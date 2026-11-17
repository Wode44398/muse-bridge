// 停放与接着用：定局后 CLI 留着等同会话的下一条消息；新会话的预热停放。

import { randomUUID } from 'node:crypto';
import { startMultiHeartbeat } from '../../runtime/sse.mjs';
import { tryStartGen, genWrite, genSubscribe } from '../../runtime/gen.mjs';
import { busPublish } from '../../runtime/bus.mjs';
import { normalizeSuggestion, setSuggestion } from '../../runtime/suggestions.mjs';
import { makeRetractLedger } from '../../runtime/retract-ledger.mjs';
import { sessionPaths } from '../../runtime/paths.mjs';
import { noteTurnStart } from '../../users.mjs';
import { getPolicy } from '../../runtime/policy.mjs';
import { familyPeerTurn } from '../../runtime/session-family.mjs';
import { notePeerHold, waitPeerRecord, peerDisplay, registerPeerGate } from '../../runtime/session-peers.mjs';
import { describeOrigin } from '../../runtime/client-origins.mjs';
import { recordChatPrefs } from '../../runtime/chat-prefs.mjs';
import { stricterMode } from '../../runtime/permissions.mjs';
import { newGen, MAX_PARALLEL_CHATS, setTurnOrigin, announceStart, closeTurn } from './turn-ledger.mjs';
import { composeTurnPrompt } from './turn-input.mjs';
import { WARM_IDLE_MS, SUGGEST_WAIT_MS, warmStat, warmRuns, evictWarm, SPARE_MS, spareRuns } from './warm.mjs';
import { armBgWatch } from './bg-hold.mjs';
import { notePermMode } from './permission.mjs';
import { armGen } from './controls.mjs';

// ---- 停放与接着用（见 WARM_IDLE_MS）-------------------------------------------------
// 读循环不用 for-await：停放期要自己拉 q.next()（收输入建议），被新一轮接走时那个还悬着的 next()
// 会落到新一轮的第一帧上——塞回 pendingNext，主循环先读它，一帧不丢。
// 直接从 CLI 流取下一帧（不经 earlyMsgs）。预热停放期只能用这个：用 readNext 的话，刚存进 earlyMsgs 的帧
// 会被下一圈立刻原样读回来、又存回去——纯微任务死循环，I/O 饿死、每圈还在 wakeP 上挂一个永不释放的
// 回调，几十秒堆满 4GB（2026-10-19 两次 OOM 都紧跟在「spare CLI ready」之后，堆快照坐实）。
function readRaw(run) { const p = run.pendingNext || run.q.next(); run.pendingNext = null; return p; }

export function readNext(run) {
  if (run.earlyMsgs.length) return Promise.resolve({ value: run.earlyMsgs.shift(), done: false });
  return readRaw(run);
}

