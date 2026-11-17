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
//   retract{text,thinking,tools} · gen_media*{...} · error{message,title,...} · done{result,isError} ·
//   ctx_usage{sessionId,usage}（done 之后才到，只改 status）· effort{sessionId,level}
// 工具行有结果【状态】事件（tool_done：成败/耗时）但没有结果正文——正文只在服务端 transcript。

import { pump, watch, linkAbort } from '../sse.js';
import { api, authHeaders } from '../api.js';
import { apiUrl, noteNetFail } from '../server.js';
import { session, settings, ui, status, compose, refusalBand, prefs, sessionWt, hostIsServer } from '../state.svelte.js';
import { closeTaskDetail, dock } from '../dock.svelte.js';
import { cacheMessages, getCachedMessages } from '../cache.js';
import { agentStart, agentEnd } from '../notify.js';
// 设置 › Claude（服务端按身份存、多设备同步）：输入建议 / 自动压缩点；本文件 chatParams 里有局部变量 cs，取别名
import { cs as claudeCs } from '../claudeSettings.svelte.js';
import { pendingOutputStyle, markOutputStyleSent, adoptOutputStyleSent, absorbSessionOutputStyle } from '../outputStyle.svelte.js';
import { noteBrowserMount, refreshBrowserMount } from '../dock.svelte.js';
import { storeGet } from '../store.js';
import { IS_CSNAP } from '../csnap.js';
import { prefsFor, lastPrefs, absorbServerPrefs } from '../chatPrefs.js';
import { promoteComposerDraft, syncComposerDraftKey } from '../composerDrafts.svelte.js';
// 权限模式 / 逐次审批卡 / 计划审批卡（2026-10-20）：帧处理与状态都在 permissions.svelte.js，这里只转发
import { permOnFinish, draftPermissionMode, draftShape, setDraftShape, resetPermDraft, steerWhileWaiting } from '../permissions.svelte.js';
import { t as tt, tr } from '../i18n.js';   // 本文件的 t 是工具行/任务局部变量，翻译函数取别名 tt
import { noteSessionArchived } from '../sessionArchive.svelte.js';   // 单条加载带回的归档态（「此会话已归档」横条）
import { narrowViewport } from '../widgetSeg.js';   // 对话内嵌交互图表（widget_* 帧 → widget 段；窄屏按手机宽度出图）
import { devices, thisDeviceId } from '../devices.svelte.js';   // 用户的电脑（设备）：发消息带上本机设备 id / 新会话选的电脑
import { effectiveEffort } from '../claudeProviders.svelte.js';   // 自定义模型只带它档位表里的推理强度（换模型带过来的不发）
import { showToast } from '../toast.svelte.js';
import { chat } from './store.svelte.js';
import { _trace, trace, noteSlow, timed } from './trace.js';
import { LAST_KEY, rememberSession, applyPrefs, notePrefsNow } from './prefs.js';
import { sentAttachments, cacheChat, revokeMessageBlobUrls, toUiAttachments } from './attachments.js';
import { tickHint } from './runHint.js';
import { newAssistant, cur, hasContent, flushText, dropText } from './turn.js';
import { pendingNew, notePendingNew, dropPendingNew } from './pending.svelte.js';
import { queueState, mcpState, noteLimitResume, refreshQueue } from './queue.svelte.js';
import { toUiMessages, trimTurnTail, mergeMessages } from './history.js';
import { STATUS_ONLY, applyStatusEvent, applyEvent } from './events.js';

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

function replaceMessages(next) {
  if (chat.messages !== next) revokeMessageBlobUrls(chat.messages);
  chat.messages = next;
  // 整表换掉 = 切会话/新聊天：工作台任务视图里挂的是旧表的条目、横条属于旧会话，一并收掉
  //（官方语义：重进会话时历史上的回退只留时间线卡、不再弹横条）。
  closeTaskDetail();
  refusalBand.notice = null;
}

// 号池智能路由撞墙换号后的无缝接续（服务端只在本端声明了 autoRetry、且确实换成了号时才下发）：
//   resend   = 这一轮什么都没产出 → 撤掉这对气泡、用新号原样重发（服务端已把失败那条从上下文分叉掉）；
//   continue = 已经干了一半 → 保留，发一句「接着做」。
// 同一条消息最多自动接 2 次（服务端号池全员用尽时本就不再下发，这里再兜一道防打转）。
// 只在发起这轮的设备上做（__sentHere）：attach 重放到别的设备的同一张错误卡不会重复重发。
// 守卫用发送序号而不是对象身份：收轮后的历史对账会把 chat.messages 整组换成服务端视图（resend 时
// 失败那条已被分叉锚点截掉），旧对象全对不上，但这不是「用户接手了」。
const AUTO_RETRY_MAX = 2;
let sendSeq = 0;   // 每次 reallySend +1
export function scheduleAutoRetry(m, mode) {
  const i = chat.messages.indexOf(m);
  const u = i > 0 ? chat.messages[i - 1] : null;
  if (!u || u.role !== 'user') return;
  const n = (u.__autoRetries || 0) + 1;
  if (n > AUTO_RETRY_MAX) return;
  const sid = session.id;
  const seq = sendSeq;
  const text = u.text;
  const atts = (u.attachments || []).filter((a) => a.path);
  setTimeout(() => {
    // 用户已经接手（发了别的、换了会话、又开了一轮）就不插手
    if (session.busy || session.id !== sid || sendSeq !== seq) return;
    if (mode === 'resend') {
      // 失败的这对气泡还在本地视图里就撤掉（历史对账可能已经替我们截掉了）
      const j = chat.messages.indexOf(m);
      if (j > 0 && chat.messages[j - 1] === u) chat.messages.splice(j - 1, 2);
      else if (j >= 0) chat.messages.splice(j, 1);
      revokeMessageBlobUrls([m]);   // 只清助手气泡；用户附件对象随重发的新气泡沿用，不能吊销
      reallySend(text, atts);
    } else {
      reallySend(tt('刚才的账号额度用尽，已自动换号。请从中断的地方继续。'), []);
    }
    const nu = chat.messages[chat.messages.length - 2];
    if (nu && nu.role === 'user') nu.__autoRetries = n;
  }, 800);
}

