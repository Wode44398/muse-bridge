// Routines: scheduled, unattended runs. This is the loop + executor; persistence +
// next-run math live in routines.mjs.
//
// Claude 引擎：到点在服务端【重放一条 /api/chat】（claude-queue.replayChat，与排队消息、限额续跑、PR 叫醒同一个口），
// 身份 = 任务主人（ctx.key 当重放标记）。所以定时任务的一次运行就是一个普通会话的一轮：
//   · 工作文件夹 / worktree / 起点分支 / 权限模式 / 模型 / 思考强度 / Fast 全走聊天路由的现成逻辑（项目归属、路径授权、
//     沙箱围栏、额度与并发上限、号池换号、限额续跑都不另写一套）；
//   · 跑的时候侧栏里能看到它在跑、点进去看直播、按停止；权限模式要人批的工具会停下来等（会话亮「待回答」，
//     官方 Desktop「A scheduled task is waiting for you」同语义），批了接着跑；
//   · 新会话的 id 事先定好（family.newSessionId），会话列表一出现就标着「定时任务」；
//   · 一轮的结局经 family.onEnd 交回来（claude.mjs retireTurn），记进这条任务的运行记录。
// 重放挂的 family origin 'routine' 是对象属性、客户端伪造不了；它让这一轮算「没人在场」（不替用户开会话）、
// 系统提示末尾追加无人值守说明、不顶掉同会话正在跑的轮（noPreempt：「接着上次的会话」撞上你正在用它就跳过这次）。
//
// dimensio 引擎（11-14）：到点经 dimensio 扩展导出的 familyCall（会话协作同一条通道：带进程内令牌直连【任务属主自己的】
// harness 实例——管理员 → 主实例，成员 → 他的租户实例，按 ctx.key 选；没起来就拉起，x-dimensio-family-call 头只有 bridge 服务端
// 发得出）调 harness 的 /api/family/routine：开一个新会话（或续上次那个）起一轮，回 { id, runId }；再用 routine-status 长轮询等结局。
//   · 任务的厂商 / 型号 / 思考深度 / 运行档位 / 工作文件夹交给 dimensio，按它设置页同一套规则校验（成员实例的工作区锁在他自己的
//     文件夹里、全权档不收）；认不了就记进这次运行的结果；
//   · 要人批的卡照常停下来等（会话亮「待处理」，GET /api/routines 的 live.waiting 跟着走）；跑完的通知、失败记录与 Claude 一致；
//   · 运行记录带 agent:'dimensio'，界面据此跳到 dimensio 页的那个会话。
//
// Gemini 引擎 2026-11-04 随 Gemini 对话下线，残留任务在 routines.mjs 读的时候就停用了（不删）。
//
// Multi-user: the scheduler iterates admin + every account user, each with its own routines.json.

import { emitBridgeEvent, ownerOf as eventOwner } from '../plugins/events.mjs';
import { randomUUID } from 'node:crypto';
import * as routines from '../routines.mjs';
import { markRoutineSession, findGenBySession } from './gen.mjs';
import { billingUser, quotaBlock } from './quota.mjs';
import { contextFor, userIdentity, REPLAY_AS_HEADER } from './identity.mjs';
import { replayChat } from './claude-queue.mjs';
import { sessionQuestions } from './questions.mjs';
import { busPublish } from './bus.mjs';
import { postNotice } from './notices.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import { FEATURES } from '../config/index.mjs';
import { getModule } from '../modules/registry.mjs';
import * as users from '../users.mjs';

const ROUTINE_NUDGE = '\n\n【运行环境：这是一个定时自动触发的任务，无人值守、当前没有用户在线实时查看或作答。请完整、自主地把任务做完；需要决策时按最合理的默认判断推进，不要中途停下来提问等待。做完后用简洁要点给出结果，方便用户事后在历史里回看。】';
const START_GRACE_MS = 3000;   // 重放的响应流收了、却一直没等到这一轮开跑：多等这么久再判「没能开跑」

