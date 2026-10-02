// touchSelection.js —— 触屏长选区护栏（md 阅读态按 DOM 位置拦；编辑器的状态层版本在
// mdeditor/touchGuard.js，共用这里的指针状态与门控）。
//
// 病根（2026-09-29 用 adb + WebView 调试口在真机上坐实）：安卓拖选择柄时，每一次「起拖」
// 浏览器都会按【另一个柄】的屏幕坐标重新命中一遍选区的固定端（Chromium
// TouchSelectionController 起拖时 SelectBetweenCoordinates(base, extent)）。选长段话时固定端
// 早已滚出滚动区——被标题栏盖着、或干脆在屏幕外——命中打在 user-select:none 的外壳上，
// Blink 再把它规整到整个文档里【最近的可选位置】：全屏阅读时是笔记第一行，Claude 工作台里
// 是左侧聊天的第一条消息。于是松手再拖一次，选区就「溢出到全文」（聊天整片变蓝），往上拖
// 起点柄时结束端同样会被甩到文首。拖柄期间页面收不到任何 touch/pointer 事件，只能在
// selectionchange 里认出这一帧，把固定端改回去。
//
// 规则只对「触屏 + 手指没按在页面上」的选区变化生效（= 浏览器自己在拖柄 / 系统浮条操作），
// 且只管旧选区起点落在受护根里的情况；鼠标、键盘、点按、长按起选一律原样放行：
//   ① 固定端跳变：新 anchor 不是旧选区的任一端，而新 focus 还停在旧的某一端（起拖那一帧的
//      特征）→ anchor 改回旧的另一端；focus 也挪了一点时，anchor 跳出了根、或隔了 40 字以上，同样认。
//   ② 系统「全选」（先派发 selectstart）：选区盖出了根 → 收成根内全文，不连带聊天/界面。
//   ③ 活动端出界：拖着的一端跑出了根（分栏时拖到左侧聊天上）或落在滚动区可视范围之外
//      （拖到标题栏上被规整到文首/文末）→ 这一步不认，停在上一个合法位置。
// 复制后系统会把选区塌成结束端的光标——塌缩一律放行，不做「恢复」。

const QUIET_MS = 700;   // 长按/点按抬手后的静默期：系统「智能选择」会异步扩选（两端都可能动），别当跳变
const FAR_CHARS = 40;   // focus 也动了时，anchor 至少跳这么远才认作误命中
const EDGE = 48;        // 活动端落在滚动区可视范围外多少像素才算「出界」（容忍半行被裁）

const ptr = { down: false, type: '', downAt: 0, upAt: 0 };
const roots = new Set();
let installed = false;
let selectStartAt = 0;
let prev = null;

