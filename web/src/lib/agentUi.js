// agent 的界面指令（取代旧全局助手的 navigate）：服务端经账号总线（/api/stream）发
//   { type:'ui.cmd', id, at, client?, op:'open'|'toast', target?, text? }
// 这里把它落成用户眼前的界面动作。App.svelte 的 busOn 转来（只有主界面挂；分屏格 / 拖出的独立窗口是 solo 入口，不挂 App）。
//   · client：只让这个客户端执行（= uiReport.js 的 uiClientId）；不带 = 收到的每一端都执行。
//   · 按 id 去重；at 超过 60 秒的旧指令丢弃（同 uiReport.handleWsx 的口径——总线断线重连不重放，但同源多实例转发可能重复）。
//   · op:'toast' → showToast(text)
//   · op:'open' 的 target：
//       { page, module?, section? }  换页（page ∈ home/claude/files/routines/settings/chatgpt/dimensio/vertex；
//                                    vertex 的 module ∈ chat/image/video/voice/music；settings 的 section = 设置分区名）
//       { session }                  到 Claude 页打开这个会话
//       { file }                     把工作空间里的文件推进预览（复用 handleWsx 的 preview）
//       { folder }                   打开文件页并定位到这个文件夹（复用 handleWsx 的 goto）
// 依赖纪律：只静态 import 轻模块（state / toast / i18n / uiReport）；换页、聊天内核、设置导航一律动态 import。
import { ui, vertex, screenOn, rootScreen } from './state.svelte.js';
import { showToast } from './toast.svelte.js';
import { t, tr } from './i18n.js';
import { handleWsx, uiClientId } from './uiReport.js';

const seen = new Set();
const MAX_AGE = 60_000;

// 对外的 page 名 → 前端顶层页面（ui.screen）
const PAGE_SCREEN = { home: 'home', claude: 'claude', files: 'files', chatgpt: 'chatgpt', codex: 'chatgpt', dimensio: 'harness', vertex: 'vertex', gemini: 'vertex' };
const VERTEX_MODULES = new Set(['chat', 'image', 'video', 'voice', 'music']);
// 两套设置外壳都认的分区名（lib/settingsNav 的 openSettings）；外壳里没有的落首页
const SETTINGS_SECS = new Set(['general', 'appearance', 'language', 'account', 'about', 'connection', 'devices', 'claude', 'agents',
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
const SCREEN_LABEL = { home: () => t('主页'), files: () => t('文件'), claude: () => 'Claude', vertex: () => 'Gemini', chatgpt: () => 'Codex', harness: () => 'dimensio' };
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
  // Gemini 的模块先设好再换页：分页此刻藏着时改模块看不见，新快照里直接就是目标模块
  if (screen === 'vertex' && VERTEX_MODULES.has(String(module || ''))) vertex.func = module;
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