// 流上来的每一帧：先记「这条流还活着」，再交给事件归并（./events.js）。
function onEvent(m, ev) {
  lastLiveAt = Date.now();   // 这条流还活着
  applyEvent(m, ev);
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
  permOnFinish(m, session.id);   // 审批卡同理（硬停止时服务端不再补发作答帧）
  if (m && m.role === 'assistant' && m.status === 'streaming') m.status = 'done';
  if (m && m.role === 'assistant' && !m.__notified) {
    m.__notified = true;
    const errored = m.status === 'error';
    const ft = m.segments && m.segments.find((s) => s.kind === 'text' && s.md.trim());
    agentEnd('Claude', errored ? tt('出错：{error}', { error: tr(m.error || '') }) : (ft ? ft.md : ''), { error: errored, watching: ui.screen === 'claude' && !document.hidden });
  }
  rememberSession(session.id);
  dropPendingNew(pendingNew.mine);   // 这一轮收了（含没拿到 id 就报错的）：占位不留
  session.busy = false;
  chat.reconnecting = false;
  chat.unverified = false;   // 终止事件 / 服务端确认没在跑 / 用户亲手停 / 明确报错——结局都是确定的
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

// attach 帧说的那一轮，是不是屏上这条流式气泡所属的那一轮？
// 气泡挂过直播就有 turnId（服务端那一轮的标识），直接比；本端亲手发出、还没重挂过的气泡没有 turnId，
// 退而比「最后一条用户气泡的文字」与这一轮的 prompt——不一样就是别的轮（自动续跑句、排队消息、别的设备发的）。
// 拿不准（旧服务端不带 turn、没有 prompt）一律当同一轮，维持原来的整轮重放去重。
// 发送可能没落地的空气泡（__sendLost）碰上一轮【已完成】的重放 = 服务端只剩上一轮：不在这里拆，照旧处理。
function isOtherTurn(m, ev) {
  if (ev.turn && m.turnId) return ev.turn !== m.turnId;
  if (!ev.userText) return false;
  if (m.__sendLost && ev.done && !hasContent(m) && !m.thinking) return false;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const u = chat.messages[i];
    if (u.role === 'user') return (u.text || '') !== ev.userText;
  }
  return false;
}

// 封存一条已经不会再有下文的流式气泡（它那一轮在服务端已经没了）：有内容就原样留下、置 done；
// 一个字都没流到的空壳直接撤掉。只收这条气泡自己的状态——计时、busy、通知归紧接着的新一轮管。
function sealStaleTurn(m) {
  flushText();
  if (!hasContent(m) && !m.thinking) {
    const i = chat.messages.indexOf(m);
    if (i >= 0) chat.messages.splice(i, 1);
    return;
  }
  m.bgHold = null; m.paused = false; m.wait = null; m.retry = null; m.compacting = false; m.hint = null;
  permOnFinish(m, session.id);
  m.status = 'done';
  m.__notified = true;   // 它的结局由新一轮交代，别再单独弹「完成」通知
}

