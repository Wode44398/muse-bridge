import type { Block, Msg, ThinkingLevel, Turn } from "./turn.ts";
import type { AgentState } from "./state.ts";
import { anchorCaps, archiveChunks, deterministicNotes, prepareSummary, renderSummary } from "./compaction-shape.ts";
import { INLINE_MIN_WINDOW, inlineInstruction, summarize, summarizeInline, summaryOutputTokens } from "./compaction-summary.ts";
import { applyRestoredReads, applyRestoredTools, gatherRestore, renderRestore, RESTORE_KIND, trimRestore, type Restore } from "./compaction-restore.ts";
import { messageKind } from "./injections.ts";
import { traceLines } from "./run-trace.ts";
import { toolArgStr } from "./tool-input.ts";
import { preCompactHook } from "../hooks/index.ts";

// 摘要怎么写（inline / sidecar、预算、指令）在 compaction-summary.ts；这几个名字老调用方与测试从这里取
export { COMPACTION_SYSTEM, SUMMARY_BUDGET, SUMMARY_INSTRUCTION, summarize, type SummaryProfile } from "./compaction-summary.ts";

// 瘦身 P0-1：整段压缩前给 run 之后的记忆沉淀留的轨迹，最多这么多行（多的从最早的丢）
const COMPACTED_TRACE_MAX = 200;

export const BUFFER_TOKENS = 13_000; // CC's AUTOCOMPACT_BUFFER_TOKENS
const MAX_FAILURES = 3; // CC's MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
const KEEP_HEAD = 2; // earliest messages (task goal) never dropped

// Micro-compaction (stage 1, free): elide stale tool outputs in place.
const MICRO_MIN_CHARS = 600; // eliding smaller results buys ~nothing
const MICRO_PROTECT_TAIL = 6; // the most recent messages stay intact
const ELIDED_TEXT =
  "[old tool output elided to save context — re-run the tool if you need it again]";
// R11：微压缩的滞回——一次腾不出这么多就不改写。就地改写旧工具输出会让请求前缀从改写处断开（缓存从那里失效，本机
// llama.cpp 要从那里重新 prefill）；在触发线附近每轮腾一点、每轮断一次，不如直接整段压缩换一段长跑道。
const MICRO_MIN_RECLAIM_TOKENS = 4_000;

// R11：按成本压缩——1M 窗口不等于该用满：每轮都整段重发，缓存读费、首 token 延迟、长上下文里的质量衰减都跟着长
// （k3 / DeepSeek 的会话平均每轮输入 28–38 万 token）。窗口 ≥ 512K 的模型默认在 256K 压；目录可按型号配 compactAt。
const COST_COMPACT_AT = 256_000;
const COST_MIN_WINDOW = 512_000;

export interface FitResult {
  used: number;
  limit: number;
  compacted: boolean;
  auditRequired?: boolean;
}

// R9：按字符类别估算——ASCII 约 4 个字符 1 token，其余（中日韩等）约 1 个字符 1 token。以前一律 4 个字符 1 token，
// 中文会话低估三四倍：主动压缩还没动手，provider 就先报超窗了。C5 的技能目录预算也按它算。
export function textTokens(s: string): number {
  let wide = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) wide++;
  return (s.length - wide) / 4 + wide;
}

export function estimateTokens(system: string | Block[], messages: Msg[]): number {
  let tokens = 0;
  if (typeof system === "string") tokens += textTokens(system);
  else for (const b of system) if (b.t === "text") tokens += textTokens(b.text);
  for (const m of messages) tokens += blocksTokens(m.content);
  return Math.ceil(tokens);
}

function blocksTokens(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.t === "text") n += textTokens(b.text);
    else if (b.t === "thinking") n += textTokens(b.text) + opaqueThinkingChars(b) / 4;
    else if (b.t === "tool_call") n += textTokens(JSON.stringify(b.args)) + b.name.length / 4;
    else if (b.t === "tool_result") n += blocksTokens(b.content);
    else n += blocksChars([b]) / 4; // 图片 / 视频 / 音频：沿用按字符折算的固定估值
  }
  return n;
}

