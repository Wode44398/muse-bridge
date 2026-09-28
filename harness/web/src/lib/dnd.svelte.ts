// 侧栏的「拿起 — 放下」：长按（触屏）或按下拖动（鼠标）把一个会话 / 项目拎起来，跟着手指走，松手时交给落点——
// 项目块在侧栏里换位置、会话拖进正文区分屏、拖进输入框引用。
//
// 手感与坑照搬 bridge 的全局拖放（web/src/lib/dragdrop.svelte.js，那边的文件头写了每条的来龙去脉），这里只留 dimensio
// 用得上的一半：
//   · 触屏长按 HOLD_MS 起拖；起拖前挪超过 MOVE_TOL 视为在滚列表，作罢（MOVE_TOL 必须小于 Chrome 的 touch slop 8px）。
//     鼠标 / 笔按下后挪过 MOUSE_TOL 就起拖（桌面上没人长按）。
//   · 拖拽那根手指以触摸事件为准（按 identifier 认），pointer 事件只当锦上添花：浏览器一旦以为在滚，会给触摸指针补
//     pointercancel；拖源被卸载（手机上抽屉收起）之后 pointer 事件也不再来，触摸事件照样投递给它——所以起拖时把监听
//     直接挂在拖源元素上，与 window 上的那套双保险。
//   · 拖拽期间 html.hx-dnd-live { touch-action:none } + 拦掉每一发可取消的 touchmove；拖源所在的滚动容器要【常驻】一个
//     非 passive 的 touchmove 监听（dragScrollGuard）——Chrome 在 touchstart 那一刻就决定滚动归不归合成器，起拖时再挂
//     已经太晚。
//   · 真机长按到 ~500ms 浏览器会补一发 contextmenu：拖拽期间吞掉。松手后浏览器可能还在落点补一发 click：只吞落点附近的
//     那一发。Esc、页面隐藏 = 取消。
//   · 命中：document.elementFromPoint + 向上找注册过的落点（最内层、且 accept 的那个），天然吃遮挡与 transform；幽灵自己
//     pointer-events:none。手指不动时页面也会变（落点刚出现），所以每 REHIT_MS 主动重算一次。
// 没做的：第二根手指滚动 / 点按（拖拽期间整页不接别的手势）、悬停自动打开。

export interface DragPayload {
  kind: "session" | "project";
  id: string;
  title: string;
  // 会话：厂商（幽灵上的标）与所在工作区；项目：路径与是否置顶
  provider?: string;
  workspace?: string;
  path?: string;
  pinned?: boolean;
}

export interface DropPoint {
  x: number;
  y: number;
}

export interface DropTargetOpts {
  // 同一个 key 视为同一个落点（命中变化时提示与触觉跟着变）；可以随落点位置变（分屏的左 / 下 / 中）
  key: string | ((p: DragPayload, pt: DropPoint) => string);
  // pt：手指此刻的位置（落点可以按位置判断接不接，比如分屏里「已经在这一格」不接）
  accept?: (p: DragPayload, pt: DropPoint) => boolean;
  // 幽灵下方那行提示（「引用这个对话」「在右侧分屏打开」）
  label?: string | ((p: DragPayload, pt: DropPoint) => string);
  // 手指在落点上方移动（落点据此画插入线 / 高亮哪一半）；离开时 leave
  over?: (p: DragPayload, pt: DropPoint) => void;
  leave?: () => void;
  drop: (p: DragPayload, pt: DropPoint) => void | Promise<void>;
  disabled?: boolean;
}

export const HOLD_MS = 420;
export const MOVE_TOL = 7;
export const MOUSE_TOL = 5;
const DROP_TOL = 8; // 起拖之后挪过这么多才算真的在拖（原地按住又松手 = 没拖）
const EDGE = 48; // 贴近滚动容器上下缘时自动滚动的感应带
const EDGE_MAX = 16;
const REHIT_MS = 100;
const DROP_ANIM = 220;
const CANCEL_ANIM = 220;
const TOUCH_MATCH = 30;
const CLICK_SLOP = 16;

