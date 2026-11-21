// 侧栏「对话内容」搜索的纯函数：片段按关键词切段（高亮用）、只取正文命中、防抖请求的先后判定。
// 标题命中由侧栏本地过滤立刻给出，这里只管服务端按 agy 文字记录搜出来的正文命中（/api/agy/search）。

/** 片段按关键词（不分大小写）切成 [{ text, hit }]，供模板逐段渲染、命中段加粗。 */
export function highlightParts(snippet = '', query = '') {
  const s = String(snippet || '');
  const q = String(query || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!s) return [];
  if (!q) return [{ text: s, hit: false }];
  const low = s.toLowerCase();
  // 极少数字符小写后长度会变：对不上就不切，整段原样给
  if (low.length !== s.length) return [{ text: s, hit: false }];
  const out = [];
  let i = 0;
  while (i < s.length) {
    const j = low.indexOf(q, i);
    if (j < 0) { out.push({ text: s.slice(i), hit: false }); break; }
    if (j > i) out.push({ text: s.slice(i, j), hit: false });
    out.push({ text: s.slice(j, j + q.length), hit: true });
    i = j + q.length;
  }
  return out;
}

/** 服务端结果里只要正文命中（标题命中本地已经列出来了），已隐藏 / 已删除的服务端已挡掉。 */
export function contentHitsOf(res) {
  const hits = Array.isArray(res?.hits) ? res.hits : [];
  return hits.filter((h) => h && h.match === 'text' && h.sessionId);
}

/** 正文搜索要不要发请求：去掉空白后至少 2 个字（与服务端一致，单字太泛）。 */
export function contentQueryOf(query = '') {
  const q = String(query || '').replace(/\s+/g, ' ').trim();
  return q.length >= 2 ? q : '';
}
