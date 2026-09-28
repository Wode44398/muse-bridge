// 工作台底部 sheet 的拖拽关闭手势（移植自 harness touch.ts dragClose，纯 JS）：
// Pointer Events + transform 跟手，拖拽期间零 transition；反向 rubber-band 阻尼；
// 松手按「位移 36% 或 速度>0.55px/ms」判关，先滑出屏再卸载避免"闪没"。
// 只认触屏/笔（鼠标不接管）；handle() 限定起拖区（内容区保留滚动）。

export function dragSheet(node, opts) {
  let startY = 0;
  let cur = 0;
  let dragging = false;
  let pid = -1;
  let lastT = 0, lastP = 0, vel = 0;
  let sizeCache = 0;

  function onDown(e) {
    if (e.pointerType === 'mouse') return;
    const h = opts.handle?.();
    if (h && !h.contains(e.target)) return;
    dragging = true;
    pid = e.pointerId;
    startY = e.clientY;
    cur = 0;
    vel = 0;
    lastT = e.timeStamp;
    lastP = startY;
    sizeCache = node.offsetHeight;
    node.style.transition = 'none';
    node.setPointerCapture?.(pid);
  }

  function onMove(e) {
    if (!dragging || e.pointerId !== pid) return;
    const p = e.clientY;
    let d = p - startY;                       // 正 = 向下（关闭方向）
    const dt = Math.max(1, e.timeStamp - lastT);
    vel = (p - lastP) / dt;                   // px/ms
    lastT = e.timeStamp;
    lastP = p;
    if (d < 0) d = -Math.pow(-d, 0.72);       // 反向阻尼（rubber-band）
    cur = d;
    node.style.transform = `translateY(${d}px)`;
    if (Math.abs(d) > 6) e.preventDefault?.();
  }

  function onUp(e) {
    if (!dragging || e.pointerId !== pid) return;
    dragging = false;
    node.style.transition = '';
    const shouldClose = cur > sizeCache * 0.36 || (vel > 0.55 && cur > 24);
    if (shouldClose) {
      node.style.transform = `translateY(${sizeCache}px)`;
      setTimeout(opts.onClose, 160);
    } else {
      node.style.transform = '';
    }
  }

  node.addEventListener('pointerdown', onDown);
  node.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', onUp);
  node.addEventListener('pointercancel', onUp);
  return {
    destroy() {
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
    },
  };
}
