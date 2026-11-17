import { genFinish, retireGen } from '../../runtime/gen.mjs';
import { busPublish } from '../../runtime/bus.mjs';
import { beginInflight, endInflight } from '../../runtime/inflight.mjs';
import { getContextUsage } from '../../runtime/ctx-usage.mjs';
import { sessionQuestions, pendingFor } from '../../runtime/questions.mjs';
import { VAULT } from '../../config/index.mjs';
import { sessionPaths } from '../../runtime/paths.mjs';
import { mirrorSessionNow } from '../../runtime/desktop-mirror.mjs';
import { transcriptTailCwd, collectDeliverables, deliverRoots, deliverAnywhere } from '../../runtime/deliverables.mjs';
import { noteRunEnd } from '../../runtime/claude-queue.mjs';
import { noteTurnSettled as noteLimitTurnSettled } from '../../runtime/limit-resume.mjs';
import { familyTurnEnded } from '../../runtime/session-family.mjs';
import { claudeCacheTtl, scheduleClaudeIdleCompact } from '../../runtime/claude-cache.mjs';
import { getClaudeSettings } from '../../runtime/claude-settings.mjs';
import { releaseLease } from '../../runtime/phone-control.mjs';
import { recordMessageOrigin } from '../../runtime/client-origins.mjs';
import { recordChatPrefs } from '../../runtime/chat-prefs.mjs';
import { noticeRunStart, noticeRunEnd } from '../../runtime/notices.mjs';

// 一轮的台账：占并发槽、开场广播、收轮结清。

// 每个 caller 同时最多几个对话并行（多对话并发上限）。09-30 维护者要求不设限（原为 3）：并行轮共享
// 同一个订阅账号的额度和这台 PC 的算力，开得多 5 小时窗烧得快，由使用者自己把握。同一会话永远串行；
// 注册用户 / 快照访客的全服上限（policy.maxUserTurns / 快照通道）是另一道闸，不受此影响。
// 小内存服务器（Muse Bridge 的 8G VM 等）由部署用 BRIDGE_MAX_PARALLEL_CHATS 给个数（正整数，别的值当不限）。
export const MAX_PARALLEL_CHATS = (() => {
  const n = Number(process.env.BRIDGE_MAX_PARALLEL_CHATS);
  return Number.isInteger(n) && n > 0 ? n : Infinity;
})();

// 一个 gen = 界面上的【一轮】（一条用户消息 + 它的回答）；一次 query（一个 CLI 进程）通常只有一轮，
// 挂起接力时一个进程会先后承载好几轮——gen 随之换新（见 gen.handoff），abort 仍是整个进程的。
export function newGen(run, userText, src, sid, atts) {
  return ({
    sessionId: sid || null,
    userText,
    userAtts: Array.isArray(atts) ? atts.slice() : [],   // 这一轮用户附的文件（绝对路径）：/api/attach 重放时据此把气泡里的图补回来

    source: src || null, // 'capsule' = 悬浮胶囊发起（/api/active 透出，网页端镜像轮询据此不挂载）
    events: [],
    subscribers: new Set(),
    abort: run.abort,
    done: false,
    startedAt: Date.now(), // boundary for reattach: transcript msgs at/after this belong to this in-flight turn
    settled: new Promise((r) => { run.settleGen = r; }),
  });
}

// 同账号的【别的设备】据此 0 延迟挂上这一轮的直播（以前靠 4s 轮询 /api/active 才发现）。
// resume 的会话这里就有 sessionId；新会话要等 SDK 的 init 消息，那边再播一次，
// 客户端按 sessionId 幂等处理。
// 每一轮（gen）对同一个 id 只播一次：续聊 / 接力的轮开跑时已经有 id，随后每轮的 init 帧又会调一次——以前同一轮成对推两帧 run.start。
// init 带来的是新 id（新会话 / 分叉）才再播。
export function announceStart(run) {
  const { sessionId, ctx, family } = run.plan;
  if (!run.gen.sessionId || run.announced.get(run.gen) === run.gen.sessionId) return;
  run.announced.set(run.gen, run.gen.sessionId);
  // 落盘台账：进程要是死在这一轮中间，下次启动能凭它在 transcript 上留下「被中断」，
  // 而不是让这轮无声无息地断在一个 tool_result 上（见 runtime/inflight.mjs）。
  beginInflight({
    key: ctx.key,
    sessionId: run.gen.sessionId,
    agent: 'claude',
    userText: run.gen.userText || '',
    startedAt: run.gen.startedAt,
    cwd: ctx.cwd,
    configDir: ctx.configDir || null,
    // 服务意外重启后自动继续（runtime/restart-resume.mjs）：凭这一轮的请求在下一条命里重放一句「继续」；
    // restartResume = 这一轮本身是第几次自动续跑（人发的没有 = 0），连续续跑的次数靠它封顶
    dataDir: ctx.dataDir || '',
    replay: run.limitReplay || null,
    resume: Number(run.limitReplay && run.limitReplay.body && run.limitReplay.body.restartResume) || 0,
  });
  busPublish(ctx.key, {
    type: 'run.start',
    sessionId: run.gen.sessionId,
    userText: run.gen.userText || '',
    startedAt: run.gen.startedAt,
    source: run.gen.source || null,
    // 新会话（不是续聊）：侧栏收到这一帧就地插一行，不等 transcript 落盘后的整表重拉（那要晚好几秒）。
    // projectId = 它落在哪个项目（缺省项目不带）；parentId = 派生它的父会话（子会话直接挂到父行下面）。
    ...(sessionId ? {} : {
      fresh: true,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      ...(family && family.origin && family.origin.kind === 'spawn' && family.origin.from && family.origin.from[0] ? { parentId: family.origin.from[0] } : {}),
    }),
  });
  noticeRunStart(ctx, run.gen);   // 会话消息通知：先把会话标题解析好（提问 / 收尾时用）
}

