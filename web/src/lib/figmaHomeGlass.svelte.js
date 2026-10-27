// 主页的 WebGPU 玻璃（四个入口方块 + 右上账户胶囊）：有 WebGPU、且维护者的私有 overlay 提供了玻璃渲染模块
// （清单 modules.figmaGlass：FigmaGlassRenderer / NOTIFICATION_SCENE，与桌面主页 Dock 同一份）时走这条。
// 公开版没有这个模块：homeGlass.failed 一开始就是 true，主页与登录卡直接用自有的 SVG 折射 / WebGL / 毛玻璃。
// 这里只管两件事：所有玻璃块共用一个 WebGPU 设备（只有真走这条路才建）；
// Home 与 LoginCard 之间共享「用不用、背景从哪来、挂没挂」。
//
// bg 两种：
//   { kind: 'image', url, box() }   静态壁纸：box() 给出壁纸 <img> 在视口里的矩形（cover 映射用）
//   { kind: 'live', subscribe(fn), request?() }  空间视差 / 流光：每画完一帧同步回调 fn(canvas, box?)
import { ov, ovModule, overlayReady } from './overlay.svelte.js';

const hasModule = () => !!(ov.on && ov.modules.figmaGlass);
// 清单（在线页由服务端注入，同步就在）没有这个模块 → 一开始就判失败，不闪；离线壳清单晚到，到了再放行
export const homeGlass = $state({ on: false, failed: !hasModule(), bg: null });
let lost = false;
overlayReady().then(() => { if (!lost) homeGlass.failed = !hasModule(); });

/** overlay 的玻璃渲染模块（{ FigmaGlassRenderer, NOTIFICATION_SCENE }）；没有 → null。Dock 也用这个。 */
export function loadFigmaGlass() {
  return ovModule('figmaGlass').then((m) => (m && m.FigmaGlassRenderer && m.NOTIFICATION_SCENE ? m : null));
}

let pending = null;
export function figmaRenderer() {
  if (!pending) {
    pending = (async () => {
      const m = await loadFigmaGlass();
      if (!m) throw new Error('WebGPU 玻璃模块不可用');   // i18n-ignore 只进 console.warn
      const { FigmaGlassRenderer, NOTIFICATION_SCENE } = m;
      const r = await FigmaGlassRenderer.create(null);
      r.device.lost.then((info) => {
        console.warn('[figmaHome] GPU 设备丢失，退回原玻璃：', info?.message);   // i18n-ignore 只进控制台
        lost = true;
        homeGlass.failed = true;
      });
      return { r, SCENE: NOTIFICATION_SCENE };
    })();
  }
  return pending;
}

// 壁纸原图解码一次，几块玻璃共用
const images = new Map();
export function loadImage(url) {
  if (!images.has(url)) {
    images.set(url, new Promise((res, rej) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => (im.decode ? im.decode().then(() => res(im), () => res(im)) : res(im));
      im.onerror = () => { images.delete(url); rej(new Error('load ' + url)); };
      im.src = url;
    }));
  }
  return images.get(url);
}