// 最近一次指针是不是手指/笔（没有指针记录时按设备主指针猜）
export function lastPointerTouch() {
  if (ptr.type) return ptr.type === 'touch' || ptr.type === 'pen';
  try { return matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

// 手指此刻按在页面上吗——拖选择柄时柄由浏览器接管，页面收不到 pointerdown，此时为 false
export function fingerOnPage() {
  install();
  return ptr.down && performance.now() - ptr.downAt < 15000;
}

// 此刻的选区变化是不是「浏览器自己在动」（触屏、手指没按在页面上、已过长按后的静默期）——
// 编辑器（CodeMirror 按文档位置记选区、DOM 会随虚拟视口重建）在状态层套同一套规则时用它门控。
export function browserDrivenSelection() {
  return lastPointerTouch() && !fingerOnPage() && performance.now() - ptr.upAt > QUIET_MS;
}

// 刚发生过「全选」吗（系统浮条/快捷键的全选会先派发 selectstart；拖柄不会）——全选两端都变，别当跳变拦。
export function recentSelectAll() {
  install();
  return performance.now() - selectStartAt < 400;
}

// 注册一个受护根。opts.scroller()：它的滚动容器（判「落在可视范围外」）；
// opts.allEl()：系统全选时收成哪一块（默认根本身）。返回注销函数。
export function guardSelection(el, opts = {}) {
  if (!el) return () => {};
  install();
  const r = { el, scroller: opts.scroller || null, allEl: opts.allEl || null };
  roots.add(r);
  el.setAttribute('data-ts-root', '');
  return () => {
    roots.delete(r);
    el.removeAttribute('data-ts-root');
    if (prev && el.contains(prev.an)) { prev = null; setLock(false); }
  };
}

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const down = (e) => { ptr.down = true; ptr.type = e.pointerType || ptr.type; ptr.downAt = performance.now(); };
  const up = () => { ptr.down = false; ptr.upAt = performance.now(); };
  window.addEventListener('pointerdown', down, { capture: true, passive: true });
  window.addEventListener('pointerup', up, { capture: true, passive: true });
  window.addEventListener('pointercancel', up, { capture: true, passive: true });
  document.addEventListener('selectstart', () => { selectStartAt = performance.now(); }, true);
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('contextmenu', (e) => {
    if (e.button !== -1) return;   // 只认拖柄松手时浏览器补发的那一发
    applyPending();
    for (const fn of dragEndHooks) { try { fn(); } catch {} }
  }, true);
  window.addEventListener('pointerdown', (e) => { if (!(e.target instanceof Node) || !rootOf(e.target)) setLock(false); }, { capture: true, passive: true });
  const st = document.createElement('style');
  st.textContent = 'html.ts-lock ::selection{background-color:transparent!important}' +
    'html.ts-lock [data-ts-root] ::selection{background-color:var(--ts-sel,rgba(120,120,120,.3))!important}' +
    'html.ts-lock body *{-webkit-user-select:text!important;user-select:text!important}';
  document.head.appendChild(st);
}

function rootOf(node) {
  for (const r of roots) if (r.el.isConnected && r.el.contains(node)) return r;
  return null;
}

const same = (n1, o1, n2, o2) => n1 === n2 && o1 === o2;

// 两个 DOM 位置之间隔了多少字（出错按无穷远）
function charsBetween(n1, o1, n2, o2) {
  try {
    const r = document.createRange();
    r.setStart(n1, o1);
    if (r.comparePoint(n2, o2) < 0) { r.setStart(n2, o2); r.setEnd(n1, o1); }
    else r.setEnd(n2, o2);
    return r.toString().length;
  } catch { return Infinity; }
}

function caretRect(node, off) {
  try {
    const r = document.createRange();
    r.setStart(node, off);
    r.collapse(true);
    const b = r.getClientRects()[0] || r.getBoundingClientRect();
    if (b && (b.top || b.bottom || b.left)) return b;
  } catch {}
  const el = node.nodeType === 1 ? node : node.parentElement;
  return el ? el.getBoundingClientRect() : null;
}

function offscreen(node, off, root) {
  const sc = root.scroller?.();
  if (!sc) return false;
  const b = caretRect(node, off);
  if (!b) return false;
  const s = sc.getBoundingClientRect();
  const vv = window.visualViewport;
  const top = Math.max(s.top, vv ? vv.offsetTop : 0);
  const bottom = Math.min(s.bottom, vv ? vv.offsetTop + vv.height : innerHeight);
  return b.bottom < top - EDGE || b.top > bottom + EDGE;
}

// 纠正要「晚一拍」：脚本改的选区 Blink 一律标成「不显示选择柄」，这个状态只要赶在浏览器下一步
// 推进拖动之前被画进一帧，浏览器那头正拖着的柄就被收掉、拖动当场结束。实测起拖那一帧同步改，
// 5 次断 2~4 次；手指按着柄不动时定时去改，3/3 断。所以：发现后只挂一笔，等浏览器自己再推进
// FIX_AFTER_MOVES 步（说明手指在动、后面还有推进），再等这一帧画完才改——下一次推进大概率赶在
// 下一帧之前把柄重新点亮（真机 8/8 + 8/8 不断）。没推进就松手了，就在松手时浏览器补发的那个
// contextmenu（button=-1，用来弹系统浮条）里改。生效时读「当时」的活动端，不会把手指拽回去。
const FIX_AFTER_MOVES = 2;
let pending = null;   // { kind:'anchor'|'focus', n, o, root, moves, queued }
const dragEndHooks = new Set();

// 等当前这一帧画完再执行（rAF 在帧首，里面再抛一个 task 就落在这一帧之后）
export function afterFrame(fn) {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

function schedule(kind, n, o, root) {
  if (!pending) pending = { kind, n, o, root, moves: 0, queued: false };
}
function applyPending() {
  const pd = pending;
  pending = null;
  if (!pd) return;
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !pd.n.isConnected) return;
  try {
    if (pd.kind === 'anchor') {
      if (!same(sel.anchorNode, sel.anchorOffset, pd.n, pd.o)) sel.setBaseAndExtent(pd.n, pd.o, sel.focusNode, sel.focusOffset);
    } else if (!pd.root.el.contains(sel.focusNode) || offscreen(sel.focusNode, sel.focusOffset, pd.root)) {
      sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, pd.n, pd.o);   // 活动端仍在界外：停回上一个合法位置
    }
  } catch {}
}