// 会话级选择器记忆：本轮实际用的 model/effort/fast 记进 sidecar（chat-prefs.mjs），
// 重开会话时选择器恢复。resume 一开始就有 id；新会话等 init 拿到 id 再记。
export function recordPrefs(run) {
  const { ctx } = run.plan;
  if (run.prefsRecorded || !run.chatPrefs || !run.gen.sessionId) return;
  run.prefsRecorded = true;
  try { recordChatPrefs(ctx, run.gen.sessionId, run.chatPrefs); } catch {}
}

export function recordOrigin(run) {
  const { ctx } = run.plan;
  if (run.originRecorded || !run.turnOrigin || !run.gen.sessionId) return;
  run.originRecorded = true;
  try { recordMessageOrigin(ctx, run.gen.sessionId, run.turnOrigin, run.turnText); } catch {}
}

export function setTurnOrigin(run, o, text) { run.turnOrigin = o || null; run.turnText = text; run.originRecorded = false; recordOrigin(run); }

// 轮次收尾台账（每轮一次）：SSE 收口、inflight 销账、run.end、并发槽让位。正常在 finally 里做；
// 停放 CLI 前提前做——那段时间 CLI 还活着，但这一轮对人、对别的设备、对并发上限都已结束。
export function closeTurn(run) {
  if (run.turnClosed) return;
  run.turnClosed = true;
  clearInterval(run.bgWatch);
  clearTimeout(run.phantomTimer);
  clearTimeout(run.interruptTimer);
  retireTurn(run);
}

// 当前这一轮（gen）的台账：挂起接力换 gen 时单独结清旧轮，CLI 与后台任务不动。
export function retireTurn(run) {
  const { model, ctx, snap, cpOwner } = run.plan;
  clearInterval(run.heartbeat);
  // The turn is over — any question it was waiting on is moot. Clear the
  // pending marker so the conversation list doesn't show a stale "待回答".
  if (run.gen.sessionId) sessionQuestions.delete(run.gen.sessionId);
  genFinish(run.gen);
  // 这一轮已经有结局（正常收尾 / 报错 / 被 stop）——从落盘台账销账，
  // 不然下次启动会把它误判成「进程死在中途」的孤儿。
  if (run.gen.sessionId) endInflight(ctx.key, run.gen.sessionId);
  // 手机操控：这一轮占着的手机（设备租约）立即放掉，别的会话不用干等 90 秒（runtime/phone-control.mjs）
  if (run.gen.sessionId) { try { releaseLease(run.gen.sessionId, ctx.key); } catch {} }
  // 别的设备据此把呼吸点熄掉、并（若正看着这个会话）在直播流收尾后转回静态跟随。
  // pending：这一轮的卡都作废了，但同会话还可能扣着跨会话消息等你确认（pendingFor 把它算上）——别让 run.end 把那颗点熄了
  if (run.gen.sessionId) busPublish(ctx.key, { type: 'run.end', sessionId: run.gen.sessionId, pending: pendingFor(run.gen.sessionId, ctx.key) });
  // 会话消息通知（runtime/notices.mjs）：完成 / 出错按会话各出一条（手机后台服务、网页横幅、铃声震动都读它）
  try { noticeRunEnd(ctx, run.gen); } catch (e) { console.log('[notices] turn-end failed:', e && e.message); }
  // 这一轮收尾了：有排队消息（Ctrl+Enter）就合并发出（claude-queue.mjs，稍后检查确实没有新一轮接上）
  if (run.gen.sessionId) noteRunEnd(ctx.key, run.gen.sessionId);
  // 会话派生：子会话这一轮是父会话发起的 → 汇报进父会话收件箱，该唤醒谁就唤醒谁（session-family.mjs）
  if (run.gen.sessionId && !snap) { try { familyTurnEnded(ctx, run.gen); } catch (e) { console.log('[family] turn-end hook failed:', e && e.message); } }
  // 设置「提示缓存快过期时 = 自动压缩」：按这个会话的缓存寿命排一次空闲压缩（runtime/claude-cache.mjs；新一轮开跑就撤）
  if (run.gen.sessionId && !snap) {
    try {
      const ttlMin = getContextUsage(ctx.key, run.gen.sessionId)?.cacheTtlMin ?? claudeCacheTtl(run.runModel || model, cpOwner).minutes;
      scheduleClaudeIdleCompact({ key: ctx.key, sid: run.gen.sessionId, mode: getClaudeSettings(ctx).cacheExpiry, replay: run.limitReplay, ttlMin, ctx });
    } catch (e) { console.log('[idle-compact] schedule failed:', e && e.message); }
  }
  // 定时任务：这一轮的结局（done / error / interrupted 都在 gen.events 里）交回运行器记进运行记录
  if (run.gen.family && typeof run.gen.family.onEnd === 'function') { try { run.gen.family.onEnd(run.gen); } catch (e) { console.log('[routine] turn-end hook failed:', e && e.message); } }
  if (run.settleGen) run.settleGen();
  // 完成的轮【长保留】（同会话下一轮开跑时替换 + LRU/时效兜底，见 gen.mjs）：
  // 手机离开多久回来都能 /api/attach 整轮重放（含最终 done），不再有 60s 悬崖。
  retireGen(ctx.key, run.gen);
}

