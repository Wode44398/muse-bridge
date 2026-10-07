// Chat controller — turns the SSE event stream into a reactive message model the
// UI renders. One conversation ON SCREEN at a time (session.id)；服务端支持多轮并行
// （多对话并发）：切走的直播轮在后端继续跑，本地只保留正看那轮的 SSE。
//
// ── 同步内核（单写者）─────────────────────────────────────────────────────────
// 2026-08-11 重写。以前这里有六条并行的恢复路径（startChat 内置重连 / resumeIfActive /
// mirrorActiveTurn / followSession / reconcileSession / scheduleStaleTakeover），每条都能
// 独立决定「这一轮结束了」并改消息列表，靠十来个门旗互相让位——组合竞态修不完，表现为
// 「复制按钮出来了却还在转圈」「重连中卡死」「杀后台重进才有完整输出」。现在只有一条规则：
//
//   ① 单写者：只有内核（用户显式操作 + 唯一一条直播流 + syncOnce）能改
//      chat.messages / session.busy / m.status。其余一切来源（总线事件、回前台、
//      看门狗、断流）只能调 requestSync()。
//   ② 状态以服务端为准：m.status 变成 done 只有两条路——直播流里收到终止事件
//      （done/interrupted/error，本就是服务端说的），或服务端确认「这轮没在跑」之后
//      的终局化。本地绝不因为「流断了」就猜结局。
//   ③ 所有唤醒源收敛到同一个幂等的 syncOnce：探 /api/active →
//      在跑 → 保证挂着直播（attach 整轮重放，天然去重）；
//      没在跑而视图未收敛 → attach 重放完成轮（服务端长保留，含最终 done），
//        204 才退到 transcript 对账；
//      已收敛 → 轻量新鲜度合并（别处/CLI 写的内容原地补上）。
//
// 配套的服务端改动：完成的 gen 不再只留 60s，而是保留到同会话下一轮开跑（+LRU/时效
// 兜底，见 src/runtime/gen.mjs）——重连不再有「60 秒悬崖」，几乎永远能整轮重放。
//
// Event vocabulary (must match src/agents/claude.mjs exactly; 接口真相 impl-contract §2):
//   session{sessionId,model[,swapped,from]} · text{text} · thinking{text} ·
//   tool{id,name,index} · tool_args{id,index,summary,input} · tool_done{id,isError,ms} ·
//   usage{output,thinking} · context{used,total,pct} · limits{limits,updatedAt} · retry{...} ·
//   question{qid,questions[]} · task_start/task_progress/task_update/task_done{taskId,toolUseId,…} ·
//   agent_msg{toolUseId,kind,text|name,summary,model} · model_notice{subtype,from,to,scope,…} ·
//   retract{text,thinking,tools} · error{message,title,...} · done{result,isError} ·
//   ctx_usage{sessionId,usage}（done 之后才到，只改 status）· effort{sessionId,level}
// 工具行有结果【状态】事件（tool_done：成败/耗时）但没有结果正文——正文只在服务端 transcript。

import { pump, watch, linkAbort } from './sse.js';
import { api, getToken, authHeaders } from './api.js';
import { apiUrl } from './server.js';
import { claudeArtifactUrl, kindOf as previewKindOf } from './preview.svelte.js';
import { session, settings, ui, status, compose, refusalBand, caps, prefs, sessionWt } from './state.svelte.js';
import { closeTaskDetail, forgetTaskTool, dock } from './dock.svelte.js';
import { toolStandalone, COMPACT_TOOL, isCompactTool } from './toolVerbs.js';
import { claudeDefaultModel } from './caps.js';
import { retractSegments } from './retract.js';
import { cacheMessages, getCachedMessages, getCachedMessagesMeta } from './cache.js';
import { getStyle } from './styles.svelte.js';
import { agentStart, agentStream, agentEnd } from './notify.js';
import { noteAgentTerm } from './dock.svelte.js';
import { handleWsx } from './uiReport.js';
import { noteFsChange } from './fsSync.svelte.js';
import { storeGet, storeSet } from './store.js';
import { IS_CSNAP } from './csnap.js';
import { IS_SOLO } from './solo.js';
import { prefsFor, lastPrefs, notePrefs, absorbServerPrefs } from './chatPrefs.js';
import { mergeProgress, settleProgress, workflowNameFromInput, usageOf, normTaskStatus, taskRunning } from './taskModel.js';
import { t as tt, tr } from './i18n.js';   // 本文件的 t 是工具行/任务局部变量，翻译函数取别名 tt

// 最近一次打开的会话 id（强持久：关掉页面冷启动也能找回）。session.id 的每个赋值点
// 都同步写入；boot 时 restoreOnBoot 用它把上次的对话自动加载回来。
// 快照模式不持久化：访客的快照会话不该污染同浏览器里主 app 的「上次会话」与本地缓存。
// 分屏那一格 / 拖出的独立窗口（?solo=）同理：它们开的会话不是主页面的「上次会话」。
const LAST_KEY = 'bridge-last-session';
function rememberSession(id) { if (IS_CSNAP || IS_SOLO) return; try { storeSet(LAST_KEY, id || null); } catch {} }

// —— 会话级选择器记忆（model/effort/fast）————————————————
// 打开会话 → 恢复该会话上次的选择；新对话 → 用最近一次的选择；每次发送/绑定新会话 id
// 时记一笔（本地立即 + 服务端 sidecar 随 /api/chat 落盘）。快照页整套跳过。
function applyPrefs(p) {
  if (IS_CSNAP) return;
  settings.model = (p && p.model) || null;
  settings.effort = (p && p.effort) || null;
  settings.fast = !!(p && p.fast);
}
function notePrefsNow(id) {
  if (IS_CSNAP) return;
  notePrefs(id, { model: settings.model, effort: settings.effort, fast: settings.fast });
}
// 选择器组件（ModelPicker/EffortPanel）改动时调：当前会话与「新对话默认」都立刻记住，
// 改完没发送就杀后台也不丢。
export function rememberCurrentPrefs() { notePrefsNow(session.id); }

export const chat = $state({
  messages: [],
  reconnecting: false,
});

const isTerminal = (ev) => ev && (ev.type === 'done' || ev.type === 'interrupted' || ev.type === 'error');
// /api/active 归一：新后端 runs[]=全部在跑的轮；旧后端只有顶层单轮字段。
const runsOf = (a) => (a && Array.isArray(a.runs)) ? a.runs : ((a && a.active) ? [a] : []);

// ---- 内核状态（全部集中在这里，不再散落十个门旗）--------------------------------
let live = null;          // 唯一直播流 { sessionId, ctrl, terminal, wdKilled }——不变量：最多一条
let lastLiveAt = 0;       // 直播流最近收到任何事件的时刻（判死活只能用它，不能用消息 startedAt）
let kernelEpoch = 0;      // 用户显式操作（发送/切会话/新聊天/停止）时 +1，作废一切在途 sync 的应用
let pendingSend = false;  // POST /api/chat 尚未落地：sync 不许插手（还没有可收敛的服务端状态）
let failingSince = 0;     // 「未收敛且连不上」的醒时起点（冻结/断网那段由 wake 拨回，不计入）
let timer = null;

function bumpEpoch() { kernelEpoch++; }
function killLive() {
  if (!live) return;
  try { live.ctrl.abort(); } catch {}
  live = null;
}
// 视图是否「未收敛」：还有一条消息自称在流式，或全局旗还立着。
function unsettled() {
  const m = cur();
  return session.busy || chat.reconnecting || !!(m && m.role === 'assistant' && m.status === 'streaming');
}

// 已上传进 uploads 的附件，记下它在服务端的文件名（file）：直播气泡照旧用本地 blob: 预览
// （秒显），但 blob 只活在这一页里——落缓存、页面重载、切会话回收后它就是死链。有了 file，
// 缓存/失败回退时都能换成服务端副本（/api/upload/raw），和重开会话时历史给的是同一条。
const UPLOAD_FILE_RE = /[\\/]uploads[\\/]([^\\/]+)$/;
const sentAttachments = (list) => (list || []).map((a) => {
  const file = a.kind === 'image' && !a.local && a.path ? (UPLOAD_FILE_RE.exec(a.path) || [])[1] : null;
  return {
    path: a.path || null,
    name: a.name,
    kind: a.kind,
    url: a.url || null,
    ...(file ? { file } : {}),
    ...(a.quoteId ? { quoteId: a.quoteId } : {}),
    ...(a.local ? { local: true } : {}),
  };
});

const isBlobUrl = (u) => typeof u === 'string' && u.startsWith('blob:');

// 写本地缓存前把 blob: 预览换掉：能换成服务端副本就换（有 file），换不了就置空（气泡回落成
// 文件卡，等网络那份回来整表替换）。此前 finishTurn 把 blob 原样写进 IndexedDB，App 重启 /
// 被系统回收后再打开会话，缓存里的图全是死链——破图，且之后的合并认为「没变」永远修不好。
function persistable(list) {
  return (list || []).map((m) => {
    if (!m || m.role !== 'user' || !(m.attachments || []).some((a) => isBlobUrl(a?.url))) return m;
    return {
      ...m,
      attachments: m.attachments.map((a) => {
        if (!isBlobUrl(a?.url)) return a;
        return a.file ? { ...a, url: uploadRawUrl(a.file), thumb: uploadRawUrl(a.file, 'preview') } : { ...a, url: null };
      }),
    };
  });
}
const cacheChat = (sid, list) => cacheMessages(sid, persistable(list));

// 气泡 <img> 加载失败时的自愈（onerror 调）：依次试其余候选：缩略图 → 原图 → 按服务端文件名
// 现算（带【当前】token，治缓存里 token 已轮换 / blob 已回收的旧 URL）。
// 候选全试过就停手，交给元素自己的失败态（不会死循环）。每一条试过的地址都记账。
export function attImgFallback(img, a) {
  if (!img || !a) return;
  const tried = (img.dataset.tried || '').split('\n').filter(Boolean);
  const go = (u) => { tried.push(u); img.dataset.tried = tried.join('\n'); img.src = u; };
  tried.push(img.src);
  const cands = [a.thumb, a.url, a.file && uploadRawUrl(a.file, 'preview'), a.file && uploadRawUrl(a.file)]
    .filter((u) => u && !isBlobUrl(u) && !tried.includes(u));
  if (cands.length) go(cands[0]);
  else img.dataset.tried = tried.join('\n');
}

function revokeMessageBlobUrls(list) {
  for (const m of list || []) {
    for (const a of m?.attachments || []) {
      if (typeof a?.url === 'string' && a.url.startsWith('blob:')) {
        try { URL.revokeObjectURL(a.url); } catch {}
      }
    }
  }
}

function replaceMessages(next) {
  if (chat.messages !== next) revokeMessageBlobUrls(chat.messages);
  chat.messages = next;
  // 整表换掉 = 切会话/新聊天：工作台任务视图里挂的是旧表的条目、横条属于旧会话，一并收掉
  //（官方语义：重进会话时历史上的回退只留时间线卡、不再弹横条）。
  closeTaskDetail();
  refusalBand.notice = null;
}

// 快照模式：Claude 调 close_snapshot 关停时后端广播 snap_closed——SnapPage 挂监听切「已关停」态。
let _onSnapClosed = null;
export function onSnapClosed(fn) { _onSnapClosed = fn; return () => { if (_onSnapClosed === fn) _onSnapClosed = null; }; }

// NB: after push, return the PROXIED element (chat.messages[i] / m.segments[i]),
// not the plain literal — Svelte 5 deep-proxies on push, and mutating the original
// reference bypasses the proxy so the UI never updates.
function newAssistant() {
  // 新一轮：上一轮的工具/任务索引作废（别让旧 proxy 挂在 Map 里）——还在跑的后台任务除外：
  // 挂起接力后它们的进度/完成帧从下一轮的流里来，得还能找到上一轮那条工具行。
  resetToolIndex(true);
  chat.messages.push({
    role: 'assistant',
    // 段模型（与服务端 /api/session 历史重建同构，见 impl-contract §4.1）：
    //   {kind:'text',md} | {kind:'tools',open,tools:[{id,name,index,summary,input,status,ms,task}]} |
    //   {kind:'notice',subtype,from,to,…}（模型切换/安全栅门卡）| {kind:'ask',…}
    segments: [],
    thinking: '',
    thinkingOpen: false,
    status: 'streaming',
    error: null,
    tokens: 0,
    thinkingTokens: 0,
    startedAt: Date.now(),
    elapsed: 0,
    question: null,
    phase: 'shimmer',     // 星标运行相位（见 PHASE）：起步=shimmer 过渡态，首个事件落定
    idle: false,          // 长静默（排队/限流等）→ Thread 星标降成 waiting 慢呼吸
    bgHold: null,         // 悬停收轮（服务端 bg_hold）：{count,tasks,deadline}——本轮挂起等后台任务
    textBreak: false,     // 下一段正文另起一段（悬停续轮时置位，见 textSeg）
    // 状态行运行态（见 trackRun / computeHint）：wait=在等什么，think*=思考起止，hint=当前显示的那条。
    wait: 'sending', thinkStart: 0, thinkEnd: null, retry: null, compacting: false,
    hint: null, hintAt: 0, replayAt: 0,
  });
  pendingTools.clear();
  return chat.messages[chat.messages.length - 1];
}
const cur = () => chat.messages[chat.messages.length - 1];

