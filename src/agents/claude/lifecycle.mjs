// 一次运行的开场与收场：占位、搭台、收尾。中间的消息循环在 claude.mjs 的 runClaudeChat 里。

import path from 'node:path';
import { startMultiHeartbeat } from '../../runtime/sse.mjs';
import { tryStartGen, genWrite, genSubscribe, genEmit } from '../../runtime/gen.mjs';
import { makeRetractLedger } from '../../runtime/retract-ledger.mjs';
import { sessionPaths } from '../../runtime/paths.mjs';
import { noteTurnStart } from '../../users.mjs';
import { makeCostMeter } from '../../runtime/usage-ledger.mjs';
import { getPolicy } from '../../runtime/policy.mjs';
import { peersOn, dropPeerGate, unregisterPeerGate } from '../../runtime/session-peers.mjs';
import { makeWidgetStream } from '../../mcp/visualize.mjs';
import { reasonText } from '../../runtime/account-router.mjs';
import { upstreamEvents } from '../../runtime/claude-upstream.mjs';
import { onFastFallback } from '../../runtime/claude-providers-proxy.mjs';
// 拉取请求闭环（pr-monitor.mjs）：流里认 PR 自动绑定、真人发话清零 Auto-fix 连续唤醒、mcp__pr__* 工具
import { makePrSniffer } from '../../runtime/pr-monitor.mjs';
import { newGen, MAX_PARALLEL_CHATS, announceStart, recordPrefs, recordOrigin, closeTurn } from './turn-ledger.mjs';
import { warmRuns } from './warm.mjs';
import { pluginTap } from './emit.mjs';
import { armBgWatch } from './bg-hold.mjs';

// 开一轮：建 gen、占并发槽、把这条请求挂上去。返回 false = 没占到位（错误已回给请求）。
export function seatTurn(run, res) {
  const { message, attachments, source, limitResume, globalMax, ctx, family, isSpare, ownSid, memberCaps, billTo } = run.plan;
  run.gen = newGen(run, message, source, ownSid, attachments);
  run.gen.family = family;   // 会话间发起的轮（session-family.mjs）：收尾时据此给父会话送汇报
  run.gen.autoTurn = !!limitResume || !!(family && family.origin && (family.origin.kind === 'routine' || family.origin.kind === 'idle-compact'));   // 额度重置后的自动续跑 / 定时任务：没人在场，sessions MCP 不替用户开会话（session-tools.mjs）
  // 全服上限：快照访客（c:）一个通道；注册用户（u:）合计一个通道（策略 maxUserTurns，0 = 不限）。管理员不设。
  const userCap = ctx.kind === 'user' ? getPolicy().maxUserTurns : 0;
  // 预热的占位「轮」不占并发槽、不登记——真消息接管时 warmTake 才为新一轮占位。
  // 每人同时在跑的轮数：成员按策略 maxParallelPerUser（0 = 不限），其余身份不限（MAX_PARALLEL_CHATS）。
  const perKeyCap = Math.min(MAX_PARALLEL_CHATS, memberCaps.maxParallel);
  const slot = isSpare ? { ok: true } : tryStartGen(ctx.key, run.gen, {
    maxPerKey: perKeyCap,
    singleSession: true,
    ...(ctx.snap && Number.isFinite(globalMax) ? { globalPrefix: 'c:', maxGlobal: globalMax }
      : userCap ? { globalPrefix: 'u:', maxGlobal: userCap } : {}),
  });
  if (!slot.ok) {
    const full = slot.reason === 'global';
    genWrite(res, full && ctx.snap
      ? { type: 'error', kind: 'busy', title: '快照通道繁忙', message: '现在同时进行的快照对话太多，稍等片刻再发送。' }
      : full
        ? { type: 'error', kind: 'busy', title: '服务器正忙', message: '现在大家同时在跑的对话已经到上限（' + userCap + ' 个），稍等片刻再发送这条消息。' }
        : slot.reason === 'session'
          ? { type: 'error', kind: 'busy', title: '会话正在启动', message: '这个会话已有一轮刚刚开始，请稍后再试。' }
          : { type: 'error', kind: 'busy', title: '并行对话已满', message: '同时最多 ' + perKeyCap + ' 个对话在跑。等一个完成，或到带呼吸点的对话里按「停止」，再重发这条消息。' });
    res.end();
    return false;
  }
  // 占到了位才记一轮（额度的轮数在开跑时算：并行发几轮也绕不过去）
  if (billTo) { try { noteTurnStart(billTo); } catch {} }
  if (!isSpare) genSubscribe(run.gen, res);
  // 定时任务（routines-runner.mjs）经重放发起：真占到位开跑了告诉它一声（收尾见 retireTurn 的 onEnd）
  if (family && typeof family.onStart === 'function') { try { family.onStart(run.gen); } catch {} }
  return true;
}