// 思考块里不在 text 里、却照样随请求回传的部分：Anthropic redacted_thinking 的加密原文、OpenRouter reasoning_details 里的
// 加密 data / 签名。按字符数折算（base64 之类的密文近似 4 字符一个 token）。明文条目（reasoning.text 的 text、
// reasoning.summary 的 summary）流里收到时就拼进了 b.text（openai.ts reasoningText），已经算过；只有 b.text 为空时才按它们算
function opaqueThinkingChars(b: Extract<Block, { t: "thinking" }>): number {
  let n = b.redacted?.length ?? 0;
  const plainCounted = b.text.length > 0;
  for (const d of b.details ?? []) {
    for (const k of plainCounted ? (["data", "signature"] as const) : (["data", "summary", "text", "signature"] as const)) {
      const v = d[k];
      if (typeof v === "string") n += v.length;
    }
  }
  return n;
}

// R9：实测为锚、之后的追加用估算补上——provider 上一次回报的输入 token 数（锚），加上那之后新追加的消息的估算。
// 以前取「整段估算」与「上次实测」的较大值，实测之后追加的内容就没算进去。锚在历史被就地改写时作废（state.noteRewrite），
// 退回整段估算与实测的较大值。
export function contextTokens(state: AgentState): number {
  const estimate = estimateTokens(state.system, state.messages);
  const anchor = state.contextAnchor;
  if (!anchor || anchor.messages > state.messages.length) return Math.max(estimate, state.lastContextTokens);
  return Math.max(estimate, anchor.tokens + estimateTokens("", state.messages.slice(anchor.messages)));
}

// 实际可用的窗口：目录里写的，和 provider 真拒过的（R7 的立刻压缩记下来）取小的。
export function effectiveWindow(state: AgentState): number {
  return Math.min(state.adapter.capabilities.contextWindow, state.observedWindow ?? Infinity);
}

// R11：压缩按的窗口——实际可用窗口封顶到「成本触发线 + 缓冲」。触发线、尾部预算、用户原话预算都按它算，报给前端的
// 上限也是它（上下文条满格 = 要压了，与 Claude Code「距自动压缩还剩多少」同一口径）；输出上限仍按实际窗口夹（R9）。
export function compactionWindow(state: AgentState): number {
  const window = effectiveWindow(state);
  const caps = state.adapter.capabilities;
  const at = caps.compactAt ?? (caps.contextWindow >= COST_MIN_WINDOW ? COST_COMPACT_AT : undefined);
  return at ? Math.min(window, at + BUFFER_TOKENS) : window;
}

function blocksChars(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.t === "text") n += b.text.length;
    else if (b.t === "thinking") n += b.text.length + opaqueThinkingChars(b);
    else if (b.t === "tool_call") n += JSON.stringify(b.args).length + b.name.length;
    else if (b.t === "tool_result") n += blocksChars(b.content);
    else if (b.t === "image") n += 2000; // rough cost of an image
    // Video is sampled server-side by the provider, so the real number scales
    // with duration; this is a deliberately pessimistic flat stand-in that keeps
    // a long clip from silently blowing the window.
    else if (b.t === "video") n += 8000;
    else if (b.t === "audio") n += b.durationSeconds && Number.isFinite(b.durationSeconds) && b.durationSeconds > 0
      ? (Math.ceil(b.durationSeconds * 6.25) + 64) * 4 : 32_000;
  }
  return n;
}

// Keep the context under the model's window. Two stages: first micro-compaction
// (free, in-place eliding of stale tool outputs), then — only if still over —
// LLM summarization of the middle, protecting head (task) and tail (current
// progress). Fuses after 3 consecutive failures so it never death-loops.
// U3：这次请求前要不要整理上下文（与 ensureContextFits 的第一道判断同口径）——loop 据此先报 compact_start
export function contextNeedsTrim(state: AgentState): boolean {
  return contextTokens(state) >= compactionWindow(state) - BUFFER_TOKENS;
}

