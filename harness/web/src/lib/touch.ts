// 触控跟手基建：全部基于 Pointer Events + transform，拖拽期间零 transition、
// 手指到哪层到哪；松手按速度决定去留（velocity fling），回弹走 CSS 过渡。
// 供底部 sheet、侧边抽屉、滑动删除三处复用。

export interface DragSheetOpts {
  onClose: () => void;
  handle?: () => HTMLElement | null; // 只允许从把手/头部起拖（内容区要保留滚动）
  axis?: "y" | "x";                  // sheet 竖拖 / 抽屉横拖
  dir?: 1 | -1;                      // 关闭方向：y+1 向下，x-1 向左
}

// 拖拽关闭：挂在 sheet/抽屉根节点。跟手位移 + 阻尼反向 + 速度/位移双阈值判关。
export function dragClose(node: HTMLElement, opts: DragSheetOpts) {
  const axis = opts.axis ?? "y";
  const dir = opts.dir ?? 1;
  let startPos = 0;
  let cur = 0;
  let dragging = false;
  let pid = -1;
  let lastT = 0, lastP = 0, vel = 0;
  let sizeCache = 0;

  const prop = axis === "y" ? "translateY" : "translateX";

  function onDown(e: PointerEvent) {
    if (e.pointerType === "mouse") return; // 桌面弹层不做鼠标拖拽（触屏/笔才跟手）
    const h = opts.handle?.();
    if (h && !h.contains(e.target as Node)) return;
    // 内容可滚区域未滚到顶时不接管（竖向 sheet）
    dragging = true;
    pid = e.pointerId;
    startPos = axis === "y" ? e.clientY : e.clientX;
    cur = 0;
    vel = 0;
    lastT = e.timeStamp;
    lastP = startPos;
    sizeCache = axis === "y" ? node.offsetHeight : node.offsetWidth;
    node.style.transition = "none";
    node.setPointerCapture?.(pid);
  }

  function onMove(e: PointerEvent) {
    if (!dragging || e.pointerId !== pid) return;
    const p = axis === "y" ? e.clientY : e.clientX;
    let d = (p - startPos) * dir; // 正 = 关闭方向
    const dt = Math.max(1, e.timeStamp - lastT);
    vel = ((p - lastP) * dir) / dt; // px/ms（关闭方向为正）
    lastT = e.timeStamp;
    lastP = p;
    if (d < 0) d = -Math.pow(-d, 0.72); // 反向阻尼（rubber-band）
    cur = d;
    node.style.transform = `${prop}(${d * dir}px)`;
    if (Math.abs(d) > 6) e.preventDefault?.();
  }

  function onUp(e: PointerEvent) {
    if (!dragging || e.pointerId !== pid) return;
    dragging = false;
    node.style.transition = "";
    const shouldClose = cur > sizeCache * 0.36 || (vel > 0.55 && cur > 24);
    if (shouldClose) {
      // 先滑出屏再卸载，避免"闪没"
      node.style.transform = `${prop}(${sizeCache * dir}px)`;
      setTimeout(opts.onClose, 160);
    } else {
      node.style.transform = "";
    }
  }

  node.addEventListener("pointerdown", onDown);
  node.addEventListener("pointermove", onMove);
  node.addEventListener("pointerup", onUp);
  node.addEventListener("pointercancel", onUp);
  return {
    destroy() {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    },
  };
}

// 屏幕左缘右滑呼出抽屉：挂在主内容根上。位移实时回调（抽屉跟手），
// 松手按速度+位移判定 open/cancel。
export function edgeSwipe(
  node: HTMLElement,
  opts: { width?: number; onProgress: (px: number) => void; onEnd: (open: boolean) => void },
) {
  const EDGE = 24;
  let pid = -1;
  let active = false;
  let startX = 0, startY = 0;
  let lastT = 0, lastX = 0, vel = 0;
  let decided = false;

  function down(e: PointerEvent) {
    if (e.pointerType === "mouse") return;
    if (e.clientX > EDGE) return;
    pid = e.pointerId;
    active = true;
    decided = false;
    startX = e.clientX;
    startY = e.clientY;
    lastT = e.timeStamp;
    lastX = e.clientX;
  }
  function move(e: PointerEvent) {
    if (!active || e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) { active = false; return; } // 竖滚放行
      decided = true;
      node.setPointerCapture?.(pid);
    }
    const dt = Math.max(1, e.timeStamp - lastT);
    vel = (e.clientX - lastX) / dt;
    lastT = e.timeStamp;
    lastX = e.clientX;
    opts.onProgress(Math.max(0, dx));
    e.preventDefault?.();
  }
  function up(e: PointerEvent) {
    if (!active || e.pointerId !== pid) return;
    active = false;
    if (!decided) return;
    const w = opts.width ?? 300;
    const dx = e.clientX - startX;
    opts.onEnd(dx > w * 0.4 || vel > 0.5);
  }

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);
  return {
    destroy() {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    },
  };
}

// 列表项左滑露删除（会话列表用）。跟手 + 打开态吸附 + 点其他处收起。
export function swipeReveal(node: HTMLElement, opts: { width: number; onOpenChange?: (open: boolean) => void }) {
  let pid = -1;
  let active = false, decided = false;
  let startX = 0, startY = 0, base = 0, cur = 0;
  const wrap = node.parentElement;

  const set = (x: number, animate: boolean) => {
    cur = x;
    // 删除层位于透明会话行下方，不能仅靠前景背景色遮住。只有真正向左
    // 位移时才让父容器显露 underlay；静止态/桌面鼠标态始终彻底隐藏。
    wrap?.classList.toggle("revealing", x < -0.5);
    node.style.transition = animate ? "transform .26s var(--ease)" : "none";
    node.style.transform = x ? `translateX(${x}px)` : "";
  };

  function down(e: PointerEvent) {
    if (e.pointerType === "mouse") return;
    pid = e.pointerId;
    active = true;
    decided = false;
    startX = e.clientX;
    startY = e.clientY;
    base = cur;
  }
  function move(e: PointerEvent) {
    if (!active || e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx)) { active = false; return; }
      decided = true;
      node.setPointerCapture?.(pid);
    }
    let x = base + dx;
    if (x > 0) x = Math.pow(x, 0.6);           // 右滑阻尼
    if (x < -opts.width) x = -opts.width - Math.pow(-x - opts.width, 0.6);
    set(x, false);
    e.preventDefault?.();
  }
  function up(e: PointerEvent) {
    if (!active || e.pointerId !== pid) return;
    active = false;
    if (!decided) return;
    const open = cur < -opts.width * 0.5;
    set(open ? -opts.width : 0, true);
    opts.onOpenChange?.(open);
  }

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);
  return {
    close() { set(0, true); opts.onOpenChange?.(false); },
    destroy() {
      wrap?.classList.remove("revealing");
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    },
  };
}

// 轻触觉反馈：安卓壳走原生，浏览器退 navigator.vibrate（iOS Safari 无声降级）。
export function haptic(kind: "light" | "medium" = "light") {
  try {
    const shell = (window as any).HarnessShell;
    if (shell?.haptic) { shell.haptic(kind); return; }
    navigator.vibrate?.(kind === "light" ? 8 : 18);
  } catch { /* ignore */ }
}
