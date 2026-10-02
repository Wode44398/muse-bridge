// touchAutoScroll.js —— 手机上拖选择柄贴近滚动区上下边缘时自动滚动（md 阅读态 / 编辑器共用）。
//
// 拖柄期间页面收不到任何 touch/pointer 事件（柄由浏览器自己接管），手指在哪只能从选区的活动端
// （focus——浏览器按柄的落点现命中出来的那个字）反推。落点伸进感应带多深就滚多快：深度 0→1
// 线性对应速度 0→VMAX，往边上拉得越狠滚得越快，退出感应带就停。落点只能按行跳（一行 ~27px），
// 目标速度再过一道一阶低通，行间跳变就成了连续的加减速。
//
// 滚的时候【不动选区】：脚本改选区会把正拖着的柄掐断（见 touchSelection.js 的 schedule）。内容在
// 手指底下滚上去，浏览器下一次推进拖动时按柄的落点重新命中，选区自然跟着长；手指真停着不发
// 事件时，活动端随内容滚出感应带，速度自己降到 0——不会失控地一直滚下去。
import { lastPointerTouch, fingerOnPage, onNativeDragEnd, browserDrivenSelection, recentSelectAll } from './touchSelection.js';

const ZONE = 96;     // 感应带高度（CSS px）：滚动区可视范围上下各这么宽
const GRAB = 18;     // 柄的落点在手指上方约这么多——手指按到最边上时落点离边还差这点，深度按它拉满
const VMAX = 1600;   // 拉满时的速度 px/s（约两屏/秒）
const TAU = 90;      // 速度低通时间常数 ms
const GAP = 400;     // 距上一发选区变化超过这么久＝一次新拖动的第一帧（或松手后的收尾），不起滚

const roots = new Set();
let installed = false;
let run = null;        // { root, sc, v, pos, last, lastSel, raf }
let lastEvt = 0;
let quietUntil = 0;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 注册一块可自动滚动的选区范围：el＝选区所在的根，opts.scroller()＝要滚的那个滚动容器。返回注销函数。
export function edgeAutoScroll(el, opts = {}) {
  if (!el || !opts.scroller) return () => {};
  install();
  const r = { el, scroller: opts.scroller };
  roots.add(r);
  return () => { roots.delete(r); if (run?.root === r) stop(); };
}

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('selectionchange', onSel);
  onNativeDragEnd(() => { stop(); quietUntil = performance.now() + 500; });   // 松手即停；随后的收尾纠正别再起滚
  window.addEventListener('pointerdown', stop, { capture: true, passive: true });
}

function onSel() {
  const now = performance.now();
  const gap = now - lastEvt;
  lastEvt = now;
  if (run) { run.lastSel = now; return; }          // 已在滚：每帧自己重算速度
  // 起滚要有「正在拖」的证据：连着两发选区变化（孤立的一发可能是松手后的纠正、CM 重写选区），
  // 且不是系统全选（活动端在文末，会被当成拉满直接滚到底）、不是刚点完格式条之类的页面操作。
  if (gap > GAP || now < quietUntil || recentSelectAll() || !browserDrivenSelection()) return;
  const t = measure();
  if (t && t.v) start(t);
}

const hasBox = (b) => b && (b.top || b.bottom || b.left || b.height);

// 活动端所在那一行的矩形。编辑器（CM）的 DOM 选区端点常落在元素边界上（行元素 + 子节点下标），
// 折叠 Range 在那里量不出矩形——退而量下标前后那个子节点。
function caretRect(node, off) {
  try {
    const r = document.createRange();
    r.setStart(node, off);
    r.collapse(true);
    const b = r.getClientRects()[0] || r.getBoundingClientRect();
    if (hasBox(b)) return b;
    if (node.nodeType === 1) {
      for (const c of [node.childNodes[off - 1], node.childNodes[off]]) {
        if (!c) continue;
        let cb;
        if (c.nodeType === 3) { const cr = document.createRange(); cr.selectNodeContents(c); const rs = cr.getClientRects(); cb = rs[c === node.childNodes[off - 1] ? rs.length - 1 : 0]; }
        else if (c.nodeType === 1) cb = c.getBoundingClientRect();
        if (hasBox(cb)) return cb;
      }
      const nb = node.getBoundingClientRect();
      if (hasBox(nb) && nb.height < 200) return nb;   // 整行元素本身（别拿整篇容器当落点）
    }
  } catch {}
  return null;
}

function forward(sel) {
  if (sel.direction === 'forward') return true;
  if (sel.direction === 'backward') return false;
  try {
    const r = document.createRange();
    r.setStart(sel.anchorNode, sel.anchorOffset);
    return r.comparePoint(sel.focusNode, sel.focusOffset) >= 0;
  } catch { return true; }
}

// 按当前选区算目标速度：只看「往哪边选」的那条边——往下选只认底边、往上选只认顶边，
// 抓起停在顶部附近的结束柄往下拖时不会先往上窜。
function measure() {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !lastPointerTouch() || fingerOnPage()) return null;
  let root = null;
  for (const r of roots) if (r.el.isConnected && r.el.contains(sel.anchorNode)) { root = r; break; }
  const sc = root?.scroller?.();
  if (!sc) return null;
  const fwd = forward(sel);
  const s = sc.getBoundingClientRect();
  const vv = window.visualViewport;
  const top = Math.max(s.top, vv ? vv.offsetTop : 0);
  const bottom = Math.min(s.bottom, vv ? vv.offsetTop + vv.height : innerHeight);   // 键盘弹起时是键盘上沿
  let depth;
  if (!root.el.contains(sel.focusNode)) depth = 1;   // 活动端已被拖出根（压到了界外的界面上）：按拉满算
  else {
    const b = caretRect(sel.focusNode, sel.focusOffset);
    if (!b) return null;
    depth = fwd ? (b.bottom - (bottom - ZONE)) / (ZONE - GRAB) : (top + ZONE - b.top) / (ZONE - GRAB);
  }
  return { root, sc, v: (fwd ? 1 : -1) * VMAX * clamp(depth, 0, 1) };
}

function start(t) {
  const now = performance.now();
  run = { root: t.root, sc: t.sc, v: 0, pos: t.sc.scrollTop, last: now, lastSel: now, raf: 0, want: t.v, wantAt: now };
  run.raf = requestAnimationFrame(tick);
}

function tick(now) {
  const r = run;
  if (!r) return;
  const dt = clamp(now - r.last, 0, 64);
  r.last = now;
  const t = measure();
  let want = t && t.sc === r.sc ? t.v : 0;
  if (t) { r.want = want; r.wantAt = now; }
  else if (r.want && now - r.wantAt < 150) want = r.want;   // 偶尔一帧量不出落点（端点正落在重排中的节点上）：沿用上一帧，别急刹
  r.v += (want - r.v) * (1 - Math.exp(-dt / TAU));
  if ((!want && Math.abs(r.v) < 12) || now - r.lastSel > 2500 || !r.sc.isConnected) { stop(); return; }
  if (Math.abs(r.sc.scrollTop - r.pos) > 2) r.pos = r.sc.scrollTop;   // 滚动被别处动过：从现值接着滚
  const max = r.sc.scrollHeight - r.sc.clientHeight;
  r.pos = clamp(r.pos + r.v * dt / 1000, 0, Math.max(0, max));
  r.sc.scrollTop = r.pos;
  if ((r.pos <= 0 && r.v < 0) || (r.pos >= max && r.v > 0)) { stop(); return; }
  r.raf = requestAnimationFrame(tick);
}

function stop() {
  if (run) cancelAnimationFrame(run.raf);
  run = null;
}