// textBreak：悬停续轮（后台任务跑完、CLI 唤醒模型接着说）的正文【另起一段】——不隔开的话
// 「已在后台启动」会和几分钟后的「后台命令已跑完…」粘成一句话（历史重建 sessions.mjs 同治）。
function textSeg(m) {
  const last = m.segments[m.segments.length - 1];
  if (last && last.kind === 'text' && !m.textBreak) return last;
  m.textBreak = false;
  m.segments.push({ kind: 'text', md: '' });
  return m.segments[m.segments.length - 1];
}
function toolsSeg(m) {
  const last = m.segments[m.segments.length - 1];
  if (last && last.kind === 'tools') return last;
  m.segments.push({ kind: 'tools', tools: [], open: false });
  return m.segments[m.segments.length - 1];
}
// 最后一个 tools 段（不管后面有没有正文）——task_start 找不到对应工具行时合成条目的落点。
function lastToolsSeg(m) {
  for (let i = m.segments.length - 1; i >= 0; i--) if (m.segments[i].kind === 'tools') return m.segments[i];
  return null;
}
// 旧服务端兼容：tool_args 只带 content-block index 时按 index 从后往前找。
function findToolByIndex(m, index) {
  if (typeof index !== 'number' || index < 0) return null;
  for (let i = m.segments.length - 1; i >= 0; i--) {
    const s = m.segments[i];
    if (s.kind === 'tools') { const t = s.tools.find((x) => x.index === index); if (t) return t; }
  }
  return null;
}

// —— 工具行 / 后台任务索引（模块级，存的是【proxy】）——
// toolById：tool_use id → tools 段条目；taskById：taskId 与 toolUseId 都指向同一条目（task_*
// 事件两个 id 都可能带）。newAssistant 与 attach 重放开头清空——重放会清掉 segments 再按
// 事件顺序重建，索引若不跟着清就会指向已不在视图里的旧对象。
const toolById = new Map();
const taskById = new Map();
// 进行中的压缩条目（status:compacting 起的行，还没等到带 uuid 的 boundary）——边界到了就把 id 补上。
let compactPending = null;
// 只留【仍在视图里】且任务在跑的条目（前几轮挂起的后台任务）。replaying = attach 重放的那条消息，
// 它自己的工具行随后整段清掉重建，也不能留。留下不在视图里的旧 proxy 会让重放的 tool 事件当成
//「已有行」跳过入段（卡片从对话里消失），之后的 task_* 帧全写进孤儿对象（任务面板只剩挂起清单
// 兜底出的空卡）。两条路径都踩过：本条仍在流式时 attach 就地重放；本条已被判成超时/切走收成
// 非流式时，attach 剪掉历史尾部再新建一条——旧那条已不在 chat.messages 里。
function toolsInView(except) {
  const set = new Set();
  for (const msg of chat.messages) {
    if (!msg || msg === except || msg.role !== 'assistant') continue;
    for (const s of (msg.segments || [])) if (s && s.kind === 'tools') for (const t of (s.tools || [])) set.add(t);
  }
  return set;
}
function resetToolIndex(keepRunningTasks = false, replaying = null) {
  compactPending = null;
  if (!keepRunningTasks) { toolById.clear(); taskById.clear(); return; }
  const inView = toolsInView(replaying);
  const alive = (v) => !!(v && inView.has(v) && v.task && taskRunning(v.task.status));
  for (const [k, v] of toolById) if (!alive(v)) toolById.delete(k);
  for (const [k, v] of taskById) if (!alive(v)) taskById.delete(k);
}
function forgetEntry(entry) {
  for (const [k, v] of toolById) if (v === entry) toolById.delete(k);
  for (const [k, v] of taskById) if (v === entry) taskById.delete(k);
  forgetTaskTool(entry);   // 工作台任务视图里挂着的就是这条被撤回的行 → 收掉
}
// 已落过 settings.model 的会话模型切换（session{swapped}）：attach 整轮重放会把同一条再送一遍，同一次切换只落
// 一次，否则用户在本轮里已手动切回的选择会被重放冲掉。键 = 会话 + from>to + 服务端时间戳。
const appliedSwaps = new Set();
// 工具行条目的统一形状——直播 push 与历史归一共用一份，组件与指纹都靠它稳定。
function makeTool(x) {
  return {
    id: x.id || '', name: x.name || '', index: typeof x.index === 'number' ? x.index : -1,
    summary: x.summary || '', input: x.input && typeof x.input === 'object' ? x.input : {},
    status: x.status || 'running',   // running | done | error（tool_done 落定；收轮时兜底）
    ms: x.ms || 0,
    ...(x.synthetic ? { synthetic: true } : {}),     // task_start 抢在工具事件前合成的行
    ...(x.interrupted ? { interrupted: true } : {}), // 轮出错/中断时还没回结果的工具
    ...(x.compact ? { compact: makeCompact(x.compact) } : {}),   // 上下文压缩条目（name=COMPACT_TOOL）
    task: x.task ? makeTask(x.task) : null,
  };
}
// 压缩条目的载荷：token 数给官方文案「Compacted session · saved N tokens」，summary = 压缩后注入的
// 摘要正文（行展开的详情），error = 失败原因。直播 compact 事件与历史重建（sessions.mjs）同形。
function makeCompact(c) {
  return {
    trigger: c.trigger === 'manual' ? 'manual' : 'auto',
    preTokens: Number(c.preTokens) || 0, postTokens: Number(c.postTokens) || 0,
    summary: typeof c.summary === 'string' ? c.summary : '', error: c.error || '',
  };
}
// 直播 compact 事件（服务端 claude.mjs 转 SDK 的 status / compact_boundary / 摘要帧）。帧序不固定
//（手动 /compact 时 end 先于 boundary 到），各阶段都按「找到就补、找不到就建」写，重放幂等。
function applyCompact(m, ev) {
  const byId = ev.id ? toolById.get(ev.id) : null;
  const open = () => pushTool(m, { name: COMPACT_TOOL, status: 'running', compact: {} });
  switch (ev.phase) {
    case 'start':
      if (!compactPending) compactPending = open();
      break;
    case 'end': {
      const t = compactPending;
      if (!t) break;
      if (ev.ok === false) { t.status = 'error'; t.compact.error = ev.error || ''; compactPending = null; }
      else t.status = 'done';   // 仍挂着 pending：随后的 boundary 补 id 与 token 数
      break;
    }
    case 'boundary': {
      const t = byId || compactPending || open();
      compactPending = null;
      t.status = 'done';
      if (ev.id && t.id !== ev.id) { t.id = ev.id; toolById.set(ev.id, t); }
      if (typeof ev.ms === 'number' && ev.ms > 0) t.ms = ev.ms;
      t.compact.trigger = ev.trigger === 'manual' ? 'manual' : 'auto';
      t.compact.preTokens = Number(ev.preTokens) || 0;
      t.compact.postTokens = Number(ev.postTokens) || 0;
      break;
    }
    case 'summary':
      if (byId && byId.compact && typeof ev.summary === 'string') byId.compact.summary = ev.summary;
      break;
  }
}
// 后台任务记录：Agent/Task/Workflow/后台 Bash 的 task_* 生命周期挂在它的工具行上。
function makeTask(x) {
  return {
    taskId: x.taskId || '', taskType: x.taskType || '',
    description: x.description || '', subagentType: x.subagentType || '',
    workflowName: x.workflowName || x.name || '', name: x.name || x.workflowName || '',
    prompt: x.prompt || '', backgrounded: typeof x.backgrounded === 'boolean' ? x.backgrounded : null,
    command: x.command || '',                                   // 后台 shell 的命令行（历史 tool_use.input / 直播 Stop hook）
    depth: typeof x.depth === 'number' ? x.depth : 0,
    // running | completed | failed | stopped | unknown（历史无记录）| pending/paused（task_update 原样，UI 当 running）
    status: x.status || 'unknown',
    startedAt: x.startedAt || 0, endedAt: x.endedAt || 0,
    usage: usageOf(x.usage), lastTool: x.lastTool || '', summary: x.summary || '', error: x.error || '',
    result: x.result || '', outputFile: x.outputFile || '',
    step: x.step || '',                                         // Workflow：task_progress 报的当前步骤（"Ping: ping:a"）
    progress: Array.isArray(x.progress) ? x.progress : [],       // Workflow：合并后的 workflow_progress 快照
    phasesMeta: Array.isArray(x.phasesMeta) ? x.phasesMeta : [], // Workflow：脚本 meta.phases（历史回落占位）
    entries: Array.isArray(x.entries) ? x.entries : [],          // Agent：子转录 {kind:'text',text}|{kind:'tools',tools:[{name,summary}]}|{kind:'thinking'}
    toolCount: x.toolCount || 0, latestToolName: x.latestToolName || '', model: x.model || '',
  };
}
// 工具行入段（官方 HD 分桶）：standalone 桶的工具（Workflow 等，toolVerbs.STANDALONE_TOOLS）自己一段，
// 它后面的工具也另起一段；其余连续 tool_use 并进同一段。服务端历史重建 sessions.mjs 同构。
function pushTool(m, x) {
  const last = m.segments[m.segments.length - 1];
  const prev = last && last.kind === 'tools' && last.tools.length ? last.tools[last.tools.length - 1] : null;
  const join = last && last.kind === 'tools' && !toolStandalone(x.name) && !(prev && toolStandalone(prev.name));
  if (!join) m.segments.push({ kind: 'tools', tools: [], open: false });
  const seg = m.segments[m.segments.length - 1];
  seg.tools.push(makeTool(x));
  const entry = seg.tools[seg.tools.length - 1];   // 取回 proxy（push 进 $state 后原字面量不再响应）
  if (entry.id) toolById.set(entry.id, entry);
  return entry;
}
// 给工具行挂 / 补任务记录：已有则只补空字段——entries/progress 不动（agent_msg 可能比
// task_start 先到），status 只允许 unknown/running 被推进。
function ensureTask(entry, seed) {
  if (!entry.task) { entry.task = makeTask(seed); return entry.task; }
  const t = entry.task;
  for (const k of Object.keys(seed)) {
    const v = seed[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (k === 'status') { if (t.status === 'unknown' || t.status === 'running') t.status = v; continue; }
    if (t[k] == null || t[k] === '' || t[k] === 0 || t[k] === false) t[k] = v;
  }
  return t;
}
function findTaskEntry(ev) {
  return (ev.taskId && taskById.get(ev.taskId)) || (ev.toolUseId && (taskById.get(ev.toolUseId) || toolById.get(ev.toolUseId))) || null;
}
// 子 agent 转录条目（agent_msg）：连续文本并成一条、连续工具并成一组、思考只留占位。
function appendAgentEntry(t, ev) {
  const list = t.entries;
  const last = list[list.length - 1];
  if (ev.kind === 'text') {
    const text = ev.text || '';
    if (!text) return;
    if (last && last.kind === 'text') last.text += (last.text ? '\n\n' : '') + text;
    else list.push({ kind: 'text', text });
  } else if (ev.kind === 'tool') {
    const tool = { name: ev.name || '', summary: ev.summary || '' };
    if (last && last.kind === 'tools') last.tools.push(tool);
    else list.push({ kind: 'tools', tools: [tool] });
    t.toolCount += 1;
    if (tool.name) t.latestToolName = tool.name;
  } else if (ev.kind === 'thinking') {
    if (!last || last.kind !== 'thinking') list.push({ kind: 'thinking' });
  }
  if (ev.model) t.model = ev.model;
}
// 模型切换 / 安全栅门通知段（直播 model_notice 事件与历史 notice 段共用一个形状）。
function noticeFromEvent(ev) {
  return {
    kind: 'notice', subtype: ev.subtype || '', direction: ev.direction || '', scope: ev.scope || '',
    from: ev.from || '', to: ev.to || '', trigger: ev.trigger || '', category: ev.category || null,
    explanation: ev.explanation || '', text: ev.text || '', requestId: ev.requestId || '',
    refusedUserUuid: ev.refusedUserUuid || '', retracted: Array.isArray(ev.retracted) ? ev.retracted.slice() : [],
    parentToolUseId: ev.parentToolUseId || '', at: ev.at || Date.now(),
  };
}
// 收轮兜底：还挂着 running 的工具行 / 后台任务给个终态（tool_done 只在 tool_result 回来时
// 发，出错/中断的轮永远等不到它）。done：工具行=done；Agent/Workflow 任务若还 running，说明
// 悬停看门狗放弃了它（bridge 只为这两类悬停）→ stopped；后台 shell 可以常驻，不动。
// error/stopped：工具行=error+interrupted，所有 running 任务=stopped。
function settleTurn(m, how) {
  for (const s of m.segments) {
    if (s.kind !== 'tools') continue;
    for (const t of s.tools) {
      // 压缩行没等到边界就收轮 = 这次压缩没成（成功必有 boundary 补上 id）
      if (isCompactTool(t) && t.status === 'running') { t.status = t.id ? 'done' : 'error'; continue; }
      if (t.status === 'running') { t.status = how === 'done' ? 'done' : 'error'; if (how !== 'done') t.interrupted = true; }
      const k = t.task;
      // 收轮 = SDK 收尾 = CLI 进程结束，【任何】还在跑的后台任务都跟着死（09-15 起后台 shell
      // 也一样：以前放它过去，是按「dev server 可能常驻」的老假设，结果面板里永远挂着一条假的
      // Running。现在只要走到收轮，后台任务要么早已完成、要么刚被一起收掉）。
      if (k && taskRunning(k.status)) {
        k.status = 'stopped';
        if (!k.summary) k.summary = how === 'done' ? 'Ended when the turn finished' : 'Stopped before completion';
        k.endedAt = Date.now();
        if (k.progress.length) k.progress = settleProgress(k.progress, 'stopped');
      }
    }
  }
}
// —— 安全栅门撤回（retract）：把本轮已渲染的内容按服务端算出的【区间】删掉——
// 被拒模型在 client lane 下可能已经流出半截正文/工具行，回退模型会重来一遍；服务端按 uuid 对账
//（runtime/retract-ledger.mjs）给出 {textFrom,textTo,thinkFrom,thinkTo,toolsFrom,toolsTo}，区间之后已流出的
// 回退模型开头原样保留。删法在 lib/retract.js（纯函数，node 单测覆盖），这里只挂索引清理。
function retractTurn(m, ev) { retractSegments(m, ev, forgetEntry); }
// 有「正文类」内容（文本/工具行）——done.result 兜底只看它；hasContent 另认 notice 段
//（只剩一张切换卡的轮也不是空幽灵轮，settleView 不许 pop）。
function hasBody(m) {
  return m.segments.some((s) => (s.kind === 'text' && s.md.trim()) || (s.kind === 'tools' && s.tools.length));
}
function hasContent(m) {
  return hasBody(m) || m.segments.some((s) => s.kind === 'notice');
}
// 通知快照用：当前回复的最后一段可见文本。
function lastText(m) {
  for (let i = m.segments.length - 1; i >= 0; i--) { const s = m.segments[i]; if (s.kind === 'text' && s.md) return s.md; }
  return '';
}

// —— 流式文本节流：text 增量先入缓冲，100ms 批量刷进响应式状态 ——
// 每个 token 都触发 Thread 里整段 markdown 重 parse + DOM 替换，是长回答打字机卡顿
// 的根源（O(n²)）。批量后肉眼仍是连续打字机，重渲染次数降一个数量级。
let txtBuf = '', txtSeg = null, txtTimer = null;
function flushText() {
  if (txtTimer) { clearTimeout(txtTimer); txtTimer = null; }
  if (txtSeg && txtBuf) txtSeg.md += txtBuf;
  txtBuf = ''; txtSeg = null;
}
function dropText() { txtBuf = ''; txtSeg = null; if (txtTimer) { clearTimeout(txtTimer); txtTimer = null; } }
function queueText(m, t) {
  const seg = textSeg(m);
  if (txtSeg && txtSeg !== seg) flushText();
  txtSeg = seg; txtBuf += t;
  if (!txtTimer) txtTimer = setTimeout(flushText, 100);
}

// —— 助手交付的产物附件（done 事件 / 历史重建共用）：补 kind + 预览/下载 URL ——
// 服务端只给 {name,path,kind,size,count,nav?}；URL 在客户端拼（带 ?token=，<img>/下载
// 带不了 Authorization 头）。文件夹无预览 URL：点卡走 nav 在工作台的工作空间视图里打开
// （服务端算好的 {rel} / {ws,rel}），没有 nav 才回落成整包 zip 下载。
function toDeliverAtts(list, sessionId) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.filter((a) => a && a.path).map((a) => {
    const name = a.name || String(a.path).split(/[\\/]/).pop() || tt('文件');
    if (a.kind === 'folder') {
      return { name, path: a.path, kind: 'folder', count: a.count || 0, sessionId,
        nav: a.nav && typeof a.nav === 'object' ? { ws: a.nav.ws || '', rel: a.nav.rel || '' } : null,
        downloadUrl: claudeArtifactUrl(sessionId, a.path, { dl: true, name: name + '.zip' }) };
    }
    const kind = previewKindOf(name);
    return { name, path: a.path, kind: kind === 'other' ? (a.kind || 'other') : kind, size: a.size || 0, sessionId,
      // nav：文件产物的工作台定位（父目录 + open=文件名）——点卡/点链接在右侧工作区打开预览
      nav: a.nav && typeof a.nav === 'object' ? { ws: a.nav.ws || '', rel: a.nav.rel || '', open: a.nav.open || '' } : null,
      url: claudeArtifactUrl(sessionId, a.path, { name }),
      downloadUrl: claudeArtifactUrl(sessionId, a.path, { dl: true, name }) };
  });
}

