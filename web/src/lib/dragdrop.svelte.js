// 全域「拿起 — 放下」（iOS / macOS 同款手感），2026-09-01 重做。
//
// 长按把一份东西从页面里拎出来，它就脱离原来的列表、浮在最上层跟着这根手指走；另一根手指
// 照常翻页、进目录、切会话，松手时落在哪儿就交给哪儿处理——移动到那个文件夹、或者挂进那个
// 对话的输入栏。整套机制由四件事组成：
//
//   ① 拖源 —— 长按 HOLD_MS 起拖（起拖前挪超过 MOVE_TOL 视为在滚列表，作罢）。
//      起拖后【不出长按菜单】：原地按住再松手才出（见 onStay）。
//   ② 落点 —— 任意组件把自己的 DOM 用 dropZone 注册成落点，松手时由命中的【最内层】落点接管；
//      落点可选 spring：拎着东西在它上面悬停一会儿，它就自己打开（iOS 的 spring-loaded folders），
//      单指也能一路钻进子目录。
//   ③ 幽灵 —— 全 app 唯一一层 fixed 浮层（DragLayer）画那份跟手的卡片，起拖从原位「抬起来」、
//      落地缩进落点、取消飞回原位。
//   ④ 另一根手指 —— 拖拽期间浏览器不再替我们做任何手势（见下），所以第二根手指的「滚列表」
//      「点一下」全由这里自己认：JS 驱动的滚动（带惯性）、位移够小就在抬起点补一发 click。
//
// ── 为什么必须由我们接管第二根手指（改这里之前先读）──
// 触摸滚动在 Chrome 里是【整场触摸序列】级别的手势：第一根手指还按着，第二根手指一动，浏览器
// 算的是两根手指的质心位移、目标是第一根手指按下时那个元素——而且一旦这个手势真的开始滚，
// 它会给【所有】触摸指针补 pointercancel，拎着的那份当场掉地（v4.67 上机「多点触控没实现」
// 的真因）。原生那条路怎么绕都绕不到「一根手指拎着、另一根正常滚」，所以：
//   · 拖拽全程 html.dnd-live { touch-action:none }（app.css）+ 拦掉每一发可取消的 touchmove：
//     浏览器彻底不做手势，也就不会有 pointercancel 和质心滚动；
//   · 第二根手指的滚动由 auxMove 自己算：按下时锁定手指底下最近的可滚容器（原生同款 latch），
//     跟手位移 + 松手惯性（指数衰减），横竖两轴都认；
//   · 多指下浏览器根本不合成 click（tap 识别只认单指），所以点按也自己补。
//
// ── 拖源被卸载之后拖拽为什么还活着 ──
// 场景「按住文件 → 另一根手指收起工作台/退回主页 → 进 Claude 松手」里，拖源那棵子树中途就
// 被 Svelte 摘掉了。触摸事件规范明说：目标被移除后，事件仍投递给它、只是不再冒泡到 document。
// 所以起拖时把 pointer/touch 两套监听【直接挂在拖源元素上】（它作为 JS 对象一直被 rec 引用着），
// 与 window 上的那套双保险；抬起点靠事件自带的 clientX/Y，不依赖任何 DOM 还在不在。
// 触摸指针的隐式捕获也必须松掉（releasePointerCapture），否则源元素一卸载浏览器就补 pointercancel。
//
// 实测（无头 Edge 真实触摸仿真，2026-09-01）拖源卸载之后 Chrome 的行为：拎着的那根手指再一动，
// 它的 pointer 事件被换成一个【新的 pointerId】重新命中、并立刻 pointercancel；从此这场触摸序列
// 【不再派发任何 pointer 事件】——第二根手指连 pointerdown 都没有；而触摸事件自始至终正常投递
// （拖拽那根到被卸载的源元素上、其它手指到各自的目标上）。所以：拖拽那根手指以触摸事件为准、
// pointer 事件只当锦上添花；另一根手指的滚动/点按【只认触摸事件】，按 identifier 区分。
//
// ── 命中判定 ──
// 走 document.elementFromPoint + 向上找注册节点，不自己维护矩形表——天然吃 z-index、遮挡与
// transform 容器；幽灵自身 pointer-events:none 所以不会挡住自己。手指不动时页面照样会变
// （另一根手指翻页了），所以每 REHIT_MS 主动重算一次落点。

