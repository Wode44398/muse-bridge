// 切换线程：标题从侧栏那一行飞到顶栏（方案第十一节第 10 条）。
// 侧栏行被点时先把起点记下来（queueTitleFlight），顶栏换上新标题后取走它画这一段（flyTitle）。
// 起点只认刚记下的（半秒内），免得从别处（‹ ›、新建、分叉）切过去时还飞一段旧的。

import { anim, EASE, reduced } from '../motion.js';

let pending = null;

/** 侧栏行被点：记下标题此刻的位置。 */
export function queueTitleFlight(id, titleEl) {
  if (!id || !titleEl?.isConnected || reduced()) { pending = null; return; }
  const r = titleEl.getBoundingClientRect();
  pending = { id, at: performance.now(), rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
}

/** 顶栏取走这条线程的起点（取一次就清掉）。 */
export function takeTitleFlight(id) {
  const p = pending;
  pending = null;
  if (!p || p.id !== id || performance.now() - p.at > 500) return null;
  return p.rect;
}

/** 从 from（视口坐标）飞到 nameEl 的位置：一份标题的影子走过去、字重由 400 变 500，到了让真标题淡入。 */
export function flyTitle(root, from, nameEl, title) {
  if (!root || !from || !nameEl?.isConnected || reduced()) return;
  const base = root.getBoundingClientRect();
  const to = nameEl.getBoundingClientRect();
  const g = document.createElement('div');
  g.textContent = title;
  g.setAttribute('aria-hidden', 'true');
  g.style.cssText = `position:absolute;z-index:80;left:${from.x - base.left}px;top:${from.y - base.top}px;`
    + `font:400 13px/${from.h}px var(--font);color:var(--fg);white-space:nowrap;pointer-events:none;transform-origin:0 50%`;
  root.appendChild(g);
  const dx = to.left - from.x, dy = to.top - from.y + (to.height - from.h) / 2;
  anim(nameEl, [{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], { dur: 420 });
  const a = anim(g, [
    { transform: 'translate(0,0)', fontWeight: 400, opacity: 1 },
    { transform: `translate(${dx}px,${dy}px)`, fontWeight: 500, opacity: 1, offset: 0.85 },
    { transform: `translate(${dx}px,${dy}px)`, opacity: 0 },
  ], { dur: 420, ease: EASE.out });
  if (a) a.finished.then(() => g.remove(), () => g.remove()); else g.remove();
}
