// 消息循环里 result 以外各类帧的处理。

import { waitPeerRecord, peerDisplay, notePeerHold } from '../../runtime/session-peers.mjs';
import { swapChatPrefsModel } from '../../runtime/chat-prefs.mjs';
import { markBridgeSession } from '../../runtime/gen.mjs';
import { applyRateLimit, statusState, getContext, applyLiveContext } from '../../runtime/status.mjs';
import { getCommands, applyCommands, getContextUsage, nativeWindow } from '../../runtime/ctx-usage.mjs';
import { refreshOutputStyles } from '../../runtime/claude-turn-settings.mjs';
// 工具行/任务卡规则与历史重建（routes/sessions.mjs）共用一份——直播与重开必须一致。
import { clip, toolSummary, compactMeta, toolShown, toolInputSubset, COMPACT_SUMMARY_RE } from '../../runtime/tool-summary.mjs';
import { autoServed } from '../../runtime/model-ratings.mjs';   // 工作流 auto:<档> agent 的真实模型与档位
import { sessionPaths } from '../../runtime/paths.mjs';
import { mirrorSessionNow } from '../../runtime/desktop-mirror.mjs';
import { noteTaskLabel } from '../../runtime/account-router.mjs';
import { noteSessionMcp } from '../../runtime/session-mcp.mjs';
import { noteLiveQuery } from '../../runtime/mcp-oauth.mjs';
import { ensureChromeNativeHost } from '../../runtime/chrome-native-host.mjs';
import { clearPendingRewind } from '../claude-rewind.mjs';
import { fastCooling } from '../../runtime/claude-providers-proxy.mjs';
import { deferredModeFor, bindModeControl } from '../../runtime/permissions.mjs';
import { cardOf } from '../../plugins/tool-card.mjs';
import { saveToolImages } from '../../runtime/tool-images.mjs';
import { emitTaskEvent } from './task-events.mjs';
import { announceStart, recordPrefs, recordOrigin } from './turn-ledger.mjs';
import { notePermMode } from './permission.mjs';
import { onBgTasksChanged } from './bg-hold.mjs';
import { markPluginOrigin } from './plugin-origin.mjs';

// 跨会话消息插进了正在跑的这一轮（CLI 在下一个工具回合读到它，流里只有 command_lifecycle）：等 transcript 落盘后
// 补一个插话段，直播当场看得见（不补的话要刷新才出现）。不是跨会话消息（后台任务通知之类）就什么都不做。
export function echoPeer(run, uuid) {
  const { ctx } = run.plan;
  run.peerSeen.add(uuid);
  const g0 = run.gen;
  const sp = run.gen.sessionId ? sessionPaths(run.gen.sessionId, ctx.cwd, ctx.configDir) : null;
  waitPeerRecord(sp && sp.file, uuid).then((r) => {
    if (!r || !r.peer || g0 !== run.gen || run.gen.done) return;
    run.send({ type: 'steer', uuid, text: peerDisplay(r.peer), files: [], at: Date.now() });
    run.send({ type: 'steer_state', uuid, state: 'started' });
  }).catch(() => {});
}

// ---- 子 agent 转录 / 模型切换 / 撤回 -----------------------------
// 子 agent 的完整 assistant 帧（parent_tool_use_id = 那次 Agent 调用的 tool_use id）→ agent_msg，每个
// content block 一条：正文 ≤4000；工具用 toolSummary；思考只发占位不发正文（子 agent 的思考没人看）。
// parent 对不上任何已知工具行（深层嵌套）也照发，前端找不到就丢。
export function emitAgentMsgs(run, m) {
  const content = m.message && Array.isArray(m.message.content) ? m.message.content : [];
  const model = (m.message && m.message.model) || '';
  const at = Date.now();
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) run.send({ type: 'agent_msg', toolUseId: m.parent_tool_use_id, kind: 'text', text: clip(b.text, 4000), model, at });
    else if (b.type === 'tool_use') run.send({ type: 'agent_msg', toolUseId: m.parent_tool_use_id, kind: 'tool', name: b.name || '', summary: toolSummary(b.name, b.input || {}), model, at });
    else if (b.type === 'thinking' || b.type === 'redacted_thinking') run.send({ type: 'agent_msg', toolUseId: m.parent_tool_use_id, kind: 'thinking', model, at });
  }
}

