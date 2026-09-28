// Q5（K49 / F3 / N50）：会话体检库。输入一条落盘的会话记录，复用生产代码（配对判定、悬空调用愈合、可见性过滤、
// 请求不变量、注入片段类别）查守恒问题，再出一份复盘统计——OBSERVED（记录里数得出来的）与 MODELED（估出来的）
// 分两栏，只有聚合数字，不含正文。脚本（harness/scripts/session-health.mjs，只读）、测试、
// GET /api/sessions/:id/health 都调这一份，检查逻辑不会和生产代码漂移。
// 只读：读文件用纯解析（parseSessionRecord），不走 loadSessionResult——那条路遇到坏文件会隔离改名。
import fs from "node:fs";
import { injectionsIn, messageKind } from "./agent/injections.ts";
import { pairingProblems } from "./agent/pairing.ts";
import type { PrefixTotals } from "./agent/prefix-audit.ts";
import { danglingToolCalls, healDanglingToolCalls, visibleMessages } from "./agent/state.ts";
import { checkTurn } from "./agent/turn-invariants.ts";
import type { Block, Msg } from "./agent/turn.ts";
import { parseSessionRecord, type PersistedSession } from "./store.ts";

export type Severity = "error" | "warn" | "info";

export interface HealthIssue {
  code: string;
  severity: Severity;
  detail: string;
  at?: number; // 相关消息的下标（0 起）
}

export interface SessionStats {
  observed: {
    runs: number; // 用户真正发的消息条数（不含工具结果、注入片段）
    assistantTurns: number;
    toolCalls: Record<string, { calls: number; failed: number }>;
    denied: number; // 被权限策略拒掉的调用
    notExecuted: number; // 用户叫停 / 部署重启时没轮到的调用
    identicalStreaks: Record<string, number>; // 连续完全相同的调用：长度（≥2）→ 出现次数
    maxIdenticalStreak: number;
    injections: Record<string, number>; // 各类注入片段的次数（追问、提醒、召回……）
    verifyGateExhaustedRuns: number; // 一轮里验证追问 ≥ 3 次
    auditGateExhaustedRuns: number; // 一轮里记忆审计追问 ≥ 3 次
    errorEndedTurns: number; // 以「出错收场」边界结束的轮
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    prefix?: PrefixTotals; // Q4 的前缀判定累计（请求数、按原因计的断点、重发字符数）
  };
  modeled: {
    transcriptChars: number;
    estimatedTokens: number; // 字符数 / 4
    writesToKnownPaths: number; // Write 的路径在本会话里先前出现过（大概率是整份覆盖已有文件）
  };
}

export interface HealthReport {
  id: string;
  load: "ok" | "corrupt" | "unsupported-version" | "not-found";
  issues: HealthIssue[];
  stats?: SessionStats;
  meta?: { provider: string; model: string; updatedAt: number; messages: number };
}

export interface HealthOptions {
  // 会话的媒体资产在不在（生产上是 <sessions>/assets/<id>/<资产>）；不给就不查
  assetExists?: (assetId: string) => boolean;
}

// loop / 会话以 internal 追加的注入片段：出现在聊天记录里就是漏了（或老记录没清干净）。插话、todo 提醒、预算
// 提示、续写提示是有意给人看的，不在这里。
const HIDDEN_KINDS = new Set(["recall", "audit-nudge", "precompact-audit-nudge", "verify-nudge", "plan-nudge", "submit-nudge", "world-state"]);
const GATE_EXHAUSTED = 3;

const textOf = (m: Msg | undefined): string => (m ? m.content.flatMap((b) => (b.t === "text" ? [b.text] : [])).join("\n") : "");
const isSummary = (m: Msg | undefined): boolean => Boolean(m) && messageKind(m!) === "compaction-summary";

// 用户真正说的话：不是 internal、不带工具结果、有正文、正文不是注入片段（插话也算用户说的）。
function isUserTurn(m: Msg): boolean {
  if (m.role !== "user" || m.internal) return false;
  if (m.content.some((b) => b.t === "tool_result")) return false;
  const text = textOf(m);
  const kind = messageKind(m); // C3：按结构化来源认，用户本人的消息不按开头当注入
  return (text.trim() !== "" || m.content.some((b) => b.t !== "text")) && (kind === null || kind === "steer");
}

function mediaBlocks(blocks: Block[], out: Extract<Block, { t: "image" | "video" | "audio" }>[] = []) {
  for (const b of blocks) {
    if (b.t === "image" || b.t === "video" || b.t === "audio") out.push(b);
    else if (b.t === "tool_result") mediaBlocks(b.content, out);
  }
  return out;
}