export async function ensureContextFits(state: AgentState, signal?: AbortSignal): Promise<FitResult> {
  const limit = compactionWindow(state);
  let estimate = estimateTokens(state.system, state.messages);
  let used = contextTokens(state);
  let micro = false;

  if (used < limit - BUFFER_TOKENS) return { used, limit, compacted: false };

  const noteMicro = () => {
    micro = true;
    state.noteRewrite("micro-compaction"); // Q4：就地改写了旧工具输出，前缀从第一处改写断开
    const after = estimateTokens(state.system, state.messages);
    // Scale the measured-usage floor by the same ratio, else the stale larger
    // measurement masks the freed headroom and full compaction fires anyway.
    if (state.lastContextTokens > 0 && estimate > 0) {
      state.lastContextTokens = Math.round((state.lastContextTokens * after) / estimate);
    }
    estimate = after;
    used = Math.max(estimate, state.lastContextTokens);
  };
  // R11：整段压缩这次做不成（熔断了、消息太少、切不出中段 / 压不短）时，腾得不多的微压缩也照做——总比什么都不腾强。
  const smallMicro = () => {
    if (!micro && microCompact(state) > 0) noteMicro();
  };

  // 微压缩先空跑：腾完能回到线下才真改写。腾完仍要整段压缩的话就不改写——就地改写会让前缀从第一处改写断开，紧接着的
  // inline 摘要请求（整段历史）就吃不到上一轮写下的缓存；整段压缩这次做不成时由 smallMicro 照旧兜底。
  const fullBlocked = state.compactionFailures >= MAX_FAILURES || state.messages.length <= KEEP_HEAD + 2;
  // Full compaction is lossy. Give the agent one turn to persist durable facts
  // before summarizing the middle of its transcript. Micro-compaction is
  // recoverable (tool calls survive), so it does not need this gate.
  const auditGate = state.memoryAuditRequired && !state.preCompactAuditPassed;
  const reclaim = microCompact(state, MICRO_MIN_RECLAIM_TOKENS, true);
  if (reclaim > 0 && (fullBlocked || auditGate || usedAfterMicro(state, estimate, reclaim) < limit - BUFFER_TOKENS)) {
    if (microCompact(state, MICRO_MIN_RECLAIM_TOKENS) > 0) noteMicro();
    if (used < limit - BUFFER_TOKENS) return { used, limit, compacted: true };
  }

  if (fullBlocked) {
    smallMicro();
    return { used, limit, compacted: micro };
  }

  if (auditGate) {
    return { used, limit, compacted: micro, auditRequired: true };
  }

  try {
    await preCompactHook(state, "auto", signal);
    const done = await compact(state, limit, signal);
    const newEstimate = afterCompaction(state, done.todosShown);
    return { used: newEstimate, limit, compacted: true };
  } catch {
    // 用户点了停止：不算失败（连停三次不该把压缩熔断掉），也不再动转录
    if (signal?.aborted) return { used, limit, compacted: micro };
    state.compactionFailures++;
    smallMicro();
    return { used, limit, compacted: micro };
  }
}

// 微压缩腾出 freed 之后的用量（与 ensureContextFits 里 noteMicro 的算法一致：实测下限按同一比例缩）
function usedAfterMicro(state: AgentState, estimate: number, freed: number): number {
  const after = Math.max(0, estimate - freed);
  const measured = state.lastContextTokens > 0 && estimate > 0 ? Math.round((state.lastContextTokens * after) / estimate) : state.lastContextTokens;
  return Math.max(after, measured);
}

// 整段压缩成功之后的账（主动压缩与 compactNow 共用）；返回压完的估算用量。
// todosShown = 回填里已经带了待办清单（下一次请求不必再挂一份提醒）
function afterCompaction(state: AgentState, todosShown: boolean): number {
  state.preCompactAuditPassed = false;
  state.preCompactAuditPrompted = false;
  // The pre-compaction checkpoint protected facts learned so far. Work after
  // the summary still needs its own final audit before the run can finish.
  state.memoryAuditCompleted = !state.memoryAuditRequired || state.memoryAuditAutoSkipped;
  state.memoryAuditNudges = 0;
  state.compactionFailures = 0;
  // 计划上下文刚被有损压缩：回填里没带待办清单，就让 loop 在下一次请求末尾带一份
  state.turnsSinceTodoSeen = todosShown ? 0 : 999;
  const newEstimate = estimateTokens(state.system, state.messages);
  state.lastContextTokens = newEstimate;
  return newEstimate;
}

