// 右键菜单的界面：命令式建 DOM、WAAPI 演动画（每一步的时长 / 曲线 / 先后都要精确控制，弹簧要能被打断接着走）。
// 挂在主文档 body 上；Codex 的 iframe 里右键也开在这里（坐标按 iframe 位置换算）。
//
// 动作：外框从指针那个角长出来（各分页用自己的进场曲线），大投影晚半拍浮起；条目随后从离指针近的那头起逐行落位。
// 悬停高亮是一块会滑的底（弹簧，划得快时纵向稍拉长）；按下底色加深、文字收一点；松手高亮闪一下再关；
// 关闭比打开快，朝来的方向缩一点淡出。玻璃材质的淡入只动外层自己的不透明度、不动祖先（祖先带 opacity 玻璃采不到底）。
import { icon } from './icons.js';

const E_OUT = 'cubic-bezier(.165,.84,.44,1)';
const E_IN = 'cubic-bezier(.5,0,.85,.45)';
const MOTION = {
  claude: { ease: E_OUT, dur: 210, from: 0.965 },
  codex: { ease: 'cubic-bezier(.16,1,.3,1)', dur: 200, from: 0.96 },
  agy: { ease: 'cubic-bezier(.05,.7,.1,1)', dur: 240, from: 0.97 },   // M3 减速曲线
  dimensio: { ease: 'cubic-bezier(.16,1,.3,1)', dur: 220, from: 0.965 },
  bridge: { ease: E_OUT, dur: 210, from: 0.965 },
};

let cur = null;   // { el, surf, shadow, pill, items, idx, busy, onClose }
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function spring(x, v, t, w, z, h) {
  const a = -w * w * (x - t) - 2 * z * w * v;
  v += a * h;
  return [x + v * h, v];
}

class Pill {
  constructor(el) { this.el = el; this.y = 0; this.v = 0; this.t = 0; this.h = 32; this.op = 0; this.opT = 0; this.raf = 0; this.last = 0; }
  to(y, h) {
    const appear = this.op < 0.05;
    this.t = y; this.h = h;
    if (appear) { this.y = y; this.v = 0; }
    this.opT = 1;
    this.kick();
  }
  hide() { this.opT = 0; this.kick(); }
  kick() { if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame((n) => this.tick(n)); } }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
  tick(now) {
    const dt = Math.max(0, Math.min(40, now - this.last));
    this.last = now;
    const rm = reduced();
    if (rm) { this.y = this.t; this.v = 0; }
    else for (let rem = dt; rem > 0; rem -= 4) [this.y, this.v] = spring(this.y, this.v, this.t, 46, 0.84, Math.min(4, rem) / 1000);
    this.op += (this.opT - this.op) * (rm ? 1 : 1 - Math.exp(-dt / (this.opT > this.op ? 26 : 45)));
    const st = rm ? 0 : Math.min(0.16, Math.abs(this.v) / 2600);
    const hh = this.h * (1 + st);
    this.el.style.transform = `translateY(${(this.y - (hh - this.h) / 2).toFixed(2)}px)`;
    this.el.style.height = hh.toFixed(2) + 'px';
    this.el.style.opacity = this.op.toFixed(3);
    if (Math.abs(this.y - this.t) > 0.1 || Math.abs(this.v) > 2 || Math.abs(this.op - this.opT) > 0.01) this.raf = requestAnimationFrame((n) => this.tick(n));
    else {
      this.raf = 0; this.y = this.t; this.op = this.opT;
      this.el.style.opacity = String(this.op); this.el.style.height = this.h + 'px'; this.el.style.transform = `translateY(${this.y}px)`;
    }
  }
}

