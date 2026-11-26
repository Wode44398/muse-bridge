// 会话消息通知（前端，2026-11-07）：像微信那样，每个会话单独一条，带会话名、铃声与震动。
//
// 来源是服务端的 {type:'notice'}（src/runtime/notices.mjs）：提问 / 权限审批 / 完成 / 出错 / 定时任务 / 模型推送，
// 账号总线实时推来。这里决定怎么提醒：
//   · 人正看着这个会话（Claude 页、页面可见、设置没盖着）→ 什么都不做（同微信：正在聊的那个人不响）；
//   · 页面在前台、看的是别处 → 顶部横幅（NoticeBanner.svelte）+ 铃声 / 震动；
//   · 页面在后台 → 手机 App 交给原生（MsgNotify：按会话一条、MessagingStyle、自己放铃声震动）；
//     浏览器用系统 Notification（tag = 会话，同一会话后来的替换前面的）；桌面壳由主进程自己弹（agent-watch）。
// 手机 App 真正可靠的后台通知靠原生服务 AgentService 轮询 /api/active 的 notices——JS 被冻住时它照样弹；
// 两边同一条通知按 id 去重（MsgNotify 在进程里记账）。
//
// 设置（设置 › 通用 › 通知）：总开关沿用 bridge-notify；四类开关沿用 Claude 设置里的本机项
// （cs.device.notifyQuestion / notifyPermission / notifyTaskComplete / notifyError，两处改的是同一份）；
// 声音、提示音、震动、详情预览、横幅、后台常驻存 localStorage 的 bridge-msg-notify，并同步一份给原生
// （AndroidStore.set 同名键，原生后台服务现读）。
import { untrack } from 'svelte';
import { ui, session } from './state.svelte.js';
import { cs, setClaudeDeviceSetting } from './claudeSettings.svelte.js';
import { busOn } from './bus.js';
import { api } from './api.js';
import { t, tr } from './i18n.js';
import { isNativeDesktop } from './nativeDesktop.js';
import { WINDOW_PAGE, isPageWindow, hasDesktopPageWindows, routeToPageWindow } from './windowPage.svelte.js';

const LS = 'bridge-msg-notify';
const DEF = { preview: true, sound: true, tone: 'system', toneUri: '', toneName: '', vibrate: true, vibe: 'double', inApp: true, keepAlive: false };
const A = () => { try { return window.AndroidStore || null; } catch { return null; } };
const loadPrefs = () => { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(LS)) || {}) }; } catch { return { ...DEF }; } };
const masterOn = () => { try { return localStorage.getItem('bridge-notify') !== '0'; } catch { return true; } };

export const np = $state({ ...loadPrefs(), on: masterOn() });
// 前台横幅（最新的在最前，最多叠 3 条）
export const banners = $state({ list: [] });