export const HOLD_MS = 420;      // 长按起拖门槛
export const MOVE_TOL = 7;       // 起拖【前】的抖动容忍：必须小于 Chrome 的 touch slop（8px）——
                                 // 超过 slop 浏览器就把这根手指判给滚动了，之后再拦都拦不住
const DROP_TOL = 10;             // 起拖【后】判「有没有真的挪过」（没挪过＝原地松手出菜单）
const EDGE = 56;                 // 拖着接近列表上下缘时自动滚动的感应带
const EDGE_MAX = 18;             // 自动滚动每帧最大位移
const TAP_SLOP = 16;             // 「另一根手指点一下」的位移容忍
const TAP_MS = 3000;             // 时长上限只用来挡「搭着不动的手掌」，不该拿它判「算不算点」
const PAN_SLOP = 7;              // 另一根手指挪过这个距离就算在滚（与原生 slop 同量级）
const SPRING_MS = 650;           // 悬停多久打开文件夹
const REHIT_MS = 100;            // 手指不动时重算落点的周期
const DROP_ANIM = 240;           // 落地收缩动画
const CANCEL_ANIM = 220;         // 取消飞回动画
const FLING_DECAY = 0.9975;      // 惯性每毫秒衰减（≈ iOS 的 decelerationRate.normal）
const MAX_V = 4.5;               // 惯性起速上限 px/ms
const TOUCH_MATCH = 30;          // 起拖点与 touchstart 点最多差这么多像素就认作同一根手指

// 幽灵与落点高亮读的视图状态（只放展示用字段，能力回调在 rec 里，别塞进 $state 被深代理）。
export const drag = $state({
  on: false,
  phase: '',        // '' 拖着 | 'drop' 落进落点 | 'cancel' 飞回原位
  name: '',
  isDir: false,
  iconHtml: '',
  thumb: '',
  count: 1,
  x: 0,
  y: 0,
  ox: 0,            // 起拖那一刻「原位中心 − 手指」的偏移：幽灵从原位抬起来
  oy: 0,
  moved: false,
  overKey: '',      // 命中落点的 key（落点自己比对它决定要不要亮）
  overLabel: '',    // 幽灵下方那行提示（「移到 xxx」「挂进这个对话」…）
  effect: '',       // move | copy | send —— 幽灵角标
  springKey: '',    // 正在倒计时准备自动打开的落点（文件夹格子据此播脉冲）
  springMs: SPRING_MS,
});

let rec = null;                 // 本场拖拽（见 beginDrag）
const zones = new Map();        // node -> { node, opts }
const aux = new Map();          // pointerId -> 另一根手指的记录
const flings = new Map();       // 滚动容器 -> 惯性动画
const liveTouches = new Map();  // identifier -> { x, y, t }（常驻登记，起拖时据此认出拖拽那根手指）
let rehitTimer = 0;
let animTimer = 0;
let lastZoneHaptic = 0;

export const isDragging = () => !!rec;
export const dragPayload = () => rec?.payload || null;

// —— 触觉：navigator.vibrate（不支持的浏览器静默）——
export function haptic(kind) {
  try { navigator.vibrate?.(kind === 'heavy' ? 18 : kind === 'tick' ? 6 : 10); } catch {}
}

// 落地反馈条：拖拽的结局常常发生在【拖源已经不在场】的页面上，所以提示必须由这套机制自己端出来。
export const dndToast = $state({ msg: '' });
let toastTimer = null;
export function dropToast(msg) {
  dndToast.msg = String(msg || '');
  clearTimeout(toastTimer);
  if (dndToast.msg) toastTimer = setTimeout(() => { dndToast.msg = ''; }, 2400);
}