// 接着用：同会话新消息、启动参数一致 → 新 gen 订阅这条 POST，消息推进同一个输入流开新一轮。
// 与挂起接力（handoff）同一套换 gen 手法，差别是上一轮早已定局收尾（turnClosed），要把看门狗/计时重挂。
// 返回 'taken' = 接走了；'busy' = 并发上限把它挡下（错误帧已回给这条 POST，CLI 原样留着停放）；false = 接不了。
// adopt = { uuid }：不是推一条新消息，而是接住 CLI 自己已经开起来的那一轮（跨会话消息，见 parkWarm）——
// 没有发起请求（nres 为空，别的设备经总线 run.start 挂上直播），也不往输入流推东西。
function warmTake(run, { res: nres, message: nmsg, attachments: natts, pin: npin, source: nsrc, chatPrefs: nprefs, origin: norigin, family: nfam, permMode: nmode, limitReplay: nreplay, auto: nauto, adopt }) {
  const { ctx, permPolicy, memberCaps, billTo, turnInput } = run.plan;
  if (!run.turnClosed || run.userStopped || run.abort.signal.aborted || run.iterDone) return false;
  const g = newGen(run, nmsg, nsrc, run.gen.sessionId, natts);
  g.family = nfam || null;
  g.autoTurn = !!nauto;
  const userCap = ctx.kind === 'user' ? getPolicy().maxUserTurns : 0;
  const perKeyCap = Math.min(MAX_PARALLEL_CHATS, memberCaps.maxParallel);
  const slot = tryStartGen(ctx.key, g, {
    maxPerKey: perKeyCap,
    singleSession: true,
    ...(userCap ? { globalPrefix: 'u:', maxGlobal: userCap } : {}),
  });
  if (!slot.ok) {
    if (nres) {
      genWrite(nres, slot.reason === 'global'
        ? { type: 'error', kind: 'busy', title: '服务器正忙', message: '现在大家同时在跑的对话已经到上限（' + userCap + ' 个），稍等片刻再发送这条消息。' }
        : slot.reason === 'per-key'
          ? { type: 'error', kind: 'busy', title: '并行对话已满', message: '同时最多 ' + perKeyCap + ' 个对话在跑。等一个完成，或到带呼吸点的对话里按「停止」，再重发这条消息。' }
          : { type: 'error', kind: 'busy', title: '会话正在启动', message: '这个会话已有一轮刚刚开始，请稍后再试。' });
      nres.end();
    }
    return 'busy';
  }
  const uuid = adopt ? adopt.uuid : randomUUID();
  const next = adopt ? null : composeTurnPrompt(npin ? npin.message : nmsg, npin ? npin.attachments : (natts || []));
  run.gen = g;
  // 预热进程被新会话接管：会话 id 要等 init 帧才有，选择器记忆改用这条请求的、届时由 recordPrefs 落上。
  if (!run.gen.sessionId && nprefs) { run.chatPrefs = nprefs; run.prefsRecorded = false; }
  // 跨会话消息（source:'peer'）没有请求可认：发送端按会话间消息记
  setTurnOrigin(run, norigin || (nfam && nfam.origin ? describeOrigin({ family: nfam }) : null), nmsg);
  if (billTo) { try { noteTurnStart(billTo); } catch {} }
  if (nres) genSubscribe(run.gen, nres);
  armGen(run, run.gen);
  run.heartbeat = startMultiHeartbeat(run.gen.subscribers);
  run.bgWatch = armBgWatch(run);
  // 每轮的计数与记账归零（上一轮定局时后台任务已清零，整进程的任务表/门禁原样留着无妨）
  run.turnClosed = false;
  run.doneEmitted = false;
  run.bgFinalized = false;
  run.heldResult = null; run.interimResult = null; run.holdStartedAt = 0;
  run.shellSeenAt.clear(); run.cutShells.clear();
  run.softStopping = false;
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
  // 这一轮的请求身份换成接管进来的这条：预热进程起的时候根本没有（预热不带 limitReplay），停放的进程是上一条的——
  // 不换的话，预热接管的会话计划卡永远没有「清空上下文后执行」，撞了限额也排不上自动续跑。
  // 先换再 announceStart：inflight 台账记的要是眼下这条请求（重启后自动继续靠它重放）
  if (nreplay) run.limitReplay = nreplay;
  announceStart(run);
  if (nprefs && run.gen.sessionId) { try { recordChatPrefs(ctx, run.gen.sessionId, nprefs); } catch {} }
  // 权限模式：这一轮要的与停放 / 预热的 CLI 眼下的不同（会话里切过、绕过权限待生效、预热时按另一个默认起的）
  // → 先 setPermissionMode 再推消息（控制请求回了才推，免得第一条在旧模式下跑）
  if (nmode && permPolicy !== 'host') run.askedPermMode = nmode;
  // 接住 CLI 自己开起来的那一轮（adopt，跨会话消息）：没有要推的消息，模式也不在这时切
  if (!next) { /* adopt：什么都不推 */ }
  else if (nmode && nmode !== run.runPermMode && permPolicy !== 'host') {
    const from = run.runPermMode;
    run.q.setPermissionMode(nmode).then(() => { notePermMode(run, nmode, 'user'); turnInput.push(next.prompt, next.imageBlocks, uuid); }, (e) => {
      console.log('[claude] warm setPermissionMode failed:', e && e.message);
      // 要的比停放进程眼下的更严格却切不过去：这条不推（不能在更宽松的模式下跑），报错收掉这一轮、关掉进程，重发即冷起
      if (stricterMode(nmode, from)) {
        run.send({ type: 'error', title: '没能切换权限模式', message: '这条消息没有发出：Claude 进程没能切到你选的更严格的权限模式。请重发一次（会重新启动 Claude）。' });
        try { run.abort.abort(); } catch {}
        return;
      }
      turnInput.push(next.prompt, next.imageBlocks, uuid);
    });
  } else turnInput.push(next.prompt, next.imageBlocks, uuid);
  return 'taken';
}

