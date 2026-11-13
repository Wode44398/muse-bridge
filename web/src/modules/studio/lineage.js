// 作品流左侧的血缘线（git graph 式泳道），纯函数，有单测。
//
// 列表自上而下＝新到旧，父作品（更早）一般在子作品下方。逐行扫一遍，维护「每条泳道正在往下等谁」：
//   · 有泳道在等这一行 → 这一行落在最左那条上，其余等它的泳道在这里并进来；
//   · 没人等 → 占第一条空道；
//   · 这一行的父作品在列表里（且在它下面）→ 第一个父作品沿本道继续往下，其余父作品各开一条新道；
//   · 父作品不在已加载的列表里 → stub（节点上方画一截渐隐短线，表示「还有上游」）。
// 每行只描述「穿过 / 从上进来 / 往下出去」的线段，界面每行画自己那一小段 SVG，不用量任何位置。
//
// rows: [{ id, parents?: [id] } | { header: true }]  —— 分组标题行只让线穿过
// 返回同长数组：{ lane, pass: [{lane, from, to}], into: [{lane, from, to}], out: [{lane, from, to}], stub }

export const MAX_LANES = 3;

export function layoutLineage(rows) {
  const index = new Map();
  rows.forEach((r, i) => { if (r && !r.header && r.id) index.set(r.id, i); });
  /** @type {({from: string, to: string} | null)[]} */
  const lanes = [];
  const clamp = (l) => Math.min(l, MAX_LANES - 1);
  const freeLane = () => {
    for (let l = 0; l < lanes.length; l++) if (!lanes[l]) return l;
    return lanes.length;
  };
  const out = [];
  rows.forEach((r, i) => {
    if (!r || r.header) {
      out.push({ lane: -1, pass: lanes.flatMap((e, l) => (e ? [{ lane: clamp(l), from: e.from, to: e.to }] : [])), into: [], out: [], stub: false });
      return;
    }
    const waiting = [];
    lanes.forEach((e, l) => { if (e && e.to === r.id) waiting.push(l); });
    const lane = waiting.length ? waiting[0] : freeLane();
    const into = waiting.map((l) => ({ lane: clamp(l), from: lanes[l].from, to: r.id }));
    for (const l of waiting) lanes[l] = null;
    const pass = lanes.flatMap((e, l) => (e && l !== lane ? [{ lane: clamp(l), from: e.from, to: e.to }] : []));
    const parents = [...new Set(r.parents || [])];
    const below = parents.filter((p) => index.has(p) && index.get(p) > i);
    const stub = parents.some((p) => !index.has(p));
    const outs = [];
    below.forEach((p, k) => {
      const l = k === 0 ? lane : freeLane();
      lanes[l] = { from: r.id, to: p };
      outs.push({ lane: clamp(l), from: r.id, to: p });
    });
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    out.push({ lane: clamp(lane), pass, into, out: outs, stub });
  });
  return out;
}

/** 某作品的整条链（祖先 + 后代，只算列表里有的）：悬停高亮用 */
export function chainOf(rows, id) {
  if (!id) return new Set();
  const byId = new Map();
  const kids = new Map();
  for (const r of rows) {
    if (!r || r.header || !r.id) continue;
    byId.set(r.id, r);
    for (const p of r.parents || []) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r.id); }
  }
  const seen = new Set([id]);
  const up = [id];
  while (up.length) { const n = byId.get(up.pop()); for (const p of n?.parents || []) if (byId.has(p) && !seen.has(p)) { seen.add(p); up.push(p); } }
  const down = [id];
  while (down.length) { for (const c of kids.get(down.pop()) || []) if (!seen.has(c)) { seen.add(c); down.push(c); } }
  return seen;
}

/** 列表里有没有任何一条血缘线（没有就不留 20px 的槽，行直接顶格） */
export const hasLineage = (rows) => rows.some((r) => r && !r.header && (r.parents || []).length);