// —— 常驻登记每一根手指的落点：起拖时用它把 pointerId 换算成 touch identifier ——
// 指针事件给 pointerId、触摸事件给 identifier，两者不通用；但同一根手指的 pointerdown 与
// touchstart 坐标完全一致，按最近的那个认即可（远比第一发 touchmove 再去猜可靠）。
if (typeof document !== 'undefined') {
  document.addEventListener('touchstart', (e) => {
    // e.touches 是此刻屏幕上【所有】手指——顺手把早已抬起却没收到 touchend（目标被卸载）的陈账清掉
    const live = new Set();
    for (const t of e.touches || []) live.add(t.identifier);
    for (const id of [...liveTouches.keys()]) if (!live.has(id)) liveTouches.delete(id);
    for (const t of e.changedTouches || []) liveTouches.set(t.identifier, { x: t.clientX, y: t.clientY, t: e.timeStamp });
  }, { capture: true, passive: true });
  const gone = (e) => { for (const t of e.changedTouches || []) liveTouches.delete(t.identifier); };
  document.addEventListener('touchend', gone, { capture: true, passive: true });
  document.addEventListener('touchcancel', gone, { capture: true, passive: true });
}
function nearestTouch(x, y) {
  let best = null, bestD = TOUCH_MATCH;
  for (const [id, p] of liveTouches) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}
const findTouch = (list, id) => { for (const t of list || []) if (t.identifier === id) return t; return null; };

// —— 滚动守卫：拖源所在的滚动容器必须【常驻】挂一个 passive:false 的 touchmove ——
// Chrome 在 touchstart 那一刻就按「这片区域有没有阻塞型 touchmove 监听」决定要不要把滚动交给
// 合成器线程；起拖时（420ms 后）才 addEventListener 已经太晚——之后的 touchmove 是
// non-cancelable，preventDefault 完全无效。所以常驻注册、内部按「有没有在拖」短路。
//   <div class="scroll" use:dragScrollGuard> … </div>
export function dragScrollGuard(node) {
  node.addEventListener('touchmove', blockTouch, { passive: false });
  return { destroy() { node.removeEventListener('touchmove', blockTouch); } };
}
// 拖拽期间【每一发】可取消的 touchmove 都拦下：滚动全由我们自己做（见文件头），浏览器不许插手。
function blockTouch(e) {
  if (rec && e.cancelable) e.preventDefault();
}

// —— 落点：Svelte action ——
//   <div use:dropZone={{ key, label, effect, accept, drop, spring, disabled }}>
//   accept(payload) 返回 false 时本层不接，继续往父级找（所以「文件夹拖到自己身上」会自然
//   落到外层的「当前目录」落点上，而不是死在这一层）。
//   spring(payload)：拎着东西在本落点上悬停 SPRING_MS 就调用它（打开这个文件夹/退到那一级）。
export function dropZone(node, opts = {}) {
  const entry = { node, opts };
  zones.set(node, entry);
  return {
    update(next) { entry.opts = next || {}; },
    destroy() { zones.delete(node); },
  };
}

function zoneAt(x, y) {
  if (!rec) return null;
  let el = null;
  try { el = document.elementFromPoint(x, y); } catch { return null; }
  for (let n = el; n; n = n.parentElement) {
    const e = zones.get(n);
    if (!e) continue;
    const o = e.opts || {};
    if (o.disabled) continue;
    if (o.accept && !o.accept(rec.payload)) continue;
    return e;
  }
  return null;
}

const labelOf = (o) => (typeof o.label === 'function' ? o.label(rec?.payload) : o.label) || '';

