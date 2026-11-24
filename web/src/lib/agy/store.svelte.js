// Antigravity 分页响应式状态与控制器（Svelte 5 runes）。
// 管理守护进程能力表、会话与项目列表、每会话草稿（落本机）、实时流式对话、断线重连重放、权限审批与提问应答、
// 一轮在跑时再发的话（默认中途插话：做完手头这一步就送达；也可以稍后发送：存在服务端排队，收尾后自动接着跑）、
// 跨设备状态（账号总线的 agy.run / agy.sessions）。

import { startChat, resumeActive } from '../sse.js';
import { caps, ui } from '../state.svelte.js';
import { setAgyDockWs, setAgyDockSession, noteAgyAgentBrowser, noteAgyAgentTerm, openAgyDockFiles, clearAgyAgentStack } from '../dock.svelte.js';
import { agySubagents, refreshAgySubagents, resetAgySubagents } from './subagents.svelte.js';
import { refreshAgySwarm, resetAgySwarm } from './swarm.svelte.js';
import { noteFsChange } from '../fsSync.svelte.js';
import { handleWsx } from '../uiReport.js';
import { narrowViewport } from '../widgetSeg.js';
import { agentStart, agentStream, agentEnd, notifyKind } from '../notify.js';
import { runPhoneCmd } from '../phonecmd.js';
import { showToast } from '../toast.svelte.js';
import { t, tr } from '../i18n.js';
import { agyApi } from './api.js';
import { agySwitchToastText } from './pool-logic.js';
import { computeWorkspaceFileTarget } from './workspace-logic.js';
// 给核心的 lib/agentUi.js（agy 的 ui_open）转出：核心只经本入口懒加载 agy 代码，不直接引共享 chunk（web/scripts/module-chunks.mjs）
export { agyUiTargetOf } from './workspace-logic.js';
import { createEmptyAssistantTurn, applyAgyStreamEvent, normalizeHistoryMessages, resolveApprovalDecision, bridgeToolOf, classifyToolKind } from './logic.js';
import { agyPrefs, ensureAgySettingsLoaded, registerAgyChatDefaultsHook } from './settings.svelte.js';
import { api } from '../api.js';
import { busOn } from '../bus.js';
import { registerNoticeAgent, noticeSessionSeen, noticesLiveFor } from '../notices.svelte.js';
import { thisDeviceId } from '../devices.svelte.js';
import { agyArtifactUrl } from '../preview.svelte.js';
import { loadDrafts, saveDrafts, putDraft, draftKeyOf, cleanAtts, loadSessionsCache, saveSessionsCache } from './persist.js';
import { applyLiveSnapshot, setSessionPending, returnQueuedToDraft, loadAgyDeviceLink } from './remote.js';
import { isVoiceAtt, saveVoicePeaks } from './voice-peaks.js';

const LAST_PROJ_KEY = 'bridge-agy-project';
const LAST_CWD_KEY = 'bridge-agy-cwd';
const LAST_SID_KEY = 'bridge-agy-session';
const PROJ_ORDER_KEY = 'bridge-agy-proj-order';
const readStored = (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const writeStored = (key, val) => {
  try { val ? localStorage.setItem(key, String(val)) : localStorage.removeItem(key); } catch {}
};
function loadStoredOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROJ_ORDER_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((p) => typeof p === 'string' && p.trim()) : [];
  } catch { return []; }
}
export function cacheAgyProjectOrder(list) {
  try {
    const arr = Array.isArray(list) ? list : [];
    if (arr.length) localStorage.setItem(PROJ_ORDER_KEY, JSON.stringify(arr));
    else localStorage.removeItem(PROJ_ORDER_KEY);
  } catch {}
}
let orderPending = 0;
export function bumpAgyOrderPending(delta) {
  orderPending = Math.max(0, orderPending + delta);
}

export const agy = $state({
  booted: false, loadingSession: false, loadingList: false, reconnecting: false,
  daemon: null, configOptions: [], modes: null, models: null, commands: [], contextUsage: null,
  // 账号模型额度（/api/agy/quota）：{ buckets:[{ id, group, window, usedPct, resetAt }], at, error }；开口仪表中间那个数字
  quota: null,
  model: '', thoughtLevel: 'medium', mode: 'default',
  projects: [], projectOrder: loadStoredOrder(), recentDirs: [], projectId: readStored(LAST_PROJ_KEY), cwd: readStored(LAST_CWD_KEY),
  // sessions 先用本机缓存垫着（冷启动 / 断网时侧栏不是空的），拉到新的再换
  sessions: loadSessionsCache(), hiddenSessions: [], hiddenCount: 0, activeSessionIds: [],
  // 在等你的会话：sessionId -> 'permission'（等审批）| 'question'（等回答）；侧栏的「在等你」点
  pendingSessions: {},
  // 这一轮说完了、后台还在跑的会话（转入后台的命令 / 定时任务 / 子代理）：侧栏的「在等后台」空心环
  bgSessionIds: [],
  sessionId: null, title: '', messages: [], busy: false,
  // 当前会话排着队的消息（这一轮收尾后依次发出）：[{ id, text, atts, at }]
  queue: [],
  // 这个会话连哪台电脑（device_* 工具的默认目标）：设备 id / 'none' / ''（自动）；新对话的选择先记在 deviceDraft
  deviceLink: '', deviceDraft: 'auto',
  // 没选文件夹时会话实际落到的目录（服务端 status.defaultCwd，即工作空间根）
  defaultCwd: '',
  // 界面弹层状态（统一由 nav.js 逐级拦截返回）
  // sheetKind：输入框底栏哪个小菜单开着（'' / 'model' / 'effort' / 'mode'）
  drawerOpen: false, sheetKind: '', projectSheetOpen: false, pickerOpen: false, hiddenOpen: false,
  // 模型 / 文件夹弹层的锚点（触发芯片 DOM 元素或矩形快照）；null = 居中对话框
  popAnchor: null, popAnchorEl: null,
  highlightedFileName: '', highlightSeq: 0,
  draftText: '', draftAtts: [],
});

function syncDockContext() {
  setAgyDockSession(agy.sessionId || '');
  setAgyDockWs(agy.cwd || '');
}

let fsNotifySeq = 0;
// 「需要你批准」通知的正文：bridge 自己的工具写要干什么（agy 给的标题只有「Run mcp_bridge_x」）
function permNoticeBody(ev) {
  const tc = ev.toolCall && typeof ev.toolCall === 'object' ? ev.toolCall : {};
  const meta = classifyToolKind({ name: tc.name || ev.toolName, kind: tc.kind || ev.kind, title: tc.title || ev.title, command: tc.command || ev.command, args: tc.args || ev.args });
  const body = meta.bridge
    ? [meta.verb, meta.detail || meta.summary].filter(Boolean).join(' · ')
    : (tc.title || ev.title || tc.command || ev.command || '');
  const sub = ev.subagent?.role || ev.subagent?.typeName || '';
  return sub ? `[${sub}] ${body}` : body;
}