// 幽灵与落点高亮读的视图状态（只放展示用字段）
export const dnd = $state({
  on: false,
  phase: "" as "" | "drop" | "cancel",
  kind: "" as "" | DragPayload["kind"],
  id: "", // 拎着的是谁（落点据此判断接不接，比如输入框不引用对话自己）
  sourceKey: "", // 拖源自己的 key（拖源据此把自己淡掉）
  title: "",
  provider: "",
  x: 0,
  y: 0,
  ox: 0, // 起拖那一刻「原位中心 − 手指」：幽灵从原位抬起来
  oy: 0,
  moved: false,
  overKey: "",
  overLabel: "",
});

interface Rec {
  payload: DragPayload;
  sourceEl: HTMLElement | null;
  pointerId: number;
  touchId: number | null;
  mode: "pointer" | "touch";
  x0: number;
  y0: number;
  x: number;
  y: number;
  moved: boolean;
  done: boolean;
  hover: { entry: ZoneEntry | null; key: string };
  lastTouchEvt: TouchEvent | null;
}
interface ZoneEntry {
  node: HTMLElement;
  opts: DropTargetOpts;
}

let rec: Rec | null = null;
const zones = new Map<HTMLElement, ZoneEntry>();
const liveTouches = new Map<number, { x: number; y: number }>();
let rehitTimer = 0;
let animTimer = 0;

export const isDragging = (): boolean => rec !== null;

function haptic(kind: "light" | "medium" | "tick"): void {
  try {
    const store = (window as any).AndroidStore;
    if (store?.haptic) {
      store.haptic(kind === "medium" ? "heavy" : kind === "tick" ? "tick" : "click");
      return;
    }
  } catch {
    /* 旧壳 */
  }
  try {
    navigator.vibrate?.(kind === "medium" ? 14 : kind === "tick" ? 5 : 9);
  } catch {
    /* 不支持 */
  }
}

// —— 常驻登记每一根手指的落点：起拖时据此把 pointerId 换算成 touch identifier（两者不通用，坐标一致）——
if (typeof document !== "undefined") {
  document.addEventListener(
    "touchstart",
    (e) => {
      const live = new Set<number>();
      for (const t of Array.from(e.touches)) live.add(t.identifier);
      for (const id of [...liveTouches.keys()]) if (!live.has(id)) liveTouches.delete(id);
      for (const t of Array.from(e.changedTouches)) liveTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    },
    { capture: true, passive: true },
  );
  const gone = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) liveTouches.delete(t.identifier);
  };
  document.addEventListener("touchend", gone, { capture: true, passive: true });
  document.addEventListener("touchcancel", gone, { capture: true, passive: true });
}
function nearestTouch(x: number, y: number): number | null {
  let best: number | null = null;
  let bestD = TOUCH_MATCH;
  for (const [id, p] of liveTouches) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}
const findTouch = (list: TouchList, id: number): Touch | null => {
  for (const t of Array.from(list)) if (t.identifier === id) return t;
  return null;
};

// —— 滚动守卫：拖源所在的滚动容器常驻一个非 passive 的 touchmove（见文件头），不在拖时什么都不做 ——
function blockTouch(e: TouchEvent): void {
  if (rec && e.cancelable) e.preventDefault();
}
export function dragScrollGuard(node: HTMLElement) {
  node.addEventListener("touchmove", blockTouch, { passive: false });
  return {
    destroy() {
      node.removeEventListener("touchmove", blockTouch);
    },
  };
}

// —— 落点 ——
export function dropTarget(node: HTMLElement, opts: DropTargetOpts) {
  const entry: ZoneEntry = { node, opts };
  zones.set(node, entry);
  return {
    update(next: DropTargetOpts) {
      entry.opts = next;
    },
    destroy() {
      zones.delete(node);
      if (rec?.hover.entry === entry) {
        try {
          entry.opts.leave?.();
        } catch {
          /* ignore */
        }
        rec.hover = { entry: null, key: "" };
        dnd.overKey = "";
        dnd.overLabel = "";
      }
    },
  };
}