// 平台能力
export const nativeNotices = () => !!A()?.postSessionNotice;          // 手机 App（新原生）
export const canVibrate = () => nativeNotices() || (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' && !isNativeDesktop());
export const canPickPhoneTone = () => !!A()?.pickNoticeTone;

// 提示音：默认 = 系统通知声音（手机放的是手机自己的通知提示音，跟系统的铃声模式与免打扰走）。
// 网页 / 电脑窗口在前台时拿不到操作系统的提示音，system 与 custom 退回内置的「清脆」（最轻的一声）。
export const TONES = [
  { id: 'ding', label: () => t('清脆') },
  { id: 'drop', label: () => t('水滴') },
  { id: 'pop', label: () => t('嘀嘀') },
];
export const VIBES = [
  { id: 'short', label: () => t('短振一下') },
  { id: 'double', label: () => t('振两下') },
  { id: 'long', label: () => t('长振') },
];
const VIBE_MS = { short: [160], double: [110, 90, 110], long: [420] };

export function toneLabel() {
  if (np.tone === 'custom') return np.toneName || t('手机里的提示音');
  const x = TONES.find((v) => v.id === np.tone);
  return x ? x.label() : t('系统通知声音');
}

// 分类开关（与 设置 › Claude › 通知 同一份）
const KIND_KEY = { question: 'notifyQuestion', permission: 'notifyPermission', done: 'notifyTaskComplete', error: 'notifyError' };
export const kindOn = (kind) => np.on && (!KIND_KEY[kind] || cs.device?.[KIND_KEY[kind]] !== false);
export function setKind(kind, v) { if (KIND_KEY[kind]) setClaudeDeviceSetting(KIND_KEY[kind], !!v); syncNative(); }
export const kindValue = (kind) => cs.device?.[KIND_KEY[kind]] !== false;

function save() {
  const { on, ...rest } = np;
  try { localStorage.setItem(LS, JSON.stringify(rest)); } catch {}
  syncNative();
}
export function setNoticePref(key, value) {
  if (key === 'on') {
    np.on = !!value;
    try { localStorage.setItem('bridge-notify', value ? '1' : '0'); } catch {}
    syncNative();
    keepAliveKick();
    return;
  }
  np[key] = value;
  save();
  if (key === 'keepAlive') keepAliveKick();
}

// 原生后台服务现读的那一份（SharedPreferences "bridge" 的 bridge-msg-notify）
function syncNative() {
  const a = A();
  if (!a || !a.set) return;
  try {
    a.set('bridge-msg-notify', JSON.stringify({
      on: np.on, preview: np.preview, sound: np.sound, tone: np.tone, toneUri: np.toneUri, toneName: np.toneName,
      vibrate: np.vibrate, vibe: np.vibe, keepAlive: np.keepAlive,
      question: kindValue('question'), permission: kindValue('permission'), done: kindValue('done'), error: kindValue('error'),
    }));
  } catch {}
}

// 后台常驻接收（手机 App）：开着就把原生服务拉起来（此刻在前台，Android 12+ 才允许起前台服务）
function keepAliveKick() {
  const a = A();
  if (!a || !a.startAgentWatch || !nativeNotices()) return;
  try {
    if (np.on && np.keepAlive) { if (!document.hidden) a.startAgentWatch(); }
    else a.stopAgentWatch?.();
  } catch {}
}
// 有会话开跑（不管是哪台设备发起的）：手机在前台时顺手把原生跟踪拉起来，切到后台它也能按会话弹
function watchKick() {
  const a = A();
  if (!a || !a.startAgentWatch || !nativeNotices() || document.hidden || !np.on) return;
  if (!['question', 'permission', 'done', 'error'].some(kindOn)) return;
  try { a.startAgentWatch(); } catch {}
}

// —— 服务端会不会推 notice（老服务端不推：notify.js 的老路照旧）——
let live = false;
export const noticesLive = () => live;
// 别的分页（Antigravity）的通知是不是也由服务端发（hello 的 noticeAgents）：是 → 那一页不再自己凑本机通知
let liveAgents = new Set(['claude']);
export const noticesLiveFor = (agent) => live && liveAgents.has(agent);

// —— 别的分页的会话（notice 带 agent）——
// 它们的会话 id 和 Claude 的不是一个命名空间：「人是不是正看着它」「点开去哪一页」由那一页自己登记的钩子答。
// 那一页的代码是懒加载的，没加载时 = 没在看；点开时由 agentUi 把页面带过去。
const AGENT_LABEL = { agy: 'Antigravity', codex: 'Codex' };
const agentHooks = new Map();          // agent -> { watching(sid) }
export function registerNoticeAgent(agent, hooks) { if (agent && hooks) agentHooks.set(agent, hooks); }
const sidAgent = new Map();            // 会话 id -> agent（只记非 Claude 的；原生通知点进来只给会话 id，靠它认回是哪一页）
function rememberAgent(sid, agent) {
  if (!sid || !agent || agent === 'claude') return;
  sidAgent.set(sid, agent);
  if (sidAgent.size > 300) sidAgent.delete(sidAgent.keys().next().value);
}
// 这个会话属于哪个分页（'' = Claude）。没见过这条通知（冷启动、JS 被冻住时原生弹的）就问一次服务端——
// /api/active 的 notices 留 30 分钟。
async function agentOfSession(sid) {
  if (!sid) return '';
  if (sidAgent.has(sid)) return sidAgent.get(sid);
  try {
    const r = await api.get('/api/active');
    for (const n of (r && r.notices) || []) rememberAgent(n.sessionId, n.agent);
  } catch {}
  return sidAgent.get(sid) || '';
}

// 插件页面正看着的会话：PluginFrame 在 chat.sub 订阅期间登记（watchFromPage），visible = 那个 iframe 此刻在不在使用者
// 眼前（PluginFrame 的 foreground()：保活在后台的应用分页、被设置盖住的、切走的标签都不算）。
const pageWatch = new Set();   // { sid, visible }
/** 插件页面订阅了会话 sid 的对话流：订阅期间页面就是这个会话的界面。回注销函数（流断 / 收订阅时调）。 */
export function watchFromPage(sid, visible) {
  const w = { sid: String(sid || ''), visible: typeof visible === 'function' ? visible : () => false };
  pageWatch.add(w);
  return () => { pageWatch.delete(w); };
}
function pageWatching(sid) {
  for (const w of pageWatch) {
    if (w.sid !== sid) continue;
    try { if (w.visible()) return true; } catch {}
  }
  return false;
}

// 人正看着这个会话
function watching(sid, kind, agent = '') {
  if (!sid || typeof document === 'undefined' || document.hidden) return false;
  if (isNativeDesktop() && !document.hasFocus()) return false;
  if (agent && agent !== 'claude') {
    if (ui.settingsOpen) return false;
    try { return !!agentHooks.get(agent)?.watching?.(sid); } catch { return false; }
  }
  if (ui.screen === 'claude' && !ui.settingsOpen && session.id === sid) return true;
  // 插件应用页面就是这个会话的界面：完成 / 出错页面自己的流里已经收到了，横幅再冒出来会盖住应用顶栏（.ap-bar），
  // 点一下还把人从应用里拽去 Claude 页。提问与审批照弹：页面不能代批，横幅是去 Claude 页处理的那条捷径。
  return (kind === 'done' || kind === 'error') && pageWatching(sid);
}

// 一条通知 → 显示用的文字
export function noticeView(n) {
  const routine = n.sub === 'routine';
  const who = AGENT_LABEL[n.agent] || 'Claude';
  const title = routine ? t('定时任务「{name}」', { name: n.title || '' }) : (n.title || who);
  const label = n.kind === 'question' ? (n.sub === 'offer' ? t('想另开一个会话') : t('在等你回答'))
    : n.kind === 'permission' ? (n.sub === 'plan' ? t('计划等你批准') : t('需要你批准'))
    : n.kind === 'done' ? t('已完成')
    : n.kind === 'error' ? t('出错了')
    : t('提醒');
  const fallback = n.kind === 'question' ? t('有一个问题在等你选择') : n.kind === 'permission' ? t('有一个操作在等你批准')
    : n.kind === 'done' ? t('回复已生成') : n.kind === 'error' ? t('这一轮没有跑完') : '';
  // 关了内容详情：会话名也藏起来（会话名就是第一句话，一样可能是隐私）
  if (!np.preview) return { title: who, label, body: t('你有一条新消息') };
  return { title, label, body: tr(n.body || '') || fallback };
}

const seen = new Set();
const remember = (id) => { seen.add(id); if (seen.size > 400) seen.delete(seen.values().next().value); };

function onNotice(n) {
  if (!n || !n.id || seen.has(n.id)) return;
  remember(n.id);
  rememberAgent(n.sessionId, n.agent);
  if (!kindOn(n.kind)) return;
  if (watching(n.sessionId, n.kind, n.agent)) return;
  const hidden = typeof document !== 'undefined' && document.hidden;
  const bg = hidden || (isNativeDesktop() && !document.hasFocus());
  if (bg) {
    if (isNativeDesktop()) return;                         // 桌面壳主进程自己弹系统通知
    const a = A();
    if (nativeNotices()) { try { a.postSessionNotice(JSON.stringify(n)); } catch {} return; }   // 原生按会话弹、自己响
    browserNotify(n);
    alertNow(n.kind);
    return;
  }
  if (np.inApp) pushBanner(n);
  alertNow(n.kind);
}

// —— 前台横幅 ——
let bannerSeq = 0;
function pushBanner(n) {
  const v = noticeView(n);
  // 同一会话的旧横幅让位给新的（像微信：同一个人连发只留最新一条）
  const rest = banners.list.filter((b) => !n.sessionId || b.sessionId !== n.sessionId);
  banners.list = [{ key: ++bannerSeq, id: n.id, sessionId: n.sessionId || null, agent: n.agent || '', kind: n.kind, sub: n.sub || '', ...v }, ...rest].slice(0, 3);
}
export function dismissBanner(key) { banners.list = banners.list.filter((b) => b.key !== key); }
export async function openBanner(b) {
  dismissBanner(b.key);
  await openNoticeTarget(b.sessionId, b.sub, b.agent);
}
// agent 不给 = 自己认（原生通知、桌面壳点进来只带会话 id）
export async function openNoticeTarget(sid, sub, agent = null) {
  try {
    const resolvedAgent = sid ? (agent == null ? await agentOfSession(sid) : agent) : '';
    const targetPage = resolvedAgent === 'agy' ? 'agy' : resolvedAgent === 'codex' ? 'chatgpt' : 'claude';
    // 独立分页窗口里点到其它分页的通知横幅：经桌面壳路由到对应分页窗口或主窗，不把当前独立窗跳歪
    if (isPageWindow() && WINDOW_PAGE !== targetPage && hasDesktopPageWindows()) {
      if (sid) await routeToPageWindow({ key: targetPage, action: 'open-session', func: resolvedAgent, sessionId: sid });
      else if (sub === 'routine') await routeToPageWindow({ key: 'claude', action: 'open-routines' });
      return;
    }
    const m = await import('./agentUi.js');
    if (sid) await m.openSessionFromNotice(sid, resolvedAgent);
    else if (sub === 'routine') await m.openRoutinesFromNotice();
  } catch {}
}

// —— 浏览器系统通知（tag = 会话：同一会话后来的替换前面的）——
const openNotes = new Map();   // sid -> Notification
function browserNotify(n) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const v = noticeView(n);
    const tag = 'bridge-s-' + (n.sessionId || n.id);
    // 声音由我们自己放（可选提示音 / 关声音）：系统那声静掉
    const note = new Notification(v.title, { body: v.label + '：' + v.body, tag, renotify: true, silent: true, icon: import.meta.env.BASE_URL + 'icons/apple-touch-icon.png' });
    note.onclick = () => { try { window.focus(); } catch {} note.close(); openNoticeTarget(n.sessionId, n.sub, n.agent || ''); };
    if (n.sessionId) openNotes.set(n.sessionId, note);
  } catch {}
}