// 停放：本轮已定局并结清台账（closeTurn），CLI 留着等同会话的下一条消息。期间顺带收输入建议。
// 返回 true = 被新一轮接走（主循环 continue 接着读）；false = 到点 / 被关 / CLI 自己动了 → 照旧收尾退出。
export async function parkWarm(run, sid) {
  const { ctx, wantSuggest, warmDigest, warmSig } = run.plan;
  if (!sid) return false;
  const idleMs = Math.max(WARM_IDLE_MS, wantSuggest ? SUGGEST_WAIT_MS : 0);
  if (!idleMs) return false;
  const lk = ctx.key + '|' + sid;
  const sp = sessionPaths(sid, ctx.cwd, ctx.configDir);
  let baseline = sp ? warmStat(sp.file) : '';
  let closed = false, taken = false, wake = null;
  // 正在认一条跨会话消息（waitPeerRecord 最多 3s）：这期间 CLI 已经在跑对方那一轮，用户的新消息不能推进同一个输入流
  //（会排在对方那轮后面、两轮输出混进用户这一轮的气泡）——take 先等结论；接住了 = 回「正在处理别的会话的消息」，没接 = 照旧冷起。
  let adopting = null, peerAdopted = false;
  const wakeP = new Promise((r) => { wake = r; });
  let finish;
  const done = new Promise((r) => { finish = r; });
  const entry = {
    lk, sig: warmSig, digest: warmDigest, parkedAt: Date.now(), done, finish,
    stat: () => baseline,
    // 关：杀掉停放的 CLI（被接走之后再关是空操作——绝不能误杀正在跑的新一轮）。
    close: () => {
      if (closed || taken) return;
      closed = true;
      if (warmRuns.get(lk) === entry) warmRuns.delete(lk);
      try { run.q.close(); } catch {}
      wake();
    },
    take: async (p) => {
      if (adopting) await adopting;
      if (peerAdopted && p.res) {
        genWrite(p.res, { type: 'error', kind: 'busy', title: '会话正在处理别的消息', message: '这个会话刚收到另一个 Claude 会话发来的消息，正在处理。等这一轮结束再发，或者在它进行中插话。' });
        p.res.end();
        return 'busy';
      }
      if (closed || taken || !WARM_IDLE_MS) return false;
      const r = warmTake(run, p);
      if (r !== 'taken') return r;
      taken = true;
      if (warmRuns.get(lk) === entry) warmRuns.delete(lk);
      finish();
      wake();
      console.log(`[claude] warm CLI ${sid.slice(0, 8)} reused — parked ${Math.round((Date.now() - entry.parkedAt) / 1000)}s, no spawn`);
      return true;
    },
  };
  const prev = warmRuns.get(lk);
  if (prev && prev !== entry) prev.close();
  run.warmEntry = entry;
  if (WARM_IDLE_MS) { warmRuns.set(lk, entry); evictWarm(entry); }
  // CLI 定局后自己还会补写几笔 transcript：3s 后重取指纹当基线，之后再变就是别的写入者。
  const settle = setTimeout(() => { if (!closed && !taken && sp) baseline = warmStat(sp.file); }, 3000);
  if (settle.unref) settle.unref();
  const deadline = Date.now() + idleMs;
  const peerTried = new Set();   // 认过的 command_uuid（hold 放行会先后来 queued / started 两帧）
  const wakeNull = wakeP.then(() => null);   // 只挂一次：每圈新挂一个，停放期每来一帧就多一个永不释放的回调
  try {
    while (!closed && !taken) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const nextP = readNext(run);
      nextP.catch(() => {});   // 被 close 收掉的那个 next 可能以异常落地，别漏成 unhandled
      let timer;
      const r = await Promise.race([
        nextP.then((v) => ({ v })),
        wakeNull,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), left); }),
      ]);
      clearTimeout(timer);
      if (taken) { run.pendingNext = r ? Promise.resolve(r.v) : nextP; return true; }
      if (!r) break;
      if (r.v.done) { run.iterDone = true; break; }
      const m = r.v.value;
      if (m && m.type === 'prompt_suggestion') {
        const text = wantSuggest ? normalizeSuggestion(m.suggestion) : '';
        if (text) {
          const v = setSuggestion(ctx.key, sid, text);
          busPublish(ctx.key, { type: 'suggestion', sessionId: sid, text, at: v.at });
        }
        continue;
      }
      // 跨会话消息（session-peers.mjs）：hold 档扣住的消息登记出来等用户确认；对方消息让 CLI 自己开了一轮
      //（先来 command_lifecycle，再 init）→ transcript 里认出是跨会话消息就当一次自动续跑接住，推给前端。
      if (run.peerAware && m && m.type === 'system' && m.subtype === 'peer_message_hold') { notePeerHold(ctx, sid, m, run.peerGate); continue; }
      if (run.peerAware && m && m.type === 'command_lifecycle' && m.command_uuid && (m.state === 'queued' || m.state === 'started')) {
        if (peerTried.has(m.command_uuid)) continue;
        peerTried.add(m.command_uuid);
        let settleAdopt;
        adopting = new Promise((r) => { settleAdopt = r; });
        try {
          const pr = await waitPeerRecord(sp && sp.file, m.command_uuid);
          if (taken) return true;
          if (closed) break;
          if (pr && pr.peer && familyPeerTurn(ctx, sid) && warmTake(run, { res: null, message: peerDisplay(pr.peer), attachments: [], source: 'peer', chatPrefs: null, family: { origin: { kind: 'peer', from: [pr.peer.from] } }, adopt: { uuid: m.command_uuid } }) === 'taken') {
            taken = true; peerAdopted = true;
            if (warmRuns.get(lk) === entry) warmRuns.delete(lk);
            finish();
            console.log(`[claude] parked CLI ${sid.slice(0, 8)} took a cross-session message from ${pr.peer.name || pr.peer.from || '?'} — adopted as a turn`);
            return true;
          }
          console.log(`[claude] parked CLI ${sid.slice(0, 8)} started a turn on its own (${pr && pr.peer ? 'cross-session message not adopted' : 'command'}) — closing it`);
          break;
        } finally {
          adopting = null;
          settleAdopt();   // 等着的 take 在下一个微任务里看结论：没接住时 finally 里的 entry.close() 已先关好
        }
      }
      // CLI 自己开了一轮（定时唤醒之类，没有人在看）——不替它挂着，照旧收掉。
      if (m && (m.type === 'assistant' || m.type === 'stream_event' || m.type === 'result' || (m.type === 'system' && m.subtype === 'init'))) {
        console.log(`[claude] parked CLI ${sid.slice(0, 8)} started a turn on its own (${m.type}) — closing it`);
        break;
      }
    }
  } catch (e) {
    if (!closed) console.log('[claude] parked CLI wait failed:', e && e.message);
  } finally {
    clearTimeout(settle);
    entry.close();
  }
  return false;
}

