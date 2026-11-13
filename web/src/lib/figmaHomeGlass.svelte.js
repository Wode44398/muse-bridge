// 主页的 WebGPU 玻璃（四个入口方块 + 右上账户胶囊）：玻璃渲染模块是原版资源
// （清单 modules.figmaGlass：FigmaGlassRenderer / NOTIFICATION_SCENE，与桌面主页 Dock 同一份），有 WebGPU 就走这条。
// 没有 WebGPU / 设备丢失 / 渲染失败时 homeGlass.failed = true，主页与登录卡退回 SVG 折射 / WebGL / 毛玻璃（硬件退路）。
// 这里只管两件事：所有玻璃块共用一个 WebGPU 设备（只有真走这条路才建）；
// Home 与 LoginCard 之间共享「用不用、背景从哪来、挂没挂」。
//
// bg 两种：
//   { kind: 'image', url, box() }   静态壁纸：box() 给出壁纸 <img> 在视口里的矩形（cover 映射用）
//   { kind: 'live', subscribe(fn), request?() }  空间视差 / 流光：每画完一帧同步回调 fn(canvas, box?)
import { ovModule } from './overlay.svelte.js';

export const homeGlass = $state({ on: false, failed: false, bg: null });

/** 玻璃渲染模块（{ FigmaGlassRenderer, NOTIFICATION_SCENE }）；加载失败 → null。Dock 也用这个。 */
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
