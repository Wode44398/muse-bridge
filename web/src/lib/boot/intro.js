// 开机入场与页面其它部分之间的几根线。

/**
 * 和主页流光 iframe（public/wallpaper/drift.js）共享的对象：开机演出期间它每帧读 parent.__bootIntro.cam
 * 来推镜，画出第一帧时把 ready 置 true。挂在 window 上，因为 iframe 只能这样够到父页。
 */
export const bootIntro = (() => {
  const o = { active: false, cam: null, ready: false };
  if (typeof window !== 'undefined') window.__bootIntro = o;
  return o;
})();

/** 标记的大小：每个 108 网格单位多少 css px。index.html 首帧已经按它画过，这里必须是同一个值 */
export function markUnit() {
  const u = typeof window !== 'undefined' && window.__bootMark && Number(window.__bootMark.u);
  if (u > 0) return u;
  return Math.min(innerWidth, innerHeight) < 600 ? 1.9 : 1.7;
}

/** 撤掉 index.html 里的首帧封面（标记 + 暖墨底） */
export function dropFirstFrame() {
  try { document.getElementById('boot-cover')?.remove(); } catch {}
}
export const firstFrame = () => (typeof document !== 'undefined' ? document.getElementById('boot-cover') : null);

/** html[data-boot]：'gate' 入场层在上面（只有浮在它上面的标题要藏）；'hide' 门洞透明、门开着，主页上的入口也藏。
    各组件自己的样式里按它藏；门出画那一帧撤掉 */
export function setBootAttr(v) {
  const el = document.documentElement;
  if (v) el.dataset.boot = v; else delete el.dataset.boot;
}
