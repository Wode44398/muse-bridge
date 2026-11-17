// 后台任务悬停与收轮：悬停清单、看门狗的三道兜底、用户主动结束等待。

import { emitDone } from './turn-ledger.mjs';

// ---- 后台任务悬停收轮（08-27 agent/workflow；09-15 起后台 shell 同治）--------
// SDK 'background_tasks_changed' 是存活后台任务的全量电平信号（replace 语义）。
// 出 result 时若还有【非 ambient】的后台任务在跑，本轮【悬停】：不发 done、不 break，
// 等 CLI 在任务完成时注入 task-notification 自动续轮（实验验证：输入流挂住时 CLI 会
// 续轮且 canUseTool 通道存活）；最终后台清零的那个 result 才定局。
// 09-15：local_bash 不再豁免。旧策略怕「常驻 dev server 把轮次钉死」而放后台 shell 走，
// 代价是模型「起个后台批处理 → end_turn → 等通知」必被腰斩（08-27 第三变种、09-15 维护者
// 报的批量中断都是它）。裸 SDK 探针实测（scratchpad/bg-probe.mjs）：release+break 后 ~8s
// CLI 就把后台 shell 杀掉（12 个 tick 只跑出 2 个）；悬停则跑满 12 个，并自动注入
// task-notification 唤醒模型汇报结果。常驻服务的代价改用【封顶】兜住，见 bgWatch。
const AGENTISH = new Set(['local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow']);

const BG_EMPTY_GRACE_MS = 2 * 60_000;   // 任务表清零却没等来续轮：静默这么久就定局

// 存活的非 ambient 后台任务（ambient = CLI 自己的杂务 watcher，SDK 明说不该进活动指示）。
export function liveBgTasks(run) {
  return run.bgTasks.filter((t) => t && t.task_id && !t.ambient && !run.cutShells.has(t.task_id));
}

// 悬停提示的载荷：电平信号只有 id/type/description，shell 的命令行只有 Stop hook 给得出。
export function bgPayload(run, list) {
  return list.map((t) => {
    const info = run.bgInfo.get(t.task_id) || {};
    return {
      taskId: t.task_id,
      taskType: t.task_type || '',
      kind: info.type || '',                                   // shell / subagent / workflow / monitor
      description: t.description || info.description || '',
      command: info.command || '',
      status: info.status || 'running',
    };
  });
}

// 封顶时刻（前端提示「到点自动收尾」用）：只有【纯后台 shell】的悬停才会到点整轮收尾；
// 有 agent/workflow 的悬停到点只掐 shell、本轮继续（见 bgWatch），没有整轮硬期限 → 0。
export function bgDeadline(run, list) {
  return (run.holdStartedAt && list.length && !list.some((t) => AGENTISH.has(t.task_type)) ? run.holdStartedAt + run.BG_SHELL_HOLD_MS : 0);
}

// 悬停期的三道兜底（都以暂存 result 定局 + abort 收残局，reason 只进日志与 bg_release 事件）：
//  ① silence —— 悬停集合【全是 agent/workflow】却整整 15 分钟一条消息都没有：跑着的子 agent
//     开着 agentProgressSummaries，每 ~30s 该有 task_progress，全静音=CLI 侧已死/卡死。
//     后台 shell 没有这种心跳（一个跑 40 分钟的批处理本来就一声不吭），所以这条只对 agent 集合用。
//  ② drained —— 任务表已清零却没等来续轮（正常是几秒内 task_notification + 新 init）。
//  ③ timeout —— 后台 shell 逐条封顶：常驻 dev server 不许把这一轮钉死。
//     09-23 前是「含 shell 的悬停整体到点 → abort 整轮」：GARGANTUA 那轮一个卡死的 chrome 探测
//     满 60 分钟，把正在正常干活的 6-agent 工作流连同集成阶段一起腰斩。现在到点时若还有
//     agent/workflow 在跑，只 stopTask 超时的 shell（记进 cutShells、不再算存活），本轮继续悬停，
//     之后由 ①② 收尾；只剩 shell 时才按原样整轮定局。
const BG_HOLD_SILENCE_MS = 15 * 60_000;

function finalizeHold(run, reason) {
  if (!run.heldResult || run.doneEmitted) return;
  run.bgFinalized = true;
  console.log(`[claude] bg-hold finalize (${reason}) — finalizing with last result, aborting leftovers`);
  run.send({ type: 'bg_release', reason });
  emitDone(run, run.heldResult);
  try { run.abort.abort(); } catch {}
}