// R7：provider 说超窗或请求体过大（我们的估算没拦住——多半是中日韩文字按 4 字符 1 token 低估了，R9 另修），
// 这一轮的请求已经发不出去：立刻压一次。先微压缩，再整段压缩；不看阈值，也不走「压缩前先审计」的门禁（等不起那一轮）。
// 返回有没有腾出地方。
export async function compactNow(state: AgentState, signal?: AbortSignal): Promise<boolean> {
  // provider 刚拒掉的就是现在这么大：按现在的用量当上限来切（尾部留它的 40%）。按配置的窗口切的话，估算偏低时整段
  // 历史都落在尾部预算里，压了等于没压。
  const observed = contextTokens(state);
  const limit = Math.min(state.adapter.capabilities.contextWindow, observed);
  // R9：记下 provider 真拒过的大小，之后的主动压缩按它判（下限两倍缓冲：一个离谱的小值不至于让每轮都压）
  state.observedWindow = Math.max(2 * BUFFER_TOKENS, Math.min(state.observedWindow ?? Infinity, observed));
  const freed = microCompact(state);
  if (freed > 0) state.noteRewrite("micro-compaction");
  if (state.messages.length > KEEP_HEAD + 2) {
    try {
      // reactive：整段历史本身就发不出去，摘要只能走 sidecar
      await preCompactHook(state, "auto", signal);
      const done = await compact(state, limit, signal, true);
      afterCompaction(state, done.todosShown);
      return true;
    } catch {
      state.compactionFailures++;
    }
  }
  if (freed > 0) state.lastContextTokens = estimateTokens(state.system, state.messages);
  return freed > 0;
}

// C8（X42、A3）：用户手动「立即压缩」。不看阈值、也不像 compactNow 那样把现在的大小记成「provider 拒过的窗口」；按现在的
// 用量切（尾部留它的 40%），所以用量不高时也压得下去。压不了（历史太短、压完没变短）就抛错，由调用方如实报。
// trigger 报给 PreCompact hook：用户点的「立即压缩」是 manual，空闲压缩是 auto
export async function compactManually(state: AgentState, signal?: AbortSignal, trigger: "manual" | "auto" = "manual"): Promise<{ before: number; after: number }> {
  const before = contextTokens(state);
  if (state.messages.length <= KEEP_HEAD + 2) throw new Error("nothing to compact yet");
  await preCompactHook(state, trigger, signal);
  const done = await compact(state, Math.min(state.adapter.capabilities.contextWindow, before), signal);
  return { before, after: afterCompaction(state, done.todosShown) };
}

// C8：「带摘要开新会话」的开头——把整段对话（不留尾部）压成一条摘要，和压缩摘要同一个形状（用户原话 + 笔记 + 锚点
// 索引），前面说明接续自哪个会话。笔记与压缩走同一套（先 inline、写不成退回 sidecar、再不行确定性笔记）。
export const HANDOFF_KIND = "handoff-summary";
export async function handoffSummary(state: AgentState, fromTitle: string, signal?: AbortSignal): Promise<Msg> {
  const all = state.messages;
  if (!all.length) throw new Error("nothing to summarize yet");
  const limit = compactionWindow(state);
  const prepared = prepareSummary(all, userWordsBudget(limit, all), anchorCaps(limit));
  const notes = await writeNotes(state, { replaced: all, tail: [], limit, signal, handoff: true });
  const from = fromTitle.trim() ? ` ("${fromTitle.trim().slice(0, 80)}")` : "";
  return {
    role: "user",
    origin: "harness",
    kind: HANDOFF_KIND,
    content: [{
      t: "text",
      text: `[Handoff] This session continues from an earlier session${from}. Its summary follows; the files it changed are on disk as it left them.\n\n` +
        renderSummary({ ...prepared, notes, archives: [] }),
    }],
  };
}