// 撤回：按 uuid 名单算出被拒那截在本轮正文/思考/工具行里占的区间（ledger 负责命中 / 零帧消息 /
// server lane 不撤的全部判定与记账前移），有区间就发 retract{textFrom,textTo,…}。名单与重试首帧的
// supersedes 是同一份，ledger 内幂等。
export function applyRetraction(run, list) {
  const ev = run.ledger.retract(list);
  if (ev) run.send(ev);
}

// model_* 系统帧（model_refusal_fallback / model_refusal_no_fallback / @internal 的 model_fallback、
// model_consent_fallback，通配 startsWith('model_')）→ model_notice 提示卡。wire 字段是 snake_case，
// 防御性地也认 camelCase。scope:'session' 的 refusal/consent 切换 = 会话模型已换：把 sidecar 里记忆的
// model 改成回退模型 + 发 session{swapped}（前端据此把选择器切过去，下一轮就显式传回退模型——
// bridge 每轮都传 --model，CLI 的 latch 不跨进程，只能由我们记）。
export function onModelNotice(run, m) {
  const { ctx } = run.plan;
  const sub = m.subtype;
  const parentTool = m.parent_tool_use_id || null;
  if (sub === 'model_fallback' && parentTool) return;   // 子 agent 内的过载回退不进主时间线（官方桌面端同款过滤）
  const pick = (a, b) => (m[a] !== undefined ? m[a] : m[b]);
  const from = String(pick('original_model', 'originalModel') || '');
  const to = String(pick('fallback_model', 'fallbackModel') || '');
  const retractedRaw = pick('retracted_message_uuids', 'retractedMessageUuids');
  const retracted = Array.isArray(retractedRaw) ? retractedRaw.filter((u) => typeof u === 'string') : [];
  const scope = m.scope === 'local' ? 'local' : 'session';
  // 先撤回被拒那截，再摆提示卡——卡片之后接的是回退模型重新生成的正文。只认 scope:'session'（主线程；
  // 旧 CLI 缺省视为 session）：model_refusal_fallback 帧【没有】parent_tool_use_id 字段，子 agent / 侧问的
  // 回退靠 scope:'local' 区分，名单里是子 agent 帧的 uuid，主线程记账对不上却会误伤正开着的那条消息。
  if (sub === 'model_refusal_fallback' && retracted.length && scope === 'session') applyRetraction(run, retracted);
  run.send({
    type: 'model_notice', subtype: sub, direction: m.direction || null, scope, from, to,
    trigger: m.trigger || null,
    category: pick('api_refusal_category', 'apiRefusalCategory') ?? null,
    explanation: pick('api_refusal_explanation', 'apiRefusalExplanation') ?? null,
    text: String(m.content || ''),
    requestId: pick('request_id', 'requestId') || null,
    refusedUserUuid: pick('refused_user_message_uuid', 'refusedUserMessageUuid') || null,
    retracted, parentToolUseId: parentTool, uuid: m.uuid || null, at: Date.now(),
  });
  if ((sub === 'model_refusal_fallback' || sub === 'model_consent_fallback') && scope === 'session' && to && !parentTool) {
    // picker 与 sidecar 只认裸 id（1M 由 to1M 在跑 query 时补回）。
    const bare = to.replace(/\[1m\]$/, '');
    const fromBare = from.replace(/\[1m\]$/, '');
    if (run.chatPrefs && run.gen.sessionId) { try { swapChatPrefsModel(ctx, run.gen.sessionId, bare, fromBare); } catch {} }
    // at：前端据此给这次切换记账——attach 整轮重放会把它再送一遍，同一次切换只落一次 settings.model
    run.send({ type: 'session', sessionId: run.gen.sessionId, model: bare, swapped: true, from: fromBare, at: Date.now(), requestId: pick('request_id', 'requestId') || null });
  }
}

