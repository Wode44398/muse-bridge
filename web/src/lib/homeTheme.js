// 主页明暗换场（点 THE BRIDGE）：暗 A（流光 flux）⇄ 明 B（静态风景）。
//
// 【2026-09-26 重做】旧版是「整屏收成中间一个方块 → 停一拍 → 方块再放开 →（暗→明）粒子显影」，
// 暗→明全程 ~4 秒，且点下去的头一秒在后台建粒子点云、画面纹丝不动；明→暗是一块黑方块
// 收拢再撑开。脚手架比内容还长，这是「粗糙」的根子。
// 现在只做一件事：新主题从标题那一点以柔边圆波铺开，~1 秒，一个焦点（编排见 pageMorph.morphTheme）。
// 粒子显影仍保留在冷启动预载的慢路径里（那里屏幕本来就得空等）。
import { tick } from 'svelte';
import { ui, setHomeMode, canUseHomeMode } from './state.svelte.js';
import { wp, wpDef } from './wallpaper.svelte.js';
import { morphTheme, homeWallpaperReady } from './pageMorph.js';
import { showToast } from './toast.svelte.js';
import { t } from './i18n.js';

// 目标壁纸先解码好：新画面拍快照那一刻图就得在，否则波前后面先是一片底色、图再「啪」地出现。
const decoded = new Set();
function decodeWallpaper(mode) {
  const w = wpDef(wp[mode === 'B' ? 'light' : 'dark']);
  if (!w || w.dyn || !w.url || decoded.has(w.url)) return Promise.resolve();
  return new Promise((res) => {
    const im = new Image();
    const ok = () => { decoded.add(w.url); res(); };
    im.onload = () => (im.decode ? im.decode().then(ok, ok) : ok());
    im.onerror = res;
    im.src = w.url;
  });
}

export function switchHomeTheme(originEl) {
  if (ui.themeTransition || ui.morphing) return;
  const next = ui.glassMode === 'A' ? 'B' : 'A';
  // iOS 没有流光：暗系统要先在设置里给它选一张静态壁纸，否则换场放完画面不变
  if (!canUseHomeMode(next)) { showToast(t('暗色主页需要先在设置 · 壁纸里选一张图片')); return; }
  ui.themeTransition = { dir: next === 'B' ? 'AtoB' : 'BtoA', phase: 'reveal' };
  const apply = async () => { setHomeMode(next); await tick(); await homeWallpaperReady(400); };
  morphTheme(originEl, apply, { prepare: () => decodeWallpaper(next), toLight: next === 'B' })
    .catch(() => setHomeMode(next))
    .finally(() => { ui.themeTransition = null; });
}

// 启动空闲后把另一套主题的静态壁纸先解码进缓存：第一次换场也不用等图
export function warmThemeWallpapers() {
  const other = ui.glassMode === 'A' ? 'B' : 'A';
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1200));
  idle(() => { decodeWallpaper(other).catch(() => {}); }, { timeout: 4000 });
}
