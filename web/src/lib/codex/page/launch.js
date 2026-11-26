// 发第一句 / 插话时页面这一半的动效（输入栏发事件，这里接）：
//   cx-launch  首页发第一句前：记下标志里那根 `_`，等线程画出那颗小球，`_` 沿弧线落进去（chrome/hero.js）
//   cx-rise    插话后：记录里那个插话气泡从输入框的位置飞进去（普通发送那条「你的话」由 Turn 自己从输入框升起）
// 都在 .cx 根上听；系统开了「减少动态效果」时什么都不画。

import { anim, EASE, reduced } from '../motion.js';
import { captureHero, landHero } from '../chrome/hero.js';

/** 等某个元素出现（下一帧起最多等 ms 毫秒），拿不到给 null。 */
function waitFor(find, ms = 900) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = () => {
      const el = find();
      if (el) return resolve(el);
      if (performance.now() - t0 > ms) return resolve(null);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function riseInto(root, target, d) {
  if (!target?.isConnected || !d?.rect) return;
  const base = root.getBoundingClientRect();
  const dst = target.getBoundingClientRect();
  const cs = getComputedStyle(target);
  const g = target.cloneNode(true);
  g.style.cssText = `position:absolute;z-index:70;margin:0;left:${dst.left - base.left}px;top:${dst.top - base.top}px;width:${dst.width}px;pointer-events:none;`;
  root.appendChild(g);
  const sx = d.rect.left - dst.left + (d.padL ?? 16) - parseFloat(cs.paddingLeft || '0');
  const sy = d.rect.top - dst.top + (d.padT ?? 13) - parseFloat(cs.paddingTop || '0');
  target.style.opacity = '0';
  const done = () => { target.style.opacity = ''; g.remove(); };
  const a = anim(g, [
    { transform: `translate(${sx}px,${sy}px)`, backgroundColor: 'transparent' },
    { transform: 'translate(0,0)', backgroundColor: cs.backgroundColor },
  ], { dur: 520, ease: EASE.soft });
  if (a) a.finished.then(done, done); else done();
}

export function wireLaunch(root) {
  if (!root) return () => {};
  let cap = null;
  const onLaunch = () => {
    if (reduced()) return;
    cap = captureHero(root);
    if (!cap) return;
    const mine = cap;
    // 线程挂上、这一轮的小球画出来以后再落
    waitFor(() => root.querySelector('.cx-col .turn:last-child .log-head .ball')).then((ball) => {
      if (cap !== mine) return;
      cap = null;
      if (ball) landHero(root, mine, ball);
      else mine.ghost?.remove?.();
    });
  };
  const onRise = (e) => {
    if (reduced()) return;
    const d = e.detail || {};
    if (d.kind !== 'steer') return;
    waitFor(() => {
      const all = root.querySelectorAll('.cx-col .msg-steer');
      return all.length ? all[all.length - 1] : null;
    }, 400).then((el) => riseInto(root, el, d));
  };
  root.addEventListener('cx-launch', onLaunch);
  root.addEventListener('cx-rise', onRise);
  return () => {
    root.removeEventListener('cx-launch', onLaunch);
    root.removeEventListener('cx-rise', onRise);
    cap?.ghost?.remove?.();
  };
}