// —— 铃声与震动 ——
let lastAlert = 0;
let audio = null;
const toneUrl = (id) => import.meta.env.BASE_URL + 'sounds/notice-' + (TONES.some((x) => x.id === id) ? id : 'ding') + '.wav';
function playTone(id) {
  try {
    if (!audio) audio = new Audio();
    audio.src = toneUrl(id);
    audio.currentTime = 0;
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
  } catch {}
}
// 页面还没被点过（没有用户激活）时浏览器拦下 vibrate 并在控制台记错误：通知可能在用户碰页面之前就到，这时干脆不震
function vibe(id) { try { if (canVibrate() && !nativeNotices() && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate(VIBE_MS[id] || VIBE_MS.double); } catch {} }
function alertNow(kind) {
  const now = Date.now();
  if (now - lastAlert < 1500) return;                        // 一下子来好几条只响一声
  lastAlert = now;
  const a = A();
  if (nativeNotices() && a.noticeAlert) { try { a.noticeAlert(kind || ''); } catch {} return; }   // 原生按铃声模式 / 免打扰决定响不响
  if (np.sound) playTone(np.tone);
  if (np.vibrate) vibe(np.vibe);
}

// 设置页试听
export function previewTone(id = np.tone) {
  const a = A();
  if (a?.previewNoticeTone) { try { a.previewNoticeTone(id, id === 'custom' ? np.toneUri : ''); } catch {} return; }
  playTone(id);
}
export function previewVibe(id = np.vibe) {
  const a = A();
  if (a?.previewNoticeVibe) { try { a.previewNoticeVibe(id); } catch {} return; }
  vibe(id);
}
export function pickTone(id) {
  setNoticePref('tone', id);
  previewTone(id);
}
// 手机：系统铃声选择器（回调 __bridgeTonePicked）
export function pickPhoneTone() {
  const a = A();
  if (!a?.pickNoticeTone) return;
  try { a.pickNoticeTone(np.tone === 'custom' ? np.toneUri : ''); } catch {}
}

// 浏览器：系统通知权限
export const browserPerm = $state({ v: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission });
export async function requestBrowserPerm() {
  try { browserPerm.v = await Notification.requestPermission(); } catch {}
  return browserPerm.v;
}

// 发一条测试通知：横幅（或系统通知）+ 铃声震动都按当前设置走
export function testNotice() {
  const n = { id: 'test-' + Date.now().toString(36), kind: 'done', sub: 'test', sessionId: null, title: t('测试会话'), body: t('这是一条测试通知：横幅、声音和震动都按当前设置来。') };
  const a = A();
  if (nativeNotices()) {
    try { a.postSessionNotice(JSON.stringify({ ...n, test: true })); } catch {}
    try { a.noticeAlert?.('done'); } catch {}
    return;
  }
  if (np.inApp) pushBanner(n);
  lastAlert = 0;
  alertNow('done');
  if (!isNativeDesktop() && browserPerm.v === 'granted' && document.hidden) browserNotify(n);
}

// 别的分页（Antigravity）：人点开 / 正看着它的某个会话时由那一页调，收掉这个会话的横幅与通知栏那条
export function noticeSessionSeen(sid) { clearSession(sid); }

// 人点开了 / 正看着某个会话：它的通知全部收掉（同微信：进了聊天，通知栏那条就没了）
// 会在 $effect 里被调用：读 banners.list 必须 untrack，且只在真有要收的才赋值——否则
// 「读 list → 赋新数组 → effect 重跑」无限自触发（effect_update_depth_exceeded），整个界面的调度被打崩（2026-11-07 v559 事故）
function clearSession(sid) {
  if (!sid) return;
  const list = untrack(() => banners.list);
  if (list.some((b) => b.sessionId === sid)) banners.list = list.filter((b) => b.sessionId !== sid);
  try { A()?.clearSessionNotice?.(sid); } catch {}
  const note = openNotes.get(sid);
  if (note) { try { note.close(); } catch {} openNotes.delete(sid); }
}

let inited = false;
export function initNotices() {
  if (inited || typeof window === 'undefined') return;
  inited = true;
  syncNative();
  busOn((ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'hello') {
      if (ev.noticesV) live = true;
      liveAgents = new Set(Array.isArray(ev.noticeAgents) && ev.noticeAgents.length ? ev.noticeAgents : ['claude']);
      // 别的分页有轮在跑：手机在前台时同样把原生跟踪拉起来
      if (live && Array.isArray(ev.ext) && ev.ext.some((e) => e && Array.isArray(e.runs) && e.runs.length)) watchKick();
      if (live && Array.isArray(ev.runs) && ev.runs.length) watchKick();
      return;
    }
    if (ev.type === 'run.start') { if (live) watchKick(); return; }
    if (ev.type === 'agy.run') { if (ev.live && noticesLiveFor('agy')) watchKick(); return; }
    if (ev.type === 'notice') { live = true; onNotice(ev); }
  });
  // 原生通知点进来：打开那个会话（冷启动时先存着，页面起来后来取）
  window.__bridgeOpenSession = (sid) => { openNoticeTarget(String(sid || ''), ''); };
  window.__bridgeTonePicked = (r) => {
    if (!r || !r.uri) return;
    np.tone = 'custom'; np.toneUri = String(r.uri); np.toneName = String(r.name || '');
    save();
  };
  try { const pend = A()?.takeOpenSession?.(); if (pend) setTimeout(() => openNoticeTarget(pend, ''), 400); } catch {}
  keepAliveKick();
  // 正看着的会话：收掉它的通知
  $effect.root(() => {
    $effect(() => {
      const sid = session.id, on = ui.screen === 'claude' && !ui.settingsOpen;
      if (on && sid && !document.hidden) untrack(() => clearSession(sid));
    });
    // Claude 设置页改了分类开关（cs.device）：同步给原生
    $effect(() => { void cs.device; syncNative(); });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    browserPerm.v = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    if (ui.screen === 'claude' && !ui.settingsOpen && session.id) clearSession(session.id);
    keepAliveKick();
  });
  // 别的标签页 / 窗口改了设置
  window.addEventListener('storage', (e) => {
    if (e.key === LS) Object.assign(np, loadPrefs());
    else if (e.key === 'bridge-notify') np.on = masterOn();
  });
}