// 工作区 goto / preview 指令去重（见 handleStreamEvent 的 wsx 分支）
const seenAgyWsx = new Set();
function emitWorkspaceFsSync(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return;
  noteFsChange(p);
  handleWsx({ op: 'fs', id: `agy-fs-${Date.now()}-${++fsNotifySeq}`, rel: p });
}

// 按会话（或 '__new__'）存未发出的草稿文字与附件；落在本机（persist.js），刷新 / 重启后还在
const drafts = loadDrafts();
let liveHandle = null;
let turnNotifying = false;
// 视图代号：每次切会话 / 新建 / 发送都 +1。异步回来的加载结果与流事件对不上当前代号就丢掉，
// 免得慢回来的旧会话把内容或 sessionId 写进刚切到的会话（以前「继续」被发进别的会话就是这么来的）。
let viewSeq = 0;

function beginAgyTurnNotify() {
  if (turnNotifying) return;
  turnNotifying = true;
  agentStart('Antigravity');
}

function finishAgyTurnNotify(body = '', { error = false, silent = false } = {}) {
  if (!turnNotifying) return;
  turnNotifying = false;
  if (silent) {
    agentEnd('Antigravity', '', { watching: true });
    return;
  }
  const watching = ui.screen === 'agy' && (typeof document === 'undefined' || !document.hidden);
  agentEnd('Antigravity', body, { error, watching });
}

// 还在上传的附件不进落盘的草稿（persist.cleanAtts），切走再切回来时从内存这份补回（它们的上传还在继续）
const pendingAtts = new Map();   // draftKey -> [att]
function stashDraft(sid) {
  const k = draftKeyOf(sid);
  const uploading = agy.draftAtts.filter((a) => a && a.pending);
  if (uploading.length) pendingAtts.set(k, uploading); else pendingAtts.delete(k);
  if (putDraft(drafts, sid, agy.draftText, agy.draftAtts)) saveDrafts(drafts);
}
function restoreDraft(sid) {
  const k = draftKeyOf(sid);
  const saved = drafts.get(k);
  agy.draftText = saved ? saved.text : '';
  // 图片的预览地址按服务端路径现拼（落盘时不存 blob: 地址）
  const atts = (saved ? saved.atts : []).map((a) => ({
    ...a, pending: false,
    url: a.kind === 'image' ? agyArtifactUrl('', a.path, { name: a.name }) : '',
  }));
  agy.draftAtts = [...atts, ...(pendingAtts.get(k) || [])];
}
function dropDraft(sid) {
  pendingAtts.delete(draftKeyOf(sid));
  if (drafts.delete(draftKeyOf(sid))) saveDrafts(drafts);
}
// 打字时也落盘（停手半秒后）：apk 被系统回收、页面被刷新都不丢
let draftTimer = null;
function watchDraft() {
  $effect.root(() => {
    $effect(() => {
      void agy.draftText; void agy.draftAtts.length;
      for (const a of agy.draftAtts) void a.pending;
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => { if (putDraft(drafts, agy.sessionId, agy.draftText, agy.draftAtts)) saveDrafts(drafts); }, 500);
    });
  });
}

export function fallbackAgyCaps() {
  return agy.daemon?.fallbackCapabilities || caps.data?.agy || {
    models: [],
    modes: [],
    efforts: [],
    defaults: { model: 'gemini-4-neon', effort: 'medium', mode: 'default' },
  };
}

function syncConfigFromSnapshot(snap = {}) {
  if (Array.isArray(snap.configOptions) && snap.configOptions.length) {
    agy.configOptions = snap.configOptions;
  }
  if (snap.modes) agy.modes = snap.modes;
  if (snap.models) agy.models = snap.models;
  if (Array.isArray(snap.commands) && snap.commands.length) agy.commands = snap.commands;
  if (snap.usage && snap.usage.size) {
    agy.contextUsage = { used: Number(snap.usage.used) || 0, size: Number(snap.usage.size) || 0 };
  }
  if (snap.model) agy.model = snap.model;
  if (snap.thoughtLevel) agy.thoughtLevel = snap.thoughtLevel;
  if (snap.mode) agy.mode = snap.mode;
}

function applySettingsDefaultsToIdleChat(cfg = agyPrefs.settings) {
  if (!cfg || agy.sessionId || agy.messages.length > 0) return;
  if (cfg.defaultModel) agy.model = cfg.defaultModel;
  if (cfg.defaultThoughtLevel) agy.thoughtLevel = cfg.defaultThoughtLevel;
  if (cfg.defaultMode) agy.mode = cfg.defaultMode;
  if (cfg.defaultProjectId) {
    const proj = agy.projects.find((p) => p.id === cfg.defaultProjectId);
    if (proj) {
      agy.projectId = proj.id;
      agy.cwd = proj.path;
      syncDockContext();
    }
  } else if (cfg.defaultCwd) {
    agy.cwd = cfg.defaultCwd;
    syncDockContext();
  }
}

registerAgyChatDefaultsHook(applySettingsDefaultsToIdleChat);

export async function refreshAgyStatus(ensure = false) {
  try {
    const st = await agyApi.status(ensure);
    agy.daemon = st;
    if (typeof st?.defaultCwd === 'string') agy.defaultCwd = st.defaultCwd;
    if (st.catalog) {
      if (!agy.configOptions.length && Array.isArray(st.catalog.configOptions)) {
        agy.configOptions = st.catalog.configOptions;
      }
      if (!agy.modes && st.catalog.modes) agy.modes = st.catalog.modes;
      if (!agy.models && st.catalog.models) agy.models = st.catalog.models;
    }
    const fb = fallbackAgyCaps();
    if (!agy.model) agy.model = fb.defaults?.model || '';
    if (!agy.thoughtLevel) agy.thoughtLevel = fb.defaults?.effort || 'medium';
    if (!agy.mode) agy.mode = fb.defaults?.mode || 'default';
    return st;
  } catch {
    return null;
  }
}

export async function refreshAgyProjects({ preserveDefault = false } = {}) {
  try {
    const res = await agyApi.listProjects();
    const list = Array.isArray(res?.projects) ? res.projects : [];
    agy.projects = list;
    agyPrefs.projects = list;
    if (orderPending === 0 && Array.isArray(res?.order)) {
      agy.projectOrder = res.order;
      cacheAgyProjectOrder(res.order);
    }
    if (agy.projectId) {
      const hit = list.find((p) => p.id === agy.projectId);
      if (hit && !agy.sessionId) agy.cwd = hit.path;
      else if (!hit) {
        agy.projectId = '';
        writeStored(LAST_PROJ_KEY, '');
        if (!agy.sessionId) {
          agy.cwd = '';
          writeStored(LAST_CWD_KEY, '');
        }
      }
    } else if (!preserveDefault && list.length && !agy.sessionId && !agy.cwd) {
      agy.projectId = list[0].id;
      agy.cwd = list[0].path;
      writeStored(LAST_PROJ_KEY, agy.projectId);
    }
    syncDockContext();
  } catch {}
}