// 占到位以后搭台：开场广播与落盘、事件出口、各种记账器、心跳与看门狗、换号 / fast 回退的订阅。
// 这些字段的初值要用到 gen 与 send，所以不在 createRun 里；先后照旧（有的会当场发事件）。
export function stageRun(run) {
  const { message, sessionId, model, origin, ctx, snap, cpOwner, custom, turnPerm, prOn, routed, customFast, seamless } = run.plan;
  announceStart(run);
  recordPrefs(run);
  // 这条消息从哪台客户端发来（runtime/client-origins.mjs）：不写进提示词——停放的 CLI 跨轮、跨设备复用，
  // 写死就会过时；agent 要在用户本地做事时经 devices 工具现查。接力 / 预热接管 / 插话各自换成那条消息的。
  // 新会话同 recordPrefs：等 init 拿到 id 再记。
  run.turnOrigin = origin || null;
  run.turnText = message;
  recordOrigin(run);
  // Deliberately NOT aborting on client disconnect: the generation keeps running
  // and buffering so a refreshed page can reattach via /api/attach.
  run.send = (obj) => { if (!run.userStopped) { genEmit(run.gen, obj); pluginTap(run, obj); } };
  // 号名是管理员的数据：只告诉主机 admin，沙箱用户 / 快照访客不发。
  run.showAccounts = !snap && !ctx.sandbox;
  if (routed && run.showAccounts) run.send({ type: 'account_switch', from: routed.fromLabel, to: routed.toLabel, reason: reasonText(routed.reason) });
  // 会话中无缝换号：上游代理在两次模型请求之间换了号——这一轮照常往下跑，只给发起端弹个轻提示。
  //（订阅挂在主循环的 try 前面，finally 里摘掉。）
  // 智能分派按会话换号（sw.sid）：只提示被换的那个会话，别的会话照常跑在自己的号上。
  run.onUpstreamSwitch = (sw) => {
    if (sw.sid && sw.sid !== run.gen.sessionId) return;
    if (run.showAccounts && !run.gen.done) run.send({ type: 'account_switch', from: sw.fromLabel, to: sw.toLabel, reason: reasonText(sw.reason) });
  };
  // 多对话并发下 MCP 工具（媒体/agy/手机）不能再按 caller key 找「唯一活跃 gen」——
  // 会串到并行的另一轮。per-run 闭包把事件精确路由回发起调用的这一轮。
  run.getGen = () => run.gen;
  run.plan.lateGen.get = run.getGen;   // 启动方案里先交给插件的那个 getGen 到这里才接得上

  // 含后台 shell 的悬停封顶：到点以暂存 result 定局并收残局（常驻服务不许把轮次钉到天荒地老）。
  run.BG_SHELL_HOLD_MS = Math.max(60_000, Number(process.env.BRIDGE_BG_HOLD_MS) || 60 * 60_000);
  run.lastMsgAt = Date.now();
  // show_widget 的参数增量 → widget_* 帧（mcp/visualize.mjs）：流式渲染、定稿、tool_result 收尾
  run.widgets = makeWidgetStream(run.send, run.getGen);
  // 流里认 PR（code_change_published / <pr-created> / gh pr create 的输出）→ 绑到本会话（pr-monitor.mjs）
  run.prSniff = prOn ? makePrSniffer(ctx, () => run.gen.sessionId, run.limitReplay) : null;
  // 工作流 agent 档位的直播来源：本会话的 subagents 目录（worktree 会话的 cwd 以 init 帧为准）+ 按 agent 的读盘缓存
  run.wfLive = {
    cache: new Map(),
    dir() {
      const sid = run.gen.sessionId || sessionId;
      const sp = sid ? sessionPaths(sid, (run.gen.mirror && run.gen.mirror.cwd) || ctx.cwd, ctx.configDir) : null;
      return sp ? path.join(sp.subdir, 'subagents') : '';
    },
  };
  // ---- 撤回记账（模型安全栅门）----
  // client lane 下被拒那截半成品可能已经流给了前端（先 stream_event，再来 model_refusal_fallback 通知，
  // 再由回退模型重试）。通知只给被撤回帧的 uuid，前端的 text 段对不上 uuid；所以服务端按 uuid 记
  // 「每个主线程 assistant 帧覆盖了正文/思考/工具行的哪一段」，收到撤回名单就算出该删的【区间】发 retract
  //（区间而非尾截：通知 / 首帧 supersedes 常在回退模型的增量之后才到，见 runtime/retract-ledger.mjs 头注）。
  run.ledger = makeRetractLedger();
  // 按人记账的计价表：result 的 total_cost_usd 是 CLI 进程（续聊还含恢复的整段会话）的累计值，按「上一次」取差入账
  //（runtime/usage-ledger.mjs）。续聊时开跑前换成从 transcript 读出的起点，见下面 query 之前。
  run.costMeter = makeCostMeter(0);
  run.compactCmd = /^\s*\/compact(?:\s|$)/.test(String(message || ''));

  // Heartbeat to every attached subscriber so a long tool run doesn't look dead
  // and the tunnel doesn't idle-close.
  run.heartbeat = startMultiHeartbeat(run.gen.subscribers);

  run.bgWatch = armBgWatch(run);
  run.runModel = model;
  run.runPermMode = turnPerm.mode;
  run.askedPermMode = turnPerm.mode;

  // 跨会话消息（session-peers.mjs）：peerGate = 改这个 CLI 的入站闸（hold 档「待你确认」卡放行 / 拒收用）
  run.peerAware = peersOn(ctx, snap);
  if (seamless) upstreamEvents.on('switch', run.onUpstreamSwitch);
  // 自定义服务的 fast 被上游拒（fast 额度 429 / 没开通）：代理已按普通速度重发，这里在对话里说一声，芯片的「· Fast」跟着熄
  run.offFastFallback = customFast ? onFastFallback((ev) => {
    if (ev.pid !== custom.provider.id || ev.owner !== (custom.provider.owner || cpOwner) || run.gen.done) return;
    const minutes = Math.round(ev.cooldownMs / 60_000);
    run.send({ type: 'model_notice', subtype: 'model_fallback', trigger: 'fast_refused', scope: 'local', from: model, to: model, text: `Fast mode 被拒（${ev.status}），已改用普通速度，${minutes} 分钟内不再尝试`, at: Date.now() });
    if (run.gen.sessionId) run.send({ type: 'session', sessionId: run.gen.sessionId, model, fast: false });
  }) : null;
}

