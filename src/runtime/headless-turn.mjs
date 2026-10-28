// 无头 Claude 执行器：没有前端连着、没人能点审批卡的一轮 Claude。定时任务（routines-runner.mjs）与
// 插件代跑（plugins/chat.mjs 的 ctx.chat）共用这一份，所以两者的沙箱、额度记账、号池路由、后台任务悬停口径永远一致。
//
// 与主聊天（agents/claude.mjs runClaudeChat）的区别：
//   · 不登记 gen 台账、不进 /api/chat 的单写者——不会顶掉这个身份正在前端进行的对话，也不会被它顶掉；
//   · 无人值守：AskUserQuestion 直接拒（让模型按默认判断推进）、不给 EnterPlanMode，其余工具按身份档位放行或拒绝
//     （沙箱身份过 sandboxFence / 无 shell 拒 Bash，与主聊天同一套），不会出现等 30 分钟的审批卡；
//   · 一轮跑完就收（后台任务悬停除外），不留常驻进程。
//
// 额度闸（quotaBlock / noteTurnStart）由调用方在开跑前判：定时任务和插件对「这次没跑」的交代方式不同。

import { pluginClaudeTurn } from '../plugins/claude-tools.mjs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeCliOptions } from './claude-cli.mjs';
import { markBridgeSession } from './gen.mjs';
import { applyRateLimit, applyContext } from './status.mjs';
import { moduleClaudeMcp } from '../modules/registry.mjs';
import { hostNudge, mediaNudge, USER_NUDGE, REGULAR_NUDGE, NO_SHELL_MSG, sandboxFence, identityNudge, makeSandboxPreToolUse, SHELL_DENY, makeTurnInput, isPhantomResult, composeTurnPrompt } from '../agents/claude.mjs';
import { UPLOADS, MEDIA, MODEL, VAULT } from '../config/index.mjs';
import { to1M, claudeEffortOptions, ULTRACODE } from '../config/capabilities.mjs';
import { billingUser, memberRules } from './quota.mjs';
import { makeCostMeter } from './usage-ledger.mjs';
import { noteTurnUsage } from './audit-log.mjs';
import { claudeEngineEnv, activeAccountId } from './claude-account.mjs';
import { routeBeforeQuery, noteLimitHit, reasonText } from './account-router.mjs';
import { isUpstreamEnv, lastServedAccount } from './claude-upstream.mjs';
import { claudeExtensionsFor, sharedExtensionDirs } from '../extensions.mjs';
import { memberClaudePlugins, memberSkillRootIfAny } from '../member-skills.mjs';
import { collectDeliverables, deliverAnywhere, deliverRoots } from './deliverables.mjs';
import { addUsage } from '../users.mjs';
import { PEER_OFF_ENV, PEER_OFF_SETTINGS } from './session-peers.mjs';   // 无人值守：跨会话通道关门

const UNATTENDED_DENY = '（这一轮是无人值守运行，没有用户在线作答。请基于已有信息用最合理的判断继续完成任务，不要提问。）';

/**
 * 跑一轮无头 Claude。
 * @param ctx  身份上下文（runtime/identity.mjs contextFor）
 * @param o    { prompt, attachments?: 绝对路径[], resume?: sessionId, model?, effort?, append?: 追加到系统提示末尾,
 *              turn?: { kind, plugin? }（给插件工具槽判断：'routine' / 'plugin'）, source?: 用量事件来源,
 *              label?: 日志名, signal?: AbortSignal, onInit?(sessionId), onEvent?(ev) }
 *   onEvent 的帧：{ type:'text', text }（主对话每条 assistant 文字）/ { type:'tool', name, input } / { type:'note', text }
 * @returns { sessionId, text, isError, files }  files = 最终回答里链接到的真实文件（同主聊天的产物附件卡）
 */
