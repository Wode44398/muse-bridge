// 插件界面扩展（插件接口四期第三批，服务端 src/plugins/ui.mjs）的数据层：插件经 ctx.ui.* 往 bridge 自己的界面里加东西。
//
// 原则：手机 App 不跑第三方代码。除了工作台标签（插件页面，不透明源 iframe / App 里原生干净页）之外全是【声明】——
// 插件给标题、图标、文字，bridge 自己画；按下去调 POST /api/plugins/ui/run，由服务端执行插件的 handler。
//
//   GET /api/plugins/ui?lang=zh|en → { homeCards, workbench, commands, composerActions, messageActions, sessionActions, theme }
//   登记一变服务端推 { type: 'plugins.ui' }（插件开关 / 装卸推 plugins.changed），这里跟着重拉。
//
// 各插槽：主页卡片（components/PluginHomeCards）、Claude 工作台标签（lib/dock + components/dock/PluginWorkbench）、
// 输入框「/」菜单与「＋」菜单（Composer / SlashMenu / AddMenu）、消息操作菜单（Thread）、会话列表菜单（ClaudePage）、
// 主题变量（本文件 applyTheme）。只给 Claude 分页做（dimensio 是另一套前端）。
import { api } from './api.js';
import { apiUrl } from './server.js';
import { busOn } from './bus.js';
import { isEn, t, tr } from './i18n.js';
import { showToast } from './toast.svelte.js';
import { uiConfirm } from './dialogs.js';
import { prefillComposer } from './composerBridge.svelte.js';
import { openPluginStandalone, inAndroidApp } from './pluginPanels.svelte.js';
import { openSettings } from './settingsNav.svelte.js';
import { isNativeDesktop, desktopOpenExternal } from './nativeDesktop.js';
import { pluginIcon } from './pluginIcons.js';

const EMPTY = () => ({ homeCards: [], workbench: [], commands: [], composerActions: [], messageActions: [], sessionActions: [], theme: {} });
export const pluginUi = $state({ ...EMPTY(), loaded: false });

const arr = (v) => (Array.isArray(v) ? v : []);

// ── 拉取 ──────────────────────────────────────────────────────────────────
let who = '';            // 当前身份（kind:user）；变了就重拉，退出登录就清空
let inflight = null;
let again = false;
export async function loadPluginUi() {
  if (!who) return;
  if (inflight) { again = true; return inflight; }
  inflight = (async () => {
    do {
      again = false;
      const forWho = who;
      try {
        const r = await api.get('/api/plugins/ui?lang=' + (isEn() ? 'en' : 'zh'));
        if (forWho !== who) continue;   // 拉的途中换了人：结果作废，循环再拉一次（again 已由 sync 置上）
        pluginUi.homeCards = arr(r?.homeCards);
        pluginUi.workbench = arr(r?.workbench);
        pluginUi.commands = arr(r?.commands);
        pluginUi.composerActions = arr(r?.composerActions);
        pluginUi.messageActions = arr(r?.messageActions);
        pluginUi.sessionActions = arr(r?.sessionActions);
        pluginUi.theme = r?.theme && typeof r.theme === 'object' ? r.theme : {};
        pluginUi.loaded = true;
        applyTheme(pluginUi.theme);
      } catch (e) {
        // 没登录 / 旧服务端（没有这条接口）：当作什么都没有；断网：留着上一份（离线也照样画，按下去才报错）
        if (e?.status === 401 || e?.status === 403 || e?.status === 404) clearAll();
      }
    } while (again);
  })().finally(() => { inflight = null; });
  return inflight;
}

function clearAll() {
  Object.assign(pluginUi, EMPTY());
  pluginUi.loaded = false;
  applyTheme({});
}

