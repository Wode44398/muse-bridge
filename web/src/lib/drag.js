// Svelte action: drag a bottom sheet down by its handle to dismiss.
// Attach to the sheet element; it grabs the `.sheet-handle` child as the grip.
//   <section use:dragDismiss={{ onClose }}> … <div class="sheet-handle"></div> …
export function dragDismiss(node, opts = {}) {
  let { onClose, handle = '.sheet-handle', threshold = 90 } = opts;
  const grip = node.querySelector(handle) || node;
  let startY = 0, dy = 0, dragging = false;

  const point = (e) => (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);

  function down(e) {
    dragging = true; startY = point(e); dy = 0;
    node.style.transition = 'none';
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  function move(e) {
    if (!dragging) return;
    dy = Math.max(0, point(e) - startY);
    node.style.transform = `translateY(${dy}px)`;
    if (e.cancelable) e.preventDefault();
  }
  function up() {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    node.style.transition = '';
    if (dy > threshold) {
      node.style.transform = 'translateY(100%)';
      setTimeout(() => onClose && onClose(), 180);
    } else {
      node.style.transform = '';
    }
  }

  grip.style.touchAction = 'none';
  grip.addEventListener('pointerdown', down);
  return {
    update(next) { onClose = next.onClose ?? onClose; threshold = next.threshold ?? threshold; },
    destroy() { grip.removeEventListener('pointerdown', down); },
  };
}