export async function refreshAgySessions({ refresh = false } = {}) {
  agy.loadingList = true;
  try {
    const [res, act] = await Promise.all([
      agyApi.listSessions({ refresh }),
      agyApi.active().catch(() => null),
    ]);
    const fresh = Array.isArray(res?.sessions) ? res.sessions : [];
    // 服务端列表还没收录的当前会话 / 在跑会话保留本地占位行，免得刷新一下它又从侧栏消失
    const freshIds = new Set(fresh.map((s) => s.sessionId));
    const keepIds = new Set([agy.sessionId, ...agy.activeSessionIds].filter(Boolean));
    const carried = agy.sessions.filter((s) => keepIds.has(s.sessionId) && !freshIds.has(s.sessionId));
    agy.sessions = carried.length ? [...carried, ...fresh] : fresh;
    if (Array.isArray(res?.recentDirs)) {
      agy.recentDirs = res.recentDirs;
    }
    agy.hiddenCount = Number(res?.hiddenCount) || 0;
    if (act && Array.isArray(act.activeSessions)) applyLiveSnapshot(act.activeSessions);
    if (act && Array.isArray(act.bgSessions)) agy.bgSessionIds = act.bgSessions;
    saveSessionsCache(fresh);
    // 正看着的会话在别处被改了名：标题跟上
    const cur = agy.sessionId ? fresh.find((s) => s.sessionId === agy.sessionId) : null;
    if (cur && (cur.customTitle || cur.title)) agy.title = cur.customTitle || cur.title;
  } catch {} finally {
    agy.loadingList = false;
  }
}

export async function refreshHiddenSessions() {
  try {
    const res = await agyApi.listSessions({ includeHidden: true });
    const all = Array.isArray(res?.sessions) ? res.sessions : [];
    agy.hiddenSessions = all.filter((s) => s.hidden);
    agy.hiddenCount = agy.hiddenSessions.length;
  } catch {}
}

// 额度：读 language server 缓存零成本，仪表挂着时每分钟读一次；每轮结束与打开弹层时强刷（服务端 30s 防抖）。
let quotaBusy = false;
export async function refreshAgyQuota({ force = false } = {}) {
  if (quotaBusy && !force) return;
  quotaBusy = true;
  try {
    const q = await agyApi.quota(force, agy.sessionId || '');
    if (q && Array.isArray(q.buckets)) agy.quota = q;
  } catch {} finally { quotaBusy = false; }
}

// —— 跨设备状态：账号总线（服务端 modules/agy/server/presence.mjs）——
let busBound = false;
let lastRemoteTurn = 0;
function bindBus() {
  if (busBound) return;
  busBound = true;
  busOn((ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'hello') {
      const mine = Array.isArray(ev.ext) ? ev.ext.find((e) => e && e.agent === 'agy') : null;
      if (Array.isArray(ev.ext)) applyLiveSnapshot(mine ? mine.runs : []);
      // 断线重连：这段时间里列表可能变过
      if (agy.booted) scheduleListSync(600, false);
      return;
    }
    if (ev.type === 'agy.run') { onRemoteRun(ev); return; }
    if (ev.type === 'agy.subagents') {
      const waiting = typeof ev.bgWaiting === 'boolean' ? ev.bgWaiting : null;
      if (ev.sessionId && waiting !== null) {
        const has = agy.bgSessionIds.includes(ev.sessionId);
        if (waiting && !has) agy.bgSessionIds = [...agy.bgSessionIds, ev.sessionId];
        else if (!waiting && has) agy.bgSessionIds = agy.bgSessionIds.filter((x) => x !== ev.sessionId);
      }
      if (ev.sessionId && ev.sessionId === agy.sessionId) {
        refreshAgySubagents(ev.sessionId, { silent: true });
        refreshAgySwarm(ev.sessionId, { silent: true });
      }
      return;
    }
    if (ev.type === 'agy.bg_update') {
      if (ev.sessionId && ev.sessionId === agy.sessionId && !agy.busy && !agy.loadingSession) {
        reconcileAgySessionSilent(ev.sessionId);
        refreshAgySubagents(ev.sessionId, { silent: true });
        refreshAgySwarm(ev.sessionId, { silent: true });
      }
      return;
    }
    if (ev.type === 'agy.sessions') { scheduleListSync(400, false); return; }
    if (ev.type === 'agy.projects') {
      refreshAgyProjects({ preserveDefault: true });
      scheduleListSync(400, false);
    }
  });
}

// 后台自动唤醒收尾后静默把最新消息对账进当前对话：不闪骨架屏、不动草稿、不重挂舞台
let reconciling = false;
async function reconcileAgySessionSilent(sid) {
  if (!sid || sid !== agy.sessionId || agy.busy || agy.loadingSession || reconciling) return;
  reconciling = true;
  const seq = viewSeq;
  try {
    const detail = await agyApi.getSession(sid, agy.cwd || '');
    if (seq !== viewSeq || agy.sessionId !== sid || agy.busy) return;
    if (detail?.live) {
      await attachLiveTurn(sid, seq, { onMissing: () => reconcileAgySessionSilent(sid) });
      return;
    }
    if (detail && Array.isArray(detail.messages)) {
      syncConfigFromSnapshot(detail);
      agy.messages = normalizeHistoryMessages(detail.messages, sid);
    }
  } catch {} finally {
    reconciling = false;
  }
}

// 从后台 / 手机锁屏回到页面时补查一次：期间后台子代理可能已自动唤醒或弹出了提问卡
export async function checkAgyForegroundSync() {
  const sid = agy.sessionId;
  if (!sid || agy.busy || agy.loadingSession) return;
  refreshAgySubagents(sid, { silent: true });
  refreshAgySwarm(sid, { silent: true });
  const seq = viewSeq;
  try {
    const act = await agyApi.active(sid);
    if (seq !== viewSeq || agy.sessionId !== sid || agy.busy || agy.loadingSession) return;
    if (act?.active && act.sessionId === sid) {
      if (act.backgroundWake) {
        attachLiveTurn(sid, seq, { onMissing: () => reconcileAgySessionSilent(sid) });
      } else {
        openAgySession(sid);
      }
    }
  } catch {}
}

// 某个会话开跑 / 收尾 / 在等人（哪台设备发起的都会来，包括自己）
function onRemoteRun(ev) {
  const sid = ev.sessionId;
  if (!sid) return;
  markSessionLive(sid, !!ev.live);
  setSessionPending(sid, ev.live ? ev.pending : '');
  if (ev.live) {
    if (!agy.sessions.some((s) => s.sessionId === sid)) {
      // 别的设备新建的会话：先插一行占位，随后静默对齐列表
      upsertLocalSession(sid, { cwd: ev.cwd || '', projectId: ev.projectId || '', title: String(ev.userText || '').slice(0, 40) });
      scheduleListSync();
    }
    // 正看着的这个会话在别处开跑、或后台子代理回报触发了自动唤醒/权限审批：挂上去看直播
    if (sid === agy.sessionId && !agy.busy && !agy.loadingSession && !liveHandle && ev.turn && (ev.turn !== lastRemoteTurn || ev.pending)
      && ui.screen === 'agy' && (typeof document === 'undefined' || !document.hidden)) {
      lastRemoteTurn = ev.turn;
      if (ev.backgroundWake) {
        // 后台自动唤醒直接接续到现有消息末尾，避免整页重刷闪骨架屏
        attachLiveTurn(sid, viewSeq, { onMissing: () => reconcileAgySessionSilent(sid) });
      } else {
        openAgySession(sid);
      }
    }
  } else {
    scheduleListSync(800);
  }
}