// ---- 直播流（唯一一条）---------------------------------------------------------
// 事件应用：晚到的旧流事件靠 live === my 一票否决——内核换流后旧流彻底失声。
function applyLiveEvent(my, ev) {
  if (live !== my || !ev) return;
  if ((ev.type === 'session' || ev.type === 'attach' || ev.type === 'start') && ev.sessionId) my.sessionId = ev.sessionId;
  // 直播流本身就是服务端在说话：收到它的帧，视图的运行状态就有了着落
  if (chat.unverified && (!my.sessionId || my.sessionId === session.id)) { chat.unverified = false; trace('live-confirmed'); }
  let m = cur();
  let sealed = false;
  // attach 挂上来的是【另一轮】，而屏上那条气泡还在流式态（上一轮没来得及定局：服务重启后自动继续、
  // 排队消息紧跟着开跑、别的设备顶掉了这一轮，再叠上网络卡）：把旧气泡按已流到的内容封存，
  // 下面照「新一轮」另起气泡。以前直接把新一轮重放进旧气泡——已经显示的内容被清空、续跑那句也没有用户气泡，
  // 要等这一轮结束和 transcript 对账后才回来（11-09 维护者报）。
  if (ev.type === 'attach' && m && m.role === 'assistant' && m.status === 'streaming' && isOtherTurn(m, ev)) {
    trace('attach-other-turn', ev.turn || 0);
    sealStaleTurn(m);
    m = cur();
    sealed = true;
  }
  if (!m || m.role !== 'assistant' || m.status !== 'streaming') {
    // 轮已定局后的尾巴事件（ctx_usage 等，见 STATUS_ONLY）：只改 status，绝不为它们再开一条气泡。
    if (STATUS_ONLY.has(ev.type)) { lastLiveAt = Date.now(); applyStatusEvent(ev); return; }
    // attach 整轮重放的开头：历史尾部若已带着这一轮（缓存快照/落盘竞态），先剪掉再由重放原样补回=净去重。
    // 补回的用户气泡要带上附件：优先沿用被剪掉那条的（图已加载、带 path 供重试），没有就用服务端随 attach 帧给的。
    // 以前只补文字——切到别的 app 再回来、重挂直播那一下，刚发的图就从气泡里消失了。
    if (ev.type === 'attach') {
      // 刚封存了上一轮：尾部那条用户气泡是上一轮的（哪怕文字碰巧一样），不剪
      const old = sealed ? null : trimTurnTail(ev.userText);
      const atts = old && old.length ? old : toUiAttachments(ev.userAtts);
      if (ev.userText) chat.messages.push({ role: 'user', text: ev.userText, ...(atts.length ? { attachments: atts } : {}) });
    }
    m = newAssistant();
    session.busy = true;
    startTimer();
    agentStart('Claude');
    ui.view = 'chat';
  }
  if (ev.type === 'attach' && ev.turn) m.turnId = ev.turn;   // 这条气泡属于哪一轮（见 isOtherTurn）
  onEvent(m, ev);
  if (isTerminal(ev)) {
    my.terminal = true;
    if (my.sessionId && !session.id) { promoteComposerDraft(my.sessionId); adoptOutputStyleSent(my.sessionId); session.id = my.sessionId; }
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
  // 服务端几十毫秒内就回响应头（实测 23ms）；8s 还没回 = 请求悬在 WebView 里了，掐掉这次重来，
  // 不让收敛路径陪它干等（悬多久界面就错多久）。只管到响应头为止，之后的流归看门狗管。
  const t0 = Date.now();
  const headTimer = setTimeout(() => { trace('attach-head-timeout', sid); attempt.abort(); }, 8000);
  let res;
  try {
    res = await fetch(apiUrl('/api/attach' + (sid ? '?session=' + encodeURIComponent(sid) : '')), {
      method: 'POST', headers: authHeaders(), credentials: 'same-origin', signal: attempt.signal,
    });
  } finally {
    clearTimeout(headTimer);
    const d = Date.now() - t0;
    if (d > 2000) noteSlow('attach', d);
  }
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
    noteNetFail();
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
    if (session.id !== sid) { session.id = sid; syncComposerDraftKey(); rememberSession(sid); ui.view = 'chat'; }   // 历史加载失败也要把视图归属定下来
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
    const data = await timed('reconcile', api.session(sid), 12_000);
    if (ep !== kernelEpoch || sid !== session.id) return 'stale';
    const msgs = toUiMessages(data.messages || [], sid);
    if (msgs.length < minLen) return 'behind';   // 落盘慢半拍：这份还不完整，别记指纹
    mergeMessages(msgs);
    if (!IS_CSNAP) cacheMessages(sid, msgs, data.fp);
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
    const data = await timed('freshen', api.session(sid, _fp.get(sid)), 12_000);
    if (gen !== loadGen || sid !== session.id || session.busy || live) return;
    noteFp(sid, data);
    if (data.unchanged) return;   // 服务端定论：这一份跟你手里的一模一样
    const msgs = toUiMessages(data.messages || [], sid);
    if (!mergeMessages(msgs)) return;
    if (!IS_CSNAP) cacheMessages(sid, msgs, data.fp);
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
    syncOnce(reason);
  }, Math.max(0, delayMs));
}

