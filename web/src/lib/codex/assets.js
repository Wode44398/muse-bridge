// 官方 Codex 桌面版的素材（OpenAI Sans、首页标志与侧栏图标的 Lottie、吉祥物精灵图、完成提示音）。
// 这些是 OpenAI 的原件，不进任何仓库：服务端从本机安装包里只读取出（modules/codex/server/assets/），
// 这里带着 bridge 鉴权去取、转成 blob URL / FontFace。取不到（Linux、云端、没装桌面版）一律安静退回：
// 系统字体、静态线稿标志、没有吉祥物、合成提示音。

import { authHeaders } from '../api.js';
import { apiUrl } from '../server.js';

let indexP = null;
const blobs = new Map();     // `${kind}/${name}` -> Promise<string|null>
const jsons = new Map();     // lottie name -> Promise<object|null>

async function get(path) {
  const r = await fetch(apiUrl(path), { headers: authHeaders(), credentials: 'same-origin' });
  if (!r.ok) throw Object.assign(new Error('asset HTTP ' + r.status), { status: r.status });
  return r;
}

/** { fonts:[…], lottie:[…], pets:[…], sounds:[…] }；取不到回空清单。 */
export function assetIndex() {
  indexP ||= get('/api/codex/assets/index').then((r) => r.json()).catch(() => ({ fonts: [], lottie: [], pets: [], sounds: [] }));
  return indexP;
}

export async function assetUrl(kind, name) {
  const key = kind + '/' + name;
  if (!blobs.has(key)) {
    blobs.set(key, (async () => {
      const idx = await assetIndex();
      const list = kind === 'pet' ? idx.pets : kind === 'sound' ? idx.sounds : kind === 'font' ? idx.fonts : [];
      if (!list?.includes(name)) return null;
      const r = await get(`/api/codex/assets/${kind}/${encodeURIComponent(name)}`);
      return URL.createObjectURL(await r.blob());
    })().catch(() => null));
  }
  return blobs.get(key);
}

export function lottieData(name) {
  if (!jsons.has(name)) {
    jsons.set(name, (async () => {
      const idx = await assetIndex();
      if (!idx.lottie?.includes(name)) return null;
      return (await get('/api/codex/assets/lottie/' + encodeURIComponent(name))).json();
    })().catch(() => null));
  }
  return jsons.get(name);
}

let fontsP = null;
/** 把 OpenAI Sans 400 / 500 / 600 装进 document.fonts（CSS 里 --font 第一位就是它，没装上自动落到系统字体）。 */
export function loadCodexFonts() {
  fontsP ||= (async () => {
    const idx = await assetIndex();
    const want = [['Regular', '400'], ['Medium', '500'], ['Semibold', '600']];
    await Promise.all(want.map(async ([w, weight]) => {
      const name = 'OpenAISans-' + w;
      if (!idx.fonts?.includes(name)) return;
      if ([...document.fonts].some((f) => f.family.replace(/"/g, '') === 'OpenAI Sans' && f.weight === weight)) return;
      const url = await assetUrl('font', name);
      if (!url) return;
      const face = new FontFace('OpenAI Sans', `url(${url})`, { weight, display: 'swap' });
      await face.load();
      document.fonts.add(face);
    }));
  })().catch(() => {});
  return fontsP;
}

let lottieLib = null;
/** lottie-web 的轻量版，按需加载（只在要播官方 Lottie 时才取，主包不带）。 */
export function lottieLibrary() {
  lottieLib ||= import('lottie-web/build/player/lottie_light.js').then((m) => m.default || m).catch(() => null);
  return lottieLib;
}

/** Lottie 默认是黑色描边：按宿主当前文字色重染（官方也是跟着前景色走）。 */
export function recolorLottie(data, el) {
  const m = getComputedStyle(el).color.match(/[\d.]+/g) || [0, 0, 0];
  const rgba = [m[0] / 255, m[1] / 255, m[2] / 255, 1];
  const d = JSON.parse(JSON.stringify(data));
  const shape = (s) => { if ((s.ty === 'fl' || s.ty === 'st') && s.c && s.c.k && !s.c.a) s.c.k = rgba; if (Array.isArray(s.it)) s.it.forEach(shape); };
  const layer = (l) => { if (l.ty === 4 && Array.isArray(l.shapes)) l.shapes.forEach(shape); if (Array.isArray(l.layers)) l.layers.forEach(layer); };
  (d.layers || []).forEach(layer);
  (d.assets || []).forEach(layer);
  return d;
}

/**
 * 在 host 里挂一段官方 Lottie（停在第 0 帧），返回动画实例或 null。
 * opts.autoplay / opts.loop 同 lottie-web。
 */
export async function mountLottie(host, name, opts = {}) {
  if (!host) return null;
  const [lib, data] = await Promise.all([lottieLibrary(), lottieData(name)]);
  if (!lib || !data || !host.isConnected) return null;
  host.innerHTML = '';
  const a = lib.loadAnimation({
    container: host, renderer: 'svg', loop: !!opts.loop, autoplay: !!opts.autoplay,
    animationData: recolorLottie(data, host),
    rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: false },
  });
  if (!opts.autoplay) a.addEventListener('DOMLoaded', () => a.goToAndStop(0, true));
  return a;
}
