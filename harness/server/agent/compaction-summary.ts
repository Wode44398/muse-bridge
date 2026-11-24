// 整段压缩的摘要怎么写。两条路，同一份分节要求：
//   · inline（默认）：主模型接着原对话写——请求 = 会话当前的 system + 工具表 + 完整消息历史 + 末尾一条摘要指令。前缀与上一轮
//     主请求相同，吃得到提示缓存；摘要器看到的是全文，不是抽样。思考档位跟主请求一致（Anthropic 上改思考配置会让消息段的
//     缓存失效），只单独放宽输出上限。不发工具选择：Anthropic 上改 tool_choice 同样会让消息段缓存失效，靠指令 + 退回兜底。
//   · sidecar：旁路请求，只给被压掉那段的转录（超了按条均匀采样）。窗口很小、provider 刚报超窗、inline 装不下 / 写不出来时走它。
// 预算（输出上限、转录字符、单条工具结果）都随窗口缩放，不再是写死的 1500 token / 6 万字符 / 1500 字。
import type { ProviderAdapter } from "../providers/types.ts";
import { sampleTranscript, tokensOf } from "./compaction-shape.ts";
import { messageKind } from "./injections.ts";
import type { Msg, ThinkingLevel, Turn } from "./turn.ts";

// 模型档案 side.summary 的形状。thinking=inherit：inline 跟主请求同档（缓存不断），sidecar 关思考（新请求没有缓存可保）。
export interface SummaryProfile {
  mode: "inline" | "sidecar";
  maxOutputTokens: number; // 输出上限的基准；实际按窗口缩放（summaryOutputTokens）
  thinking: ThinkingLevel | "inherit";
}
export const SUMMARY_BUDGET: Readonly<SummaryProfile> = Object.freeze({ mode: "inline", maxOutputTokens: 8_000, thinking: "inherit" });

// 窗口小于这个（token）的型号默认走 sidecar：触发线的 1.3 万缓冲已占窗口四成以上，整段历史再加摘要输出常常装不下
export const INLINE_MIN_WINDOW = 32_000;
const OUTPUT_CAP = 16_000; // 按窗口放宽的输出上限封顶（档案给的基准更大时以基准为准）
const DEGENERATE_SUMMARY_CHARS = 200; // 被压的部分超过 2000 字符时，摘要短于这个数就算没写
const SUMMARY_ATTEMPTS = 2;
// R10：摘要请求的时限（到点就走确定性笔记）：至少 3 分钟，输出上限大时按每 token 40ms 放宽（本机模型一秒二三十个 token，
// 8000 token 的摘要写不完 3 分钟）；DIMENSIO_SUMMARY_TIMEOUT_MS 给测试调短
const summaryTimeoutMs = (maxOutputTokens = 0): number => Number(process.env.DIMENSIO_SUMMARY_TIMEOUT_MS) || Math.max(180_000, maxOutputTokens * 40);

