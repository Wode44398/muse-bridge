// 触屏选区的工具条：横排胶囊，停在选区上方正中（放不下才放到下方），只在手指离开后出现。
// 挂在主文档 body 上、fixed 定位；Codex 的 iframe 里选的字也开在这里（调用方已把坐标换算成主文档的）。
//
// 动作：从选区上沿正中长出来（弹簧），按钮从离选区最近的那个开始往两边亮起；拖柄、滑动时先让开，松手后从原位置滑到新位置
// （是同一条，不是重新弹一条）；放不下的收进「›」翻页，翻页时整排滑走、胶囊宽度一起变；复制后收成「✓ 已复制 · N 字」。
// 外层只做缩放与位移、不碰不透明度：外层一旦动了不透明度就成了磨砂的取样边界，玻璃采不到背后的页面。
const E_OUT = 'cubic-bezier(.165,.84,.44,1)';
const E_IN = 'cubic-bezier(.5,0,.85,.45)';
const SPRING = 'linear(0, 0.064, 0.212, 0.391, 0.568, 0.723, 0.846, 0.937, 0.997, 1.033, 1.05, 1.054, 1.05, 1.042, 1.032, 1.023, 1.014, 1.008, 1.003, 1, 0.998, 0.997, 0.997, 0.997, 1)';
const BAR_H = 44;
const CHEV_R = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
const CHEV_L = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8 10 12.5"/></svg>';
const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.6 11.4 12.5 4.8"/></svg>';

const B = { el: null, surf: null, on: false, temp: false, items: [], page: 0, x: 0, y: 0, w: 0, pos: null, anchor: null };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function freeze(el, props) {
  const cs = getComputedStyle(el), v = {};
  for (const p of props) v[p] = cs[p];
  el.getAnimations().forEach((a) => a.cancel());
  return v;
}

function ensure() {
  if (B.el && B.el.isConnected) return;
  const el = document.createElement('div');
  el.className = 'selt';
  el.setAttribute('role', 'toolbar');
  el.innerHTML = '<div class="selt-surf"></div>';
  document.body.append(el);
  B.el = el;
  B.surf = el.firstChild;
  // 按下按钮不许抢焦点、不许触发页面上「点空白处取消」：触屏控制器认 contains() 放行
  B.surf.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const b = e.target.closest('.selt-it');
    if (b) { b.classList.add('press'); b._down = true; }
  });
  B.surf.addEventListener('pointerup', (e) => { const b = e.target.closest('.selt-it'); if (b && b._down) run(b); });
  const clearPress = () => B.surf.querySelectorAll('.press').forEach((b) => { b.classList.remove('press'); b._down = false; });
  B.surf.addEventListener('pointercancel', clearPress);
  B.surf.addEventListener('pointerleave', clearPress);
  B.surf.addEventListener('contextmenu', (e) => e.preventDefault());
}

export const barEl = () => B.el;
export const barContains = (t) => !!(B.el && t && B.el.contains(t));
export const barOn = () => B.on && !B.temp;

function pagesOf(items) {
  if (items.length <= 4) return [items];
  return [[...items.slice(0, 3), { more: 1 }], [{ back: 1 }, ...items.slice(3)]];
}

function buildRow(list) {
  const row = document.createElement('div');
  row.className = 'selt-row';
  for (const it of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'selt-it' + (it.more || it.back ? ' ico' : '');
    b.innerHTML = '<span class="pr"></span>' + (it.more ? CHEV_R : it.back ? CHEV_L : '<span></span>');
    if (it.more) b.setAttribute('aria-label', it.label || '›');
    if (!it.more && !it.back) b.lastChild.textContent = it.label;
    b._it = it;
    row.append(b);
  }
  return row;
}

function rowWidth(row) {
  B.surf.append(row);
  const w = Math.ceil(row.scrollWidth);
  row.remove();
  return w;
}

