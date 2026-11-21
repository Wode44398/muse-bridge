// 插件页面的跳转落地：bridge.nav.* 与 bridge.composer.prefill 在宿主这头的落点。
//
//   pageNav(plugin, { to, session, rel, ws, app }, { comeBack }) → Promise<boolean>   // 回 true = 跳了
//   （第三参 { comeBack } 是可选扩展，不传时行为不变；语义见下）
//     to: 'session'  → 到 Claude 页打开这个会话（同 agentUi 的 openSessionTarget）
//         'file'     → 把文件推进预览（同 uiReport.handleWsx 的 preview：{ origin:'cloud', rel, ws }，全屏宿主）
//         'app'      → 打开插件应用（pluginApps.openApp）；app 写 '<id>' = 本插件的应用，'<插件>:<id>' = 别的插件的
//         'settings' → 设置 › 扩展 › 功能扩展 里本插件的详情（extensionsNav.openPluginDetail）；成员没有插件详情，退回提示
//         'home'     → 回这个身份的根页（goto(rootScreen())）
//   pageComposer(text, { comeBack }) → void   // = handoffToClaude(text)：跳到 Claude 页、新对话、填好输入框，不代发
//
// comeBack：发起的页面就在这个界面里（PluginFrame：应用分页、工作台标签、插件详情）——跳去会话 / 别的应用 / 交给 Claude 时
// 记下来处，系统返回回到这一页（lib/screenReturn.js），而不是收回入口回主页。手机中转（pluginHostRelay）不带：
// 发起的是原生另起的插件页面，跳走时它已经关了，主 WebView 当时的分页并不是「来处」。
//
// plugin 是宿主认定的「发起页面属于哪个插件」（PluginFrame 的 props、手机中转的请求记录），不是页面自报的；
// 页面给的 session / rel / ws / app 一律当不可信输入：形状不对直接回 false，不拼路径、不猜。
// 文件只是摆到使用者眼前的预览里，页面拿不到内容；读写文件走句柄，与这里无关。
//
// 依赖纪律同 claudeHandoff.js：可能出现在 solo 入口，绝不静态引 agentUi.js；重模块一律动态 import。
import { ui, screenOn, rootScreen } from './state.svelte.js';
import { showToast } from './toast.svelte.js';
import { t } from './i18n.js';
import { gotoScreen, handoffToClaude } from './claudeHandoff.js';
import { setScreenReturn } from './screenReturn.svelte.js';

const PLUGIN_RE = /^[a-z][a-z0-9-]{0,47}$/;
const APP_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
// 会话 id：服务端的会话 id 是 uuid，留点余量也只放字母数字和 . _ - :
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REL_MAX = 1024;
// ws 是项目路径（服务端 scopeCtx → authorizeProjectPath 逐个核对能不能进），可能是绝对路径，这里只挡明显的垃圾
const WS_MAX = 1024;
// 等插件 UI 清单（冷启动刚登录时可能还在路上）最多这么久，同 agentUi 的 openAppTarget
const UI_WAIT_MS = 3000;

const notOpen = () => { showToast(t('这个分页没有对你开放'), 'err'); return false; };