// —— 起拖 ——
// payload：来源自定义的数据 + 能力回调（见 files 侧的 wsFilePayload）。
// opts.onStay：原地按住又松手时回调（拖源用它补回长按菜单）。
// opts.ghost：{ name, isDir, iconHtml, thumb } 幽灵长什么样。
export function beginDrag(payload, { x, y, pointerId = -1, pointerType = 'touch', sourceEl = null, onStay = null, ghost = {} } = {}) {
  if (rec) return false;
  endAnim();
  const touchId = pointerType === 'mouse' ? null : nearestTouch(x, y);
  rec = {
    payload, pointerId, touchId, sourceEl, onStay,
    x0: x, y0: y, x, y, moved: false, done: false,
    mode: 'pointer',                 // pointer | touch（拖拽指针被 pointercancel 之后改听触摸事件）
    hover: { key: '', since: 0, fired: false },
    lastTouchEvt: null,
  };
  // 触摸指针的隐式捕获必须松掉：否则源元素一被卸载，浏览器补 pointercancel 打断整场拖拽。
  try { if (pointerId >= 0 && sourceEl?.hasPointerCapture?.(pointerId)) sourceEl.releasePointerCapture(pointerId); } catch {}
  let ox = 0, oy = 0;
  try {
    const r = sourceEl?.getBoundingClientRect?.();
    if (r && r.width && r.height) { ox = r.left + r.width / 2 - x; oy = r.top + r.height / 2 - y; }
  } catch {}
  Object.assign(drag, {
    on: true, phase: '',
    name: ghost.name ?? payload.name ?? '',
    isDir: ghost.isDir ?? !!payload.isDir,
    iconHtml: ghost.iconHtml || '',
    thumb: ghost.thumb || '',
    count: payload.count || 1,
    x, y, ox, oy, moved: false, overKey: '', overLabel: '', effect: '', springKey: '',
  });
  haptic('heavy');

  window.addEventListener('pointermove', onPtrMove, { capture: true, passive: false });
  window.addEventListener('pointerup', onPtrUp, true);
  window.addEventListener('pointercancel', onPtrCancel, true);
  document.addEventListener('touchstart', onTouchStart, true);
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  document.addEventListener('touchend', onTouchEnd, true);
  document.addEventListener('touchcancel', onTouchCancel, true);
  if (sourceEl) {
    // 目标被卸载后事件仍投递到它、只是不再冒泡——直接挂在它身上就还听得见（见文件头）。
    sourceEl.addEventListener('pointermove', onPtrMove, { passive: false });
    sourceEl.addEventListener('pointerup', onPtrUp);
    sourceEl.addEventListener('pointercancel', onPtrCancel);
    sourceEl.addEventListener('touchmove', onTouchMove, { passive: true });
    sourceEl.addEventListener('touchend', onTouchEnd);
    sourceEl.addEventListener('touchcancel', onTouchCancel);
  }
  window.addEventListener('touchmove', blockTouch, { passive: false });
  window.addEventListener('contextmenu', blockCtxMenu, true);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVisibility);
  document.documentElement.classList.add('dnd-live');
  rehitTimer = setInterval(tick, REHIT_MS);
  return true;
}

// 拖拽进行中再拎一份进来（iOS 的「点其他文件加进叠放」）：payload 自己决定收不收。
export function addToDrag(item, ghost = {}) {
  if (!rec || !rec.payload?.add) return false;
  if (rec.payload.add(item) === false) return false;
  drag.count = rec.payload.count || drag.count + 1;
  // 叠放时幽灵的脸换成最新那份（iOS 同款：最后加入的在最上面）
  if (ghost.name) Object.assign(drag, { name: ghost.name, isDir: !!ghost.isDir, iconHtml: ghost.iconHtml || '', thumb: ghost.thumb || '' });
  haptic('tick');
  return true;
}

const isDragPtr = (e) => !!rec && (rec.pointerId < 0 || e.pointerId === rec.pointerId);

// 真机长按到 ~500ms 时浏览器还会自己补一发 contextmenu（安卓/iOS 的「长按菜单」事件）。
// 拎着东西的时候它必须被吞掉，否则页面上任何一个 oncontextmenu 都会在刚拎起来的那一份上盖菜单。
function blockCtxMenu(e) {
  if (!rec) return;
  e.preventDefault();
  e.stopPropagation();
}

function onKey(e) {
  if (e.key === 'Escape' && rec) { e.preventDefault(); e.stopPropagation(); cancelDrag(); }
}
function onVisibility() { if (document.hidden && rec) cancelDrag(); }