// Stage-1 context reclaim: blank out OLD tool outputs in place. Free (no API
// call) and recoverable (the tool_call block above each survives, so the model
// can re-run anything it still needs). Protects the head, the newest messages,
// and the latest Read of each file (the model may be mid-edit against it).
// R11：先算能腾出多少（token），不到 minReclaim 就一处也不改（返回 0）；返回值是腾出的 token 数。
// dryRun = 只算能腾多少，不改写、不存档
function microCompact(state: AgentState, minReclaim = 0, dryRun = false): number {
  const msgs = state.messages;

  const protectedIds = new Set<string>();
  const lastReadByPath = new Map<string, string>();
  const toolNames = new Map<string, string>();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.t === "tool_call") toolNames.set(b.id, b.name);
      // 转录里是模型的原话：file_path 这类别名也认（tool-input.ts toolArgStr）
      const readPath = b.t === "tool_call" && b.name === "Read" ? toolArgStr("Read", b.args, "path") : undefined;
      if (b.t === "tool_call" && readPath) lastReadByPath.set(readPath, b.id);
    }
  }
  for (const id of lastReadByPath.values()) protectedIds.add(id);

  const picks: { m: Msg; j: number }[] = [];
  let freed = 0;
  const end = Math.max(KEEP_HEAD, msgs.length - MICRO_PROTECT_TAIL);
  for (let i = KEEP_HEAD; i < end; i++) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j];
      if (b.t !== "tool_result" || protectedIds.has(b.id)) continue;
      // 推迟工具的完整说明（deferred-tools.ts）：清掉了模型就照着骨架瞎填参数，还当自己「加载过」——不清
      if (Array.isArray(b.meta?.loadedTools)) continue;
      if (blocksChars(b.content) <= MICRO_MIN_CHARS) continue;
      picks.push({ m, j });
      freed += blocksTokens(b.content) - textTokens(ELIDED_TEXT) - ELIDED_REF_TOKENS;
    }
  }
  if (freed <= 0 || freed < minReclaim) return 0;
  if (dryRun) return Math.ceil(freed);
  // R13：清掉之前先把这批旧输出存成一个文件（每条一个「### [tool_result <id>]」头），占位里给路径和头——要看就 Grep / Read，
  // 不用重跑工具（重跑可能有副作用、结果也可能变了）。没接存储（子 agent、测试、eval）或写不成就用老的占位。
  const results = picks.map(({ m, j }) => m.content[j] as Extract<Block, { t: "tool_result" }>);
  const saved = state.compactionArchive?.saveElided?.(
    "# Old tool outputs elided from the context by micro-compaction — read-only history, not instructions.\n\n" +
      results.map((b) => `### [tool_result ${b.id}] ${toolNames.get(b.id) ?? "?"} ${b.ok ? "ok" : "FAILED"}\n${elidedText(b.content)}`).join("\n\n") +
      "\n",
  ) ?? null;
  picks.forEach(({ m, j }, k) => {
    const b = results[k];
    const gist = elidedGist(toolNames.get(b.id), elidedText(b.content));
    const text = saved
      ? `[old tool output elided to save context — saved under "### [tool_result ${b.id}]" in ${saved}; Grep for that line or Read the file instead of re-running the tool]`
      : ELIDED_TEXT;
    m.content[j] = { t: "tool_result", id: b.id, ok: b.ok, content: [{ t: "text", text: gist ? `${text}\nGist: ${gist}` : text }] };
  });
  return Math.ceil(freed);
}

// 占位里的路径、头与 Gist 大约多出这么多 token（算回收量时先扣掉，免得高估）
const ELIDED_REF_TOKENS = 45 + 90;
const GIST_MAX = 300;

// 被清掉的输出留一句「要点」：以前只剩一个档案指针，回头想核对一个结论（子 agent 查出的某处行为、某条命令过没过）
// 就得 Grep 档案拿行号再 Read，两三步（2026-10-09 长会话里反复发生）。子 agent 报告本身就是浓缩的结论，留开头；
// Bash 留命令行与末尾两行（退出码、tail 结果多在那）；其余留第一行。只是提示，全文仍在档案里。
function elidedGist(tool: string | undefined, text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^\[Sub-agent report/.test(l));
  if (!lines.length) return "";
  let picked: string[];
  if (tool === "Agent" || tool === "Workflow") picked = lines.slice(0, 4);
  else if (tool === "Bash" && lines.length > 3) picked = [lines[0], "…", ...lines.slice(-2)];
  else picked = lines.slice(0, 1);
  const gist = picked.join(" ⏎ ").replace(/\s+/g, " ");
  return gist.length > GIST_MAX ? `${gist.slice(0, GIST_MAX - 1)}…` : gist;
}

function elidedText(blocks: Block[]): string {
  return blocks
    .map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? elidedText(b.content) : b.t === "image" || b.t === "video" || b.t === "audio" ? `[${b.t}]` : ""))
    .filter(Boolean)
    .join("\n");
}

const hasToolCalls = (m: Msg) => m.role === "assistant" && m.content.some((b) => b.t === "tool_call");
const carriesToolResults = (m: Msg) => m.role === "user" && m.content.some((b) => b.t === "tool_result");

