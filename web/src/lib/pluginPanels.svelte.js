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
import { isEn, tr } from './i18n.js';

export const pluginPanels = $state({ list: [], loaded: false });

// 面板标题：英文界面有插件自带的英文标题（清单 ui.panel.titleEn）就用它，否则照旧查 bridge 的字典
export const panelTitle = (p) => (p ? (isEn() && p.titleEn ? p.titleEn : tr(p.title || '')) : '');

// ── 插件自带的英文词条（插件目录 locales/en.json → /api/plugins 每项的 i18n.en）──
// 第三方插件没法往 bridge 的英文字典里加词：英文界面按「字段路径」取它自带的词条，没有再退回 tr(中文)。
// 路径写法：'name'、'description'、'ui.panel.title'、'config.<字段>.label'（也可传数组，键里带点时用）。
const enPick = (p, path) => {
  let v = p?.i18n?.en;
  for (const k of Array.isArray(path) ? path : String(path || '').split('.')) {
    if (!v || typeof v !== 'object') return '';
    v = v[k];
  }
  return typeof v === 'string' && v.trim() ? v : '';
};
export const plText = (p, path, zh) => (isEn() && enPick(p, path)) || tr(zh || '');

// 配置 schema 叠上英文词条（只换展示用的 label / desc / section / placeholder，类型与规则不动），给自动表单用。
// en.json 里 config 的写法与 schema 同构：{ 字段: { label, desc, section, placeholder,
//   fields: { 子字段: {…} }, items: {…}, key: {…}, value: {…}, enum: { 取值: '英文名' } } }
const SPEC_TEXT = ['label', 'desc', 'section', 'placeholder'];
function enSpec(s, e) {
  if (!s || typeof s !== 'object' || !e || typeof e !== 'object') return s;
  const o = { ...s };
  for (const k of SPEC_TEXT) if (typeof e[k] === 'string' && e[k].trim()) o[k] = e[k];
  if (s.fields && e.fields) o.fields = enFields(s.fields, e.fields);
  for (const k of ['items', 'key', 'value']) if (s[k] && e[k]) o[k] = enSpec(s[k], e[k]);
  if (Array.isArray(s.enum) && e.enum && typeof e.enum === 'object') {
    o.enum = s.enum.map((x) => {
      const obj = x && typeof x === 'object';
      const l = e.enum[String(obj ? x.value : x)];
      return typeof l === 'string' && l.trim() ? { ...(obj ? x : {}), value: obj ? x.value : x, label: l } : x;
    });
  }
  return o;
}
function enFields(fields, en) {
  const out = {};
  for (const [k, s] of Object.entries(fields || {})) out[k] = enSpec(s, en && typeof en === 'object' ? en[k] : null);
  return out;
}
export const plSchema = (p) => {
  const en = isEn() ? p?.i18n?.en?.config : null;
  return en && typeof en === 'object' ? enFields(p?.schema, en) : p?.schema || {};
};

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
