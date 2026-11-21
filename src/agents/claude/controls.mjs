// 挂在 gen 上的控制口：停后台任务、软停 / 硬停、挂起接力、插话与撤回。

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { startMultiHeartbeat } from '../../runtime/sse.mjs';
import { genEmit, tryStartGen, genWrite, genSubscribe } from '../../runtime/gen.mjs';
import { makeRetractLedger } from '../../runtime/retract-ledger.mjs';
import { noteTurnStart } from '../../users.mjs';
import { splitAttachments, toClientAtt } from '../../runtime/client-atts.mjs';
import { recordChatPrefs } from '../../runtime/chat-prefs.mjs';
import { isCustomModelId } from '../../runtime/claude-providers.mjs';
import { stricterMode } from '../../runtime/permissions.mjs';
import { closeTurn, emitDone, retireTurn, newGen, setTurnOrigin, announceStart } from './turn-ledger.mjs';
import { composeTurnPrompt } from './turn-input.mjs';
import { pluginTap } from './emit.mjs';
import { liveBgTasks, releaseHold } from './bg-hold.mjs';
import { notePermMode } from './permission.mjs';

// 单条停止后台任务（工作台任务面板的 ⏹）：控制请求 stop_task 走同一条活着的控制通道，
// 所以必须挂在这一轮的 gen 上（悬停期间通道正是活的，这也是能停的前提）。
// 停掉后 CLI 会发 background_tasks_changed + task_notification(stopped)，UI 照常收敛；
// 任务表清零后本轮按正常路径定局。
async function stopTask(run, taskId) {
  if (!taskId || run.doneEmitted) return false;
  await run.q.stopTask(String(taskId));
  return true;
}

// 停止键（POST /api/stop 不带 release）：后台任务还活着时只打断【当前这一轮作答】——官方 Esc 同款，
// 声明了 perTaskStopAffordance 的 interrupt 放过后台任务（探针实测：打断后后台 shell 照跑到完成、
// 照常触发完成通知续轮）。打断后的 result 走正常路径：后台任务还在 → 这一轮转入挂起。
// 返回 false = 调用方照旧 abort 整个进程：没有后台任务、或已经在挂起（那时停止 = 用户要连后台一起停，
// 老客户端在挂起期仍显示停止键，保持它原来的语义）。
function interruptTurn(run) {
  if (run.doneEmitted || run.bgFinalized || run.turnClosed || run.heldResult || !liveBgTasks(run).length) return false;
  console.log('[claude] stop with live background task(s) — interrupting the current reply only');
  run.softStopping = true;
  run.q.interrupt().catch(() => {});
  clearTimeout(run.interruptTimer);
  run.interruptTimer = setTimeout(() => {
    if (run.heldResult || run.doneEmitted) return;
    console.log('[claude] no result 10s after interrupt — aborting the run');
    try { run.abort.abort(); } catch {}
  }, 10_000);
  if (run.interruptTimer.unref) run.interruptTimer.unref();
  return true;
}

// 硬停止（没有后台任务、或已在挂起）。以前直接 abort：Windows 上 SDK 关 CLI 是「关 stdin → 等 2s →
// 再等 5s → SIGKILL」，主循环要等进程退出才抛出，于是停止键按下后这一轮还「活」7 秒以上——
// /api/active 照样列着它，前端同步内核把刚停掉的轮重新挂回来接着转圈，最后收到一张
//「出错了 — Operation aborted」错误卡（09-29 维护者报）。
// 现在：界面侧当场收尾（interrupted 事件 + 台账结清，重放缓冲以它结尾），CLI 在后台退——
// 先 interrupt 让它停笔、写下中断标记（transcript 干净，续聊不受影响），出 result 即 break
// 走正常收尾；3s 没回音再 abort。挂起中则直接 abort（用户要连后台任务一起停）。
function hardStop(run) {
  if (run.userStopped) return true;
  run.userStopped = true;
  run.doneEmitted = true;
  clearTimeout(run.interruptTimer);
  console.log('[claude] user stop — turn settled now, CLI shutting down in background');
  if (!run.turnClosed) {
    genEmit(run.gen, { type: 'interrupted', sessionId: run.gen.sessionId || null });
    pluginTap(run, { type: 'interrupted', sessionId: run.gen.sessionId || null });
    run.gen.stopping = run.procExited;
    closeTurn(run);
  }
  if (run.heldResult || run.bgFinalized) { try { run.abort.abort(); } catch {} return true; }
  run.q.interrupt().catch(() => {});
  const t = setTimeout(() => { try { run.abort.abort(); } catch {} }, 3000);
  if (t.unref) t.unref();
  return true;
}