let _syncStartedAt = 0, _syncRun = 0;
async function syncOnce(reason) {
  // 保险丝：每个网络等待都已封顶，正常一次收敛最多十几秒；超过 30s 还没回来 = 有一步悬死了，
  // 不再让它挡着后面所有唤醒（它晚到的结果各分支自有 epoch / session 校验兜着）。
  if (_syncing && Date.now() - _syncStartedAt < 30_000) { _syncAgain = true; return; }
  if (_syncing) trace('sync-wedged', Date.now() - _syncStartedAt);
  const run = ++_syncRun;
  _syncing = true;
  _syncStartedAt = Date.now();
  trace('sync', reason || '');
  try { await doSync(); }
  catch (e) {
    // 收敛路径绝不允许静默死亡：报出去 + 兜底再约一次（唤醒源不在场时它就是唯一的续命）。
    try { console.error('[chat-sync]', e); } catch {}
    requestSync('error-retry', 4000);
  }
  finally {
    if (run === _syncRun) {
      const d = Date.now() - _syncStartedAt;
      if (d > 2000) noteSlow('sync:' + (reason || ''), d);
      _syncing = false;
      if (_syncAgain) { _syncAgain = false; requestSync('again'); }
    }
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
  // 服务端 1ms 内就回；6s 还没回就是这次请求悬住了——不再干等 10s（录屏里切会话的那 10 秒），
  // 走失败分支，短间隔重探（视图未确认时见 doSync）。
  return await timed('active', api.active(), 6000);
}

// detachLive 记住被主动切走的直播会话：① 不把用户拽回去；② 点回时重新 attach 续看。
const mutedLive = new Set();
let lastDetachAt = 0;   // 最近一次 detachLive 的时刻：切会话途中旧会话还静音着、session.id 还没换过去
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
    else if (chat.unverified) requestSync('offline-wait', 4000);   // 状态没确认也一样等旗子翻回
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
    else if (chat.unverified) requestSync('verify-retry', 2000);   // 视图状态还没确认：缓冲态挂着，短间隔重探
    return;
  }
  if (ep !== kernelEpoch) return;
  const runs = runsOf(a).filter((r) => r.sessionId);
  for (const id of [...mutedLive]) if (!runs.some((r) => r.sessionId === id)) mutedLive.delete(id);   // 已结束 → 解除静音
  // 空态（greeting / 切会话途中 session.id 还没落定）：什么都不挂。以前这里会自动挂上「最新在跑的一轮」
  //（别处发起的直播镜像）——并行会话一多就成了抢视图：正在新对话里打字，别的会话互发消息开了一轮，页面就被拽过去；
  // 新会话刚发出就切走，几秒后它的 run.start 到了又被拽回去（11-09 维护者报）。看哪个会话只由人点，
  // 别处新开的轮在侧栏里亮起来就够了。
  if (!sid) {
    chat.unverified = false;            // 空态没有「这一轮」可言
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
  if (run) {
    // 正看着的会话在跑、却在静音集合里：只该出现在「切走途中」（detachLive 之后、新会话的
    // session.id 落定之前）。这时不能说它结束了（那是假话），也不该把它挂回来（用户正要离开）——
    // 缓冲态等切换落定。过了切换窗口还这样 = 静音残留，用户就在看它：解除静音、挂上直播。
    if (Date.now() - lastDetachAt < 4000) { chat.unverified = true; requestSync('muted-wait', 1500); return; }
    trace('unmute-viewed', sid);
    mutedLive.delete(sid);
    if (live) killLive();
    await openRun(run);
    return;
  }
  // 服务端明确：这个会话现在没有在跑的轮。
  if (chat.unverified && !unsettled()) { chat.unverified = false; trace('idle-confirmed'); }
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
    trace: () => _trace.map(([at, what, x]) => [new Date(at).toISOString().slice(11, 23), what, x]),
    // 生产构建剔除：feed 灌合成事件 / snapshot 取纯 JSON 供断言
    // feedLive：把帧当成直播流上来的（走 applyLiveEvent 全路径，含 attach 的剪尾 / 换轮封存）
    ...(import.meta.env.DEV ? { feedLive: (ev) => { if (!live) live = { sessionId: session.id || null, ctrl: new AbortController(), terminal: false, wdKilled: false }; applyLiveEvent(live, ev); } } : {}),
    ...(import.meta.env.DEV ? { feed: (ev) => feedSynthetic(ev), snapshot: () => JSON.parse(JSON.stringify(chat.messages)) } : {}),
    state: () => ({
      live: live ? { sessionId: live.sessionId, terminal: live.terminal } : null,
      lastLiveAgo: lastLiveAt ? Date.now() - lastLiveAt : null,
      epoch: kernelEpoch, pendingSend, failingSince, behindRuns,
      syncing: _syncing, timerSet: !!_syncTimer,
      busy: session.busy, reconnecting: chat.reconnecting, unverified: chat.unverified,
      sessionId: session.id, msgs: chat.messages.length,
      lastStatus: (chat.messages[chat.messages.length - 1] || {}).status || null,
    }),
  };
}

