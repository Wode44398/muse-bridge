import fs from "node:fs/promises";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { walk, globToRegExp } from "./walk.ts";
import { readVerdict } from "../sandbox.ts";
import { withheldNoteCheck } from "../memory-files.ts";
import { redactOutput } from "../redact.ts";
import type { GrepBatchReply, GrepJob } from "./grep-worker.ts";
import { ARG_ALIASES } from "./arg-aliases.ts";
import { typeFilter, TYPE_NAMES } from "./grep-types.ts";

// S9（#24）：模型给的正则以前在主线程同步执行，`(a+)+$` 这类嵌套量词对 26 个字符就能把整个 harness
// 冻住 3.6 秒（28 个字符 13.9 秒，所有会话、SSE、探活一起停摆，abort 也打断不了）。打开 V8 的
// 线性回退：回溯超过阈值就改用线性引擎重跑——40 个字符从天文数字降到 1ms。进程级旗标（worker 线程同样生效）。
// 线性引擎不支持反向引用与前瞻，`(a+)+\1$`、`(?=(a+)+$)` 仍是指数级——所以 #70 起匹配挪进 worker 线程
// （grep-worker.ts），每批限时，超时就把那个线程整个结束掉，主线程从头到尾不被卡住。
v8.setFlagsFromString("--enable-experimental-regexp-engine-on-excessive-backtracks");

const MAX_MATCHES = 200; // content mode: matching lines (context excluded)
const MAX_FILES_LISTED = 200; // files/count modes
const MAX_HEAD_LIMIT = 1000; // head_limit 的上限
const MAX_FILE_BYTES = 2_000_000; // don't slurp giant blobs
const MAX_CONTEXT = 10;

const intArg = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : dflt;
};

// glob 过滤：不带 / 的（*.ts）按文件名比，任意深度都算（ripgrep 的写法）；带 / 的按相对工作区根或相对 path 比
function globFilter(glob: string, baseRel: string): ((rel: string) => boolean) | null {
  if (!glob) return null;
  const re = globToRegExp(glob);
  const prefix = baseRel && baseRel !== "." ? `${baseRel}/` : "";
  if (!glob.includes("/")) return (rel) => re.test(rel) || re.test(rel.slice(rel.lastIndexOf("/") + 1));
  return (rel) => re.test(rel) || (prefix !== "" && rel.startsWith(prefix) && re.test(rel.slice(prefix.length)));
}
const BATCH_FILES = 32;

// 一批文件的匹配时限（默认 15 秒；测试用环境变量调小）。
function batchTimeoutMs(): number {
  const n = Number(process.env.DIMENSIO_GREP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
}

type Cand = { abs: string; rel: string };
type BatchOutcome = GrepBatchReply | "timeout" | "aborted" | Error;

function runBatch(worker: Worker, files: Cand[], signal: AbortSignal | undefined): Promise<BatchOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish("timeout"), batchTimeoutMs());
    const onMessage = (m: GrepBatchReply) => finish(m);
    const onError = (e: Error) => finish(e);
    const onAbort = () => finish("aborted");
    function finish(v: BatchOutcome) {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    }
    worker.once("message", onMessage);
    worker.once("error", onError);
    if (signal?.aborted) return finish("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.postMessage(files);
  });
}