// 预热停放（见 SPARE_MS）：第一轮之前就停着，等新会话的第一条消息经 warmTake 接管。
// 返回 true = 被接走（主循环照常读新一轮）；false = 到点 / 被换掉 / 初始化失败 → 收尾退出。
export async function parkSpare(run) {
  const { ctx, warmDigest, warmSig } = run.plan;
  closeTurn(run);   // 占位轮从没开始：结清它（停掉看门狗/心跳），warmTake 才认得这是「上一轮已收」
  let closed = false, taken = false, wake = null;
  const wakeP = new Promise((r) => { wake = r; });
  let deadline = Date.now() + SPARE_MS;
  const entry = {
    sig: warmSig, digest: warmDigest, parkedAt: Date.now(), readyAt: 0,
    touch: () => { deadline = Date.now() + SPARE_MS; },
    close: () => {
      if (closed || taken) return;
      closed = true;
      if (spareRuns.get(ctx.key) === entry) spareRuns.delete(ctx.key);
      try { run.q.close(); } catch {}
      wake();
    },
    take: async (p) => {
      if (closed || taken) return false;
      const r = warmTake(run, p);
      if (r !== 'taken') return r;
      taken = true;
      // 跨会话入站闸还给真会话（预热期关着，见下）：清掉预热期写进内联层的 refuse，回到 spawn 时下发的那个
      //（warmSig 一致才接得走；「跟随 Claude 默认」时 spawn 没写 = CLI 默认）
      if (run.peerAware) run.q.applyFlagSettings({ crossSessionInbound: null }).catch(() => {});
      if (run.peerGate) registerPeerGate(ctx.key, run.peerGate);
      if (spareRuns.get(ctx.key) === entry) spareRuns.delete(ctx.key);
      wake();
      console.log(`[claude] spare CLI taken by a new session — parked ${Math.round((Date.now() - entry.parkedAt) / 1000)}s, ${entry.readyAt ? 'initialized' : 'still initializing'}`);
      return true;
    },
  };
  spareRuns.set(ctx.key, entry);
  // 预热的 CLI 还不是任何会话：别让 Desktop / 终端会话经跨会话通道把消息投进来（没人看着就跑一整轮，
  // 接管后那一轮还会混进新对话的第一条回答里）。入站闸先关成 refuse，被接走时再还原（session-peers.mjs）。
  if (run.peerAware) run.q.applyFlagSettings({ crossSessionInbound: 'refuse' }).catch(() => {});
  // 现在就把初始化（spawn、工具、插件、MCP 握手）做完，第一条消息只等模型。
  run.q.initializationResult().then(() => {
    entry.readyAt = Date.now();
    console.log(`[claude] spare CLI ready in ${entry.readyAt - entry.parkedAt}ms`);
  }, (e) => {
    if (!closed && !taken) { console.log('[claude] spare CLI init failed:', e && e.message); entry.close(); }
  });
  let nextP = null;
  const wakeNull = wakeP.then(() => null);
  try {
    while (!closed && !taken) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      // 必须 readRaw：这里读到的帧是往 earlyMsgs 里存的，经 readNext 会立刻把它读回来（见 readRaw）
      if (!nextP) { nextP = readRaw(run); nextP.catch(() => {}); }
      let timer;
      const r = await Promise.race([
        nextP.then((v) => ({ v })),
        wakeNull,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), left); }),
      ]);
      clearTimeout(timer);
      if (taken) {
        if (!r) run.pendingNext = nextP;
        else if (r.v.done) run.iterDone = true;
        else run.earlyMsgs.push(r.v.value);
        return true;
      }
      if (!r) continue;   // 到点（touch 续过期就接着等）或被关（循环条件收）
      nextP = null;
      if (r.v.done) { run.iterDone = true; break; }
      // 第一条消息之前 CLI 自己开了一轮（入站闸关上之前漏进来的跨会话消息之类）：同 parkWarm，不替它挂着，收掉
      const em = r.v.value;
      if (em && (em.type === 'command_lifecycle' || em.type === 'assistant' || em.type === 'stream_event' || em.type === 'result')) {
        console.log(`[claude] spare CLI started a turn on its own (${em.type}) — closing it`);
        break;
      }
      // 第一条消息之前 CLI 不该说话；init 这类帧先存着，接管后照常处理
      if (r.v.value) run.earlyMsgs.push(r.v.value);
    }
  } catch (e) {
    if (!closed) console.log('[claude] spare CLI wait failed:', e && e.message);
  } finally {
    if (!taken) entry.close();
  }
  if (!taken) console.log('[claude] spare CLI closed unused');
  return false;
}