// —— 拖拽那根手指：pointer 事件（能来的时候）——
function onPtrMove(e) {
  if (!rec || !isDragPtr(e) || rec.mode !== 'pointer') return;
  if (e.cancelable) e.preventDefault();
  moveTo(e.clientX, e.clientY);
}
function onPtrUp(e) {
  if (!rec || !isDragPtr(e) || rec.mode !== 'pointer') return;
  release(e.clientX, e.clientY);
}
function onPtrCancel(e) {
  if (!rec || !isDragPtr(e)) return;
  // 指针被浏览器收走（多半是它以为自己在滚/缩放）：触摸事件还在继续投递，改听它们。
  if (rec.touchId != null) { rec.mode = 'touch'; return; }
  cancelDrag();
}

// —— 触摸事件：拖拽那根手指的主线 + 另一根手指的全部 ——
// 同一个事件可能从 document（捕获）和拖源元素各到一次，按事件对象去重。
function onTouchMove(e) {
  if (!rec || e === rec.lastTouchEvt) return;
  rec.lastTouchEvt = e;
  if (rec.touchId != null) {
    const t = findTouch(e.touches, rec.touchId);
    if (t) moveTo(t.clientX, t.clientY);      // 与指针事件同源同坐标，重复更新无害
  }
  for (const t of e.changedTouches || []) {
    const a = aux.get(t.identifier);
    if (a) auxMove(a, t.clientX, t.clientY, e.timeStamp);
  }
}
function onTouchEnd(e) {
  if (!rec) return;
  for (const t of e.changedTouches || []) {
    if (t.identifier === rec.touchId) { release(t.clientX, t.clientY); return; }   // 指针模式下 pointerup 先到已收场，这里自然空转
    const a = aux.get(t.identifier);
    if (a) { aux.delete(t.identifier); auxUp(a, t.clientX, t.clientY, e.timeStamp); }
  }
}
function onTouchCancel(e) {
  if (!rec) return;
  for (const t of e.changedTouches || []) {
    if (t.identifier === rec.touchId) { cancelDrag(); return; }
    aux.delete(t.identifier);
  }
}
// 新手指落下：① 对账——e.touches 是屏幕上全部手指，拖拽那根若已不在其中，说明它的抬起我们没收到
// （目标被卸载后 touchend 不冒泡；两套监听都没接住的极端情形），只能作废，不能让幽灵赖在屏上；
// ② 登记成「另一根手指」，之后它的滚动/点按全由我们认（见文件头）。
function onTouchStart(e) {
  if (!rec) return;
  if (rec.touchId != null && !findTouch(e.touches, rec.touchId)) { cancelDrag(); return; }
  for (const t of e.changedTouches || []) {
    if (t.identifier === rec.touchId) continue;
    aux.set(t.identifier, {
      x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, t0: e.timeStamp,
      px: t.clientX, py: t.clientY, target: t.target,
      samples: [[e.timeStamp, t.clientX, t.clientY]],
      panning: false, axis: '', el: null,
    });
    // 手指落在正在惯性滑动的列表上＝按住它停下（原生同款）
    for (const [el] of flings) if (t.target && el.contains(t.target)) stopFling(el);
  }
}

function moveTo(x, y) {
  if (!rec || rec.done) return;
  rec.x = x; rec.y = y;
  drag.x = x; drag.y = y;
  if (!rec.moved && Math.hypot(x - rec.x0, y - rec.y0) > DROP_TOL) { rec.moved = true; drag.moved = true; }
  updateHit(x, y);
  armAutoScroll(x, y);
}