function zoneAt(x: number, y: number): ZoneEntry | null {
  if (!rec) return null;
  let el: Element | null = null;
  try {
    el = document.elementFromPoint(x, y);
  } catch {
    return null;
  }
  for (let n = el as HTMLElement | null; n; n = n.parentElement) {
    const e = zones.get(n);
    if (!e) continue;
    if (e.opts.disabled) continue;
    if (e.opts.accept && !e.opts.accept(rec.payload, { x, y })) continue;
    return e;
  }
  return null;
}

const keyOf = (e: ZoneEntry, p: DragPayload, pt: DropPoint) => (typeof e.opts.key === "function" ? e.opts.key(p, pt) : e.opts.key);
const labelOf = (e: ZoneEntry, p: DragPayload, pt: DropPoint) =>
  (typeof e.opts.label === "function" ? e.opts.label(p, pt) : e.opts.label) ?? "";

function updateHit(x: number, y: number): void {
  if (!rec) return;
  const pt = { x, y };
  const hit = rec.moved ? zoneAt(x, y) : null;
  if (hit !== rec.hover.entry) {
    try {
      rec.hover.entry?.opts.leave?.();
    } catch {
      /* ignore */
    }
  }
  if (!hit) {
    rec.hover = { entry: null, key: "" };
    dnd.overKey = "";
    dnd.overLabel = "";
    return;
  }
  try {
    hit.opts.over?.(rec.payload, pt);
  } catch {
    /* ignore */
  }
  const key = keyOf(hit, rec.payload, pt);
  if (key !== rec.hover.key) haptic("tick");
  rec.hover = { entry: hit, key };
  dnd.overKey = key;
  dnd.overLabel = labelOf(hit, rec.payload, pt);
}

// —— 起拖 ——
function beginDrag(
  payload: DragPayload,
  from: { x: number; y: number; pointerId: number; pointerType: string; sourceEl: HTMLElement | null; sourceKey: string },
): boolean {
  if (rec) return false;
  endAnim();
  const touchId = from.pointerType === "mouse" ? null : nearestTouch(from.x, from.y);
  rec = {
    payload,
    sourceEl: from.sourceEl,
    pointerId: from.pointerId,
    touchId,
    mode: "pointer",
    x0: from.x,
    y0: from.y,
    x: from.x,
    y: from.y,
    moved: from.pointerType === "mouse", // 鼠标是挪过阈值才起拖的
    done: false,
    hover: { entry: null, key: "" },
    lastTouchEvt: null,
  };
  // 鼠标按下到挪过阈值之间，浏览器可能已经开始选字了：拎起来时清掉（之后 html.hx-dnd-live 的 user-select:none 不让它再长）；
  // 按下时拖源里的按钮拿到了焦点，也还掉——不然拖完那一行一直挂着 :focus-within 的样子（删除钮露在外面）
  try {
    window.getSelection()?.removeAllRanges();
    const held = document.activeElement;
    if (held instanceof HTMLElement && from.sourceEl?.contains(held)) held.blur();
  } catch {
    /* ignore */
  }
  // 触摸指针的隐式捕获必须松掉：否则拖源一被卸载，浏览器补 pointercancel 打断整场拖拽
  try {
    if (from.pointerId >= 0 && from.sourceEl?.hasPointerCapture?.(from.pointerId)) from.sourceEl.releasePointerCapture(from.pointerId);
  } catch {
    /* ignore */
  }
  let ox = 0;
  let oy = 0;
  try {
    const r = from.sourceEl?.getBoundingClientRect();
    if (r && r.width && r.height) {
      ox = r.left + r.width / 2 - from.x;
      oy = r.top + r.height / 2 - from.y;
    }
  } catch {
    /* ignore */
  }
  Object.assign(dnd, {
    on: true,
    phase: "",
    kind: payload.kind,
    id: payload.id,
    sourceKey: from.sourceKey,
    title: payload.title,
    provider: payload.provider ?? "",
    x: from.x,
    y: from.y,
    ox,
    oy,
    moved: rec.moved,
    overKey: "",
    overLabel: "",
  });
  haptic("medium");
  window.addEventListener("pointermove", onPtrMove, { capture: true, passive: false });
  window.addEventListener("pointerup", onPtrUp, true);
  window.addEventListener("pointercancel", onPtrCancel, true);
  document.addEventListener("touchstart", onTouchStart, true);
  document.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
  document.addEventListener("touchend", onTouchEnd, true);
  document.addEventListener("touchcancel", onTouchCancel, true);
  const s = from.sourceEl;
  if (s) {
    s.addEventListener("pointermove", onPtrMove, { passive: false });
    s.addEventListener("pointerup", onPtrUp);
    s.addEventListener("pointercancel", onPtrCancel);
    s.addEventListener("touchmove", onTouchMove, { passive: true });
    s.addEventListener("touchend", onTouchEnd);
    s.addEventListener("touchcancel", onTouchCancel);
  }
  window.addEventListener("touchmove", blockTouch, { passive: false });
  window.addEventListener("contextmenu", blockCtxMenu, true);
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("visibilitychange", onVisibility);
  document.documentElement.classList.add("hx-dnd-live");
  rehitTimer = window.setInterval(() => rec && !rec.done && updateHit(rec.x, rec.y), REHIT_MS);
  if (rec.moved) updateHit(from.x, from.y);
  return true;
}

