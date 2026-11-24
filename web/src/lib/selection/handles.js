// 触屏选择柄：一根 2px 的杆贴着选区的边，圆头在杆外（起点在上、终点在下），不挡字；看得见的圆头 11px，能按的范围 44px。
// 柄和墨在同一个父元素里（滚动容器），随内容一起滚。柄不自己定位置，而是骑在墨此刻的边上，再挂一个硬弹簧：
// 墨的边一跳（全选、换手）柄也是滑过去的。
const E_OUT = 'cubic-bezier(.165,.84,.44,1)';
const E_IN = 'cubic-bezier(.5,0,.85,.45)';
// 阻尼比约 .68 的弹簧取样：峰值 1.054，圆头弹出来用
const SPRING = 'linear(0, 0.064, 0.212, 0.391, 0.568, 0.723, 0.846, 0.937, 0.997, 1.033, 1.05, 1.054, 1.05, 1.042, 1.032, 1.023, 1.014, 1.008, 1.003, 1, 0.998, 0.997, 0.997, 0.997, 1)';
const f2 = (n) => Math.round(n * 100) / 100;

function spring(x, v, t, w, z, h) {
  const a = -w * w * (x - t) - 2 * z * w * v;
  v += a * h;
  return [x + v * h, v];
}

// 打断一段动画：读出此刻的样子当新动画的起点，再取消旧的。不把动画「提交」成内联样式：
// 动画刚建、还没开始的那一帧这样做会把起始值定格，之后连内联样式都压不过
function freeze(el, props) {
  const cs = el.ownerDocument.defaultView.getComputedStyle(el), v = {};
  for (const p of props) v[p] = cs[p];
  el.getAnimations().forEach((a) => a.cancel());
  return v;
}

function make(doc, w) {
  const el = doc.createElement('div');
  el.className = 'sel-hd ' + w;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="stem"></div><div class="knob"></div><div class="hit"></div>';
  el.children[2].dataset.selHandle = w;
  return { w, el, stem: el.children[0], knob: el.children[1], x: 0, y: 0, h: 0, vx: 0, vy: 0, placed: false, on: false };
}

export function createHandles(doc) {
  return { s: make(doc, 's'), e: make(doc, 'e'), parent: null };
}

// 柄搬到墨所在的父元素里（换了滚动容器就跟过去），颜色按分页与明暗
export function mountHandles(H, parent, skin, theme) {
  // 父元素换了，或页面重绘时把柄连同其它子节点一起清掉了：重新挂上
  if (H.parent !== parent || H.s.el.parentNode !== parent || H.e.el.parentNode !== parent) {
    parent.append(H.s.el, H.e.el);
    H.parent = parent;
    H.s.placed = H.e.placed = false;
  }
  for (const h of [H.s, H.e]) { h.el.dataset.skin = skin; h.el.dataset.theme = theme; }
}

export function handleOf(target) {
  const w = target && target.closest && target.closest('[data-sel-handle]');
  return w ? w.dataset.selHandle : null;
}

export function grab(H, which, on) {
  H.s.el.classList.toggle('grab', on && which === 's');
  H.e.el.classList.toggle('grab', on && which === 'e');
}

// 长出来：杆从这一行的中线往上下长开，圆头晚 70ms 带一点回弹弹出来；终点比起点晚 30ms
export function showHandles(H, reduce) {
  for (const h of [H.s, H.e]) {
    h.el.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    h.placed = false;
    h.on = true;
    h.el.classList.add('on');
    const delay = h.w === 'e' ? 30 : 0;
    if (reduce) { h.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, delay, fill: 'both' }); continue; }
    h.stem.animate([{ scale: '1 0' }, { scale: '1 1' }], { duration: 160, delay, easing: E_OUT, fill: 'both' });
    h.knob.animate([{ scale: '0' }, { scale: '1' }], { duration: 300, delay: delay + 70, easing: SPRING, fill: 'both' });
  }
}

// 退场：圆头先缩、杆再收，比出现快
export function hideHandles(H, reduce) {
  for (const h of [H.s, H.e]) {
    if (!h.on) continue;
    h.on = false;
    h.el.classList.remove('grab');
    if (reduce) { h.el.getAnimations({ subtree: true }).forEach((a) => a.cancel()); h.el.classList.remove('on'); continue; }
    const kn = freeze(h.knob, ['scale']), sm = freeze(h.stem, ['scale']);
    h.el.getAnimations().forEach((a) => a.cancel());
    h.knob.animate([kn, { scale: '0' }], { duration: 90, easing: E_IN, fill: 'forwards' });
    h.stem.animate([sm, { scale: '1 0' }], { duration: 100, delay: 40, easing: E_IN, fill: 'both' }).finished.then(() => {
      if (!h.on) { h.el.classList.remove('on'); h.el.getAnimations({ subtree: true }).forEach((a) => a.cancel()); }
    }, () => {});
  }
}

// 每帧：目标取墨此刻的两条边；返回 true = 还在动
export function stepHandles(H, ink, dt, reduce) {
  if (!ink || (!H.s.on && !H.e.on)) return false;
  const ed = ink.edges();
  if (!ed) return false;
  let act = false;
  for (const h of [H.s, H.e]) {
    const t = ed[h.w];
    h.h = t.h;
    if (!h.placed || reduce) { h.x = t.x; h.y = t.y; h.vx = h.vy = 0; h.placed = true; }
    else {
      for (let rem = dt; rem > 0; rem -= 4) {
        const s = Math.min(4, rem) / 1000;
        [h.x, h.vx] = spring(h.x, h.vx, t.x, 55, 1, s);
        [h.y, h.vy] = spring(h.y, h.vy, t.y, 55, 1, s);
      }
    }
    if (Math.abs(h.x - t.x) > 0.2 || Math.abs(h.y - t.y) > 0.2) act = true;
    else { h.x = t.x; h.y = t.y; }
    h.el.style.transform = `translate(${f2(h.x)}px, ${f2(h.y)}px)`;
    h.el.style.setProperty('--h', h.h + 'px');
  }
  return act;
}

export function removeHandles(H) {
  H.s.el.remove();
  H.e.el.remove();
  H.parent = null;
}
