// 模型档案阶段 1：从一份会话记录里数「模型适配要看的信号」。评测台的每次运行（lib.ts）和正式服 / 评测臂落盘的转录
// （transcripts.ts）用同一个函数，口径一致才能横比、才能拿实测频次给拆解报告里的建议排优先级。
// 只读记录、只出计数，不含正文（样例只留工具名与一小段报错开头）。分类沿用 metrics.ts 的 categorize。
import type { PersistedSession } from "../../server/store.ts";
import { injectionsIn } from "../../server/agent/injections.ts";
import { categorize, type ErrorCategory } from "./metrics.ts";

// 参数 / JSON 类失败再分一层：对应的修法不一样（JSON 修复、参数别名、类型强转、行号前缀……）
export const BAD_ARG_KINDS = {
  "json-invalid": "参数不是合法 JSON",
  "missing-required": "缺必填参数",
  "alias-param": "用了别名参数（如 file_path）",
  "wrong-type": "参数类型不对",
  "extra-prop": "多了不认识的参数",
  "line-prefix": "带了行号前缀",
  "noop-edit": "空操作编辑",
  other: "其他",
} as const;
export type BadArgKind = keyof typeof BAD_ARG_KINDS;

// dimensio 自家契约把调用打回去的几类：不是参数写错，是没按 dimensio 的规矩来（categorize 里它们散在 bad-args / other）。
// 单列出来，因为修法在提示词与工具说明（把规矩讲清楚 / 放宽），不在参数修复。
export const CONTRACT_KINDS = {
  "verify-status": "verify:true 的命令吞了退出码（|| 、& 、非布尔）",
  "verify-evidence": "拿只读 / 无关命令当完成证据",
  "memory-contract": "Remember 不合记忆契约",
  "deferred-load": "延迟工具没加载就调用",
  "todo-contract": "Todo 状态不合规",
  "binary-read": "Read 读了二进制文件",
  "browser-state": "浏览器 / 设备没就绪就操作",
} as const;
export type ContractKind = keyof typeof CONTRACT_KINDS;

