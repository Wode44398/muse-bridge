// 命令输出的采集（头尾保留、溢出落盘、解码、脱敏）与「命令结束了」的判定、进程树收尾。
import type { ChildProcess } from "node:child_process";
import { consoleDecoder } from "../console-decode.ts";
import { redactOutput } from "../../redact.ts";
import { isSensitiveEnvName } from "../../helper-proc.ts";
import { killChildTree } from "../../proc-tree.ts";
import { OutputSpill, savedHint } from "../result-store.ts";
import { JAVA_PICKUP_LINE } from "./env.ts";

// Failure summaries (test runners, builds, tracebacks) land at the END of the
// output, so on overflow keep a small head for context and favor the tail.
const HEAD_MAX = 5_000;
const TAIL_MAX = 25_000;

// Rolling head+tail capture shared by the sync path and background jobs.
// R13：spillTo 给了（有会话）就在第一次溢出时开一个落盘文件——那一刻头尾还是完整的，先整段写进去，之后每一段都追加；
// 被截掉的中段不再永久丢失，截断提示里写明全文在哪（savedAt）。
export interface OutBuf {
  head: string;
  tail: string;
  omitted: number;
  total?: number;
  spillTo?: () => OutputSpill | null;
  spill?: OutputSpill | null;
  savedAt?: string | null;
  // 后台 job 的 watch：每段解码后的输出也交给它（按行匹配，见 startJob）
  onText?: (s: string) => void;
}

// 有会话才落盘；落盘前按块过 Bash 的脱敏（与交给模型的同一层）
export function spillFor(sessionId: string | undefined): (() => OutputSpill | null) | undefined {
  if (!sessionId) return undefined;
  return () => {
    try {
      return new OutputSpill(sessionId, "bash", (text) => redactSecrets(dropJavaPickup(text)));
    } catch {
      return null;
    }
  };
}

// 进程结束时收尾：把落盘文件写完关上（写失败就不再在提示里给路径）
export async function closeSpill(b: OutBuf): Promise<void> {
  const spill = b.spill;
  if (!spill) return;
  b.spill = null;
  b.savedAt = await spill.end();
}

export function pushOut(b: OutBuf, s: string): void {
  b.total = (b.total ?? 0) + s.length;
  if (b.onText) {
    try {
      b.onText(s);
    } catch {
      /* watch 出错不影响输出采集 */
    }
  }
  if (b.spill) b.spill.write(s);
  if (b.head.length < HEAD_MAX) {
    const need = HEAD_MAX - b.head.length;
    b.head += s.slice(0, need);
    s = s.slice(need);
  }
  b.tail += s;
  if (b.tail.length > TAIL_MAX) {
    if (b.spill === undefined) {
      b.spill = b.spillTo?.() ?? null;
      if (b.spill) {
        b.spill.write(b.head + b.tail);
        b.savedAt = b.spill.file;
      }
    }
    b.omitted += b.tail.length - TAIL_MAX;
    b.tail = b.tail.slice(-TAIL_MAX);
  }
}

export function renderOut(b: OutBuf): string {
  const note = b.savedAt ? ` — ${savedHint(b.savedAt, b.total ?? 0)}` : "";
  const rendered = b.omitted > 0 ? `${b.head}\n…[${b.omitted} chars omitted${note}]…\n${b.tail}` : b.head + b.tail;
  return redactSecrets(dropJavaPickup(rendered));
}

// Every JVM announces an inherited JAVA_TOOL_OPTIONS on stderr. We set that var
// (see childEnv) purely to fix encoding, so the announcement is pure noise on
// every java/javac/gradle call — drop exactly our own line, nothing else.
export function dropJavaPickup(text: string): string {
  if (!text.includes(JAVA_PICKUP_LINE)) return text;
  return text
    .split("\n")
    .filter((line) => line.trimEnd() !== JAVA_PICKUP_LINE)
    .join("\n");
}

// stdout/stderr arrive as byte chunks split at arbitrary offsets, so decoding
// each chunk on its own shreds any multi-byte character that straddles a
// boundary — one `�` per ~64KB of Chinese output, reported as "编码问题".
// A decoder per stream holds the incomplete tail until its rest arrives;
// finish() flushes whatever the process left dangling at exit.
// #97：Windows 上按行认 UTF-8 / GBK（原生控制台程序写的是系统代码页），见 console-decode.ts。
export function streamPump(b: OutBuf): { write: (buf: Buffer) => void; finish: () => void } {
  const decoder = consoleDecoder();
  return {
    write: (buf: Buffer) => pushOut(b, decoder.write(buf)),
    finish: () => {
      const rest = decoder.end();
      if (rest) pushOut(b, rest);
    },
  };
}