// 会改盘上文件的内置工具：tool_result 成功后向前端推 {type:'fs',path}，
// 打开中的文档预览据此实时跟盘（不含 Bash——命令是否写文件无从静态判断）。
const FS_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function onInit(run, msg) {
  const { message, sessionId, model, fast, ctx, snap, cpOwner, custom, permPolicy, chromeOn, customFast } = run.plan;
  run.gen.sessionId = msg.session_id;
  announceStart(run);   // 新会话/分叉后 id 才定下来——总线补播，别的设备这才认得出该挂哪一轮
  recordPrefs(run);     // 新会话此刻才有 id——把本轮选择器记忆落上
  recordOrigin(run);    // 同上：这条消息的发送端
  markBridgeSession(msg.session_id); // this conversation was started from the phone
  markPluginOrigin(run, msg.session_id);
  // 官方 Desktop 侧栏索引：会话 id 一定下来就登记（desktop-mirror.mjs），bridge 会话天生带 Desktop 索引
  if (!snap && msg.session_id) {
    run.gen.mirror = {
      fresh: !sessionId || msg.session_id !== sessionId,
      cwd: msg.cwd || ctx.cwd,
      model: /^claude-/.test(String(msg.model || '')) ? msg.model : undefined,
      permissionMode: msg.permissionMode,
      title: String(message || '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
    mirrorSessionNow(ctx, msg.session_id, { file: sessionPaths(msg.session_id, run.gen.mirror.cwd, ctx.configDir)?.file, hint: run.gen.mirror });
    if (run.gen.mirror.fresh && run.gen.mirror.title) noteTaskLabel(msg.session_id, run.gen.mirror.title);   // 号池分派记录里认得出是哪个对话
  }
  // 对话回滚锚点已随本轮 resumeSessionAt 消费（分支从此落进 transcript）——清账。
  if (sessionId) clearPendingRewind(sessionId);
  // 带 --chrome 启动的 CLI 刚把 native host 入口改写成 SDK 内核——归位到约定的那个 exe。
  if (chromeOn) ensureChromeNativeHost();
  // fast：本轮加速是否真点亮（开了开关也可能因冷却/额度不可用——前端据此显示实况）。
  // 自定义模型：CLI 报的是裸型号（mimo-v2.6-pro），前端拿它和所选（custom:<服务>:<模型>）对账会误判成「实际用的是别的模型」
  // 自定义服务的 fast 由代理发，实况 = 支持且这个服务不在 fast 退避期
  run.send({ type: 'session', sessionId: msg.session_id, model: custom ? model : msg.model, ...(fast ? { fast: custom ? customFast && !fastCooling(custom.provider.id, custom.provider.owner || cpOwner) : msg.fast_mode_state === 'on' } : {}), ...(ctx.worktree ? { wt: ctx.worktree } : {}) });
  // 权限模式实况（init 帧带 permissionMode；与要的不同 = CLI 降级了，如 auto 对这个模型不可用）+ 会话中切模式的控制口
  if (msg.permissionMode) notePermMode(run, msg.permissionMode, msg.permissionMode !== run.askedPermMode && run.runPermMode === run.askedPermMode ? 'fallback' : 'init');
  // 冷启动还没出 init 时用户在芯片上选过模式（控制口没登记，接口只记进会话记忆、回 next）：现在口通了，当场切过去。
  // 绕过权限照官方等这一轮定局（deferredModeFor 在停放前切）。
  if (msg.permissionMode && msg.session_id && !snap && permPolicy !== 'host') {
    const want = deferredModeFor(ctx, msg.session_id, run.runPermMode);
    if (want && want !== 'bypassPermissions') {
      run.q.setPermissionMode(want).then(() => notePermMode(run, want, 'user'), (e) => console.log('[claude] init setPermissionMode failed:', e && e.message));
    }
  }
  if (!run.unbindMode && msg.session_id && !snap && permPolicy !== 'host') {
    run.unbindMode = bindModeControl(ctx.key, msg.session_id, {
      set: (m) => run.q.setPermissionMode(m),
      busy: () => !run.turnClosed && !run.heldResult,
      current: () => run.runPermMode,
      note: (m) => notePermMode(run, m, 'user'),
    });
  }
  // 斜杠命令表（输入栏「/」菜单用）：控制接口 supportedCommands() 给全表（内置 + 技能，
  // 带 description/argumentHint），init 帧的 terminal_slash_commands（SDK 0.3.257）标出
  // 绑定本地终端 UX 的命令（doctor/color），手机/远程 UI 该藏。表跟账号/技能走不跟会话，
  // 按 caller key 缓存 10 分钟，不必每轮都走一趟控制通道。快照访客没有输入栏菜单，跳过。
  if (!snap && Date.now() - getCommands(ctx.key).at > 600_000) {
    const termCmds = Array.isArray(msg.terminal_slash_commands) ? msg.terminal_slash_commands : [];
    run.q.supportedCommands().then((list) => applyCommands(ctx.key, list, termCmds)).catch(() => {});
  }
  // 连接器（MCP）状态：init 帧自带全表 [{name,status}]——会话信息面板的「连接器」卡吃这份，
  // 不必等进程活着时再走控制通道。快照访客没有面板，跳过。
  // 同时登记这个活着的 CLI：连接器「授权」按钮直接借它发控制请求（runtime/mcp-oauth.mjs），不必另起进程
  if (!snap && msg.session_id && run.liveSid !== msg.session_id) { if (run.offLive) run.offLive(); run.offLive = noteLiveQuery(ctx.key, msg.session_id, run.q); run.liveSid = msg.session_id; }
  if (!snap && Array.isArray(msg.mcp_servers)) {
    const servers = noteSessionMcp(ctx.key, msg.session_id, msg.mcp_servers);
    run.send({ type: 'mcp', sessionId: msg.session_id, servers });
  }
  // 可选输出风格清单（设置页 / 会话菜单的「输出风格」用）：按身份 10 分钟问一次控制通道
  refreshOutputStyles(ctx, run.q);
}

// 插话消息的生命周期（queued → started → completed / cancelled）：started = CLI 已把它读进这一轮。
function onCommandLifecycle(run, msg) {
  if (msg.command_uuid && run.steerUuids.has(msg.command_uuid) && msg.state !== 'queued') {
    const si = run.steerItems.get(msg.command_uuid);
    // 正在撤回的那条报 cancelled：是我们自己撤的，等 unsteer 发 withdrawn，不另发
    const ours = !!(si && si.pending && msg.state === 'cancelled');
    if (si && !ours) { if (msg.state === 'cancelled') run.steerItems.delete(msg.command_uuid); else si.read = true; }
    if (!ours) run.send({ type: 'steer_state', uuid: msg.command_uuid, state: msg.state });
  } else if (run.peerAware && msg.state === 'started' && msg.command_uuid && !run.awaitingUser.has(msg.command_uuid) && !run.peerSeen.has(msg.command_uuid)) {
    echoPeer(run, msg.command_uuid);   // 可能是跨会话消息插进来了（session-peers.mjs）
  }
}

// 自定义 API：第三方的限流跟官方号的额度窗口无关，不记账
function onRateLimitEvent(run, msg) {
  const { custom, servedAcct } = run.plan;
  if (!custom) {
    applyRateLimit(msg.rate_limit_info, servedAcct(run.gen.sessionId));
    if (msg.rate_limit_info && msg.rate_limit_info.status === 'rejected') run.turnRejection = msg.rate_limit_info;
    run.send({ type: 'limits', limits: statusState.limits, updatedAt: statusState.updatedAt, noFiveHour: statusState.noFiveHour });
  }
}

// 上下文压缩进度（SDK 实测帧序：status:compacting → status:null+compact_result → compact_boundary →
// 摘要 user 帧；手动 /compact 时 init 夹在中间）。前端据此在循环组里摆「Compacting…」流光行，
// 失败给「Compaction failed」；成功的定局以 boundary 为准（它才带 uuid 与 token 数）。
// requesting = 发起一次 API 请求 → 前端状态行「等待 Claude…」（官方 /code 同款信号）。
function onStatus(run, msg) {
  if (msg.status === 'requesting') run.send({ type: 'mode', mode: 'requesting' });
  else if (msg.status === 'compacting') run.send({ type: 'compact', phase: 'start' });
  else if (msg.compact_result) run.send({ type: 'compact', phase: 'end', ok: msg.compact_result !== 'failed', error: msg.compact_error ? clip(String(msg.compact_error), 300) : '' });
  // 权限模式变化（计划批准切到目标模式、模型自行 EnterPlanMode、会话中 setPermissionMode）——与上面的运行相位 mode 帧别撞名
  if (msg.permissionMode) notePermMode(run, msg.permissionMode, 'cli');
}

// 压缩边界（只认主线程；子 agent 自己的压缩不上主时间线，同官方）。id = 边界 uuid，与 jsonl 那条
// system 记录同一个——历史重建的条目指纹对得上（routes/sessions.mjs）。
function onCompactBoundary(run, msg) {
  const cm = compactMeta(msg);
  run.compactSeen = true;
  run.compactAwait = msg.uuid || '';
  run.send({ type: 'compact', phase: 'boundary', id: msg.uuid || '', trigger: cm.trigger, preTokens: cm.preTokens, postTokens: cm.postTokens, ms: cm.ms });
}

// 只认主线程（parent_tool_use_id 为空）。子 agent 的增量本就不转发，万一来了也不能混进主正文——
// 它们属于 Agent 卡的转录（走 assistant 帧 → agent_msg）。
function onStreamEvent(run, msg) {
  const ev = msg.event;
  if (ev?.type === 'message_start') {
    // 撤回记账：API 消息边界——被拒的半截若没凑成完整 block（没有 uuid 可对），按整条消息的区间撤。
    run.ledger.messageStart();
    run.widgets.reset();   // 内嵌图表：上一条消息没收尾的 show_widget 记录作废（index 重新数）
    run.send({ type: 'mode', mode: 'requesting' });   // 新一条 API 消息开跑：状态行「等待 Claude…」
  } else if (ev?.type === 'message_stop') {
    run.ledger.messageStop();
  } else if (ev?.type === 'content_block_start' && (ev.content_block?.type === 'thinking' || ev.content_block?.type === 'redacted_thinking')) {
    // 思考块开头：思考内容被隐去（display omitted / redacted）时一条 thinking_delta 都没有，
    // 状态行的「思考中…」只能靠这一帧点亮。
    run.send({ type: 'mode', mode: 'thinking' });
  } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
    // AskUserQuestion / agy / 媒体工具有各自专属 UI（问答卡 / 胶囊 / 媒体卡），不露成工具行；
    // Agent/Task/Workflow 现在【露】——它们的工具行就是子 agent 卡 / 工作流卡的宿主（task_* 按 id 挂上去）。
    const n = ev.content_block.name;
    const shown = toolShown(n);
    const id = ev.content_block.id || '';
    run.streamBlocks[ev.index] = { type: 'tool_use', name: n, json: '', shown, id };
    if (run.widgets.start(ev.index, n, id)) run.ledger.addWidget();   // show_widget 不露成工具行，落 widget 段（撤回按段序号记账）
    if (shown) {
      run.ledger.addTool();
      if (id) { run.toolStarts.set(id, Date.now()); run.taskGuard.mainTools.add(id); }
      run.send({ type: 'tool', id, name: n, index: ev.index, at: Date.now() });   // at：开始时刻，重放时前端按它续算行内计时
    }
  } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
    const t = ev.delta.text || '';
    run.ledger.addText(t.length);
    run.send({ type: 'text', text: t });
  } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
    // Claude's extended-thinking stream — the "想法" view (phone hides it by default).
    const t = ev.delta.thinking || '';
    run.ledger.addThink(t.length);
    run.send({ type: 'thinking', text: t });
  } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') {
    const b = run.streamBlocks[ev.index];
    if (b) { b.json += ev.delta.partial_json || ''; run.widgets.delta(ev.index, b.json); }
  } else if (ev?.type === 'content_block_stop') {
    const b = run.streamBlocks[ev.index];
    if (b && b.type === 'tool_use') {
      let input = {}; try { input = JSON.parse(b.json || '{}'); } catch {}
      run.widgets.stop(ev.index, input);
      if (b.shown) {
        // 摘要 + 安全输入子集（file_path/command/pattern/description/prompt≤200…），前端工具行的参数表用。
        const summary = toolSummary(b.name, input);
        const sub = toolInputSubset(b.name, input);
        if (summary || Object.keys(sub).length) run.send({ type: 'tool_args', id: b.id, index: ev.index, summary, input: sub });
      }
      if (b.id && FS_EDIT_TOOLS.has(b.name)) {
        const p = input.file_path || input.notebook_path || '';
        if (p) run.fsPending.set(b.id, String(p));
      }
    }
    delete run.streamBlocks[ev.index];
  } else if (ev?.type === 'message_delta' && ev.usage) {
    // Live token totals for the thinking status bar. One message_delta per
    // message (carries that message's final output_tokens), so accumulate
    // across a multi-message turn. thinking_tokens is a subset of output.
    run.turnOut += ev.usage.output_tokens || 0;
    run.turnThink += (ev.usage.output_tokens_details && ev.usage.output_tokens_details.thinking_tokens) || 0;
    run.send({ type: 'usage', output: run.turnOut, thinking: run.turnThink });
  }
}