export const routineRunning = new Set(); // routine ids currently executing — guard against overlap (ids are UUIDs, globally unique)
const live = new Map();                  // routine id → { sessionId, runId }：GET /api/routines 据此报「在跑哪个会话 / 在不在等你」

// admin + every account user — each owns a routines.json under its own data dir.
// 用户身份从账号库现拼（userIdentity）：带上档位与按人授权。以前只传名字，普通档（无命令行）
// 的定时任务被当成 Pro 跑、带着 shell；停用的账号也照跑不误。多用户关着时只跑服务账号的。
function ownerContexts() {
  const ctxs = [contextFor({ kind: 'admin' })];
  for (const u of users.listUsers()) {
    if (u.disabled || (!FEATURES.multiUser && !u.service)) continue;
    const id = userIdentity(u.name);
    if (id) ctxs.push(contextFor(id));
  }
  return ctxs;
}

// —— dimensio：经扩展的 familyCall 直连属主自己的 harness 实例（测试用 _setRoutineDimCall 顶替这一层）——
let dimCallOverride = null;
export function _setRoutineDimCall(fn) { dimCallOverride = fn; }
const familyCallFn = () => (dimCallOverride || getModule('dimensio')?.familyCall);
/** 这个身份能不能用 dimensio 跑定时任务：按人授权（ctx.allowDimensio 已含全局开关）+ dimensio 扩展装着、导出了 familyCall。 */
export function dimensioRoutineOk(ctx) {
  return !!(ctx && ctx.allowDimensio) && typeof familyCallFn() === 'function';
}
const dimCall = (ctx, op, body, timeoutMs) => {
  const call = familyCallFn();
  if (typeof call !== 'function') return Promise.reject(new Error('dimensio 扩展没装或没启用'));
  return call(ctx, op, body, timeoutMs);
};
const DIM_START_MS = 90_000;     // 开会话：harness 没起来先拉起（最多二十来秒），新会话还要对一遍 MCP 连接器
const DIM_WAIT_MS = 20_000;      // routine-status 长轮询：dimensio 那边在跑就最多等这么久再答
const DIM_MISS_MAX = 30;         // 连着这么多次问不到（dimensio 在重启 / 卡住）才放弃：约 10 分钟以上
let dimRetryMs = 20_000;         // 问不到时隔多久再问
export function _setRoutineDimTiming({ retryMs } = {}) { if (retryMs != null) dimRetryMs = retryMs; }

// 这条定时任务用的 agent 此刻对它的主人还开着吗（全局开关 + 按人授权）。
const routineAllowed = (ctx, r) => (r.agent === 'dimensio' ? dimensioRoutineOk(ctx) : ctx.allowClaude);

/** 正在跑的那几条：{ [routineId]: { sessionId, waiting, agent? } }（waiting = 会话停在审批卡 / 提问上等你）。 */
export function liveRoutines(ids) {
  const out = {};
  for (const id of ids) {
    const l = live.get(id);
    if (!l) continue;
    // dimensio 的「在等人」由长轮询带回来（l.waiting）；Claude 的看提问 / 审批台账
    const waiting = l.agent === 'dimensio' ? !!l.waiting : !!(l.sessionId && sessionQuestions.has(l.sessionId));
    out[id] = { sessionId: l.sessionId || null, waiting, ...(l.agent === 'dimensio' ? { agent: 'dimensio' } : {}) };
  }
  return out;
}

const clipPreview = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * 跑一次。trigger = 'schedule'（到点）| 'manual'（立即运行）。
 * 跳过与拦下（上一次还在跑、引擎没权限、额度用完）也记一条运行记录，界面上看得到为什么这次没跑。
 */
