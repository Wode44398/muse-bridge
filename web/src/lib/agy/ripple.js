// agy 分页的按压涟漪（Material 3 state layer + ripple）：页面根上一个委托监听，页内所有按钮都有，
// 不用逐个组件接。参数照 Material Web 的 ripple：从落点长到盖满 450ms、按下层 10%、最短显示 225ms、
// 退场 375ms；触屏先等 150ms 再起（手指是来滚动的话浏览器会发 pointercancel，就不闪一下）。
// 只动 transform / opacity。涟漪挂在按钮自己里面（跟着按钮走；菜单选完收起时不会留在原地），
// 颜色取按钮的文字色（M3：状态层用内容色）。
import { reducedMotion } from './motion.js';

const HOST = 'button, [role="button"], summary';
// 自带按压形变或不该整块泛色的：发送键、logo、弹层遮罩、附件瓦片、拖拽把手
const SKIP = '.bud, .agy-mark, .agy-pop-scrim, .aa, [data-no-ripple], [data-no-ripple] *';
const GROW_MS = 450, MIN_MS = 225, IN_MS = 105, OUT_MS = 375, TOUCH_DELAY = 150;
const PRESSED = 0.1;
const MAX_AREA = 300 * 300;   // 再大的「按钮」是遮罩 / 整卡，不泛色

function hostOf(target, root) {
  const el = target?.closest?.(HOST);
  if (!el || !root.contains(el)) return null;
  if (el.matches(SKIP) || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
  return el;
}

function spawn(el, x, y) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height || r.width * r.height > MAX_AREA) return null;
  const wrap = document.createElement('span');
  wrap.className = 'agy-rpl';
  wrap.setAttribute('aria-hidden', 'true');
  const dot = document.createElement('i');
  const d = Math.hypot(r.width, r.height) + 10;
  dot.style.width = dot.style.height = d + 'px';
  dot.style.left = (r.width - d) / 2 + 'px';
  dot.style.top = (r.height - d) / 2 + 'px';
  wrap.appendChild(dot);
  // 涟漪层靠 absolute 铺满按钮：按钮本身没定位时临时给它 relative，收场还原
  let restore = null;
  if (getComputedStyle(el).position === 'static') {
    const prev = el.style.position;
    el.style.position = 'relative';
    restore = () => { el.style.position = prev; };
  }
  el.appendChild(wrap);
  const still = reducedMotion();
  const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
  const s0 = Math.max(0.05, (Math.max(r.width, r.height) * 0.2) / d);
  if (!still) {
    dot.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${s0})` }, { transform: 'translate(0, 0) scale(1)' }],
      { duration: GROW_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' },
    );
  }
  dot.animate([{ opacity: 0 }, { opacity: PRESSED }], { duration: IN_MS, easing: 'linear', fill: 'forwards' });
  const at = performance.now();
  let gone = false;
  return {
    release() {
      if (gone) return;
      gone = true;
      const wait = Math.max(0, MIN_MS - (performance.now() - at));
      setTimeout(() => {
        const done = () => { wrap.remove(); restore?.(); };
        if (!wrap.isConnected) { restore?.(); return; }
        try {
          dot.animate([{ opacity: PRESSED }, { opacity: 0 }], { duration: OUT_MS, easing: 'linear', fill: 'forwards' })
            .finished.then(done, done);
        } catch { done(); }
      }, wait);
    },
  };
}

/** Svelte action：挂在页面根上 */
export function agyRipple(root) {
  const live = new Map();   // pointerId -> { el, x, y, timer, rp }

  function down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = hostOf(e.target, root);
    if (!el) return;
    const rec = { el, x: e.clientX, y: e.clientY, timer: 0, rp: null };
    live.set(e.pointerId, rec);
    if (e.pointerType === 'touch') {
      rec.timer = setTimeout(() => { rec.timer = 0; rec.rp = spawn(el, rec.x, rec.y); }, TOUCH_DELAY);
    } else {
      rec.rp = spawn(el, rec.x, rec.y);
    }
  }
  function up(e) {
    const rec = live.get(e.pointerId);
    if (!rec) return;
    live.delete(e.pointerId);
    // 轻点：还没等到起涟漪手就抬了——照样完整播一次
    if (rec.timer) { clearTimeout(rec.timer); if (rec.el.isConnected) rec.rp = spawn(rec.el, rec.x, rec.y); }
    rec.rp?.release();
  }
  function cancel(e) {
    const rec = live.get(e.pointerId);
    if (!rec) return;
    live.delete(e.pointerId);
    if (rec.timer) clearTimeout(rec.timer);   // 是滚动：不起
    rec.rp?.release();
  }

  root.addEventListener('pointerdown', down, { capture: true, passive: true });
  window.addEventListener('pointerup', up, { capture: true, passive: true });
  window.addEventListener('pointercancel', cancel, { capture: true, passive: true });
  return {
    destroy() {
      root.removeEventListener('pointerdown', down, { capture: true });
      window.removeEventListener('pointerup', up, { capture: true });
      window.removeEventListener('pointercancel', cancel, { capture: true });
      for (const rec of live.values()) { if (rec.timer) clearTimeout(rec.timer); rec.rp?.release(); }
      live.clear();
    },
  };
}