export async function bootAgy() {
  if (agy.booted) return;
  agy.booted = true;
  bindBus();
  watchDraft();
  // 通知：人是不是正看着某个 agy 会话，由这一页自己答（lib/notices.svelte.js）
  registerNoticeAgent('agy', {
    watching: (sid) => ui.screen === 'agy' && agy.sessionId === sid,
  });
  await Promise.all([
    ensureAgySettingsLoaded(),
    refreshAgyStatus(true),
    refreshAgyProjects(),
    refreshAgySessions(),
  ]);
  applySettingsDefaultsToIdleChat();
  // 若外部入口（如文件面板「发送给 AI」或拖拽投递）已在首次挂载前预置了会话或草稿附件，不再用上次历史会话冲掉当前草稿
  if (agy.sessionId || agy.messages.length > 0 || agy.draftAtts.length > 0 || agy.draftText) {
    return;
  }
  // 进分页一律落在新对话首页（维护者 11-19）：不再自动打开上次看的 / 正在跑的会话，要看哪个从侧栏点
  // 新对话页上次没发出去的草稿（落在本机的那份）接着摆出来
  restoreDraft(null);
}

// 新会话一建立就插进侧栏（不等整轮跑完再刷新列表——长任务跑十几分钟时侧栏里一直看不到它）。
// 标题先用首条消息占位，agy 生成标题后由 title 事件替换；随后再静默拉一次服务端列表对齐。
let listSyncTimer = null;
let listSyncForce = false;
// refresh：要不要让服务端重新向 agy 要会话清单（开跑 / 收尾 / 新会话要；改名、隐藏只动了 bridge 这边的侧车表，不用）
function scheduleListSync(delay = 1200, refresh = true) {
  listSyncForce = listSyncForce || refresh;
  clearTimeout(listSyncTimer);
  listSyncTimer = setTimeout(() => {
    const force = listSyncForce;
    listSyncForce = false;
    refreshAgySessions({ refresh: force });
  }, delay);
}

function upsertLocalSession(sid, { cwd = '', projectId = '', title = '' } = {}) {
  if (!sid) return;
  const now = Date.now();
  const hit = agy.sessions.find((s) => s.sessionId === sid);
  if (hit) {
    hit.updatedMs = now;
    hit.updatedAt = new Date(now).toISOString();
    const defTitle = t('新对话');
    if (title && !hit.customTitle && (!hit.title || hit.title === defTitle)) hit.title = title;
    return;
  }
  const folder = String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
  agy.sessions = [{
    sessionId: sid,
    cwd: cwd || '',
    projectId: projectId || null,
    projectName: folder,
    title: title || t('新对话'),
    customTitle: '',
    updatedAt: new Date(now).toISOString(),
    updatedMs: now,
    hidden: false,
    config: null,
  }, ...agy.sessions];
}

function markSessionLive(sid, live) {
  if (!sid) return;
  const has = agy.activeSessionIds.includes(sid);
  if (live && !has) agy.activeSessionIds = [...agy.activeSessionIds, sid];
  else if (!live && has) agy.activeSessionIds = agy.activeSessionIds.filter((x) => x !== sid);
}

function firstUserTextTitle() {
  const u = agy.messages.find((m) => m.role === 'user' && (m.text || (Array.isArray(m.atts) && m.atts.length > 0)));
  const txt = String(u?.text || '').replace(/\s+/g, ' ').trim();
  if (txt) return txt.length > 40 ? txt.slice(0, 40) + '…' : txt;
  if (Array.isArray(u?.atts) && u.atts.some((a) => isVoiceAtt(a))) return t('语音消息');
  return '';
}

function getLastAssistantTurn() {
  const last = agy.messages[agy.messages.length - 1];
  return last && last.role === 'assistant' ? last : null;
}

// 界面附件（服务端 attach / 排队消息带来的）→ 气泡里能直接画的样子
function viewAtts(raw) {
  return cleanAtts(raw).map((a) => ({ ...a, url: '' }));
}

function ensureStreamingTurn(userTextIfMissing = '', userAtts = null) {
  let turn = getLastAssistantTurn();
  if (!turn || turn.status !== 'streaming') {
    const prev = agy.messages[agy.messages.length - 1];
    const atts = viewAtts(userAtts);
    if ((userTextIfMissing || atts.length) && !(prev && prev.role === 'user' && (prev.text === userTextIfMissing || prev.id?.startsWith?.('u-')))) {
      agy.messages.push({ id: 'u-attach-' + Date.now(), role: 'user', text: userTextIfMissing, atts });
    }
    agy.messages.push(createEmptyAssistantTurn({ sessionId: agy.sessionId || '' }));
    turn = agy.messages[agy.messages.length - 1];
  }
  return turn;
}

function handleStreamEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  agy.reconnecting = false;

  if (ev.type === 'attach') {
    if (ev.sessionId) {
      agy.sessionId = ev.sessionId;
      writeStored(LAST_SID_KEY, ev.sessionId);
    }
    if (ev.cwd) agy.cwd = ev.cwd;
    if (ev.projectId) agy.projectId = ev.projectId;
    syncDockContext();
    if (Array.isArray(ev.queue)) agy.queue = ev.queue;
    if (ev.turn) lastRemoteTurn = ev.turn;
    const turn = ensureStreamingTurn(ev.userText || '', ev.userAtts);
    applyAgyStreamEvent(turn, ev);
    return;
  }

  if (ev.type === 'queue') {
    if (!ev.sessionId || ev.sessionId === agy.sessionId) agy.queue = Array.isArray(ev.items) ? ev.items : [];
    return;
  }

  if (ev.type === 'session') {
    if (ev.sessionId) {
      const prevSid = agy.sessionId;
      agy.sessionId = ev.sessionId;
      writeStored(LAST_SID_KEY, ev.sessionId);
      if (!prevSid) {
        dropDraft(null);
        // 新对话选的电脑随第一条消息带给了服务端：现在它就是这个会话的连接
        if (agy.deviceDraft !== 'auto') agy.deviceLink = agy.deviceDraft;
        else loadAgyDeviceLink(ev.sessionId);
        agy.deviceDraft = 'auto';
      }
    }
    if (ev.cwd) agy.cwd = ev.cwd;
    if (ev.projectId) agy.projectId = ev.projectId;
    syncDockContext();
    syncConfigFromSnapshot(ev);
    if (ev.sessionId) {
      const known = agy.sessions.some((s) => s.sessionId === ev.sessionId);
      const placeholder = firstUserTextTitle();
      if (!agy.title && placeholder && !known) agy.title = placeholder;
      upsertLocalSession(ev.sessionId, { cwd: ev.cwd || agy.cwd, projectId: ev.projectId || '', title: placeholder });
      markSessionLive(ev.sessionId, true);
      if (!known) scheduleListSync();
    }
    return;
  }

  if (ev.type === 'fs') {
    emitWorkspaceFsSync(ev.path);
    return;
  }
  if (ev.type === 'term') {
    noteAgyAgentTerm();
    return;
  }
  // bridge 工具中枢（服务端 mcp/hub.mjs，与 Claude 同一套工具）推来的界面事件
  if (ev.type === 'browser') {
    noteAgyAgentBrowser(ev.url || 'about:blank');
    return;
  }
  if (ev.type === 'wsx') {
    // 文件夹定位交给 agy 自己的工作区文件卡（Claude 的 goto 只认 Claude 页的面板）；其余（fs / preview / capture / draft）通用
    // preview 同理：通用 handleWsx 走 App 级全屏查看器（host 'app'），agy 边开发边 preview 会一次次整屏盖住对话；
    // 改成在 agy 自己的工作区文件卡里打开（文件卡内嵌预览 host 'agy-workspace'）
    if (ev.op === 'goto' || ev.op === 'preview') {
      // 这两条会动用户眼前的界面：过期的不执行，同一条只执行一次（断线重连 / 切回会话时服务端会把这一轮的事件整段重放，
      // 不去重的话用户刚关掉的文件卡又被重放的指令拉开）
      if (ev.at && Math.abs(Date.now() - ev.at) > 60_000) return;
      const key = ev.id || `${ev.op}:${ev.ws || ''}:${ev.rel || ''}:${ev.at || ''}`;
      if (seenAgyWsx.has(key)) return;
      seenAgyWsx.add(key);
      if (seenAgyWsx.size > 300) { const it = seenAgyWsx.values(); for (let i = 0; i < 100; i++) seenAgyWsx.delete(it.next().value); }
      if (ev.op === 'goto') openAgyDockFiles({ ws: ev.ws || agy.cwd, rel: ev.rel || '' });
      else if (ev.rel) {
        const target = computeWorkspaceFileTarget(ev.rel, ev.ws || agy.cwd, { openFile: true });
        if (target) openAgyDockFiles({ ws: target.ws, rel: target.rel, open: target.open });
      }
    }
    else handleWsx(ev);
    return;
  }

  if (ev.type === 'title' && ev.title) {
    const sid = ev.sessionId || agy.sessionId;
    const hit = agy.sessions.find((s) => s.sessionId === sid);
    if (hit?.customTitle) return;
    if (hit) hit.title = ev.title;
    else if (sid) upsertLocalSession(sid, { cwd: agy.cwd, projectId: agy.projectId, title: ev.title });
    if (sid === agy.sessionId) agy.title = ev.title;
    return;
  }

  if (ev.type === 'commands' && Array.isArray(ev.commands)) { agy.commands = ev.commands; return; }
  if (ev.type === 'config') { syncConfigFromSnapshot(ev); return; }
  if (ev.type === 'mode' && ev.modeId) { agy.mode = ev.modeId; return; }
  if (ev.type === 'usage') {
    agy.contextUsage = { used: Number(ev.used) || 0, size: Number(ev.size) || 0 };
    return;
  }

  if (ev.type === 'phone_cmd') {
    runPhoneCmd(ev);
    return;
  }
  if (ev.type === 'account_switch') {
    showToast(agySwitchToastText(ev), { ms: 4200 });
    refreshAgyQuota({ force: true });
    return;
  }
  if (ev.type === 'subagents') {
    if (agy.sessionId) {
      refreshAgySubagents(agy.sessionId, { silent: true });
      refreshAgySwarm(agy.sessionId, { silent: true });
    }
    return;
  }

  const turn = ensureStreamingTurn();
  applyAgyStreamEvent(turn, ev);

  if (ev.type === 'text') {
    agentStream('Antigravity', turn.md);
  } else if (ev.type === 'permission') {
    setSessionPending(agy.sessionId, 'permission');
    // 服务端会按会话发「需要你批准」通知时（notices.svelte.js 接手），这里不再自己弹一条
    if (!noticesLiveFor('agy')) {
      const watching = ui.screen === 'agy' && (typeof document === 'undefined' || !document.hidden);
      notifyKind('permission', {
        title: t('Antigravity 需要你批准'),
        body: permNoticeBody(ev),
        watching,
        tag: 'agy-perm-' + (ev.requestId || ''),
        force: true,
      });
    }
  } else if (ev.type === 'question') {
    setSessionPending(agy.sessionId, 'question');
    if (!noticesLiveFor('agy')) {
      const watching = ui.screen === 'agy' && (typeof document === 'undefined' || !document.hidden);
      notifyKind('question', {
        title: t('Antigravity 在等你回答'),
        body: ev.message || '',
        watching,
        tag: 'agy-q-' + (ev.requestId || ''),
        force: true,
      });
    }
  } else if (ev.type === 'permission-resolved' || ev.type === 'question-resolved') {
    setSessionPending(agy.sessionId, '');
  }

  if (ev.type === 'tool' || ev.type === 'tool-update') {
    const rawTool = (ev.tool && typeof ev.tool === 'object') ? ev.tool : ev;
    const tName = String(rawTool.name || '');
    // bridge 自己的工具（mcp_bridge_*）不在这里认：侧边浏览器 / 共享终端由服务端中枢另发 browser / term 事件（上面已处理）。
    // 不排除的话 device_browser（操作的是用户电脑上的浏览器）会被名字里的 browser 认成侧边浏览器，把那张空卡片拉开
    if (!bridgeToolOf(rawTool) && (rawTool.kind === 'browser' || /browser/i.test(tName))) {
      noteAgyAgentBrowser(rawTool.args?.url || rawTool.args?.Url || 'about:blank');
    }
    if (rawTool.status === 'completed' && (rawTool.kind === 'edit' || rawTool.kind === 'delete' || rawTool.kind === 'move')) {
      const changedPath = rawTool.diffs?.[0]?.path || rawTool.locations?.[0]?.path || rawTool.args?.Path || rawTool.args?.path || '';
      if (changedPath) emitWorkspaceFsSync(changedPath);
    }
    const lowerTool = tName.toLowerCase();
    if (agy.sessionId && (lowerTool === 'invoke_subagent' || lowerTool === 'send_message' || lowerTool === 'manage_subagents' || lowerTool === 'run_workflow' || lowerTool === 'swarm' || lowerTool === 'post_message' || lowerTool === 'read_board' || lowerTool === 'swarm_wait' || lowerTool === 'schedule')) {
      refreshAgySubagents(agy.sessionId, { silent: true });
      if (lowerTool === 'swarm' || lowerTool === 'post_message' || lowerTool === 'read_board' || lowerTool === 'swarm_wait') {
        refreshAgySwarm(agy.sessionId, { silent: true });
      }
    }
  }

  if (ev.type === 'done' || ev.type === 'interrupted' || ev.type === 'error') {
    if (ev.contextUsage && ev.contextUsage.size) agy.contextUsage = ev.contextUsage;
    agy.busy = false;
    liveHandle = null;
    setSessionPending(agy.sessionId, '');
    agy.queue = Array.isArray(ev.queue) ? ev.queue : [];
    // 排着的话被退回（人按了停止 / 这一轮出错）：并回输入框，改改再发
    if (Array.isArray(ev.queueReturned) && ev.queueReturned.length) returnQueuedToDraft(ev.queueReturned);
    if (ev.next) {
      // 排着的下一条已经在服务端开跑：接上去，不算「这一轮做完了」
      followQueuedTurn(ev.next);
      refreshAgyQuota({ force: true });
      return;
    }
    markSessionLive(agy.sessionId, false);
    finishAgyTurnNotify(ev.type === 'error' ? (ev.message || turn.error) : turn.md, {
      error: ev.type === 'error',
      silent: ev.type === 'interrupted',
    });
    clearTimeout(listSyncTimer);
    // 列表对齐后顺带对一次账：这个会话在服务端其实又开跑了（排队请求正好撞在收尾那一下、别的设备紧跟着发了一条——
    // 那时这边还显示在跑，开跑的广播被当成自己这一轮略过了）→ 重新载入并挂上直播，别让新一轮在看不见的地方跑完
    const sid = agy.sessionId, seq = viewSeq;
    refreshAgySessions({ refresh: true }).then(() => {
      if (sid && seq === viewSeq && agy.sessionId === sid && !agy.busy && !agy.loadingSession && agy.activeSessionIds.includes(sid)) openAgySession(sid);
    });
    if (sid) {
      refreshAgySubagents(sid, { silent: true });
      refreshAgySwarm(sid, { silent: true });
    }
    refreshAgyQuota({ force: true });
  }
}

