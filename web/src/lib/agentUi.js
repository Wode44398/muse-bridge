// agent 的界面指令（取代旧全局助手的 navigate）：服务端经账号总线（/api/stream）发
//   { type:'ui.cmd', id, at, client?, op:'open'|'toast', target?, text? }
// 这里把它落成用户眼前的界面动作。App.svelte 的 busOn 转来（只有主界面挂；分屏格 / 拖出的独立窗口是 solo 入口，不挂 App）。
//   · client：只让这个客户端执行（= uiReport.js 的 uiClientId）；不带 = 收到的每一端都执行。
//   · 按 id 去重；at 超过 60 秒的旧指令丢弃（同 uiReport.handleWsx 的口径——总线断线重连不重放，但同源多实例转发可能重复）。
//   · 执行完拿 id 回执 {ok, reason?}（uiReport.uiAck 补上 client / visible）：点名给本端的必回；广播的只有在前台的一端回，
//     免得后台那几端抢先回「打开了」。服务端 ui.open / ui.notify 等这个回执，没等到就照实说「未确认」。
//   · op:'toast' → showToast(text)
//   · op:'open' 的 target：
//       { page, module?, section? }  换页（page ∈ home/claude/files/routines/settings/chatgpt/dimensio/studio；
//                                    studio 的 module ∈ image/video/voice/music（旧的 page=vertex/gemini 一并落到 studio）；settings 的 section = 设置分区名）
//       { session }                  到 Claude 页打开这个会话
//       { file }                     把工作空间里的文件推进预览（复用 handleWsx 的 preview）
//       { folder }                   打开文件页并定位到这个文件夹（复用 handleWsx 的 goto）
// 依赖纪律：只静态 import 轻模块（state / toast / i18n / uiReport）；换页、聊天内核、设置导航一律动态 import。
import { ui, studioInbox, screenOn, rootScreen } from './state.svelte.js';
import { showToast } from './toast.svelte.js';
import { t, tr } from './i18n.js';
import { handleWsx, uiClientId, uiAck, startUiBeat } from './uiReport.js';

const seen = new Set();
const MAX_AGE = 60_000;

// 本模块只由 App 静态引入（主界面才收 ui.cmd）：在这里开视图心跳，solo 入口不开
startUiBeat();

// 对外的 page 名 → 前端顶层页面（ui.screen）
const PAGE_SCREEN = { home: 'home', claude: 'claude', files: 'files', chatgpt: 'chatgpt', codex: 'chatgpt', dimensio: 'harness', studio: 'studio', vertex: 'studio', gemini: 'studio' };
const STUDIO_PAGES = new Set(['image', 'video', 'voice', 'music']);
// 两套设置外壳都认的分区名（lib/settingsNav 的 openSettings）；外壳里没有的落首页
const SETTINGS_SECS = new Set(['general', 'notify', 'appearance', 'language', 'account', 'about', 'connection', 'devices', 'claude', 'agents',
  'feedback', 'phone', 'shortcuts', 'wallpaper', 'agentapi', 'agent-api', 'extensions', 'policy']);

const notOpen = () => { showToast(t('这个分页没有对你开放'), 'err'); return false; };

async function gotoScreen(screen) {
  const { goto } = await import('./pageMorph.js');
  // 盖在页面上的层先收掉：设置 / 定时任务 / 登录卡挡着，换了页用户也看不见
  ui.settingsOpen = false; ui.routinesOpen = false; ui.loginOpen = false;
  await goto(screen === 'home' ? rootScreen() : screen);
}

// 红字报错提示的「问 Claude」（lib/toast.svelte.js）：开一个新的 Claude 对话，把报错和出错的界面填进输入框，
// 不替用户发出去——用户补一句再发，Claude 按系统提示里「bridge 的 bug」那套诊断、确认后上报。
const SCREEN_LABEL = { home: () => t('主页'), files: () => t('文件'), claude: () => 'Claude', studio: () => 'Media Studio', chatgpt: () => 'Codex', harness: () => 'dimensio' };
export async function askClaudeAboutError(text) {
  if (!screenOn('claude')) return false;
  const where = ui.settingsOpen ? t('设置') : (SCREEN_LABEL[ui.screen]?.() || String(ui.screen || ''));
  await gotoScreen('claude');
  ui.taskDone = false;
  // Claude 页挂着就按它「新对话」的落点规则开；还没挂上时开在默认工作空间（同 App 里桌面快捷键的处理）
  const handled = !window.dispatchEvent(new CustomEvent('bridge:newchat', { cancelable: true }));
  if (!handled) { const { newConversation } = await import('./chat.svelte.js'); newConversation(); }
  const { prefillComposer } = await import('./composerBridge.svelte.js');
  const msg = t('我刚在「{where}」看到这个报错：「{err}」。帮我看看是不是 bridge 出 bug 了；是的话跟我确认后上报。', { where, err: String(text || '').slice(0, 500) });
  // 等新对话的输入栏换好草稿再填，别被「换成新对话那份草稿」冲掉
  setTimeout(() => prefillComposer(msg), 80);
  return true;
}