export async function runRoutine(ctx, id, trigger = 'manual') {
  const r = routines.get(ctx.dataDir, id);
  if (!r) return;
  if (routineRunning.has(id)) {
    routines.startRun(ctx.dataDir, id, { trigger, status: 'skipped', preview: '上一次运行还没结束，这次跳过。', endedAt: Date.now() });
    return;
  }
  if (r.agent === 'vertex') {   // 残留的 Gemini 引擎任务（立即运行也拦下）
    routines.startRun(ctx.dataDir, id, { trigger, status: 'error', preview: routines.GEMINI_ROUTINE_NOTE, endedAt: Date.now() });
    return;
  }
  const dim = r.agent === 'dimensio';
  if (!routineAllowed(ctx, r)) {
    const why = dim ? 'dimensio 未启用或没有权限，这次没有运行。' : 'Claude 未启用或没有权限，这次没有运行。';
    routines.startRun(ctx.dataDir, id, { trigger, status: 'error', preview: why, endedAt: Date.now(), ...(dim ? { agent: 'dimensio' } : {}) });
    return;
  }
  // 额度（开源路线 S2-6）：先看一眼，用完了就记一条说清楚。记账在聊天路由里（与聊天同一道闸）。管理员不限。
  // dimensio 的对话不记这本账（反代也不拦），它的定时任务同样不拦。
  const billTo = dim ? null : billingUser(ctx);
  if (billTo) {
    const block = quotaBlock(billTo);
    if (block) {
      routines.startRun(ctx.dataDir, id, { trigger, status: 'error', preview: block.title + '：' + block.message + '这次没有运行。', endedAt: Date.now() });
      return;
    }
  }
  routineRunning.add(id);
  const run = routines.startRun(ctx.dataDir, id, { trigger, ...(dim ? { agent: 'dimensio' } : {}) });
  live.set(id, { sessionId: null, runId: run && run.id, ...(dim ? { agent: 'dimensio', waiting: false } : {}) });
  const onSession = (sid) => {
    const l = live.get(id); if (l) l.sessionId = sid;
    if (run) routines.patchRun(ctx.dataDir, id, run.id, { sessionId: sid });
    busPublish(ctx.key, { type: 'routine', id, state: 'start', sessionId: sid, ...(dim ? { agent: 'dimensio' } : {}) });
  };
  // dimensio 的会话停在审批卡 / 提问上等人（或等完了接着跑）：界面的「等你处理」跟着变
  const onWaiting = (w) => {
    const l = live.get(id);
    if (!l || l.waiting === w) return;
    l.waiting = w;
    busPublish(ctx.key, { type: 'routine', id, state: w ? 'waiting' : 'start', sessionId: l.sessionId, agent: 'dimensio' });
  };
  let out = { sessionId: null, text: '', isError: false, stopped: false, skipped: false, cost: 0 };
  try {
    out = { ...out, ...(await (dim ? runDimensioRoutine(ctx, r, onSession, onWaiting) : runClaudeRoutine(ctx, r, onSession))) };
  } catch (err) {
    out = { ...out, text: String((err && err.message) || err), isError: true };
  } finally {
    routineRunning.delete(id);
    live.delete(id);
    const status = out.skipped ? 'skipped' : out.stopped ? 'stopped' : out.isError ? 'error' : 'ok';
    const preview = clipPreview(out.text);
    if (run) routines.patchRun(ctx.dataDir, id, run.id, { status, endedAt: Date.now(), ...(out.sessionId ? { sessionId: out.sessionId } : {}), preview, ...(out.cost ? { cost: out.cost } : {}) });
    // 「接着上次的会话」：记住这次的会话，下次续它（这期间任务被改成了另一个引擎，就别把这个会话记成那边的）
    const cur = routines.get(ctx.dataDir, id);
    if (cur && cur.sessionMode === 'continue' && out.sessionId && (cur.agent === 'dimensio') === dim) routines.update(ctx.dataDir, id, { threadSessionId: out.sessionId });
    busPublish(ctx.key, { type: 'routine', id, state: 'end', status, name: r.name, notify: !!(cur && cur.notify), sessionId: out.sessionId || null, preview: preview.slice(0, 120), ...(dim ? { agent: 'dimensio' } : {}) });
    // 会话消息通知（notices.mjs）：开了「通知我」的任务按会话单独一条（手机后台服务 / 网页横幅都读它）；被停掉 / 跳过的不报。
    // dimensio 的会话不带会话 id：通知的点开目标按 Claude 会话打开（手机原生通知也是），带了会打开一个不存在的 Claude 会话——
    // 不带就落到定时任务页，运行记录里再点进 dimensio 的那个会话
    if (cur && cur.notify && (status === 'ok' || status === 'error')) {
      try { postNotice(ctx.key, { kind: status === 'ok' ? 'done' : 'error', sub: 'routine', sessionId: dim ? null : (out.sessionId || null), title: r.name || '', body: preview.slice(0, 200) }); } catch {}
    }
    // 插件订阅的 routine.run（plugins/events.mjs）
    emitBridgeEvent('routine.run', { id, name: r.name || '', agent: r.agent || 'claude', owner: eventOwner(ctx), ok: status === 'ok', status, trigger, sessionId: out.sessionId || null, preview: preview.slice(0, 500) });
    console.log(`[routine] "${r.name}" (${ctx.user || 'admin'}) [${r.agent || 'claude'}] ${trigger} -> ${status}${out.sessionId ? ' (' + out.sessionId + ')' : ''}`);
  }
}