export const grepTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  aliases: ARG_ALIASES.Grep,
  def: {
    name: "Grep",
    description:
      "Search file contents with a JavaScript regular expression (skips binaries, .gitignore'd and vendored paths). " +
      "mode \"content\" (default) returns file:line: text; \"files\" just the matching paths; \"count\" per-file counts. " +
      "Results are paged: head_limit caps how many come back, offset skips that many for the next page.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression to search for." },
        path: { type: "string", description: "File or directory to search (default: workspace root)." },
        glob: { type: "string", description: 'File filter: "*.ts" matches by file name at any depth; "src/**/*.js" by path.' },
        type: { type: "string", description: `Language filter, e.g. "ts", "py", "go" (${TYPE_NAMES.length} known: ${TYPE_NAMES.join(", ")}).` },
        ignoreCase: { type: "boolean", description: "Case-insensitive match." },
        multiline: { type: "boolean", description: "Match across lines (. also matches newlines); a hit is reported over the lines it spans." },
        context: { type: "integer", description: `Lines of context before and after each match (0-${MAX_CONTEXT}, content mode).` },
        before: { type: "integer", description: `Lines of context before each match (overrides context).` },
        after: { type: "integer", description: `Lines of context after each match (overrides context).` },
        mode: {
          type: "string",
          enum: ["content", "files", "count"],
          description: '"content" (default) | "files" | "count".',
        },
        head_limit: { type: "integer", description: `Max results to return: matching lines in content mode, files otherwise (default ${MAX_MATCHES}, max ${MAX_HEAD_LIMIT}; 0 = the max).` },
        offset: { type: "integer", description: "Skip this many results first (for the next page)." },
      },
      required: ["pattern"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    let re: RegExp;
    let literalNote = "";
    const multiline = args.multiline === true;
    const flags = (args.ignoreCase ? "i" : "") + (multiline ? "s" : "");
    try {
      re = new RegExp(String(args.pattern), flags);
    } catch {
      // Not valid regex (unescaped [ ( … — typical when searching CSS selectors
      // like `[data-theme="light"]`). Search the literal text instead of failing.
      const escaped = String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(escaped, flags);
      literalNote = "(pattern is not valid regex — searched as LITERAL text instead)\n";
    }

    const base = args.path ? ctx.sandbox.resolve(String(args.path)) : ctx.sandbox.root;
    const keep = globFilter(typeof args.glob === "string" ? args.glob.trim() : "", ctx.sandbox.rel(base));
    const lang = typeof args.type === "string" && args.type.trim() ? typeFilter(args.type) : null;
    if (lang === undefined) return fail("unknown type", `Grep type "${args.type}" is not known. Known types: ${TYPE_NAMES.join(", ")}. Or use glob (e.g. "*.ext").`);
    const mode = args.mode === "files" || args.mode === "count" ? args.mode : "content";
    const context = intArg(args.context ?? 0, 0, MAX_CONTEXT, 0);
    const before = args.before === undefined ? context : intArg(args.before, 0, MAX_CONTEXT, context);
    const after = args.after === undefined ? context : intArg(args.after, 0, MAX_CONTEXT, context);
    // head_limit: 0 是主流 harness 的「不限」：按上限给（再多就翻页）
    const limit = args.head_limit === 0 || args.head_limit === "0"
      ? MAX_HEAD_LIMIT
      : intArg(args.head_limit ?? (mode === "content" ? MAX_MATCHES : MAX_FILES_LISTED), 1, MAX_HEAD_LIMIT, MAX_MATCHES);
    const offset = intArg(args.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 0);

    // S4（#37①）：递归遍历逐个过统一的凭据判定——以前 walk 不经 secret guard，
    // Read 拦得住的 .env、deploy/.ssh/id_rsa，一次 Grep 就原文吐出来。
    // K9：自己记忆目录里命中注入特征的笔记也跳过（给模型看的地方只露标题）
    const withheld = withheldNoteCheck(ctx.sandbox.root);
    const skip = (abs: string) => readVerdict(abs, ctx.sandbox.root, { bypass: ctx.sandbox.bypassing }) !== null || withheld(abs);
    // U5（#57）：path 指向单个文件时就搜这个文件（以前对文件调 readdir，拿不到条目，静默回「No matches.」——
    // MiMo 因此误判成「不支持中文文件名」还存成了记忆）；path 不存在时明说，绝不回空结果。
    const baseStat = await fs.stat(base).catch(() => null);
    if (!baseStat) return fail("no such path", `Grep path does not exist: ${args.path}`);
    const targets: AsyncIterable<{ abs: string }> | { abs: string }[] = baseStat.isFile()
      ? skip(base) ? [] : [{ abs: base }]
      : walk(base, { skip });

    const job: GrepJob = {
      source: re.source,
      flags: re.flags,
      mode,
      before,
      after,
      multiline,
      offset,
      limit,
      maxFileBytes: MAX_FILE_BYTES,
    };
    const worker = new Worker(new URL("./grep-worker.ts", import.meta.url), { workerData: job });
    // 常挂一个兜底：超时收手之后、terminate 之前，失控的正则若恰好抛错，'error' 事件没人接就会变成
    // harness 主进程的未捕获异常。每批的结果另有自己的监听。
    worker.on("error", () => {});
    const lines: string[] = [];
    let matchCount = 0;
    let fileCount = 0;
    let truncated = false;
    let moreExist = false;
    let timedOut = false;
    let failure: Error | null = null;
    try {
      let batch: Cand[] = [];
      const flush = async (): Promise<boolean> => {
        if (!batch.length) return true;
        const out = await runBatch(worker, batch, ctx.signal);
        batch = [];
        if (out === "aborted") return false;
        if (out === "timeout") {
          timedOut = true;
          return false;
        }
        if (out instanceof Error) {
          failure = out;
          return false;
        }
        if (out.error) {
          failure = new Error(out.error);
          return false;
        }
        lines.push(...out.lines);
        matchCount = out.matchCount;
        fileCount = out.fileCount;
        if (out.stop) {
          truncated = true;
          moreExist = out.more;
          return false;
        }
        return true;
      };
      let more = true;
      for await (const { abs } of targets) {
        if (ctx.signal?.aborted) break;
        const rel = ctx.sandbox.rel(abs);
        if (keep && !keep(rel)) continue;
        if (lang && !lang(rel)) continue;
        batch.push({ abs, rel });
        if (batch.length >= BATCH_FILES && !(more = await flush())) break;
      }
      if (more && !ctx.signal?.aborted) await flush();
    } finally {
      // 超时 / 中止 / 正常结束都在这里收：terminate 连正在跑的失控正则一起打断。
      worker.terminate().catch(() => {});
    }

    if (failure) return fail("grep failed", `Grep failed: ${(failure as Error).message}`);
    if (timedOut) {
      return fail(
        "grep timed out",
        `Grep stopped: matching took longer than ${Math.round(batchTimeoutMs() / 1000)}s on one batch of files, ` +
          `so the search was cut off (nothing else was blocked). The pattern most likely backtracks catastrophically ` +
          `— nested quantifiers combined with a backreference or lookahead, e.g. (a+)+\\1 — simplify it, ` +
          `or narrow path/glob.` +
          (lines.length ? `\n\nPartial results before the cut-off:\n${redactOutput(lines.join("\n"))}` : ""),
      );
    }

    // 截断时告诉模型怎么翻页（结果按遍历顺序稳定，offset 接着上一页）
    const unit = mode === "content" ? "matches" : "files";
    const shown = mode === "content" ? matchCount : fileCount;
    if (truncated && moreExist) {
      lines.push(`…[stopped at ${limit} ${unit} — more exist: pass offset: ${offset + shown} for the next page, or narrow the pattern/path/glob]`);
    }
    const skippedNote = offset && !lines.length ? `No results after skipping the first ${offset}.` : "No matches.";
    // S4 出口脱敏：命中行里恰好有真令牌时不原样交给模型。
    const body = literalNote + (lines.length ? redactOutput(lines.join("\n")) : skippedNote);
    const label =
      mode === "content"
        ? `${matchCount} matches in ${fileCount} files`
        : `${fileCount} files (${matchCount} matches)`;
    return {
      ok: true,
      summary: `grep /${args.pattern}/ [${mode}] → ${label}${truncated && moreExist ? " (truncated)" : ""}`,
      // U8（K36）
      outcome: matchCount ? `${matchCount} 处匹配（${fileCount} 个文件）${truncated && moreExist ? " · 只列了一部分" : ""}` : "没有匹配",
      content: [{ t: "text", text: body }],
    };
  },
};
