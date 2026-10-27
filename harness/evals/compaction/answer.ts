// Q6（N47）：答题臂。在场召回（replay.ts）只说明锚点还在不在上下文里；这里让模型只看压缩后的上下文答题，答案按
// 同一套锚点、同一套归一化做字符串判分——量的是「在」之后模型能不能用上。每种锚点一问，一次会话最多四次调用。
import type { Block, Msg, ToolDef } from "../../server/agent/turn.ts";
import type { ProviderAdapter } from "../../server/providers/types.ts";
import { ANCHOR_KINDS, type Anchor, type AnchorKind, normText, renderTranscript } from "./anchors.ts";
import type { Tally } from "./replay.ts";

export const QUESTIONS: Record<AnchorKind, string> = {
  file: "Earlier in this session, which files did the agent create or modify? List every path you can find, one per line.",
  error:
    "Earlier in this session, which error codes or error types (for example ENOENT, ERR_MODULE_NOT_FOUND, TS2345, TypeError) " +
    "did failing tools or commands report? List them.",
  id: "List every commit hash, URL and UUID that came up earlier in this session, one per line.",
  user: "Quote, word for word, each request the user made earlier in this session.",
};

export const ANSWER_SYSTEM =
  "You answer questions about an agent's work session using only the transcript you are given. Be exhaustive and literal: " +
  "copy names, paths, codes and ids exactly as they appear. If the transcript does not say, answer 'unknown'.";

async function ask(adapter: ProviderAdapter, transcript: string, question: string): Promise<string> {
  let out = "";
  const stream = adapter.stream({
    system: ANSWER_SYSTEM,
    messages: [{ role: "user", content: [{ t: "text", text: `<transcript>\n${transcript}\n</transcript>\n\n${question}` }] }],
    tools: [],
    budget: { maxOutputTokens: 2000, thinking: "off" },
  });
  for await (const ev of stream) {
    if (ev.e === "text_delta") out += ev.text;
    else if (ev.e === "error") throw new Error(`answer request failed: ${ev.kind}`);
  }
  return out;
}

export async function answerRecall(adapter: ProviderAdapter, context: readonly Msg[], questions: readonly Anchor[]): Promise<Record<AnchorKind, Tally>> {
  const transcript = renderTranscript(context);
  const byKind = {} as Record<AnchorKind, Tally>;
  for (const kind of ANCHOR_KINDS) {
    const gold = questions.filter((q) => q.kind === kind);
    byKind[kind] = { asked: gold.length, recalled: 0 };
    if (!gold.length) continue;
    const answer = normText(await ask(adapter, transcript, QUESTIONS[kind]));
    byKind[kind].recalled = gold.filter((q) => answer.includes(q.needle)).length;
  }
  return byKind;
}

// ── R10（二）回查臂：同样的问题，但模型可以用 Grep / Read 翻压缩归档（生产摘要末尾列出的那些文件）再答 ──────────
// 工具在这里用内存实现（归档在回放里就是内存的），行为贴着生产的 Grep / Read：Grep 回「路径:行号: 文本」，Read 回带行号的行。
const RECOVERY_ROUNDS = 6; // 每问最多几轮工具调用
const GREP_MAX_LINES = 60;
const READ_MAX_LINES = 200;
const LINE_CHARS = 2_000;

export const RECOVERY_SYSTEM =
  `${ANSWER_SYSTEM} The summary in the transcript lists compaction archive files that hold the original messages word for ` +
  "word; the Grep and Read tools search them.";
// 第一版协议（09-24 的 r10b-recovery-prod 收据）一上来就给工具、最后一轮还说「按你查到的回答」：模型只报 grep 到的那几十行，
// 把上下文里锚点索引列好的丢了，答题召回反而从 49% 掉到 27%。生产里 agent 不会因为查了归档就忘掉上下文——所以改成：
// 先闭卷答一次（与 current 臂同一个问法），再给工具让它把闭卷答案里缺的补上；计分取两次答案的并集，闭卷那次另记一份。
const RECOVERY_FOLLOWUP =
  "Now check the compaction archive files listed in the summary for items your answer above is missing: use Grep (and Read " +
  "around the hits) to find them. Then reply with ONLY the additional items you found, one per line — do not repeat the ones " +
  "you already listed. If you find nothing new, reply 'nothing new'.";

export const RECOVERY_TOOLS: ToolDef[] = [
  {
    name: "Grep",
    description:
      "Search the compaction archive files for a JavaScript regular expression (case-insensitive). Returns matching lines as " +
      `path:line: text (at most ${GREP_MAX_LINES}). Omit path to search every archive file.`,
    parameters: {
      type: "object",
      properties: { pattern: { type: "string", description: "Regular expression" }, path: { type: "string", description: "One archive file (optional)" } },
      required: ["pattern"],
    },
  },
  {
    name: "Read",
    description: `Read numbered lines of an archive file (at most ${READ_MAX_LINES} per call).`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", description: "First line to read, 1-based (default 1)" },
        limit: { type: "integer", description: `How many lines (default and max ${READ_MAX_LINES})` },
      },
      required: ["path"],
    },
  },
];

