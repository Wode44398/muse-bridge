import type { Block, Msg } from "./turn.ts";
import type { AgentState } from "./state.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import { archiveChunks, deterministicNotes, prepareSummary, renderSummary, sampleTranscript } from "./compaction-shape.ts";
import { runningJobsSummary } from "../tools/bash.ts";

export const BUFFER_TOKENS = 13_000; // CC's AUTOCOMPACT_BUFFER_TOKENS
const MAX_FAILURES = 3; // CC's MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
const KEEP_HEAD = 2; // earliest messages (task goal) never dropped

// Micro-compaction (stage 1, free): elide stale tool outputs in place.
const MICRO_MIN_CHARS = 600; // eliding smaller results buys ~nothing
const MICRO_PROTECT_TAIL = 6; // the most recent messages stay intact
const ELIDED_TEXT =
  "[old tool output elided to save context — re-run the tool if you need it again]";
// R11：微压缩的滞回——一次腾不出这么多就不改写。就地改写旧工具输出会让请求前缀从改写处断开（缓存从那里失效，自建的
// llama.cpp 服务要从那里重新 prefill）；在触发线附近每轮腾一点、每轮断一次，不如直接整段压缩换一段长跑道。
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
    if (b.t === "text" || b.t === "thinking") n += textTokens(b.text);
    else if (b.t === "tool_call") n += textTokens(JSON.stringify(b.args)) + b.name.length / 4;
    else if (b.t === "tool_result") n += blocksTokens(b.content);
    else n += blocksChars([b]) / 4; // 图片 / 视频 / 音频：沿用按字符折算的固定估值
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
    if (b.t === "text" || b.t === "thinking") n += b.text.length;
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

  if (microCompact(state, MICRO_MIN_RECLAIM_TOKENS) > 0) {
    noteMicro();
    if (used < limit - BUFFER_TOKENS) return { used, limit, compacted: true };
  }

  if (state.compactionFailures >= MAX_FAILURES || state.messages.length <= KEEP_HEAD + 2) {
    smallMicro();
    return { used, limit, compacted: micro };
  }

  // Full compaction is lossy. Give the agent one turn to persist durable facts
  // before summarizing the middle of its transcript. Micro-compaction above is
  // recoverable (tool calls survive), so it does not need this gate.
  if (state.memoryAuditRequired && !state.preCompactAuditPassed) {
    return { used, limit, compacted: micro, auditRequired: true };
  }

  try {
    await compact(state, limit, signal);
    const newEstimate = afterCompaction(state);
    return { used: newEstimate, limit, compacted: true };
  } catch {
    // 用户点了停止：不算失败（连停三次不该把压缩熔断掉），也不再动转录
    if (signal?.aborted) return { used, limit, compacted: micro };
    state.compactionFailures++;
    smallMicro();
    return { used, limit, compacted: micro };
  }
}

// 整段压缩成功之后的账（主动压缩与 compactNow 共用）；返回压完的估算用量。
function afterCompaction(state: AgentState): number {
  state.preCompactAuditPassed = false;
  state.preCompactAuditPrompted = false;
  // The pre-compaction checkpoint protected facts learned so far. Work after
  // the summary still needs its own final audit before the run can finish.
  state.memoryAuditCompleted = !state.memoryAuditRequired || state.memoryAuditAutoSkipped;
  state.memoryAuditNudges = 0;
  state.compactionFailures = 0;
  // The plan context was just lossy-compressed; make the loop re-show todos.
  state.turnsSinceTodoSeen = 999;
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
      await compact(state, limit, signal);
      afterCompaction(state);
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
export async function compactManually(state: AgentState, signal?: AbortSignal): Promise<{ before: number; after: number }> {
  const before = contextTokens(state);
  if (state.messages.length <= KEEP_HEAD + 2) throw new Error("nothing to compact yet");
  await compact(state, Math.min(state.adapter.capabilities.contextWindow, before), signal);
  return { before, after: afterCompaction(state) };
}

// C8：「带摘要开新会话」的开头——把整段对话（不留尾部）压成一条摘要，和压缩摘要同一个形状（用户原话 + 笔记 + 锚点
// 索引），前面说明接续自哪个会话。摘要写不出来就换成确定性的笔记（同压缩）。
export const HANDOFF_KIND = "handoff-summary";
export async function handoffSummary(state: AgentState, fromTitle: string, signal?: AbortSignal): Promise<Msg> {
  const all = state.messages;
  if (!all.length) throw new Error("nothing to summarize yet");
  const limit = state.adapter.capabilities.contextWindow;
  const userBudget = Math.min(20_000, Math.floor(limit * 0.08), Math.floor(estimateTokens("", all) * 0.5));
  const prepared = prepareSummary(all, userBudget);
  let notes: string;
  try {
    notes = await summarize(state.adapter, state.materializeMessages(all), signal, (u) => state.recordSideUsage("compaction", u));
  } catch (e) {
    if (signal?.aborted) throw e;
    notes = deterministicNotes((e as Error).message);
  }
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
function microCompact(state: AgentState, minReclaim = 0): number {
  const msgs = state.messages;

  const protectedIds = new Set<string>();
  const lastReadByPath = new Map<string, string>();
  const toolNames = new Map<string, string>();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.t === "tool_call") toolNames.set(b.id, b.name);
      if (b.t === "tool_call" && b.name === "Read" && typeof b.args?.path === "string") {
        lastReadByPath.set(b.args.path, b.id);
      }
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
      if (blocksChars(b.content) <= MICRO_MIN_CHARS) continue;
      picks.push({ m, j });
      freed += blocksTokens(b.content) - textTokens(ELIDED_TEXT) - ELIDED_REF_TOKENS;
    }
  }
  if (freed <= 0 || freed < minReclaim) return 0;
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
    const text = saved
      ? `[old tool output elided to save context — saved under "### [tool_result ${b.id}]" in ${saved}; Grep for that line or Read the file instead of re-running the tool]`
      : ELIDED_TEXT;
    m.content[j] = { t: "tool_result", id: b.id, ok: b.ok, content: [{ t: "text", text }] };
  });
  return Math.ceil(freed);
}