// 挂起接力：挂起中（模型已停笔、后台任务在跑）同会话又来一条消息 → 上一轮按正常定局收尾
//（done + 附件卡、台账结清），新消息推进同一个 CLI 的输入流开新一轮；gen 换新，后台任务、
// 权限通道、封顶计时都原样延续。返回 false = 不接（这一轮并没在挂起），调用方照旧顶掉重开。
async function handoff(run, { res: nres, message: nmsg, attachments: natts, pin: npin, source: nsrc, model: nmodel, chatPrefs: nprefs, origin: norigin, family: nfam, permMode: nmode, permPolicy: npolicy, limitReplay: nreplay, auto: nauto }) {
  const { ctx, permPolicy, modelFor, billTo, turnInput } = run.plan;
  // 软停止刚打断这一轮、result 还没回（停止键 / 插话「立即打断」之后紧跟着发来的这条）：等它定局——
  // 转入挂起就照常接力（后台任务照跑），收尾了就回 false 走普通新一轮。以前这里直接回 false，
  // 调用方见上一轮没收尾就 abort，连后台任务一起杀掉。interruptTimer 10s 没 result 会 abort，这里多等一点。
  if (run.softStopping && !run.heldResult && !run.doneEmitted && !run.bgFinalized && !run.abort.signal.aborted) {
    const until = Date.now() + 11_000;
    while (run.softStopping && !run.heldResult && !run.doneEmitted && !run.bgFinalized && !run.abort.signal.aborted && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!run.heldResult || run.doneEmitted || run.bgFinalized || run.turnClosed || run.abort.signal.aborted) return false;
  // 权限策略不同不接（管理台代聊 = 宿主放行 / 用户自己发 = 弹卡）：停放复用靠 warmSig 分开，接力不过签名，要在这里拦。
  // 混用的后果：用户的这一轮全程宿主放行；或代聊把用户的会话模式改成 default、弹出控制台看不到的卡。
  // 回 'policy'（不是 false）：调用方据此回 busy，不能照「没在挂起」那样顶掉——顶掉会连后台任务一起杀掉。
  if (npolicy && npolicy !== permPolicy) return 'policy';
  // 换到 / 换出自定义 API 的模型：env（地址 / 鉴权）是 spawn 时定的，同一进程里换不了——不接（回 'model'，调用方回 busy，
  // 不顶掉挂起的后台任务）；等这一轮收掉，下一条消息按新模型冷起。
  if (nmodel && nmodel !== run.runModel && (isCustomModelId(nmodel) || isCustomModelId(run.runModel))) return 'model';
  // 权限模式先切（上一轮还没动）：切不过去、而要的比进程眼下的更严格 → 不接（'mode'，调用方回 busy）——
  // 不能让这条消息在更宽松的旧模式下跑（以前失败只打一行日志就照推）。切向更宽松的失败照旧用当前模式跑。
  // 等控制请求这一下让出了执行权：另一条接力这时进来不能也往下走（两条一起把上一轮收掉）——回 'busy'
  if (run.handoffSwitching) return 'busy';
  if (nmode && nmode !== run.runPermMode && permPolicy !== 'host') {
    run.handoffSwitching = true;
    try {
      try { await run.q.setPermissionMode(nmode); notePermMode(run, nmode, 'user'); }
      catch (e) {
        console.log('[claude] handoff setPermissionMode failed:', e && e.message);
        if (stricterMode(nmode, run.runPermMode)) return 'mode';
      }
    } finally { run.handoffSwitching = false; }
    if (!run.heldResult || run.doneEmitted || run.bgFinalized || run.turnClosed || run.abort.signal.aborted) return false;   // 等控制请求期间这一轮收了
  }
  const uuid = randomUUID();
  const next = composeTurnPrompt(npin ? npin.message : nmsg, npin ? npin.attachments : (natts || []));   // 插件改写过的那份（ctx.claude.input）
  const prevResult = run.heldResult;
  run.heldResult = null;
  emitDone(run, prevResult);
  retireTurn(run);
  run.gen = newGen(run, nmsg, nsrc, run.gen.sessionId, natts);
  run.gen.family = nfam || null;
  run.gen.autoTurn = !!nauto;
  // 并发槽原样继承（旧轮刚让出），只守「同会话一个写入者」。
  const slot = tryStartGen(ctx.key, run.gen, { singleSession: true });
  if (!slot.ok) {
    genWrite(nres, { type: 'error', kind: 'busy', title: '会话正在启动', message: '这个会话已有一轮刚刚开始，请稍后再试。' });
    nres.end();
    run.bgFinalized = true;
    try { run.abort.abort(); } catch {}
    return true;
  }
  setTurnOrigin(run, norigin, nmsg);
  if (billTo) { try { noteTurnStart(billTo); } catch {} }
  genSubscribe(run.gen, nres);
  armGen(run, run.gen);
  run.heartbeat = startMultiHeartbeat(run.gen.subscribers);
  // 每轮的计数与记账归零（后台任务表 / 任务门禁 / shell 封顶计时是整个进程的，不动）
  run.doneEmitted = false;
  run.interimResult = null;
  run.turnOut = 0; run.turnThink = 0;
  run.authFailed = false;
  run.turnRejection = null; run.limitFrame = null;
  run.compactAwait = ''; run.compactSeen = false;
  run.compactCmd = /^\s*\/compact(?:\s|$)/.test(String(nmsg || ''));
  run.hookLevel = null;
  run.ledger = makeRetractLedger();
  for (const k of Object.keys(run.streamBlocks)) delete run.streamBlocks[k];
  run.lastMsgAt = Date.now();
  run.awaitingUser.add(uuid);
  // 这一轮的请求身份换成接力进来的这条（清空上下文后执行 / 限额续跑 / 重启后自动继续重放用它）——
  // 先换再 announceStart：inflight 台账记的要是眼下这条请求
  if (nreplay) run.limitReplay = nreplay;
  announceStart(run);
  if (nprefs && run.gen.sessionId) { try { recordChatPrefs(ctx, run.gen.sessionId, nprefs); } catch {} }
  // 选择器换了模型：同一进程里 setModel（effort / fast 这类启动参数本轮沿用，下一次新开进程才生效）。
  if (nmodel && nmodel !== run.runModel) {
    try { await run.q.setModel(modelFor(nmodel)); run.runModel = nmodel; } catch (e) { console.log('[claude] handoff setModel failed:', e && e.message); }
  }
  // 后台子 agent 还在等的审批卡：重发进新一轮的缓冲、待回答点重新亮（retireTurn 刚把旧轮的清掉）
  if (run.permGate) run.permGate.rehome();
  // 权限模式：这一轮要的与进程眼下的不同（会话里切过 / 绕过权限待生效）→ 先切再推消息
  if (nmode && permPolicy !== 'host') run.askedPermMode = nmode;   // 模式已在接力开头切过
  turnInput.push(next.prompt, next.imageBlocks, uuid);
  console.log(`[claude] handoff — new message fed into the held run (${liveBgTasks(run).length} background task(s) keep running)`);
  return true;
}

// 插话（官方 Code 页：Claude 工作中按回车）：消息带 priority:'next' 推进【正在跑的】这一轮，
// CLI 做完手头这一步就读到，不打断、不另起一轮。界面上它是这一轮回答流里的一个插话气泡（steer 事件，
// 进可重放缓冲，别的设备 attach 也看得见）；CLI 读到 / 这轮答完时发 steer_state。
// 返回 uuid；返回 null = 现在插不进（这一轮已定局 / 挂起等后台任务 / 进程在收尾），调用方按普通发送处理。
function steer(run, { message: smsg, attachments: satts, origin: sorigin }) {
  const { ctx, turnInput } = run.plan;
  if (run.heldResult || run.doneEmitted || run.bgFinalized || run.turnClosed || run.userStopped || run.abort.signal.aborted) return null;
  const uuid = randomUUID();
  const next = composeTurnPrompt(smsg, satts || []);
  if (!turnInput.push(next.prompt, next.imageBlocks, uuid, 'next')) return null;
  run.awaitingUser.add(uuid);
  run.steerUuids.add(uuid);
  run.lastMsgAt = Date.now();
  if (sorigin) setTurnOrigin(run, sorigin, smsg);   // 插话也是一条用户消息：「这条消息发自」换成它的
  // atts：与历史重开同一套抽取与出口（runtime/client-atts.mjs），插话气泡据此画缩略图
  const atts = splitAttachments(next.prompt).attachments.map((a) => toClientAtt(a, ctx));
  if (sorigin) run.steerItems.set(uuid, { message: smsg || '', attachments: (satts || []).slice(), files: (satts || []).map((p) => path.basename(p)), read: false });
  run.send({ type: 'steer', uuid, text: smsg, files: (satts || []).map((p) => path.basename(p)), atts, at: Date.now(), ...(sorigin ? { retractable: true } : {}) });
  console.log(`[claude] steer — message fed into the running turn at priority next (${uuid.slice(0, 8)})`);
  return uuid;
}

// 撤回插话：Claude 真读到之前它是「虚」的——还在 bridge 的发送队列里就直接摘掉；已写进 CLI、
// 还在 CLI 队列里等（command_lifecycle 只报过 queued）就经控制通道 cancel_async_message 撤回，
// CLI 回 cancelled:false = 已经出队读进这一轮了（判定在 CLI 那边原子完成，不会撤一半）。
// 成功：发 steer_state withdrawn（进重放缓冲，各设备的气泡一起消失），返回原文与附件交还输入栏。
async function unsteer(run, uuid) {
  const { turnInput } = run.plan;
  const it = run.steerItems.get(uuid);
  if (!it) return { ok: false, reason: 'unknown' };
  if (it.read) return { ok: false, reason: 'read' };
  while (run.withdrawing) await run.withdrawing.catch(() => {});
  if (!run.steerItems.has(uuid) || it.read) return { ok: false, reason: it.read ? 'read' : 'unknown' };
  // 这一轮已经答完、读循环只在等它开的下一轮（interimResult）：CLI 马上就拿它开轮，撤回后
  // 读循环会空等一个不会来的 result——这时按「已读」处理，不撤。
  if (run.interimResult && run.awaitingUser.size <= 1) return { ok: false, reason: 'read' };
  it.pending = true;
  let done = turnInput.withdraw(uuid);
  if (!done) {
    const p = (async () => {
      try { return (await Promise.race([run.q.cancelAsyncMessage(uuid), new Promise((r) => setTimeout(() => r(false), 5000))])) === true; }
      catch (e) { console.log('[claude] cancelAsyncMessage failed:', e && e.message); return false; }
    })();
    run.withdrawing = p;
    try { done = await p; } finally { run.withdrawing = null; }
  }
  it.pending = false;
  if (!done) { it.read = true; return { ok: false, reason: 'read' }; }
  run.steerItems.delete(uuid);
  run.steerUuids.delete(uuid);
  run.awaitingUser.delete(uuid);
  run.send({ type: 'steer_state', uuid, state: 'withdrawn' });
  console.log(`[claude] steer withdrawn before Claude read it (${uuid.slice(0, 8)})`);
  return { ok: true, message: it.message, attachments: it.attachments, files: it.files };
}

// 挂在 gen 上的控制口（/api/stop、任务面板 ⏹、同会话新消息都按会话找到当前 gen 来调）。
export function armGen(run, g) {
  g.stopTask = (...a) => stopTask(run, ...a);
  g.releaseHold = () => releaseHold(run);
  g.interruptTurn = () => interruptTurn(run);
  g.hardStop = () => hardStop(run);
  g.handoff = (...a) => handoff(run, ...a);
  g.steer = (...a) => steer(run, ...a);
  g.unsteer = (...a) => unsteer(run, ...a);
}
