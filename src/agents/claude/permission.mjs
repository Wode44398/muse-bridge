// 权限模式的实况与安全栅门的暂停对话框。

import { randomBytes } from 'node:crypto';
import { busPublish } from '../../runtime/bus.mjs';
import { pendingFor, sessionQuestions, waitForAnswer } from '../../runtime/questions.mjs';
import { sessionPaths } from '../../runtime/paths.mjs';
import { swapChatPrefsModel } from '../../runtime/chat-prefs.mjs';
import { noteSessionMode, pendingModeFor, makePermissionGate } from '../../runtime/permissions.mjs';
import { pluginPermission } from '../../plugins/claude-tools.mjs';
import { lastRealUserUuid } from './transcript.mjs';
import { applyRetraction } from './frames.mjs';
import { NO_SHELL_MSG } from './prompts.mjs';
import { sandboxFence } from './sandbox.mjs';

// 暂停对话框走 AskUserQuestion 同一条等待通道：发 refusal_prompt 给前端（输入框上方的 Paused 卡）、
// 会话列表亮「待回答」、POST /api/answer 带 choice 回来（10 分钟没人答按 cancelled）。三种结局：
//   retry_fallback → CLI 换会话模型重试（会话模型切换这里就记上，之后的 model_refusal_fallback 再记一次无害）；
//   edit_prompt    → CLI 撤掉半截并自行中断本轮（按软停止收，不报错）；前端等收轮后回滚到被拒消息、原文填回输入框；
//   cancelled（X / 超时 / 停止）→ CLI 按经典拒答收尾（model_refusal_no_fallback + 错误帧）。
// payload.retractedMessageUuids 官方规定「落定时才撤、收到时不撤」——回话前按名单撤（ledger 幂等）。
export function makeRefusalDialog(run) {
  const { ctx } = run.plan;
  return async (req, opts) => {
    if (!req || req.dialogKind !== 'refusal_fallback_prompt') return { behavior: 'cancelled' };
    const p = req.payload || {};
    const qid = 'rf-' + randomBytes(6).toString('hex');
    const sid = run.gen.sessionId;
    const from = String(p.originalModel || ''), to = String(p.fallbackModel || '');
    // 被拒的用户消息此刻已落盘：先把它的 uuid 作为回滚锚点发下去（「编辑并重试」回滚到它）
    if (sid) {
      try { const sp = sessionPaths(sid, ctx.cwd, ctx.configDir); const a = sp ? lastRealUserUuid(sp.file) : null; if (a) run.send({ type: 'anchor', uuid: a, sessionId: sid }); } catch {}
    }
    run.send({ type: 'refusal_prompt', qid, sessionId: sid || null, from, to, category: p.apiRefusalCategory ?? null, at: Date.now() });
    // pending 按「这个会话还有没有别的在等」算：同一会话可能同时挂着审批卡（sessionQuestions 一会话多条）
    const announce = () => { if (sid) busPublish(ctx.key, { type: 'question', sessionId: sid, pending: pendingFor(sid, ctx.key) }); };
    if (sid) sessionQuestions.set(sid, { qid, kind: 'refusal', ownerKey: ctx.key, questions: [{ header: 'Session paused', question: `Safeguards flagged this message. Edit and retry, or switch to ${to || 'the fallback model'}.` }], ts: Date.now() });
    announce(true);
    let choice = 'cancelled';
    try {
      const ans = await waitForAnswer(qid, opts && opts.signal, undefined, ctx.key);
      if (ans && !ans.cancelled && (ans.choice === 'retry_fallback' || ans.choice === 'edit_prompt')) choice = ans.choice;
    } catch {}
    if (sid) sessionQuestions.delete(sid, qid);
    announce(false);
    const retracted = Array.isArray(p.retractedMessageUuids) ? p.retractedMessageUuids.filter((u) => typeof u === 'string') : [];
    if (retracted.length) applyRetraction(run, retracted);
    if (choice === 'edit_prompt') run.softStopping = true;
    if (choice === 'retry_fallback' && to && sid) {
      const bare = to.replace(/\[1m\]$/, ''), fromBare = from.replace(/\[1m\]$/, '');
      if (run.chatPrefs) { try { swapChatPrefsModel(ctx, sid, bare, fromBare); } catch {} }
      run.send({ type: 'session', sessionId: sid, model: bare, swapped: true, from: fromBare, at: Date.now(), requestId: null });
    }
    run.send({ type: 'refusal_answer', qid, choice, sessionId: sid || null });
    return choice === 'cancelled' ? { behavior: 'cancelled' } : { behavior: 'completed', result: choice };
  };
}

