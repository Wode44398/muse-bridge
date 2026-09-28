// Q2（X10）：上下文分窗——Codex context_snapshot（group_requests）的 dimensio 版，跑在 provider 中立的 Turn 上，
// 一份实现覆盖所有 provider。逐个请求与上一个主线请求比：settings（system + 工具定义）变了，或者消息没能原样接续
// （中间某条被改写 = diverged，整体变短 = truncated），就开一个新窗——每开一个窗，provider 的前缀缓存就断一次，
// 这类破坏是无声的：没有报错，只有账单和延迟。
// 用法纪律：测试只断言「开了几个窗、为什么开」，不钉措辞；renderWindows 只给人看（断言失败时附在消息里）。
import { createHash } from "node:crypto";
import { COMPACTION_SYSTEM } from "../agent/context.ts";
import { injectionKind } from "../agent/injections.ts";
import type { Block, Msg, Turn } from "../agent/turn.ts";

export type WindowReason = "settings" | "diverged" | "truncated";

export interface ContextWindow {
  index: number; // 第几个窗（1 起）
  request: number; // 开窗的请求在输入里的下标（0 起）
  reasons: WindowReason[]; // 第一个窗为空
  at?: number; // diverged / truncated：从第几条消息（0 起）开始接不上
  lostChars: number; // 上一个请求里没法复用、要重新算的字符数（settings 变了就是整个请求）
  requests: number[]; // 落在这个窗里的主线请求下标
}

export interface WindowOptions {
  // 旁路请求（压缩摘要之类）：不进主线比较，也不开窗。默认认压缩摘要。
  side?: (turn: Turn, index: number) => boolean;
}

export const isCompactionRequest = (turn: Turn): boolean => turn.system === COMPACTION_SYSTEM;

// provider 只消费 role + content（turn.ts 的约定）；displayText、internal 这些 UI 字段不算前缀。
const itemOf = (m: Msg): string => JSON.stringify({ role: m.role, content: m.content });
const digest = (v: unknown): string => createHash("sha1").update(JSON.stringify(v)).digest("hex");

interface Seen {
  items: string[];
  system: string;
  tools: string;
  systemChars: number;
  toolsChars: number;
}

function see(turn: Turn): Seen {
  const system = JSON.stringify(turn.system);
  const tools = JSON.stringify(turn.tools);
  return { items: turn.messages.map(itemOf), system: digest(system), tools: digest(tools), systemChars: system.length, toolsChars: tools.length };
}

function sharedPrefix(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

const chars = (items: string[]): number => items.reduce((n, s) => n + s.length, 0);

export function contextWindows(turns: Turn[], opts: WindowOptions = {}): ContextWindow[] {
  const side = opts.side ?? isCompactionRequest;
  const out: ContextWindow[] = [];
  let prev: Seen | null = null;
  turns.forEach((turn, i) => {
    if (side(turn, i)) return;
    const now = see(turn);
    if (!prev) {
      out.push({ index: 1, request: i, reasons: [], lostChars: 0, requests: [i] });
      prev = now;
      return;
    }
    const reasons: WindowReason[] = [];
    const settingsChanged = now.system !== prev.system || now.tools !== prev.tools;
    if (settingsChanged) reasons.push("settings");
    const shared = sharedPrefix(prev.items, now.items);
    let at: number | undefined;
    if (shared < prev.items.length) {
      reasons.push(shared === now.items.length ? "truncated" : "diverged");
      at = shared;
    }
    if (!reasons.length) {
      out[out.length - 1].requests.push(i);
    } else {
      // 前缀顺序是 工具 → system → 消息：工具变了全废；system 变了 system 与全部消息重算；否则只重算接不上的那段。
      const lostChars =
        now.tools !== prev.tools ? prev.toolsChars + prev.systemChars + chars(prev.items)
        : now.system !== prev.system ? prev.systemChars + chars(prev.items)
        : chars(prev.items.slice(shared));
      out.push({ index: out.length + 1, request: i, reasons, ...(at !== undefined ? { at } : {}), lostChars, requests: [i] });
    }
    prev = now;
  });
  return out;
}

// ── 给人看的渲染：同一个窗里只列每个请求新增的消息；已知的注入片段折叠成标签（类别表与 Q4 的请求记录共用）──
function oneLine(s: string, max = 60): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function renderBlock(b: Block): string {
  switch (b.t) {
    case "text": {
      const kind = injectionKind(b.text);
      return kind ? `[${kind}]` : `"${oneLine(b.text)}"`;
    }
    case "tool_call":
      return `call ${b.name}#${b.id}`;
    case "tool_result":
      return `result #${b.id} ${b.ok ? "ok" : "fail"}`;
    default:
      return `[${b.t}]`;
  }
}

const renderMsg = (m: Msg, n: number): string => `#${n} ${m.role}: ${m.content.map(renderBlock).join(" | ")}`;

export function renderWindows(turns: Turn[], opts: WindowOptions = {}): string {
  const side = opts.side ?? isCompactionRequest;
  const windows = contextWindows(turns, opts);
  const lines: string[] = [];
  const opener = new Map(windows.map((w) => [w.request, w]));
  let prevLen = 0;
  turns.forEach((turn, i) => {
    if (side(turn, i)) {
      lines.push(`  (request ${i}: side request, not compared)`);
      return;
    }
    const w = opener.get(i);
    let from = prevLen;
    if (w) {
      const why = w.reasons.length ? `: ${w.reasons.join(" + ")}${w.at !== undefined ? ` at message ${w.at}` : ""}, ${w.lostChars} chars to recompute` : "";
      lines.push(`Window ${w.index} (request ${i}${why})`);
      from = w.reasons.includes("settings") && w.at === undefined ? prevLen : (w.at ?? 0);
      if (w.index === 1) from = 0;
    }
    const added = turn.messages.slice(from).map((m, k) => renderMsg(m, from + k));
    lines.push(`  request ${i}: ${added.length ? "" : "(nothing new)"}`);
    for (const a of added) lines.push(`    ${a}`);
    prevLen = turn.messages.length;
  });
  return lines.join("\n");
}
