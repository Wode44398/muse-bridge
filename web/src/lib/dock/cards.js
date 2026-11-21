// 工作区卡片的排布（纯函数，不碰 DOM / Svelte；四个 agent 分页的工作区共用这一份）。
//
// 两列的顺序（cols.a / cols.b）是这个宿主全部工具的一份排列，没开的卡也留在里面——下次开出来还在老位置附近。
// 卡片按比例绝对定位：位置写成 calc(百分比 + 缝)，不量容器尺寸；列数变化、换位、换列时卡片不换父节点、
// 不重挂——终端和浏览器的连接、滚回缓冲都留着。

export const GAP = 8;
// 权重的上下限：拖分隔条时按像素钳最小高度，这里只防存坏的值
const W_MIN = 0.15;
const W_MAX = 8;

// 去重、去掉不认识的；缺的（新加的工具、存坏了的）按 colOf 给的默认列补在末尾
export function normCols(c, keys, colOf = () => 'b') {
  const src = c && typeof c === 'object' ? c : {};
  const seen = new Set();
  const take = (arr) => (Array.isArray(arr) ? arr : []).filter((v) => keys.includes(v) && !seen.has(v) && !!seen.add(v));
  const a = take(src.a);
  const b = take(src.b);
  for (const v of keys) if (!seen.has(v)) (colOf(v) === 'a' ? a : b).push(v);
  return { a, b };
}

export function normWeights(v, keys) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, n] of Object.entries(v)) {
    if (keys.includes(k) && typeof n === 'number' && Number.isFinite(n)) out[k] = Math.min(W_MAX, Math.max(W_MIN, n));
  }
  return out;
}

export const sameCols = (p, q) => p.a.join() === q.a.join() && p.b.join() === q.b.join();
export const weightOf = (w, v) => w?.[v] ?? 1;

// v 插进 col 列、排在这一列第 idx 张【看得见的】卡前面（没开的卡留在原处）
export function place(st, v, col, idx, shown) {
  const a = st.a.filter((k) => k !== v);
  const b = st.b.filter((k) => k !== v);
  const arr = col === 'a' ? a : b;
  const vis = arr.filter((k) => shown.includes(k));
  const at = idx < vis.length ? arr.indexOf(vis[idx]) : vis.length ? arr.indexOf(vis[vis.length - 1]) + 1 : arr.length;
  arr.splice(at, 0, v);
  return { a, b };
}

// 拖动中的预览排布：一律从起手排布推（不在上一帧的预览上叠加），指针回到原处就原样复原。
//   · 起手两列：左半 / 右半定列，纵向按「这一列放进它之后每格多高」定第几格。拖空的那一列留着当落点。
//   · 起手一列：纵向定第几格；够宽、还有别的卡时拖进右侧三成 = 拆成两列、它单独占右列
//     （拆开后退回门槛放宽到右半边，免得在门槛上来回抖）。
// fx / fy = 指针在卡片区里的相对位置（0..1）。
export function target(o, fx, fy, allowSplit = true) {
  const { start: st, v, shown } = o;
  const vis = (arr) => arr.filter((k) => k !== v && shown.includes(k));
  const ra = vis(st.a);
  const rb = vis(st.b);
  const slot = (count) => Math.max(0, Math.min(count, Math.floor(fy * (count + 1))));
  if (o.n0 === 2) {
    const col = fx < 0.5 ? 'a' : 'b';
    return { n: 2, split: false, cols: place(st, v, col, slot(col === 'a' ? ra.length : rb.length), shown) };
  }
  const others = ra.length + rb.length;
  if (allowSplit && o.canTwo && others > 0 && fx > (o.split ? 0.5 : 0.7)) {
    const a = [...st.a.filter((k) => k !== v), ...st.b.filter((k) => k !== v && shown.includes(k))];
    const b = [v, ...st.b.filter((k) => k !== v && !shown.includes(k))];
    return { n: 2, split: true, cols: { a, b } };
  }
  const i = slot(others);
  const toA = i < ra.length || (i === ra.length && (st.a.includes(v) || !rb.length));
  return { n: 1, split: false, cols: toA ? place(st, v, 'a', i, shown) : place(st, v, 'b', i - ra.length, shown) };
}

// 此刻摆出来的列：允许两列才分两列（哪怕其中一列空着——拖动时空列是落点），否则 a 再 b 叠成一列
export function columns(cols, shown, two) {
  const a = cols.a.filter((k) => shown.includes(k));
  const b = cols.b.filter((k) => shown.includes(k));
  return two ? [a, b] : [[...a, ...b]];
}

// 第 i 段的起点：(100% - 缝 × (n-1)) × 前面的占比 + 缝 × i
const startCalc = (frac, gaps, i) => `calc((100% - ${GAP * gaps}px) * ${frac.toFixed(6)} + ${GAP * i}px)`;
const sizeCalc = (frac, gaps) => `calc((100% - ${GAP * gaps}px) * ${frac.toFixed(6)})`;

// 每张卡的格子。列宽均分；一列里的卡按权重分高度。
export function slots(list, w) {
  const at = {};
  const nc = list.length;
  list.forEach((col, ci) => {
    const total = col.reduce((s, v) => s + weightOf(w, v), 0) || 1;
    let acc = 0;
    col.forEach((v, ri) => {
      const f = weightOf(w, v) / total;
      at[v] = {
        col: ci,
        row: ri,
        left: startCalc(ci / nc, nc - 1, ci),
        width: sizeCalc(1 / nc, nc - 1),
        top: startCalc(acc / total, col.length - 1, ri),
        height: sizeCalc(f, col.length - 1),
      };
      acc += weightOf(w, v);
    });
  });
  return at;
}
export const boxCss = (s) => `left:${s.left};width:${s.width};top:${s.top};height:${s.height}`;

// 两列时拖空的那一列（描一圈告诉你还能放回去）；没有空列回 ''
export function emptyColCss(list) {
  if (list.length !== 2) return '';
  const empty = list.findIndex((c) => c.length === 0);
  if (empty < 0) return '';
  return `left:${startCalc(empty / 2, 1, empty)};width:${sizeCalc(1 / 2, 1)};top:0;height:100%`;
}

// 卡与卡之间的分隔条（拖了调这两张的高度比）：落在上一张的下沿那道缝里
export function dividers(list, at) {
  const out = [];
  for (const col of list) {
    for (let i = 0; i + 1 < col.length; i++) {
      const up = at[col[i]];
      const down = at[col[i + 1]];
      if (!up || !down) continue;
      out.push({ key: `${col[i]}|${col[i + 1]}`, up: col[i], down: col[i + 1], css: `left:${up.left};width:${up.width};top:calc(${down.top} - ${GAP}px);height:${GAP}px` });
    }
  }
  return out;
}

// 拖分隔条：这两张的权重之和不变，按像素位移重新分；各自不低于 minPx。
// avail = 这一列可分的总高（容器高 - 缝），total = 这一列的权重和。
export function resizePair(wUp, wDown, total, avail, dy, minPx) {
  const pair = wUp + wDown;
  const pxUp = (wUp / total) * avail;
  const pxPair = (pair / total) * avail;
  const lo = Math.min(minPx, pxPair / 2);
  const next = Math.min(pxPair - lo, Math.max(lo, pxUp + dy));
  const up = (next / avail) * total;
  return [up, pair - up];
}