// —— 星标运行相位：Thread 底部菊花按 claude.ai 同款映射选动画——只认「最近一种活动」。
// thinking→思考脉动 / text→书写 / 工具·子任务·媒体生成→tool(环绕) / 提问→waiting(等回答) /
// 答完先回 thinking。attach 整轮重放按事件顺序自然重建到最新相位，无需特判。
const PHASE = {
  thinking: 'thinking', text: 'writing',
  tool: 'tool', tool_args: 'tool',   // tool_done 不改相位：结果回来不等于活干完
  task_start: 'tool', task_progress: 'tool', task_update: 'tool', task_done: 'tool',
  agent_msg: 'tool',                 // 子 agent 在干活 → 环绕
  question: 'waiting', answer: 'thinking',
  refusal_prompt: 'waiting', refusal_answer: 'thinking',   // 安全栅门暂停：等人二选一
  model_notice: 'thinking', retract: 'thinking',   // 安全栅门切模型重试：换个模型重新想
  bg_hold: 'waiting',   // 悬停等后台子任务：主模型已停笔，星标降成慢呼吸
  compact: 'tool',      // 上下文压缩（动辄一两分钟不出字）：算在干活，别被判成长静默
};

// —— 只改 status、不碰消息列表的事件 ——
// context（每次 API 调用后的上下文填充）/ ctx_usage（done 之后 ~1.5s 才到的 getContextUsage 精确分布）/
// effort（Stop hook 回报的实际档位）/ limits（额度窗口）。它们【可能在本轮定局之后才到】：done 一发，
// 服务端还要 await getContextUsage 再发 ctx_usage；attach 重放同样先 done 后 ctx_usage。applyLiveEvent
// 若像对待正文一样为它们「补开一条 assistant 气泡」，就会造出一个空的、永远转圈的幽灵轮，还把
// session.busy 立起来堵住下一次发送——下一次 sync 的 attach 重放又会把整轮内容灌进这只幽灵，看起来
// 像回答重复了一遍（2026-09-02 集成验收工作流轮实证：done → ctx_usage → 空气泡 → 重放复制）。
const STATUS_ONLY = new Set(['context', 'ctx_usage', 'effort', 'limits']);
function applyStatusEvent(ev) {
  switch (ev.type) {
    case 'context': {
      const c = { used: ev.used, total: ev.total, pct: ev.pct, sessionId: ev.sessionId };
      status.context = c;
      if (ev.sessionId) status.contexts[ev.sessionId] = c;   // 多对话并发：按会话各记各的填充
      return;
    }
    case 'ctx_usage': if (ev.sessionId && ev.usage && ev.usage.max) status.usages[ev.sessionId] = ev.usage; return;
    case 'effort': if (ev.sessionId) status.efforts[ev.sessionId] = { level: ev.level || null, at: Date.now() }; return;
    case 'limits': if (ev.limits) { status.limits = ev.limits; status.updatedAt = ev.updatedAt || Date.now(); } return;
  }
}

// —— 状态行「正在干啥」（官方 /code 页 working line 同款：时长 · tokens · 思考中…/运行工具中…）——
// 移植自桌面包的会话运行态 reducer：waiting ∈ sending → starting（SSE 接通）→ preparing（init）→
// model（发起 API 请求 / 新消息开跑）⇄ tools（主链工具在跑，全部回完回到 model）；正文/思考一开写就清空。
// 思考另记起止：进行中 =「思考中…」（按本轮时长升级措辞），结束后至少凑满 2s 再换成「已思考 N 秒」留 2s。
// 待回结果的工具 id 不进响应式（只有当前这一轮在用，attach 重放按事件顺序重建）。
const pendingTools = new Set();
const THINK_MIN_MS = 2000, THOUGHT_SHOW_MS = 2000, HINT_HOLD_MS = 650, REPLAY_MS = 400;
function thinkBegin(m) {
  if (m.thinkStart) return;
  m.thinkStart = Date.now();
  m.thinkEnd = null;
}
function thinkFinish(m) {
  if (!m.thinkStart) return;
  const now = Date.now();
  // attach 整轮重放会在几毫秒内灌完历史帧：那时算出来的「思考了 0 秒」是假的，不留。
  m.thinkEnd = now - (m.replayAt || 0) < REPLAY_MS ? null : { start: m.thinkStart, end: now };
  m.thinkStart = 0;
}
function trackRun(m, ev) {
  switch (ev.type) {
    case 'attach':
      pendingTools.clear();
      m.wait = 'model'; m.thinkStart = 0; m.thinkEnd = null; m.retry = null; m.compacting = false;
      m.hint = null; m.hintAt = 0; m.replayAt = Date.now();
      return;
    case 'session': if (m.wait === 'sending' || m.wait === 'starting') m.wait = 'preparing'; return;
    case 'mode':
      m.retry = null;
      if (ev.mode === 'thinking') { thinkBegin(m); m.wait = null; if (m.phase !== 'thinking') m.phase = 'thinking'; }
      else if (ev.mode === 'requesting') { thinkFinish(m); m.wait = 'model'; pendingTools.clear(); }
      return;
    case 'thinking': m.retry = null; thinkBegin(m); m.wait = null; return;
    case 'text': m.retry = null; thinkFinish(m); m.wait = null; return;
    case 'tool':
      m.retry = null; thinkFinish(m); m.wait = 'tools';
      pendingTools.add(ev.id || '#' + ev.index);
      return;
    case 'tool_done':
      pendingTools.delete(ev.id);
      if (!pendingTools.size && m.wait === 'tools') m.wait = 'model';
      return;
    case 'compact': m.compacting = ev.phase === 'start'; return;
    case 'retry':
      m.retry = { attempt: Number(ev.attempt) || 0, max: Number(ev.max) || 0, kind: ev.errorKind || '', status: ev.status || 0 };
      return;
    case 'question': case 'bg_hold': case 'refusal_prompt': thinkFinish(m); m.wait = null; return;
  }
}
// 当前该显示哪条状态（纯函数，计时器每 200ms 调一次）。返回 {k,…} 或 null；文案在 Thread 里按 k 取。
function computeHint(m, now) {
  if (m.compacting) return { k: 'compact' };
  if (m.retry) return { k: 'retry', ...m.retry };
  if (m.paused || m.segments.some((s) => s.kind === 'ask' && !s.answered)) return { k: 'ask' };
  if (m.bgHold) return null;   // 挂起等后台任务：右侧任务芯片已经说明在等什么
  const sec = Math.floor((now - m.startedAt) / 1000);
  const thinking = () => ({ k: 'think', n: sec >= 60 ? 4 : sec >= 45 ? 3 : sec >= 30 ? 2 : sec >= 15 ? 1 : 0 });
  if (m.thinkStart) return thinking();
  if (m.thinkEnd) {
    const dur = m.thinkEnd.end - m.thinkEnd.start;
    const until = m.thinkEnd.end + Math.max(0, THINK_MIN_MS - dur);
    if (now < until) return thinking();
    if (now < until + THOUGHT_SHOW_MS) return { k: 'thought', n: Math.max(1, Math.round(dur / 1000)) };
  }
  return m.wait ? { k: m.wait } : null;
}
const hintKey = (h) => (h ? h.k + ':' + (h.n ?? '') + ':' + (h.attempt ?? '') : '');
// 换文案至少停留 650ms（官方同款防抖）：Read 这类 20ms 的工具不至于把「运行工具中…」闪成一帧。
function tickHint(m, now) {
  const h = computeHint(m, now);
  if (hintKey(h) === hintKey(m.hint)) return;
  if (m.hint && now - m.hintAt < HINT_HOLD_MS) return;
  m.hint = h;
  m.hintAt = now;
}

