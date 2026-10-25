// Claude 侧栏归档 / 组内翻页 / 搜索高亮用到的纯函数（2026-10-20）。不碰 $state，node:test 直接测
//（见 sessionArchiveView.test.js）；ClaudePage.svelte 与 claude/SessionSearch.svelte 共用。

/**
 * 一条会话在已加载列表里的全部后代（子、孙……）。两种血缘都认：
 *   · parentId = 顶层祖先（Desktop 子会话树与 bridge 派生会话都折成这个）：id 是根时，挂在它名下的都是后代；
 *   · spawnedBy = 直接父（只 bridge 派生的有）：顺着直接父一路往上能走到 id 的也是（id 是中间一层时靠它）。
 * 没有 parentId 的行是顶层（含「移到顶层」过的）：它自己不算谁的后代，往上找也到它为止。
 */
export function descendantsOf(sessions, id) {
  const list = Array.isArray(sessions) ? sessions : [];
  const byId = new Map(list.map((s) => [s.id, s]));
  const out = [];
  for (const s of list) {
    if (!s || s.id === id || !s.parentId) continue;
    if (s.parentId === id) { out.push(s); continue; }
    let p = s.spawnedBy;
    for (let n = 0; p && n < 32; n++) {
      if (p === id) { out.push(s); break; }
      const ps = byId.get(p);
      if (!ps || !ps.parentId) break;   // 走到顶层了（它就是根，或被移到了顶层）
      p = ps.spawnedBy;
    }
  }
  return out;
}

/** 整表刷新拿到的服务端列表 + 之前翻页拿回来的老会话（去重，老的接在后面）。没有可并的返回原数组。 */
export function mergeOlder(list, older) {
  if (!older || !older.length) return list;
  const ids = new Set(list.map((s) => s.id));
  const add = older.filter((s) => !ids.has(s.id));
  return add.length ? [...list, ...add] : list;
}

/**
 * 组内翻页的游标。服务端默认列表回 cutoff = 最新 60 条里最旧那条的 mtime（收藏 / 一家子补进来的老行不算，
 * 它们不连续）；某项目翻过页就记 p = { hi, lo, done }：[lo, hi) 这一段该项目的活跃会话都拿到了。
 *   · hi ≥ cutoff：翻过的那段与当前首页接得上，接着从 lo 往下要；
 *   · 否则（首页窗口往新挪了：新会话把一些老行挤出了 60 条）中间有断档，从 cutoff 重新往下翻
 *    （已经拿到的行按 id 去重，不会重复上屏）。
 * cutoff = 0：首页已经是全部，不用翻。返回下一次请求要用的 p（before = p.lo）。
 */
export function pagerFrom(p, cutoff) {
  if (p && cutoff && p.hi >= cutoff) return p;
  return { hi: cutoff, lo: cutoff, done: !cutoff };
}

/** 某项目在服务端还有多少条没拿到：projectCounts 里的总数 − 已加载的（收藏的也算已加载）。 */
export function serverRestOf(sessions, projectCounts, projectId) {
  const total = Number(projectCounts && projectCounts[projectId]) || 0;
  if (!total) return 0;
  let have = 0;
  for (const s of sessions || []) if (s.projectId === projectId) have++;
  return Math.max(0, total - have);
}

export const normQuery = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 命中词切段（搜索结果加粗用）：q 为规范化后的小写查询；整句命中优先，整句找不到再按空格分开的各个词。
 * → [{ s, hit? }]
 */
export function highlightParts(text, q) {
  text = String(text || '');
  if (!q) return [{ s: text }];
  const low = text.toLowerCase();
  const needles = low.includes(q) ? [q] : [...new Set(q.split(' ').filter(Boolean))];
  const out = [];
  let i = 0;
  while (i < text.length) {
    let at = -1, len = 0;
    for (const n of needles) { const k = low.indexOf(n, i); if (k >= 0 && (at < 0 || k < at || (k === at && n.length > len))) { at = k; len = n.length; } }
    if (at < 0 || !len) { out.push({ s: text.slice(i) }); break; }
    if (at > i) out.push({ s: text.slice(i, at) });
    out.push({ s: text.slice(at, at + len), hit: true });
    i = at + len;
  }
  return out;
}

// 搜索结果的三层（官方面板：标题与曾用名 / 宽松 / 转录全文，每层先给前 5 条）
export const SEARCH_LAYERS = ['title', 'loose', 'text'];
const layerOf = (h) => (h.match === 'former' || h.match === 'title' || h.match === 'recent' ? 'title' : h.match === 'loose' ? 'loose' : 'text');

/**
 * 把一串结果分层：活跃的按层分组、每层 per 条（open[层]=true 时全给）；已归档的另收一组（官方折进 show-archived）。
 * → { layers:[{ key, hits, hidden }], archived:[…] }（hidden = 这一层还藏着几条；空层不出）
 */
export function groupHits(hits, { per = 5, open = {} } = {}) {
  const by = { title: [], loose: [], text: [] };
  const archived = [];
  for (const h of hits || []) (h.archived ? archived : by[layerOf(h)]).push(h);
  const layers = [];
  for (const key of SEARCH_LAYERS) {
    const all = by[key];
    if (!all.length) continue;
    const shown = open[key] ? all : all.slice(0, per);
    layers.push({ key, hits: shown, hidden: all.length - shown.length });
  }
  return { layers, archived };
}