export async function runHeadlessTurn(ctx, o, attempt = 0) {
  const abort = new AbortController();
  const onExternalAbort = () => { try { abort.abort(); } catch {} };
  if (o.signal) { if (o.signal.aborted) onExternalAbort(); else o.signal.addEventListener('abort', onExternalAbort, { once: true }); }
  const emit = (ev) => { try { o.onEvent?.(ev); } catch {} };
  const label = o.label || 'headless';
  let sessionId = o.resume || null, text = '', isError = false;
  let rejection = null, apiStatus = null, produced = false;   // 撞额度墙判定（见文末 noteLimitHit）
  const runModelBase = o.model || MODEL;
  // 号池智能路由（可选，默认关）：激活号已知用尽就先换号再开跑。
  await routeBeforeQuery({ model: runModelBase });
  // 扩展中心与主聊天同源注入（管理员 = 自用 + 全服，注册用户 = 只有全服）。
  const ext = claudeExtensionsFor(ctx);
  if (ctx.kind === 'user') ext.plugins.push(...memberClaudePlugins(ctx.user));
  const attachments = Array.isArray(o.attachments) ? o.attachments.filter((p) => typeof p === 'string' && p) : [];
  const composed = composeTurnPrompt(o.prompt || '（没有内容）', attachments);
  // 恒流式输入 + gate 挂流（同主聊天，见 agents/claude.mjs makeTurnInput 注释）：
  // 字符串 prompt 会让 SDK 在 result 后自动关 stdin，后台子任务被杀、续轮通知丢失。
  const turnInput = makeTurnInput(composed.prompt, composed.imageBlocks);
  // effort 经 claudeEffortOptions 翻译（ultracode → xhigh + settings）。成员（runtime/quota.mjs memberRules）没给开放
  // Ultracode / 1M 就降档、用裸模型 id；没有命令行的身份 ultracode 一律降到 xhigh。
  const caps = memberRules(ctx);
  const effortOpts = claudeEffortOptions(o.effort === ULTRACODE && (!caps.ultracode || (ctx.sandbox && !ctx.shell)) ? 'xhigh' : o.effort);
  const modelId = runModelBase ? (caps.ctx1m ? to1M(runModelBase) : String(runModelBase).replace(/\[1m\]$/i, '')) : '';
  // 按人记账：新会话 CLI 的累计花费从 0 起；续写的会话也从 0 起算（CLI 每次启动都重新累计）。
  const billTo = billingUser(ctx);
  const costMeter = makeCostMeter(0);
  const notes = [];   // model_* 系统帧（安全栅门切换等）的官方文案——无人值守没有 UI，记进结果
  const engineAcct = activeAccountId();
  const engineEnv = claudeEngineEnv(ctx);
  const servedAcct = () => (isUpstreamEnv(engineEnv) && lastServedAccount()) || engineAcct;
  // 插件给 Claude 的工具与提示段（kind 由调用方给：插件可据此决定无人值守的轮次里给不给）
  const plug = pluginClaudeTurn({ ...(o.turn || { kind: 'routine' }), ctx, snap: null, message: o.prompt || '', sessionId: o.resume || null });
  const q = query({
    prompt: turnInput.stream,
    options: {
      ...claudeCliOptions(),
      cwd: ctx.cwd,
      ...(o.resume ? { resume: o.resume } : {}),
      additionalDirectories: ctx.sandbox ? (ctx.kind === 'user' ? [...sharedExtensionDirs(), ...[memberSkillRootIfAny(ctx.user)].filter(Boolean)] : []) : [UPLOADS, MEDIA],
      // 功能扩展的工具（媒体）跟着 agent 开关走（ctx.allowGemini），与主聊天同口径。
      mcpServers: { ...moduleClaudeMcp(ctx), ...plug.mcpServers, ...ext.mcpServers },
      ...(ext.plugins.length ? { plugins: ext.plugins } : {}),
      // snapshot:false 同 claude.mjs：SDK 0.3.267 起默认首轮录制复用，换模型后的身份 nudge 会被冻住。
      systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false, append: identityNudge(runModelBase) + (ctx.sandbox ? (USER_NUDGE + (ctx.shell ? '' : REGULAR_NUDGE) + mediaNudge(ctx)) : (hostNudge(ctx) + mediaNudge(ctx))) + plug.prompt + (o.append || '') },
      // 跨会话通道（Desktop / 终端会话互发）一律关：env 关总开关、settings 关入站闸（session-peers.mjs PEER_OFF_*）
      env: { ...(engineEnv || process.env), ...PEER_OFF_ENV },
      ...(modelId ? { model: modelId } : {}),
      ...(effortOpts.effort ? { effort: effortOpts.effort } : {}),
      settings: JSON.stringify({ ...(effortOpts.settings || {}), ...PEER_OFF_SETTINGS }),
      // 沙箱身份同样套硬边界（PreToolUse hook 含只读 + 无 shell disallow + 设置隔离）。
      ...(ctx.sandbox ? {
        hooks: { PreToolUse: [{ hooks: [makeSandboxPreToolUse(ctx)] }] },
        settingSources: [],
      } : {}),
      // 权限模式显式传 default（不传 = CLI 按服务端闸自己挑，可能静默变成 auto 分类器审批）+ 下面的宿主放行。
      // 没人能批计划：不给 EnterPlanMode（ExitPlanMode 万一来了也直接放行）。
      permissionMode: 'default',
      disallowedTools: [...(ctx.sandbox && !ctx.shell ? SHELL_DENY : []), 'EnterPlanMode'],
      includePartialMessages: false,
      abortController: abort,
      canUseTool: async (name, input) => {
        if (name === 'AskUserQuestion') return { behavior: 'deny', message: UNATTENDED_DENY };
        if (name === 'ExitPlanMode') return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] };
        if (ctx.sandbox) {
          if (!ctx.shell && (name === 'Bash' || name === 'PowerShell')) return { behavior: 'deny', message: NO_SHELL_MSG };
          // 多根围栏（principal.allowedRoots，开源路线 C5）+ 全服扩展目录只读豁免，与主聊天同一口径
          const v = sandboxFence(ctx, name, input); if (v) return { behavior: 'deny', message: v };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });
  let lastMainUsage = null; // main conversation's last API call usage (real context fill)
  // 后台任务悬停收轮（与主聊天同一机制、同一策略，见 agents/claude.mjs）：result 出来时只要还有
  // 【非 ambient】的后台任务在跑就不收——等 CLI 注入 task-notification 自动续轮，最终 result 覆盖 text。
  // 后台 shell（local_bash）同样悬停：不悬停 = CLI 收尾时把它杀掉（探针实测 ~8s）。常驻服务用封顶兜。
  const AGENTISH = new Set(['local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow']);
  const BG_SHELL_HOLD_MS = Math.max(60_000, Number(process.env.BRIDGE_BG_HOLD_MS) || 60 * 60_000);
  let bgTasks = [];
  let held = false;          // 出过 result 但后台任务未清
  let lastMsgAt = Date.now();
  const shellSeenAt = new Map();
  const cutShells = new Set();
  const liveBgTasks = () => bgTasks.filter((t) => t && t.task_id && !t.ambient && !cutShells.has(t.task_id));
  // 悬停期兜底（与主聊天同口径）：全 agent 集合看 15 分钟静默；任务表清零却没等来续轮看 2 分钟；
  // 后台 shell 逐条封顶——还有 agent/workflow 在跑时只掐超时的 shell，只剩 shell 时才 abort 收残局。
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
        console.log(`[${label}] bg-hold shell cap — stopping ${t.task_id}, agents keep running`);
        q.stopTask(String(t.task_id)).catch(() => {});
      }
      return;
    }
    const over = (agentOnly && quiet > 15 * 60_000)
      || (!live.length && quiet > 2 * 60_000)
      || (overdue.length > 0);
    if (!over) return;
    console.log(`[${label}] bg-hold timeout — aborting leftovers`);
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
        try { o.onInit?.(sessionId); } catch {}
      } else if (msg.type === 'rate_limit_event') {
        applyRateLimit(msg.rate_limit_info, servedAcct());
        if (msg.rate_limit_info && msg.rate_limit_info.status === 'rejected') rejection = msg.rate_limit_info;
      } else if (msg.type === 'system' && typeof msg.subtype === 'string' && msg.subtype.startsWith('model_')) {
        // 模型安全栅门 / 模型切换通知：这里没有 UI，只把官方文案记下来，结果前缀「⚠」。子 agent 内的不记。
        if (!msg.parent_tool_use_id && msg.content) { notes.push(String(msg.content)); emit({ type: 'note', text: String(msg.content) }); }
      } else if (msg.type === 'assistant') {
        // Main turn's own last API call = real context fill; skip subagents (parent_tool_use_id).
        if (!msg.parent_tool_use_id && msg.message && msg.message.usage) lastMainUsage = msg.message.usage;
        if (!msg.parent_tool_use_id && msg.message && !msg.error && (msg.message.usage?.output_tokens || 0) > 0) produced = true;
        if (!msg.parent_tool_use_id && Array.isArray(msg.message?.content)) {
          for (const b of msg.message.content) {
            if (b.type === 'text' && b.text) emit({ type: 'text', text: b.text });
            else if (b.type === 'tool_use') emit({ type: 'tool', name: b.name, input: b.input });
          }
        }
      } else if (msg.type === 'result') {
        // 幻影 result（resume 时 CLI 替上一条命的孤儿后台任务补的那一轮，在真轮 init 之前）——不是本轮定局。
        if (isPhantomResult(msg)) { console.log(`[${label}] phantom result before the real turn — ignored`); continue; }
        sessionId = msg.session_id;
        text = msg.result || '';
        apiStatus = typeof msg.api_error_status === 'number' ? msg.api_error_status : null;
        isError = Boolean(msg.is_error) || (apiStatus != null && apiStatus >= 400);
        if (billTo) {
          const u = msg.usage || {};
          const toks = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          const turnCost = costMeter.turnCost(msg.total_cost_usd);
          try { addUsage(billTo, { tokens: toks, costUsd: turnCost }); } catch {}
          // 用量事件流（开源路线 C12，runtime/audit-log.mjs）：与 usage.json 同一口径，多带号与模型的维度
          try { noteTurnUsage(ctx, { billTo, accountId: servedAcct(), model: modelId || runModelBase || '', tokens: toks, cost: turnCost, source: o.source || 'routine' }); } catch {}
        }
        applyContext(msg.modelUsage, msg.session_id, lastMainUsage || msg.usage, ctx.key);
        // gate 挂着输入流，stream 不会自然结束——不悬停就由我们收轮。
        held = !isError && liveBgTasks().length > 0;
        if (held) { console.log(`[${label}] result with live background task(s) — holding`); }
        else break;
      }
    }
  } catch (err) {
    // 看门狗 abort / CLI 半途死掉：已有的 text 就是最好结果；从没出过 result 才算失败。
    if (!text) { isError = true; text = o.signal?.aborted ? '已停止' : String((err && err.message) || err || ''); }
  } finally {
    clearInterval(bgWatch);
    turnInput.release();
    o.signal?.removeEventListener?.('abort', onExternalAbort);
  }
  // 号池智能路由：撞了额度墙 / token 失效就给这个号记冷却并换号；换成了且这次什么都没干成 → 用新号整条重跑
  //（最多换两次，防在全员用尽时来回打转——noteLimitHit 找不到可用号会回 null，本身也会停）。
  const limitKind = !isError ? '' : (apiStatus === 429 || rejection) ? 'rate_limit' : apiStatus === 401 ? 'auth' : '';
  if (limitKind && !o.signal?.aborted) {
    const sw = await noteLimitHit(servedAcct(), {
      kind: limitKind,
      type: rejection ? rejection.rateLimitType : '',
      resetsAt: rejection && rejection.resetsAt ? (rejection.resetsAt < 1e12 ? rejection.resetsAt * 1000 : rejection.resetsAt) : 0,
      model: runModelBase,
    });
    if (sw && !produced && attempt < 2) {
      console.log(`[${label}] hit ${limitKind} on ${sw.fromLabel} — rerunning on ${sw.toLabel}`);
      return runHeadlessTurn(ctx, o, attempt + 1);
    }
    if (sw) notes.push(`账号「${sw.fromLabel}」${reasonText(sw.reason)}，已自动切到「${sw.toLabel}」，下次运行会用新账号。`);
  }
  if (notes.length) text = notes.map((n) => '⚠ ' + n).join('\n') + (text ? '\n\n' + text : '');
  let files = [];
  if (!isError && text) {
    try {
      files = collectDeliverables(text, { cwd: ctx.cwd, roots: deliverRoots(ctx, ctx.cwd, VAULT), anywhere: deliverAnywhere(ctx) });
    } catch {}
  }
  return { sessionId, text, isError, files };
}