async function openPageTarget({ page, module, section }) {
  const p = String(page || '').toLowerCase();
  if (p === 'settings') {
    const { openSettings } = await import('./settingsNav.svelte.js');
    const { isNativeDesktop } = await import('./nativeDesktop.js');
    let sec = SETTINGS_SECS.has(String(section || '')) ? String(section) : null;
    if (sec === 'agent-api') sec = 'agentapi';
    // 桌面外壳没有这两页（手机操控、单独的语言页）：落「通用」
    if (sec && isNativeDesktop() && (sec === 'phone' || sec === 'language')) sec = 'general';
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
  // Studio 的创作页先设好再换页：分页此刻藏着时切页看不见，新快照里直接就是目标创作页
  if (screen === 'studio' && STUDIO_PAGES.has(String(module || ''))) studioInbox.items.push({ page: String(module) });
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
// 会话消息通知（lib/notices.svelte.js）：点横幅 / 系统通知 → 打开那个会话；定时任务没有会话时打开定时任务页
export const openSessionFromNotice = (id) => openSessionTarget(id);
export async function openRoutinesFromNotice() {
  if (!screenOn('claude')) return notOpen();
  await gotoScreen('claude');
  ui.routinesOpen = true;
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
  let ack = null;   // 要回执时 = { ok, reason? }
  try {
    if (!ev || ev.type !== 'ui.cmd' || !ev.op) return;
    if (ev.client && ev.client !== uiClientId) return;
    const key = ev.id || (ev.op + ':' + JSON.stringify(ev.target || ev.text || '') + ':' + (ev.at || ''));
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 300) { const it = seen.values(); for (let i = 0; i < 100; i++) seen.delete(it.next().value); }
    if (ev.at && Math.abs(Date.now() - ev.at) > MAX_AGE) return;
    if (ev.id && (ev.client || !document.hidden)) ack = { ok: false };
    if (ev.op === 'toast') {
      if (ev.text) showToast(tr(String(ev.text)));
      if (ack) ack.ok = !!ev.text;
      return;
    }
    if (ev.op !== 'open' || !ev.target || typeof ev.target !== 'object') {
      if (ack) ack.reason = '这个界面不认识这条指令';   // i18n-ignore 回传给 agent 的工具结果（AI 读，服务端拼进中文工具文案）
      return;
    }
    const tg = ev.target;
    let ok = false;
    if (tg.session) ok = await openSessionTarget(tg.session);
    else if (tg.file) { await handleWsx({ op: 'preview', id: (ev.id || key) + ':preview', at: Date.now(), rel: String(tg.file), ws: '' }); ok = true; }
    else if (tg.folder != null && tg.folder !== false) ok = await openFolderTarget({ id: ev.id || key }, String(tg.folder));
    else if (tg.page) ok = await openPageTarget(tg);
    if (ack) {
      ack.ok = ok !== false;
      const p = String(tg.page || '').toLowerCase();
      const unknown = !tg.session && !tg.file && tg.folder == null && !PAGE_SCREEN[p] && p !== 'settings' && p !== 'routines';
      if (!ack.ok) ack.reason = unknown ? '这个界面不认识这个页面' : '这个分页对用户没开';   // i18n-ignore 回传给 agent 的工具结果（AI 读，服务端拼进中文工具文案）
    }
  } catch (e) {
    /* 界面指令失败不影响其它 */
    if (ack) { ack.ok = false; ack.reason = '打开时出错：' + String(e?.message || e).slice(0, 160); }   // i18n-ignore 回传给 agent 的工具结果（AI 读，服务端拼进中文工具文案）
  } finally {
    if (ack) uiAck(ev.id, ack);
  }
}