// 回前台/联网/解冻：网络栈稍等 250ms 再收敛（也给看门狗的 wake 巡检让个身位）；
// 醒时限的表随 wake 拨回——冻结/断网那段不计入放弃倒计时。
if (typeof window !== 'undefined') {
  let hiddenAt = 0;
  const wake = () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (failingSince) failingSince = Date.now();
    // 在后台待过一阵（WebView 被冻结、socket 可能早被系统掐了）：屏上那份状态是离开时的，
    // 这期间别处可能开跑了新一轮、或这一轮早结束了——探活确认之前按未确认处理。
    // 显式的流式态（转圈）本来就会被探活纠正，这里只管「看起来已结束」的那种。
    if (hiddenAt && Date.now() - hiddenAt > 5000 && session.id && !session.busy && !live) chat.unverified = true;
    hiddenAt = 0;
    requestSync('wake', 250);
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);    // 安卓 WebView 从冻结态回来只发这个
  window.addEventListener('online', wake);
  // 兜底核对：视图看起来已结束、又没挂直播时，每 20s 探一次服务端（/api/active ~1KB，
  // 没变化的 transcript 对账只回几十字节）。总线漏发 run.start、半开的总线、本地哪条路径
  // 误判了结局——都不会让「其实在跑、屏上说完了」挂超过 20 秒。
  setInterval(() => {
    if (document.hidden || ui.screen !== 'claude' || !session.id || session.busy || live || pendingSend) return;
    requestSync('verify-tick');
  }, 20_000);
  // 不挂 window 'focus'（10-21 回归 FR4）：桌面上点一下窗口就是一次 focus，每次都打一遍 /api/active 收敛，
  // 实测 18 次 focus 打了约 20 次；从后台回来本来就会先发 visibilitychange / pageshow。
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
  pendingNew.mine = null;              // 新会话 id 还没回来就切走：占位留在侧栏，等总线那一帧认领
  lastDetachAt = Date.now();
  session.busy = false;
  chat.reconnecting = false;
  // 上面那个 done 只是「本地不再看它」，不是服务端说它结束了：切换落定之前，这一屏一律当未确认
  chat.unverified = true;
  failingSince = 0;
}

// 抽屉点会话的统一入口：直播中也能切换。看的就是直播会话 → 不动；否则先 detach 再加载；
// 点回一个正在跑的会话（被静音的直播 / 并行后台轮 / 胶囊轮）→ requestSync 重新挂直播续看。
export async function openSession(id) {
  if (session.busy || live || pendingSend) {
    const liveId = (live && live.sessionId) || session.id;
    if (id === liveId) { ui.view = 'chat'; return; }
    detachLive();
  }
  mutedLive.delete(id);                // 显式点开 = 解除静音
  refreshQueue(id);                    // 这个会话的排队消息（服务端持有）
  // sync:true —— 本地缓存一摆上屏（session.id 已换过来）就开始探活/挂直播，不等整份 transcript
  // 下完：以前要先等 /api/session 回来才探活，手机上那个请求一慢，菊花就跟着晚出来十秒。
  await loadSession(id, { sync: true });
  requestSync('open');                 // 正好有轮在跑 → 内核补挂直播续看（幂等，上面已探过也无害）
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
    me.error = hostIsServer() ? tt('离线：连不上服务器，无法发送（恢复网络后会自动重连，届时重试即可）') : tt('离线：连不上电脑，无法发送（恢复网络后会自动重连，届时重试即可）');
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
  sendSeq++;
  bumpLoadGen();   // 作废在途的历史刷新——慢返回不覆盖即将开始的流式轮
  bumpEpoch();     // 作废在途 sync 的应用
  if (handoff) settleHeldForHandoff();
  killLive();
  chat.unverified = false;   // 本端亲手开的这一轮：流式态就是真相
  chat.messages.push({ role: 'user', text: t, attachments: sentAttachments(atts) });
  notePendingNew(t);           // 新会话：侧栏先占一行，不等 id 回来
  refusalBand.notice = null;   // 新回合开始：上一轮的「已切换到 X」横条收起（官方同款）
  if (!handoff) refusalBand.prompt = null;   // 接力进同一 CLI 时那张 Paused 卡仍在等人
  session.busy = true;
  lastLiveAt = Date.now();   // 刚发出去、还一个事件都没回：这段时间不许被判成陈旧流
  const m = newAssistant();
  m.__sentHere = true;   // 本端发起的轮：号池换号后的自动重发 / 换号提示只在这里做
  startTimer();
  agentStart('Claude');

  notePrefsNow(session.id);   // 发送即记忆：本会话（新会话先记 last，id 回来再补绑）+ 新对话默认
  const params = chatParams(t, atts);
  markOutputStyleSent(params.outputStyle);   // 新会话随第一条带的输出风格：id 回来后转记成这个会话的覆盖（lib/outputStyle）
  if (session.id) delete status.suggestions[session.id];   // 这一轮开跑，上一条输入建议随之作废
  openChatStream(params, m);
}