const isDragPtr = (e: PointerEvent) => !!rec && (rec.pointerId < 0 || e.pointerId === rec.pointerId);

function blockCtxMenu(e: Event): void {
  if (!rec) return;
  e.preventDefault();
  e.stopPropagation();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && rec) {
    e.preventDefault();
    e.stopPropagation();
    cancelDrag();
  }
}
function onVisibility(): void {
  if (document.hidden && rec) cancelDrag();
}

function onPtrMove(e: PointerEvent): void {
  if (!rec || !isDragPtr(e) || rec.mode !== "pointer") return;
  if (e.cancelable) e.preventDefault();
  moveTo(e.clientX, e.clientY);
}
function onPtrUp(e: PointerEvent): void {
  if (!rec || !isDragPtr(e) || rec.mode !== "pointer") return;
  void release(e.clientX, e.clientY);
}
function onPtrCancel(e: PointerEvent): void {
  if (!rec || !isDragPtr(e)) return;
  // 指针被浏览器收走（它以为在滚）：触摸事件还在继续投递，改听它们
  if (rec.touchId != null) {
    rec.mode = "touch";
    return;
  }
  cancelDrag();
}
function onTouchMove(e: TouchEvent): void {
  if (!rec || e === rec.lastTouchEvt || rec.touchId == null) return;
  rec.lastTouchEvt = e;
  const t = findTouch(e.touches, rec.touchId);
  if (t) moveTo(t.clientX, t.clientY);
}
function onTouchEnd(e: TouchEvent): void {
  if (!rec || rec.touchId == null) return;
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier === rec.touchId) {
      void release(t.clientX, t.clientY); // 指针模式下 pointerup 先到已收场，这里自然空转
      return;
    }
  }
}
function onTouchCancel(e: TouchEvent): void {
  if (!rec || rec.touchId == null) return;
  for (const t of Array.from(e.changedTouches)) if (t.identifier === rec.touchId) cancelDrag();
}
// 新手指落下：拖拽那根若已不在屏上（它的抬起我们没收到），只能作废
function onTouchStart(e: TouchEvent): void {
  if (!rec || rec.touchId == null) return;
  if (!findTouch(e.touches, rec.touchId)) cancelDrag();
}

function moveTo(x: number, y: number): void {
  if (!rec || rec.done) return;
  rec.x = x;
  rec.y = y;
  dnd.x = x;
  dnd.y = y;
  if (!rec.moved && Math.hypot(x - rec.x0, y - rec.y0) > DROP_TOL) {
    rec.moved = true;
    dnd.moved = true;
  }
  updateHit(x, y);
  armAutoScroll(x, y);
}

