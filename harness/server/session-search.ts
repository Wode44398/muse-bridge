// K10（D5）：侧栏搜索的正文命中。以前侧栏只按项目名与会话标题过滤——标题是首句截的，「上次让它改登录页的那个对话」
// 这种按内容找的，只能一个个点开翻。
//
// 扫的是用户看得见的正文：用户的话（插话取原话）+ 助手的正文；不含思考、工具调用与结果、给模型的注入（visibleMessages
// 已经去掉 internal）。不建索引：会话总量小（实际使用约 25 个、约 12MB，列表接口本来每次都整份读一遍），按文件修改时间缓存
// 抽出来的正文，没变的不再读。范围与列表一致：只收读得通的记录，快照桶的旧会话照列表的规矩不出现（调用方给 filter）。
// 多个词（空格分开）要都出现；不分大小写；按最近更新排，给出第一处命中的前后文。
import fs from "node:fs/promises";
import path from "node:path";
import { visibleMessages } from "./agent/state.ts";
import type { Msg } from "./agent/turn.ts";
import { sessionsDir } from "./paths.ts";
import { loadSession, type SessionMeta } from "./store.ts";

export interface SessionSearchHit {
  id: string;
  title: string;
  workspace?: string;
  provider: string;
  updatedAt: number;
  // 这个会话里第一个词出现的次数（封顶 99）
  hits: number;
  // 第一处命中：前文、命中的原文、后文（空白压成一个空格；截断处带省略号）——前端自己加高亮，不拼 HTML
  snippet: { before: string; match: string; after: string };
}

interface Extract {
  mtimeMs: number;
  size: number;
  meta: SessionMeta;
  parts: string[];
}

export const MAX_QUERY_CHARS = 100;
const MAX_TERMS = 5;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const BEFORE = 24;
const AFTER = 60;
const cache = new Map<string, Extract>();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const flat = (s: string) => s.replace(/\s+/g, " ");

// 一条消息里用户看得见的字
function visibleText(m: Msg): string {
  if (m.role === "user") {
    if (m.origin === "harness") return "";
    if (typeof m.displayText === "string") return m.displayText;
  }
  return m.content.map((b) => (b.t === "text" ? b.text : "")).join("\n");
}

async function extract(id: string, file: string): Promise<Extract | null> {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    cache.delete(id);
    return null;
  }
  const hit = cache.get(id);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const rec = await loadSession(id);
  if (!rec) {
    cache.delete(id);
    return null;
  }
  const parts = visibleMessages(rec.messages)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map(visibleText)
    .filter((t) => t.trim());
  const entry: Extract = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    meta: {
      id: rec.id,
      title: rec.title,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      messageCount: rec.messages.length,
      provider: rec.config.provider,
      model: rec.config.model,
      workspace: rec.config.workspace,
    },
    parts,
  };
  cache.set(id, entry);
  return entry;
}

function snippetOf(text: string, index: number, length: number): SessionSearchHit["snippet"] {
  const start = Math.max(0, index - BEFORE);
  const end = Math.min(text.length, index + length + AFTER);
  return {
    before: (start > 0 ? "…" : "") + flat(text.slice(start, index)).trimStart(),
    match: flat(text.slice(index, index + length)),
    after: flat(text.slice(index + length, end)).trimEnd() + (end < text.length ? "…" : ""),
  };
}

export function searchTerms(query: string): string[] {
  return query.slice(0, MAX_QUERY_CHARS).trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
}

export async function searchSessions(
  query: string,
  opts: { limit?: number; filter?: (m: SessionMeta) => boolean } = {},
): Promise<{ items: SessionSearchHit[]; scanned: number }> {
  const terms = searchTerms(query);
  if (!terms.length) return { items: [], scanned: 0 };
  const res = terms.map((t) => new RegExp(escapeRe(t), "gi"));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)));
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir());
  } catch {
    return { items: [], scanned: 0 };
  }
  const entries: Extract[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const e = await extract(n.slice(0, -".json".length), path.join(sessionsDir(), n));
    if (e) entries.push(e);
  }
  // 与列表同一个次序、同一套过滤（快照桶的过滤器依赖「最新的先来」）
  entries.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
  const items: SessionSearchHit[] = [];
  for (const e of entries) {
    if (opts.filter && !opts.filter(e.meta)) continue;
    if (!res.every((re) => e.parts.some((p) => (re.lastIndex = 0, re.test(p))))) continue;
    // 第一个词：数次数、取第一处命中
    const first = res[0];
    let hits = 0;
    let at: { part: string; index: number; length: number } | null = null;
    for (const p of e.parts) {
      first.lastIndex = 0;
      for (let m = first.exec(p); m; m = first.exec(p)) {
        hits++;
        if (!at) at = { part: p, index: m.index, length: m[0].length };
        if (hits >= 99) break;
        if (m[0].length === 0) first.lastIndex++;
      }
      if (hits >= 99) break;
    }
    if (!at) continue;
    items.push({
      id: e.meta.id,
      title: e.meta.title,
      ...(e.meta.workspace ? { workspace: e.meta.workspace } : {}),
      provider: e.meta.provider,
      updatedAt: e.meta.updatedAt,
      hits,
      snippet: snippetOf(at.part, at.index, at.length),
    });
    if (items.length >= limit) break;
  }
  return { items, scanned: entries.length };
}