function build(rows, skin) {
  const el = document.createElement('div');
  el.className = 'selm';
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  const shadow = document.createElement('div');
  shadow.className = 'selm-shadow';
  const surf = document.createElement('div');
  surf.className = 'selm-surf';
  const pillEl = document.createElement('div');
  pillEl.className = 'selm-pill';
  surf.append(pillEl);
  const items = [], blocks = [];
  for (const r of rows) {
    if (r.sep) {
      const s = document.createElement('div');
      s.className = 'selm-sep';
      surf.append(s);
      blocks.push(s);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'selm-row' + (r.disabled ? ' dis' : '');
    row.setAttribute('role', 'menuitem');
    if (r.disabled) row.setAttribute('aria-disabled', 'true');
    const inner = document.createElement('div');
    inner.className = 'selm-in';
    const ic = document.createElement('span');
    ic.className = 'selm-ic';
    ic.innerHTML = icon(skin, r.icon);
    const lb = document.createElement('span');
    lb.className = 'selm-lb';
    lb.textContent = r.label;
    inner.append(ic, lb);
    if (r.obj) { const o = document.createElement('span'); o.className = 'selm-obj'; o.textContent = r.obj; inner.append(o); }
    if (r.hk) { const h = document.createElement('span'); h.className = 'selm-hk'; h.textContent = r.hk; inner.append(h); }
    row.append(inner);
    surf.append(row);
    blocks.push(row);
    items.push({ ...r, el: row });
  }
  el.append(shadow, surf);
  return { el, shadow, surf, pillEl, items, blocks };
}

function animateIn(m, skin, up) {
  const K = 1;
  if (reduced()) {
    m.surf.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90, fill: 'both' });
    m.shadow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90, fill: 'both' });
    return;
  }
  const mo = MOTION[skin] || MOTION.bridge;
  m.el.animate([{ transform: `scale(${mo.from})` }, { transform: 'none' }], { duration: mo.dur * K, easing: mo.ease, fill: 'both' });
  m.surf.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90 * K, easing: 'linear', fill: 'both' });
  m.shadow.animate([{ opacity: 0, transform: 'translateY(-3px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 320 * K, delay: 30 * K, easing: E_OUT, fill: 'both' });
  const n = m.blocks.length;
  m.blocks.forEach((b, i) => {
    const order = up ? n - 1 - i : i;
    b.animate([{ opacity: 0, transform: `translateY(${up ? 3 : -3}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 180 * K, delay: (30 + 12 * Math.min(order, 8)) * K, easing: E_OUT, fill: 'both' });
  });
}

function hover(i) {
  const m = cur;
  if (!m) return;
  m.items.forEach((it, j) => it.el.classList.toggle('on', j === i && !it.disabled));
  m.idx = i;
  const it = m.items[i];
  if (!it || it.disabled) { m.pill.hide(); return; }
  m.pill.to(it.el.offsetTop, it.el.offsetHeight);
}

function activate(i) {
  const m = cur;
  if (!m || m.busy) return;
  const it = m.items[i];
  if (!it || it.disabled) return;
  m.busy = true;
  hover(i);
  const go = () => { closeMenu(); try { it.act(); } catch (e) { console.error('[selection] menu action failed', e); } };
  if (reduced()) { go(); return; }
  m.pillEl.classList.remove('press');
  it.el.classList.remove('press');
  // 和 macOS 确认菜单项那一下同一个意思：高亮灭一下再亮，然后才关
  m.pillEl.animate([{ opacity: 1 }, { opacity: 0.25, offset: 0.45 }, { opacity: 1 }], { duration: 110, easing: 'linear' });
  setTimeout(go, 110);
}

export const menuOpen = () => !!cur;
export const menuEl = () => cur?.el || null;

// opts：{ x, y（主文档视口坐标）, rows, skin, theme, font, kb（键盘唤出：高亮先落在第一项）, onClose }
export function openMenu(opts) {
  closeMenu(true);
  const rows = opts.rows.filter(Boolean);
  if (!rows.some((r) => !r.sep)) return;
  // 分隔线不出现在头尾、不连着两条
  const clean = rows.filter((r, i, a) => !(r.sep && (i === 0 || i === a.length - 1 || a[i - 1].sep)));
  const m = build(clean, opts.skin);
  m.el.dataset.skin = opts.skin;
  m.el.dataset.theme = opts.theme;
  if (opts.font) m.el.style.fontFamily = opts.font;
  document.body.append(m.el);
  const w = m.el.offsetWidth, h = m.el.offsetHeight;
  let left = opts.x + 2, top = opts.y + 2, ox = 'left', oy = 'top';
  if (left + w > innerWidth - 8) { left = Math.max(8, opts.x - w - 2); ox = 'right'; }
  if (top + h > innerHeight - 8) { top = Math.max(8, opts.y - h - 2); oy = 'bottom'; }
  m.el.style.left = left + 'px';
  m.el.style.top = top + 'px';
  m.el.style.transformOrigin = `${ox} ${oy}`;
  m.pill = new Pill(m.pillEl);
  m.idx = -1;
  m.onClose = opts.onClose || null;
  cur = m;
  animateIn(m, opts.skin, oy === 'bottom');
  m.items.forEach((it, i) => {
    it.el.addEventListener('pointermove', () => { if (cur === m && m.idx !== i) hover(i); });
    it.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (it.disabled) return;
      it.el.classList.add('press');
      m.pillEl.classList.add('press');
    });
    it.el.addEventListener('pointerup', () => { if (it.el.classList.contains('press')) activate(i); });
  });
  m.surf.addEventListener('pointerleave', () => {
    if (cur !== m || m.busy) return;
    m.idx = -1;
    m.items.forEach((t) => t.el.classList.remove('on', 'press'));
    m.pillEl.classList.remove('press');
    m.pill.hide();
  });
  // 按下菜单不许抢走焦点、不许清掉选区（要复制的正是那段选区）
  m.el.addEventListener('mousedown', (e) => e.preventDefault());
  m.el.addEventListener('contextmenu', (e) => e.preventDefault());
  if (opts.kb) { const i = m.items.findIndex((t) => !t.disabled); if (i >= 0) hover(i); }
}

export function closeMenu(instant = false) {
  const m = cur;
  if (!m) return;
  cur = null;
  m.pill.stop();
  const cb = m.onClose;
  if (cb) try { cb(); } catch {}
  if (instant || reduced()) { m.el.remove(); return; }
  // 打断进场：先把此刻的样子落成内联样式，退场从这里接着走
  m.el.getAnimations({ subtree: true }).forEach((a) => { try { a.commitStyles(); } catch {} a.cancel(); });
  m.el.style.pointerEvents = 'none';
  const a = m.el.animate([{ transform: 'scale(.985)' }], { duration: 100, easing: E_IN, fill: 'forwards' });
  m.surf.animate([{ opacity: 0 }], { duration: 100, easing: E_IN, fill: 'forwards' });
  m.shadow.animate([{ opacity: 0 }], { duration: 70, easing: E_IN, fill: 'forwards' });
  a.finished.then(() => m.el.remove(), () => m.el.remove());
}

// 菜单开着时的键盘：↑↓ 跳着走（跳过分隔与置灰项）、Home / End、Enter / 空格执行、Esc / Tab 关。返回 true = 吃掉了这个键
export function menuKey(e) {
  const m = cur;
  if (!m) return false;
  const en = m.items.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (en.length) {
      const p = en.indexOf(m.idx);
      const n = p < 0 ? (e.key === 'ArrowDown' ? 0 : en.length - 1) : (p + (e.key === 'ArrowDown' ? 1 : -1) + en.length) % en.length;
      hover(en[n]);
    }
    return true;
  }
  if (e.key === 'Home' || e.key === 'End') { if (en.length) hover(e.key === 'Home' ? en[0] : en[en.length - 1]); return true; }
  if (e.key === 'Enter' || e.key === ' ') { if (m.idx >= 0) activate(m.idx); return true; }
  if (e.key === 'Escape' || e.key === 'Tab') { closeMenu(); return true; }
  return false;
}