// 拖柄松手（浏览器补发 button=-1 的 contextmenu）时的回调——编辑器的状态层护栏也在这里收尾
export function onNativeDragEnd(fn) {
  install();
  dragEndHooks.add(fn);
  return () => dragEndHooks.delete(fn);
}

// 受护根里有触屏选区时上「锁」（html.ts-lock，样式见 install）：
//   · 根以外的选中高亮一律透明——纠正生效前那几帧选区可能已伸进左侧聊天，整片变蓝的那一闪没了；
//   · 根以外的界面临时一律可选中——固定端的柄压在工具栏按钮、标题栏这类不可选中的字上时，Blink
//     会把它规整成「空位置」，起点一空选区当场塌成光标（工作台里「选着选着突然取消」的真身，
//     正式版实测 2/2 必现）；可选中后命中就落在按钮字上，由规则①改回原起点，3/3 不再塌。
// 手指一按到根外（去点别的、长按拖文件）立刻解锁，不影响那边原本的交互。
function setLock(on) {
  const el = document.documentElement;
  if (el.classList.contains('ts-lock') !== on) el.classList.toggle('ts-lock', on);
}

function onSelectionChange() {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) { prev = null; setLock(false); return; }
  const cur = { an: sel.anchorNode, ao: sel.anchorOffset, fn: sel.focusNode, fo: sel.focusOffset };
  const p = prev;
  const root = p && p.an.isConnected && p.fn.isConnected ? rootOf(p.an) : null;
  if (!root || !browserDrivenSelection()) {
    prev = cur;
    pending = null;
    setLock(!!rootOf(cur.an) && lastPointerTouch());
    return;
  }
  if (pending) {   // 已挂着一笔纠正：只数浏览器又推进了几步，够了就当场改
    if (++pending.moves >= FIX_AFTER_MOVES && !pending.queued) { pending.queued = true; afterFrame(applyPending); }
    return;
  }

  // ② 系统「全选」：只收回根内
  if (recentSelectAll()) {
    const all = root.allEl?.() || root.el;
    if (!root.el.contains(cur.an) || !root.el.contains(cur.fn)) { try { sel.selectAllChildren(all); } catch {} return; }
    prev = cur;
    return;
  }

  // ① 固定端跳变（起拖时按屏外坐标重新命中的那一帧）
  if (!same(cur.an, cur.ao, p.an, p.ao) && !same(cur.an, cur.ao, p.fn, p.fo)) {
    let fixed = null;
    if (same(cur.fn, cur.fo, p.fn, p.fo)) fixed = [p.an, p.ao];
    else if (same(cur.fn, cur.fo, p.an, p.ao)) fixed = [p.fn, p.fo];
    else if (!root.el.contains(cur.an) ||
             Math.min(charsBetween(cur.an, cur.ao, p.an, p.ao), charsBetween(cur.an, cur.ao, p.fn, p.fo)) > FAR_CHARS) {
      // 拖着的那端离新 focus 近，另一端就是被误命中的固定端
      fixed = charsBetween(cur.fn, cur.fo, p.an, p.ao) > charsBetween(cur.fn, cur.fo, p.fn, p.fo) ? [p.an, p.ao] : [p.fn, p.fo];
    }
    if (fixed) { schedule('anchor', fixed[0], fixed[1], root); return; }   // 改完会再来一发 selectionchange，届时记账
  }

  // ③ 活动端出界：停在上一个合法位置（固定端必须还是旧选区的一端，才知道哪端在动）
  const keepA = same(cur.an, cur.ao, p.an, p.ao), swapped = same(cur.an, cur.ao, p.fn, p.fo);
  if ((keepA || swapped) && (!root.el.contains(cur.fn) || offscreen(cur.fn, cur.fo, root))) {
    const back = keepA ? [p.fn, p.fo] : [p.an, p.ao];
    schedule('focus', back[0], back[1], root);
    return;
  }
  prev = cur;
}
