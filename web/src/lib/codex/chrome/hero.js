// 首页标志的签名时刻：发第一句时，标志淡出，它里面那根 `_` 飞下来，变成这一轮开头那颗小球（方案第十五节第 7 条）。
//
// 用法（页面外壳负责接线）：
//   发送前、首页还在时：const cap = captureHero(rootEl);   // 记下 `_` 的位置，留一份首页的残影
//   换到线程、小球挂上以后：landHero(rootEl, cap, ballEl);   // 残影淡出，`_` 沿弧线落进小球，小球弹一下
// 也可以只用底层的 flyUnderscore(rootEl, fromRect, toEl)。坐标一律是视口坐标（getBoundingClientRect），这里换成 .cx 里的。
// 系统开了「减少动态效果」：什么都不画，直接返回。

import { anim, EASE, reduced } from '../motion.js';
import { underscoreBox, underscoreFlight } from './logic.js';

/** Home 挂上时登记自己的 hero、标志与点头（同一页只有一个首页）。 */
export const heroRef = { hero: null, logo: null, nod: null };

const boxOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
function toLocal(root, b) {
  const r = root.getBoundingClientRect();
  return { x: b.x - r.left, y: b.y - r.top, w: b.w, h: b.h };
}

/** 标志里 `_` 那一笔此刻在视口里的位置 { x, y, w, h }；首页不在返回 null。 */
export function underscoreRect(logo = heroRef.logo) {
  if (!logo?.isConnected) return null;
  const r = logo.getBoundingClientRect();
  if (!r.width) return null;
  return underscoreBox({ left: r.left, top: r.top, width: r.width });
}

/** 首页那一块的残影（克隆一份挂到 .cx 根下、原位不动；`_` 已经飞走所以藏起来）。 */
export function heroGhost(root, hero = heroRef.hero, logo = heroRef.logo) {
  if (!root || !hero?.isConnected) return null;
  const at = toLocal(root, boxOf(hero));
  const g = hero.cloneNode(true);
  g.removeAttribute('id');
  g.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  const ul = g.querySelector('.ul');
  if (ul) ul.style.opacity = '0';
  const lg = g.querySelector('.logo');
  if (lg && logo) {
    const tf = getComputedStyle(logo).transform;
    lg.style.transform = tf === 'none' ? '' : tf;
    lg.classList.remove('playing');
  }
  g.setAttribute('aria-hidden', 'true');
  g.style.cssText = `position:absolute;z-index:70;margin:0;left:${at.x}px;top:${at.y}px;width:${at.w}px;pointer-events:none`;
  root.appendChild(g);
  return g;
}

/** `_` 从 fromRect（视口坐标）飞到 toEl 的位置，到了就消失。返回飞完的 Promise。 */
export function flyUnderscore(root, fromRect, toEl) {
  if (!root || !fromRect || !toEl?.isConnected || reduced()) return Promise.resolve();
  const from = toLocal(root, fromRect), to = toLocal(root, boxOf(toEl));
  const op = heroRef.logo?.isConnected ? Number(getComputedStyle(heroRef.logo).opacity) || 0.3 : 0.3;
  const f = underscoreFlight(from, to, op);
  const g = document.createElement('i');
  g.setAttribute('aria-hidden', 'true');
  g.style.cssText = `position:absolute;z-index:71;left:${f.start.left}px;top:${f.start.top}px;width:${f.start.w}px;height:${f.start.h}px;`
    + `border-radius:${f.start.h / 2}px;background:var(--btn);pointer-events:none;transform:translate(-50%,-50%)`;
  root.appendChild(g);
  const a = anim(g, f.frames, { dur: 720, ease: 'linear', delay: 60 });
  if (!a) { g.remove(); return Promise.resolve(); }
  return a.finished.then(() => g.remove(), () => g.remove());
}

/** 发送前调用：记下 `_` 的位置、留一份首页残影。不在首页 / 减少动态效果时返回 null。 */
export function captureHero(root) {
  if (!root || reduced()) return null;
  const ul = underscoreRect();
  if (!ul) return null;
  return { ul, ghost: heroGhost(root) };
}

/**
 * 线程画出来、小球挂上以后调用：残影上浮淡出，`_` 落进小球，小球弹一下。
 * ballEl = 小球外层（.ball，飞行期间加 hold 藏起原来的点），dot = 小球里那颗点（默认 .ball 里的 i）。
 */
export function landHero(root, cap, ballEl, dot = ballEl?.querySelector?.('i') || ballEl) {
  if (!cap) return Promise.resolve();
  const ghost = cap.ghost;
  if (ghost) {
    const a = anim(ghost, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-14px) scale(.985)' }], { dur: 380, ease: EASE.io });
    if (a) a.finished.then(() => ghost.remove(), () => ghost.remove()); else ghost.remove();
  }
  if (!ballEl?.isConnected || !dot) return Promise.resolve();
  ballEl.classList.add('hold');
  return flyUnderscore(root, cap.ul, dot).then(() => {
    ballEl.classList.remove('hold');
    anim(dot, [{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { dur: 360, ease: EASE.pop });
  });
}
