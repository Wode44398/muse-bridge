// 代码 / 文本查看器的纯函数部分（零依赖、不碰 DOM）：全篇查找、日志识别用的正则。
// 从 cm.js 拆出来——DocViewer 判「是不是日志」、单测都不必把 CM6 整个拉进来；cm.js 原样再导出。

export const MAX_HITS = 20000;

/** 全篇查找：返回 { hits（Int32Array，[from,to] 平铺）, n, capped }；正则写错 → { error } */
export function findAll(text, { q = '', cs = false, re = false, word = false } = {}) {
  if (!q) return { hits: null, n: 0, capped: false };
  let rx;
  try {
    const src = re ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rx = new RegExp(word ? '(?<![\\p{L}\\p{N}_])(?:' + src + ')(?![\\p{L}\\p{N}_])' : src, 'gmu' + (cs ? '' : 'i'));
  } catch { return { error: true, hits: null, n: 0, capped: false }; }
  const out = new Int32Array(Math.min(MAX_HITS, 1024) * 2);
  let buf = out, n = 0, capped = false, m;
  // 纯文本、区分大小写、非全字：indexOf 比正则快一截（10MB 日志查一个词 ~10ms）
  if (!re && !word && cs) {
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      if (n >= MAX_HITS) { capped = true; break; }
      if (n * 2 >= buf.length) { const nb = new Int32Array(buf.length * 2); nb.set(buf); buf = nb; }
      buf[n * 2] = i; buf[n * 2 + 1] = i + q.length; n++;
    }
    return { hits: buf, n, capped };
  }
  while ((m = rx.exec(text))) {
    if (!m[0].length) { rx.lastIndex++; if (rx.lastIndex > text.length) break; continue; }   // 空匹配（^、\b）不算命中
    if (n >= MAX_HITS) { capped = true; break; }
    if (n * 2 >= buf.length) { const nb = new Int32Array(buf.length * 2); nb.set(buf); buf = nb; }
    buf[n * 2] = m.index; buf[n * 2 + 1] = m.index + m[0].length; n++;
  }
  return { hits: buf, n, capped };
}

// —— 日志：级别词与时间戳（着色在 cm.js 的 logPlugin）——
export const LV_ERR = /\b(ERROR|ERR|FATAL|CRITICAL|CRIT|SEVERE|PANIC|EXCEPTION)\b/;
export const LV_WARN = /\b(WARN|WARNING)\b/;
export const LV_DIM = /\b(DEBUG|TRACE|VERBOSE)\b/;
export const TS = /^\[?\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d)?([.,]\d+)?(Z|[+-]\d\d:?\d\d)?\]?|^\[?\d\d:\d\d:\d\d([.,]\d+)?\]?/;

/** 看起来像日志：.log / .out，或前 40 行里一半以上带时间戳或级别词 */
export function looksLikeLog(text, name = '') {
  if (/\.(log|out)$/i.test(name)) return true;
  const lines = String(text).slice(0, 8192).split('\n', 40).filter((l) => l.trim());
  if (lines.length < 4) return false;
  const k = lines.filter((l) => TS.test(l) || LV_ERR.test(l.slice(0, 80)) || LV_WARN.test(l.slice(0, 80))).length;
  return k >= lines.length * 0.5;
}
