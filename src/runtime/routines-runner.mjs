// Routines: scheduled, unattended Claude runs. A routine fires its prompt with NO
// connected client; the resulting session lands in the OWNER's projects dir (admin
// -> ~/.claude; user -> their .bridge/claude) and shows up in their conversation
// list, tagged "路由". This is the loop + headless executor; persistence + next-run
// math live in routines.mjs.
//
// Multi-user: the scheduler iterates admin + every account user, each with its own
// routines.json. A user's routine runs INSIDE that user's sandbox (their cwd, their
// CLAUDE_CONFIG_DIR, the path guard) — same isolation as their interactive chat,
// applied to unattended runs.

import { query } from '@anthropic-ai/claude-agent-sdk';
import * as routines from '../routines.mjs';
import { markBridgeSession, markRoutineSession } from './gen.mjs';
import { applyRateLimit, applyContext } from './status.mjs';
import { hostNudge, USER_NUDGE, REGULAR_NUDGE, NO_SHELL_MSG, sandboxViolation, identityNudge, makeSandboxPreToolUse, SHELL_DENY, makeTurnInput, isPhantomResult } from '../agents/claude.mjs';
import { UPLOADS, MEDIA, MODEL } from '../config/index.mjs';
import { to1M, claudeEffortOptions } from '../config/capabilities.mjs';
import { contextFor, userIdentity } from './identity.mjs';
import { FEATURES } from '../config/index.mjs';
import { claudeEngineEnv } from './claude-account.mjs';
import { claudeExtensionOptions } from '../extensions.mjs';
import { addUsage } from '../users.mjs';
import * as users from '../users.mjs';

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

// 定时任务只跑 Claude：它此刻对任务的主人还开着吗（全局开关 + 按人授权）。
const routineAllowed = (ctx, r) => (r.agent || 'claude') === 'claude' && ctx.allowClaude;