// Claude 引擎：重放一条 /api/chat（见文件头）。返回 { sessionId, text, isError, stopped, skipped, cost }。
async function runClaudeRoutine(ctx, r, onSession) {
  const cont = r.sessionMode === 'continue' && r.threadSessionId ? r.threadSessionId : null;
  // 工作文件夹：按路径登记 / 找到对应的项目（createProject 同路径幂等、过一遍路径授权）。续会话时 cwd 由会话自己定。
  let projectId = '';
  if (!cont && r.cwd) {
    try { projectId = claudeProjects.createProject(ctx.claudeProjects, ctx, { path: r.cwd }).id; }
    catch (e) { return { sessionId: null, text: '工作文件夹不可用：' + ((e && e.message) || e) + '。请编辑任务换一个文件夹。', isError: true }; }
  }
  const sid = cont || randomUUID();
  markRoutineSession(sid);
  let resolveEnd;
  const ended = new Promise((res) => { resolveEnd = res; });
  let began = false;
  const family = {
    origin: { kind: 'routine', from: [] },
    noPreempt: true,
    nudge: ROUTINE_NUDGE,
    ...(cont ? {} : { newSessionId: sid }),
    onStart: () => { began = true; onSession(sid); },
    onEnd: (gen) => resolveEnd(gen),
  };
  const body = {
    agent: 'claude', client: 'web',
    message: r.prompt || '（这条任务没有写指令）', attachments: [],
    ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}), ...(r.fast ? { fast: true } : {}),
    ...(cont ? { sessionId: cont } : {
      ...(projectId ? { claudeProjectId: projectId } : {}),
      ...(r.worktree ? { worktree: true, ...(r.branch ? { worktreeFrom: r.branch } : {}) } : {}),
      ...(r.permissionMode ? { permissionMode: r.permissionMode } : {}),
      ...(r.shape === 'project' ? { shape: 'project' } : {}),   // 以项目对话运行（续会话按会话自己记的形态）
    }),
    autoRetry: true,
  };
  let rr;
  try {
    rr = await replayChat({ headers: { [REPLAY_AS_HEADER]: ctx.key, 'user-agent': 'bridge-routine' }, url: '/api/chat', body, family });
  } catch (e) { return { sessionId: cont, text: String((e && e.message) || e), isError: true }; }
  if (!rr || !rr.status || rr.status >= 400) {
    let reason = `没能开跑（状态 ${rr && rr.status || '未知'}）`;
    try { const j = JSON.parse((rr && rr.detail) || '{}'); if (j.error) reason = j.error; } catch {}
    return { sessionId: cont, text: reason, isError: true };
  }
  // 等这一轮收尾。响应流收了却没开跑 = 开跑前就被拦下（并发满、会话被占……）：错误帧在流的前几块里。
  const res = rr.res;
  const streamDone = new Promise((resolve) => { if (!res || res.writableEnded) resolve(); else res.on('close', resolve); });
  let gen = await Promise.race([ended, streamDone.then(() => new Promise((x) => setTimeout(() => x(null), START_GRACE_MS)))]);
  if (!gen && began) gen = await ended;
  if (!gen) {
    const txt = ((res && res.chunks) || []).join('');
    const m = txt.match(/"message":"([^"]{1,300})"/) || txt.match(/"title":"([^"]{1,120})"/);
    const busy = /"kind":"busy"/.test(txt);
    // 「接着上次的会话」撞上那个会话正在跑（你正在用它）：不顶掉，这次跳过
    if (busy && cont && findGenBySession(ctx.key, cont)) return { sessionId: cont, text: '接着用的那个会话正在进行中，这次没有打断它。', skipped: true };
    return { sessionId: cont, text: m ? m[1] : '没能开跑', isError: true };
  }
  const ev = gen.events || [];
  const last = (t) => { for (let i = ev.length - 1; i >= 0; i--) if (ev[i] && ev[i].type === t) return ev[i]; return null; };
  const done = last('done'), error = last('error'), stopped = last('interrupted');
  return {
    sessionId: gen.sessionId || sid,
    text: String((done && done.result) || (error && (error.message || error.title)) || (stopped ? '已停止' : '')),
    isError: !stopped && ((error && !done) || !!(done && done.isError)),
    stopped: !!stopped,
    cost: (done && Number(done.cost)) || 0,
  };
}