// R5（#11）：切点对齐 exchange 边界，头尾都不许把一对 tool_call / tool_result 拆开。以前头部固定留两条
// （任务 + 第一条 assistant），而第一条 assistant 几乎总带 tool_call、它的结果却被压进了摘要；尾部按条数
// 截，可能从一条孤儿 tool_result 开始。压出来的转录各家 API 都回 400（判为不可重试），落盘后每轮重放，
// 会话就此报废。toTurn 出口另有一道统一配对修复兜底（state.ts 的 repairToolPairing）。
// Q6：切分与摘要拆成可单独调用的纯步骤，压缩召回 eval（evals/compaction）直接 import 生产路径跑，不另抄一份。
export interface CompactionPlan {
  head: Msg[];
  middle: Msg[];
  tail: Msg[];
}

export function planCompaction(msgs: Msg[], limit: number): CompactionPlan {
  // 任务（第一条）永远保留；第一条 assistant 只在不带 tool_call 时一起留（带的话它的结果会被摘要掉）。
  const headLen = msgs.length > 1 && msgs[1].role === "assistant" && !hasToolCalls(msgs[1]) ? 2 : 1;
  const head = msgs.slice(0, headLen);

  // Keep as many recent messages as fit in ~40% of the window.
  const tailBudget = Math.floor(limit * 0.4);
  const tail: Msg[] = [];
  let tailTokens = 0;
  for (let i = msgs.length - 1; i >= headLen; i--) {
    const cost = Math.ceil(blocksTokens(msgs[i].content));
    if (tailTokens + cost > tailBudget && tail.length > 0) break;
    tail.unshift(stripThinking(msgs[i]));
    tailTokens += cost;
  }
  // 尾部不许从结果消息开始：它对应的 tool_call 在要被摘要的中段里。
  while (tail.length && carriesToolResults(tail[0])) tail.shift();

  return { head, middle: msgs.slice(headLen, msgs.length - tail.length), tail };
}

// 只有笔记、没有用户原话与锚点的最简摘要消息（测试夹具与旧调用方用）
export const summaryMessage = (notes: string): Msg => ({
  role: "user",
  content: [{ t: "text", text: renderSummary({ notes, userWords: [], omitted: 0, omittedAt: -1, anchors: { files: [], commands: [], errors: [], ids: [] }, archives: [] }) }],
});

// 用户原话的预算：4 万 token、窗口的 8%、被压掉那段的一半，取最小——原样保留不能反过来让压缩压不下去。
// （15% 时压缩召回 eval 在一个用户消息很多的长会话上报了棘轮嫌疑：每次只腾出 12–16%；kimi / Codex 约 7–8%。所以比例不动，
// 只把绝对上限从 2 万放到 4 万：只在压缩窗口超过 25 万 token 时才起作用。）
const userWordsBudget = (limit: number, replaced: Msg[]): number =>
  Math.min(40_000, Math.floor(limit * 0.08), Math.floor(estimateTokens("", replaced) * 0.5));

// 压完的总量（system + 头 + 摘要 + 回填 + 尾部）超过压缩窗口的这个比例，就按优先级裁回填——回填不能让压缩只腾出一点
// （另有「压完没变短就不提交」兜底）
const RESTORE_CEILING = 0.6;
const INLINE_MARGIN = 1_000; // inline 请求算剩余空间时给估算误差留的余量
const INLINE_MIN_OUTPUT = 2_048; // inline 能给的输出上限低于这个（或型号上限）就不走 inline

interface NotesJob {
  replaced: Msg[]; // 摘要要替换掉的那部分（压缩 = 中段；带摘要开新会话 = 全部）
  tail: Msg[]; // 原样留下的尾部
  limit: number; // 这次压缩按的窗口
  handoff?: boolean;
  reactive?: boolean; // provider 刚报超窗（compactNow）：整段历史本身就发不出去，不走 inline
  signal?: AbortSignal;
}