export function contractKind(text: string): ContractKind | null {
  if (/verify:true needs/i.test(text)) return "verify-status";
  if (/cannot be used as completion evidence|Verification assertion at .* did not/i.test(text)) return "verify-evidence";
  if (/^Could not save memory|No successful Remember change/i.test(text)) return "memory-contract";
  if (/is a deferred tool and its full instructions had not been loaded|tool instructions not loaded/i.test(text)) return "deferred-load";
  if (/Only one todo may be in_progress/i.test(text)) return "todo-contract";
  if (/ is binary \(NUL byte/i.test(text)) return "binary-read";
  if (/^No browser is running|The user's Edge is not connected|本机 PC 能力已关闭/i.test(text)) return "browser-state";
  return null;
}

// 别家 harness 常用、dimensio 不认的参数名 → dimensio 的名字（拆解报告 A06 / 通用机制里的 pathAliases）
const PARAM_ALIASES: Record<string, string> = { file_path: "path", filePath: "path", filepath: "path", file: "path", old_str: "old_string", new_str: "new_string", cmd: "command" };

export interface RecordSignals {
  assistantTurns: number;
  toolCalls: number;
  toolFailed: number;
  editCalls: number; // Edit / MultiEdit / Write
  editFailed: number;
  errors: Partial<Record<ErrorCategory | "elided", number>>; // elided = 失败了但正文已被压缩替换，分不了类
  badArgs: Partial<Record<BadArgKind, number>>; // 已剔掉 contract 里那几类
  contract: Partial<Record<ContractKind, number>>;
  aliasParams: Record<string, number>; // 调用里出现的别名参数名（不管成败）
  unknownTools: Record<string, number>; // 模型叫了、注册表里没有的工具名
  failedByTool: Record<string, number>;
  thinkingOnlyTurns: number; // 只有思考、没正文也没工具调用
  emptyTurns: number; // 什么都没有的回合
  textToolCalls: number; // 正文里写出了工具调用标记、这一回合却没有真的工具调用
  waitPolls: number; // 纯等待的 Bash（sleep / timeout / Start-Sleep）
  waitSeconds: number;
  identicalRepeats: number; // 与上一次调用完全相同（工具名 + 参数）的调用次数
  maxIdenticalStreak: number;
  failThenSame: number; // 失败后紧接着原样重发同一个调用
  injections: Record<string, number>; // 追问、续写、预算、loop-guard……
  errorEndedTurns: number; // 以 provider 报错收场的回合
  samples: { tool: string; cat: string; head: string }[]; // 每类失败留几条报错开头，便于回头核对
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
// 正文里的工具调用痕迹：各家模板的标记。只在这一回合没有结构化 tool_call 时才算（否则只是模型在解释）。
const TEXT_TOOL_CALL = /<tool_call>|<\/tool_call>|<function_calls?>|<invoke\s+name=|<function=[\w-]+>|<\|tool▁calls?▁begin\|>|<\|tool_call_begin\|>|\[TOOL_CALLS\]|^\s*\{\s*"(?:name|tool|function)"\s*:\s*"[A-Za-z_]+"\s*,\s*"(?:arguments|parameters|args|input)"\s*:/m;
const ELIDED = /^\[old tool output elided/;
// 纯等待：整条命令只是在睡（允许前面有 cd、后面跟一条很短的查看命令不算——那是轮询，另由 identicalRepeats 体现）
const SLEEP = /^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:sleep\s+(\d+(?:\.\d+)?)([smh]?)|timeout\s+\/t\s+(\d+)|Start-Sleep\s+(?:-Seconds\s+|-s\s+)?(\d+)|ping\s+-n\s+(\d+)\s+127\.0\.0\.1)\b/i;

function sleepSeconds(cmd: string): number | null {
  const m = SLEEP.exec(cmd);
  if (!m) return null;
  if (m[1]) return Number(m[1]) * (m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 1);
  return Number(m[3] ?? m[4] ?? m[5] ?? 0);
}

export function badArgKind(text: string): BadArgKind {
  if (/were not valid JSON|not valid JSON/i.test(text)) return "json-invalid";
  if (/line-number prefixes/i.test(text)) return "line-prefix";
  if (/no-op edit|old_string and new_string are identical/i.test(text)) return "noop-edit";
  if (/is not an allowed property/i.test(text)) return "extra-prop";
  if (/is required\b/i.test(text)) return "missing-required";
  if (/expected \w+, got \w+|must be (?:a|an) /i.test(text)) return "wrong-type";
  return "other";
}

type Block = { t?: string; id?: string; name?: string; args?: unknown; ok?: boolean; text?: string; content?: unknown };

const resultText = (b: Block): string => (Array.isArray(b.content) ? b.content.flatMap((c: Block) => (c && c.t === "text" ? [String(c.text ?? "")] : [])).join("\n") : String(b.content ?? ""));

export function recordSignals(rec: Pick<PersistedSession, "messages">, maxSamples = 3): RecordSignals {
  const s: RecordSignals = {
    assistantTurns: 0,
    toolCalls: 0,
    toolFailed: 0,
    editCalls: 0,
    editFailed: 0,
    errors: {},
    badArgs: {},
    contract: {},
    aliasParams: {},
    unknownTools: {},
    failedByTool: {},
    thinkingOnlyTurns: 0,
    emptyTurns: 0,
    textToolCalls: 0,
    waitPolls: 0,
    waitSeconds: 0,
    identicalRepeats: 0,
    maxIdenticalStreak: 0,
    failThenSame: 0,
    injections: injectionsIn(rec.messages as never),
    errorEndedTurns: 0,
    samples: [],
  };
  const callById = new Map<string, { name: string; key: string }>();
  const perCat: Record<string, number> = {};
  let prevKey = "";
  let streak = 0;
  let lastFailedKey = ""; // 最近一次失败调用的键；下一次调用若相同就是「失败后原样重发」
  const bump = <K extends string>(o: Partial<Record<K, number>>, k: K) => void (o[k] = (o[k] ?? 0) + 1);

  for (const m of rec.messages as unknown as { role: string; content: Block[] }[]) {
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      s.assistantTurns++;
      const text = blocks.flatMap((b) => (b.t === "text" ? [String(b.text ?? "")] : [])).join("\n");
      const hasText = text.trim().length > 0;
      const hasCall = blocks.some((b) => b.t === "tool_call");
      const hasThink = blocks.some((b) => b.t === "thinking" && String(b.text ?? "").trim());
      if (/\[this turn ended on an error/.test(text)) s.errorEndedTurns++;
      else if (!hasText && !hasCall) hasThink ? s.thinkingOnlyTurns++ : s.emptyTurns++;
      if (!hasCall && TEXT_TOOL_CALL.test(text)) s.textToolCalls++;
    }
    for (const b of blocks) {
      if (b.t === "tool_call") {
        const name = String(b.name ?? "?");
        const key = `${name}:${JSON.stringify(b.args ?? null)}`;
        callById.set(String(b.id), { name, key });
        s.toolCalls++;
        if (EDIT_TOOLS.has(name)) s.editCalls++;
        if (key === prevKey) {
          streak++;
          s.identicalRepeats++;
        } else {
          prevKey = key;
          streak = 1;
        }
        s.maxIdenticalStreak = Math.max(s.maxIdenticalStreak, streak);
        if (lastFailedKey && key === lastFailedKey) s.failThenSame++;
        lastFailedKey = "";
        const args = b.args && typeof b.args === "object" ? (b.args as Record<string, unknown>) : {};
        for (const k of Object.keys(args)) if (k in PARAM_ALIASES) bump(s.aliasParams, k);
        if (name === "Bash" && typeof args.command === "string") {
          const sec = sleepSeconds(args.command);
          if (sec !== null) {
            s.waitPolls++;
            s.waitSeconds += sec;
          }
        }
      } else if (b.t === "tool_result" && b.ok === false) {
        const call = callById.get(String(b.id));
        const name = call?.name ?? "unknown";
        const text = resultText(b);
        s.toolFailed++;
        bump(s.failedByTool, name);
        if (EDIT_TOOLS.has(name)) s.editFailed++;
        if (call) lastFailedKey = call.key;
        let cat: ErrorCategory | "elided";
        if (ELIDED.test(text)) cat = "elided";
        else {
          cat = categorize(name, "", text);
          const contract = contractKind(text);
          if (contract) bump(s.contract, contract);
          if (cat === "unknown-tool" && contract !== "deferred-load") bump(s.unknownTools, name);
          if (cat === "bad-args" && !contract) {
            const kind = badArgKind(text);
            // 缺了 path 而调用里带着 file_path 这类：归到别名（修法是别名映射，不是提示词）
            const args = call ? (JSON.parse(call.key.slice(name.length + 1)) as Record<string, unknown> | null) : null;
            const aliased = kind === "missing-required" && args && Object.keys(args).some((k) => k in PARAM_ALIASES && new RegExp(`\\.${PARAM_ALIASES[k]} is required`).test(text));
            bump(s.badArgs, aliased ? "alias-param" : kind);
          }
        }
        bump(s.errors, cat);
        perCat[cat] = (perCat[cat] ?? 0) + 1;
        if (cat !== "elided" && perCat[cat] <= maxSamples) s.samples.push({ tool: name, cat, head: text.slice(0, 160).replace(/\s+/g, " ") });
      }
    }
  }
  return s;
}

// 多份记录的信号相加（样例截到每类 maxSamples 条）
export function addSignals(a: RecordSignals | null, b: RecordSignals, maxSamples = 4): RecordSignals {
  if (!a) return { ...b, errors: { ...b.errors }, badArgs: { ...b.badArgs }, contract: { ...b.contract }, aliasParams: { ...b.aliasParams }, unknownTools: { ...b.unknownTools }, failedByTool: { ...b.failedByTool }, injections: { ...b.injections }, samples: [...b.samples] };
  const add = (x: Record<string, number | undefined>, y: Record<string, number | undefined>) => {
    for (const [k, v] of Object.entries(y)) x[k] = (x[k] ?? 0) + (v ?? 0);
  };
  for (const k of ["assistantTurns", "toolCalls", "toolFailed", "editCalls", "editFailed", "thinkingOnlyTurns", "emptyTurns", "textToolCalls", "waitPolls", "waitSeconds", "identicalRepeats", "failThenSame", "errorEndedTurns"] as const) a[k] += b[k];
  a.maxIdenticalStreak = Math.max(a.maxIdenticalStreak, b.maxIdenticalStreak);
  add(a.errors, b.errors);
  add(a.badArgs, b.badArgs);
  add(a.contract, b.contract);
  add(a.aliasParams, b.aliasParams);
  add(a.unknownTools, b.unknownTools);
  add(a.failedByTool, b.failedByTool);
  add(a.injections, b.injections);
  for (const smp of b.samples) if (a.samples.filter((x) => x.cat === smp.cat).length < maxSamples) a.samples.push(smp);
  return a;
}
