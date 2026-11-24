// 独立分页窗口（?page=<key>）的前端状态与双轨操作（桌面壳独立 BrowserWindow / 网页新标签页）。
import { normalizePageKey, parseWindowPage, pageWindowUrl } from './windowPageCore.js';
import { isOffline } from './server.js';
import { t } from './i18n.js';

const D = typeof window !== 'undefined' ? window.BridgeDesktop : null;

export const WINDOW_PAGE = typeof window !== 'undefined'
  ? parseWindowPage({ bridgePageKey: D?.window?.pageKey || '', search: location.search })
  : '';

export const isPageWindow = () => Boolean(WINDOW_PAGE);
export const hasDesktopPageWindows = () => Boolean(D?.window?.openPage);

// 桌面壳只有支持 window.openPage 的新版才显示「在独立窗口中打开」（老壳不退回 window.open，避免被外部浏览器接管）；
// 网页端在非离线 apk 且非触屏设备上显示「在新标签页中打开」。
export function canOpenPageInWindow() {
  if (D) return Boolean(D.window?.openPage);
  if (typeof window === 'undefined' || isOffline()) return false;
  try {
    if (window.AndroidStore) return false;
    return matchMedia('(pointer: fine)').matches;
  } catch {
    return false;
  }
}

// 桌面壳当前已打开的独立分页窗口快照：{ counts: { [key]: number }, items: [...] }
export const pageWindows = $state({ counts: {}, items: [] });

let subscribed = false;
function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  pageWindows.counts = snap.counts && typeof snap.counts === 'object' ? { ...snap.counts } : {};
  pageWindows.items = Array.isArray(snap.items) ? snap.items : [];
}

export function initPageWindowsWatch() {
  if (subscribed || !D?.window?.listPages) return;
  subscribed = true;
  D.window.listPages().then(applySnapshot).catch(() => {});
  D.window.onPagesChanged?.(applySnapshot);
}

export function pageWindowCount(key) {
  const k = normalizePageKey(key);
  return k ? Number(pageWindows.counts[k] || 0) : 0;
}

export function pageTitleFor(key, fallback = '') {
  const k = normalizePageKey(key);
  switch (k) {
    case 'claude': return 'Claude';
    case 'chatgpt': return 'ChatGPT';
    case 'agy': return 'Antigravity';
    case 'harness': return 'dimensio';
    case 'studio': return 'Media Studio';
    case 'files': return t('工作空间');
    default: return fallback || 'The Bridge';
  }
}

export async function openPageInWindow(key, { title = '', bg = '' } = {}) {
  const k = normalizePageKey(key);
  if (!k) return false;
  if (D?.window?.openPage) {
    const res = await D.window.openPage({ key: k, title: title || pageTitleFor(k), bg }).catch(() => null);
    return Boolean(res?.ok);
  }
  if (typeof window === 'undefined') return false;
  const url = pageWindowUrl(k, location.href);
  if (!url) return false;
  try {
    window.open(url, '_blank', 'noopener');
    return true;
  } catch {
    return false;
  }
}

export function focusPageWindow(key) {
  const k = normalizePageKey(key);
  if (!k || !D?.window?.focusPage) return Promise.resolve(false);
  return D.window.focusPage(k).then((r) => Boolean(r?.ok)).catch(() => false);
}

export function closePageWindow(key) {
  const k = normalizePageKey(key);
  if (!k || !D?.window?.closePage) return Promise.resolve(false);
  return D.window.closePage(k).then((r) => Boolean(r?.ok)).catch(() => false);
}

export function focusMainWindow() {
  if (!D?.window?.focusMain) return Promise.resolve(false);
  return D.window.focusMain().then((r) => Boolean(r?.ok)).catch(() => false);
}

export function routeToPageWindow(payload) {
  if (!D?.window?.routeToPage) return Promise.resolve({ ok: false });
  return D.window.routeToPage(payload || {}).catch(() => ({ ok: false }));
}

export function onRouteToPage(fn) {
  if (!D?.window?.onRouteAction || typeof fn !== 'function') return () => {};
  return D.window.onRouteAction(fn);
}
