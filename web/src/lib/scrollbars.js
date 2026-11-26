// 全站滚动条的「平时隐身」：滚动时、或鼠标移到滚条那一条上时，给滚动容器挂 data-sb，
// 停下 1 秒后摘掉；拇指只在挂着 data-sb 时显形（样式见 app.css 全站滚动条段）。
// 用属性不用 class：Svelte 的 class 指令重算时会覆写 className，属性它不碰。
// 捕获阶段监听 document 的 scroll：元素自己的 scroll 事件不冒泡，但会经过捕获阶段。
// 「鼠标在滚条上」的判定：滚条画在元素内边距盒之外，鼠标落在上面时 target 是滚动容器本身、
// offsetX ≥ clientWidth（竖条）或 offsetY ≥ clientHeight（横条）。
//
// 另外两件事也在这里：
// ① 贴窗口右沿（桌面壳 WCO）：Electron 在窗口内沿留 5px 拉伸热区，系统层命中、页面改不了。浮出时量一次，
//    贴着窗口右沿的滚动容器挂 data-sb-edge，拇指改画在槽的左 3px（app.css），别的滚动条不动。
// ② 拇指优先：拉宽把手骑在接缝上时会盖住旁边滚动容器的滚动条。不挪把手、也不挪滚动条——鼠标停在把手上时
//    按几何算出它底下滚动条拇指的位置，正落在拇指上就给把手挂 data-sb-yield（app.css 里 pointer-events:none），
//    指针直接落到滚动条上；离开拇指再摘掉。只让拇指本体那一块，接缝其余部分照常能拖宽度。
const timers = new WeakMap();
const HIDE_MS = 1000;
let hot = null;   // 鼠标正停在它的滚条上：一直显形，离开后再按 HIDE_MS 隐身

// 溢出只有一两像素（行高取整、子像素缩放造成的假溢出，xterm 视口常见）时不浮出：拇指会几乎占满整条，看着像坏了
function scrollable(el) {
  return el.scrollHeight - el.clientHeight > 2 || el.scrollWidth - el.clientWidth > 2;
}

function maximized() {
  return outerWidth >= screen.availWidth - 1 && outerHeight >= screen.availHeight - 1;
}

function markEdge(el) {
  const root = document.documentElement;
  let edge = false;
  if (root.dataset.wco === '1' && el !== root && !maximized() && el.offsetWidth - el.clientWidth > 2) {
    edge = el.getBoundingClientRect().right >= innerWidth - 1;
  }
  if (edge !== el.hasAttribute('data-sb-edge')) el.toggleAttribute('data-sb-edge', edge);
}

function show(el) {
  if (!el.hasAttribute('data-sb')) {
    if (!scrollable(el)) return;
    markEdge(el);
    el.setAttribute('data-sb', '');
  }
  clearTimeout(timers.get(el));
}
function hideLater(el) {
  clearTimeout(timers.get(el));
  timers.set(el, setTimeout(() => { if (el !== hot) el.removeAttribute('data-sb'); }, HIDE_MS));
}

function onScroll(e) {
  const el = e.target === document ? document.documentElement : e.target;
  if (!(el instanceof Element)) return;
  show(el);
  if (el !== hot) hideLater(el);
}

// —— 拇指优先 ——
const SASH = /^(col|ew|row|ns)-resize$/;
let probeEl = null, probeSash = false;
let yieldSash = null, yieldBar = null;

function isSash(el) {
  if (el !== probeEl) { probeEl = el; probeSash = SASH.test(getComputedStyle(el).cursor); }
  return probeSash;
}

// 视口坐标 (x, y) 是否落在 el 滚动条的拇指上。拇指位置按几何推算，所以平时隐身、还没浮出的拇指也算。
// 标准属性（scrollbar-width / scrollbar-color）画的是原生条，两端各有一枚箭头按钮，长度按条宽估。
function onThumb(el, x, y) {
  const cw = el.clientWidth, ch = el.clientHeight;
  if (!cw || !ch) return false;
  const cs = getComputedStyle(el);
  const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
  const native = cs.scrollbarWidth !== 'auto' || cs.scrollbarColor !== 'auto';
  const r = el.getBoundingClientRect();
  const vw = el.offsetWidth - cw - bl - br;
  if (vw > 0 && el.scrollHeight > ch + 1) {
    const x0 = r.left + bl + cw, y0 = r.top + bt;
    if (x >= x0 && x < x0 + vw && y >= y0 && y < y0 + ch) {
      const btn = native ? vw : 0, len = ch - 2 * btn;
      const tl = Math.min(len, Math.max(native ? 18 : 32, len * ch / el.scrollHeight));
      const top = y0 + btn + (len - tl) * el.scrollTop / (el.scrollHeight - ch);
      return y >= top - 2 && y <= top + tl + 2;
    }
  }
  const hh = el.offsetHeight - ch - bt - bb;
  if (hh > 0 && el.scrollWidth > cw + 1) {
    const x0 = r.left + bl, y0 = r.top + bt + ch;
    if (y >= y0 && y < y0 + hh && x >= x0 && x < x0 + cw) {
      const btn = native ? hh : 0, len = cw - 2 * btn;
      const tl = Math.min(len, Math.max(native ? 18 : 32, len * cw / el.scrollWidth));
      const left = x0 + btn + (len - tl) * Math.abs(el.scrollLeft) / (el.scrollWidth - cw);
      return x >= left - 2 && x <= left + tl + 2;
    }
  }
  return false;
}

function release() {
  if (yieldSash) yieldSash.removeAttribute('data-sb-yield');
  yieldSash = yieldBar = null;
}

// 鼠标在把手上：找它底下第一个「拇指正好在这儿」的滚动容器，找到就让开
function tryYield(sash, x, y) {
  const stack = document.elementsFromPoint(x, y);
  const root = document.documentElement;
  for (let i = stack.indexOf(sash) + 1; i < stack.length; i++) {
    const el = stack[i];
    if (el === root || el === document.body) break;
    if (onThumb(el, x, y)) {
      yieldSash = sash; yieldBar = el;
      sash.setAttribute('data-sb-yield', '');
      return el;
    }
  }
  return null;
}

function onMove(e) {
  if (yieldSash) {
    // 按着键 = 正拖着拇指，别中途把把手放回来
    if (!e.buttons && (!yieldBar.isConnected || !onThumb(yieldBar, e.clientX, e.clientY))) release();
  } else if (!e.buttons && e.target instanceof Element && isSash(e.target)) {
    const bar = tryYield(e.target, e.clientX, e.clientY);
    if (bar) {
      if (hot && hot !== bar) hideLater(hot);
      hot = bar;
      show(bar);
      return;
    }
  }
  const el = e.target;
  const onBar = el instanceof Element && (
    (e.offsetX >= el.clientWidth && el.offsetWidth > el.clientWidth + 1 && el.scrollHeight > el.clientHeight) ||
    (e.offsetY >= el.clientHeight && el.offsetHeight > el.clientHeight + 1 && el.scrollWidth > el.clientWidth));
  const next = onBar ? el : null;
  if (next === hot) return;
  if (hot) hideLater(hot);
  hot = next;
  if (hot) show(hot);
}

if (typeof document !== 'undefined' && matchMedia('(pointer: fine)').matches) {
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('mousemove', onMove, { passive: true });
  document.documentElement.addEventListener('mouseleave', release);
  addEventListener('blur', release);
}
