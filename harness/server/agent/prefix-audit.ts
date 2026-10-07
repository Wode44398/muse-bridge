// Q4（X09 / K46）：请求前缀守恒判定器。loop 每次调 provider 前经 attach() 把观察者挂在 turn.hints.onWire 上，adapter
// 在 fetch 之前把编码好的请求体交过来：与上一次请求比，纯追加记 append；断了记断点、重发量与原因。原因由改写者自报
// （noteRewrite：切模式 / 切访问范围 / 压缩 / 审计收尾挪位 / 恢复会话……），没人报备的断点记成
// unexplained 并告警——那就是有人悄悄改了模型可见前缀。
// 只观测、不改变任何行为；只存哈希与计数，不存正文。累计数与「上一次请求」基线随会话落盘，恢复会话后接着比
// （#30 那类恢复即断，在生产上也看得见）。
import { comparePrefix, fingerprintWire, parseFingerprint, serializeFingerprint, type BreakPoint, type SerializedFingerprint, type WireFingerprint } from "../providers/wire-fingerprint.ts";
import { injectionsIn, recallIds } from "./injections.ts";
import type { Turn, WireShape } from "./turn.ts";

// ephemeral-tail（瘦身 P0-2）：上一次请求末尾挂过一条不落盘的提醒，这一次在它的位置断开是预期的
export type RewriteKind = "mode" | "access" | "micro-compaction" | "compaction" | "audit-closure" | "resume" | "heal" | "media-retire" | "ephemeral-tail";

export interface RequestUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface RequestRecord {
  seq: number; // 这条 state 的第几次主线请求（1 起，重试也算一次）
  at: string; // ISO 时间
  attempt: number; // 0 = 首次，>0 = 同一轮的第几次重试
  shape: WireShape;
  verdict: "first" | "append" | "break";
  breakAt?: BreakPoint;
  cause?: string; // 断点的原因（改写者自报，多个用 + 连接；没人报备 = unexplained）
  resentChars: number;
  items: number;
  shared: number;
  hashes: { system: string; tools: string; params: string };
  injected: Record<string, number>; // 这次新增的部分里各类注入片段的个数
  recall?: string[]; // 这次请求里自动召回的文档 id
  usage?: RequestUsage;
}

export interface PrefixTotals {
  requests: number;
  breaks: Record<string, number>; // 按原因计
  resentChars: number;
}

const RECENT = 50;

export class PrefixAudit {
  totals: PrefixTotals = { requests: 0, breaks: {}, resentChars: 0 };
  readonly recent: RequestRecord[] = [];
  // 日志里标明是哪个会话（会话把自己的 id 填进来；没填就不带）
  label = "";
  private prev: WireFingerprint | null = null;
  private causes = new Set<RewriteKind>();
  private prevCount = 0; // 上一次请求的中立消息条数：据此算「这次新增了什么」
  private seq = 0;

  // 改写者自报：接下来那次请求如果断了，原因记成这些。
  noteRewrite(kind: RewriteKind): void {
    this.causes.add(kind);
  }

  // 每次 provider 调用前：返回挂好观察者的请求（不改原 turn）。
  attach(turn: Turn, attempt: number): Turn {
    const from = attempt > 0 ? turn.messages.length : this.prevCount <= turn.messages.length ? this.prevCount : 0;
    this.prevCount = turn.messages.length;
    const injected = injectionsIn(turn.messages.slice(from));
    const recall = recallIds(turn.messages);
    return {
      ...turn,
      hints: { ...turn.hints, onWire: (shape, body) => void this.observe(shape, body, attempt, injected, recall) },
    };
  }

  observe(shape: WireShape, body: Record<string, unknown>, attempt: number, injected: Record<string, number>, recall: string[]): RequestRecord {
    const fp = fingerprintWire(shape, body);
    const v = comparePrefix(this.prev, fp);
    const record: RequestRecord = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      attempt,
      shape,
      verdict: v.verdict,
      ...(v.at !== undefined ? { breakAt: v.at } : {}),
      resentChars: v.resentChars,
      items: v.items,
      shared: v.shared,
      hashes: { system: fp.system.hash.slice(0, 12), tools: fp.tools.hash.slice(0, 12), params: fp.params.hash.slice(0, 12) },
      injected,
      ...(recall.length ? { recall } : {}),
    };
    this.totals.requests++;
    if (v.verdict === "break") {
      const cause = [...this.causes].sort().join("+") || "unexplained";
      record.cause = cause;
      this.totals.breaks[cause] = (this.totals.breaks[cause] ?? 0) + 1;
      this.totals.resentChars += v.resentChars;
      const where = typeof v.at === "number" ? `message ${v.at}` : v.at;
      const line = `[prefix]${this.label ? ` ${this.label}` : ""} request #${record.seq}: prefix broke at ${where} (${cause}) — ~${v.resentChars} chars re-sent`;
      if (cause === "unexplained") console.warn(`${line}; nobody declared a rewrite — something changed model-visible history`);
      else console.log(line);
    }
    this.causes.clear();
    this.prev = fp;
    this.recent.push(record);
    if (this.recent.length > RECENT) this.recent.splice(0, this.recent.length - RECENT);
    return record;
  }

  // 这一轮最终采用的那次请求的用量（loop 在重试收敛后提交）。
  noteUsage(usage: RequestUsage): void {
    const last = this.recent.at(-1);
    if (last) last.usage = usage;
  }

  // ── 落盘 / 恢复 ──
  baseline(): SerializedFingerprint | undefined {
    return this.prev ? serializeFingerprint(this.prev) : undefined;
  }

  restore(baseline: unknown, totals: unknown): void {
    this.prev = parseFingerprint(baseline);
    const t = totals as Partial<PrefixTotals> | undefined;
    if (t && typeof t.requests === "number" && typeof t.resentChars === "number" && t.breaks && typeof t.breaks === "object") {
      const breaks: Record<string, number> = {};
      for (const [k, n] of Object.entries(t.breaks)) if (typeof n === "number") breaks[k] = n;
      this.totals = { requests: t.requests, breaks, resentChars: t.resentChars };
    }
  }
}