// done 的唯一出口（正常收轮 / 悬停后最终收轮 / 看门狗与流意外终止的兜底共用）。
export function emitDone(run, rmsg) {
  const { ctx, snap, custom } = run.plan;
  if (run.doneEmitted) return;
  run.doneEmitted = true;
  // 正常收尾：之前撞的限额（若有）翻篇，等着的自动续跑作废（续跑轮自己跑完也走这里）。
  if (!snap && (rmsg.session_id || run.gen.sessionId)) noteLimitTurnSettled(ctx.key, rmsg.session_id || run.gen.sessionId);
  // 每轮结束刷新 Desktop 索引（最后活动时刻、标题、归档态）；Desktop 接手过的那份不再碰
  if (!snap && run.gen.mirror && (rmsg.session_id || run.gen.sessionId)) {
    const mid = rmsg.session_id || run.gen.sessionId;
    mirrorSessionNow(ctx, mid, { file: sessionPaths(mid, run.gen.mirror.cwd, ctx.configDir)?.file, hint: run.gen.mirror });
  }
  // done 发出 → 收尾还要 1–3s（effort 定局、上下文用量），之后才 closeTurn + 停放。这期间同会话来的
  // 下一条消息认这个标记：等它收完再接着用停放的 CLI，而不是把它当「还在跑」顶掉（顶掉 = 杀进程冷起）。
  run.gen.finalizing = true;
  // 下一条已经在等（fin-wait）就喊一声：收尾里最慢的上下文用量（首次 ~6s）改到后台收完，不挡下一轮。
  run.finHurry = new Promise((r) => { run.gen.hurry = r; });
  // 产物附件：最终回答里 markdown 链接指向的真实文件/文件夹（根守卫内）→ 附件卡。
  let attachments = [];
  // nav = 文件夹卡「在工作空间里打开」的定位。项目制下 ctx.cwd 已被覆写成项目目录，
  // 身份原本的文件根由 chat.mjs 一并传进 ctx.homeRoot（没有项目时两者本就相同）。
  try {
    // 模型这一轮若 cd 进过子目录，会按新目录写相对链接：transcript 末尾记录的 cwd 排在项目根前面。
    const sp = rmsg.session_id ? sessionPaths(rmsg.session_id, ctx.cwd, ctx.configDir) : null;
    const turnCwd = sp ? transcriptTailCwd(sp.file) : '';
    attachments = collectDeliverables(rmsg.result, {
      cwd: turnCwd && turnCwd !== ctx.cwd ? [turnCwd, ctx.cwd] : ctx.cwd,
      roots: deliverRoots(ctx, ctx.cwd, VAULT),
      nav: { fileRoot: ctx.homeRoot || ctx.cwd, ws: ctx.cwd, shell: !!ctx.shell },
      anywhere: deliverAnywhere(ctx),
    });
  } catch {}
  run.send({
    type: 'done',
    result: rmsg.result ?? '',
    isError: Boolean(rmsg.is_error),
    cost: custom ? 0 : (rmsg.total_cost_usd ?? 0),   // 自定义 API：CLI 不认识型号，按 Claude 价目表瞎估的美元数，不报
    sessionId: rmsg.session_id,
    ...(attachments.length ? { attachments } : {}),
  });
}
