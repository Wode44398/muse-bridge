// Q6（N47）：压缩召回 eval 的「考题」。不让 LLM 出题：从会被压缩掉的消息里机械地抽锚点——改过的文件、失败工具报的
// 错误码 / 错误类型、提交哈希 / URL / UUID、用户原话——压缩之后在上下文里按字符串找，判分确定、没有评委噪声。
// hermes 的教训：路径、SHA、错误串这类锚点最容易被摘要器转述丢掉（他们的机械锚点索引把闭卷分从 23.3 提到 60.0）；
// 用户原话则是 R10 要原样保留的东西。
import { injectionKind } from "../../server/agent/injections.ts";
import type { Block, Msg } from "../../server/agent/turn.ts";

export type AnchorKind = "file" | "error" | "id" | "user";
export const ANCHOR_KINDS: AnchorKind[] = ["file", "error", "id", "user"];

export interface Anchor {
  kind: AnchorKind;
  needle: string; // 已归一化（见 normText），按子串在归一化后的上下文里找
  source: number; // 出自原转录的第几条消息
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const ERRNO = /\bE(?:ACCES|ADDRINUSE|AGAIN|BUSY|CONNREFUSED|CONNRESET|EXIST|ISDIR|MFILE|NOENT|NOTDIR|NOTEMPTY|PERM|PIPE|TIMEDOUT)\b/g;
const ERR_CODE = /\bERR_[A-Z0-9_]{3,}\b/g;
const ERR_CLASS = /\b[A-Z][a-zA-Z]+Error\b/g;
const TS_CODE = /\bTS\d{4}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SHA = /\b[0-9a-f]{7,40}\b/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/g;
const MAX_IDS_PER_MESSAGE = 5;

// 归一化：反斜杠一律成正斜杠（JSON 里转义过的双反斜杠先收成一个），小写，空白压成一个空格。
export function normText(s: string): string {
  return s.replace(/\\\\/g, "/").replace(/\\/g, "/").toLowerCase().replace(/\s+/g, " ");
}

function blockText(b: Block): string {
  if (b.t === "text") return b.text;
  if (b.t === "tool_call") return `${b.name} ${JSON.stringify(b.args)}`;
  if (b.t === "tool_result") return b.content.map(blockText).join("\n");
  return ""; // thinking 是模型的私下推理，不算上下文里「看得见」的事实；媒体块没有文本
}

// 一组消息里模型看得见的文本（归一化后）
export function renderText(msgs: readonly Msg[]): string {
  return normText(msgs.map((m) => m.content.map(blockText).join("\n")).join("\n"));
}

// 给答题臂看的转录（原样，不归一化）
export function renderTranscript(msgs: readonly Msg[]): string {
  return msgs.map((m) => `${m.role.toUpperCase()}: ${m.content.map(blockText).filter(Boolean).join("\n")}`).join("\n\n");
}

// 判断「这条消息还原样在上下文里」用的签名（去掉 thinking：压缩留尾部时会剥掉它）
export const contentSig = (m: Msg): string => JSON.stringify(m.content.filter((b) => b.t !== "thinking"));

const pathNeedle = (p: string): string => {
  const parts = normText(p).split("/").filter(Boolean);
  return parts.slice(-2).join("/");
};

function idsIn(text: string): string[] {
  const out: string[] = [];
  const uuids = text.match(UUID) ?? [];
  out.push(...uuids);
  const rest = text.replace(UUID, " ");
  for (const sha of rest.match(SHA) ?? []) if (/\d/.test(sha) && /[a-f]/.test(sha)) out.push(sha);
  for (const url of rest.match(URL_RE) ?? []) out.push(url.replace(/[.,;:]+$/, "").slice(0, 120));
  return out;
}

// 用户文本块里真正是用户说的话：注入片段（追问、提醒、召回、摘要……）不算；运行中插话去掉前缀说明，留用户原话。
function userWords(text: string): string {
  const kind = injectionKind(text);
  if (kind === null) return text;
  if (kind !== "steer") return "";
  const cut = text.indexOf("\n\n");
  return cut >= 0 ? text.slice(cut + 2) : "";
}

export function anchorsOf(m: Msg, source: number): Anchor[] {
  const found: Anchor[] = [];
  const add = (kind: AnchorKind, raw: string, min = 5) => {
    const needle = normText(raw).trim();
    if (needle.length >= min && !found.some((a) => a.kind === kind && a.needle === needle)) found.push({ kind, needle, source });
  };
  let ids = 0;
  const addIds = (text: string) => {
    for (const id of idsIn(text)) {
      if (ids >= MAX_IDS_PER_MESSAGE) return;
      const before = found.length;
      add("id", id, 7);
      if (found.length > before) ids++;
    }
  };
  for (const b of m.content) {
    if (m.role === "assistant" && b.t === "tool_call") {
      if (EDIT_TOOLS.has(b.name) && typeof b.args?.path === "string") add("file", pathNeedle(b.args.path));
      addIds(JSON.stringify(b.args));
    } else if (m.role === "user" && b.t === "tool_result") {
      const text = b.content.map(blockText).join("\n");
      if (!b.ok) {
        const head = text.slice(0, 2000);
        const codes = [...(head.match(ERRNO) ?? []), ...(head.match(ERR_CODE) ?? []), ...(head.match(TS_CODE) ?? []), ...(head.match(ERR_CLASS) ?? [])];
        for (const code of codes.slice(0, 2)) add("error", code, 4);
      }
      addIds(text);
    } else if (b.t === "text") {
      if (m.role === "user") add("user", normText(userWords(b.text)).trim().slice(0, 48), 12);
      addIds(b.text);
    }
  }
  return found;
}