/** 页面给的相对路径：只认文件根下的相对路径——不许 ..、不许控制字符、不许盘符 / UNC / 绝对路径。回规整后的 rel 或 null。 */
export function cleanRel(rel) {
  if (typeof rel !== 'string') return null;
  const s = rel.replace(/\\/g, '/').trim();
  if (!s || s.length > REL_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (/^[A-Za-z]:/.test(s) || s.startsWith('//')) return null;
  const parts = s.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** 应用：'<id>'（本插件）或 '<插件>:<id>'。回应用键 'app:<插件>:<id>' 或 null。 */
export function appKeyOf(plugin, app) {
  if (typeof app !== 'string') return null;
  const s = app.trim();
  const i = s.indexOf(':');
  const p = i < 0 ? String(plugin || '') : s.slice(0, i);
  const id = i < 0 ? s : s.slice(i + 1);
  if (!PLUGIN_RE.test(p) || !APP_ID_RE.test(id)) return null;
  return 'app:' + p + ':' + id;
}

// 记下来处（跳之前调；from 取此刻的 ui.screen——过了 frontGate 的页面就在这一屏上，或在盖着它的设置里）。
// 来处是根页（主页 / 单 agent 模式的根页）不记：照常返回本来就回那儿，还带收回入口的转场；跳到同一页（工作台标签里跳会话）也不记。
async function noteReturn(to) {
  const from = ui.screen;
  if (!from || from === to || from === rootScreen()) return;
  const apps = await import('./pluginApps.svelte.js');
  setScreenReturn(from, to, { valid: () => (apps.isAppKey(from) ? !!apps.appByKey(from) : screenOn(from)) });
}

// 这个身份有没有这个会话：有记录，或者正在跑（刚开的会话头一轮还没落盘，记录查不到）。
// 连不上服务器之类的说不准就当有——交给 Claude 页自己处理（它会读本地缓存）。
async function sessionExists(id) {
  const { api } = await import('./api.js');
  try { await api.session(id); return true; } catch (e) {
    if (e?.status !== 404 && e?.status !== 400) return true;
  }
  try { return !!(await api.active())?.runs?.some((r) => r.sessionId === id); } catch { return true; }
}

async function toSession(session, comeBack) {
  const id = typeof session === 'string' ? session.trim() : '';
  if (!SESSION_RE.test(id)) return false;
  if (!screenOn('claude')) return notOpen();
  // 先查再跳：不存在的 id 交给 Claude 页会静默变成一个空白新对话，看着像跳成功了
  if (!(await sessionExists(id))) { showToast(t('找不到这个会话'), 'err'); return false; }
  if (comeBack) await noteReturn('claude');
  await gotoScreen('claude');
  const { openSession } = await import('./chat.svelte.js');
  await openSession(id);
  return true;
}

async function toFile(rel, ws) {
  const r = cleanRel(rel);
  if (!r) return false;
  const w = typeof ws === 'string' ? ws.trim() : '';
  if (w.length > WS_MAX || /[\u0000-\u001f\u007f]/.test(w)) return false;
  const { openPreview } = await import('./preview.svelte.js');
  openPreview({ origin: 'cloud', rel: r, ws: w }, 0, { host: 'app' });
  return true;
}

async function toApp(plugin, app, comeBack) {
  const key = appKeyOf(plugin, app);
  if (!key) return false;
  const [{ pluginUi }, apps] = await Promise.all([import('./pluginUi.svelte.js'), import('./pluginApps.svelte.js')]);
  for (let waited = 0; !pluginUi.loaded && waited < UI_WAIT_MS; waited += 100) await new Promise((r) => setTimeout(r, 100));
  if (comeBack && apps.appByKey(key)) await noteReturn(key);
  // 盖在页面上的层先收掉（同 gotoScreen）；应用不在了 openApp 自己会提示「这个应用已经不可用了」
  ui.settingsOpen = false; ui.routinesOpen = false; ui.loginOpen = false;
  return !!(await apps.openApp(key));
}

async function toSettings(plugin) {
  const { openPluginDetail, canOpenPluginDetail } = await import('./extensionsNav.svelte.js');
  if (!canOpenPluginDetail()) {
    // 成员的扩展面板里没有插件管理：说清楚找谁，别默默没反应
    showToast(t('插件详情只有这台服务器的管理员能打开'));
    return false;
  }
  ui.routinesOpen = false; ui.loginOpen = false;
  return openPluginDetail(plugin);
}

export async function pageNav(plugin, { to, session, rel, ws, app } = {}, { comeBack = false } = {}) {
  const pid = typeof plugin === 'string' && PLUGIN_RE.test(plugin) ? plugin : '';
  try {
    switch (to) {
      case 'session': return await toSession(session, comeBack);
      case 'file': return await toFile(rel, ws);
      case 'app': return await toApp(pid, app, comeBack);
      case 'settings': return pid ? await toSettings(pid) : false;
      case 'home': await gotoScreen('home'); return true;
      default: return false;
    }
  } catch (e) {
    try { console.warn('[pageNav]', to, e?.message || e); } catch {}   // i18n-ignore 只进控制台
    return false;
  }
}

// 回 void：调用方都不等它。带 comeBack 时先记来处再交——noteReturn 第一句就同步读了此刻的 ui.screen，
// 交给 Claude 排在它记完之后，顺序和先 await 记完再交一样
export function pageComposer(text, { comeBack = false } = {}) {
  if (!comeBack) { handoffToClaude(text); return; }
  // 交给 Claude 被拒（分页没开放 / 没登录）就不会到 Claude 页：记录到期自己作废（screenReturn.js）
  noteReturn('claude').catch(() => {}).then(() => handoffToClaude(text));
}