async function release(x: number, y: number): Promise<void> {
  if (!rec || rec.done) return;
  rec.done = true;
  const r = rec;
  const hit = r.moved ? zoneAt(x, y) : null;
  if (r.hover.entry && r.hover.entry !== hit) {
    try {
      r.hover.entry.opts.leave?.();
    } catch {
      /* ignore */
    }
  }
  teardown();
  swallowClickNear(x, y);
  if (!hit) {
    endWith("cancel", r, null);
    return;
  }
  haptic("light");
  endWith("drop", r, hit);
  try {
    await hit.opts.drop(r.payload, { x, y });
  } catch {
    /* 落点自己报错 */
  }
  try {
    hit.opts.leave?.();
  } catch {
    /* ignore */
  }
}

export function cancelDrag(): void {
  if (!rec) return;
  const r = rec;
  try {
    r.hover.entry?.opts.leave?.();
  } catch {
    /* ignore */
  }
  teardown();
  endWith("cancel", r, null);
}

// 收尾动画：落进落点 = 在原地缩掉；取消 = 飞回原位（原位还在的话）
function endWith(phase: "drop" | "cancel", r: Rec, hit: ZoneEntry | null): void {
  let tx = r.x;
  let ty = r.y;
  if (phase === "cancel" && r.sourceEl?.isConnected) {
    try {
      const b = r.sourceEl.getBoundingClientRect();
      if (b.width && b.height) {
        tx = b.left + b.width / 2 - dnd.ox;
        ty = b.top + b.height / 2 - dnd.oy;
      }
    } catch {
      /* ignore */
    }
  }
  void hit;
  dnd.overKey = "";
  dnd.overLabel = "";
  dnd.phase = phase;
  dnd.x = tx;
  dnd.y = ty;
  animTimer = window.setTimeout(
    () => {
      animTimer = 0;
      dnd.on = false;
      dnd.phase = "";
      dnd.sourceKey = "";
    },
    phase === "drop" ? DROP_ANIM : CANCEL_ANIM,
  );
}
function endAnim(): void {
  if (animTimer) {
    clearTimeout(animTimer);
    animTimer = 0;
  }
  dnd.on = false;
  dnd.phase = "";
  dnd.sourceKey = "";
}

function teardown(): void {
  const r = rec;
  rec = null;
  clearInterval(rehitTimer);
  rehitTimer = 0;
  stopAutoScroll();
  window.removeEventListener("pointermove", onPtrMove, true);
  window.removeEventListener("pointerup", onPtrUp, true);
  window.removeEventListener("pointercancel", onPtrCancel, true);
  document.removeEventListener("touchstart", onTouchStart, true);
  document.removeEventListener("touchmove", onTouchMove, true);
  document.removeEventListener("touchend", onTouchEnd, true);
  document.removeEventListener("touchcancel", onTouchCancel, true);
  const s = r?.sourceEl;
  if (s) {
    s.removeEventListener("pointermove", onPtrMove);
    s.removeEventListener("pointerup", onPtrUp);
    s.removeEventListener("pointercancel", onPtrCancel);
    s.removeEventListener("touchmove", onTouchMove);
    s.removeEventListener("touchend", onTouchEnd);
    s.removeEventListener("touchcancel", onTouchCancel);
  }
  window.removeEventListener("touchmove", blockTouch);
  window.removeEventListener("contextmenu", blockCtxMenu, true);
  window.removeEventListener("keydown", onKey, true);
  document.removeEventListener("visibilitychange", onVisibility);
  document.documentElement.classList.remove("hx-dnd-live");
}

// 只吞浏览器自己补的（isTrusted）、落在这一点附近的一发 click；350ms 没等到就撤
function swallowClickNear(x: number, y: number): void {
  let done = false;
  const off = () => {
    if (done) return;
    done = true;
    window.removeEventListener("click", kill, true);
  };
  const kill = (ev: MouseEvent) => {
    if (!ev.isTrusted) return;
    if (Math.hypot(ev.clientX - x, ev.clientY - y) > CLICK_SLOP) return;
    ev.stopPropagation();
    ev.preventDefault();
    off();
  };
  window.addEventListener("click", kill, true);
  window.setTimeout(off, 350);
}