// 落点判定 + 弹簧计时。手指不动时由 tick 周期性调用：页面会在手指底下变（另一根手指翻页、
// 弹簧刚打开了文件夹），命中结果必须跟着变。
function updateHit(x, y) {
  const now = performance.now();
  const hit = zoneAt(x, y);
  const key = hit ? (hit.opts.key || '') : '';
  if (key !== rec.hover.key) {
    rec.hover = { key, since: now, fired: false };
    drag.overKey = key;
    drag.overLabel = hit ? labelOf(hit.opts) : '';
    drag.effect = hit ? (hit.opts.effect || 'move') : '';
    drag.springKey = hit?.opts.spring && rec.moved ? key : '';
    if (key && now - lastZoneHaptic > 140) { lastZoneHaptic = now; haptic('tick'); }
    return;
  }
  // key 没变不等于落点没变：「当前目录」那个落点在手指底下换了目录（另一根手指翻页/弹簧打开了
  // 文件夹），key 仍是 ws-here，提示语却该跟着换
  if (hit) { const lb = labelOf(hit.opts); if (lb !== drag.overLabel) drag.overLabel = lb; }
  if (!hit?.opts.spring || rec.hover.fired || !rec.moved) return;
  if (!drag.springKey) drag.springKey = key;   // 起拖后第一次挪动才开始计时（原地按住不算悬停）
  if (now - rec.hover.since < SPRING_MS) return;
  rec.hover.fired = true;
  drag.springKey = '';
  haptic('click');
  try { hit.opts.spring(rec.payload); } catch {}
}

function tick() {
  if (!rec || rec.done) return;
  updateHit(rec.x, rec.y);
}

// —— 松手 ——
async function release(x, y) {
  if (!rec || rec.done) return;
  rec.done = true;
  const r = rec;
  const hit = r.moved ? zoneAt(x, y) : null;
  teardown();
  // 松手之后有些内核还会在落点补一发 click：「拖进某个文件夹」会顺带把它点开、「原地松手出菜单」
  // 会在菜单底下把文件打开。只吞落点附近、且只吞浏览器自己发的那一发（我们合成的 click 不算）。
  swallowClickNear(x, y);
  if (!r.moved) {
    endWith('cancel', r, null);
    r.onStay?.({ clientX: x, clientY: y });
    return;
  }
  if (!hit) { endWith('cancel', r, null); return; }
  haptic('click');
  endWith('drop', r, hit);
  try { await hit.opts.drop?.(r.payload, { x, y }); } catch {}
}

export function cancelDrag() {
  if (!rec) return;
  const r = rec;
  teardown();
  endWith('cancel', r, null);
}

// 收尾动画：落进落点＝缩进它的中心（大块落点就在原地缩掉）；取消＝飞回原位（原位还在的话）。
// 动画期间 drag.on 仍为 true（拖源保持淡出，直到幽灵真的回到它身上），rec 已清空。
function endWith(phase, r, hit) {
  let tx = r.x, ty = r.y;
  if (phase === 'drop' && hit) {
    try {
      const b = hit.node.getBoundingClientRect();
      if (b.width <= 280 && b.height <= 280) { tx = b.left + b.width / 2; ty = b.top + b.height / 2; }
    } catch {}
  } else if (phase === 'cancel' && r.sourceEl?.isConnected) {
    try {
      const b = r.sourceEl.getBoundingClientRect();
      if (b.width && b.height) { tx = b.left + b.width / 2; ty = b.top + b.height / 2; }
    } catch {}
  }
  drag.overKey = '';
  drag.overLabel = '';
  drag.springKey = '';
  drag.phase = phase;
  drag.x = tx;
  drag.y = ty;
  animTimer = setTimeout(() => { animTimer = 0; drag.on = false; drag.phase = ''; drag.count = 1; }, phase === 'drop' ? DROP_ANIM : CANCEL_ANIM);
}
function endAnim() {
  if (animTimer) { clearTimeout(animTimer); animTimer = 0; }
  drag.on = false;
  drag.phase = '';
}

