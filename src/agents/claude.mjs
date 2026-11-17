// Claude chat branch. BUFFERED for reattach: each in-flight generation is held
// in runtime/gen.mjs's per-caller gen list; subscribers (initial POST + later
// /api/attach) live-receive events and the buffered backlog. Disconnect does
// NOT abort — only explicit POST /api/stop or a same-session resend does.
// Different sessions run in PARALLEL (multi-conversation concurrency, capped).

import './claude/load-order.mjs';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
// 测试接缝：特征测试要跑真的 runClaudeChat 而不起 CLI 进程，用按剧本吐消息的假 query 换掉 SDK 的。
// 只供测试调用；不传参数 = 换回 SDK 的。
let query = sdkQuery;
export function _setQueryForTest(fn) { query = typeof fn === 'function' ? fn : sdkQuery; }
import { sessionPaths } from '../runtime/paths.mjs';
import { sanitizeSessionThinking } from '../runtime/session-sanitize.mjs';
import { makeCostMeter, sessionCostBaseline } from '../runtime/usage-ledger.mjs';
import { setLimitResumePool } from '../runtime/limit-resume.mjs';
// 与官方 Claude Desktop / 终端会话互发（CLI 自带跨会话通道；只给主机管理员）：env 开关、入站闸、停放 CLI 接住对方消息开的轮
import { registerPeerGate } from '../runtime/session-peers.mjs';
import { CLAUDE_IN_CHROME } from '../config/index.mjs';
import { ensureChromeNativeHost } from '../runtime/chrome-native-host.mjs';
import { noteLimitHit, poolAvailableAt } from '../runtime/account-router.mjs';
// 撞墙全员用尽时，自动续跑等号池里最先恢复的那个号（不是撞墙那个号自己的重置点）
setLimitResumePool(poolAvailableAt);
// 权限模式 / 逐次工具审批卡 / 计划审批卡（2026-10-20，见 runtime/permissions.mjs 头注）
import { deferredModeFor } from '../runtime/permissions.mjs';
import { handedTurn } from '../runtime/turn-timing.mjs';
import './claude/sdk-warnings.mjs';
import { sleep } from './claude/warm.mjs';
import { planTurn } from './claude/plan.mjs';
import { admitTurn } from './claude/admit.mjs';
import { createRun } from './claude/run-state.mjs';
import { emitDone, closeTurn } from './claude/turn-ledger.mjs';
import { notePermMode, armPermGate } from './claude/permission.mjs';
import { holdPhantomResult, noteResult, settleSoftStop, judgeResult, reportTurnError, settleEffort, captureContextUsage } from './claude/result.mjs';
import { armGen } from './claude/controls.mjs';
import { parkSpare, readNext, parkWarm } from './claude/parking.mjs';
import { onFrame } from './claude/frames.mjs';
import { deferResult } from './claude/bg-hold.mjs';
import { seatTurn, stageRun, detachRun, sealRun } from './claude/lifecycle.mjs';
import { buildQueryOptions } from './claude/options.mjs';
import { reportRunError } from './claude/errors.mjs';
export { hostNudge, USER_NUDGE, REGULAR_NUDGE, NO_SHELL_MSG, mediaNudge, identityNudge } from './claude/prompts.mjs';
export { hasClaudeLogin, chromeEngineEnv } from './claude/chrome.mjs';
export { withinDir, absPathViolation, sandboxViolation, SHELL_DENY, sharedExtRead, maskSharedRoot, readRootDecision, sandboxFence, makeSandboxPreToolUse } from './claude/sandbox.mjs';
export { MAX_PARALLEL_CHATS } from './claude/turn-ledger.mjs';
export { makeTurnInput, composeTurnPrompt } from './claude/turn-input.mjs';
export { isPhantomResult } from './claude/result.mjs';
export { releaseWarmClaude, releaseWarmOf, spareStatus } from './claude/warm.mjs';

// 启动时校正一次 native host 入口（上次运行留下的路径可能已随升级失效），见 chrome-native-host.mjs。
if (CLAUDE_IN_CHROME) ensureChromeNativeHost();

