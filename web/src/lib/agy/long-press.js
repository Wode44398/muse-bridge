// 长按 / 右键手势 action：供工作空间列表与侧栏文件夹组共用。
// 触屏 / 鼠标长按：停留超过 ARM_MS 挂 .lp-arming 给出蓄力回弹视觉反馈，满 holdMs 触发震动并弹出菜单，
// 同时吞掉紧随其后的合成 click，避免松手误选中该工作空间；期间移动超过 moveTol 自动放弃，不干扰列表滚动。
// 桌面右键：拦截浏览器原生菜单，直接在指针位置弹出。
import { haptic } from '../dragdrop.svelte.js';

const ARM_MS = 110;

export function longPress(node, initialOpts = {}) {
  let opts = initialOpts || {};
  let armTimer = 0;
  let holdTimer = 0;
  let active = null;         // { pointerId, pointerType, startX, startY, fired }
  let suppressClickUntil = 0;
  let lastPointerType = '';

  function clearTimers() {
    if (armTimer) { clearTimeout(armTimer); armTimer = 0; }
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
    node.classList.remove('lp-arming');
  }

  function reset() {
    clearTimers();
    active = null;
  }

  function onPointerDown(ev) {
    if (opts.disabled) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    // 点在行内附属按钮（如新建对话 + / 悬停 ⋯）上时不抢它的点击
    if (ev.target?.closest?.('[data-lp-ignore]')) return;
    reset();
    lastPointerType = ev.pointerType || '';
    const holdMs = Number(opts.holdMs) || 420;
    const rec = {
      pointerId: ev.pointerId,
      pointerType: ev.pointerType || 'touch',
      startX: ev.clientX,
      startY: ev.clientY,
      fired: false,
    };
    active = rec;
    armTimer = setTimeout(() => {
      armTimer = 0;
      if (active === rec && !rec.fired) node.classList.add('lp-arming');
    }, ARM_MS);
    holdTimer = setTimeout(() => {
      holdTimer = 0;
      if (active !== rec) return;
      rec.fired = true;
      node.classList.remove('lp-arming');
      suppressClickUntil = Date.now() + 650;
      haptic('medium');
      opts.onTrigger?.({
        x: rec.startX,
        y: rec.startY,
        el: node,
        via: 'hold',
        pointerId: rec.pointerId,
        pointerType: rec.pointerType,
      });
    }, holdMs);
  }

  function onPointerMove(ev) {
    if (!active || ev.pointerId !== active.pointerId || active.fired) return;
    const tol = Number(opts.moveTol) || 8;
    if (Math.hypot(ev.clientX - active.startX, ev.clientY - active.startY) > tol) {
      reset();
    }
  }

  function onPointerEnd(ev) {
    if (!active || ev.pointerId !== active.pointerId) return;
    reset();
  }

  // 长按已弹出菜单后，手指若不松开直接向下滑选，必须拦掉冒泡到外层抽屉的 touchmove，
  // 否则移动会顺带把底部抽屉（AgyPopover.sheet）一起往下拖。
  function onTouchMove(ev) {
    if (active?.fired) {
      ev.stopPropagation();
      if (ev.cancelable) ev.preventDefault();
    }
  }

  function onClickCapture(ev) {
    if (Date.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  function onContextMenu(ev) {
    if (opts.disabled) return;
    if (ev.target?.closest?.('[data-lp-ignore]')) return;
    ev.preventDefault();
    ev.stopPropagation();
    // 触屏长按时浏览器常补发一次合成 contextmenu：已由长按触发（或刚按过 touch）就不重复开第二次
    if (active?.fired || Date.now() < suppressClickUntil || lastPointerType === 'touch') {
      return;
    }
    reset();
    opts.onTrigger?.({
      x: ev.clientX,
      y: ev.clientY,
      el: node,
      via: 'contextmenu',
      pointerId: null,
      pointerType: 'mouse',
    });
  }

  node.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerEnd, { passive: true });
  window.addEventListener('pointercancel', onPointerEnd, { passive: true });
  node.addEventListener('touchmove', onTouchMove, { passive: false });
  node.addEventListener('click', onClickCapture, true);
  node.addEventListener('contextmenu', onContextMenu);

  return {
    update(nextOpts) {
      opts = nextOpts || {};
      if (opts.disabled) reset();
    },
    destroy() {
      reset();
      node.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('click', onClickCapture, true);
      node.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