function onEvent(m, ev) {
  lastLiveAt = Date.now();   // 这条流还活着
  const ph = PHASE[ev.type];
  if (ph && m.phase !== ph) m.phase = ph;
  trackRun(m, ev);
  // 悬停态解除：主模型恢复动笔（续轮 init 的 session / 正文 / 主链工具）即回到普通
  // 运行显示。task_* 进度事件【不】解除——后台子任务推进正是挂起期的常态。
  if (m.bgHold && (ev.type === 'session' || ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool')) {
    m.bgHold = null;
    m.textBreak = true;   // 续轮正文另起一段（见 textSeg）
  }
  // 非 text 事件先把缓冲刷进去，保证段落顺序正确（attach 例外：重放重建，缓冲直接丢弃）。
  if (ev.type === 'attach') dropText();
  else if (ev.type !== 'text') flushText();
  switch (ev.type) {
    // 断线重连成功：/api/attach 会从头重放整个缓冲，先清掉本条已渲染内容，
    // 否则 text/tools 会追加第二遍（内容翻倍）。重放随后完整重建。
    case 'attach':
      resetToolIndex(true, m);  // 重放会按事件顺序重建工具行/任务，索引跟着重建（【前几轮】仍在跑的后台任务留着，同上；本条自己的不留）
      m.segments = [];
      m.thinking = '';
      m.question = null;
      m.phase = 'shimmer';   // 相位归零，重放事件流会按顺序重建到最新相位
      m.idle = false;
      m.bgHold = null;       // 重放会按事件顺序重建悬停态（bg_hold → session/text 解除）
      m.paused = false;      // 同理：安全栅门暂停由重放里的 refusal_prompt / refusal_answer 重建
      // elapsedMs：把"思考 Ns"计时器重锚到服务端真实起点——杀后台/刷新回来不再从 0 数。
      if (typeof ev.elapsedMs === 'number' && ev.elapsedMs >= 0) {
        m.startedAt = Date.now() - ev.elapsedMs;
        m.elapsed = ev.elapsedMs;
      }
      break;
    case 'session':
      if (ev.sessionId) {
        // 新会话首轮：id 此刻才定下来——把发送时的选择器记忆补绑到这个会话上。
        if (!session.id) notePrefsNow(ev.sessionId);
        session.id = ev.sessionId; rememberSession(ev.sessionId);
        if (ev.wt && ev.wt.cwd) sessionWt[ev.sessionId] = ev.wt;   // worktree 会话：工作台当场切过去
      }
      // fast 实况回执：开了开关也可能因冷却/额度没点亮（status.fast: null=未知/未开）。
      if ('fast' in ev) status.fast = !!ev.fast;
      if (ev.swapped && ev.model) {
        // 安全栅门把会话模型换掉（scope=session 的回退，服务端 sidecar 已改）：选择器跟着切
        // 过去并记忆——官方语义「会话模型已切换，用户可手动切回」；下一轮 bridge 显式传的
        // 就是回退模型。session.id 上面刚对齐过，这里不必再比。重放幂等（appliedSwaps）。
        const sid = ev.sessionId || session.id || '';
        const key = sid + '|' + (ev.from || '') + '>' + ev.model + '@' + (ev.at || '');
        if (!appliedSwaps.has(key)) {
          appliedSwaps.add(key);
          settings.model = ev.model;
          rememberCurrentPrefs();
        }
        if (sid) status.models[sid] = { id: ev.model, from: ev.from || '', at: ev.at || Date.now() };
      } else if (ev.model) {
        // 普通 init 回执 = 本轮实际跑的模型（带 [1m] 后缀，剥掉再比）。会话上次被安全栅门换过模型
        //（status.models 有记录）时对账：与当前所选一致 → 记号清掉（用户手动切回原模型并跑完一轮后，
        // 芯片不该还点线下划说「已切换到 X」）；不一致（服务端夹紧了）→ 记实况、from 留空（芯片给通用提示）。
        const sid = ev.sessionId || session.id || '';
        if (sid && status.models[sid]) {
          const bare = String(ev.model).replace(/\[1m\]$/, '');
          if (bare === (settings.model || claudeDefaultModel(caps.data))) delete status.models[sid];
          else status.models[sid] = { id: bare, from: '', at: Date.now() };
        }
      }
      break;
    case 'text': queueText(m, ev.text || ''); agentStream('Claude', lastText(m)); break;
    case 'thinking': m.thinking += ev.text || ''; break;
    case 'tool': {
      // 索引命中但那一行不在本条消息里（上面 resetToolIndex 注释里的孤儿）= 不算已有，照常入段——
      // 宁可重建一行，也不能让卡片凭空消失。pushTool 随即把索引改指向新行。
      let known = ev.id ? toolById.get(ev.id) : null;
      if (known && !(m.segments || []).some((s) => s && s.kind === 'tools' && (s.tools || []).includes(known))) known = null;
      if (known) { if (ev.name) known.name = ev.name; if (typeof ev.index === 'number') known.index = ev.index; }
      else pushTool(m, { id: ev.id, name: ev.name, index: ev.index });
      break;
    }
    case 'tool_args': {
      const t = (ev.id && toolById.get(ev.id)) || findToolByIndex(m, ev.index);
      if (!t) break;
      if (ev.summary) t.summary = ev.summary;
      if (ev.input && typeof ev.input === 'object') t.input = ev.input;
      if (t.name === 'Workflow' && t.task && !t.task.name) {   // 工作流名：input.name（task_start 若先到已试过脚本头）
        const n = workflowNameFromInput(t.input);
        if (n) { t.task.name = n; if (!t.task.workflowName) t.task.workflowName = n; }
      }
      break;
    }
    case 'tool_done': {
      const t = ev.id ? toolById.get(ev.id) : null;
      if (t) { t.status = ev.isError ? 'error' : 'done'; if (typeof ev.ms === 'number') t.ms = ev.ms; }
      break;
    }
    case 'usage':
      if (typeof ev.output === 'number') m.tokens = ev.output;
      if (typeof ev.thinking === 'number') m.thinkingTokens = ev.thinking;
      break;
    // 只改 status 的事件（上下文填充 / 分布 / 实际 effort / 额度）——统一走 applyStatusEvent，
    // 收轮之后还会到的那几条（ctx_usage 在 done 之后 ~1.5s）在 applyLiveEvent 里也走它，不再开气泡。
    case 'context': case 'ctx_usage': case 'effort': case 'limits': applyStatusEvent(ev); break;
    // 检查点回滚锚点：本轮用户消息在 transcript 里的 uuid → 挂到最近的用户气泡上
    //（「回滚到此」入口据此可用；历史重开的气泡由 /api/session 直接带 uuid）。
    case 'anchor': {
      for (let i = chat.messages.length - 1; i >= 0; i--) {
        const u = chat.messages[i];
        if (u.role === 'user') { if (ev.uuid) u.uuid = ev.uuid; break; }
      }
      break;
    }
    case 'retry': chat.reconnecting = true; break;
    // agent 用了共享终端：宽屏自动拉开终端面板同屏，窄屏亮提示点。
    case 'term': noteAgentTerm(); break;
    // 工作区协同指令（文件面板刷新/导航、推预览、截图/草稿请求）——uiReport 统一处理。
    case 'wsx': handleWsx(ev); break;
    // agent 的 Edit/Write 落盘成功：打开中的文档查看器自动跟盘刷新（fsSync）。
    case 'fs': noteFsChange(ev.path); break;
    case 'question': showQuestion(m, ev); break;
    case 'answer': markAnswered(m, ev); break;
    // 安全栅门暂停（服务端 onRefusalDialog）：输入框上方摆 Paused 卡，等人选「编辑重试 / 换模型」。
    // attach 重放按顺序先 prompt 后 answer，已答的自然不再弹。
    case 'refusal_prompt':
      m.paused = true;
      refusalBand.prompt = { qid: ev.qid, sessionId: ev.sessionId || session.id || '', from: ev.from || '', to: ev.to || '', category: ev.category || null, busy: false };
      break;
    case 'refusal_answer':
      m.paused = false;
      if (refusalBand.prompt && refusalBand.prompt.qid === ev.qid) refusalBand.prompt = null;
      break;
    case 'snap_closed': if (_onSnapClosed) { try { _onSnapClosed(ev.reason || ''); } catch {} } break;
    case 'error':
      m.status = 'error';
      m.error = ev.message || ev.title || tt('出错了');
      settleTurn(m, 'error');
      break;
    case 'interrupted': settleTurn(m, 'stopped'); break;
    // —— 后台任务生命周期：挂在对应工具行（toolUseId）的 task 上；Agent/Task/Workflow/Bash 的
    //    tool 事件先到（content_block_start），task_start 随后。找不到行【不再合成】：主线程的任务
    //    永远先有工具行；对不上的只可能是子 agent 名下的任务（服务端已按 owned_by_subagent 过滤，
    //    这里是第二道闸）——以前合成的 Bash 幽灵行没有 tool_done、永远 running，把分组头钉死在
    //    「Running a command」，正是 09-05 工作流卡「不出面板」那单的元凶之一。 ——
    case 'task_start': {
      const tuid = ev.toolUseId || '';
      const entry = tuid ? toolById.get(tuid) : null;
      if (!entry) break;
      // 工作流名：task_started.workflow_name → tool_args 的 input.name → 脚本头 meta={name}（prompt 是脚本前 300 字）
      const wfName = ev.workflowName || (ev.taskType === 'local_workflow'
        ? (workflowNameFromInput(entry.input) || workflowNameFromInput({ script: ev.prompt || '' }) || '') : '');
      ensureTask(entry, {
        taskId: ev.taskId, taskType: ev.taskType, description: ev.description, subagentType: ev.subagentType,
        workflowName: wfName, name: wfName, prompt: ev.prompt,
        backgrounded: typeof ev.backgrounded === 'boolean' ? ev.backgrounded : null, depth: ev.depth,
        status: 'running', startedAt: ev.at || Date.now(),
      });
      if (ev.taskId) taskById.set(ev.taskId, entry);
      if (tuid) taskById.set(tuid, entry);
      break;
    }
    case 'task_progress': {
      const entry = findTaskEntry(ev);
      if (!entry) break;
      const t = ensureTask(entry, { taskId: ev.taskId, status: 'running' });
      if (ev.usage) t.usage = usageOf(ev.usage);
      if (ev.lastTool) t.lastTool = ev.lastTool;
      if (ev.summary) t.summary = ev.summary;
      // 官方：description 只在还是占位（空/=taskId）时采纳；工作流 progress 的 description 是当前步骤
      if (ev.description) { if (!t.description || t.description === t.taskId) t.description = ev.description; else t.step = ev.description; }
      // workflow_progress 整快照透传：按 `${type}:${index}` 合并、补 startedAt（taskModel.mergeProgress）
      if (Array.isArray(ev.progress)) t.progress = mergeProgress(t.progress, ev.progress, ev.at || Date.now());
      if (!t.startedAt) t.startedAt = ev.at || Date.now();
      break;
    }
    case 'task_update': {
      const entry = findTaskEntry(ev);
      const t = entry && entry.task;
      if (!t) break;
      if (ev.status) t.status = ev.status === 'killed' ? 'stopped' : ev.status;   // pending/paused 原样，UI 当 running
      if (ev.description) t.description = ev.description;
      if (ev.error) t.error = ev.error;
      break;
    }
    case 'task_done': {
      const entry = findTaskEntry(ev);
      if (!entry) break;
      const t = ensureTask(entry, { taskId: ev.taskId });
      const at = ev.at || Date.now();
      t.status = normTaskStatus(ev.status);
      if (ev.summary) t.summary = ev.summary;
      if (ev.usage) t.usage = usageOf(ev.usage);
      if (ev.result) t.result = ev.result;
      if (ev.outputFile) t.outputFile = ev.outputFile;
      if (Array.isArray(ev.progress) && ev.progress.length) t.progress = mergeProgress(t.progress, ev.progress, at);
      if (t.progress.length) t.progress = settleProgress(t.progress, t.status);   // 官方 _t：残留 progress 态的 agent → error
      t.endedAt = at;
      break;
    }
    // 子 agent 转录（parent_tool_use_id 帧）：挂到父 Agent 工具行的 task.entries；task_start
    // 还没到就先立个 running 的 local_agent 记录（父行没找到=深层嵌套，丢弃）。
    case 'agent_msg': {
      const entry = ev.toolUseId ? toolById.get(ev.toolUseId) : null;
      if (!entry) break;
      // 工作流里的 agent 帧分不出是哪个 agent 的（SDK 帧只有 parent_tool_use_id、没有 agent_id），
      // 混着塞进 Workflow 行的 entries 既没人渲染又能堆出几千条——工作流的逐 agent 转录走磁盘 jsonl
      // 轮询（AgentTranscript），这里直接不收。
      if (entry.task && entry.task.taskType === 'local_workflow') break;
      appendAgentEntry(ensureTask(entry, { taskType: 'local_agent', status: 'running', startedAt: ev.at || Date.now() }), ev);
      break;
    }
    // 模型切换 / 安全栅门通知（system/model_*）：时间线卡 + 会话实际模型 + 输入栏横条数据源。
    // model_refusal_no_fallback 不动 m.status——由随后的 error/done 决定结局。
    case 'model_notice': {
      m.segments.push(noticeFromEvent(ev));
      // 「本会话实际模型」的记号只由 session{swapped} 落（服务端只在真换了会话模型时才发它）。这里不能按
      // scope 写：过载回退 model_fallback 帧没有 scope 字段却被填成 session、子 agent 内的 refusal 也是 session，
      // 照写会在会话模型根本没换时标「已切换到 X」，而普通 session 事件又不会把它清掉。
      if (ev.subtype === 'model_refusal_fallback' && ev.scope === 'session' && ev.to && !ev.parentToolUseId) {
        const sid = ev.sessionId || session.id || '';
        // attach 重放同一条通知：保留用户已点 X 的 dismissed，别把横条再弹回来
        const prev = refusalBand.notice;
        const key = ev.requestId || String(ev.at || '');
        const same = !!(prev && (prev.sessionId || '') === sid && (prev.requestId || String(prev.at || '')) === key);
        refusalBand.notice = { ...noticeFromEvent(ev), sessionId: sid, dismissed: same ? !!prev.dismissed : false };
      }
      break;
    }
    case 'retract': retractTurn(m, ev); break;   // 缓冲已在上面 flushText 过，截的是真实全文
    // 上下文压缩：循环组里一条「Compacting… → Compacted session · saved N tokens」，展开看压缩摘要
    case 'compact': applyCompact(m, ev); break;
    // 悬停收轮：主模型停笔但后台任务（子 agent / 工作流 / 后台 shell）还在跑，本轮挂起等它们
    //（服务端不发 done；CLI 会在任务完成时注入 task-notification 自动续轮）。运行状态行据此显示
    // 「等待后台任务…」——与真结束（status done、无状态行）可分；右侧工作台「任务」面板据此
    // 摆挂起横幅 + 逐条详情。count=0 = 任务刚清零、正在等模型续轮（收尾中）。
    case 'bg_hold': {
      const tasks = Array.isArray(ev.tasks) ? ev.tasks : [];
      m.bgHold = { count: typeof ev.count === 'number' ? ev.count : (tasks.length || 1), tasks, deadline: ev.deadline || 0 };
      // 后台 shell 的命令行只有服务端 Stop hook 拿得到——合并进对应工具行的 task 记录，
      // 任务面板展开即可见（工具行自带的 description 常常只是一句话概括）。
      for (const t of tasks) {
        const entry = t && t.taskId ? taskById.get(t.taskId) : null;
        if (!entry || !entry.task) continue;
        if (t.command && !entry.task.command) entry.task.command = t.command;
        if (t.kind && !entry.task.kind) entry.task.kind = t.kind;
      }
      break;
    }
    // 悬停被兜底收尾（封顶/静默/用户点「结束等待」）：挂起提示退场，紧随其后的 done 定局。
    case 'bg_release': m.bgHold = null; break;
    case 'done': {
      if (!hasBody(m) && ev.result) textSeg(m).md += ev.result;
      if (Array.isArray(ev.attachments) && ev.attachments.length) m.attachments = toDeliverAtts(ev.attachments, ev.sessionId || session.id || '');
      settleTurn(m, 'done');
      m.status = 'done';
      break;
    }
  }
  if (ev.type === 'text' || ev.type === 'session' || ev.type === 'done') chat.reconnecting = false;
}

// ---- AskUserQuestion (multi-question, multi-select, custom, skip) -------------
function normOptions(options) {
  return (options || []).map((o) => (typeof o === 'string' ? { label: o, description: '' } : { label: o.label, description: o.description || '' }));
}
// AskUserQuestion → 作为一个 ask 段插进 m.segments（落在「提问前文字」和「回答后文字」之间），
// 答完转成只读「已回答」块常驻历史——不再是问句后 Claude 连贯输出、看不到用户答了什么。
function showQuestion(m, ev) {
  const list = Array.isArray(ev.questions) ? ev.questions : [ev];
  m.segments.push({
    kind: 'ask',
    qid: ev.qid,
    answered: false,
    cancelled: false,
    submitting: false,
    submitError: '',
    items: list.map((q) => ({
      header: q.header || '',
      question: q.question || q.text || '',
      options: normOptions(q.options),
      multi: !!q.multiSelect,
      selected: [],   // option labels
      custom: '',
    })),
  });
  session.pendingQid = ev.qid;
}
function findAsk(m, qid) {
  for (let i = m.segments.length - 1; i >= 0; i--) { const s = m.segments[i]; if (s.kind === 'ask' && s.qid === qid) return s; }
  return null;
}
// 后端「已回答」广播（本机答的 / 别设备答的 / 重连重放都走它）——标记 ask 段已回答 + 回填结构化选择。
function markAnswered(m, ev) {
  const seg = findAsk(m, ev.qid);
  if (!seg || seg.answered) return;
  if (Array.isArray(ev.answers)) {
    ev.answers.forEach((a, i) => {
      if (!seg.items[i] || !a) return;
      if (Array.isArray(a.selected)) seg.items[i].selected = a.selected.slice();
      if (a.custom) seg.items[i].custom = String(a.custom);
    });
  }
  seg.answered = true;
  seg.cancelled = !!ev.cancelled;
  seg.submitting = false;
  seg.submitError = '';
  if (session.pendingQid === ev.qid) session.pendingQid = null;
}
// 用户在本机点提交/跳过：先锁 submitting，POST 后由后端 answer 广播落定（markAnswered）；这里也兜底立即标记。
export async function answerQuestion(seg, { cancelled } = {}) {
  if (!seg || seg.answered || seg.submitting) return;
  seg.submitting = true;
  seg.submitError = '';
  const payload = cancelled
    ? { cancelled: true }
    : { answers: seg.items.map((it) => ({ selected: it.selected, custom: it.custom.trim() || undefined })) };
  try { await api.answer(seg.qid, payload); }
  catch (e) {
    seg.submitting = false;
    const detail = (e?.body && typeof e.body === 'object' ? (e.body.error || e.body.message) : e?.body) || e?.message || '';
    seg.submitError = detail && !/^HTTP \d+$/.test(detail) ? tt('提交失败：{detail}', { detail: tr(detail) }) : tt('提交失败，请重试');
    return;
  }   // POST 失败：保留选择、解锁并就地提示（后端仍在等这个答案）
  seg.answered = true;
  seg.cancelled = !!cancelled;
  seg.submitting = false;
  if (session.pendingQid === seg.qid) session.pendingQid = null;
}

// ---- timer -------------------------------------------------------------------
const IDLE_MS = 20_000;   // 20s 没有任何流事件（心跳不算）→ 星标降成 waiting 慢呼吸
function startTimer() {
  stopTimer();
  timer = setInterval(() => {
    const m = cur();
    if (m && m.role === 'assistant' && m.status === 'streaming') {
      m.elapsed = Date.now() - m.startedAt;
      // 长静默判定：工具执行期的静默是常态（那是 orbiting 的正常形态），不算 idle。
      const idle = m.phase !== 'tool' && Date.now() - lastLiveAt > IDLE_MS;
      if (m.idle !== idle) m.idle = idle;
      tickHint(m, Date.now());
    }
  }, 200);
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

// 一轮的统一收尾（唯一出口）：刷缓冲、停表、置 done、通知、清旗、写缓存。
function finishTurn(m) {
  flushText();
  stopTimer();
  if (m && m.role === 'assistant') { m.bgHold = null; m.paused = false; }
  refusalBand.prompt = null;   // 收轮了还挂着的 Paused 卡（停止 / 超时）已无人在等
  if (m && m.role === 'assistant' && m.status === 'streaming') m.status = 'done';
  if (m && m.role === 'assistant' && !m.__notified) {
    m.__notified = true;
    const errored = m.status === 'error';
    const ft = m.segments && m.segments.find((s) => s.kind === 'text' && s.md.trim());
    agentEnd('Claude', errored ? tt('出错：{error}', { error: tr(m.error || '') }) : (ft ? ft.md : ''), { error: errored, watching: ui.screen === 'claude' && !document.hidden });
  }
  rememberSession(session.id);
  session.busy = false;
  chat.reconnecting = false;
  failingSince = 0;
  if (session.id && !IS_CSNAP) cacheChat(session.id, chat.messages);   // 缓存这轮结束后的会话快照，供离线浏览（快照模式不落访客本地）
}

// 终局化视图（服务端确认没在跑之后调用）：把残留的「流式中」状态收干净。
// 空幽灵轮（attach 建了气泡但一个事件都没到）整个撤掉——绝不留「0 tokens 已完成」怪胎；
// 发送可能没落地的（__sendLost）给出明确可重试的错误而不是假 done。
function settleView(sid) {
  if (sid && session.id !== sid) return;
  const m = cur();
  if (m && m.role === 'assistant' && m.status === 'streaming' && !hasContent(m) && !m.thinking) {
    if (m.__sendLost) {
      m.status = 'error';
      m.error = tt('发送失败，请重试');
    } else {
      chat.messages.pop();
      revokeMessageBlobUrls([m]);
      finishTurn(null);
      return;
    }
  }
  finishTurn(m);
}

function errText(e) {
  if (e && e.status === 401) return tt('需要登录');
  const msg = (e && e.message) || String(e || '');
  if (/reconnect|network|fetch/i.test(msg)) return tt('连接中断，请重试');
  return msg || tt('出错了');
}

// ---- 直播流（唯一一条）---------------------------------------------------------
// 事件应用：晚到的旧流事件靠 live === my 一票否决——内核换流后旧流彻底失声。
function applyLiveEvent(my, ev) {
  if (live !== my || !ev) return;
  if ((ev.type === 'session' || ev.type === 'attach' || ev.type === 'start') && ev.sessionId) my.sessionId = ev.sessionId;
  let m = cur();
  if (!m || m.role !== 'assistant' || m.status !== 'streaming') {
    // 轮已定局后的尾巴事件（ctx_usage 等，见 STATUS_ONLY）：只改 status，绝不为它们再开一条气泡。
    if (STATUS_ONLY.has(ev.type)) { lastLiveAt = Date.now(); applyStatusEvent(ev); return; }
    // attach 整轮重放的开头：历史尾部若已带着这一轮（缓存快照/落盘竞态），先剪掉再由重放原样补回=净去重。
    if (ev.type === 'attach') {
      trimTurnTail(ev.userText);
      if (ev.userText) chat.messages.push({ role: 'user', text: ev.userText });
    }
    m = newAssistant();
    session.busy = true;
    startTimer();
    agentStart('Claude');
    ui.view = 'chat';
  }
  onEvent(m, ev);
  if (isTerminal(ev)) {
    my.terminal = true;
    if (my.sessionId && !session.id) { session.id = my.sessionId; }
    finishTurn(m);
  }
}

// 起搏一条已打开的 SSE 响应：看门狗判半开（sse.js 全局巡检）就掐这条连接；
// 散场时若没见过终止事件 → 结局未知，唯一的出路是 requestSync（绝不静默收工）。
function startPump(sid, res, ctrl) {
  killLive();
  const my = { sessionId: sid || null, ctrl, terminal: false, wdKilled: false };
  live = my;
  lastLiveAt = Date.now();
  chat.reconnecting = false;
  const m0 = cur();   // 发送后 SSE 接通 = 服务端已接单、在拉起 CLI（官方「Sending…」→「Starting session…」）
  if (m0 && m0.role === 'assistant' && m0.status === 'streaming' && m0.wait === 'sending') m0.wait = 'starting';
  failingSince = 0;
  behindRuns = 0;
  const w = watch(() => { my.wdKilled = true; if (res.__attemptAbort) res.__attemptAbort(); else { try { ctrl.abort(); } catch {} } });
  w.touch();
  (async () => {
    try { await pump(res, (ev) => applyLiveEvent(my, ev), ctrl.signal, w.touch); } catch { /* 网络断流 */ }
    w.release();
    flushText();
    if (live === my) live = null;
    if (my.terminal) return;                              // 正常终局：finishTurn 已在事件里做完
    if (ctrl.signal.aborted && !my.wdKilled) return;      // 内核主动换流/停止：新去向已定
    // 没见终止事件就散场（半开被看门狗掐掉 / 网络断 / 服务端收流）→ 收敛。
    if (!my.sessionId || my.sessionId === session.id) {
      if (unsettled()) chat.reconnecting = true;
      requestSync('stream-lost');
    }
  })();
}

async function openAttachFetch(sid, parentCtrl) {
  const attempt = linkAbort(parentCtrl.signal);
  const res = await fetch(apiUrl('/api/attach' + (sid ? '?session=' + encodeURIComponent(sid) : '')), {
    method: 'POST', headers: authHeaders(), credentials: 'same-origin', signal: attempt.signal,
  });
  if (res.status === 204) return null;
  if (!res.ok || !res.body) throw Object.assign(new Error('attach HTTP ' + res.status), { status: res.status });
  try { res.__attemptAbort = () => attempt.abort(); } catch { /* 只读 Response：退化成不可单掐 */ }
  return res;
}

// attach 一个会话（在跑的轮=挂直播；完成的轮=整轮重放到 done 后服务端自动收流）。
// 返回 'attached' | 'empty'(204) | 'unreachable' | 'auth' | 'stale'。
async function tryAttach(sid) {
  const ep = kernelEpoch;
  const ctrl = new AbortController();
  let res;
  try { res = await openAttachFetch(sid, ctrl); }
  catch (e) {
    if (ep !== kernelEpoch) return 'stale';
    if (e && (e.status === 401 || e.status === 403)) return 'auth';
    return 'unreachable';
  }
  if (ep !== kernelEpoch) { try { ctrl.abort(); } catch {} return 'stale'; }
  if (!res) return 'empty';
  startPump(sid, res, ctrl);
  return 'attached';
}

// 挂上一个正在跑（或刚跑完）的轮：视图里还没有这个会话的历史就先补（按 startedAt 过滤
// 当前轮，随后 attach 整轮重放补齐），再 attach。
async function openRun(run) {
  const ep = kernelEpoch;
  const sid = run && run.sessionId;
  if (!sid) return;
  killLive();
  if (session.id !== sid || !chat.messages.length) {
    try { await loadSession(sid, { before: run.startedAt || 0 }); } catch {}
    if (ep !== kernelEpoch) return;
    if (session.id !== sid) { session.id = sid; rememberSession(sid); ui.view = 'chat'; }   // 历史加载失败也要把视图归属定下来
  }
  const r = await tryAttach(sid);
  if (r === 'empty') requestSync('attach-race', 900);           // 探活与 attach 之间刚好收尾 → 再收敛一次
  else if (r === 'unreachable') { if (unsettled()) chat.reconnecting = true; noteFailing(); }
  else if (r === 'auth') {
    const m = cur();
    if (m && m.role === 'assistant' && m.status === 'streaming') { m.status = 'error'; m.error = tt('需要登录'); }
    settleView(sid);
  }
}

// ---- transcript 侧（真相兜底）---------------------------------------------------
// 每个会话最近一次 /api/session 响应的指纹。带回服务端做对账短路：内容没变就只回
// 几十字节，不重传整份 transcript。
//
// 为什么要有：freshen 的触发源是 session.touch 总线事件，而 CLI / 桌面 Claude Code
// 在跑的时候那个 jsonl 一直在长——实测手机端大约每 8 秒重拉一次整份记录（长会话
// 几百 KB），而绝大多数时候拉回来的内容跟手里的一模一样。harness 那边早就用
// recordFp 短路了（319KB→53B），Claude 分页一直没有。
//
// 只在【手里就是服务端那份完整记录】时才记指纹：裁过的视图（loadSession 带 before）
// 和还没追上的记录（reconcile 判 'behind'）都不记，否则短路会把缺的部分永远挡在外面。
const _fp = new Map();
const noteFp = (sid, data) => { if (sid && data && data.fp) _fp.set(sid, data.fp); };

// 终局对账：attach 204（缓冲没了：服务端重启/被挤出/CLI 轮）时读 transcript 定局。
// minLen 防落盘慢半拍把本轮删没——宁可 'behind' 退避重试。
async function reconcileFromTranscript(sid) {
  const ep = kernelEpoch;
  const minLen = chat.messages.length;
  try {
    const data = await api.session(sid);
    if (ep !== kernelEpoch || sid !== session.id) return 'stale';
    const msgs = toUiMessages(data.messages || [], sid);
    if (msgs.length < minLen) return 'behind';   // 落盘慢半拍：这份还不完整，别记指纹
    mergeMessages(msgs);
    if (!IS_CSNAP) cacheMessages(sid, msgs);
    noteFp(sid, data);
    return 'ok';
  } catch { return 'behind'; }
}

// 新鲜度合并（视图已收敛时）：别处/CLI 写进 transcript 的内容原地补上。
// 原地 merge 而不是整表替换：保住 chat.messages 的数组引用（ClaudePage 的滚动 effect
// 拿数组引用变化当「切了会话」的信号，整表替换会把视口踹到底并整屏重建 DOM）。
let _freshening = false;
async function freshen(sid) {
  if (_freshening || !sid || sid !== session.id || session.busy || live || ui.offline) return;
  _freshening = true;
  const gen = loadGen;
  try {
    const data = await api.session(sid, _fp.get(sid));
    if (gen !== loadGen || sid !== session.id || session.busy || live) return;
    noteFp(sid, data);
    if (data.unchanged) return;   // 服务端定论：这一份跟你手里的一模一样
    const msgs = toUiMessages(data.messages || [], sid);
    if (!mergeMessages(msgs)) return;
    if (!IS_CSNAP) cacheMessages(sid, msgs);
  } catch { /* 网络抖动：下个触发源会再来 */ }
  finally { _freshening = false; }
}

// ---- syncOnce：唯一的收敛路径 ----------------------------------------------------
let _syncing = false, _syncAgain = false;
let _syncTimer = null, _syncAt = 0;

// 所有唤醒源（总线事件 / 回前台 / 断流 / 看门狗 / 页面兜底轮询）的唯一入口。合并去抖：
// 已排了更早的一次就不重排。幂等——多叫无害。
export function requestSync(reason, delayMs = 0) {
  if (typeof window === 'undefined') return;
  const at = Date.now() + delayMs;
  if (_syncTimer && at >= _syncAt) return;
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncAt = at;
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    syncOnce();
  }, Math.max(0, delayMs));
}