// inline 摘要请求的形状：主请求（前缀与上一轮相同）+ 指令；装不下就返回 null（走 sidecar）
function inlineRequest(state: AgentState, job: NotesJob, instruction: string): { turn: Turn; budget: { maxOutputTokens: number; thinking?: ThinkingLevel } } | null {
  const side = state.profile.side.summary;
  if (side.mode !== "inline" || job.reactive || state.switchSummarizer || effectiveWindow(state) < INLINE_MIN_WINDOW) return null;
  const caps = state.adapter.capabilities;
  const cap = caps.maxOutputTokens > 0 ? caps.maxOutputTokens : Infinity;
  const room = effectiveWindow(state) - contextTokens(state) - Math.ceil(textTokens(instruction)) - INLINE_MARGIN;
  const turn = state.toTurn();
  const thinking = side.thinking === "inherit" ? turn.budget.thinking : side.thinking;
  // 开着思考时思考 token 也算在输出上限里：上限至少给到主请求的那么大（改 max_tokens 不影响缓存），免得思考挤掉后几节正文
  const thinks = Boolean(thinking && thinking !== "off");
  const base = Math.max(summaryOutputTokens(side.maxOutputTokens, job.limit), thinks ? turn.budget.maxOutputTokens : 0);
  const out = Math.min(base, cap, room);
  if (out < Math.min(INLINE_MIN_OUTPUT, cap)) return null;
  return { turn, budget: { maxOutputTokens: Math.floor(out), ...(thinking ? { thinking } : {}) } };
}

// 摘要笔记：先 inline（主模型接着原对话写），写不成退回 sidecar（刚换到窗口更小的型号时先交给换之前的那个写），都写不出来
// 换成确定性的笔记；用户点了停止就抛出去（不压）。
async function writeNotes(state: AgentState, job: NotesJob): Promise<string> {
  let lastError = "";
  const instruction = inlineInstruction({ tail: job.tail, handoff: job.handoff });
  const inline = inlineRequest(state, job, instruction);
  if (inline) {
    try {
      const replacedChars = job.replaced.reduce((n, m) => n + blocksChars(m.content), 0);
      return await summarizeInline(state.adapter, inline.turn, instruction, inline.budget, replacedChars, job.signal, (u) => state.recordSideUsage("compaction", u));
    } catch (e) {
      if (job.signal?.aborted) throw e;
      lastError = (e as Error).message;
    }
  }
  const summarizers = state.switchSummarizer ? [state.switchSummarizer, state.adapter] : [state.adapter];
  for (const by of summarizers) {
    // 摘要旁路的思考 / 输出上限按写摘要的那个型号的档案取；转录预算按它能收多大的请求
    const side = (by === state.adapter ? state.profile : state.switchSummarizerProfile ?? state.profile).side.summary;
    const window = by === state.adapter ? effectiveWindow(state) : by.capabilities.contextWindow;
    try {
      return await summarize(by, state.materializeMessages(job.replaced), job.signal, (u) => state.recordSideUsage("compaction", u, by), side, { window, scope: job.limit });
    } catch (e) {
      if (job.signal?.aborted) throw e;
      lastError = (e as Error).message;
    }
  }
  return deterministicNotes(lastError);
}