// 停在哪：选区上方正中，离起点的圆头留出空隙；上面放不下才放到下方（让出终点圆头）；横向夹在屏内
function place(w) {
  const a = B.anchor;
  const vv = window.visualViewport;
  const vTop = (vv ? vv.offsetTop : 0) + 8;
  const vBot = (vv ? vv.offsetTop + vv.height : innerHeight) - 8;
  const topLimit = Math.max(vTop, a.vis.t);
  // 和选区上沿留 24：起点圆头伸到上沿外 10，它的触摸范围更高，工具条别压住它
  let y = a.t - 24 - BAR_H, below = false;
  if (y < topLimit) { y = a.b + 22; below = true; }
  if (y + BAR_H > Math.min(vBot, a.vis.b)) y = Math.max(topLimit, Math.min(vBot - BAR_H, (a.t + a.b) / 2 - BAR_H / 2));
  const cx = (Math.max(a.l, a.vis.l) + Math.min(a.r, a.vis.r)) / 2;
  const x = Math.max(8, Math.min(innerWidth - w - 8, cx - w / 2));
  return { x, y, below, ox: Math.max(16, Math.min(w - 16, cx - x)) };
}

function inAnims(row, ox) {
  B.el.animate([{ scale: '.9', translate: '0 5px' }, { scale: '1', translate: '0 0' }], { duration: 300, easing: SPRING, fill: 'both' });
  B.surf.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: 'linear', fill: 'both' });
  // 按钮从离选区最近的那个开始往两边亮：看起来是从那一点打开的
  const kids = [...row.children];
  let acc = 4;
  const dist = kids.map((b) => { const w = b.offsetWidth || 50, c = acc + w / 2; acc += w; return Math.abs(c - ox); });
  dist.map((d, i) => [d, i]).sort((a, b) => a[0] - b[0]).forEach(([, i], rank) => {
    kids[i].animate([{ opacity: 0, translate: '0 2px' }, { opacity: 1, translate: '0 0' }], { duration: 170, delay: 40 + 14 * rank, easing: E_OUT, fill: 'both' });
  });
}

// anchor：选区在主文档视口里的外接框 { l, r, t, b } 与可见区 vis；skin / theme / font 跟着选区所在的分页
export function showBar({ items, anchor, skin, theme, font }) {
  ensure();
  B.items = items;
  B.anchor = anchor;
  B.page = 0;
  B.el.dataset.skin = skin;
  B.el.dataset.theme = theme;
  B.el.style.fontFamily = font || '';
  const row = buildRow(pagesOf(items)[0]);
  const w = rowWidth(row);
  const pos = place(w);
  const wasOn = B.on, from = B.pos;
  const cur = B.temp ? freeze(B.surf, ['opacity']) : null;
  B.surf.replaceChildren(row);
  B.surf.style.width = w + 'px';
  B.el.style.left = pos.x + 'px';
  B.el.style.top = pos.y + 'px';
  B.el.style.transformOrigin = `${pos.ox}px ${pos.below ? '0%' : '100%'}`;
  B.el.classList.add('on');
  B.el.classList.remove('off');
  B.el.getAnimations({ subtree: true }).forEach((a) => a.cancel());
  if (reduced()) B.surf.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, fill: 'both' });
  else if (wasOn && from) {
    // 同一条挪过去：从原来的位置滑到新位置（让开过就同时淡回来）
    B.el.animate([{ translate: `${from.x - pos.x}px ${from.y - pos.y}px` }, { translate: '0 0' }], { duration: 320, easing: SPRING, fill: 'both' });
    if (cur) B.surf.animate([{ opacity: cur.opacity }, { opacity: 1 }], { duration: 140, easing: 'linear', fill: 'both' });
    if (from.w && from.w !== w) B.surf.animate([{ width: from.w + 'px' }, { width: w + 'px' }], { duration: 260, easing: E_OUT });
  } else inAnims(row, pos.ox);
  B.on = true;
  B.temp = false;
  B.x = pos.x; B.y = pos.y; B.w = w;
  B.pos = { x: pos.x, y: pos.y, w };
}