async function syncOnce() {
  if (_syncing) { _syncAgain = true; return; }
  _syncing = true;
  try { await doSync(); }
  catch (e) {
    // 收敛路径绝不允许静默死亡：报出去 + 兜底再约一次（唤醒源不在场时它就是唯一的续命）。
    try { console.error('[chat-sync]', e); } catch {}
    requestSync('error-retry', 4000);
  }
  finally {
    _syncing = false;
    if (_syncAgain) { _syncAgain = false; requestSync('again'); }
  }
}

// 「未收敛且连不上」的醒时限：反复失败 2 分钟（醒着的时间）就给出明确错误收场——
// 服务端的轮不受影响，网络恢复后 wake→sync 会自动补全/重挂。
function noteFailing() {
  if (!failingSince) failingSince = Date.now();
  if (unsettled() && Date.now() - failingSince > 120_000) {
    const m = cur();
    if (m && m.role === 'assistant' && m.status === 'streaming') {
      m.status = 'error';
      m.error = tt('连接超时；任务可能仍在后台运行，网络恢复后会自动补全');
    }
    settleView(session.id);
    return;
  }
  requestSync('retry', 4000);
}

async function probeActive() {
  return await Promise.race([
    api.active(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 10_000)),
  ]);
}

// detachLive 记住被主动切走的直播会话：① 不把用户拽回去；② 点回时重新 attach 续看。
const mutedLive = new Set();
// 服务器可达时 transcript 连续落后的计数（区分「落盘慢半拍」与「记录永远不会来」）。
let behindRuns = 0;