// 挂上一轮正在服务端跑的直播（打开在跑的会话、排队的下一条开跑、queue 请求直接开跑 都走这里）
async function attachLiveTurn(id, seq, { onMissing = null } = {}) {
  const stale = () => seq !== viewSeq;
  agy.busy = true;
  beginAgyTurnNotify();
  const handle = await resumeActive({
    onEvent: forView(seq, handleStreamEvent),
    onReconnecting: forView(seq, () => { agy.reconnecting = true; }),
    onError: forView(seq, (err) => {
      const turn = ensureStreamingTurn();
      turn.status = 'error';
      turn.error = tr(err?.message) || t('连接中断');
      agy.busy = false;
      agy.reconnecting = false;
      liveHandle = null;
      finishAgyTurnNotify(turn.error, { error: true });
    }),
    onEnded: forView(seq, async (sid) => {
      agy.busy = false;
      liveHandle = null;
      finishAgyTurnNotify('', { silent: false });
      if (sid) await openAgySession(sid);
    }),
    onClose: forView(seq, () => { agy.reconnecting = false; }),
  }, { scope: 'agy', session: id });
  if (stale()) { handle?.stop?.(); return; }
  if (handle) { liveHandle = handle; return; }
  // 探测时还在跑、挂上去时已经结束
  agy.busy = false;
  finishAgyTurnNotify('', { silent: true });
  if (onMissing) await onMissing();
}

// 排队的那条开跑了：先把它摆成用户气泡 + 一条空的回复，再去挂直播
function followQueuedTurn(next) {
  const sid = agy.sessionId;
  if (!sid) return;
  const seq = ++viewSeq;
  agy.messages.push({ id: 'u-' + Date.now(), role: 'user', text: String(next.text || ''), atts: viewAtts(next.atts) });
  agy.messages.push(createEmptyAssistantTurn({ sessionId: sid }));
  agy.reconnecting = false;
  markSessionLive(sid, true);
  attachLiveTurn(sid, seq, { onMissing: () => openAgySession(sid) });
}

// 只在发起它的那个视图还在时才执行回调（切走之后迟到的流事件 / 加载结果一律丢弃）
function forView(seq, fn) {
  return (...args) => (seq === viewSeq ? fn(...args) : undefined);
}

export function newAgyChat({ projectId, cwd } = {}) {
  viewSeq++;
  agy.loadingSession = false;
  if (liveHandle) { liveHandle.stop(); liveHandle = null; }
  finishAgyTurnNotify('', { silent: true });
  stashDraft(agy.sessionId);
  agy.busy = false;
  agy.reconnecting = false;
  agy.sessionId = null;
  agy.title = '';
  agy.messages = [];
  agy.configOptions = [];
  agy.contextUsage = null;
  agy.queue = [];
  agy.deviceLink = '';
  agy.deviceDraft = 'auto';
  writeStored(LAST_SID_KEY, '');

  const cfg = agyPrefs.settings;
  if (cfg.defaultModel) agy.model = cfg.defaultModel;
  if (cfg.defaultThoughtLevel) agy.thoughtLevel = cfg.defaultThoughtLevel;
  if (cfg.defaultMode) agy.mode = cfg.defaultMode;

  if (projectId !== undefined) {
    agy.projectId = projectId || '';
    writeStored(LAST_PROJ_KEY, agy.projectId);
    const proj = agy.projects.find((p) => p.id === agy.projectId);
    agy.cwd = proj?.path || cwd || '';
    writeStored(LAST_CWD_KEY, agy.projectId ? '' : agy.cwd);
  } else if (cwd) {
    agy.projectId = '';
    writeStored(LAST_PROJ_KEY, '');
    agy.cwd = cwd;
    writeStored(LAST_CWD_KEY, cwd);
  } else if (cfg.defaultProjectId && agy.projects.some((p) => p.id === cfg.defaultProjectId)) {
    const defProj = agy.projects.find((p) => p.id === cfg.defaultProjectId);
    agy.projectId = defProj.id;
    agy.cwd = defProj.path;
  } else if (cfg.defaultCwd) {
    agy.cwd = cfg.defaultCwd;
  } else if (agy.projectId) {
    const proj = agy.projects.find((p) => p.id === agy.projectId);
    if (proj) agy.cwd = proj.path;
  }
  syncDockContext();
  clearAgyAgentStack();
  resetAgySubagents('');
  resetAgySwarm('');
  restoreDraft(null);
}