type UsageFn = (u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => void;

// 摘要输出上限：小窗口按窗口的 10% 收（至少 1500），大窗口按 4% 放宽（封顶 OUTPUT_CAP）；scope = 这次压缩按的窗口
export function summaryOutputTokens(base: number, scope: number): number {
  const small = Math.min(base, Math.max(1_500, Math.round(scope * 0.1)));
  const large = Math.min(Math.max(base, OUTPUT_CAP), Math.round(scope * 0.04));
  return Math.max(small, large);
}

const SECTIONS = [
  "1. Goal and constraints: what the user wants, and every explicit constraint or preference they stated.",
  "2. Decisions: choices made and why.",
  "3. State: a 'Done (do not redo)' list (edits already applied, files created, commands that succeeded, commits, pushes, " +
    "messages sent), then 'In progress', then 'Remaining'. Only list an action as done when its result appears in the transcript.",
  "4. Files: each file created or changed, and what changed in it.",
  "5. Key facts: what was established, with exact values (paths, function and symbol names, commands, numbers, IDs, hashes, URLs).",
  "6. Errors: errors hit and how each was resolved, or that it is still open.",
  "7. Next step: exactly what you were about to do next.",
].join("\n");

// 压缩摘要旁路请求的 system；Q2 的分窗器按它认出 sidecar 请求（认身份，不认措辞）
export const COMPACTION_SYSTEM =
  "You compress an agent transcript into working notes that the same agent will use to continue the task without re-exploring. " +
  "Be specific (names, paths, values); prefer 'read X, found Y' over quoting. Write these sections:\n" +
  SECTIONS;

// #83：sidecar 的用户消息里转录包进 <transcript>，后面明说「现在写摘要」——关着思考的模型常把裸转录当成待续写的数据
export const SUMMARY_INSTRUCTION = "Write the summary of the transcript above now, following your instructions.";

// inline 指令的开头（injections.ts 按它认类别）；这条只在摘要请求里，不进转录
export const INLINE_HEAD = "[Compaction request]";
export const INLINE_KIND = "compaction-request";

const clip = (s: string, n: number): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

// 尾部第一条消息的一句描述：模型数不清第几条消息，但认得出自己说过的话
function describeMsg(m: Msg): string {
  const kind = messageKind(m);
  for (const b of m.content) {
    if (b.t === "text" && b.text.trim()) {
      if (m.role === "assistant") return `your reply beginning "${clip(b.text, 100)}"`;
      if (kind === null || kind === "steer") return `the user's message beginning "${clip(kind === "steer" ? b.text.slice(b.text.indexOf("\n\n") + 2) : b.text, 100)}"`;
      return `the note beginning "${clip(b.text, 80)}"`;
    }
    if (b.t === "tool_call") return `your ${b.name} call ${clip(JSON.stringify(b.args), 100)}`;
  }
  return `the ${m.role === "assistant" ? "assistant" : "user"} message after that`;
}

// keep：压完原样留下的部分（tail = 尾部；handoff = 整段都被换掉、新会话只有摘要）
export function inlineInstruction(keep: { tail: Msg[]; handoff?: boolean }): string {
  const kept = keep.handoff
    ? "A new session will start from your summary alone: nothing else from this conversation is kept."
    : keep.tail.length
      ? `The first user message and everything from ${describeMsg(keep.tail[0])} to the end (the last ${keep.tail.length} ` +
        `message${keep.tail.length === 1 ? "" : "s"}) stay in context word for word; summarize the part in between, which your summary replaces.`
      : "Only the first user message stays in context word for word; your summary replaces everything after it.";
  return [
    `${INLINE_HEAD} Pause the task for this one reply: the conversation is being compacted to free context. ${kept}`,
    "Write that summary now so that you can carry on afterwards without re-exploring; it will be your only memory of the replaced part. " +
      "Do not call any tools: reply with the summary only, as markdown, in these sections:",
    SECTIONS,
    "The user's own messages and a mechanical index of the files, commands, errors and IDs are carried over separately, so you need " +
      "not quote them in full. " +
      (keep.handoff
        ? "The files this conversation changed stay on disk as they are, so describe changes instead of pasting code."
        : "Your todo list and the current contents of the files you edited most recently are re-attached after the summary when " +
          "there are any, so describe changes instead of pasting code."),
  ].join("\n\n");
}

export function inlineInstructionMsg(text: string): Msg {
  return { role: "user", origin: "harness", kind: INLINE_KIND, content: [{ t: "text", text }] };
}

// inline 写不成（发了工具调用、退化、出错、超时、被输出上限截断）：调用方退回 sidecar
export class InlineSummaryUnusable extends Error {}

// turn = 主请求的形状（state.toTurn()）——前缀与上一轮主请求相同；末尾追加指令，只换输出上限与思考档。
// replacedChars = 被换掉那段的大小，用来判「短得离谱」。
export async function summarizeInline(
  adapter: ProviderAdapter,
  turn: Turn,
  instruction: string,
  budget: { maxOutputTokens: number; thinking?: ThinkingLevel },
  replacedChars: number,
  signal?: AbortSignal,
  onUsage?: UsageFn,
): Promise<string> {
  if (signal?.aborted) throw new Error("summary aborted");
  const limit = AbortSignal.timeout(summaryTimeoutMs(budget.maxOutputTokens));
  const bounded = signal ? AbortSignal.any([signal, limit]) : limit;
  const request: Turn = {
    ...turn,
    messages: [...turn.messages, inlineInstructionMsg(instruction)],
    budget: { maxOutputTokens: budget.maxOutputTokens, ...(budget.thinking ? { thinking: budget.thinking } : {}) },
  };
  let out = "";
  let called = false;
  let error = "";
  let truncated = false;
  try {
    for await (const ev of adapter.stream(request, bounded)) {
      if (ev.e === "text_delta") out += ev.text;
      else if (ev.e === "tool_call" || ev.e === "tool_call_begin") called = true;
      else if (ev.e === "usage") onUsage?.(ev);
      else if (ev.e === "error") error = ev.kind;
      else if (ev.e === "turn_done" && ev.stopReason === "length") truncated = true;
    }
  } catch (e) {
    if (signal?.aborted) throw new Error("summary aborted");
    throw new InlineSummaryUnusable(`inline summary request failed: ${(e as Error).message}`);
  }
  if (signal?.aborted) throw new Error("summary aborted");
  if (bounded.aborted) throw new InlineSummaryUnusable("inline summary timed out");
  if (error) throw new InlineSummaryUnusable(`inline summary request failed: ${error}`);
  if (called) throw new InlineSummaryUnusable("the model called a tool instead of writing the summary");
  // 碰到输出上限：后几节（错误、下一步）多半没写出来——宁可退回 sidecar，也不悄悄提交半截摘要
  if (truncated) throw new InlineSummaryUnusable("inline summary hit the output limit");
  const text = out.trim();
  if (!text || (replacedChars > 2000 && text.length < DEGENERATE_SUMMARY_CHARS)) {
    throw new InlineSummaryUnusable(`degenerate inline summary (${text.length} chars)`);
  }
  return out;
}

// sidecar 的预算：转录 token = 窗口扣掉输出与余量后的六成（窗口装得下时不少于以前的约 1.5 万 token），单条工具结果 /
// 调用参数的截断长度随转录预算放宽
export interface SidecarSizing {
  window?: number; // 写摘要的那个型号能收多大的请求（token）；不给 = 它的目录窗口
  scope?: number; // 这次压缩按的窗口（定输出上限）；不给 = window
}

function sidecarBudget(window: number, out: number): { tokens: number } {
  const room = Math.max(1_000, window - out - 2_000);
  const share = Math.floor(room * 0.6);
  return { tokens: share >= 15_000 ? share : Math.min(15_000, Math.floor(room * 0.85)) };
}

function renderMsg(m: Msg, resultChars: number, argChars: number): string {
  const parts = m.content.map((b) => {
    if (b.t === "text") return b.text;
    if (b.t === "thinking") return "";
    if (b.t === "tool_call") return `[tool ${b.name} ${JSON.stringify(b.args).slice(0, argChars)}]`;
    if (b.t === "tool_result") {
      const txt = b.content.map((c) => (c.t === "text" ? c.text : "")).join("");
      return `[result ${b.ok ? "ok" : "err"}: ${txt.slice(0, resultChars)}]`;
    }
    return "";
  });
  return `${m.role.toUpperCase()}: ${parts.filter(Boolean).join("\n")}`;
}

// sidecar：signal 是 run 的停止信号——用户点了停止，摘要请求不再发（#31）；另有自己的时限。
// O8：onUsage = 这次摘要请求（每次尝试）的用量，给用量账本记一笔（任务 compaction）
// side = 档案 side.summary（不给 = SUMMARY_BUDGET）；sizing = 预算按的窗口
export async function summarize(
  adapter: ProviderAdapter,
  middle: Msg[],
  signal?: AbortSignal,
  onUsage?: UsageFn,
  side: Readonly<SummaryProfile> = SUMMARY_BUDGET,
  sizing: SidecarSizing = {},
): Promise<string> {
  const caps = adapter.capabilities;
  const window = sizing.window ?? caps.contextWindow;
  const maxOut = Math.max(256, Math.min(summaryOutputTokens(side.maxOutputTokens, sizing.scope ?? window), caps.maxOutputTokens || Infinity));
  const { tokens } = sidecarBudget(window, maxOut);
  // 先按宽松的截断渲染一遍，量出这段转录每个字符折多少 token，再把 token 预算换成字符预算（中日韩文字约 1 字 1 token）
  const resultChars = Math.min(8_000, Math.max(1_500, Math.floor((tokens * 4) / 40)));
  const argChars = Math.min(2_000, Math.max(500, Math.floor(resultChars / 3)));
  const records = middle.map((m) => renderMsg(m, resultChars, argChars));
  const joined = records.join("\n\n");
  const perChar = joined.length ? Math.max(0.25, tokensOf(joined) / joined.length) : 0.25;
  const transcript = sampleTranscript(records, Math.floor(tokens / perChar));
  const thinking: ThinkingLevel = side.thinking === "inherit" ? "off" : side.thinking;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new Error("summary aborted");
    const limit = AbortSignal.timeout(summaryTimeoutMs(maxOut));
    const bounded = signal ? AbortSignal.any([signal, limit]) : limit;
    let out = "";
    const stream = adapter.stream(
      {
        system: COMPACTION_SYSTEM,
        messages: [{ role: "user", content: [{ t: "text", text: `<transcript>\n${transcript}\n</transcript>\n\n${SUMMARY_INSTRUCTION}` }] }],
        tools: [],
        budget: { maxOutputTokens: maxOut, thinking },
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