// temp = 先让开（拖柄、滑动），之后 showBar 会从原位置滑回来；否则彻底收起
export function hideBar(temp = false) {
  if (!B.el || !B.on) return;
  if (B.temp) { if (!temp) { B.on = false; B.temp = false; B.pos = null; B.el.classList.remove('on'); } return; }
  B.temp = temp;
  if (!temp) B.on = false;
  B.el.classList.add('off');   // 正在收、让开着的工具条看不见，也不许接住手指（会挡住底下的选择柄）
  const from = freeze(B.el, ['scale', 'translate']), fo = freeze(B.surf, ['opacity']);
  B.surf.querySelectorAll('*').forEach((x) => x.getAnimations().forEach((a) => a.finish()));
  B.el.animate([from, { scale: '.96', translate: from.translate }], { duration: 100, easing: E_IN, fill: 'forwards' });
  B.surf.animate([fo, { opacity: 0 }], { duration: 100, easing: E_IN, fill: 'forwards' }).finished.then(() => {
    if (!B.on) { B.el.classList.remove('on'); B.el.getAnimations({ subtree: true }).forEach((a) => a.cancel()); B.pos = null; }
  }, () => {});
}

function pageTo(p) {
  const pages = pagesOf(B.items);
  if (!pages[p]) return;
  const dir = p > B.page ? 1 : -1;
  const old = B.surf.firstElementChild, row = buildRow(pages[p]), w = rowWidth(row);
  const cx = B.x + B.w / 2, x = Math.max(8, Math.min(innerWidth - w - 8, cx - w / 2));
  B.surf.append(row);
  if (reduced()) old?.remove();
  else {
    old?.animate([{ translate: '0 0', opacity: 1 }, { translate: `${-dir * 18}px 0`, opacity: 0 }], { duration: 120, easing: E_IN, fill: 'forwards' }).finished.then(() => old.remove(), () => old.remove());
    row.animate([{ translate: `${dir * 18}px 0`, opacity: 0 }, { translate: '0 0', opacity: 1 }], { duration: 220, delay: 40, easing: E_OUT, fill: 'both' });
    B.surf.animate([{ width: B.w + 'px' }, { width: w + 'px' }], { duration: 240, easing: E_OUT });
    B.el.animate([{ translate: `${B.x - x}px 0` }, { translate: '0 0' }], { duration: 240, easing: E_OUT });
  }
  B.surf.style.width = w + 'px';
  B.el.style.left = x + 'px';
  B.page = p; B.w = w; B.x = x;
  B.pos = { x, y: B.y, w };
}

// 复制之后：胶囊收成一句确认，对勾一笔画出来
export function confirmBar(text) {
  if (!B.el || !B.on) return;
  const old = B.surf.firstElementChild;
  const row = document.createElement('div');
  row.className = 'selt-row';
  row.innerHTML = '<div class="selt-ok">' + CHECK + '<span></span></div>';
  row.querySelector('span').textContent = text;
  const w = rowWidth(row), cx = B.x + B.w / 2, x = Math.max(8, Math.min(innerWidth - w - 8, cx - w / 2));
  B.surf.append(row);
  const path = row.querySelector('path');
  if (reduced()) { old?.remove(); path.style.strokeDashoffset = '0'; }
  else {
    old?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: E_IN, fill: 'forwards' }).finished.then(() => old.remove(), () => old.remove());
    row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 70, fill: 'both' });
    path.animate([{ strokeDashoffset: 20 }, { strokeDashoffset: 0 }], { duration: 240, delay: 90, easing: E_OUT, fill: 'both' });
    B.surf.animate([{ width: B.w + 'px' }, { width: w + 'px' }], { duration: 260, easing: SPRING });
    B.el.animate([{ translate: `${B.x - x}px 0` }, { translate: '0 0' }], { duration: 260, easing: SPRING });
  }
  B.surf.style.width = w + 'px';
  B.el.style.left = x + 'px';
  B.w = w; B.x = x;
}

function run(b) {
  const it = b._it;
  b._down = false;
  const go = () => {
    b.classList.remove('press');
    if (it.more) return pageTo(B.page + 1);
    if (it.back) return pageTo(B.page - 1);
    try { it.act(); } catch (e) { console.error('[selection] toolbar action failed', e); }
  };
  if (reduced()) { go(); return; }
  setTimeout(go, 90);   // 按下的底留一瞬再动作：看得见按到了哪一个
}