export async function openAgySession(sessionId, { _retry = 0 } = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  const seq = ++viewSeq;
  const stale = () => seq !== viewSeq;
  if (liveHandle) { liveHandle.stop(); liveHandle = null; }
  finishAgyTurnNotify('', { silent: true });
  stashDraft(agy.sessionId);
  const row = agy.sessions.find((s) => s.sessionId === id);
  const rowTitle = row?.customTitle || row?.title || '';
  agy.drawerOpen = false;
  agy.loadingSession = true;
  agy.busy = false;
  agy.reconnecting = false;
  if (agy.sessionId !== id) {
    // 换会话时立刻清掉旧对话：不能出现「sessionId 已是新会话、屏幕上还是旧会话」的窗口——
    // 那时点「重新生成」或发消息，会把旧会话里的话发进新会话
    agy.messages = [];
    agy.title = rowTitle;
    agy.contextUsage = null;
    agy.queue = [];
    agy.deviceLink = '';
    clearAgyAgentStack();
    resetAgySubagents(id);
    resetAgySwarm(id);
  }
  agy.sessionId = id;
  writeStored(LAST_SID_KEY, id);
  restoreDraft(id);
  loadAgyDeviceLink(id);
  refreshAgySubagents(id, { silent: true });
  refreshAgySwarm(id, { silent: true });
  // 点开了这个会话：它的横幅 / 通知栏那条收掉
  noticeSessionSeen(id);

  const attachLive = async (userText = '') => {
    if (!agy.title) agy.title = rowTitle || (userText ? userText.slice(0, 48) : '');
    // 探测时还在跑、挂上去时已经结束：按普通会话重新载入一次完整历史
    await attachLiveTurn(id, seq, { onMissing: async () => { if (_retry < 1) await openAgySession(id, { _retry: _retry + 1 }); } });
  };

  try {
    const act = await agyApi.active(id).catch(() => null);
    if (stale()) return;
    const liveNow = !!(act?.active && act.sessionId === id);
    agy.queue = liveNow && Array.isArray(act.queue) ? act.queue : [];

    const hintCwd = row?.cwd || act?.cwd || '';
    let detail = null;
    try {
      detail = await agyApi.getSession(id, hintCwd);
    } catch (err) {
      // 旧服务端对在跑会话回 409：没有历史可拿，只挂实时流
      if (err?.status !== 409 && !liveNow) throw err;
    }
    if (stale()) return;

    if (detail) {
      agy.title = detail.customTitle || detail.title || rowTitle || '';
      agy.cwd = detail.cwd || act?.cwd || agy.cwd;
      if (detail.projectId) {
        agy.projectId = detail.projectId;
        writeStored(LAST_PROJ_KEY, detail.projectId);
      }
      syncConfigFromSnapshot(detail);
      agy.messages = normalizeHistoryMessages(detail.messages || [], id);
    } else if (act?.cwd) {
      agy.cwd = act.cwd;
      agy.projectId = act.projectId || agy.projectId;
    }
    syncDockContext();

    // 在跑：历史已经铺好，再挂实时流把当前这一轮接在后面（attach 事件会补上本轮的用户消息）。
    // detail 不带 live 说明拿到的是完整历史（这一轮刚好跑完），不能再挂流，否则最后一轮会重复一遍。
    if (!detail || detail.live) {
      agy.loadingSession = false;
      await attachLive(act?.userText || '');
    }
  } catch (err) {
    if (!stale()) showToast(tr(err?.body?.error || err?.message) || t('加载对话失败'), 'err');
  } finally {
    if (!stale()) agy.loadingSession = false;
  }
}

export async function sendAgyMessage(rawText = agy.draftText, rawAtts = agy.draftAtts) {
  const text = String(rawText ?? '').trim();
  const readyAtts = (Array.isArray(rawAtts) ? rawAtts : []).filter((a) => a && !a.pending && a.path);
  // 切会话的加载还没回来时不发：此刻发出去的消息归属说不清
  if ((!text && !readyAtts.length) || agy.loadingSession) return;
  // 这一轮还在跑：中途插话——它做完手头这一步就读到，不打断（要等这一轮结束再发用 sendAgyLater）
  if (agy.busy) return postWhileBusy(text, readyAtts, 'steer');
  const seq = ++viewSeq;

  agy.draftText = '';
  agy.draftAtts = [];
  dropDraft(agy.sessionId);

  agy.messages.push({
    id: 'u-' + Date.now(),
    role: 'user',
    text,
    atts: readyAtts.map((a) => ({ ...a })),
  });
  agy.messages.push(createEmptyAssistantTurn({ sessionId: agy.sessionId || '' }));
  agy.busy = true;
  agy.reconnecting = false;
  beginAgyTurnNotify();

  const payload = chatPayload(text, readyAtts);

  liveHandle = startChat(payload, {
    onEvent: forView(seq, handleStreamEvent),
    onReconnecting: forView(seq, () => { agy.reconnecting = true; }),
    onError: forView(seq, (err) => {
      const turn = getLastAssistantTurn();
      if (turn) {
        turn.status = 'error';
        turn.error = tr(err?.body?.error || err?.message) || t('请求执行失败');
      }
      agy.busy = false;
      agy.reconnecting = false;
      liveHandle = null;
      finishAgyTurnNotify(turn?.error || '', { error: true });
    }),
    onEnded: forView(seq, async (sid) => {
      agy.busy = false;
      liveHandle = null;
      finishAgyTurnNotify('', { silent: false });
      if (sid) await openAgySession(sid);
    }),
    onClose: forView(seq, () => { agy.reconnecting = false; }),
  }, { scope: 'agy' });
}

// 发送原生语音消息：上传 WAV 音频并作为原生音频附件直发给 Gemini，气泡立即复用本地 blob 零延迟播放
export async function sendAgyVoice({ blob, durationSec, peaks, fileName } = {}) {
  if (!blob || !fileName || agy.loadingSession || agy.busy) return { ok: false };
  const seq = viewSeq;
  const startSid = agy.sessionId;
  const localUrl = URL.createObjectURL(blob);
  try {
    const res = await api.uploadBlob(fileName, blob);
    if (seq !== viewSeq || agy.sessionId !== startSid) {
      URL.revokeObjectURL(localUrl);
      return { ok: false, stale: true };
    }
    const uploadedPath = res?.path || '';
    if (!uploadedPath) throw new Error('missing upload path');
    if (Array.isArray(peaks) && peaks.length) {
      saveVoicePeaks(uploadedPath, peaks);
      saveVoicePeaks(fileName, peaks);
    }
    const voiceAtt = {
      path: uploadedPath,
      name: fileName,
      kind: 'voice',
      url: localUrl,
      size: blob.size,
      duration: Math.round((Number(durationSec) || 1) * 100) / 100,
      peaks: Array.isArray(peaks) ? peaks : [],
    };
    await sendAgyMessage('', [voiceAtt]);
    return { ok: true, att: voiceAtt };
  } catch (err) {
    URL.revokeObjectURL(localUrl);
    showToast(tr(err?.body?.error || err?.message) || t('语音上传失败，请重试'), 'err');
    return { ok: false, error: err };
  }
}