// 占位里的路径与头大约多出这么多 token（算回收量时先扣掉，免得高估）
const ELIDED_REF_TOKENS = 45;

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
// Q6：切分与摘要拆成可单独调用的纯步骤，离线评测可以直接 import 生产路径跑，不另抄一份。
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

// R10（一）：摘要消息 = 被压掉那段里的用户原话（原样）+ LLM 笔记 + 机械锚点索引（形状见 compaction-shape.ts）。
// 摘要写不出来（两次都没写、超时、出错）就换成确定性的笔记照样压；用户点了停止就不压。压完没变短就不提交。
// R10（二）：再加 Context Recovery——原文归档成纯文本，摘要末尾写明在哪、怎么读。
async function compact(state: AgentState, limit: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("compaction aborted");
  // 尾部按「窗口扣掉 system」的 40% 留——system 也占窗口。按整个窗口算的话，system 大、窗口小（本机 64K 模型 +
  // 1.6 万 token 的 system）时压完就贴着触发线，几轮一压（压缩召回 eval 的棘轮嫌疑：一个长会话 27 → 33 次、每次只腾出
  // 16–31%；扣掉之后 19 次、29–42%，召回不变）。大窗口模型上 system 占比小，几乎没差别。
  const { head, middle, tail } = planCompaction(state.messages, Math.max(0, limit - estimateTokens(state.system, [])));
  if (middle.length === 0) throw new Error("nothing to compact");

  // 用户原话的预算：2 万 token、窗口的 8%、被压掉那段的一半，取最小——原样保留不能反过来让压缩压不下去。
  // （15% 时压缩召回 eval 在一个用户消息很多的长会话上报了棘轮嫌疑：每次只腾出 12–16%；kimi / Codex 约 7–8%。）
  const userBudget = Math.min(20_000, Math.floor(limit * 0.08), Math.floor(estimateTokens("", middle) * 0.5));
  const prepared = prepareSummary(middle, userBudget);
  let notes: string;
  try {
    notes = await summarize(state.adapter, state.materializeMessages(middle), signal, (u) => state.recordSideUsage("compaction", u));
  } catch (e) {
    if (signal?.aborted) throw e;
    notes = deterministicNotes((e as Error).message);
  }
  // R10（二）：被压掉那段的原文归档，摘要末尾列出文件与读法。归档写不成就不列这次的（照样压，只是少一个回查点）。
  const chunks = state.compactionArchive ? archiveChunks(middle) : [];
  const files = chunks.length ? state.compactionArchive!.plan(chunks.length) : [];
  // O6（K63）：还在跑的后台 job 写在摘要末尾——锚点索引收不到 job id，压完模型就不知道自己有什么在跑
  const running = state.ctx.ownerId ? runningJobsSummary(state.ctx.ownerId) : "";
  const jobsNote = running
    ? `\n\nBackground jobs still running for this session: ${running}. Bash(wait:"<id>") waits for one to finish; Bash(poll:"<id>") reads its output now.`
    : "";
  const withSummary = (archives: string[]): Msg[] => [
    ...head,
    { role: "user", content: [{ t: "text", text: renderSummary({ ...prepared, notes, archives }) + jobsNote }], origin: "harness", kind: "compaction-summary" },
    ...tail,
  ];
  let next = withSummary([...prepared.archives, ...files]);
  if (estimateTokens(state.system, next) >= estimateTokens(state.system, state.messages)) {
    throw new Error("compaction would not shrink the context");
  }
  if (files.length) {
    try {
      await state.compactionArchive!.write(files.map((path, i) => ({ path, text: chunks[i] })));
    } catch (e) {
      console.error(`[compaction] context-recovery archive not written: ${(e as Error).message}`);
      next = withSummary(prepared.archives);
    }
  }
  state.messages = next;
  state.noteRewrite("compaction"); // Q4：压缩边界是唯一合法的全量重建点
  // C4（N09 第 3 步）：借这次全量重建把 system 也按当前的模式、GUIDE、项目知识……重建一遍（会话挂了 rebuildSystem 才做）
  state.rebuildSystemAfterCompaction();
  // Compaction is lossy for file state; force fresh Reads before future Edits.
  state.ctx.readFileState.clear();
}