function onAssistant(run, msg) {
  const { ctx, custom, modelFor } = run.plan;
  if (msg.parent_tool_use_id) {
    // 子 agent 的完整 assistant 帧 → agent_msg（Agent 卡的实时转录）。它跑在更小的窗口上，
    // usage 不计入主线程上下文（下面 lastMainUsage 只认主线程）。
    emitAgentMsgs(run, msg);
  } else {
    // Track the MAIN conversation's own last API call — its usage IS the current
    // context fill (prompt this round + the reply that becomes next round's history).
    // Subagent messages carry a parent_tool_use_id and run on smaller windows, so skip
    // them. This replaces the result's top-level usage, which is CUMULATIVE across every
    // API round-trip in the turn (a multi-tool turn sums each round's cache read, so a
    // 200k window reported ~1.6M and pinned the bar at a bogus 100%).
    if (msg.message && msg.message.usage) {
      run.lastMainUsage = msg.message.usage;
      // 轮中实时填充（status.mjs applyLiveContext）：窗口取本会话上一轮的真值 → 用量分布的 max →
      // 自定义模型配置 → 按型号估；轮末 result 再用真窗口覆盖。同一次 API 调用拆成多帧时 used 不变，不重发。
      const lsid = msg.session_id || '';
      if (lsid) {
        const total = getContext(ctx.key, lsid)?.total || getContextUsage(ctx.key, lsid)?.max
          || (custom ? Number(custom.model.contextWindow) || 0 : 0) || nativeWindow(msg.message.model || modelFor(run.runModel));
        const live = applyLiveContext(lsid, run.lastMainUsage, total, ctx.key);
        if (live && live.used !== run.liveCtxUsed) {
          run.liveCtxUsed = live.used;
          run.send({ type: 'context', used: live.used, total: live.total, pct: live.pct, sessionId: live.sessionId, at: live.at });
        }
      }
    }
    if (msg.error === 'authentication_failed') run.authFailed = true;
    if (msg.error === 'rate_limit') {
      const parts = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
      const params = msg.apiErrorParams || msg.api_error_params || null;
      run.limitFrame = {
        text: parts.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim(),
        info: (params && params.rate_limit_info) || msg.quotaLimits || null,
      };
    }
    // 撤回记账：回退模型重试的首条 assistant 帧带 supersedes[]（与通知里的 retracted 名单同一份，幂等）；
    // 先撤再把本帧覆盖的区间记下来（上一帧结束 → 当前计数），供之后的撤回名单按 uuid 对账。
    const sup = Array.isArray(msg.supersedes) ? msg.supersedes : (Array.isArray(msg.supersedesUuids) ? msg.supersedesUuids : null);
    if (sup && sup.length) applyRetraction(run, sup);
    run.ledger.frame(msg.uuid || '');
  }
}

