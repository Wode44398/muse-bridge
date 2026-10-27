// 插件面板（第三方插件清单里的 ui.panel）：当前用户能看到哪些，以及怎么打开。
//
// 桌面设置侧栏、手机设置都按 pluginPanels.list 多出几行；插件开关 / 装卸后总线推 plugins.changed，这里跟着重拉。
// 打开方式：
//   · 网页、桌面壳：嵌在设置里（components/ext/PluginFrame.svelte，不透明源 iframe + 宿主代发请求）；
//   · 手机 App：主 WebView 的原生桥会注入所有帧，iframe 挡不住——交给原生另起一个干净的 WebView 页（AndroidStore.openPluginPage），
//     页面带插件票据（#t=）调接口。旧版 App 没有这个桥就用系统浏览器打开（同样带票）。

import { api } from './api.js';
import { apiUrl } from './server.js';
import { busOn } from './bus.js';
import { isEn } from './i18n.js';

export const pluginPanels = $state({ list: [], loaded: false });

let started = false;
export async function loadPluginPanels() {
  try { const r = await api.get('/api/plugins/panels'); pluginPanels.list = Array.isArray(r?.panels) ? r.panels : []; }
  catch { pluginPanels.list = []; }
  pluginPanels.loaded = true;
}
export function watchPluginPanels() {
  if (started) return;
  started = true;
  loadPluginPanels();
  busOn((ev) => { if (ev?.type === 'plugins.changed') loadPluginPanels(); });
}

export const currentTheme = () => (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
export const hostPlatform = () => (typeof window === 'undefined' ? 'web' : window.AndroidStore ? 'android' : window.BridgeDesktop ? 'desktop' : 'web');
export const inAndroidApp = () => typeof window !== 'undefined' && !!window.AndroidStore;

// 独立打开一个插件页面（which: 'panel' | 'settings'）。返回 false = 打不开（已提示）。
export async function openPluginStandalone(id, { which = 'panel', title = '' } = {}) {
  const r = await api.post('/api/plugins/ticket', { id, which });
  const hash = new URLSearchParams({ t: r.ticket, theme: currentTheme(), lang: isEn() ? 'en' : 'zh', platform: hostPlatform() });
  const url = apiUrl(r.page) + '#' + hash.toString();
  const store = typeof window !== 'undefined' ? window.AndroidStore : null;
  if (store && typeof store.openPluginPage === 'function') { store.openPluginPage(url, String(title || ''), currentTheme() === 'dark'); return true; }
  if (store) { location.assign(url); return true; }
  window.open(url, '_blank', 'noopener');
  return true;
}