export function checkSession(rec: PersistedSession, opts: HealthOptions = {}): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const messages = rec.messages;

  // 1. 配对。末尾悬空的调用是被中断的那一轮，恢复时会自动愈合（info）；愈合之后仍有的配对问题才是真坏。
  const dangling = danglingToolCalls(messages);
  if (dangling.length) {
    issues.push({ code: "dangling-tail", severity: "info", detail: `${dangling.length} tool call(s) at the end have no result (interrupted run); resume heals them` });
  }
  const healed = structuredClone(messages);
  healDanglingToolCalls(healed);
  const pairing = pairingProblems(healed);
  for (const p of pairing) {
    const n = Number(/^message (\d+)/.exec(p)?.[1]);
    const at = Number.isFinite(n) ? n - 1 : undefined;
    // 压缩摘要后面紧跟着找不到调用的结果 = 压缩把一对调用 / 结果切开了
    const cut = at !== undefined && isSummary(healed[at - 1]);
    issues.push({ code: cut ? "compaction-cut" : "pairing", severity: "error", detail: p, ...(at !== undefined ? { at } : {}) });
  }

  // 2. 其余请求不变量（Q3 的 checkTurn）：配对已在上面报过；媒体在记录里本来就是资产引用（发送前才解析），另查。
  const skip = new Set(pairing);
  for (const v of checkTurn({ system: rec.system, messages: healed, tools: [], budget: { maxOutputTokens: 1 } })) {
    if (skip.has(v) || /carries no data at the provider boundary/.test(v)) continue;
    issues.push({ code: "request-invariant", severity: "error", detail: v });
  }

  // 3. 可见性：只该给模型看的注入片段不许出现在聊天记录里。
  visibleMessages(messages).forEach((m) => {
    const kind = messageKind(m);
    if (kind && HIDDEN_KINDS.has(kind)) issues.push({ code: "injection-visible", severity: "error", detail: `a ${kind} fragment shows up in the visible conversation` });
  });

  // 4. 媒体引用：资产文件得在；什么都不带的媒体块是坏的。
  messages.forEach((m, at) => {
    for (const b of mediaBlocks(m.content)) {
      if (b.asset) {
        if (opts.assetExists && !opts.assetExists(b.asset)) issues.push({ code: "media-missing", severity: "error", at, detail: `${b.t} asset ${b.asset} is referenced but its file is gone` });
      } else if (!b.data && !b.url) {
        issues.push({ code: "media-empty", severity: "error", at, detail: `${b.t} block carries neither an asset, data nor a url` });
      }
    }
  });

  // 5. 续写链没闭合：续写提示之后再没有 assistant 接着说。
  messages.forEach((m, at) => {
    if (messageKind(m) !== "length-continue") return;
    if (!messages.slice(at + 1).some((x) => x.role === "assistant")) {
      issues.push({ code: "length-chain-open", severity: "warn", at, detail: "a reply was cut off by the output limit and never continued" });
    }
  });

  // 6. 停在 plan 档；前缀有过没人报备的断点（Q4）
  if (rec.config.permissionMode === "plan") issues.push({ code: "plan-mode", severity: "info", detail: "the session is still in plan mode" });
  const unexplained = rec.totals?.prefix?.breaks?.unexplained ?? 0;
  if (unexplained) issues.push({ code: "prefix-unexplained", severity: "warn", detail: `${unexplained} request(s) broke the cache prefix without a declared rewrite` });

  // 7. 门禁连击
  const stats = sessionStats(rec);
  if (stats.observed.verifyGateExhaustedRuns) issues.push({ code: "verify-gate-exhausted", severity: "warn", detail: `${stats.observed.verifyGateExhaustedRuns} run(s) got ≥${GATE_EXHAUSTED} verification nudges` });
  if (stats.observed.auditGateExhaustedRuns) issues.push({ code: "audit-gate-exhausted", severity: "warn", detail: `${stats.observed.auditGateExhaustedRuns} run(s) got ≥${GATE_EXHAUSTED} memory-audit nudges` });
  return issues;
}

