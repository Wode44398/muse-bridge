// 选区的墨：每行左右两条边各挂一个弹簧，几何上把同一段里相邻的行连成一整块
// 带圆角（外角、内角同一个半径）的形状。只往给定的 <svg> 里写 path、不碰全局状态，
// 所以同一套也能跑在 Codex 的 iframe 文档里。
import { PAD } from './measure.js';

const NS = 'http://www.w3.org/2000/svg';
// 几种起法的弹簧（角频率 w、阻尼比 z）：拖选临界阻尼贴手；双击欠阻尼带一点回弹；三击 / 全选逐行漫开；
// charge 是触屏长按还没落定时的「蓄力」：慢弹簧（约 300ms 走到词的两头），配合 alphaT 只有三成浓度
const PARAMS = { drag: { w: 48, z: 1 }, word: { w: 34, z: 0.72 }, para: { w: 30, z: 0.9 }, all: { w: 32, z: 0.95 }, charge: { w: 15, z: 1 } };
export const EXIT_MS = 130;
const WET = 0.78;   // 拖的时候墨淡一点，松手沉到足色：告诉人「选定了」
const f = (n) => Math.round(n * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeIn = (p) => p * p * p;

function spring(x, v, t, w, z, h) {
  const a = -w * w * (x - t) - 2 * z * w * v;
  v += a * h;
  return [x + v * h, v];
}

function svgEl(svg, tag, attrs = {}) {
  const e = svg.ownerDocument.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

export class Ink {
  // o.mode：drag / word / para / all；o.ox / o.oy：起点（内容坐标），双击从这一点绽开、三击从这一行漫开
  constructor(svg, o) {
    this.svg = svg;
    this.mode = o.mode;
    this.ox = o.ox;
    this.oy = o.oy;
    this.fwd = o.fwd !== false;
    this.r = o.r ?? 6;
    this.reduce = !!o.reduce;
    this.g = svgEl(svg, 'g');
    this.fill = svgEl(svg, 'path', { class: 'ink-fill' });
    this.edge = svgEl(svg, 'path', { class: 'ink-edge' });
    this.g.append(this.fill, this.edge);
    svg.append(this.g);
    this.lines = new Map();
    this.inherit = o.inherit || null;
    this.wet = !!o.wet;
    this.alphaT = o.alphaT ?? null;   // 指定浓度（蓄力时 0.32）；null = 按湿 / 干
    this.alpha = this.mode === 'charge' ? 0 : this.wet ? WET : 1;
    this.edgeA = 0;
    this.edgeT = 0;
    this.exiting = false;
    this.exitT = 0;
    this.dead = false;
  }

  // 换上新的一组目标行。新出现的行从哪里长出来取决于起法：拖选从起点那一侧长、双击从点中处绽开、
  // 三击 / 全选从起点那一行起逐行晚一点漫开；不在新目标里的行朝起点方向收回再删掉。
  set(ms) {
    if (this.exiting) return;
    const seen = new Set();
    const fresh = this.lines.size === 0;
    let oIdx = 0;
    if (fresh && (this.mode === 'para' || this.mode === 'all')) {
      oIdx = this.oy == null ? 0 : ms.findIndex((m) => this.oy >= m.y1 && this.oy < m.y1 + m.h);
      if (oIdx < 0) {
        let best = Infinity;
        ms.forEach((m, i) => { const d = Math.abs(m.y1 + m.h / 2 - this.oy); if (d < best) { best = d; oIdx = i; } });
      }
    }
    ms.forEach((m, i) => {
      seen.add(m.key);
      let L = this.lines.get(m.key);
      if (!L) {
        L = { key: m.key, bid: m.bid, y1: m.y1, h: m.h, v1: 0, v2: 0, s: 1, vs: 0, delay: 0, dying: false, rr1: 0, rr2: 0 };
        const inh = this.inherit && this.inherit.get(m.key);
        const onAnchor = this.oy != null && this.oy >= m.y1 && this.oy < m.y1 + m.h;
        if (inh) { L.x1 = inh.x1; L.x2 = inh.x2; L.v1 = inh.v1; L.v2 = inh.v2; L.s = inh.s; }
        else if (this.mode === 'word' || this.mode === 'charge' || (this.mode === 'drag' && onAnchor && this.ox != null)) {
          L.x1 = L.x2 = clamp(this.ox ?? m.x1, m.x1, m.x2);
          L.s = this.mode === 'drag' ? 0.62 : 0.5;
        } else if (this.mode === 'para' || this.mode === 'all') {
          const d = Math.abs(i - oIdx);
          L.delay = fresh ? Math.min(d * (this.mode === 'all' ? 10 : 16), 240) : 0;
          if (d === 0 && this.ox != null && this.mode === 'para') { L.x1 = L.x2 = clamp(this.ox, m.x1, m.x2); L.s = 0.6; }
          else L.x1 = L.x2 = m.x1;
        } else {
          const below = this.oy == null ? this.fwd : (m.y1 + m.h / 2 > this.oy);
          L.x1 = L.x2 = below ? m.x1 : m.x2;
        }
        this.lines.set(m.key, L);
      }
      L.dying = false;
      L.t1 = m.x1; L.t2 = m.x2; L.y1 = m.y1; L.h = m.h; L.bid = m.bid;
    });
    for (const L of this.lines.values()) {
      if (seen.has(L.key) || L.dying) continue;
      L.dying = true;
      const below = this.oy == null ? this.fwd : (L.y1 + L.h / 2 > this.oy);
      L.t1 = L.t2 = below ? L.x1 : L.x2;
    }
    this.inherit = null;
  }

  // 版面变了（窗口缩放、流式输出撑开）：直接落到新位置，不演
  snap() {
    for (const L of this.lines.values()) {
      if (L.dying) { this.lines.delete(L.key); continue; }
      L.x1 = L.t1; L.x2 = L.t2; L.v1 = L.v2 = 0; L.s = 1; L.vs = 0; L.delay = 0; L.rr1 = L.rr2 = 0;
    }
  }

  exit() { this.exiting = true; }

  // dt：毫秒（已按慢放倍数折算、且不为负）。返回 true = 还在动，要下一帧
  step(dt) {
    dt = Math.max(0, dt);   // 负的时间差会把退场计时倒扣、墨永远留在那（调用方已夹过，这里再兜一道）
    let act = false;
    const P = PARAMS[this.mode] || PARAMS.drag;
    for (const L of [...this.lines.values()]) {
      if (L.delay > 0) { L.delay -= dt; act = true; if (L.delay > 0) continue; }
      if (this.reduce) { L.x1 = L.t1; L.x2 = L.t2; L.s = 1; L.v1 = L.v2 = 0; }
      else {
        for (let rem = dt; rem > 0; rem -= 4) {
          const h = Math.min(4, rem) / 1000;
          [L.x1, L.v1] = spring(L.x1, L.v1, L.t1, P.w, P.z, h);
          [L.x2, L.v2] = spring(L.x2, L.v2, L.t2, P.w, P.z, h);
          [L.s, L.vs] = spring(L.s, L.vs, 1, P.w * 0.9, Math.max(0.68, P.z * 0.9), h);
        }
      }
      // 流动的那一端按速度变圆（像液面的前沿），停下来收回原来的圆角
      const k = 1 - Math.exp(-dt / 40);
      L.rr1 += (Math.min(1, Math.abs(L.v1) / 1300) - L.rr1) * k;
      L.rr2 += (Math.min(1, Math.abs(L.v2) / 1300) - L.rr2) * k;
      const moving = Math.abs(L.x1 - L.t1) > 0.12 || Math.abs(L.x2 - L.t2) > 0.12 || Math.abs(L.v1) > 3 || Math.abs(L.v2) > 3
        || Math.abs(L.s - 1) > 0.003 || Math.abs(L.vs) > 0.02 || L.rr1 > 0.01 || L.rr2 > 0.01;
      if (!moving) { L.x1 = L.t1; L.x2 = L.t2; L.v1 = L.v2 = 0; L.s = 1; L.vs = 0; L.rr1 = L.rr2 = 0; }
      if (L.dying && L.x2 - L.x1 < 0.8) { this.lines.delete(L.key); continue; }
      if (moving) act = true;
    }
    const aT = this.alphaT ?? (this.wet ? WET : 1);
    this.alpha += (aT - this.alpha) * (this.reduce ? 1 : 1 - Math.exp(-dt / (this.mode === 'charge' ? 120 : 70)));
    if (Math.abs(this.alpha - aT) > 0.003) act = true; else this.alpha = aT;
    this.edgeA += (this.edgeT - this.edgeA) * (this.reduce ? 1 : 1 - Math.exp(-dt / 35));
    if (Math.abs(this.edgeA - this.edgeT) > 0.005) act = true; else this.edgeA = this.edgeT;
    if (this.exiting) {
      this.exitT += this.reduce ? dt * 1.6 : dt;
      if (this.exitT >= EXIT_MS) this.dead = true; else act = true;
    }
    return act;
  }

  // 每行一条带子：同一段里上下相邻、横向有重叠的行接成一块；没有邻居的那一侧按 s 收窄（双击的墨从半个行高长满）
  geom() {
    const p = this.exiting ? easeIn(Math.min(1, this.exitT / EXIT_MS)) : 0;
    const inset = p * 2;   // 退场往里收 2px
    const vis = [...this.lines.values()].filter((L) => L.delay <= 0 && L.x2 - L.x1 - inset * 2 > 0.8)
      .map((L) => ({ L, x1: L.x1 + inset, x2: L.x2 - inset, y1: L.y1, y2: L.y1 + L.h, cy: L.y1 + L.h / 2, up: false }))
      .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
    const touch = (a, b) => a.L.bid === b.L.bid && Math.abs(a.y2 - b.y1) < 0.6 && Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 1;
    for (let i = 0; i < vis.length; i++) {
      const v = vis[i];
      const up = i > 0 && touch(vis[i - 1], v);
      const dn = i < vis.length - 1 && touch(v, vis[i + 1]);
      const hh = (v.L.h / 2) * v.L.s - p;
      if (!up) v.y1 = v.cy - hh;
      if (!dn) v.y2 = v.cy + hh;
      if (up) v.y1 = vis[i - 1].y2;
      v.up = up;
    }
    const comps = [];
    let c = null;
    for (const v of vis) { if (!c || !v.up) { c = []; comps.push(c); } c.push(v); }
    return comps;
  }

  path() {
    let d = '';
    for (const comp of this.geom()) {
      // 上下两行的边差不到 1px 就对齐，免得出现一像素的台阶
      for (let i = 1; i < comp.length; i++) {
        if (Math.abs(comp[i].x2 - comp[i - 1].x2) < 0.75) comp[i].x2 = comp[i - 1].x2;
        if (Math.abs(comp[i].x1 - comp[i - 1].x1) < 0.75) comp[i].x1 = comp[i - 1].x1;
      }
      const rad = (v, right) => {
        const half = (v.y2 - v.y1) / 2;
        return this.r + (right ? v.L.rr2 : v.L.rr1) * Math.max(0, half - this.r);
      };
      const pts = [];
      for (const v of comp) { const r = rad(v, true); pts.push({ x: v.x2, y: v.y1, r }, { x: v.x2, y: v.y2, r }); }
      for (let i = comp.length - 1; i >= 0; i--) { const v = comp[i], r = rad(v, false); pts.push({ x: v.x1, y: v.y2, r }, { x: v.x1, y: v.y1, r }); }
      d += roundPoly(clean(pts));
    }
    return d;
  }

  render() {
    const d = this.path();
    this.fill.setAttribute('d', d);
    this.edge.setAttribute('d', d);
    const p = this.exiting ? easeIn(Math.min(1, this.exitT / EXIT_MS)) : 0;
    this.g.style.opacity = String(f(this.alpha * (1 - p)));
    this.edge.style.opacity = String(f(this.edgeA));
    if (this.dead) this.g.remove();
  }

  // 触屏选择柄骑在哪：首行的左边、末行的右边，取墨此刻的样子（还在排队的行用目标位置，柄不会先跳到行首）
  edges() {
    const ls = [...this.lines.values()].filter((L) => !L.dying).sort((a, b) => a.y1 - b.y1 || a.t1 - b.t1);
    if (!ls.length) return null;
    const a = ls[0], b = ls[ls.length - 1];
    return { s: { x: (a.delay > 0 ? a.t1 : a.x1) + PAD, y: a.y1, h: a.h }, e: { x: (b.delay > 0 ? b.t2 : b.x2) - PAD, y: b.y1, h: b.h } };
  }

  bbox() {
    const ls = [...this.lines.values()].filter((L) => !L.dying);
    if (!ls.length) return null;
    return { l: Math.min(...ls.map((L) => L.t1)), r: Math.max(...ls.map((L) => L.t2)), t: Math.min(...ls.map((L) => L.y1)), b: Math.max(...ls.map((L) => L.y1 + L.h)) };
  }

  // 选区的末端（拖选的终点那一头）：「已复制」小签、键盘唤出的菜单都落在这里
  head() {
    const ls = [...this.lines.values()].filter((L) => !L.dying).sort((a, b) => a.y1 - b.y1);
    if (!ls.length) return null;
    const L = this.fwd ? ls[ls.length - 1] : ls[0];
    return { x: this.fwd ? L.t2 - PAD : L.t1 + PAD, y1: L.y1, y2: L.y1 + L.h, first: ls[0] };
  }

  // 右键点在不在选区上：贴着某一行（左右各让 24px），或落在首行顶到末行底之间
  contains(x, y) {
    const ls = [...this.lines.values()].filter((L) => !L.dying);
    if (!ls.length) return false;
    for (const L of ls) if (x >= L.t1 - 24 && x <= L.t2 + 24 && y >= L.y1 - 6 && y <= L.y1 + L.h + 6) return true;
    const top = Math.min(...ls.map((L) => L.y1)), bot = Math.max(...ls.map((L) => L.y1 + L.h));
    const lft = Math.min(...ls.map((L) => L.t1)), rgt = Math.max(...ls.map((L) => L.t2));
    return y >= top && y <= bot && x >= lft - 24 && x <= rgt + 24;
  }

  // 复制的反馈：同一个形状浮起一张拓印，变亮、上移、淡走
  lift(K = 1) {
    const d = this.fill.getAttribute('d');
    if (!d) return null;
    const gh = svgEl(this.svg, 'path', { d, class: 'ink-ghost' });
    this.svg.append(gh);
    const a = gh.animate(
      [{ opacity: 0.85, transform: 'translateY(0) scale(1)' }, { opacity: 0.55, offset: 0.25 }, { opacity: 0, transform: 'translateY(-10px) scale(1.014)' }],
      { duration: 460 * K, easing: 'cubic-bezier(.165,.84,.44,1)', fill: 'both' },
    );
    a.finished.then(() => gh.remove(), () => gh.remove());
    return a;
  }
}

// 去掉重合点与共线点（边都是横平竖直的，叉积为 0 即共线）
export function clean(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01) { q.r = Math.min(q.r, p.r); continue; }
    out.push({ ...p });
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) { a.r = Math.min(a.r, b.r); out.pop(); }
  }
  for (let again = true; again && out.length > 3;) {
    again = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length], p = out[i], b = out[(i + 1) % out.length];
      if (Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) < 0.01) { out.splice(i, 1); again = true; break; }
    }
  }
  return out;
}

// 多边形每个顶点按各自半径倒圆（凸角、凹角一视同仁；半径不超过相邻两边各一半），三次贝塞尔近似圆弧
export function roundPoly(pts) {
  const n = pts.length;
  if (n < 3) return '';
  const K = 0.5523;
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], p = pts[i], b = pts[(i + 1) % n];
    const da = Math.hypot(a.x - p.x, a.y - p.y), db = Math.hypot(b.x - p.x, b.y - p.y);
    const r = Math.max(0, Math.min(p.r, da / 2, db / 2));
    const x1 = p.x + ((a.x - p.x) / da) * r, y1 = p.y + ((a.y - p.y) / da) * r;
    const x2 = p.x + ((b.x - p.x) / db) * r, y2 = p.y + ((b.y - p.y) / db) * r;
    d += (i ? 'L' : 'M') + f(x1) + ' ' + f(y1)
      + 'C' + f(x1 + (p.x - x1) * K) + ' ' + f(y1 + (p.y - y1) * K) + ' ' + f(x2 + (p.x - x2) * K) + ' ' + f(y2 + (p.y - y2) * K) + ' ' + f(x2) + ' ' + f(y2);
  }
  return d + 'Z';
}