// —— 边缘自动滚动：拖到滚动容器上下缘时让它自己滚（长侧栏里把项目挪到看不见的位置）——
let scrollEl: HTMLElement | null = null;
let scrollVec = 0;
let scrollRaf = 0;
function scrollableAt(x: number, y: number): HTMLElement | null {
  let el: Element | null = null;
  try {
    el = document.elementFromPoint(x, y);
  } catch {
    return null;
  }
  for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight - n.clientHeight <= 4) continue;
    const oy = getComputedStyle(n).overflowY;
    if (oy === "auto" || oy === "scroll") return n;
  }
  return null;
}
function armAutoScroll(x: number, y: number): void {
  const el = scrollableAt(x, y);
  if (!el) {
    stopAutoScroll();
    return;
  }
  const r = el.getBoundingClientRect();
  let v = 0;
  if (y < r.top + EDGE) v = -Math.ceil(((r.top + EDGE - y) / EDGE) * EDGE_MAX);
  else if (y > r.bottom - EDGE) v = Math.ceil(((y - (r.bottom - EDGE)) / EDGE) * EDGE_MAX);
  if (!v) {
    stopAutoScroll();
    return;
  }
  scrollEl = el;
  scrollVec = v;
  if (!scrollRaf) scrollRaf = requestAnimationFrame(tickAutoScroll);
}
function tickAutoScroll(): void {
  scrollRaf = 0;
  if (!rec || !scrollEl || !scrollVec) return;
  scrollEl.scrollTop += scrollVec;
  updateHit(rec.x, rec.y); // 列表滚了，手指底下的插入位置跟着变
  scrollRaf = requestAnimationFrame(tickAutoScroll);
}
function stopAutoScroll(): void {
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
  scrollEl = null;
  scrollVec = 0;
}

// —— 拖源：Svelte action ——
//   <div use:dragSource={{ key, payload: () => ({ kind: "session", … }), disabled }}>
// 触屏：按住 HOLD_MS 不动才拎起（之前挪了就是在滚 / 左滑）；鼠标 / 笔：按下挪过 MOUSE_TOL 就拎起。
// 起拖之后原来的点按作废（松手附近的 click 被吞掉）。
export interface DragSourceOpts {
  key: string;
  payload: () => DragPayload | null;
  disabled?: boolean;
  onStart?: () => void;
}
export function dragSource(node: HTMLElement, opts: DragSourceOpts) {
  let cur = opts;
  let timer = 0;
  let from: { x: number; y: number; pointerId: number; pointerType: string } | null = null;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
    from = null;
    window.removeEventListener("pointermove", track, true);
    window.removeEventListener("pointerup", disarm, true);
    window.removeEventListener("pointercancel", disarm, true);
  };
  const lift = () => {
    const f = from;
    disarm();
    if (!f || cur.disabled || rec) return;
    const payload = cur.payload();
    if (!payload) return;
    if (beginDrag(payload, { ...f, sourceEl: node, sourceKey: cur.key })) cur.onStart?.();
  };
  function track(e: PointerEvent) {
    if (!from || e.pointerId !== from.pointerId) return;
    const d = Math.hypot(e.clientX - from.x, e.clientY - from.y);
    if (from.pointerType === "mouse" || from.pointerType === "pen") {
      if (d > MOUSE_TOL) lift();
      return;
    }
    if (d > MOVE_TOL) disarm(); // 触屏：还没到时间就挪了 = 在滚列表 / 左滑
  }
  const down = (e: PointerEvent) => {
    if (cur.disabled || rec) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // 行内的按钮（删除、更多）自己处理，不从它们上面起拖
    if ((e.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
    disarm();
    from = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, pointerType: e.pointerType };
    window.addEventListener("pointermove", track, true);
    window.addEventListener("pointerup", disarm, true);
    window.addEventListener("pointercancel", disarm, true);
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") {
      timer = window.setTimeout(() => {
        timer = 0;
        lift();
      }, HOLD_MS);
    }
  };
  node.addEventListener("pointerdown", down);
  return {
    update(next: DragSourceOpts) {
      cur = next;
    },
    destroy() {
      disarm();
      node.removeEventListener("pointerdown", down);
    },
  };
}