async function doSync() {
  if (typeof window === 'undefined' || pendingSend) return;
  // 离线闸【不许熄火】：可达性状态机（server.js）自己带退避重探、恢复时翻回 ui.offline，
  // 但它的回调槽归 App 维护 ui.offline 用，不会叫醒我们。视图未收敛时就自持一个 4s 的
  // 轻心跳（只看旗子，不发网络请求），旗子一翻回下个心跳即完成收敛——否则「重连中」
  // 会在服务器恢复后仍然卡死（实测踩过）。
  if (ui.offline) {
    if (unsettled()) { chat.reconnecting = true; requestSync('offline-wait', 4000); }
    return;
  }
  const ep = kernelEpoch;
  const sid = session.id;
  let a;
  try { a = await probeActive(); }
  catch {
    if (ep !== kernelEpoch) return;
    // 服务器探不到 + 直播流长时间静默 = 半开死流（看门狗被后台节流拦住时的内核兜底）：
    // 掐掉它，让「重连中」诚实亮起，恢复后由收敛路径重挂/补全。健康流（刚有过字节）不动。
    if (live && Date.now() - lastLiveAt > 45_000) killLive();
    if (unsettled() && !live) { chat.reconnecting = true; noteFailing(); }
    return;
  }
  if (ep !== kernelEpoch) return;
  const runs = runsOf(a).filter((r) => r.sessionId);
  for (const id of [...mutedLive]) if (!runs.some((r) => r.sessionId === id)) mutedLive.delete(id);   // 已结束 → 解除静音
  // 空态（greeting）：自动挂上最新的一轮（别处发起的直播镜像）。
  if (!sid) {
    if (session.busy || live) return;   // 新会话首轮正在发
    const cand = runs.filter((r) => !mutedLive.has(r.sessionId));
    if (cand.length) await openRun(cand[cand.length - 1]);
    return;
  }
  const run = runs.find((r) => r.sessionId === sid);
  // sessionId 为 null 的直播流=新会话首轮（id 尚未回来），等价于「正写着当前视图」。
  const liveMine = live && (live.sessionId === sid || live.sessionId == null);
  if (run && !mutedLive.has(sid)) {
    if (liveMine) {
      // 直播还挂着：45s 内有过任何字节（心跳 15s 一个）就是健康的，别动它。
      if (Date.now() - lastLiveAt <= 45_000) { chat.reconnecting = false; failingSince = 0; return; }
      killLive();   // 静默过久=半开死流（看门狗漏网时的内核兜底）
    } else if (live) {
      killLive();   // 单流不变量的保险丝：直播挂在别的会话上不该发生
    }
    await openRun(run);
    return;
  }
  // 服务端明确：这个会话现在没有在跑的轮。
  if (liveMine) {
    // 直播还开着：正常收尾时 done 几百 ms 内就到——宽限一下，别误杀正在重放结尾的流。
    if (Date.now() - lastLiveAt < 2500) { requestSync('grace', 1500); return; }
    killLive();
  }
  if (unsettled()) {
    // 首选：整轮重放完成轮（服务端长保留，含最终 done/附件——保真度最高、无落盘竞态）。
    const r = await tryAttach(sid);
    if (r === 'attached' || r === 'stale') return;
    if (r === 'auth') {
      const m = cur();
      if (m && m.role === 'assistant' && m.status === 'streaming') { m.status = 'error'; m.error = tt('需要登录'); }
      settleView(sid);
      return;
    }
    if (r === 'unreachable') { chat.reconnecting = true; noteFailing(); return; }
    // 'empty'：缓冲真没了 → transcript 是唯一真相。
    const t = await reconcileFromTranscript(sid);
    if (t === 'stale') return;
    if (t === 'behind') {
      // 落盘慢半拍：正常 1-2s 内追上。服务器可达却连续多次都追不上（如服务端中途
      // 硬崩、这轮的 assistant 记录永远不会出现）→ 以本地已流到的内容终局，
      // 不再空等——内容本来就来自服务端流，transcript 之后追上会由 freshen 自愈。
      if (++behindRuns >= 4) { behindRuns = 0; settleView(sid); return; }
      requestSync('transcript-behind', 1200);
      return;
    }
    behindRuns = 0;
    settleView(sid);
    return;
  }
  await freshen(sid);
}

// DEV 专用：集成验收把合成事件灌进内核（impl-contract §7.3）。没有流式轮时先开一条
// assistant 气泡，终止事件照常走 finishTurn；{type:'user',text} 先摆一条用户气泡。
function feedSynthetic(ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'user') { chat.messages.push({ role: 'user', text: ev.text || '', ...(ev.uuid ? { uuid: ev.uuid } : {}) }); return; }
  let m = cur();
  if (!m || m.role !== 'assistant' || m.status !== 'streaming') {
    if (STATUS_ONLY.has(ev.type)) { applyStatusEvent(ev); return; }   // 与 applyLiveEvent 同规矩
    m = newAssistant();
    session.busy = true;
    startTimer();
    ui.view = 'chat';
  }
  onEvent(m, ev);
  if (isTerminal(ev)) finishTurn(m);
}

// 内核诊断口（现场排障用；只读快照 + 手动触发收敛）。
if (typeof window !== 'undefined') {
  window.__chatKernel = {
    sync: (reason) => requestSync(reason || 'manual'),
    bus: (ev) => onBusEvent(ev),
    // 生产构建剔除：feed 灌合成事件 / snapshot 取纯 JSON 供断言
    ...(import.meta.env.DEV ? { feed: (ev) => feedSynthetic(ev), snapshot: () => JSON.parse(JSON.stringify(chat.messages)) } : {}),
    state: () => ({
      live: live ? { sessionId: live.sessionId, terminal: live.terminal } : null,
      lastLiveAgo: lastLiveAt ? Date.now() - lastLiveAt : null,
      epoch: kernelEpoch, pendingSend, failingSince, behindRuns,
      syncing: _syncing, timerSet: !!_syncTimer,
      busy: session.busy, reconnecting: chat.reconnecting,
      sessionId: session.id, msgs: chat.messages.length,
      lastStatus: (chat.messages[chat.messages.length - 1] || {}).status || null,
    }),
  };
}

// 回前台/联网/解冻：网络栈稍等 250ms 再收敛（也给看门狗的 wake 巡检让个身位）；
// 醒时限的表随 wake 拨回——冻结/断网那段不计入放弃倒计时。
if (typeof window !== 'undefined') {
  const wake = () => {
    if (document.hidden) return;
    if (failingSince) failingSince = Date.now();
    requestSync('wake', 250);
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);    // 安卓 WebView 从冻结态回来只发这个
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
}

// ---- 运行时切换会话 / 多对话并发 ------------------------------------------------
// detachLive：只断【本地】直播连接——服务端该轮继续跑（abort 不触发服务端中止；那要
// /api/stop 或同会话重发才会）。切走后可以直接在别的会话发消息，后台轮各跑各的。
export function detachLive() {
  const liveId = (live && live.sessionId) || session.id;
  if (!live && !session.busy && !unsettled()) return;
  dropText();                          // 缓冲丢弃——本条消息马上随会话切换整体替换
  stopTimer();
  bumpEpoch();                         // 一切在途 sync 的应用全部作废
  killLive();
  pendingSend = false;
  const m = cur();
  if (m && m.role === 'assistant' && m.status === 'streaming') m.status = 'done';  // 不留永久转圈
  if (liveId) mutedLive.add(liveId);
  session.busy = false;
  chat.reconnecting = false;
  failingSince = 0;
}

// 抽屉点会话的统一入口：直播中也能切换。看的就是直播会话 → 不动；否则先 detach 再加载；
// 点回一个正在跑的会话（被静音的直播 / 并行后台轮）→ requestSync 重新挂直播续看。
export async function openSession(id) {
  ui.customizeOpen = false;   // 「自定义」页占着正文列：打开任何会话都先让回对话
  if (session.busy || live || pendingSend) {
    const liveId = (live && live.sessionId) || session.id;
    if (id === liveId) { ui.view = 'chat'; return; }
    detachLive();
  }
  mutedLive.delete(id);                // 显式点开 = 解除静音
  await loadSession(id);
  requestSync('open');                 // 正好有轮在跑 → 内核补挂直播续看
}

// ---- public API --------------------------------------------------------------
// attachments 缺省 = 消费 composer 暂存（正常发送）；显式传数组（如重试传 []）
// 则不读不清 compose——否则点旧消息「重试」会偷走输入框里还没发出去的附件。
export function send(text, attachments) {
  const t = (text || '').trim();
  const atts = attachments !== undefined ? attachments.slice() : compose.attachments.slice();
  // 挂起中（模型已停笔、只在等后台任务）照样能发：服务端把这条接力送进同一个 CLI（gen.handoff），
  // 后台任务照跑、完成时照常汇报——不用先按停止（那会连后台任务一起杀掉）。
  const handoff = !!bgHoldNow();
  if ((!t && !atts.length) || (session.busy && !handoff)) return;
  if (ui.view !== 'chat') ui.view = 'chat';
  // 离线（连不上 PC）只读：立即给出明确失败，不发请求、不进重连退避。
  // 附件跟着这条消息一起显示——否则气泡里没有、输入框里还挂着，用户以为丢了。
  if (ui.offline) {
    chat.messages.push({ role: 'user', text: t, attachments: sentAttachments(atts) });
    const me = newAssistant();
    me.status = 'error';
    me.error = tt('离线：连不上服务器，无法发送（恢复网络后会自动重连，届时重试即可）');
    if (attachments === undefined) compose.attachments = [];   // 与正常发送一致：消费掉 composer 暂存
    return;
  }
  if (attachments === undefined) compose.attachments = [];   // 只有消费了 composer 暂存才清
  // 多对话并发：后端不再把新 POST 当「顶掉一切」，后台轮各跑各的——直接发。
  // 超出并发上限时后端回一个 error 事件，正常渲染成气泡。
  reallySend(t, atts, handoff);
}