// dimensio 引擎（见文件头）：开 / 续会话起一轮，长轮询等结局。返回 { sessionId, text, isError, stopped, skipped }。
async function runDimensioRoutine(ctx, r, onSession, onWaiting) {
  let cont = r.sessionMode === 'continue' && r.threadSessionId ? r.threadSessionId : null;
  const config = {
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.provider && r.model ? { model: r.model } : {}),
    ...(r.effort ? { thinking: r.effort } : {}),
    ...(r.permissionMode ? { permissionMode: r.permissionMode } : {}),
    ...(r.cwd && !cont ? { workspace: r.cwd } : {}),   // 续会话时工作区由会话自己定
  };
  const start = (sessionId, cfg) => dimCall(ctx, 'routine', { ...(sessionId ? { sessionId } : {}), title: r.name || '', prompt: r.prompt || '（这条任务没有写指令）', config: cfg }, DIM_START_MS);
  let st;
  try {
    st = await start(cont, config);
    // 接着用的那个会话被删了：这次改开一个新会话（跑完记成新的「接着用」），工作区按任务里选的
    if (st && st.ok === false && st.code === 'gone' && cont) {
      cont = null;
      st = await start(null, r.cwd ? { ...config, workspace: r.cwd } : config);
    }
  } catch (e) { return { sessionId: cont, text: 'dimensio 没能开跑：' + ((e && e.message) || e), isError: true }; }
  if (!st || st.ok !== true || !st.id || !st.runId) {
    // 「接着上次的会话」撞上那个会话正在跑（你正在用它）：不顶掉，这次跳过（同 Claude）
    if (st && st.code === 'busy' && cont) return { sessionId: cont, text: '接着用的那个会话正在进行中，这次没有打断它。', skipped: true };
    const why = (st && st.error) || 'dimensio 没开成';
    return { sessionId: cont, text: st && st.code === 'config' ? `dimensio 不认这条任务的设置：${why}。请编辑任务重新选型号 / 档位 / 文件夹。` : why, isError: true };
  }
  const sid = String(st.id), runId = String(st.runId);
  onSession(sid);
  // 等结局：dimensio 那边在跑就挂着最多 DIM_WAIT_MS 再答；问不到（重启、卡住）隔一会儿再问，连着问不到太多次才放弃
  let misses = 0, lastErr = '';
  for (;;) {
    let s = null;
    try { s = await dimCall(ctx, 'routine-status', { id: sid, runId, waitMs: DIM_WAIT_MS }, DIM_WAIT_MS + 15_000); }
    catch (e) { lastErr = String((e && e.message) || e); }
    if (s && s.ok === true) {
      misses = 0;
      if (s.running) { onWaiting(!!s.waiting); continue; }
      onWaiting(false);
      const text = String(s.text || '');
      if (s.outcome === 'done') return { sessionId: sid, text };
      if (s.outcome === 'aborted') {
        return { sessionId: sid, stopped: true, text: s.by === 'restart' ? 'dimensio 重启，这次运行被中断；重启后它会自动接着做，点进会话看。' : (text || '已停止') };
      }
      if (s.outcome === 'unknown') return { sessionId: sid, stopped: true, text: 'dimensio 中途重启过，这次运行的结局没记下；会话可能已由重启续跑做完，点进去看。' };
      return { sessionId: sid, text: text || 'dimensio 这一轮出错了', isError: true };
    }
    if (s && s.ok === false && s.code === 'gone') return { sessionId: sid, text: 'dimensio 里的这个会话已经不在了。', isError: true };
    if (s && s.ok === false) lastErr = s.error || lastErr;
    if (++misses >= DIM_MISS_MAX) return { sessionId: sid, text: `一直问不到 dimensio 这次运行的结果（${lastErr || '没有回应'}），不再等了；点进会话看它跑到哪了。`, isError: true };
    await new Promise((res) => setTimeout(res, dimRetryMs));
  }
}