export function grepArchives(archives: ReadonlyMap<string, string>, pattern: string, file?: string): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const out: string[] = [];
  for (const [p, text] of archives) {
    if (file && p !== file) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && out.length < GREP_MAX_LINES; i++) {
      if (re.test(lines[i])) out.push(`${p}:${i + 1}: ${lines[i].slice(0, LINE_CHARS)}`);
    }
  }
  if (file && !archives.has(file)) return `No such archive file: ${file}`;
  return out.length ? out.join("\n") : "No matches.";
}

export function readArchive(archives: ReadonlyMap<string, string>, file: string, offset = 1, limit = READ_MAX_LINES): string {
  const text = archives.get(file);
  if (text === undefined) return `No such archive file: ${file}`;
  const lines = text.split("\n");
  const from = Math.max(1, Math.floor(offset) || 1);
  const n = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(limit) || READ_MAX_LINES));
  const slice = lines.slice(from - 1, from - 1 + n);
  if (!slice.length) return `The file has ${lines.length} lines.`;
  return slice.map((l, i) => `${from + i}\t${l.slice(0, LINE_CHARS)}`).join("\n");
}

function runRecoveryTool(archives: ReadonlyMap<string, string>, name: string, args: Record<string, unknown>): string {
  if (name === "Grep") return grepArchives(archives, String(args.pattern ?? ""), args.path ? String(args.path) : undefined);
  if (name === "Read") return readArchive(archives, String(args.path ?? ""), Number(args.offset ?? 1), Number(args.limit ?? READ_MAX_LINES));
  return `Unknown tool: ${name}`;
}

// 闭卷答案之后接着问：用工具补上缺的，只回新找到的。返回补充的那段文字与工具调用次数。
async function lookUpMissing(
  adapter: ProviderAdapter,
  transcript: string,
  question: string,
  closed: string,
  archives: ReadonlyMap<string, string>,
): Promise<{ answer: string; lookups: number }> {
  const messages: Msg[] = [
    { role: "user", content: [{ t: "text", text: `<transcript>\n${transcript}\n</transcript>\n\n${question}` }] },
    { role: "assistant", content: [{ t: "text", text: closed || "unknown" }] },
    { role: "user", content: [{ t: "text", text: RECOVERY_FOLLOWUP }] },
  ];
  let lookups = 0;
  for (let round = 0; round <= RECOVERY_ROUNDS; round++) {
    const last = round === RECOVERY_ROUNDS;
    let text = "";
    const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
    for await (const ev of adapter.stream({ system: RECOVERY_SYSTEM, messages, tools: last ? [] : RECOVERY_TOOLS, budget: { maxOutputTokens: 2000, thinking: "off" } })) {
      if (ev.e === "text_delta") text += ev.text;
      else if (ev.e === "tool_call") calls.push({ id: ev.id, name: ev.name, args: ev.args });
      else if (ev.e === "error") throw new Error(`answer request failed: ${ev.kind}`);
    }
    if (!calls.length) return { answer: text, lookups };
    lookups += calls.length;
    messages.push({ role: "assistant", content: [...(text ? [{ t: "text" as const, text }] : []), ...calls.map((c) => ({ t: "tool_call" as const, ...c }))] });
    const results: Block[] = calls.map((c) => ({ t: "tool_result", id: c.id, ok: true, content: [{ t: "text", text: runRecoveryTool(archives, c.name, c.args) }] }));
    if (round === RECOVERY_ROUNDS - 1) results.push({ t: "text", text: "That was the last lookup. Reply now with the additional items you found." });
    messages.push({ role: "user", content: results });
  }
  return { answer: "", lookups };
}

export async function answerRecallWithRecovery(
  adapter: ProviderAdapter,
  context: readonly Msg[],
  questions: readonly Anchor[],
  archives: ReadonlyMap<string, string>,
): Promise<{ byKind: Record<AnchorKind, Tally>; closedByKind: Record<AnchorKind, Tally>; lookups: number }> {
  const transcript = renderTranscript(context);
  const byKind = {} as Record<AnchorKind, Tally>;
  const closedByKind = {} as Record<AnchorKind, Tally>;
  let lookups = 0;
  for (const kind of ANCHOR_KINDS) {
    const gold = questions.filter((q) => q.kind === kind);
    byKind[kind] = { asked: gold.length, recalled: 0 };
    closedByKind[kind] = { asked: gold.length, recalled: 0 };
    if (!gold.length) continue;
    const closed = await ask(adapter, transcript, QUESTIONS[kind]);
    const more = await lookUpMissing(adapter, transcript, QUESTIONS[kind], closed, archives);
    lookups += more.lookups;
    const closedText = normText(closed);
    const both = `${closedText}\n${normText(more.answer)}`;
    closedByKind[kind].recalled = gold.filter((q) => closedText.includes(q.needle)).length;
    byKind[kind].recalled = gold.filter((q) => both.includes(q.needle)).length;
  }
  return { byKind, closedByKind, lookups };
}
