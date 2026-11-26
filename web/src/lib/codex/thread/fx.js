// 对话这一栏的几个编排好的动作（照 demo.js 的 grow / setRow / riseInto / ballHandoff）。只动 DOM，节奏用 motion.js 那一套。

import { anim, EASE, reduced } from '../motion.js';

/** 工作记录新的一条从零高度轻轻弹开，里面的字从下面 5px 跟上来。 */
export function grow(el, o = {}) {
  if (!el || reduced()) return null;
  const h = el.offsetHeight;
  if (!h) return null;
  el.style.overflow = 'hidden';
  const dur = o.dur ?? 420;
  const a = anim(el, [{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1, offset: 0.9 }, { height: h + 'px', opacity: 1 }], { dur, ease: EASE.soft, delay: o.delay });
  if (el.firstElementChild) anim(el.firstElementChild, [{ transform: `translateY(${o.from ?? 5}px)` }, { transform: 'none' }], { dur, ease: EASE.soft, delay: o.delay });
  const done = () => { el.style.overflow = ''; };
  a ? a.finished.then(done, done) : done();
  return a;
}

/** 刚长出来 / 原地换了内容的那一行：字上先扫一道光再定住。 */
export function sweep(el) {
  if (!el || reduced()) return;
  el.classList.remove('sweep');
  void el.offsetWidth;
  el.classList.add('sweep');
  clearTimeout(el.__sweepT);
  el.__sweepT = setTimeout(() => el.classList.remove('sweep'), 950);
}

/** 同一行原地换内容（等你批准 → 正在运行）：这一行从淡处回到实。 */
export function settleLine(el) {
  if (!el || reduced()) return;
  anim(el, [{ opacity: 0.25, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { dur: 300, ease: EASE.soft });
}

const local = (r, root) => {
  const b = root.getBoundingClientRect();
  return { x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height };
};

/**
 * 你的话：输入框里那段字往上升，变成你的消息（不是凭空冒出一块）。找不到输入框就从下面升上来。
 */
export function riseInto(target) {
  if (!target || reduced()) return;
  const root = target.closest('.cx');
  const input = root?.querySelector('.comp-input');
  const ir = input?.getBoundingClientRect();
  if (!root || !ir || !ir.width) {
    anim(target, [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }], { dur: 460, ease: EASE.soft });
    return;
  }
  const src = local(ir, root), dst = local(target.getBoundingClientRect(), root);
  const cs = getComputedStyle(target);
  const g = target.cloneNode(true);
  g.style.cssText = `position:absolute;z-index:70;margin:0;left:${dst.x}px;top:${dst.y}px;width:${dst.w}px;pointer-events:none;`;
  root.appendChild(g);
  const sx = src.x - dst.x + 16 - parseFloat(cs.paddingLeft), sy = src.y - dst.y + 13 - parseFloat(cs.paddingTop);
  target.style.opacity = '0';
  const end = () => { target.style.opacity = ''; g.remove(); };
  const a = anim(g, [
    { transform: `translate(${sx}px,${sy}px)`, backgroundColor: 'transparent' },
    { transform: 'translate(0,0)', backgroundColor: cs.backgroundColor },
  ], { dur: 520, ease: EASE.soft });
  a ? a.finished.then(end, end) : end();
}

/**
 * 小球交接：工作记录顶上那颗沿弧线飞到回答开头，缩成字号大小，之后由回答末尾那颗领着字走。
 * onLand 在落地（或放弃）时调，回答那边据此把末尾那颗亮出来。
 */
export function handoff(ball, md, onLand) {
  const i = ball?.querySelector('i');
  const root = md?.closest('.cx');
  if (!i || !root || reduced()) { onLand?.(); return; }
  const ar = i.getBoundingClientRect();
  if (!ar.width) { onLand?.(); return; }
  const a = local(ar, root), p = local(md.getBoundingClientRect(), root);
  const fs = parseFloat(getComputedStyle(md).fontSize) || 15;
  const g = document.createElement('i');
  g.style.cssText = `position:absolute;z-index:70;left:${a.x}px;top:${a.y}px;width:9px;height:9px;border-radius:5px;background:var(--btn);pointer-events:none`;
  root.appendChild(g);
  const dx = p.x - a.x + 1, dy = p.y - a.y + fs * 0.72;
  const end = () => { g.remove(); onLand?.(); };
  const an = anim(g, [
    { transform: 'translate(0,0) scale(1)' },
    { transform: `translate(${dx * 0.5}px,${dy * 0.5 - 18}px) scale(1.15)`, offset: 0.45 },
    { transform: `translate(${dx}px,${dy}px) scale(${(fs * 0.56) / 9})` },
  ], { dur: 520, ease: EASE.io });
  an ? an.finished.then(end, end) : end();
}

/** 刚收尾的卡片（改动卡、产物）从下面 8px 淡入。 */
export function rise(el, delay = 80) {
  if (!el || reduced()) return;
  anim(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { dur: 420, ease: EASE.soft, delay });
}