function teardown() {
  const r = rec;
  rec = null;
  aux.clear();
  clearInterval(rehitTimer);
  rehitTimer = 0;
  stopAutoScroll();
  window.removeEventListener('pointermove', onPtrMove, true);
  window.removeEventListener('pointerup', onPtrUp, true);
  window.removeEventListener('pointercancel', onPtrCancel, true);
  document.removeEventListener('touchstart', onTouchStart, true);
  document.removeEventListener('touchmove', onTouchMove, true);
  document.removeEventListener('touchend', onTouchEnd, true);
  document.removeEventListener('touchcancel', onTouchCancel, true);
  if (r?.sourceEl) {
    const s = r.sourceEl;
    s.removeEventListener('pointermove', onPtrMove);
    s.removeEventListener('pointerup', onPtrUp);
    s.removeEventListener('pointercancel', onPtrCancel);
    s.removeEventListener('touchmove', onTouchMove);
    s.removeEventListener('touchend', onTouchEnd);
    s.removeEventListener('touchcancel', onTouchCancel);
  }
  window.removeEventListener('touchmove', blockTouch);
  window.removeEventListener('contextmenu', blockCtxMenu, true);
  window.removeEventListener('keydown', onKey, true);
  document.removeEventListener('visibilitychange', onVisibility);
  document.documentElement.classList.remove('dnd-live');
}

// —— 另一根手指：滚动与点按都自己认（见文件头）——
function auxMove(a, x, y, ts) {
  a.x = x; a.y = y;
  a.samples.push([ts, x, y]);
  if (a.samples.length > 10) a.samples.shift();
  if (!a.panning) {
    const dx = a.x - a.x0, dy = a.y - a.y0;
    if (Math.hypot(dx, dy) <= PAN_SLOP) return;
    a.panning = true;
    a.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    // 锁定手指底下第一个【此刻真能往这个方向滚】的容器；都滚到头了就锁最里层那个（不再向外传）
    a.el = findScroller(a.target, a.axis, a.axis === 'x' ? -dx : -dy);
    a.px = a.x; a.py = a.y;
    return;
  }
  const d = a.axis === 'x' ? a.x - a.px : a.y - a.py;
  a.px = a.x; a.py = a.y;
  if (a.el && d) scrollBy(a.el, a.axis, -d);
}
function auxUp(a, x, y, ts) {
  if (!a.panning) {
    if (Math.hypot(x - a.x0, y - a.y0) > TAP_SLOP) return;   // 那是在挪，不是点
    if (ts - a.t0 > TAP_MS) return;                          // 搭着不动的手掌
    synthTap(x, y);
    return;
  }
  if (!a.el) return;
  const v = velocityOf(a.samples, a.axis, ts);
  if (Math.abs(v) > 0.06) fling(a.el, a.axis, -Math.max(-MAX_V, Math.min(MAX_V, v)));
}

function synthTap(x, y) {
  let el = null;
  try { el = document.elementFromPoint(x, y); } catch { return; }
  if (!el) return;
  // 落到最近的「可点的东西」上：直接在叶子节点上派发也能冒泡到行，但落在按钮上更贴近真实点击。
  const target = el.closest('button, a, [role="button"], [role="link"], input, label, select, summary') || el;
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
  // 万一某些内核在多指下仍补了一发原生 click，把它吞掉，避免同一下点两次。
  swallowClickNear(x, y);
}
// 只吞浏览器自己发的（isTrusted）、落在这一点附近的一发 click；350ms 没等到就撤——
// 挂太久会连另一根手指的正常点击一起吃掉。
function swallowClickNear(x, y) {
  let done = false;
  const off = () => { if (done) return; done = true; window.removeEventListener('click', kill, true); };
  const kill = (ev) => {
    if (!ev.isTrusted) return;
    if (Math.hypot(ev.clientX - x, ev.clientY - y) > TAP_SLOP) return;
    ev.stopPropagation();
    ev.preventDefault();
    off();
  };
  window.addEventListener('click', kill, true);
  setTimeout(off, 350);
}

