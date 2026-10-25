// agent 的界面指令（取代旧全局助手的 navigate）：服务端经账号总线（/api/stream）发
//   { type:'ui.cmd', id, at, client?, op:'open'|'toast', target?, text? }
// 这里把它落成用户眼前的界面动作。App.svelte 的 busOn 转来（只有主界面挂；分屏格 / 拖出的独立窗口是 solo 入口，不挂 App）。
//   · client：只让这个客户端执行（= uiReport.js 的 uiClientId）；不带 = 收到的每一端都执行。
//   · 按 id 去重；at 超过 60 秒的旧指令丢弃（同 uiReport.handleWsx 的口径——总线断线重连不重放，但同源多实例转发可能重复）。
//   · op:'toast' → showToast(text)
//   · op:'open' 的 target：
//       { page, section? }           换页（page ∈ home/claude/files/routines/settings/dimensio；settings 的 section = 设置分区名）
//       { session }                  到 Claude 页打开这个会话
//       { file }                     把工作空间里的文件推进预览（复用 handleWsx 的 preview）
//       { folder }                   打开文件页并定位到这个文件夹（复用 handleWsx 的 goto）
// 依赖纪律：只静态 import 轻模块（state / toast / i18n / uiReport）；换页、聊天内核、设置导航一律动态 import。
import { ui, screenOn, rootScreen } from './state.svelte.js';
import { showToast } from './toast.svelte.js';
import { t, tr } from './i18n.js';
import { handleWsx, uiClientId } from './uiReport.js';

const seen = new Set();
const MAX_AGE = 60_000;

// 对外的 page 名 → 前端顶层页面（ui.screen）
const PAGE_SCREEN = { home: 'home', claude: 'claude', files: 'files', dimensio: 'harness', harness: 'harness' };
// 设置外壳认的分区名（lib/settingsNav 的 openSettings）；外壳里没有的落首页
const SETTINGS_SECS = new Set(['general', 'account', 'agents', 'claude', 'providers', 'agentapi', 'agent-api', 'connection',
  'dimensio', 'android', 'feedback', 'about']);

const notOpen = () => { showToast(t('这个分页没有对你开放'), 'err'); return false; };

async function gotoScreen(screen) {
  const { goto } = await import('./pageMorph.js');
  // 盖在页面上的层先收掉：设置 / 定时任务 / 登录卡挡着，换了页用户也看不见
  ui.settingsOpen = false; ui.routinesOpen = false; ui.loginOpen = false;
  await goto(screen === 'home' ? rootScreen() : screen);
}

async function openPageTarget({ page, section }) {
  const p = String(page || '').toLowerCase();
  if (p === 'settings') {
    const { openSettings } = await import('./settingsNav.svelte.js');
    let sec = SETTINGS_SECS.has(String(section || '')) ? String(section) : null;
    if (sec === 'agent-api') sec = 'agentapi';
    ui.routinesOpen = false; ui.loginOpen = false;
    openSettings(sec);
    return true;
  }
  if (p === 'routines') {
    if (!screenOn('claude')) return notOpen();
    await gotoScreen('claude');
    ui.routinesOpen = true;
    return true;
  }
  const screen = PAGE_SCREEN[p];
  if (!screen) return false;
  if (screen !== 'home' && screen !== 'files' && !screenOn(screen)) return notOpen();
  await gotoScreen(screen);
  return true;
}

async function openSessionTarget(id) {
  if (!screenOn('claude')) return notOpen();
  await gotoScreen('claude');
  const { openSession } = await import('./chat.svelte.js');
  await openSession(String(id));
  return true;
}

async function openFolderTarget(cmd, rel) {
  // 先把文件页开出来，让它的面板挂上并订阅 onAgentGoto，再交给 handleWsx 定位；
  // 面板还没挂好时 handleWsx 退回「预置 ui.filesPath」，面板挂载时照样消费
  if (ui.screen !== 'files') {
    await gotoScreen('files');
    await new Promise((r) => setTimeout(r, 120));
  }
  await handleWsx({ op: 'goto', id: cmd.id + ':goto', at: Date.now(), rel, ws: '' });
  return true;
}

export async function handleUiCmd(ev) {
  try {
    if (!ev || ev.type !== 'ui.cmd' || !ev.op) return;
    if (ev.client && ev.client !== uiClientId) return;
    const key = ev.id || (ev.op + ':' + JSON.stringify(ev.target || ev.text || '') + ':' + (ev.at || ''));
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 300) { const it = seen.values(); for (let i = 0; i < 100; i++) seen.delete(it.next().value); }
    if (ev.at && Math.abs(Date.now() - ev.at) > MAX_AGE) return;
    if (ev.op === 'toast') {
      if (ev.text) showToast(tr(String(ev.text)));
      return;
    }
    if (ev.op !== 'open' || !ev.target || typeof ev.target !== 'object') return;
    const tg = ev.target;
    if (tg.session) await openSessionTarget(tg.session);
    else if (tg.file) await handleWsx({ op: 'preview', id: (ev.id || key) + ':preview', at: Date.now(), rel: String(tg.file), ws: '' });
    else if (tg.folder != null && tg.folder !== false) await openFolderTarget({ id: ev.id || key }, String(tg.folder));
    else if (tg.page) await openPageTarget(tg);
  } catch { /* 界面指令失败不影响其它 */ }
}