export function tickRoutines() {
  const now = Date.now();
  for (const ctx of ownerContexts()) {
    for (const r of routines.due(ctx.dataDir, now)) {
      // Advance the next fire BEFORE running so a long run can't get re-fired.
      routines.update(ctx.dataDir, r.id, { nextRun: routines.computeNextRun(r.schedule, now) });
      runRoutine(ctx, r.id, 'schedule');   // 上一次还在跑：runRoutine 记一条「跳过」
    }
  }
}

// On startup, don't fire a backlog: any fire missed while down is skipped forward.
// 跳过的那次不静默丢掉：记下它的计划时刻（missedAt），定时任务页在它晚于上次运行时标「已错过」。
// 上一条命里没跑完的运行（服务重启时还在 running）收成「中断」——会话本身可能由重启续跑接着做完，点进去看。
export function reconcileRoutines() {
  const now = Date.now();
  for (const ctx of ownerContexts()) {
    for (const r of routines.list(ctx.dataDir)) {
      if (r.enabled && r.nextRun && r.nextRun <= now) {
        routines.update(ctx.dataDir, r.id, { nextRun: routines.computeNextRun(r.schedule, now), missedAt: r.nextRun });
      }
      for (const run of (r.runs || []).filter((x) => x.status === 'running')) {
        routines.patchRun(ctx.dataDir, r.id, run.id, { status: 'stopped', endedAt: now, preview: run.preview || '服务重启，这次运行被中断。' });
      }
      if (r.lastStatus === 'running' && !(r.runs || []).length) routines.update(ctx.dataDir, r.id, { lastStatus: 'error', lastPreview: '服务重启，这次运行被中断。' });
    }
  }
}

// Only the always-on production server should call this — the desktop debug
// instance (BRIDGE_NO_AUTH, loopback-only) must not double-fire routines.
export function startRoutineScheduler() {
  reconcileRoutines();
  return setInterval(tickRoutines, 30000);
}