// 挂起接力：上一轮就地收成「已完成」——服务端同时以它暂存的 result 正常定局（done 进它的缓冲）。
// 不走 settleTurn / finishTurn：它的后台任务还在跑（下一轮的流里继续报进度），不能标成 stopped，
// 也不是一轮真正结束（不发完成通知）。
function settleHeldForHandoff() {
  const m = cur();
  flushText();
  stopTimer();
  if (m && m.role === 'assistant') {
    m.bgHold = null;
    if (m.status === 'streaming') m.status = 'done';
  }
  session.busy = false;
}

function reallySend(t, atts, handoff = false) {
  bumpLoadGen();   // 作废在途的历史刷新——慢返回不覆盖即将开始的流式轮
  bumpEpoch();     // 作废在途 sync 的应用
  if (handoff) settleHeldForHandoff();
  killLive();
  chat.messages.push({ role: 'user', text: t, attachments: sentAttachments(atts) });
  refusalBand.notice = null;   // 新回合开始：上一轮的「已切换到 X」横条收起（官方同款）
  if (!handoff) refusalBand.prompt = null;   // 接力进同一 CLI 时那张 Paused 卡仍在等人
  session.busy = true;
  lastLiveAt = Date.now();   // 刚发出去、还一个事件都没回：这段时间不许被判成陈旧流
  const m = newAssistant();
  startTimer();
  agentStart('Claude');

  notePrefsNow(session.id);   // 发送即记忆：本会话（新会话先记 last，id 回来再补绑）+ 新对话默认
  const params = { message: t, agent: 'claude' };
  if (session.id) params.sessionId = session.id;
  // 项目制：新会话带上项目（=cwd）；续聊服务端按 transcript 所在目录反查，此值被忽略。
  if (!session.id && session.projectId) params.claudeProjectId = session.projectId;
  // worktree 勾选框：只对新会话、且服务端说这里能开 worktree 会话（wtNew：git 主检出）时生效——芯片上
  // 勾选框也只在这时出现；dock.meta 此刻就是新对话落点的那份。项目本身已是 linked worktree 就不再套一层。
  if (!session.id && prefs.worktree && !IS_CSNAP && dock.meta?.wtNew) params.worktree = true;
  if (settings.model) params.model = settings.model;
  // 快照访客没有 Ultracode（服务端静默降到 xhigh 且不发 effort 实况）：请求就按 xhigh 发，芯片不说谎
  if (settings.effort) params.effort = (IS_CSNAP && settings.effort === 'ultracode') ? 'xhigh' : settings.effort;
  if (settings.fast) params.fast = true;
  if (settings.style && settings.style !== 'normal') {
    params.style = settings.style;
    const cs = getStyle(settings.style);          // 自定义风格：附上指令文本（预设则后端按 id 注入）
    if (cs && cs.text) params.styleText = cs.text;
  }
  if (settings.research) params.research = true;
  // 输入建议：开关开着才让服务端生成（定局后 CLI 预测下一句）。这一轮开跑，上一条建议随之作废。
  if (prefs.promptSuggest && !IS_CSNAP) params.suggest = true;
  if (session.id) delete status.suggestions[session.id];
  if (atts.length) params.attachments = atts.map((a) => a.path).filter(Boolean);

  openChatStream(params, m);
}

// POST /api/chat 并起搏响应流。没有内置重连循环：流散场没见终止事件 → requestSync，
// 由唯一的收敛路径接手（attach 整轮重放续上；POST 根本没落地则收敛成明确的发送失败）。
async function openChatStream(params, m) {
  const ep = kernelEpoch;
  pendingSend = true;
  const ctrl = new AbortController();
  const attempt = linkAbort(ctrl.signal);
  let res;
  try {
    res = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(params),
      credentials: 'same-origin',
      signal: attempt.signal,
    });
  } catch {
    pendingSend = false;
    if (ep !== kernelEpoch) return;
    m.__sendLost = true;                 // POST 可能落地也可能没有——由收敛路径判定
    chat.reconnecting = true;
    requestSync('send-lost', 600);
    return;
  }
  pendingSend = false;
  if (ep !== kernelEpoch) { try { ctrl.abort(); } catch {} return; }
  if (!res.ok || !res.body) {
    // 明确鉴权失败：重连永远不会成功，直接报错让用户重新登录，绝不进收敛循环。
    if (res.status === 401 || res.status === 403) {
      m.status = 'error'; m.error = tt('需要登录');
      finishTurn(m);
      return;
    }
    m.__sendLost = true;
    chat.reconnecting = true;
    requestSync('send-lost', 600);
    return;
  }
  try { res.__attemptAbort = () => attempt.abort(); } catch {}
  startPump(session.id || null, res, ctrl);
}

// —— 检查点回滚：恢复到某条用户消息发出之前 ——
// mode 'both'=文件+对话（默认）| 'files'=仅文件 | 'chat'=仅对话锚点、不回滚文件（安全栅门
// 横条「Edit prompt and retry」用：把被拒的那条用户消息撤回输入框重发）。
// 服务端 /api/claude/rewind 目前只区分 'files'，其余一律按 'both' 处理（会顺带尝试文件回滚，
// 无检查点时软失败、只回滚对话）——'chat' 先原样透传，服务端补上分支后即是纯对话回滚。
// 成功且含对话时：本地立即截断视图（目标消息及其后全部移除，正文放回可编辑语境由调用方
// 决定），服务端 pending 锚点保证重开/别设备看到同样的截断，下一轮发送时才真正在
// transcript 里分叉。
export async function rewindToMessage(msg, mode) {
  if (session.busy || !session.id || !msg || !msg.uuid) throw new Error(tt('当前无法回滚'));
  const r = await api.claudeRewind(session.id, msg.uuid, mode === 'files' || mode === 'chat' ? mode : 'both');
  if (r && r.conv) {
    // 原地 splice（不整组替换）：保留消息与被删消息共享附件对象，整组替换会误吊销
    // 留存气泡的 blob 缩略图；只对移除段做 blob 清理。
    const i = chat.messages.indexOf(msg);
    if (i >= 0) revokeMessageBlobUrls(chat.messages.splice(i));
    if (session.id && !IS_CSNAP) cacheChat(session.id, chat.messages);
    refusalBand.notice = null;   // 回滚到被拒消息之前 = 横条使命完成（官方 resolveRefusalFallback）
  }
  return r;
}

// —— 后台挂起（bg_hold）的公共读写口：状态行（Thread）与工作台「任务」面板共用同一处真相 ——
// 正在跑的那一轮若挂起等后台任务则返回 {count,tasks,deadline}，否则 null。
export function bgHoldNow() {
  const m = chat.messages[chat.messages.length - 1];
  return m && m.role === 'assistant' && m.status === 'streaming' && m.bgHold ? m.bgHold : null;
}
// 「结束等待」：服务端以暂存的 result【正常定局】（不是硬停留下的「已中断」），
// 后台任务随 CLI 收尾一起结束——这是用户明确要求的语义。后续 bg_release + done 走正常收尾路径。
export function releaseBgHold() {
  const liveId = (live && live.sessionId) || session.id || null;
  try { api.stop(liveId || undefined, { release: true }); } catch {}
}

export function stop() {
  // 点名停「正看的这一轮」——并行的后台轮不受影响。新会话 id 还没回来时退回旧行为（停最新一轮）。
  const liveId = (live && live.sessionId) || session.id || null;
  // 还有后台任务在跑时服务端只打断这一轮作答（held:true，官方 Esc 同款）：进程还在、这一轮转入
  // 挂起等后台任务——重新挂上直播，挂起态（等待后台任务…/任务芯片）才看得见。
  try {
    Promise.resolve(api.stop(liveId || undefined))
      .then((r) => { if (r && r.held) requestSync('soft-stop', 800); })
      .catch(() => {});
  } catch {}
  if (liveId) session.id = liveId;   // killLive 前保住刚拿到但尚未落 state 的新会话 id
  bumpEpoch();
  killLive();
  pendingSend = false;
  const m = cur();
  if (m && m.role === 'assistant' && m.status === 'streaming') m.status = 'done';
  finishTurn(m);
}

export function newConversation(projectId) {
  ui.customizeOpen = false;
  if (session.busy || live || pendingSend || unsettled()) detachLive();   // 直播中也能开新聊天：后台轮继续跑，完成照常提醒
  bumpLoadGen();                    // 作废在途的历史刷新——慢返回不把空白新聊天顶回旧会话
  replaceMessages([]);
  session.id = null;
  session.pendingQid = null;
  session.projectId = projectId || null;  // 项目上下文：首轮拿到会话 id 时上报归属
  rememberSession(null);
  applyPrefs(lastPrefs());          // 新对话选择器 = 最近一次的选择（而不是沿用刚看的会话的）
  ui.view = 'greeting';
}

// 历史附件（sessions.mjs 抽出的 {file,name} 或 {rel,name}）→ 前端消息附件 {name,kind,url}。
// 图片取图：uploads 里的（{file}）走 /api/upload/raw；工作空间直发的（{rel}，「发送给 AI」零拷贝）
// 走 /api/file。<img> 跨源带不了 Authorization，附 ?token=；见 auth.mjs 白名单。
// 非图片只留名字（当文件卡显示，不预览）。
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'svg'];
function uploadRawUrl(file, thumb) {
  const t = getToken();
  return apiUrl('/api/upload/raw?name=' + encodeURIComponent(file)
    + (thumb ? '&thumb=' + thumb : '') + (t ? '&token=' + encodeURIComponent(t) : ''));
}
function wsFileUrl(rel, thumb) {
  const t = getToken();
  return apiUrl('/api/file?path=' + encodeURIComponent(rel)
    + (thumb ? '&thumb=' + thumb : '') + (t ? '&token=' + encodeURIComponent(t) : ''));
}
// 每张图给两条 URL：
//   thumb —— 气泡里内联显示用（1280px webp，服务端 thumb-cache 缓存）
//   url   —— 原图，只在灯箱放大 / 下载时才拉
// 此前气泡直接挂原图：uploads 里躺着 15.8MB 的截图、7MB 的手机照，翻旧会话时手机要把
// 它们全下下来并解码成位图（4000px 的图 ≈ 30MB+ RGBA），几张就够把 WebView 挤到被系统
// 回收重载。服务端缩略图不可用时会自动回落原图，故这里无条件带 thumb= 即可。
function toUiAttachments(list) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.map((a) => {
    const name = a.name || a.file || tt('文件');
    if (a.kind === 'chat') return { name, kind: 'chat', url: null, quoteId: a.quoteId || null };   // 引用对话（sessions.mjs 按存盘名认出）
    const isImg = IMG_EXT.includes((name.split('.').pop() || '').toLowerCase());
    if (!isImg) return { name, kind: 'file', url: null };
    const src = a.rel ? wsFileUrl : (a.file ? uploadRawUrl : null);
    const key = a.rel || a.file;
    return {
      name,
      kind: 'image',
      url: src ? src(key) : null,
      thumb: src ? src(key, 'preview') : null,
    };
  });
}

// 历史段归一：tools 条目补齐直播同款字段（id/input/status/ms/task——旧服务端只给 name/summary），
// notice 段走同一构造器（at 缺省 0 求稳定，指纹不看它）；其余段原样。
function normSeg(s) {
  if (!s || typeof s !== 'object') return s;
  if (s.kind === 'tools') return { kind: 'tools', open: !!s.open, tools: (Array.isArray(s.tools) ? s.tools : []).map((t) => {
    const tool = makeTool({ ...t, status: t.status || 'done' });
    // 历史里仍标 running 的后台任务 = 已经死了：bridge 一轮 = 一次 query，进程收尾时后台任务
    // 跟着结束；transcript 里没有完成记录只说明「那一轮没等到它」。不收干净的话刷新之后
    // 「任务」面板会永远挂着一条假的 Running（真在跑的那一轮由 /api/attach 重放重建，不走这里）。
    if (tool.task && taskRunning(tool.task.status)) {
      tool.task.status = 'stopped';
      if (!tool.task.summary) tool.task.summary = tt('进程结束时中止');
    }
    return tool;
  }) };
  if (s.kind === 'notice') return { ...noticeFromEvent(s), at: s.at || 0 };
  return s;
}

function toUiMessages(raw, sid) {
  return (raw || []).map((msg) => {
    if (msg.role === 'user') return { role: 'user', text: msg.text, attachments: toUiAttachments(msg.attachments), ...(msg.uuid ? { uuid: msg.uuid } : {}) };
    // assistant：后端现在直接给结构化 segments（text/tools/notice/ask，与直播同构）；旧后端/纯文本兜底成单 text 段。
    // startedAt 兜底用 0 而非 Date.now()：历史消息（status done）不显示计时，而稳定值让
    // 「缓存快照 vs 网络刷新」逐字节可比——内容没变就跳过整树替换。
    const segments = (Array.isArray(msg.segments) && msg.segments.length ? msg.segments : [{ kind: 'text', md: msg.text || '' }]).map(normSeg);
    // 服务端重建时能标出「这一轮是错误」（如 CLI 认证失败的合成回答）→ 与直播 error 事件落成同一张错误卡
    const failed = msg.status === 'error';
    const out = { role: 'assistant', segments, thinking: '', thinkingOpen: false, status: failed ? 'error' : 'done', error: failed ? (msg.error || tt('出错了')) : null, tokens: 0, thinkingTokens: 0, startedAt: msg.ts || 0, elapsed: 0, question: null };
    // 助手产物附件（服务端从 transcript 重提取）→ 与直播 done 同款卡片
    const atts = toDeliverAtts(msg.attachments, sid);
    if (atts.length) out.attachments = atts;
    return out;
  });
}