export function sessionStats(rec: PersistedSession): SessionStats {
  const messages = rec.messages;
  const toolCalls: Record<string, { calls: number; failed: number }> = {};
  const nameById = new Map<string, string>();
  const identicalStreaks: Record<string, number> = {};
  let maxIdenticalStreak = 0;
  let streakKey = "";
  let streak = 0;
  const endStreak = () => {
    if (streak >= 2) identicalStreaks[streak] = (identicalStreaks[streak] ?? 0) + 1;
    maxIdenticalStreak = Math.max(maxIdenticalStreak, streak);
  };
  const seenPaths = new Set<string>();
  let writesToKnownPaths = 0;
  let runs = 0, assistantTurns = 0, denied = 0, notExecuted = 0, errorEndedTurns = 0;
  let verifyGateExhaustedRuns = 0, auditGateExhaustedRuns = 0, runVerify = 0, runAudit = 0;
  const closeRun = () => {
    if (runVerify >= GATE_EXHAUSTED) verifyGateExhaustedRuns++;
    if (runAudit >= GATE_EXHAUSTED) auditGateExhaustedRuns++;
    runVerify = runAudit = 0;
  };
  let chars = 0;

  for (const m of messages) {
    chars += JSON.stringify(m.content).length;
    if (isUserTurn(m)) {
      closeRun();
      runs++;
    }
    if (m.role === "assistant") {
      assistantTurns++;
      if (/\[this turn ended on an error/.test(textOf(m))) errorEndedTurns++;
    }
    for (const b of m.content) {
      if (b.t === "tool_call") {
        nameById.set(b.id, b.name);
        (toolCalls[b.name] ??= { calls: 0, failed: 0 }).calls++;
        const key = `${b.name}:${JSON.stringify(b.args)}`;
        if (key === streakKey) streak++;
        else {
          endStreak();
          streakKey = key;
          streak = 1;
        }
        const p = typeof b.args?.path === "string" ? b.args.path : typeof b.args?.file_path === "string" ? b.args.file_path : undefined;
        if (p) {
          if (b.name === "Write" && seenPaths.has(p)) writesToKnownPaths++;
          seenPaths.add(p);
        }
      } else if (b.t === "tool_result") {
        const name = nameById.get(b.id) ?? "unknown";
        const text = b.content.flatMap((c) => (c.t === "text" ? [c.text] : [])).join("\n");
        if (!b.ok) (toolCalls[name] ??= { calls: 0, failed: 0 }).failed++;
        if (text.startsWith("Denied by permission policy")) denied++;
        if (text.startsWith("Not executed:")) notExecuted++;
      } else if (b.t === "text" && m.role === "user") {
        const kind = messageKind(m);
        if (kind === "verify-nudge") runVerify++;
        if (kind === "audit-nudge") runAudit++;
      }
    }
  }
  endStreak();
  closeRun();

  const t = rec.totals;
  return {
    observed: {
      runs,
      assistantTurns,
      toolCalls,
      denied,
      notExecuted,
      identicalStreaks,
      maxIdenticalStreak,
      injections: injectionsIn(messages),
      verifyGateExhaustedRuns,
      auditGateExhaustedRuns,
      errorEndedTurns,
      tokens: { input: t?.inputTokens ?? 0, output: t?.outputTokens ?? 0, cacheRead: t?.cacheReadTokens ?? 0, cacheWrite: t?.cacheWriteTokens ?? 0 },
      ...(t?.prefix ? { prefix: t.prefix } : {}),
    },
    modeled: { transcriptChars: chars, estimatedTokens: Math.ceil(chars / 4), writesToKnownPaths },
  };
}

// 体检一个会话文件（只读）。
export function inspectSessionFile(file: string, id: string, opts: HealthOptions = {}): HealthReport {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { id, load: "not-found", issues: [{ code: "load-not-found", severity: "error", detail: "the session file cannot be read" }] };
  }
  return inspectRecordText(text, id, opts);
}

export function inspectRecordText(text: string, id: string, opts: HealthOptions = {}): HealthReport {
  const parsed = parseSessionRecord(text, id);
  if (parsed.kind === "corrupt") {
    return { id, load: "corrupt", issues: [{ code: "load-corrupt", severity: "error", detail: "the session file does not parse as a session record (a checkpoint copy may restore it)" }] };
  }
  if (parsed.kind === "unsupported-version") {
    return { id, load: "unsupported-version", issues: [{ code: "load-unsupported-version", severity: "warn", detail: `written by a newer dimensio (record v${parsed.version}); read-only here` }] };
  }
  return inspectRecord(parsed.rec, opts);
}

export function inspectRecord(rec: PersistedSession, opts: HealthOptions = {}): HealthReport {
  return {
    id: rec.id,
    load: "ok",
    issues: checkSession(rec, opts),
    stats: sessionStats(rec),
    meta: { provider: rec.config.provider, model: rec.config.model, updatedAt: rec.updatedAt, messages: rec.messages.length },
  };
}

// 守恒问题（error）的条数——脚本据此给退出码。
export const errorCount = (report: HealthReport): number => report.issues.filter((i) => i.severity === "error").length;
