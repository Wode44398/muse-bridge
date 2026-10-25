// Edge（Win11 Fluent 浮层）同款滚动条的「平时隐身」：滚动时、或鼠标移到滚条那一条上时，给滚动容器挂 data-sb，
// 停下 1 秒后摘掉；拇指只在挂着 data-sb 时显形（样式见 app.css 全站滚动条段）。
// 用属性不用 class：Svelte 的 class 指令重算时会覆写 className，属性它不碰。
// 捕获阶段监听 document 的 scroll：元素自己的 scroll 事件不冒泡，但会经过捕获阶段。
// 「鼠标在滚条上」的判定：滚条画在元素内边距盒之外，鼠标落在上面时 target 是滚动容器本身、
// offsetX ≥ clientWidth（竖条）或 offsetY ≥ clientHeight（横条）。
const timers = new WeakMap();
const HIDE_MS = 1000;
let hot = null;   // 鼠标正停在它的滚条上：一直显形，离开后再按 HIDE_MS 隐身

function show(el) {
  if (!el.hasAttribute('data-sb')) el.setAttribute('data-sb', '');
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

function onMove(e) {
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
}
