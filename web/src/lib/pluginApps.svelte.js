// 插件应用（主页图标 + 自己的全屏分页）的前端工具函数。数据来自 pluginUi.apps（GET /api/plugins/ui 的 apps）。
//
// 应用键 'app:<插件>:<应用>' 同时是 ui.screen 的取值、主页布局（prefs.homeLayout）里的键、pageMorph 找根盒 / 落点用的键。
// apps 项：{ key, plugin, pluginName, id, title, kind: 'page' | 'view', page, icon: { light, dark } | { name }, order, badge, who }
import { ui, me } from './state.svelte.js';
import { pluginUi } from './pluginUi.svelte.js';
import { openPluginStandalone, inAndroidApp } from './pluginPanels.svelte.js';
import { openPage } from './pageMorph.js';
import { apiUrl } from './server.js';
import { showToast } from './toast.svelte.js';
import { t, tr } from './i18n.js';

const PREFIX = 'app:';
export const isAppKey = (k) => typeof k === 'string' && k.startsWith(PREFIX);
export const appKey = (a) => PREFIX + a.plugin + ':' + a.id;
/** 'app:<插件>:<应用>' → { plugin, id }；形状不对回 null（插件 id 与应用 id 都不含冒号，按第一个冒号切）。 */
export const parseAppKey = (k) => {
  if (!isAppKey(k)) return null;
  const m = /^app:([a-z][a-z0-9-]{0,47}):([a-z][a-z0-9-]{0,31})$/.exec(k);
  return m ? { plugin: m[1], id: m[2] } : null;
};

/** 在已加载的 pluginUi.apps 里找；没加载完和真没有都回 null（要分清的看 pluginUi.loaded）。 */
export function appByKey(key) {
  if (!isAppKey(key)) return null;
  return pluginUi.apps.find((a) => (a.key || appKey(a)) === key) || null;
}

/**
 * 图片图标的地址（light = 显示它的界面是浅色：主页明亮主题 glassMode B、浅色设置页）。
 * 服务端给的是 '/plugins/<插件>/web/…'，这里按服务器地址补全（离线 App 跨源）。内置图标名回 null，调用方用 uiIcon(name) 画。
 */
export function appIconUrl(app, light) {
  const ic = app?.icon;
  if (!ic || typeof ic !== 'object' || ic.name) return null;
  const p = String((light ? ic.light : ic.dark) || ic.light || ic.dark || '');
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return /^\/(?!\/)/.test(p) ? apiUrl(p) : null;
}

/** appKey → { file? }：打开应用时带进去的上下文（「用 X 打开」的文件），PluginAppPage 传给 PluginFrame。 */
export const appContexts = $state({});

/**
 * 打开一个应用。appOrKey = apps 项或应用键。
 * 手机 App 里页面型应用走原生干净页（App 的 JS 桥对所有帧可见，绝不内嵌第三方 iframe）；其余在主界面里开全屏分页。
 * 声明式应用（kind:'view'）在手机 App 里也走主界面分页：它不跑第三方代码，积木由 bridge 自己的组件画（AppView），没有要隔离的东西。
 * 回 true = 打开了（或交给了原生页）；false = 没登录 / 应用不在了 / 签票失败。
 */
export async function openApp(appOrKey, { from = null, radius = 30, context = null } = {}) {
  if (me.kind === 'none') { ui.loginOpen = true; return false; }
  const key = typeof appOrKey === 'string' ? appOrKey : appOrKey ? (appOrKey.key || appKey(appOrKey)) : '';
  // 以最新下发的为准（传进来的可能是旧快照）；列表里没有但调用方给了完整的项（还没加载完的冷启动）就先用它
  const app = appByKey(key) || (typeof appOrKey === 'object' && appOrKey?.plugin && appOrKey?.id ? appOrKey : null);
  // 普通提示（同 App.svelte 的撤销守卫）：应用被撤了是告知，不是能「问 Claude」诊断的报错
  if (!app) { showToast(t('这个应用已经不可用了')); return false; }
  const kind = app.kind || 'page';
  if (inAndroidApp() && kind === 'page') {
    try { await openPluginStandalone(app.plugin, { which: 'app', app: app.id, title: app.title || '', context }); return true; }
    catch (e) { showToast(tr(e?.body?.error || e?.message || '') || t('插件页面打不开'), 'err'); return false; }
  }
  if (context) appContexts[key] = context;
  await openPage(key, { from, radius });
  return true;
}