// 「切走/新聊天/发送」都推进这个代数，作废还在天上飞的 loadSession 网络刷新——
// 慢返回不再覆盖用户已经切到的新内容。
let loadGen = 0;
export function bumpLoadGen() { loadGen++; }
const sameSnapshot = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };

// opts.before：只加载该服务端时间戳之前的消息——恢复"直播中的会话"时用，
// 过滤掉当前轮已落 transcript 的半截消息（随后 /api/attach 会完整重放这一轮，不滤会重复）。
// 常规打开（无 before）缓存优先：本地有快照先渲染（点开即进，不等隧道往返 ~1s），
// 网络返回后内容有变化才替换（stale-while-revalidate）。
export async function loadSession(id, opts) {
  if (session.busy) return;
  const before = opts && opts.before;
  const gen = ++loadGen;
  // 选择器恢复：先按本地镜像立即回到该会话上次的选择（点开秒生效，不等隧道）；
  // 网络返回后若服务端 sidecar 更新（别的设备聊过）再覆盖一次。before = 恢复直播
  // 中的同一会话，不动选择器。
  if (!before) applyPrefs(prefsFor(id));
  let shown = false;
  if (!before) {
    const cached = await getCachedMessages(id);
    if (cached && cached.length && gen === loadGen && !session.busy) {
      replaceMessages(cached);
      session.id = id;
      rememberSession(id);
      ui.view = 'chat';
      shown = true;
    }
  }
  let msgs = null;
  let projId = null;
  try {
    const data = await api.session(id);
    projId = data.projectId || null;   // 会话归属（=工作空间/项目）：服务端按 transcript 所在目录判的真值
    if (data.wt && data.wt.cwd) sessionWt[id] = data.wt;
    let raw = data.messages || [];
    if (before) raw = raw.filter((x) => !x.ts || x.ts < before);
    else noteFp(id, data);   // 只在未过滤时记：裁过的视图 ≠ 服务端那份，不能拿来短路
    msgs = toUiMessages(raw, id);
    if (!before && !IS_CSNAP) cacheMessages(id, msgs);    // 在线成功 → 写本地缓存（离线可读；截断态不缓存；快照模式不落）
    if (!before && !IS_CSNAP && data.prefs) {
      absorbServerPrefs(id, data.prefs);                  // 服务端 sidecar（可能来自别的设备）并入本地
      if (gen === loadGen && !session.busy) applyPrefs(prefsFor(id));
    }
  } catch {
    if (shown) return;                       // 缓存已渲染，网络失败就先看缓存（离线只读）
    msgs = await getCachedMessages(id);      // 连不上 PC → 读本地缓存（离线浏览）
    if (!msgs) return;
  }
  if (gen !== loadGen || session.busy) return;   // 期间已切走/开始发送 → 这次刷新作废
  // 归属跟着会话一起落定。抽屉点会话走的是 pickSession（它自己带 projectId），但
  // 【冷启动恢复】(restoreOnBoot) 与【挂直播续看】(openRun) 都直接进这里，只给得出
  // session.id——归属留空的话，归属芯片与右侧工作台会把它当"没选目录"，双双退回默认
  // 工作空间：在快照对话上就表现为凭空摆出「Claude / main」那颗芯片、工作台也开错目录。
  if (projId) session.projectId = projId;
  if (shown && sameSnapshot(chat.messages, msgs)) return;   // 内容没变 → 不动 DOM/视口
  replaceMessages(msgs);
  session.id = id;
  rememberSession(id);
  ui.view = 'chat';
}

// —— 会话正文预取：列表刷新后，把最近几条「没缓存或已过期」的会话正文悄悄拉回本地 ——
// 之后点开直接渲染缓存，不等隧道往返。串行不抢带宽；缓存 ts ≥ 服务端 mtime 则跳过；
// 正在生成/等提问的会话不取（transcript 是半截）。
let _prefetching = false;
export async function prefetchSessions(list) {
  if (_prefetching || ui.offline) return;
  _prefetching = true;
  try {
    for (const s of (list || []).slice(0, 5)) {
      if (session.busy) break;                      // 开始流式 → 让路
      if (s.thinking || s.pending) continue;
      const meta = await getCachedMessagesMeta(s.id);
      if (meta && s.mtime && meta.ts >= s.mtime) continue;
      try {
        const d = await api.session(s.id);
        cacheMessages(s.id, toUiMessages(d.messages || [], s.id));
      } catch { break; }                            // 网络不行 → 别继续白试
    }
  } finally { _prefetching = false; }
}

// attach 重放会从头完整重建当前这一轮；若历史尾部【已经】带着这一轮的内容（before 过滤
// 失效、loadSession 网络失败回退到含本轮的缓存快照、加载与挂载间的竞态都会造成），不剪掉
// 就会整轮问答显示两遍。只认「最后一个 user 气泡文本 = 本轮 prompt」这一种形态，命中则
// 从它起剪到末尾——随后的重放原样补回，净效果就是去重。
function trimTurnTail(userText) {
  if (!userText) return;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const msg = chat.messages[i];
    if (msg.role !== 'user') continue;
    if ((msg.text || '') === userText) chat.messages.splice(i);
    return;
  }
}

// ---- 语义指纹（transcript merge 用）----------------------------------------------
// 只看内容，忽略 tokens/elapsed/startedAt/__notified 这些直播派生字段。否则同一条消息
// 「直播渲染出来的」和「transcript 重建出来的」永远不相等，对账时 mergeMessages 会从
// 第 0 条开始全量替换——整屏 DOM 重建、闪一下、白丢滚动位置。
// media 返回 null = 【不参与比较】：transcript 重建刻意不还原媒体富 UI（见 readSessionMessages），
// 把它计入指纹的话，一轮生成过图片的对话每次对账都会被判成"有变化"，然后拿重建版覆盖
// 掉——刚生成的图就这么没了。
// tools 只看 tool_use id 列表（不含 status/summary/task）：直播与历史的 id 同源（transcript
// 里的 tool_use.id），任务状态/子转录这些直播比历史更富的字段一律不进指纹，否则对账会
// 拿历史的贫版把富卡换掉。没有 id 的旧服务端条目回落 name|summary。
// notice 只看 subtype/from/to：at 直播是服务端 Date.now()、历史是 jsonl 时间戳，永远对不上。
// 压缩条目额外带「有没有摘要」：直播按位置认摘要帧，万一没认出来，对账时拿历史那份（有摘要）补上。
function segFp(s) {
  if (!s) return null;
  switch (s.kind) {
    case 'text': return ['t', (s.md || '').trim()];
    case 'tools': return ['k', (s.tools || []).map((t) => (t.id || ((t.name || '') + '|' + (t.summary || ''))) + (t.compact && t.compact.summary ? '#s' : ''))];
    case 'notice': return ['n', s.subtype || '', s.from || '', s.to || ''];
    case 'ask': return ['q', s.qid || '', !!s.answered, !!s.cancelled, (s.items || []).map((it) => (it.selected || []).join(',') + '|' + (it.custom || ''))];
    default: return null;
  }
}
function msgFp(m) {
  if (!m) return '';
  if (m.role === 'user') return JSON.stringify(['u', m.text || '', (m.attachments || []).map((a) => a.name || '')]);
  return JSON.stringify(['a', (m.segments || []).map(segFp).filter(Boolean), (m.attachments || []).map((a) => a.path || a.name || ''), m.status === 'error' ? (m.error || 'err') : '']);
}

// 指纹对用户消息只看文字 + 附件名（故意不看 URL：URL 带 token/局域网地址，每次都可能不同，
// 看了就会整条重建）。代价是 URL 本身永远换不进来——直播气泡的 blob:、缓存里写死的旧
// token / 局域网地址，一旦失效就一直破图。所以在相同前缀里单独把附件 URL 对到服务端那份：
// 只换 attachments 这一个字段，不动消息对象本身（不触发整条重建）。返回是否有改动。
function refreshAttachmentUrls(curList, next, n) {
  let changed = false;
  for (let k = 0; k < n; k++) {
    const a = curList[k], b = next[k];
    if (!a || a.role !== 'user' || !b || !(b.attachments || []).length) continue;
    const urls = (x) => (x.attachments || []).map((t) => [t.url || '', t.thumb || '']);
    if (JSON.stringify(urls(a)) === JSON.stringify(urls(b))) continue;
    const old = a.attachments || [];
    // 按位合并（指纹已保证附件名逐个对得上）：保留直播那份的 path/file（「重试」要靠 path 重发），
    // 只拿服务端的 url/thumb 覆盖。
    a.attachments = b.attachments.map((t, j) => ({ ...(old[j] || {}), ...t }));
    revokeMessageBlobUrls([{ attachments: old }]);
    changed = true;
  }
  return changed;
}

function mergeMessages(next) {
  const curList = chat.messages;
  let i = 0;
  while (i < curList.length && i < next.length && msgFp(curList[i]) === msgFp(next[i])) i++;
  const urlsChanged = refreshAttachmentUrls(curList, next, i);
  if (i === curList.length && i === next.length) return urlsChanged;   // 正文一模一样 → 只可能换了附件 URL
  const dropped = curList.slice(i);
  curList.splice(i, curList.length - i, ...next.slice(i));
  revokeMessageBlobUrls(dropped);   // 被换掉的那批里若挂着本地 blob 预览，跟着一起释放
  // 工作台任务视图正盯着被换掉那批里的条目 → 收掉（否则它盯着一个已不在视图里的旧 proxy）
  for (const msg of dropped) for (const s of (msg.segments || [])) if (s.kind === 'tools') for (const t of s.tools) forgetTaskTool(t);
  return true;
}

// ---- 输入建议（官方 prompt suggestion）-------------------------------------------
// 服务端每轮定局后经总线推 {type:'suggestion', sessionId, text, at}；hello 帧带全量 {sid:{text,at}}。
// 纯显示态，不进 requestSync：Composer 在输入框空着时把它当占位文字，Tab 填入、Esc 收起（dismissed）。
function noteSuggestion(sid, v) {
  if (!sid || !v || !v.text) return;
  const cur = status.suggestions[sid];
  if (cur && cur.at === v.at) return;   // 同一条（hello 重放）→ 保留本机的 dismissed
  status.suggestions[sid] = { text: String(v.text), at: v.at || Date.now() };
}
// hello = 服务端眼下的全量：不在里面的就是已过时（别处开了新一轮 / 服务重启），一并收掉。
function syncSuggestions(all) {
  const next = all && typeof all === 'object' ? all : {};
  for (const sid of Object.keys(status.suggestions)) if (!next[sid]) delete status.suggestions[sid];
  for (const [sid, v] of Object.entries(next)) noteSuggestion(sid, v);
}

// ---- 总线事件 / 页面接线 ---------------------------------------------------------
// 一切「刚发生了什么」全部折算成 requestSync——内核自己去探真相，绝不按事件内容直接改状态。
// （输入建议例外：它只是显示态，照事件直接记。）
export function onBusEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case 'hello':
      if ('suggestions' in ev) syncSuggestions(ev.suggestions);
      // hello 是【每次连上/重连】都发的，也是「你不在的这段时间发生了什么」唯一的交底。
      requestSync('hello');
      return;
    case 'suggestion':
      noteSuggestion(ev.sessionId, ev);
      return;
    case 'run.start':
      if (ev.sessionId) delete status.suggestions[ev.sessionId];   // 新一轮开跑：上一条建议过时
      if (!ev.sessionId || mutedLive.has(ev.sessionId)) return;
      if (session.id === ev.sessionId || !session.id) requestSync('run.start');
      return;
    case 'run.end':
      // 稍等：健康直播流的 done 事件通常几百 ms 内就到，先让它自己收尾（doSync 里还有
      // 2.5s 宽限做双保险）；死流则由这次 sync 接管收敛。
      if (ev.sessionId && ev.sessionId === session.id) requestSync('run.end', 800);
      return;
    case 'session.touch':
      if (ev.sessionId && ev.sessionId === session.id) requestSync('touch', ev.live ? 0 : 400);
      return;
  }
}

// 兼容旧接线名（ClaudePage 兜底轮询 / SnapPage 镜像轮询 / 回前台对账）——全部等价于 requestSync。
export function mirrorActiveTurn() { requestSync('mirror'); }
export async function reconcileSession() { requestSync('reconcile'); }

export async function restoreOnBoot() {
  let a = null;
  try { a = await probeActive(); } catch {}
  const saved = storeGet(LAST_KEY);
  const runs = runsOf(a).filter((r) => r.sessionId);
  // 上次看的会话正在跑（属于"回到原处"）→ 挂直播。
  const savedRun = saved ? runs.find((r) => r.sessionId === saved) : null;
  if (savedRun) { await openRun(savedRun); return; }
  // 否则挂最新的一轮（别处发起的直播镜像）。
  if (runs.length) { await openRun(runs[runs.length - 1]); return; }
  if (saved) await loadSession(saved);
}