// 发送与新会话预热共用的请求选项——预热进程的启动参数要和随后那条真消息逐项一致，服务端才会接管它。
function chatParams(t, atts) {
  const params = { message: t, agent: 'claude' };
  // 客户端形态：手机 App（apk，有原生桥）才有手机文件/操控的物理通道——后端据此决定
  // 本轮要不要给 Claude 注手机工具（修「电脑网页端误宣称能操作手机」）。
  params.client = (typeof window !== 'undefined' && window.AndroidStore) ? 'apk' : 'web';
  if (narrowViewport()) params.narrow = true;   // 内嵌图表：窄屏（手机浏览器）按约 380px 宽出图
  // 用户的电脑（设备）：从桌面客户端发的带上本机设备 id——新会话没选过电脑时默认连这台；
  // 新会话在电脑芯片里选过（某台 / 不连）就随第一条带上（续聊改连走 /api/devices/link）。
  const pc = thisDeviceId();
  if (pc && !IS_CSNAP) params.fromComputer = pc;
  if (!session.id && !IS_CSNAP && devices.draft && devices.draft !== 'auto') params.computer = devices.draft;
  if (session.id) params.sessionId = session.id;
  // 项目制：新会话带上项目（=cwd）；续聊服务端按 transcript 所在目录反查，此值被忽略。
  if (!session.id && session.projectId) params.claudeProjectId = session.projectId;
  // worktree 勾选框：只对新会话、且服务端说这里能开 worktree 会话（wtNew：git 主检出）时生效——芯片上
  // 勾选框也只在这时出现；dock.meta 此刻就是新对话落点的那份。项目本身已是 linked worktree 就不再套一层。
  if (!session.id && prefs.worktree && !IS_CSNAP && dock.meta?.wtNew) params.worktree = true;
  if (settings.model) params.model = settings.model;
  // 自定义模型：芯片藏着（没有档位）或选的不在它的档位表里就不带
  const eff = effectiveEffort(settings.model, settings.effort);
  if (eff) params.effort = eff;
  // Ultracode 与档位独立（10-30）；快照访客没有它（服务端也会拦），不带
  if (settings.ultracode && !IS_CSNAP) params.ultracode = true;
  if (settings.fast) params.fast = true;
  if (settings.research) params.research = true;
  // 输入建议：开关开着才让服务端生成（定局后 CLI 预测下一句）。自 2026-10-20 起两项都以服务端设置为准
  //（claudeCs），这里照带只为与老服务端兼容；新服务端改过的值盖过请求体。
  if (claudeCs.values.promptSuggestions !== false && !IS_CSNAP) params.suggest = true;
  if (claudeCs.values.compactFrac && !IS_CSNAP) params.compactFrac = claudeCs.values.compactFrac;   // 自动压缩点（用量弹层滑块）
  // 新会话在加号菜单里单独选了输出风格：随第一条带上，服务端记进这个会话的 chat-prefs（lib/outputStyle）
  if (!session.id && !IS_CSNAP && pendingOutputStyle()) params.outputStyle = pendingOutputStyle();
  // 权限模式：只有新会话带草稿里选的（续聊用会话自己的记忆，见 src/runtime/permissions.mjs）
  if (!session.id && !IS_CSNAP && draftPermissionMode()) params.permissionMode = draftPermissionMode();
  // 项目模式：新对话草稿里选了「项目」——这条对话是协调者（预热也带上，起的就是协调者版 CLI）
  if (!session.id && !IS_CSNAP && draftShape()) params.shape = 'project';
  // 转成项目（convertToProject）：首条真消息带上原会话 id，服务端在前面附一张「原会话」卡；预热（没有正文）不带、也不消费
  if (!session.id && t && fromSessionNext && draftShape()) { params.fromSession = fromSessionNext; fromSessionNext = null; }
  params.autoRetry = true;   // 声明：号池撞墙被自动换号时本端会自己重发（见 scheduleAutoRetry）
  if (atts.length) params.attachments = atts.map((a) => a.path).filter(Boolean);
  return params;
}