// Kill a process tree. On Windows the child is the shell running the command;
// its node grandchild survives a plain kill(), so the whole tree has to go. (Shared
// with services.ts — lives here because services already imports from this module.)
// #77：以前是 taskkill /T——它只按 ParentProcessId 找子进程，会顺着「悬空的父 PID」把不相干的进程链整条带走
// （2026-09-24 正式服 bridge 就这样没的）。现在由 proc-tree.ts 按创建时间核对子孙后逐个结束；Node 已经收到
// 退出的子进程不再按 PID 去杀（PID 可能已被复用）。
export function killTree(child: ChildProcess): void {
  killChildTree(child);
}

// ── 「命令结束了」到底怎么判 ─────────────────────────────────────────────────
// 曾经两条路径都只听 'close'，那是个陷阱：'close' 要等 stdio 管道全部 EOF，而管道
// 的写端会被【孙进程】继承。命令里写个 `&` 起一个长命进程（`cmd & sleep 90`、
// `./game.exe & …`），shell 自己 echo 完就正常退出了，孙进程却攥着那对管道不放 ——
// 管道不 EOF，'close' 永远不来，同步路径那个 Promise 于是永不 resolve。
// 2026-09-10 实测：一次 `./SUMMER.exe >/dev/null 2>&1 & sleep 90` 把整个会话冻死
// 3 小时 15 分（shell 16:11 就退干净了，UI 一直显示「运行中」）。超时兜底也救不了 ——
// 定时器烧到时 killTree 打的是那个早已自己退出的 shell pid，孤儿子树根本不在射程内，
// 打完还是接着等 'close'。
//
// 'exit' 只跟进程本身的死活绑定，管道被谁攥着都一定会来，所以定局改挂 'exit'：
// exit 之后再给一小段安静窗口把管道里剩下的字读干净（还有数据就续窗口，但总时长封顶,
// 免得被一个话痨孤儿续到天荒地老），到点就收工。
const POST_EXIT_QUIET_MS = 300; // exit 后多久没新输出就算读干净了
const POST_EXIT_MAX_MS = 3_000; // drain 总时长上限（孤儿可能一直往管道里写）
const KILL_BACKSTOP_MS = 5_000; // killTree 之后进程仍没死透的最后兜底

export function whenFinished(
  child: ChildProcess,
  pumps: { finish: () => void }[],
  onFinish: (code: number | null) => void,
): { markKilled: () => void } {
  let settled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    timers.push(t);
    return t;
  };

  const settle = (code: number | null) => {
    if (settled) return;
    settled = true;
    for (const t of timers) clearTimeout(t);
    for (const p of pumps) p.finish();
    // 松开读端。孤儿还攥着写端，但 harness 这边没必要再为它留着 fd 和 buffer。
    child.stdout?.destroy();
    child.stderr?.destroy();
    onFinish(code);
  };

  // 正常命令仍然走这条：'close' 紧跟在 'exit' 后面，等不到安静窗口就收工了。
  child.on("close", (code) => settle(code));

  child.on("exit", (code) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (quiet) clearTimeout(quiet);
      quiet = later(POST_EXIT_QUIET_MS, () => settle(code));
    };
    child.stdout?.on("data", bump);
    child.stderr?.on("data", bump);
    later(POST_EXIT_MAX_MS, () => settle(code));
    bump();
  });

  // 超时/中止路径调这个：killTree 之后万一进程还是没死（taskkill 失败、句柄被占），
  // 'exit' 也不会来，靠这个保证调用方一定拿得到结局，而不是无限等待。
  return { markKilled: () => later(KILL_BACKSTOP_MS, () => settle(null)) };
}


export function redactSecrets(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !isSensitiveEnvName(name)) continue;
    out = out.split(value).join(`[REDACTED:${name}]`);
  }
  out = out.replace(
    /(^|\n)([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*)\s*=\s*[^\r\n]*/gi,
    (_m, lead: string, name: string) => `${lead}${name}=[REDACTED]`,
  );
  out = out.replace(/-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/g, "[REDACTED:PRIVATE_KEY]");
  // S4：再过一遍与 Read/Grep/WebFetch 共用的高置信规则（JSON 里的 Bearer、知名前缀令牌）——
  // 以前 `cat registry.json` 这类 JSON 形态的令牌两条规则都匹配不到。
  return redactOutput(out);
}