function stripThinking(m: Msg): Msg {
  if (!m.content.some((b) => b.t === "thinking")) return m;
  return { ...m, content: m.content.filter((b) => b.t !== "thinking") };
}

// 压缩摘要是主线之外的一次旁路请求；Q2 的分窗器按这个 system 认出它（认身份，不认措辞）。
export const COMPACTION_SYSTEM =
  "You compress an agent transcript. Preserve concrete facts the agent will need to keep working: " +
  "files read and their key contents, decisions made, commands run and their results, current progress, " +
  "and remaining work. Be specific (names, paths, values). Prefer 'read X, found Y' over quoting.";

// #83：用户消息里以前只有转录本身、没有一句指令，关着思考的模型常把它当成待续写的数据——本机 Qwen 连跑 5 次有 2 次
// 只回「.」或几十个字，压缩于是悄悄清空了上下文。现在转录包进 <transcript>、后面明说「现在写摘要」；输出短得离谱就
// 重试一次，还不行就按压缩失败处理（失败计数、满 3 次熔断）——宁可报错，也不悄悄丢上下文。
export const SUMMARY_INSTRUCTION = "Write the summary of the transcript above now, following your instructions.";
const DEGENERATE_SUMMARY_CHARS = 200; // 输入超过 2000 字符时，摘要短于这个数就算没写
const SUMMARY_ATTEMPTS = 2;
const SUMMARY_INPUT_CHARS = 60_000; // 交给摘要器的转录上限；超了按条均匀采样
// R10：摘要请求的时限（到点就走确定性笔记）；DIMENSIO_SUMMARY_TIMEOUT_MS 给测试调短
const summaryTimeoutMs = (): number => Number(process.env.DIMENSIO_SUMMARY_TIMEOUT_MS) || 180_000;

// signal：run 的停止信号——用户点了停止，摘要请求不再发（#31）；另有自己的时限。
// O8：onUsage = 这次摘要请求（每次尝试）的用量，给用量账本记一笔（任务 compaction）
export async function summarize(
  adapter: ProviderAdapter,
  middle: Msg[],
  signal?: AbortSignal,
  onUsage?: (u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => void,
): Promise<string> {
  const transcript = sampleTranscript(middle.map(renderMsg), SUMMARY_INPUT_CHARS);
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new Error("summary aborted");
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(summaryTimeoutMs())]) : AbortSignal.timeout(summaryTimeoutMs());
    let out = "";
    const stream = adapter.stream(
      {
        system: COMPACTION_SYSTEM,
        messages: [{ role: "user", content: [{ t: "text", text: `<transcript>\n${transcript}\n</transcript>\n\n${SUMMARY_INSTRUCTION}` }] }],
        tools: [],
        budget: { maxOutputTokens: 1500, thinking: "off" },
      },
      bounded,
    );
    for await (const ev of stream) {
      if (ev.e === "text_delta") out += ev.text;
      else if (ev.e === "usage") onUsage?.(ev);
      else if (ev.e === "error") throw new Error(ev.kind);
    }
    if (bounded.aborted) throw new Error(signal?.aborted ? "summary aborted" : "summary timed out");
    const degenerate = !out.trim() || (transcript.length > 2000 && out.trim().length < DEGENERATE_SUMMARY_CHARS);
    if (!degenerate) return out;
    if (attempt >= SUMMARY_ATTEMPTS) throw new Error(`degenerate summary (${out.trim().length} chars for ${transcript.length} chars of transcript)`);
  }
}

function renderMsg(m: Msg): string {
  const parts = m.content.map((b) => {
    if (b.t === "text") return b.text;
    if (b.t === "thinking") return "";
    if (b.t === "tool_call") return `[tool ${b.name} ${JSON.stringify(b.args).slice(0, 500)}]`;
    if (b.t === "tool_result") {
      const txt = b.content.map((c) => (c.t === "text" ? c.text : "")).join("");
      return `[result ${b.ok ? "ok" : "err"}: ${txt.slice(0, 1500)}]`;
    }
    return "";
  });
  return `${m.role.toUpperCase()}: ${parts.filter(Boolean).join("\n")}`;
}