function bgTick(run) {
  if (!run.heldResult || run.doneEmitted) return;
  const now = Date.now();
  const live = liveBgTasks(run);
  const shells = live.filter((t) => !AGENTISH.has(t.task_type));
  for (const t of shells) if (!run.shellSeenAt.has(t.task_id)) run.shellSeenAt.set(t.task_id, now);
  const agentOnly = live.length > 0 && !shells.length;
  // 有审批卡在等人（后台子 agent 要批）：等审批的 agent 本来就一声不吭，别按静默判死把它连同这一轮收掉
  const quiet = run.permGate && run.permGate.pending() ? 0 : now - run.lastMsgAt;
  if (agentOnly && quiet > BG_HOLD_SILENCE_MS) finalizeHold(run, 'silence');
  else if (!live.length && quiet > BG_EMPTY_GRACE_MS) finalizeHold(run, 'drained');
  else if (shells.length) {
    const overdue = shells.filter((t) => now - run.shellSeenAt.get(t.task_id) > run.BG_SHELL_HOLD_MS);
    if (!overdue.length) return;
    if (shells.length === live.length) { finalizeHold(run, 'timeout'); return; }
    for (const t of overdue) {
      run.cutShells.add(t.task_id);
      console.log(`[claude] bg-hold shell cap — stopping ${t.task_id} (${t.description || t.task_type}), agents keep running`);
      Promise.resolve(run.gen.stopTask?.(t.task_id)).catch(() => {});
    }
    const rest = liveBgTasks(run);   // 停不掉也照样从挂起清单里摘掉
    run.send({ type: 'bg_hold', count: rest.length, tasks: bgPayload(run, rest), deadline: bgDeadline(run, rest) });
  }
}

// 每轮一个看门狗（closeTurn 停掉；停放的 CLI 被下一条消息接着用时 warmTake 重挂）。
export function armBgWatch(run) { const t = setInterval(() => bgTick(run), 15_000); if (t.unref) t.unref(); return t; }

// 用户主动「结束等待」（POST /api/stop {release:true}）：按正常定局收尾，而不是留一条「已中断」。
export function releaseHold(run) {
  if (!run.heldResult || run.doneEmitted) return false;
  finalizeHold(run, 'user');
  return true;
}

// 存活后台任务全量电平（replace 语义）——悬停收轮的判据，见声明处注释。
export function onBgTasksChanged(run, msg) {
  run.bgTasks = Array.isArray(msg.tasks) ? msg.tasks : [];
  for (const t of run.bgTasks) if (t && t.task_id && t.task_type && !run.taskTypes.has(t.task_id)) run.taskTypes.set(t.task_id, t.task_type);
  // 悬停期任务表变了（一个跑完还剩两个之类）：把新的挂起清单推给前端，计数与面板跟着变。
  // 清零那一刻也发（count:0 = 后台任务已完成、正在等模型续轮）。
  if (run.heldResult && !run.doneEmitted) {
    const live = liveBgTasks(run);
    run.send({ type: 'bg_hold', count: live.length, tasks: bgPayload(run, live), deadline: bgDeadline(run, live) });
  }
}

// 后台任务（子 agent / 工作流 / 后台 shell）还活着 → 本轮悬停：不发 done、不 break。
// CLI 会在任务完成时注入 task-notification 自动续轮，后续消息继续走本循环，
// 最终（后台清零的那个）result 才定局。gate 挂着输入流，权限通道保持存活。
// 接力来的用户消息还没答（这个 result 是 CLI 先跑的中间轮，比如后台任务完成通知）——接着读。
// queued_turn_count>0 同理：CLI 队列里还有用户消息，后面必有它们的轮与 result。
// 返回 true = 先不定局，循环接着读。
export function deferResult(run, msg) {
  if (run.awaitingUser.size || msg.queued_turn_count > 0) {
    run.interimResult = msg;
    console.log(`[claude] interim result while ${run.awaitingUser.size || msg.queued_turn_count} handed-off message(s) wait their turn — reading on`);
    return true;
  }
  const holdFor = liveBgTasks(run);
  if (holdFor.length) {
    run.heldResult = msg;
    if (!run.holdStartedAt) run.holdStartedAt = Date.now();
    run.send({ type: 'bg_hold', count: holdFor.length, tasks: bgPayload(run, holdFor), deadline: bgDeadline(run, holdFor) });
    console.log(`[claude] result with ${holdFor.length} live background task(s) [${holdFor.map((t) => t.task_type).join(',')}] — holding the turn open`);
    return true;
  }
  return false;
}