// 新会话预热：「新对话」输入框获得焦点 / 开始打字时调。服务端按同一套选项提前起好 CLI（约 300MB，
// 10 分钟没人用就收），第一条消息不再等 spawn 与 MCP 握手（实测会话帧 1.6s → 0.06s）。
// 只对主机 admin 生效，其余身份服务端回 204；同一组选项 60 秒内只打一次（服务端同参数也只续期）。
let lastPrewarm = { key: '', at: 0 };
export function prewarmNewChat() {
  if (session.id || session.busy || IS_CSNAP || ui.offline) return;
  const params = chatParams('', []);
  delete params.message;
  if (params.worktree) return;   // worktree 新会话要先切目录，cwd 事先不知道
  const key = JSON.stringify(params);
  if (key === lastPrewarm.key && Date.now() - lastPrewarm.at < 60_000) return;
  lastPrewarm = { key, at: Date.now() };
  fetch(apiUrl('/api/chat/prewarm'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: key,
    credentials: 'same-origin',
  }).catch(() => {});
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
    noteNetFail();                       // 发送阶段网络失败：LAN 失效，重试走隧道
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
    // 会话正被 Desktop / 终端 CLI 持有（服务端单写者判活）：重试也不会过，直接把原因摆出来。
    if (res.status === 409) {
      let msg = '';
      try { msg = (await res.json())?.error || ''; } catch {}
      m.status = 'error'; m.error = msg || tt('这个会话正在别处打开，请先关掉再续聊');
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
  if (session.busy || live || pendingSend || unsettled()) detachLive();   // 直播中也能开新聊天：后台轮继续跑，完成照常提醒
  bumpLoadGen();                    // 作废在途的历史刷新——慢返回不把空白新聊天顶回旧会话
  replaceMessages([]);
  session.id = null;
  chat.unverified = false;          // 空白新对话没有要确认的轮
  syncComposerDraftKey();           // 输入栏换成新对话那份草稿（同步：调用方可能紧接着往里塞附件）
  session.pendingQid = null;
  session.projectId = projectId || null;  // 项目上下文：首轮拿到会话 id 时上报归属
  resetPermDraft();                 // 权限模式草稿回到「跟文件夹默认」
  rememberSession(null);
  applyPrefs(lastPrefs());          // 新对话选择器 = 最近一次的选择（而不是沿用刚看的会话的）
  ui.view = 'greeting';
}

// 转成项目（档位菜单里普通对话的「转成项目」，运行档位 › 项目）：以这段对话为背景另开一个项目对话——
// 同一个项目（工作空间）里新开、形态是项目，首条消息带 fromSession（服务端 routes/project-mode.mjs projectSourceNote）。
// 原会话不动。返回 false = 这会儿开不了（还在跑 / 没有会话）。
let fromSessionNext = null;
export function convertToProject(srcSid, text) {
  if (!srcSid || session.busy || IS_CSNAP) return false;
  const pid = session.projectId;
  newConversation(pid);
  setDraftShape(true);
  fromSessionNext = srcSid;
  send(text, []);
  return true;
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
      chat.unverified = true;   // 缓存只说明「上次看到时是这样」，在不在跑要等内核探过才知道
      syncComposerDraftKey();
      rememberSession(id);
      ui.view = 'chat';
      shown = true;
      if (opts && opts.sync) requestSync('open-cached');
    }
  }
  let msgs = null;
  let projId = null;
  try {
    // 封顶：有缓存垫着时这只是后台刷新，没缓存时它挡着首屏——都不许无限期悬着
    const data = await timed('load', api.session(id), 15_000);
    projId = data.projectId || null;   // 会话归属（=工作空间/项目）：服务端按 transcript 所在目录判的真值
    if (!IS_CSNAP) noteSessionArchived(id, data);   // 冷启动恢复 / 助手 open_session 打开的已归档会话也认得出
    if (data.wt && data.wt.cwd) sessionWt[id] = data.wt;
    let raw = data.messages || [];
    if (before) raw = raw.filter((x) => !x.ts || x.ts < before);
    else noteFp(id, data);   // 只在未过滤时记：裁过的视图 ≠ 服务端那份，不能拿来短路
    msgs = toUiMessages(raw, id);
    if (!before && !IS_CSNAP) cacheMessages(id, msgs, data.fp);    // 在线成功 → 写本地缓存（离线可读；截断态不缓存；快照模式不落）
    // 连接器状态（最近一轮 init 帧，服务端内存）：重开会话时输入框上方的「需要授权」提示条靠它（流里的 mcp 事件更新的优先）
    if (!before && !IS_CSNAP && Array.isArray(data.mcp) && !mcpState.bySession[id]) mcpState.bySession[id] = { servers: data.mcp, at: Date.now() };
    if (!before && !IS_CSNAP && data.prefs) {
      absorbServerPrefs(id, data.prefs);                  // 服务端 sidecar（可能来自别的设备）并入本地
      absorbSessionOutputStyle(id, data.prefs);           // 会话级输出风格覆盖（加号菜单 › 输出风格 主行首屏就对）
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
  // transcript 里没有「这轮还在跑」的信息（摆出来的每一轮都像已结束）——同样等探活确认。
  // before 模式是 openRun 挂直播前补历史，紧接着就 attach，结局由直播流定。
  if (!before) chat.unverified = true;
  syncComposerDraftKey();
  rememberSession(id);
  ui.view = 'chat';
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
      refreshBrowserMount();   // 断线期间浏览器可能被关 / 回收：重连时对一遍状态灯
      // hello 是【每次连上/重连】都发的，也是「你不在的这段时间发生了什么」唯一的交底。
      requestSync('hello');
      return;
    case 'suggestion':
      noteSuggestion(ev.sessionId, ev);
      return;
    case 'browser.mount':
      // 这个对话的浏览器有没有标签（工具开关上的状态灯），纯显示态，照事件直接记
      noteBrowserMount(ev.sessionId, !!ev.mounted);
      return;
    case 'run.start':
      if (ev.sessionId) delete status.suggestions[ev.sessionId];   // 新一轮开跑：上一条建议过时
      if (!ev.sessionId || mutedLive.has(ev.sessionId)) return;
      if (session.id === ev.sessionId) requestSync('run.start');   // 只跟正看着的会话；别的会话开跑不动视图（见 doSync 空态分支）
      return;
    case 'run.end':
      // 稍等：健康直播流的 done 事件通常几百 ms 内就到，先让它自己收尾（doSync 里还有
      // 2.5s 宽限做双保险）；死流则由这次 sync 接管收敛。
      if (ev.sessionId && ev.sessionId === session.id) requestSync('run.end', 800);
      return;
    case 'session.touch':
      if (ev.sessionId && ev.sessionId === session.id) requestSync('touch', ev.live ? 0 : 400);
      return;
    case 'queue':
      // 排队消息（服务端持有，见 src/runtime/claude-queue.mjs）：纯显示态，照事件直接记
      if (ev.sessionId) {
        queueState.bySession[ev.sessionId] = Array.isArray(ev.items) ? ev.items : [];
        if (ev.error && ev.sessionId === session.id) queueState.error = ev.error;
      }
      return;
    case 'limit_resume':
      // 自动续跑状态变了（勾选框在别的设备上改了 / 到点发出 / 作废）：纯显示态，照事件直接记
      if (!ev.sessionId) return;
      noteLimitResume(ev.sessionId, ev.state || null);
      if (ev.sessionId === session.id) {
        if (ev.fired) showToast(tt('限额已重置，正在继续会话'));
        else if (ev.error) showToast(tr(ev.error));
      }
      return;
    case 'restart_resume':
      // 服务意外重启后自动继续（src/runtime/restart-resume.mjs）发出了：新一轮的 run.start 会把直播挂上，这里只交代一声为什么
      if (ev.fired && ev.sessionId && ev.sessionId === session.id) showToast(tt('服务刚才意外重启，正在继续会话'));
      return;
  }
}