export async function runClaudeChat(req, res, input) {
  const plan = await planTurn(req, res, input);
  if (!plan) return;
  const { sessionId, model, ctx, snap, isSpare, permPolicy, billTo, turnInput, servedAcct } = plan;

  if (await admitTurn(plan, req, res)) return;

  const run = createRun(plan);
  if (!seatTurn(run, res)) return;
  stageRun(run);
  try {
    // The SDK persists extended-thinking blocks to the session log with their text
    // emptied but the signature kept; on resume the API can 400 on those dead blocks.
    // Strip them from this session's transcript before the SDK replays it — content
    // (text / tool_use / tool_result) is preserved, only already-empty thinking goes.
    if (sessionId) {
      const sp = sessionPaths(sessionId, ctx.cwd, ctx.configDir);
      if (sp) { try { const r = sanitizeSessionThinking(sp.file); if (r && r.dropped) console.log(`[sanitize] ${sessionId.slice(0, 8)} dropped ${r.dropped} dead thinking block(s)`); } catch {} }
      // 续聊：CLI 会从该会话最后一条 cost-state 恢复整段会话的累计花费——以它为起点取差，别把历史再记一遍
      if (sp && billTo) { try { run.costMeter = makeCostMeter(await sessionCostBaseline(sp.file, sessionId)); } catch {} }
    }
    armPermGate(run);
    if (!isSpare) handedTurn(req, sessionId, 'cold');
    run.q = run.qHandle = query({ prompt: turnInput.stream, options: buildQueryOptions(run) });

    // v = null：清掉 flag 内联层里 bridge 写过的值，回到 spawn 时 --settings 里的（「跟随 Claude 默认」时那里没有这个键 = CLI 默认）
    if (run.peerAware) run.peerGate = (v) => run.q.applyFlagSettings({ crossSessionInbound: v || null });
    // 设置「其它会话发来的消息」一改就当场换到这个 CLI 上（session-peers.mjs）；预热的那个被接走时才登记（之前一直关着）
    if (run.peerGate && !isSpare) registerPeerGate(ctx.key, run.peerGate);

    armGen(run, run.gen);

    // 预热：停在第一轮之前，被新会话接管才往下读；没人接就收尾退出（finally 关进程）。
    if (isSpare && !(await parkSpare(run))) return;

    while (true) {
      const step = await readNext(run);
      if (step.done) { run.iterDone = true; break; }
      const msg = step.value;
      run.lastMsgAt = Date.now();
      if (run.prSniff) run.prSniff(msg);
      // 硬停止后：这一轮对界面已收尾，只等被打断那轮的 result 就走正常收尾（见 hardStop）。
      if (run.userStopped) { if (msg.type === 'result') break; continue; }
      // 幻影 result 之后只要还有任何消息（正常是紧接着的第二个 init），兜底计时器就作废。
      if (run.phantomTimer && msg.type !== 'result') { clearTimeout(run.phantomTimer); run.phantomTimer = null; }
      if (msg.type !== 'result') { onFrame(run, msg); continue; }
      if (holdPhantomResult(run, msg)) continue;
      noteResult(run, msg);
      if (run.softStopping) {
        if (settleSoftStop(run, msg)) continue;
        break;
      }
      const { apiStatus, errored, hasText, limitKind, lim } = judgeResult(run, msg);
      const failover = limitKind ? await noteLimitHit(servedAcct(run.gen.sessionId), {
        kind: limitKind,
        type: lim ? lim.type : '',
        resetsAt: lim ? lim.resetsAt : 0,
        model,
        sid: run.gen.sessionId || '',
      }) : null;
      if (!reportTurnError(run, msg, { apiStatus, errored, hasText, limitKind, lim, failover })) {
        if (deferResult(run, msg)) continue;
        emitDone(run, msg);
        // ultracode 轮的 effort 实况（getSettings，同 getContextUsage 的时机：result 后、break 前）。
        await settleEffort(run);
        // 上下文用量分布（SDK 0.3.257 query.getContextUsage）：done 已发、break 之前趁子进程还
        // 活着拿【精确档】（detail:'full' 按类别真打 count_tokens，实测 ~1.5s；'summary' 只 11ms
        // 但是本地估算、没有 Messages 行、System tools 高估 50%）。前端收到 done 已清忙态，这
        // 1.5s 只延后进程收尾；事件进 gen 缓冲，attach 重放 / /api/status 都拿得到。
        await captureContextUsage(run, msg);
        // 停放：台账先结清（界面、别的设备、并发槽都当这轮已结束），CLI 留着等同会话下一条消息
        //（顺带收输入建议）。被接走就 continue 接着读新一轮；否则照旧收尾退出。快照访客不停放。
        if (!snap && !run.userStopped && !run.abort.signal.aborted) {
          closeTurn(run);
          // 干活时选的绕过权限（官方「这一轮结束后开启」）：定局了，停放前切过去（runtime/permissions.mjs deferredModeFor）
          const dm = permPolicy !== 'host' ? deferredModeFor(ctx, msg.session_id || run.gen.sessionId, run.runPermMode) : null;
          if (dm) { try { await run.q.setPermissionMode(dm); notePermMode(run, dm, 'user'); } catch (e) { console.log('[claude] deferred setPermissionMode failed:', e && e.message); } }
          if (await parkWarm(run, msg.session_id || run.gen.sessionId)) continue;
        }
      }
      // 本轮已定局（正常 done 或错误）——由我们跳出，finally 里 q.return() →
      // SDK cleanup 关掉子进程（悬停路径在上面 continue，不走到这）。
      // 悬停期存的旧 result 一并作废：这一轮若以错误定局（撞限额、换号），循环外的兜底不许再拿它
      // emitDone——那会把刚挂上的自动续跑当「正常收尾」撤掉，还推一条「这一轮跑完了」。
      run.heldResult = null; run.interimResult = null;
      break;
    }
    // 流自然走到头（CLI 进程自己停了）而 done 还没发：悬停期存的最后一个 result 定局，
    // 别让这轮无声无息地断掉（正常路径都在 break 前发过 done，这里只有悬停期会命中）。
    if ((run.heldResult || run.interimResult) && !run.doneEmitted) {
      console.log('[claude] stream ended while holding for background tasks — finalizing with last result');
      emitDone(run, run.heldResult || run.interimResult);
    }
  } catch (err) {
    reportRunError(run, err);
  } finally {
    detachRun(run);
    // 以前 for-await 的 break 会自动调迭代器 return()（SDK cleanup：关 stdin、等 CLI 退、必要时杀）；
    // 手动读循环要自己调。没有悬着的 next() 时它很快；兜底 10s 后硬关。
    if (run.qHandle && !run.iterDone) {
      try { await Promise.race([run.qHandle.return(undefined), sleep(10_000)]); } catch {}
      try { run.qHandle.close(); } catch {}
    }
    sealRun(run);
  }
}