let watching = false;
/** 身份变了时调（App 根上的 $effect）：key = 'kind:user'，没登录传 ''。 */
export function syncPluginUi(key) {
  if (!watching) {
    watching = true;
    busOn((ev) => { if (ev?.type === 'plugins.ui' || ev?.type === 'plugins.changed') loadPluginUi(); });
  }
  const k = String(key || '');
  if (k === who) return;
  who = k;
  if (!k) { clearAll(); return; }
  again = true;
  loadPluginUi();
}

// ── 主题变量（ctx.ui.theme）─────────────────────────────────────────────
// 设到 <html> 的 style 上；记下每个变量原来的行内值，插件撤掉 / 改了主题时只撤自己设过的（原来有就还原）。
const applied = new Map();   // '--名字' → 设之前的行内值（'' = 原来没有）
const VAR_RE = /^--[a-zA-Z0-9-]{1,40}$/;
function applyTheme(vars) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const next = vars && typeof vars === 'object' ? vars : {};
  for (const [k, prev] of [...applied]) {
    if (Object.prototype.hasOwnProperty.call(next, k)) continue;
    if (prev) root.style.setProperty(k, prev); else root.style.removeProperty(k);
    applied.delete(k);
  }
  for (const [k, v] of Object.entries(next)) {
    if (!VAR_RE.test(k)) continue;
    const val = String(v ?? '');
    if (/[;{}<>]|url\s*\(|expression\s*\(|javascript:/i.test(val)) continue;   // 服务端已滤过，这里再兜一层
    if (!applied.has(k)) applied.set(k, root.style.getPropertyValue(k));
    root.style.setProperty(k, val);
  }
}

// ── 工作台标签 ─────────────────────────────────────────────────────────────
// 工作台的卡片键：'plg:<插件>:<id>'（内置六件是 term / review / …，不会撞）
export const WB_PREFIX = 'plg:';
export const isPluginView = (k) => typeof k === 'string' && k.startsWith(WB_PREFIX);
export const workbenchKey = (w) => WB_PREFIX + w.plugin + ':' + w.id;
export const workbenchByKey = (k) => (isPluginView(k) ? pluginUi.workbench.find((w) => workbenchKey(w) === k) || null : null);
export const workbenchKeys = () => pluginUi.workbench.map(workbenchKey);
export const uiIcon = (name) => pluginIcon(name || 'plugin');

/** 手机 App 里打开工作台标签：签票后交给原生另起的干净页面（App 的 JS 桥对所有帧可见，绝不内嵌第三方 iframe）。 */
export async function openWorkbenchStandalone(w, context) {
  try { await openPluginStandalone(w.plugin, { which: 'workbench', page: w.page, title: w.title, context }); }
  catch (e) { showToast(tr(e?.body?.error || e?.message || '') || t('插件页面打不开'), 'err'); }
}

// ── 「/」命令 ─────────────────────────────────────────────────────────────
/** 插件命令里按查询过滤（与内置命令同一套：前缀命中在前，名字 / 描述包含在后）。 */
export function filterPluginCommands(q) {
  const s = String(q || '').toLowerCase();
  const list = pluginUi.commands.filter((c) => c && c.name);
  if (!s) return list.slice(0, 20);
  const starts = [], incl = [];
  for (const c of list) {
    const n = c.name.toLowerCase();
    if (n.startsWith(s)) starts.push(c);
    else if (n.includes(s) || String(c.description || '').toLowerCase().includes(s) || String(c.pluginName || '').toLowerCase().includes(s)) incl.push(c);
  }
  return [...starts, ...incl].slice(0, 20);
}
/** 输入框整段是「/名字 后面的文字」且名字是插件的 action 命令 → { cmd, args }；否则 null（照常发给 Claude）。 */
export function matchPluginAction(text) {
  const m = /^\s*\/([a-z][a-z0-9-]{0,31})(?:\s+([\s\S]*))?$/.exec(String(text || ''));
  if (!m) return null;
  const cmd = pluginUi.commands.find((c) => c.name === m[1] && c.mode === 'action');
  return cmd ? { cmd, args: (m[2] || '').trim() } : null;
}

// ── 按下一个界面动作 ───────────────────────────────────────────────────────
// kind: 'command' | 'composerAction' | 'messageAction' | 'sessionAction'；item 是 /api/plugins/ui 下发的那一项。
// 回 { toast?, insert?, send?, open? }：insert = 换掉输入框里的文字（send 为真就顺手发出）；open 'panel' = 插件的控制面板；open 网址 = 外部打开。
export async function runPluginUi(item, kind, args = {}) {
  if (!item) return null;
  try {
    const r = await api.post('/api/plugins/ui/run', { plugin: item.plugin, kind, id: kind === 'command' ? item.name : item.id, args: { agent: 'claude', ...args } });
    await applyRunResult(item, r || {});
    return r || {};
  } catch (e) {
    showToast(tr((e?.body && typeof e.body === 'object' ? e.body.error : e?.body) || '') || t('插件动作没有执行成功'), 'err');
    return null;
  }
}

async function applyRunResult(item, r) {
  if (typeof r.insert === 'string') prefillComposer(r.insert, { send: r.send === true });
  if (r.open === 'panel') await openPluginPanel(item.plugin, item.pluginName);
  else if (typeof r.open === 'string' && r.open) openExternalUrl(r.open);
  if (typeof r.toast === 'string' && r.toast) showToast(r.toast);
}

/** 打开插件的控制面板：网页 / 桌面壳 = 设置里那一页（嵌 PluginFrame）；手机 App = 原生干净页面。 */
export async function openPluginPanel(plugin, title = '') {
  if (inAndroidApp()) {
    try { await openPluginStandalone(plugin, { title }); }
    catch (e) { showToast(tr(e?.body?.error || e?.message || '') || t('插件页面打不开'), 'err'); }
    return;
  }
  openSettings('plg-' + plugin);
}

/** 插件给的网址：http(s) 外部打开；站内 / 开头的按服务器地址补全（离线 App 跨源）。 */
export function openExternalUrl(url) {
  const s = String(url || '');
  let full = '';
  if (/^https?:\/\//i.test(s)) full = s;
  else if (/^\/(?!\/)/.test(s)) full = apiUrl(s);
  if (!full) return;
  if (isNativeDesktop()) { desktopOpenExternal(full); return; }
  window.open(full, '_blank', 'noopener');
}

// ── 主页卡片 ───────────────────────────────────────────────────────────────
/** 点一张主页卡片：open = { panel } | { action } | { url } | null。action 走插件的 ctx.action 按钮（只有主机能按）。 */
export async function openHomeCard(card) {
  const o = card?.open;
  if (!o) return;
  if (o.panel) { await openPluginPanel(card.plugin, card.pluginName); return; }
  if (o.url) { openExternalUrl(o.url); return; }
  if (!o.action) return;
  // 按钮声明了 confirm / danger 的先问一句（拿不到动作表就直接按）
  try {
    const list = await api.get('/api/plugin/' + encodeURIComponent(card.plugin) + '/_bridge/actions');
    const a = arr(list?.actions).find((x) => x.id === o.action);
    if (a && (a.confirm || a.danger)) {
      const ok = await uiConfirm(t('要执行「{label}」吗？', { label: a.label || o.action }), { detail: String(a.confirm || a.desc || ''), okLabel: String(a.label || t('确定')), type: a.danger ? 'warning' : 'question' });
      if (!ok) return;
    }
  } catch {}
  try {
    const r = await api.post('/api/plugins/action', { id: card.plugin, action: o.action });
    showToast(typeof r?.message === 'string' && r.message ? r.message : t('已执行'));
  } catch (e) {
    showToast(tr((e?.body && typeof e.body === 'object' ? e.body.error : e?.body) || '') || t('插件动作没有执行成功'), 'err');
  }
  loadPluginUi();   // 卡片上的数字多半跟着变
}
