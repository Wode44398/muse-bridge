// 检索用的分词与打分（记忆 / 项目知识的 Recall 检索、历史会话检索共用）。
//
// 中文没有空格：一段汉字按相邻两字切成二元组，2–4 个字的整段另算一个整词；其余按字母数字串切词，带 . / : _ - 的再拆一层。
// 打分是「部分命中也算」：每个词按它出现在哪个字段（标题、描述、正文……各有权重）加分，再按稀有程度（idf）加权，最后乘上
// 覆盖率——命中的词越多越靠前，一个都没命中才是零分。整词的权重高于二元组；常见的虚词、口头语不算词。
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "what", "when", "where", "which", "how", "why", "are", "was", "were",
  "is", "it", "to", "of", "in", "on", "a", "an", "be", "do", "does", "did", "can", "could", "should", "would", "you", "your", "we",
  "our", "me", "my", "i", "please", "about", "there", "here", "then", "than", "them", "they", "it's", "let", "lets", "just",
]);
// 口语里到处都是、单独命中说明不了什么的汉字二元组
const STOP_GRAMS = new Set([
  "一下", "这个", "那个", "我们", "你们", "他们", "可以", "什么", "怎么", "一个", "没有", "就是", "还是", "现在", "已经", "然后",
  "因为", "所以", "帮我", "看看", "上次", "之前", "的话", "是不", "不是", "有没", "没有", "一些", "这些", "那些", "如果", "需要",
  "知道", "时候", "里的", "了吗", "的是", "是什", "么的",
]);
const HAN = /\p{Script=Han}/u;
const MAX_TERMS = 60;

export interface Terms {
  words: string[]; // 整词（含 2–4 字的汉字整段）
  grams: string[]; // 汉字二元组
  phrase: string; // 归一后的整句（整句出现时另加分）
}

export const normalizeText = (s: string): string => s.replaceAll("\\", "/").toLowerCase().replace(/\s+/g, " ").trim();

export function queryTerms(query: string): Terms {
  const words = new Set<string>();
  const grams = new Set<string>();
  const text = normalizeText(query);
  for (const token of text.match(/[\p{L}\p{N}_./:-]+/gu) ?? []) {
    // 汉字段与非汉字段分开处理（「bridge客户端」= bridge + 客户端）
    for (const part of token.split(/(\p{Script=Han}+)/u).filter(Boolean)) {
      if (HAN.test(part)) {
        const chars = [...part];
        if (chars.length >= 2 && chars.length <= 4 && !STOP_GRAMS.has(part)) words.add(part);
        for (let i = 0; i < chars.length - 1; i++) {
          const g = chars[i] + chars[i + 1];
          if (!STOP_GRAMS.has(g)) grams.add(g);
        }
        continue;
      }
      const w = part.replace(/^[./:_-]+|[./:_-]+$/g, "");
      if (w.length > 1 && !STOP_WORDS.has(w)) words.add(w);
      for (const sub of w.split(/[./:_-]/)) if (sub.length > 1 && !STOP_WORDS.has(sub)) words.add(sub);
    }
  }
  for (const g of grams) words.delete(g); // 两个字的整段就是它的二元组，不重复算
  return { words: [...words].slice(0, MAX_TERMS), grams: [...grams].slice(0, MAX_TERMS), phrase: text };
}

export const termCount = (t: Terms): number => t.words.length + t.grams.length;

export interface Field {
  name: string;
  text: string; // 已归一（normalizeText）
  weight: number;
}

export interface TextScore {
  score: number;
  matched: number; // 命中的词数
  total: number;
  hits: Record<string, number>; // 各字段命中的词数
}

const WORD_WEIGHT = 1;
const GRAM_WEIGHT = 0.6;

// idf：这个词在多少篇里出现过（调用方按整批候选算）；不给就都按 1
export function scoreFields(fields: Field[], terms: Terms, idf: (term: string) => number = () => 1): TextScore {
  const hits: Record<string, number> = {};
  let score = 0;
  let matched = 0;
  const total = termCount(terms);
  const one = (term: string, base: number) => {
    let best: Field | undefined;
    for (const f of fields) if (f.text.includes(term) && (!best || f.weight > best.weight)) best = f;
    if (!best) return;
    matched++;
    hits[best.name] = (hits[best.name] ?? 0) + 1;
    score += base * best.weight * idf(term);
  };
  for (const w of terms.words) one(w, WORD_WEIGHT);
  for (const g of terms.grams) one(g, GRAM_WEIGHT);
  if (!matched) return { score: 0, matched, total, hits };
  // 整句原样出现：另加一份（按出现处最重的字段）
  if (terms.phrase.length >= 2) {
    const where = fields.filter((f) => f.text.includes(terms.phrase)).sort((a, b) => b.weight - a.weight)[0];
    if (where) score += 3 * where.weight;
  }
  const coverage = total ? matched / total : 0;
  return { score: score * (0.4 + coverage), matched, total, hits };
}

// 按一批文档算 idf：出现得越少的词越值钱
export function idfOver(docs: readonly string[][], terms: Terms): (term: string) => number {
  const n = docs.length || 1;
  const df = new Map<string, number>();
  for (const t of [...terms.words, ...terms.grams]) {
    let c = 0;
    for (const fields of docs) if (fields.some((f) => f.includes(t))) c++;
    df.set(t, c);
  }
  return (t) => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
}