// 权限模式实况变了（init / status 帧、会话中切换、接管时对齐）：发 perm_mode（前端芯片）并记进会话记忆，
// 下一轮 spawn 照它。init 每轮都发一次（新设备 attach 也拿得到实况）；无人值守的轮不记（别把用户选的模式改成 default）。
// init 只在会话还没记过模式时落一笔（新会话首轮）：会话记忆同时承载「待生效的选择」——干活时选的绕过权限、冷启动
// 还没出 init 时刚选的模式——挂起后的续轮 / 冷启动首帧的 init 只报实况，不许把它冲掉。事件带上待生效的绕过权限，
// 前端芯片的小红点才不会被 init 抹掉。
export function notePermMode(run, mode, trigger) {
  const { ctx, snap, permPolicy } = run.plan;
  if (!mode || (mode === run.runPermMode && trigger !== 'init')) return;
  const from = run.runPermMode;
  run.runPermMode = mode;
  // Claude 自己进的计划模式（CLI 报来的，不是用户选的）记下来路：从绕过权限进去的，出计划时不挂审批卡（permissions.mjs planGate）
  if (mode === 'plan') { if (from !== 'plan') run.planFrom = trigger === 'cli' ? from : null; }
  else run.planFrom = null;
  const sidM = run.gen.sessionId;
  if (!sidM || snap) return;
  if (permPolicy !== 'host') noteSessionMode(ctx, sidM, mode, { ifUnset: trigger === 'init' });
  const pendingMode = permPolicy !== 'host' ? pendingModeFor(ctx, sidM, mode) : null;
  const ev = { type: 'perm_mode', sessionId: sidM, mode, ...(from !== mode ? { from } : {}), ...(pendingMode ? { pendingMode } : {}), trigger, at: Date.now() };
  if (!run.turnClosed) run.send(ev);
  if (trigger !== 'init') busPublish(ctx.key, ev);
}

// 逐次工具审批 / 计划审批（AskUserQuestion 之外的工具在 canUseTool 末尾交给它）。沙箱复检放在弹卡之前
// （别让人批一个注定被拒的调用）；拒绝且不带反馈 = 停下这一轮（官方），按软停止收、不报错。
export function armPermGate(run) {
  const { source, ctx, snap, permPolicy } = run.plan;
  run.permGate = makePermissionGate({
    ctx, policy: permPolicy, send: (ev) => run.send(ev), sid: () => run.gen.sessionId, currentMode: () => run.runPermMode,
    guard: ctx.sandbox ? (name, input) => ((!ctx.shell && (name === 'Bash' || name === 'PowerShell')) ? NO_SHELL_MSG : sandboxFence(ctx, name, input)) : null,
    onInterrupt: () => { run.softStopping = true; },
    planFrom: () => run.planFrom || null,
    // 卡片作答算一次活动（挂起看门狗的静默计时从这里重新算，见 bgTick）
    onActivity: () => { run.lastMsgAt = Date.now(); },
    // 取值函数：停放复用 / 预热接管 / 挂起接力会把 limitReplay 换成眼下这条请求的（见 warmTake / handoff）
    limitReplay: () => run.limitReplay,
    // 眼下这一轮是谁发起的（gen 在停放复用 / 接力时会换）：Auto-fix 叫醒的轮（'ci'）里开长期授权的调用直接拒，不弹卡
    turnOrigin: () => (run.gen && run.gen.family && run.gen.family.origin && run.gen.family.origin.kind) || '',
    // 没有真人发起的轮（会话间 / 跨会话 / Auto-fix 开的、额度重置后的自动续跑）：审批卡等 30 分钟没人答就收掉这一轮
    unattended: () => !!(run.gen && (run.gen.family || run.gen.autoTurn)),
    // 插件的审批策略（ctx.claude.permission）：快照访客不问
    pluginPolicy: snap ? null : (name, input, o) => pluginPermission({ kind: 'chat', ctx, snap: null, sessionId: run.gen.sessionId || null, source },
      { tool: name, input, mode: run.runPermMode, agentID: o && o.agentID, signal: o && o.signal }),
  });
}