// 收场的前一半（在等 CLI 退出之前）：摘订阅、松开输入流、结清这一轮的台账。
export function detachRun(run) {
  const { turnInput } = run.plan;
  upstreamEvents.off('switch', run.onUpstreamSwitch);
  if (run.offFastFallback) run.offFastFallback();
  if (run.unbindMode) run.unbindMode();   // 会话中切模式的控制口跟着进程走
  turnInput.release(); // 松开输入流 gate——挂着的生成器结束，SDK 得以完全收尾
  closeTurn(run);
}

// 收场的后一半（CLI 已经收完）：撤掉各处对这个进程的登记，放行等它退干净的人。
export function sealRun(run) {
  const { ctx } = run.plan;
  if (run.offLive) run.offLive();
  // 进程没了：hold 档扣着的跨会话消息随之作废（session-peers.mjs）
  if (run.peerGate && run.gen.sessionId) dropPeerGate(ctx.key, run.gen.sessionId, run.peerGate);
  if (run.peerGate) unregisterPeerGate(ctx.key, run.peerGate);
  // 停放登记：走到这里子进程已收完，等着它退干净的人（同会话冷起 / releaseWarm）这才放行。
  if (run.warmEntry) {
    if (warmRuns.get(run.warmEntry.lk) === run.warmEntry) warmRuns.delete(run.warmEntry.lk);
    run.warmEntry.finish();
  }
  run.markExited();
}