// 主线程的 tool_result：① 工具行收尾（tool_done：状态 + 耗时）② 文件编辑工具成功落盘 → 推 fs 事件
// 让打开中的文档预览跟盘刷新。子 agent 的 tool_result 不看（它们的工具活动走 agent_msg）。
function onUserFrame(run, msg) {
  const { ctx } = run.plan;
  const parts = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
  // 压缩边界之后紧跟的那条 user 帧 = CLI 注入的压缩摘要（直播帧没有 isCompactSummary 标记，按位置认；
  // 措辞校验兜一道，别把 <local-command-stdout> 之类的包裹当成摘要）→ 压缩行的展开详情。
  if (run.compactAwait) {
    const c = msg.message && msg.message.content;
    const text = (typeof c === 'string' ? c : parts.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')).trim();
    if (text && COMPACT_SUMMARY_RE.test(text)) run.send({ type: 'compact', phase: 'summary', id: run.compactAwait, summary: text });
    run.compactAwait = '';
  }
  for (const blk of parts) {
    if (!blk || blk.type !== 'tool_result' || !blk.tool_use_id) continue;
    const tid = blk.tool_use_id;
    if (run.widgets.result(blk)) continue;
    if (run.toolStarts.has(tid)) {
      const t0 = run.toolStarts.get(tid);
      run.toolStarts.delete(tid);
      // 插件工具的结果卡片（plugins/tool-card.mjs）：带上卡片对象，前端画在工具行下
      const card = cardOf(blk);
      // 结果里的图片（读图 / 截图）落到身份 media 目录，帧里只带张数——状态行缩略图条按 /api/tool-image 取
      const images = saveToolImages(ctx.media, tid, blk);
      run.send({ type: 'tool_done', id: tid, isError: !!blk.is_error, ms: Math.max(0, Date.now() - t0), ...(card ? { card } : {}), ...(images ? { images } : {}) });
    }
    if (run.fsPending.has(tid)) {
      const p = run.fsPending.get(tid);
      run.fsPending.delete(tid);
      if (!blk.is_error) run.send({ type: 'fs', path: p });
    }
  }
}

// result 以外的帧按类型分派；各分支都不含 await。
export function onFrame(run, msg) {
  const { ctx, cpOwner, custom } = run.plan;
  if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
    onBgTasksChanged(run, msg);
  } else if (msg.type === 'system' && msg.subtype === 'init') {
    onInit(run, msg);
  } else if (msg.type === 'command_lifecycle') {
    onCommandLifecycle(run, msg);
  } else if (msg.type === 'system' && msg.subtype === 'peer_message_hold') {
    // hold 档扣住 / 放行 / 丢弃了一条跨会话消息：登记出来，前端「待你确认」卡据此显示
    if (run.peerAware) notePeerHold(ctx, run.gen.sessionId || msg.session_id, msg, run.peerGate);
  } else if (msg.type === 'rate_limit_event') {
    onRateLimitEvent(run, msg);
  } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
    run.send({ type: 'retry', attempt: msg.attempt, max: msg.max_retries, status: msg.error_status, errorKind: msg.error });
  } else if (msg.type === 'system' && msg.subtype === 'status') {
    onStatus(run, msg);
  } else if (msg.type === 'system' && msg.subtype === 'permission_denied') {
    // 不经 canUseTool 就被拒的调用（auto 模式分类器 / 规则）：工具行标「被自动模式拦下」
    run.send({ type: 'perm_denied', toolUseId: msg.tool_use_id || '', tool: msg.tool_name || '', kind: msg.decision_reason_type || '', reason: clip(String(msg.decision_reason || msg.message || ''), 400), agentId: msg.agent_id || null, at: Date.now() });
  } else if (msg.type === 'system' && msg.subtype === 'compact_boundary' && !msg.parent_tool_use_id) {
    onCompactBoundary(run, msg);
  } else if (msg.type === 'system' && typeof msg.subtype === 'string' && msg.subtype.startsWith('model_')) {
    // 模型安全栅门 / 模型切换（refusal → 回退模型重试 → 提示卡 + 撤回半截正文）。聊天轮不再自动切：
    // 先经 onRefusalDialog 暂停问人，选了「Switch to X」才走到这里；快照轮仍是 CLI 默认的自动切换。
    onModelNotice(run, msg);
  } else if (msg.type === 'system' && typeof msg.subtype === 'string' && msg.subtype.startsWith('task_')) {
    // Subagent / dynamic-workflow fan-out lifecycle -> Agent 卡 / 工作流卡（挂在对应工具行上）。
    emitTaskEvent(run.send, msg, run.taskTypes, run.taskGuard, cpOwner ? (name) => autoServed(name, cpOwner, { official: !custom }) : null, run.wfLive);
  } else if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
    onStreamEvent(run, msg);
  } else if (msg.type === 'assistant') {
    onAssistant(run, msg);
  } else if (msg.type === 'user' && !msg.parent_tool_use_id) {
    onUserFrame(run, msg);
  }
}