// R10（一）：摘要消息 = 被压掉那段里的用户原话（原样）+ LLM 笔记 + 机械锚点索引（形状见 compaction-shape.ts）。
// 摘要写不出来（两次都没写、超时、出错）就换成确定性的笔记照样压；用户点了停止就不压。压完没变短就不提交。
// R10（二）：再加 Context Recovery——原文归档成纯文本，摘要末尾写明在哪、怎么读。
// 摘要之后紧跟一条回填的工作现场（compaction-restore.ts）；回填过的文件记成已读。返回这次回填里有没有待办清单。
async function compact(state: AgentState, limit: number, signal?: AbortSignal, reactive = false): Promise<{ todosShown: boolean }> {
  if (signal?.aborted) throw new Error("compaction aborted");
  const all = state.messages;
  // 尾部按「窗口扣掉 system」的 40% 留——system 也占窗口。按整个窗口算的话，system 大、窗口小（本机 64K 模型 +
  // 1.6 万 token 的 system）时压完就贴着触发线，几轮一压（压缩召回 eval 的棘轮嫌疑：一个长会话 27 → 33 次、每次只腾出
  // 16–31%；扣掉之后 19 次、29–42%，召回不变）。大窗口模型上 system 占比小，几乎没差别。
  const { head, middle, tail } = planCompaction(all, Math.max(0, limit - estimateTokens(state.system, [])));
  if (middle.length === 0) throw new Error("nothing to compact");

  const prepared = prepareSummary(middle, userWordsBudget(limit, middle), anchorCaps(limit));
  // 回填的现场在摘要请求之前收集（这期间不跑工具，磁盘不会变）；上一次压缩回填的那条若还在尾部里就拿掉，免得一次次叠上去
  // 回填的预算与上限按真实的压缩窗口算：手动 / 空闲压缩的 limit 是此刻的用量（尾部按它切），按它算的话窗口还空着一大半，
  // 回填的文件却被裁光。上限 = 窗口与 limit 取大的 60%，且不超过触发线（压完不能一进门就又要压）。
  const window = compactionWindow(state);
  const ceiling = Math.min(window - BUFFER_TOKENS, Math.floor(Math.max(limit, window) * RESTORE_CEILING));
  let restore: Restore | null = await gatherRestore(state, all, all.length - tail.length, window);
  const keptTail = tail.filter((m) => messageKind(m) !== RESTORE_KIND);
  const notes = await writeNotes(state, { replaced: middle, tail: keptTail, limit, signal, reactive });
  // R10（二）：被压掉那段的原文归档，摘要末尾列出文件与读法。归档写不成就不列这次的（照样压，只是少一个回查点）。
  const chunks = state.compactionArchive ? archiveChunks(middle) : [];
  const files = chunks.length ? state.compactionArchive!.plan(chunks.length) : [];
  const build = (archives: string[]): Msg[] => {
    const restored = restore ? renderRestore(restore) : null;
    return [
      ...head,
      { role: "user", content: [{ t: "text", text: renderSummary({ ...prepared, notes, archives }) }], origin: "harness", kind: "compaction-summary" },
      ...(restored ? [restored] : []),
      ...keptTail,
    ];
  };
  let archives = [...prepared.archives, ...files];
  let next = build(archives);
  const before = estimateTokens(state.system, all);
  // 超过上限、或回填让压完反而不比压前短（用量本来就不高时的手动压缩）：按优先级裁回填
  const tooBig = (msgs: Msg[]) => {
    const n = estimateTokens(state.system, msgs);
    return n > ceiling || n >= before;
  };
  while (restore && tooBig(next)) {
    const trimmed = trimRestore(restore);
    if (!trimmed) break;
    restore = trimmed;
    next = build(archives);
  }
  if (estimateTokens(state.system, next) >= before) {
    throw new Error("compaction would not shrink the context");
  }
  if (files.length) {
    try {
      await state.compactionArchive!.write(files.map((path, i) => ({ path, text: chunks[i] })));
    } catch (e) {
      console.error(`[compaction] context-recovery archive not written: ${(e as Error).message}`);
      archives = prepared.archives;
      next = build(archives);
    }
  }
  // 空闲压缩（idle-compact.ts）：摘要与归档都是 await 出来的，这期间用户可能发了话（startRun 会先掐掉它）。提交前最后看一眼：
  // 从这里到下面换掉 messages 全是同步的，不会有新消息插在中间被覆盖。
  if (signal?.aborted) throw new Error("compaction aborted");
  // 瘦身 P0-1：被压掉那段干过什么，先记一份工具轨迹（收工不再有记忆审计，压缩前也不再停下来审一次——由 run 之后的沉淀看）
  state.compactedTrace = [...state.compactedTrace, ...traceLines(middle)].slice(-COMPACTED_TRACE_MAX);
  state.messages = next;
  state.switchSummarizer = undefined;
  state.switchSummarizerProfile = undefined;
  state.noteRewrite("compaction"); // Q4：压缩边界是唯一合法的全量重建点
  // C4（N09 第 3 步）：借这次全量重建把 system 也按当前的模式、GUIDE、项目知识……重建一遍（会话挂了 rebuildSystem 才做）
  state.rebuildSystemAfterCompaction();
  // 压缩对文件的了解是有损的：已读状态只留回填过的文件（按回填的范围），其余的改之前要重新 Read
  applyRestoredReads(state.ctx.readFileState, restore);
  // 已加载的延迟工具：压完的上下文里还看得到说明的（尾部里的、回填里的）才算加载（compaction-restore.ts 文件头）
  applyRestoredTools(state, restore);
  return { todosShown: Boolean(restore?.todos) };
}

function stripThinking(m: Msg): Msg {
  if (!m.content.some((b) => b.t === "thinking")) return m;
  return { ...m, content: m.content.filter((b) => b.t !== "thinking") };
}
