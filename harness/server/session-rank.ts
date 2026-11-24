// 历史会话检索（Recall 的 layer:"sessions"）：按 text-match.ts 打分——标题命中权重高于正文，中文按二元组与整词，
// 部分命中也排得出来（侧栏搜索那套「每个词都要出现」的字面匹配在 session-search.ts，界面照旧用它）。
// 每个命中的会话给最相关的两处原文，前后文比侧栏的长。
import type { SessionMeta } from "./store.ts";
import { sessionExtracts, type TranscriptLine } from "./session-search.ts";
import { idfOver, normalizeText, queryTerms, scoreFields, termCount, type Terms } from "./text-match.ts";

export interface RankedSession {
  id: string;
  title: string;
  updatedAt: number;
  score: number;
  matched: number;
  total: number;
  snippets: string[];
}

const TITLE_WEIGHT = 5;
const BODY_WEIGHT = 1;
const BEFORE = 120;
const AFTER = 240;
const MAX_SNIPPETS = 2;

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

// 一段原文里第一个命中词前后的一截
function snippetOf(text: string, terms: Terms): string {
  const lower = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const t of [...terms.words, ...terms.grams]) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = t.length;
    }
  }
  if (at < 0) return flat(text.slice(0, BEFORE + AFTER)) + (text.length > BEFORE + AFTER ? "…" : "");
  const start = Math.max(0, at - BEFORE);
  const end = Math.min(text.length, at + len + AFTER);
  return `${start > 0 ? "…" : ""}${flat(text.slice(start, end))}${end < text.length ? "…" : ""}`;
}

export async function rankSessions(
  query: string,
  opts: { filter?: (m: SessionMeta) => boolean; limit?: number } = {},
): Promise<RankedSession[]> {
  const terms = queryTerms(query);
  if (!termCount(terms)) return [];
  const entries = (await sessionExtracts()).filter((e) => !opts.filter || opts.filter(e.meta));
  const docs = entries.map((e) => ({ e, title: normalizeText(e.meta.title ?? ""), body: normalizeText(e.parts.join("\n")) }));
  const idf = idfOver(docs.map((d) => [d.title, d.body]), terms);
  const out: RankedSession[] = [];
  for (const d of docs) {
    const s = scoreFields([{ name: "title", text: d.title, weight: TITLE_WEIGHT }, { name: "body", text: d.body, weight: BODY_WEIGHT }], terms, idf);
    if (!s.score) continue;
    // 最相关的两段原文
    const parts = d.e.parts
      .map((p, i) => ({ p, i, s: scoreFields([{ name: "body", text: normalizeText(p), weight: 1 }], terms, idf).score }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, MAX_SNIPPETS)
      .sort((a, b) => a.i - b.i);
    out.push({
      id: d.e.meta.id,
      title: d.e.meta.title,
      updatedAt: d.e.meta.updatedAt,
      score: s.score,
      matched: s.matched,
      total: s.total,
      snippets: parts.map((x) => snippetOf(x.p, terms)),
    });
  }
  out.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  return out.slice(0, Math.max(1, Math.min(20, opts.limit ?? 10)));
}

// 读一个会话、又带着 query 时：哪些行算命中（命中整词，或者至少两个二元组 / 一半的词）
export function matchingLineIndexes(lines: readonly TranscriptLine[], query: string): Set<number> {
  const terms = queryTerms(query);
  const out = new Set<number>();
  if (!termCount(terms)) return out;
  const need = Math.min(2, termCount(terms));
  lines.forEach((l, i) => {
    const text = normalizeText(l.text);
    const words = terms.words.filter((w) => text.includes(w)).length;
    const grams = terms.grams.filter((g) => text.includes(g)).length;
    if (words > 0 || words + grams >= need) out.add(i);
  });
  return out;
}