// —— JS 滚动：容器选择 / 位移 / 惯性 ——
const pos = (el, axis) => (axis === 'x' ? el.scrollLeft : el.scrollTop);
const maxPos = (el, axis) => (axis === 'x' ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight);
function scrollBy(el, axis, d) {
  if (axis === 'x') el.scrollLeft += d; else el.scrollTop += d;
}
function findScroller(from, axis, dir) {
  let fallback = null;
  for (let el = from; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    let ov = '';
    try { const cs = getComputedStyle(el); ov = axis === 'x' ? cs.overflowX : cs.overflowY; } catch { continue; }
    if (ov !== 'auto' && ov !== 'scroll' && ov !== 'overlay') continue;
    const max = maxPos(el, axis);
    if (max <= 1) continue;
    const cur = pos(el, axis);
    if ((dir < 0 && cur > 0.5) || (dir > 0 && cur < max - 0.5)) return el;
    if (!fallback) fallback = el;
  }
  return fallback;
}
function velocityOf(samples, axis, tNow) {
  const i = axis === 'x' ? 1 : 2;
  const last = samples[samples.length - 1];
  if (!last) return 0;
  // 取 ~90ms 前那一发做基准：太近的抖、太远的过时
  let base = samples[0];
  for (const s of samples) { if (tNow - s[0] <= 90) break; base = s; }
  const dt = last[0] - base[0];
  if (dt < 8 || tNow - last[0] > 80) return 0;      // 抬起前已停住＝不甩
  return (last[i] - base[i]) / dt;
}
function fling(el, axis, v) {
  stopFling(el);
  const f = { v, last: performance.now(), raf: 0 };
  flings.set(el, f);
  const step = (now) => {
    const dt = Math.min(48, Math.max(1, now - f.last));
    f.last = now;
    const before = pos(el, axis);
    scrollBy(el, axis, f.v * dt);
    f.v *= Math.pow(FLING_DECAY, dt);
    if (Math.abs(f.v) < 0.02 || pos(el, axis) === before) { flings.delete(el); return; }
    f.raf = requestAnimationFrame(step);
  };
  f.raf = requestAnimationFrame(step);
}
function stopFling(el) {
  const f = flings.get(el);
  if (!f) return;
  cancelAnimationFrame(f.raf);
  flings.delete(el);
}

// —— 边缘自动滚动（拖拽那根手指）——
// 拖到列表上下缘时让它自己滚，否则长列表里「把文件拖到看不见的那个文件夹」根本做不到。
let scrollEl = null, scrollVec = 0, scrollRaf = 0;

function scrollableAt(x, y) {
  let el = null;
  try { el = document.elementFromPoint(x, y); } catch { return null; }
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight - n.clientHeight <= 4) continue;
    const oy = getComputedStyle(n).overflowY;
    if (oy === 'auto' || oy === 'scroll') return n;
  }
  return null;
}

function armAutoScroll(x, y) {
  const el = scrollableAt(x, y);
  if (!el) { stopAutoScroll(); return; }
  const r = el.getBoundingClientRect();
  let v = 0;
  if (y < r.top + EDGE) v = -Math.ceil(((r.top + EDGE - y) / EDGE) * EDGE_MAX);
  else if (y > r.bottom - EDGE) v = Math.ceil(((y - (r.bottom - EDGE)) / EDGE) * EDGE_MAX);
  if (!v) { stopAutoScroll(); return; }
  scrollEl = el;
  scrollVec = v;
  if (!scrollRaf) scrollRaf = requestAnimationFrame(tickAutoScroll);
}

function tickAutoScroll() {
  scrollRaf = 0;
  if (!rec || !scrollEl || !scrollVec) return;
  scrollEl.scrollTop += scrollVec;
  scrollRaf = requestAnimationFrame(tickAutoScroll);
}

function stopAutoScroll() {
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
  scrollEl = null;
  scrollVec = 0;
}

// —— 拖源侧的长按计时器（各页面共用同一套门槛，手感才一致）——
// 用法：pointerdown 里 arm(e, fire)，pointermove 里 track(e)，pointerup/cancel 里 disarm()。
export function makeHold({ ms = HOLD_MS, tol = MOVE_TOL } = {}) {
  let timer = null, from = null;
  return {
    arm(e, fire) {
      this.disarm();
      from = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, pointerType: e.pointerType, el: e.currentTarget };
      timer = setTimeout(() => { timer = null; const f = from; from = null; if (f) fire(f); }, ms);
    },
    track(e) {
      if (!timer || !from || e.pointerId !== from.pointerId) return;
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > tol) this.disarm();
    },
    disarm() {
      if (timer) clearTimeout(timer);
      timer = null;
      from = null;
    },
    get armed() { return !!timer; },
  };
}