async function postChatJSON(params) {
  const res = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(params),
    credentials: 'same-origin',
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

function steerParams(t, atts, priority) {
  const params = { message: t, agent: 'claude', sessionId: session.id, priority };
  params.client = (typeof window !== 'undefined' && window.AndroidStore) ? 'apk' : 'web';
  if (narrowViewport()) params.narrow = true;   // 内嵌图表：窄屏（手机浏览器）按约 380px 宽出图
  const pc = thisDeviceId();
  if (pc && !IS_CSNAP) params.fromComputer = pc;
  if (settings.model) params.model = settings.model;
  const eff = effectiveEffort(settings.model, settings.effort);
  if (eff) params.effort = eff;
  if (settings.ultracode && !IS_CSNAP) params.ultracode = true;
  if (settings.fast) params.fast = true;
  if (settings.research) params.research = true;
  if (claudeCs.values.promptSuggestions !== false && !IS_CSNAP) params.suggest = true;
  if (claudeCs.values.compactFrac && !IS_CSNAP) params.compactFrac = claudeCs.values.compactFrac;
  if (atts.length) params.attachments = atts.map((a) => a.path).filter(Boolean);
  return params;
}

// 409 not_running = 服务端那一轮恰好刚收尾：等本地也收尾后按普通发送（最多等 6 秒）
function sendWhenIdle(t, atts) {
  let tries = 0;
  const tick = () => {
    if (!session.busy || bgHoldNow()) { send(t, atts); return; }
    if (++tries > 20) { send(t, atts); return; }
    setTimeout(tick, 300);
  };
  tick();
}

// 插话：消息推进正在跑的这一轮（priority next），Claude 做完手头这一步就读到，不打断。
// 气泡由流里的 steer 事件落段（单写者）。返回 false = 没发出去（调用方保留输入框内容）。
export async function steer(text, attachments) {
  const t = (text || '').trim();
  const atts = attachments !== undefined ? attachments.slice() : compose.attachments.slice();
  if ((!t && !atts.length) || !session.id || IS_CSNAP) return false;
  if (attachments === undefined) compose.attachments = [];
  let r;
  try { r = await postChatJSON(steerParams(t, atts, 'next')); } catch { r = { status: 0 }; }
  if (r.status === 200 && r.body?.steered) { steerWhileWaiting(session.id); return true; }   // 卡在审批上：提示批完才读到
  if (r.status === 409 && r.body?.code === 'not_running') { sendWhenIdle(t, atts); return true; }
  if (attachments === undefined) compose.attachments = atts;   // 没发出去：附件放回输入框
  queueState.error = r.body?.error || tt('插话没发出去，请重试');
  return false;
}

// 稍后发送：排进服务端队列，这一轮结束后合并成一条自动发出。
export async function queueSend(text, attachments) {
  const t = (text || '').trim();
  const atts = attachments !== undefined ? attachments.slice() : compose.attachments.slice();
  if ((!t && !atts.length) || !session.id || IS_CSNAP) return false;
  if (attachments === undefined) compose.attachments = [];
  const sid = session.id;
  let r;
  try { r = await postChatJSON(steerParams(t, atts, 'later')); } catch { r = { status: 0 }; }
  if (r.status === 200 && r.body?.queued) { queueState.bySession[sid] = r.body.items || []; return true; }
  if (r.status === 409 && r.body?.code === 'not_running') { sendWhenIdle(t, atts); return true; }
  if (attachments === undefined) compose.attachments = atts;
  queueState.error = r.body?.error || tt('排队失败，请重试');
  return false;
}

// 兼容旧接线名（ClaudePage 兜底轮询 / SnapPage 镜像轮询 / 回前台对账）——全部等价于 requestSync。
export function mirrorActiveTurn() { requestSync('mirror'); }
export async function reconcileSession() { requestSync('reconcile'); }

export async function restoreOnBoot() {
  let a = null;
  try { a = await probeActive(); } catch {}
  const saved = storeGet(LAST_KEY);
  const runs = runsOf(a).filter((r) => r.sessionId);
  // 上次看的会话正在跑（含胶囊轮——属于"回到原处"）→ 挂直播。
  const savedRun = saved ? runs.find((r) => r.sessionId === saved) : null;
  if (savedRun) { await openRun(savedRun); return; }
  // 否则回到上次看的会话；别的会话正在跑也不挂过去（11-09：不再自动跳到「最新在跑的一轮」）。
  if (saved) {
    await loadSession(saved);
    requestSync('boot');   // 摆出来的是缓存/transcript（未确认）：开机探活那一下可能早于它落定，再核对一次
  }
}