// 一条消息的请求体（直接发与排队共用）
function chatPayload(text, readyAtts) {
  const pc = thisDeviceId();
  return {
    agent: 'agy',
    message: text,
    // 发起端：手机 App / 窄屏按手机宽度出内嵌图表；从桌面客户端发的带上本机设备 id（新会话没选过电脑时默认连这台）
    client: (typeof window !== 'undefined' && window.AndroidStore) ? 'apk' : 'web',
    ...(narrowViewport() ? { narrow: true } : {}),
    ...(pc ? { fromComputer: pc } : {}),
    ...(agy.sessionId ? { sessionId: agy.sessionId } : {}),
    ...(!agy.sessionId && agy.projectId ? { agyProjectId: agy.projectId } : {}),
    ...(!agy.sessionId && !agy.projectId && agy.cwd ? { cwd: agy.cwd } : {}),
    ...(!agy.sessionId && agy.deviceDraft !== 'auto' ? { agyComputer: agy.deviceDraft } : {}),
    ...(agy.model ? { agyModel: agy.model } : {}),
    ...(agy.thoughtLevel ? { agyThoughtLevel: agy.thoughtLevel } : {}),
    ...(agy.mode ? { agyMode: agy.mode } : {}),
    ...(readyAtts.length ? { attachments: readyAtts.map((a) => a.path), agyAtts: cleanAtts(readyAtts) } : {}),
  };
}

// —— 一轮在跑时再发的话 ——
// 两种发法（服务端 agents/agy.mjs）：
//   steer  中途插话：送进正在跑的这一轮，它做完手头这一步就读到，不打断；这条消息由事件流里的 steer 事件摆进回答中间。
//   queue  稍后发送：存在服务端排队（queue.mjs），这一轮收尾后自动作为下一轮发出去；人按了停止则整队退回输入框。
// 人切到后台、换台设备都不耽误。
let busyPostBusy = false;
async function postWhileBusy(text, readyAtts, how) {
  const sid = agy.sessionId;
  // 新对话的第一轮还没拿到会话 id（就开头一两秒）：这时送不进去
  if (!sid) { showToast(t('对话还在建立，稍等一下再发'), 'err'); return; }
  if (busyPostBusy) return;
  busyPostBusy = true;
  const seq = viewSeq;
  const keepText = agy.draftText, keepAtts = [...agy.draftAtts];
  agy.draftText = '';
  agy.draftAtts = [];
  dropDraft(sid);
  try {
    const res = await api.post('/api/chat', { ...chatPayload(text, readyAtts), [how]: true });
    if (seq !== viewSeq || agy.sessionId !== sid) return;
    // 插话成功：气泡随事件流里的 steer 事件出现，这里不用再摆
    if (res?.steered) return;
    // 排上了（稍后发送；或插话时这一轮正好收不了消息，服务端替我们改成了排队）
    if (res?.queued) { agy.queue = Array.isArray(res.queue) ? res.queue : agy.queue; return; }
    // 发的那一刻这一轮刚好跑完：服务端直接开跑了，接上去
    if (res?.started && !agy.busy) followQueuedTurn({ text, atts: readyAtts });
  } catch (err) {
    if (seq === viewSeq && agy.sessionId === sid && !agy.draftText && !agy.draftAtts.length) {
      agy.draftText = keepText;
      agy.draftAtts = keepAtts;
    }
    showToast(tr(err?.body?.error || err?.message) || (how === 'steer' ? t('没能送达，再发一次试试') : t('排队失败')), 'err');
  } finally {
    busyPostBusy = false;
  }
}

// 稍后发送：这一轮结束后再发（不在跑时就是普通发送）
export async function sendAgyLater(rawText = agy.draftText, rawAtts = agy.draftAtts) {
  const text = String(rawText ?? '').trim();
  const readyAtts = (Array.isArray(rawAtts) ? rawAtts : []).filter((a) => a && !a.pending && a.path);
  if ((!text && !readyAtts.length) || agy.loadingSession) return;
  if (!agy.busy) return sendAgyMessage(text, readyAtts);
  return postWhileBusy(text, readyAtts, 'queue');
}

export async function stopAgyTurn() {
  const sid = agy.sessionId || liveHandle?.sessionId || '';
  try { await agyApi.stop(sid); } catch { liveHandle?.stop(); }
}

export async function retryAgyFrom(msgIndex) {
  if (agy.busy) return;
  for (let i = msgIndex; i >= 0; i--) {
    const m = agy.messages[i];
    if (m && m.role === 'user') {
      await sendAgyMessage(m.text, (m.atts || []).filter((a) => a.path));
      return;
    }
  }
}

export async function changeAgyConfig(configId, value) {
  if (configId === 'model') agy.model = value;
  else if (configId === 'thought_level') agy.thoughtLevel = value;
  else if (configId === 'mode') agy.mode = value;

  if (!agy.sessionId) return;
  try {
    const res = await agyApi.setConfig(agy.sessionId, configId, value, agy.cwd);
    syncConfigFromSnapshot(res);
  } catch (err) {
    showToast(tr(err?.body?.error || err?.message) || t('切换配置失败'), 'err');
  }
}

export async function submitAgyPermission(perm, optionId) {
  if (!perm || perm.status !== 'pending') return;
  try {
    const outcome = optionId ? 'selected' : 'cancelled';
    const res = await agyApi.answerPermission(perm.requestId, optionId, outcome);
    if (res?.ok) {
      perm.status = optionId ? 'resolved' : 'cancelled';
      perm.selectedOptionId = optionId || null;
      const turn = getLastAssistantTurn();
      const tid = String(perm.toolCallId || '');
      if (turn && tid && turn.toolsById?.[tid]) {
        turn.toolsById[tid].approvalState = resolveApprovalDecision(outcome, optionId);
      }
    }
  } catch (err) {
    showToast(tr(err?.body?.error || err?.message) || t('审批提交失败'), 'err');
  }
}

export async function submitAgyQuestion(qItem, action, content = {}) {
  if (!qItem || qItem.status !== 'pending') return;
  try {
    const res = await agyApi.answerQuestion(qItem.requestId, action, content);
    if (res?.ok) {
      qItem.status = action === 'accept' ? 'answered' : 'cancelled';
      qItem.action = action;
      qItem.answer = action === 'accept' ? content : null;
    }
  } catch (err) {
    showToast(tr(err?.body?.error || err?.message) || t('提交回答失败'), 'err');
  }
}

export { removeAgyQueued, sendAgyQueuedNow, loadAgyDeviceLink, setAgyDevice } from './remote.js';

export {
  selectProjectForNewChat,
  selectDirectoryForNewChat,
  createAgyProjectAt,
  pinAgyProject,
  renameAgyProject,
  deleteAgyProject,
  reorderAgyProjects,
  locateAgyFileInWorkspace,
  scrollToAgyCard,
  uploadAgyFile,
  pushAgyFolder,
  attachAgyTransfer,
  removeAgyDraftAtt,
  pushAgyDraftAtt,
  renameAgySession,
  hideAgySession,
  hideAgyWorkspaceSessions,
  restoreAgySession,
  restoreAllHiddenAgySessions,
} from './workspace-actions.js';
