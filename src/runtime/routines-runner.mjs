// Routines: scheduled, unattended Claude runs. A routine fires its prompt with NO
// connected client; the resulting session lands in the OWNER's projects dir (admin
// -> ~/.claude; user -> their .bridge/claude) and shows up in their conversation
// list, tagged "路由". This is the loop + headless executor; persistence + next-run
// math live in routines.mjs.
//
// Multi-user: the scheduler iterates admin + every account user, each with its own
// routines.json. A user's routine runs INSIDE that user's sandbox (their cwd, their
// CLAUDE_CONFIG_DIR, their media MCP, the path guard) — same isolation as
// their interactive chat, applied to unattended runs.

import * as routines from '../routines.mjs';
import { markRoutineSession } from './gen.mjs';
import { holdKeepAwake } from './keep-awake.mjs';   // 定时任务不登记 gen 台账：Claude 引擎跑的时候另计「在跑」，保持唤醒照样生效
import { moduleRoutine } from '../modules/registry.mjs';
import { billingUser, quotaBlock } from './quota.mjs';
import { contextFor, userIdentity } from './identity.mjs';
import { FEATURES } from '../config/index.mjs';
import * as users from '../users.mjs';
import { runHeadlessTurn } from './headless-turn.mjs';

const ROUTINE_NUDGE = '\n\n【运行环境：这是一个定时自动触发的「路由」任务，无人值守、当前没有用户在线实时查看或作答。请完整、自主地把任务做完；需要决策时按最合理的默认判断推进，不要中途停下来提问等待。做完后用简洁要点给出结果，方便用户事后在历史里回看。】';

export const routineRunning = new Set(); // routine ids currently executing — guard against overlap (ids are UUIDs, globally unique)

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

// 这条定时任务用的 agent 此刻对它的主人还开着吗（全局开关 + 按人授权）。
const routineAllowed = (ctx, r) => (r.agent === 'vertex' ? ctx.allowGemini : ctx.allowClaude);

export async function runRoutine(ctx, id) {
  const r = routines.get(ctx.dataDir, id);
  if (!r || routineRunning.has(id)) return;
  if (!routineAllowed(ctx, r)) {
    routines.update(ctx.dataDir, id, { lastRun: Date.now(), lastStatus: 'error', lastPreview: (r.agent === 'vertex' ? 'Gemini' : 'Claude') + ' 未启用或没有权限，这次没有运行。' });
    return;
  }
  // 额度（开源路线 S2-6）：定时任务与「立即运行」和聊天走同一道闸，一次运行算一轮、开跑即记。管理员不限。
  const billTo = billingUser(ctx);
  if (billTo) {
    const block = quotaBlock(billTo);
    if (block) {
      routines.update(ctx.dataDir, id, { lastRun: Date.now(), lastStatus: 'error', lastPreview: block.title + '：' + block.message + '这次没有运行。' });
      return;
    }
    try { users.noteTurnStart(billTo); } catch {}
  }
  routineRunning.add(id);
  routines.update(ctx.dataDir, id, { lastRun: Date.now(), lastStatus: 'running' });
  let out = { sessionId: null, text: '', isError: false };
  const unhold = r.agent === 'vertex' ? null : holdKeepAwake();
  try {
    out = (r.agent === 'vertex') ? await runModuleRoutine(ctx, r) : await runClaudeRoutine(ctx, r);
  } catch (err) {
    out = { sessionId: out.sessionId, text: String((err && err.message) || err), isError: true };
  } finally {
    if (unhold) unhold();
    routineRunning.delete(id);
    routines.update(ctx.dataDir, id, {
      lastStatus: out.isError ? 'error' : 'ok',
      lastSessionId: out.sessionId,
      lastPreview: (out.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    });
    console.log(`[routine] "${r.name}" (${ctx.user || 'admin'}) [${r.agent || 'claude'}] -> ${out.isError ? 'error' : 'ok'}${out.sessionId ? ' (' + out.sessionId + ')' : ''}`);
  }
}

// Claude engine (default): headless query() inside the owner's sandbox, with the
// routine's chosen model/effort (null -> server default). 执行器与插件代跑共用（runtime/headless-turn.mjs）。
// 每条路由都是新会话；撞额度墙换号后的整条重跑也在执行器里。
async function runClaudeRoutine(ctx, r) {
  const out = await runHeadlessTurn(ctx, {
    prompt: r.prompt || '（这条路由没有写 prompt）',
    model: r.model || null,
    effort: r.effort,
    append: ROUTINE_NUDGE,
    turn: { kind: 'routine' },
    source: 'routine',
    label: 'routine "' + r.name + '"',
    onInit: (sid) => markRoutineSession(sid),
  });
  return { sessionId: out.sessionId, text: out.text, isError: out.isError };
}

// 非 Claude 引擎（目前只有 Gemini）由所属功能扩展提供；扩展没装时 routineAllowed 已先拦下，这里兜底。
async function runModuleRoutine(ctx, r) {
  const engine = moduleRoutine(r.agent);
  if (!engine) return { sessionId: null, text: '「' + r.agent + '」引擎所属的功能扩展没装，这次没有运行。', isError: true };
  return engine(ctx, r);
}

export function tickRoutines() {
  const now = Date.now();
  for (const ctx of ownerContexts()) {
    for (const r of routines.due(ctx.dataDir, now)) {
      if (routineRunning.has(r.id)) continue;
      // Advance the next fire BEFORE running so a long run can't get re-fired.
      routines.update(ctx.dataDir, r.id, { nextRun: routines.computeNextRun(r.schedule, now) });
      runRoutine(ctx, r.id);
    }
  }
}

// On startup, don't fire a backlog: any fire missed while down is skipped forward.
// 跳过的那次不静默丢掉：记下它的计划时刻（missedAt），定时任务页在它晚于上次运行时标「已错过」。
export function reconcileRoutines() {
  const now = Date.now();
  for (const ctx of ownerContexts()) {
    for (const r of routines.list(ctx.dataDir)) {
      if (r.enabled && r.nextRun && r.nextRun <= now) {
        routines.update(ctx.dataDir, r.id, { nextRun: routines.computeNextRun(r.schedule, now), missedAt: r.nextRun });
      }
    }
  }
}

// Only the always-on production server should call this — the desktop debug
// instance (BRIDGE_NO_AUTH, loopback-only) must not double-fire routines.
export function startRoutineScheduler() {
  reconcileRoutines();
  return setInterval(tickRoutines, 30000);
}