export async function runRoutine(ctx, id) {
  const r = routines.get(ctx.dataDir, id);
  if (!r || routineRunning.has(id)) return;
  if (!routineAllowed(ctx, r)) {
    routines.update(ctx.dataDir, id, { lastRun: Date.now(), lastStatus: 'error', lastPreview: (r.agent && r.agent !== 'claude' ? '这条定时任务用的引擎已不再支持' : 'Claude 未启用或没有权限') + '，这次没有运行。' });
    return;
  }
  routineRunning.add(id);
  routines.update(ctx.dataDir, id, { lastRun: Date.now(), lastStatus: 'running' });
  let out = { sessionId: null, text: '', isError: false };
  try {
    out = await runClaudeRoutine(ctx, r);
  } catch (err) {
    out = { sessionId: out.sessionId, text: String((err && err.message) || err), isError: true };
  } finally {
    routineRunning.delete(id);
    routines.update(ctx.dataDir, id, {
      lastStatus: out.isError ? 'error' : 'ok',
      lastSessionId: out.sessionId,
      lastPreview: (out.text || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    });
    console.log(`[routine] "${r.name}" (${ctx.user || 'admin'}) [${r.agent || 'claude'}] -> ${out.isError ? 'error' : 'ok'}${out.sessionId ? ' (' + out.sessionId + ')' : ''}`);
  }
}

// Claude engine: headless query() inside the owner's sandbox, with the
// routine's chosen model/effort (null -> server default).
async function runClaudeRoutine(ctx, r) {
  const abort = new AbortController();
  let sessionId = null, text = '', isError = false;
  // 扩展中心与主聊天同源注入（admin 非沙箱）：定时任务也吃托管技能/插件/连接器。
  const ext = ctx.sandbox ? { plugins: [], mcpServers: {} } : claudeExtensionOptions();
  // 恒流式输入 + gate 挂流（同主聊天，见 agents/claude.mjs makeTurnInput 注释）：
  // 字符串 prompt 会让 SDK 在 result 后自动关 stdin，后台子任务被杀、续轮通知丢失。
  const turnInput = makeTurnInput(r.prompt || '（这条路由没有写 prompt）', []);
  // effort 经 claudeEffortOptions 翻译（ultracode → xhigh + settings）：routes/routines.mjs 保存时已拒绝
  // ultracode，这里是旧数据 / 手改文件的兜底，别把 SDK 不认的档名原样塞进 query。
  const effortOpts = claudeEffortOptions(r.effort);
  const notes = [];   // model_* 系统帧（安全栅门切换等）的官方文案——无人值守没有 UI，记进结果预览
  const q = query({
    prompt: turnInput.stream,
    options: {
      cwd: ctx.cwd,
      additionalDirectories: ctx.sandbox ? [] : [UPLOADS, MEDIA],
      mcpServers: ctx.sandbox ? {} : { ...ext.mcpServers },
      ...(ext.plugins.length ? { plugins: ext.plugins } : {}),
      // snapshot:false 同 claude.mjs：SDK 0.3.267 起默认首轮录制复用，换模型后的身份 nudge 会被冻住。
      systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false, append: identityNudge(r.model || MODEL) + (ctx.sandbox ? (USER_NUDGE + (ctx.shell ? '' : REGULAR_NUDGE)) : hostNudge()) + ROUTINE_NUDGE },
      ...((() => { const e = claudeEngineEnv(ctx); return e ? { env: e } : {}; })()),
      ...((r.model || MODEL) ? { model: to1M(r.model || MODEL) } : {}),
      ...(effortOpts.effort ? { effort: effortOpts.effort } : {}),
      ...(effortOpts.settings ? { settings: JSON.stringify(effortOpts.settings) } : {}),
      // 沙箱用户的定时路由同样套硬边界（PreToolUse hook 含只读 + 无 shell disallow + 设置隔离）。
      ...(ctx.sandbox ? {
        hooks: { PreToolUse: [{ hooks: [makeSandboxPreToolUse(ctx)] }] },
        settingSources: [],
        ...(!ctx.shell ? { disallowedTools: SHELL_DENY } : {}),
      } : {}),
      includePartialMessages: false,
      abortController: abort,
      canUseTool: async (name, input) => {
        if (name === 'AskUserQuestion') {
          return { behavior: 'deny', message: '（这是无人值守的定时路由，没有用户在线作答。请基于已有信息用最合理的判断继续完成任务，不要提问。）' };
        }
        if (ctx.sandbox) {
          if (!ctx.shell && (name === 'Bash' || name === 'PowerShell')) return { behavior: 'deny', message: NO_SHELL_MSG };
          const v = sandboxViolation(name, input, ctx.cwd); if (v) return { behavior: 'deny', message: v };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });
  let lastMainUsage = null; // main conversation's last API call usage (real context fill)
  // 后台任务悬停收轮（与主聊天同一机制、同一策略，见 agents/claude.mjs）：result 出来时只要还有
  // 【非 ambient】的后台任务在跑就不收——等 CLI 注入 task-notification 自动续轮，最终 result 覆盖 text。
  // 09-15 起后台 shell（local_bash）同样悬停：不悬停 = CLI 收尾时把它杀掉（探针实测 ~8s），
  // 无人值守的路由「起个后台批处理再等通知」会静默半途而废。常驻服务用封顶兜。
  const AGENTISH = new Set(['local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow']);
  const BG_SHELL_HOLD_MS = Math.max(60_000, Number(process.env.BRIDGE_BG_HOLD_MS) || 60 * 60_000);
  let bgTasks = [];
  let held = false;          // 出过 result 但后台任务未清
  let lastMsgAt = Date.now();
  const shellSeenAt = new Map();   // 后台 shell 逐条封顶计时（09-23，同 claude.mjs）
  const cutShells = new Set();     // 到点已 stopTask 的 shell，不再算存活
  const liveBgTasks = () => bgTasks.filter((t) => t && t.task_id && !t.ambient && !cutShells.has(t.task_id));
  // 悬停期兜底（与主聊天同口径）：全 agent 集合看 15 分钟静默（子 agent 每 ~30s 有 task_progress）；
  // 任务表清零却没等来续轮看 2 分钟；后台 shell 逐条封顶——还有 agent/workflow 在跑时只掐超时的
  // shell、不连带腰斩工作流，只剩 shell 时才 abort 收残局。已到手的 text 就是这条路由的结果。
  const bgWatch = setInterval(() => {
    if (!held) return;
    const now = Date.now();
    const live = liveBgTasks();
    const shells = live.filter((t) => !AGENTISH.has(t.task_type));
    for (const t of shells) if (!shellSeenAt.has(t.task_id)) shellSeenAt.set(t.task_id, now);
    const agentOnly = live.length > 0 && !shells.length;
    const quiet = now - lastMsgAt;
    const overdue = shells.filter((t) => now - shellSeenAt.get(t.task_id) > BG_SHELL_HOLD_MS);
    if (overdue.length && shells.length < live.length) {
      for (const t of overdue) {
        cutShells.add(t.task_id);
        console.log(`[routine] bg-hold shell cap — stopping ${t.task_id}, agents keep running`);
        q.stopTask(String(t.task_id)).catch(() => {});
      }
      return;
    }
    const over = (agentOnly && quiet > 15 * 60_000)
      || (!live.length && quiet > 2 * 60_000)
      || (overdue.length > 0);
    if (!over) return;
    console.log('[routine] bg-hold timeout — aborting leftovers');
    try { abort.abort(); } catch {}
  }, 15_000);
  if (bgWatch.unref) bgWatch.unref();
  try {
    for await (const msg of q) {
      lastMsgAt = Date.now();
      if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
        bgTasks = Array.isArray(msg.tasks) ? msg.tasks : [];
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id;
        markBridgeSession(sessionId);
        markRoutineSession(sessionId);
      } else if (msg.type === 'rate_limit_event') {
        applyRateLimit(msg.rate_limit_info);
      } else if (msg.type === 'system' && typeof msg.subtype === 'string' && msg.subtype.startsWith('model_')) {
        // 模型安全栅门 / 模型切换通知（SDK 宿主默认自动切换到回退模型重试）：这里没有 UI，只把官方文案
        // 记下来，结果预览前缀「⚠」让用户事后在历史里看得见这轮换过模型。子 agent 内的不记。
        if (!msg.parent_tool_use_id && msg.content) notes.push(String(msg.content));
      } else if (msg.type === 'assistant') {
        // Main turn's own last API call = real context fill; skip subagents (parent_tool_use_id).
        // The result's top-level usage is cumulative across the turn and overstates the window.
        if (!msg.parent_tool_use_id && msg.message && msg.message.usage) lastMainUsage = msg.message.usage;
      } else if (msg.type === 'result') {
        // 幻影 result（resume 时 CLI 替上一条命的孤儿后台任务补的那一轮，在真轮 init 之前）——
        // 与 agents/claude.mjs 同患同治：不是本轮定局，跳过等真 result。
        if (isPhantomResult(msg)) { console.log(`[routine] "${r.name}" phantom result before the real turn — ignored`); continue; }
        sessionId = msg.session_id;
        text = msg.result || '';
        isError = Boolean(msg.is_error) || (typeof msg.api_error_status === 'number' && msg.api_error_status >= 400);
        if (ctx.user) {
          const u = msg.usage || {};
          const toks = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          try { addUsage(ctx.user, { tokens: toks, costUsd: msg.total_cost_usd || 0 }); } catch {}
        }
        applyContext(msg.modelUsage, msg.session_id, lastMainUsage || msg.usage, ctx.key);
        // gate 挂着输入流，stream 不会自然结束——不悬停就由我们收轮。
        held = !isError && liveBgTasks().length > 0;
        if (held) { console.log(`[routine] "${r.name}" result with live background task(s) — holding`); }
        else break;
      }
    }
  } catch (err) {
    // 看门狗 abort / CLI 半途死掉：已有的 text 就是最好结果；从没出过 result 才算失败。
    if (!text) { isError = true; text = String((err && err.message) || err || ''); }
  } finally {
    clearInterval(bgWatch);
    turnInput.release();
  }
  if (notes.length) text = notes.map((n) => '⚠ ' + n).join('\n') + (text ? '\n\n' + text : '');
  return { sessionId, text, isError };
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
export function reconcileRoutines() {
  const now = Date.now();
  for (const ctx of ownerContexts()) {
    for (const r of routines.list(ctx.dataDir)) {
      if (r.enabled && r.nextRun && r.nextRun <= now) routines.update(ctx.dataDir, r.id, { nextRun: routines.computeNextRun(r.schedule, now) });
    }
  }
}

// Only the always-on production server should call this — the desktop debug
// instance (BRIDGE_NO_AUTH, loopback-only) must not double-fire routines.
export function startRoutineScheduler() {
  reconcileRoutines();
  return setInterval(tickRoutines, 30000);
}
