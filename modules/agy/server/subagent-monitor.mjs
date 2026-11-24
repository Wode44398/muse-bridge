// Antigravity 会话级后台多代理监视器与后台唤醒桥接：
//
// 解决 ACP 接入下的多代理三大痛点：
//   1. agy 在 session/prompt 返回 end_turn 后，子代理回报触发主会话后台自动唤醒（auto-wake），
//      但 agy acp 不再推送该唤醒的 session/update，前端一直停在上一轮。本监视器盯住主会话的
//      transcript_full.jsonl 与 conversations/<id>.db，一出现后台自动唤醒就挂起被动 gen、
//      把思考 / 工具调用 / 正文 / 交付物实时推给前端并同步进 acp.historyUpdates；
//   2. 后台唤醒期间 agy 发来的 elicitation/create（ask_question）与 session/request_permission
//      反向请求原先因「无活跃 turn」被直接 cancel；本模块接管这些反向请求，挂到被动 gen 上弹窗
//      并推通知，让用户的真实回答回到 agy；
//   3. 若子代理汇报落进 transcript 末尾但 agy 未自动唤醒（如部分旧版或偶发停滞），等待宽限期后
//      自动发一条静默续接（internalWake）唤醒主会话，彻底告别「每次手动追问好了么」。

import { busPublish } from '@bridge/core/runtime/bus.mjs';
import {
  findGenBySession, setCurrentGen, genEmit, genFinish, retireGen,
} from '@bridge/core/runtime/gen.mjs';
import { startMultiHeartbeat } from '@bridge/core/runtime/sse.mjs';
import { questionTimeoutMs } from '@bridge/core/runtime/questions.mjs';
import { unansweredSenders, sessionBrainDir } from './background.mjs';
import { AGY_WAKE_PROMPT } from './wake-prompt.mjs';
import { collectDeliverableAttachments } from './deliverables.mjs';
import { getSessionMeta, noteSessionMeta } from './sessions.mjs';
import { BYPASS_MODE } from './acp/bypass.mjs';
import {
  agyGenKey, publishAgyRun, noticeAgyPending, noticeAgyEnd,
} from './presence.mjs';
import {
  readDbActivity,
  readLatestTranscriptStepIndex,
  readTranscriptStepsAfter,
  readFullTranscriptAsUpdates,
  stepsToAcpUpdates,
  readSubagentTree,
  hasProtectedSubagents,
  backgroundBusy,
  backgroundShown,
} from './subagents.mjs';

const DEFAULT_ACTIVE_POLL_MS = 1_500;
const DEFAULT_QUIET_POLL_MS = 4_000;
const DEFAULT_WAKE_GRACE_DB_MS = 4_500;
const DEFAULT_WAKE_GRACE_NODB_MS = 350;
const IDLE_DISARM_MS = 60_000;
const MAX_DORMANT_MS = 4 * 3600_000;

const monitors = new Map();      // `${ctxKey}::${sessionId}` -> monitor state
const sessionOwners = new Map(); // sessionId -> { ctx, client }
const attachedClients = new WeakSet();

let timing = {
  activePollMs: DEFAULT_ACTIVE_POLL_MS,
  quietPollMs: DEFAULT_QUIET_POLL_MS,
  wakeGraceDbMs: DEFAULT_WAKE_GRACE_DB_MS,
  wakeGraceNoDbMs: DEFAULT_WAKE_GRACE_NODB_MS,
};

/** 仅用于测试加速轮询与宽限期。 */
export function setMonitorTimingForTest(patch = {}) {
  timing = {
    activePollMs: patch.activePollMs ?? DEFAULT_ACTIVE_POLL_MS,
    quietPollMs: patch.quietPollMs ?? DEFAULT_QUIET_POLL_MS,
    wakeGraceDbMs: patch.wakeGraceDbMs ?? DEFAULT_WAKE_GRACE_DB_MS,
    wakeGraceNoDbMs: patch.wakeGraceNoDbMs ?? DEFAULT_WAKE_GRACE_NODB_MS,
  };
}

function monKey(ctxKey, sessionId) {
  return `${ctxKey || 'admin'}::${sessionId}`;
}

export function noteSessionOwner(ctx, client, sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid || !ctx || !client) return;
  sessionOwners.set(sid, { ctx, client });
  attachAcpBackgroundBridge(client);
}

export function isMonitorActive(ctxKey, sessionId) {
  return monitors.has(monKey(ctxKey, sessionId));
}

/** 这一轮已经说完、但还挂着后台（子代理 / 团队 / 转入后台的命令 / 定时任务）在跑的会话：侧栏据此画「在等后台」 */
export function listBackgroundWaitingSessions(ctxKey) {
  const prefix = `${ctxKey || 'admin'}::`;
  const out = [];
  for (const [k, mon] of monitors) {
    if (!k.startsWith(prefix) || mon.stopped || !mon.bgActive) continue;
    out.push(mon.sessionId);
  }
  return out;
}

/** 全服（所有账号）有多少个会话的后台还在干活：bridge 的空闲重启据此等它们（见 index.mjs 的 busyRuns） */
export function countBackgroundBusySessions() {
  let n = 0;
  for (const mon of monitors.values()) {
    if (!mon.stopped && mon.bgBusy && !mon.client?.hasActiveTurn?.(mon.sessionId)) n += 1;
  }
  return n;
}

export function getPassiveBackgroundGen(ctxKey, sessionId) {
  const mon = monitors.get(monKey(ctxKey, sessionId));
  return mon?.passiveGen && !mon.passiveGen.done ? mon.passiveGen : null;
}

/** 登记该会话已同步到磁盘的哪一步（正常 runPrompt 结束或 session/load 完成时调，防重复重放）。 */
export function markSessionTranscriptSynced(ctxKey, client, sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid || !client?.dataDir) return;
  const { stepIndex } = readLatestTranscriptStepIndex(client.dataDir, sid);
  const mon = monitors.get(monKey(ctxKey, sid));
  if (mon && stepIndex > mon.syncedStep) {
    mon.syncedStep = stepIndex;
    mon.emittedStep = Math.max(mon.emittedStep, stepIndex);
  }
}

/**
 * 把磁盘上晚于已同步步骤的新步骤补进 client.historyUpdates（供 loadSessionWithReplay 跳过
 * session/close 时取到完整最新历史）。返回同步进来的更新条数。
 */
export function syncDiskTailIntoHistory(ctxKey, client, sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid || !client?.dataDir) return 0;
  const hist = client.historyUpdates?.get(sid);
  if (!hist) return 0;
  const mon = monitors.get(monKey(ctxKey, sid));
  if (!mon) return 0;
  const steps = readTranscriptStepsAfter(client.dataDir, sid, mon.syncedStep);
  if (!steps.length) return 0;
  const converted = stepsToAcpUpdates(steps, sid);
  if (converted.updates.length) {
    hist.push(...converted.updates);
  }
  if (converted.maxStepIndex > mon.syncedStep) {
    mon.syncedStep = converted.maxStepIndex;
    mon.emittedStep = Math.max(mon.emittedStep, converted.maxStepIndex);
  }
  return converted.updates.length;
}

function createPassiveGen(mon) {
  const { ctx, client, sessionId } = mon;
  const genKey = agyGenKey(ctx.key);
  const meta = getSessionMeta(ctx.agyDir, sessionId) || {};
  const abort = new AbortController();
  let settleGen;
  const hist = client.historyUpdates?.get(sessionId);
  const gen = {
    agent: 'agy',
    sessionId,
    cwd: meta.cwd || client.mountedSessions?.get(sessionId)?.cwd || '',
    projectId: meta.projectId || null,
    userText: '',
    userAtts: [],
    backgroundWake: true,
    historyBase: Array.isArray(hist) ? hist.length : null,
    events: [],
    subscribers: new Set(),
    abort,
    done: false,
    startedAt: Date.now(),
    pendingPermission: null,
    pendingPermissions: [],
    pendingQuestion: null,
    settled: new Promise((resolve) => { settleGen = resolve; }),
    _settle: () => settleGen?.(),
    _hb: null,
  };
  gen._hb = startMultiHeartbeat(gen.subscribers);
  abort.signal.addEventListener('abort', () => {
    if (gen.done) return;
    try { client.cancelSession(sessionId); } catch {}
    closePassiveGen(mon, { status: 'interrupted', notify: false });
  }, { once: true });

  setCurrentGen(genKey, gen);
  mon.passiveGen = gen;
  mon.passiveBaseStep = mon.emittedStep;
  mon.passiveText = '';
  mon.passivePendingTools = [];
  mon.passiveSawActivity = false;
  mon.passiveIdleTicks = 0;
  publishAgyRun(ctx, gen, { live: true });
  return gen;
}

function ensurePassiveGen(mon) {
  if (mon.passiveGen && !mon.passiveGen.done) return mon.passiveGen;
  return createPassiveGen(mon);
}

function closePassiveGen(mon, { status = 'completed', notify = true } = {}) {
  const gen = mon.passiveGen;
  if (!gen || gen.done) { mon.passiveGen = null; return; }
  mon.passiveGen = null;
  const { ctx, client, sessionId } = mon;
  const genKey = agyGenKey(ctx.key);
  const meta = getSessionMeta(ctx.agyDir, sessionId) || {};
  const elapsedMs = Math.max(0, Date.now() - (gen.startedAt || Date.now()));
  const text = mon.passiveText || '';

  // 收尾时把还在等 GENERIC 的工具收敛成终态，避免界面一直转圈
  const pendingLeft = Array.isArray(mon.passivePendingTools) ? mon.passivePendingTools.splice(0) : [];
  const hist = client.historyUpdates?.get(sessionId);
  for (const leftover of pendingLeft) {
    const finalSt = status === 'interrupted' ? 'cancelled' : 'completed';
    leftover.status = finalSt;
    if (hist) {
      hist.push({
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: leftover.toolCallId,
            name: leftover.name,
            kind: leftover.kind,
            status: finalSt,
            title: leftover.title,
            rawInput: leftover.args,
          },
        },
      });
    }
    try { genEmit(gen, { type: 'tool-update', tool: { ...leftover } }); } catch {}
  }

  const attachments = text ? collectDeliverableAttachments(text, {
    workDir: gen.cwd || meta.cwd || '',
    additionalDirectories: Array.isArray(meta.additionalDirectories) ? meta.additionalDirectories : [],
    uploads: ctx?.uploads,
    artifactDir: sessionBrainDir(client.dataDir, sessionId),
  }) : [];

  try {
    if (status === 'interrupted') {
      genEmit(gen, {
        type: 'interrupted',
        result: text,
        status: 'interrupted',
        sessionId,
        attachments,
        elapsedMs,
        backgroundWake: true,
      });
    } else {
      genEmit(gen, {
        type: 'done',
        result: text,
        status: 'completed',
        isError: false,
        cost: 0,
        sessionId,
        attachments,
        elapsedMs,
        backgroundWake: true,
      });
    }
  } catch {}

  gen.pendingPermission = null;
  gen.pendingPermissions = [];
  gen.pendingQuestion = null;
  clearInterval(gen._hb);
  genFinish(gen);
  retireGen(genKey, gen);
  try { gen._settle?.(); } catch {}
  publishAgyRun(ctx, gen, { live: false });

  if (status === 'completed' && text) {
    noteSessionMeta(ctx.agyDir, sessionId, {
      lastTurnStatus: 'completed',
      updatedAt: new Date().toISOString(),
    });
    if (notify) noticeAgyEnd(ctx, gen, { kind: 'done', text });
  }
  busPublish(ctx.key, {
    type: 'agy.bg_update',
    sessionId,
    stepIndex: mon.syncedStep,
    status,
  });
}

/** 用户主动发新消息前，把被动后台唤醒 gen 干净收掉（不 cancel agy、不挡住用户发言）。 */
export function finishPassiveGenForSession(ctxKey, sessionId) {
  const mon = monitors.get(monKey(ctxKey, sessionId));
  if (!mon?.passiveGen || mon.passiveGen.done) return false;
  closePassiveGen(mon, { status: 'completed', notify: false });
  return true;
}

function flushDiskStepsToPassiveGen(mon, steps, isActive = false) {
  if (!steps.length) return { emitted: false, hasRunningStep: false, hasPlanner: false };
  const { client, sessionId } = mon;
  // 先在副本上演算，确认有可展示步骤再建被动 gen 并回写，避免 createPassiveGen 清空刚入队的 pendingTools
  const pending = Array.isArray(mon.passivePendingTools) ? [...mon.passivePendingTools] : [];
  const converted = stepsToAcpUpdates(steps, sessionId, {
    isActive,
    pendingTools: pending,
  });
  if (!converted.events.length && !converted.hasPlanner) {
    if (converted.maxStepIndex > mon.syncedStep) {
      mon.syncedStep = converted.maxStepIndex;
      mon.emittedStep = Math.max(mon.emittedStep, converted.maxStepIndex);
    }
    return { emitted: false, hasRunningStep: converted.hasRunningStep, hasPlanner: false };
  }
  const gen = ensurePassiveGen(mon);
  mon.passivePendingTools = pending;
  const hist = client.historyUpdates?.get(sessionId);
  if (hist && converted.updates.length) {
    if (!mon.passiveSawActivity && converted.text) {
      for (let i = hist.length - 1; i >= 0; i--) {
        const u = hist[i]?.params?.update;
        if (!u) continue;
        if (u.sessionUpdate === 'user_message_chunk') break;
        if (u.sessionUpdate === 'agent_message_chunk') {
          const prevText = String(u.content?.text || '');
          if (prevText && !/\n\s*$/.test(prevText)) {
            hist.push({ params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\n' } } } });
          }
          break;
        }
      }
    }
    hist.push(...converted.updates);
  }
  for (const ev of converted.events) {
    try { genEmit(gen, ev); } catch {}
  }
  if (converted.text) {
    mon.passiveText += (mon.passiveText && !/\n\s*$/.test(mon.passiveText) ? '\n\n' : '') + converted.text;
  }
  if (converted.maxStepIndex > mon.syncedStep) {
    mon.syncedStep = converted.maxStepIndex;
    mon.emittedStep = Math.max(mon.emittedStep, converted.maxStepIndex);
  }
  mon.passiveSawActivity = true;
  mon.passiveIdleTicks = 0;
  return { emitted: true, hasRunningStep: converted.hasRunningStep, hasPlanner: converted.hasPlanner };
}

async function triggerFallbackWake(mon) {
  if (mon.waking || mon.stopped) return false;
  const { ctx, client, sessionId } = mon;
  if (client.hasActiveTurn(sessionId)) return false;
  const liveGen = findGenBySession(agyGenKey(ctx.key), sessionId);
  if (liveGen && !liveGen.done && !liveGen.backgroundWake) return false;
  if (mon.passiveGen && !mon.passiveGen.done) closePassiveGen(mon, { status: 'completed', notify: false });

  mon.waking = true;
  mon.unansweredSince = 0;
  try {
    const meta = getSessionMeta(ctx.agyDir, sessionId) || {};
    const { runAgyChat } = await import('./agents/agy.mjs');
    await runAgyChat(null, null, {
      message: AGY_WAKE_PROMPT,
      sessionId,
      cwd: meta.cwd || client.mountedSessions?.get(sessionId)?.cwd || ctx.cwd || '',
      projectId: meta.projectId || null,
      additionalDirectories: Array.isArray(meta.additionalDirectories) ? meta.additionalDirectories : [],
      internalWake: true,
      ctx,
    });
    return true;
  } catch (err) {
    console.error('[agy] 后台子代理兜底唤醒失败：', err?.message || err);
    return false;
  } finally {
    mon.waking = false;
    markSessionTranscriptSynced(ctx.key, client, sessionId);
  }
}

function addGenPermission(gen, payload) {
  if (!gen || !payload?.requestId) return false;
  if (!Array.isArray(gen.pendingPermissions)) gen.pendingPermissions = [];
  if (gen.pendingPermissions.some((p) => p?.requestId === payload.requestId)) return false;
  gen.pendingPermissions.push(payload);
  gen.pendingPermission = gen.pendingPermissions[0] || null;
  return true;
}

function removeGenPermission(gen, requestId) {
  if (!gen) return false;
  const id = String(requestId || '');
  let changed = false;
  if (Array.isArray(gen.pendingPermissions)) {
    const next = gen.pendingPermissions.filter((p) => p?.requestId !== id);
    if (next.length !== gen.pendingPermissions.length) {
      gen.pendingPermissions = next;
      changed = true;
    }
  }
  const nextFirst = Array.isArray(gen.pendingPermissions) ? (gen.pendingPermissions[0] || null) : null;
  if (gen.pendingPermission?.requestId === id || gen.pendingPermission !== nextFirst) {
    gen.pendingPermission = nextFirst;
    changed = true;
  }
  return changed;
}

function attachWaitingSubagents(mon, tree) {
  const { ctx, client, sessionId } = mon;
  const waiting = Array.isArray(tree?.waitingAgents) ? tree.waitingAgents : [];
  if (waiting.length > 0 && typeof client.ensureSubagentAttached === 'function') {
    const meta = getSessionMeta(ctx?.agyDir, sessionId) || {};
    const cwd = meta.cwd || client.mountedSessions?.get(sessionId)?.cwd || ctx?.cwd || '';
    for (const a of waiting) {
      if (!a?.id || a.id === sessionId) continue;
      client.ensureSubagentAttached(a.id, sessionId, {
        cwd,
        role: a.role,
        typeName: a.typeName,
        depth: a.depth,
        kind: a.kind,
      }).catch(() => {});
    }
  }

  // agy 对子代理权限有内置 60s 超时：若子代理 DB 已离开 status=9，及时收掉本地过期的挂起卡片
  const now = Date.now();
  for (const entry of [...(client.pendingPermissions?.values() || [])]) {
    if (entry.rootSessionId !== sessionId) continue;
    if (!entry.sourceSessionId || entry.sourceSessionId === sessionId) continue;
    if (now - (entry.createdAt || 0) < 3_500) continue;
    if (!readDbActivity(client.dataDir, entry.sourceSessionId).hasWaiting) {
      try { client.retireExternalPermission?.(entry.requestId); } catch {}
    }
  }
}

function adoptOrphanSubagentPermissions(mon) {
  const { ctx, client, sessionId } = mon;
  for (const entry of [...(client.pendingPermissions?.values() || [])]) {
    if (entry.rootSessionId !== sessionId) continue;
    if (!entry.sourceSessionId || entry.sourceSessionId === sessionId) continue;
    if (entry.onResolved) continue;
    const gen = ensurePassiveGen(mon);
    if (!addGenPermission(gen, entry.payload)) continue;
    mon.passiveSawActivity = true;
    mon.passiveIdleTicks = 0;
    try { genEmit(gen, entry.payload); } catch {}
    noticeAgyPending(ctx, gen);
    publishAgyRun(ctx, gen, { live: true });
    entry.onResolved = (resolved) => {
      if (removeGenPermission(gen, resolved.requestId)) {
        publishAgyRun(ctx, gen, { live: true });
      }
      try { genEmit(gen, { type: 'permission-resolved', ...resolved }); } catch {}
      scheduleNextPoll(mon, 200);
    };
  }
}

function dbHasActiveTurnAfter(db, baseStep) {
  if (!db?.exists || !db.hasRunning) return false;
  for (const idx of db.activeTurnStepIdxs || []) {
    if (idx > baseStep) return true;
  }
  return false;
}

async function pollMonitor(mon) {
  if (mon.stopped || mon.polling) return;
  mon.polling = true;
  try {
    const { ctx, client, sessionId } = mon;
    if (!client.dataDir) return;

    const tree = readSubagentTree(client.dataDir, sessionId);
    mon.bgActive = backgroundShown(tree);
    mon.bgBusy = backgroundBusy(tree);
    // 无论主轮是否正在运行，一旦有子代理/Swarm 成员卡在待审批（status=9）立即接通其 ACP 更新流
    attachWaitingSubagents(mon, tree);
    if (tree.signature !== mon.lastTreeSig) {
      mon.lastTreeSig = tree.signature;
      busPublish(ctx.key, {
        type: 'agy.subagents',
        sessionId,
        counts: tree.counts,
        hasActive: tree.hasActive,
        // 侧栏「在等后台」：有在跑 / 在等的子代理或在跑的后台任务（不含主会话残留的 RUNNING 步骤）
        bgWaiting: mon.bgActive,
        updatedAt: tree.updatedAt,
      });
      const liveGen = findGenBySession(agyGenKey(ctx.key), sessionId);
      if (liveGen && !liveGen.done) {
        try {
          genEmit(liveGen, {
            type: 'subagents',
            sessionId,
            counts: tree.counts,
            hasActive: tree.hasActive,
          });
        } catch {}
      }
    }

    // 正常用户轮正在跑：由 runPrompt 自己管流式与历史，监视器只跟进步号和推子代理树
    if (client.hasActiveTurn(sessionId)) {
      const { stepIndex } = readLatestTranscriptStepIndex(client.dataDir, sessionId);
      if (stepIndex > mon.syncedStep) {
        mon.syncedStep = stepIndex;
        mon.emittedStep = Math.max(mon.emittedStep, stepIndex);
      }
      mon.unansweredSince = 0;
      mon.idleSince = 0;
      return;
    }

    // 主轮收尾后若仍有未处理的子代理权限请求，立刻转接到被动 gen 展示
    adoptOrphanSubagentPermissions(mon);

    const db = readDbActivity(client.dataDir, sessionId);
    const newSteps = readTranscriptStepsAfter(client.dataDir, sessionId, mon.emittedStep);
    const hasModelSteps = newSteps.some((s) => s.type === 'PLANNER_RESPONSE' || s.type === 'GENERIC');
    // 只有「晚于已同步步骤」的前台运行步骤才算新的后台自动唤醒；历史轮转入后台的 run_command / schedule
    // 步骤 idx <= syncedStep（且已被后续 PLANNER_RESPONSE 越过），不能据此凭空挂起被动 gen。
    const wakeBase = (mon.passiveGen && !mon.passiveGen.done) ? mon.passiveBaseStep : mon.emittedStep;
    const dbTurnActive = dbHasActiveTurnAfter(db, wakeBase);

    // 1) agy 已在后台自动唤醒（DB 有晚于基线的运行中前台步骤，或 transcript 新增了模型回复/工具步骤）
    if (dbTurnActive || hasModelSteps) {
      mon.unansweredSince = 0;
      mon.idleSince = 0;
      if (hasModelSteps) {
        flushDiskStepsToPassiveGen(mon, newSteps, dbTurnActive);
      } else if (dbTurnActive && !mon.passiveGen) {
        // 刚醒来正在生成第一步，提前建好被动 gen 让前端切入直播态
        ensurePassiveGen(mon);
        mon.passiveSawActivity = true;
      }
    }

    // 2) 检查被动 gen 是否可以收尾
    if (mon.passiveGen && !mon.passiveGen.done) {
      const hasPendingRpc = Boolean(
        (Array.isArray(mon.passiveGen.pendingPermissions) && mon.passiveGen.pendingPermissions.length > 0)
        || mon.passiveGen.pendingPermission
        || mon.passiveGen.pendingQuestion
      );
      const stillRunning = db.exists
        ? dbHasActiveTurnAfter(db, mon.passiveBaseStep)
        : newSteps.some((s) => s.status === 'RUNNING');
      if (!stillRunning && !hasPendingRpc) {
        mon.passiveIdleTicks += 1;
        // DB 存在且已经 idle，或者无 DB 连续静默 1 拍且已有模型输出 → 收尾并通知用户
        const readyToClose = (db.exists && mon.passiveSawActivity) || mon.passiveIdleTicks >= 2;
        if (readyToClose) {
          closePassiveGen(mon, { status: 'completed', notify: true });
        }
      } else {
        mon.passiveIdleTicks = 0;
      }
      return;
    }

    // 3) 若末尾是子代理汇报（SYSTEM_MESSAGE），给 agy 一个自动唤醒宽限期；超时仍未醒则兜底唤醒
    const unanswered = unansweredSenders(client.dataDir, sessionId);
    if (unanswered.length > 0 && !db.hasRunning && !mon.waking) {
      const now = Date.now();
      if (!mon.unansweredSince) mon.unansweredSince = now;
      const grace = db.exists ? timing.wakeGraceDbMs : timing.wakeGraceNoDbMs;
      if (now - mon.unansweredSince >= grace) {
        await triggerFallbackWake(mon);
        return;
      }
    } else {
      mon.unansweredSince = 0;
    }

    // 4) 调整下次轮询频率 / 彻底空闲后自动撤防
    const now = Date.now();
    const stillWaiting = tree.hasActive || unanswered.length > 0;
    if (stillWaiting) {
      mon.idleSince = 0;
      mon.dormantSince = 0;
      scheduleNextPoll(mon, timing.activePollMs);
    } else if (tree.hasAliveNonImage) {
      // 有活着但暂时待命的多代理（如 Teamwork 暂停等用户确认方案）：降频值守，零开销且不丢下次唤醒
      mon.idleSince = 0;
      if (!mon.dormantSince) mon.dormantSince = now;
      if (now - mon.dormantSince > MAX_DORMANT_MS) {
        stopSubagentMonitor(ctx.key, sessionId);
      } else {
        scheduleNextPoll(mon, timing.quietPollMs);
      }
    } else {
      if (!mon.idleSince) mon.idleSince = now;
      if (now - mon.idleSince > IDLE_DISARM_MS) {
        stopSubagentMonitor(ctx.key, sessionId);
      } else {
        scheduleNextPoll(mon, timing.quietPollMs);
      }
    }
  } finally {
    mon.polling = false;
    if (!mon.stopped && !mon.timer) {
      scheduleNextPoll(mon, timing.activePollMs);
    }
  }
}

function scheduleNextPoll(mon, delayMs) {
  if (mon.stopped) return;
  clearTimeout(mon.timer);
  mon.timer = setTimeout(() => {
    mon.timer = null;
    pollMonitor(mon).catch(() => {});
  }, delayMs);
  mon.timer.unref?.();
}

/** 为会话挂载后台多代理监视器（幂等；已挂载时立即续命并触发一次检查）。 */
export function armSubagentMonitor(ctx, client, sessionId, { pollNow = false } = {}) {
  const sid = String(sessionId || '').trim();
  if (!ctx?.key || !client || !sid) return null;
  noteSessionOwner(ctx, client, sid);
  const k = monKey(ctx.key, sid);
  let mon = monitors.get(k);
  if (mon && !mon.stopped) {
    mon.ctx = ctx;
    mon.client = client;
    mon.idleSince = 0;
    mon.dormantSince = 0;
    if (pollNow) scheduleNextPoll(mon, 20);
    return mon;
  }
  const latest = client.dataDir ? readLatestTranscriptStepIndex(client.dataDir, sid) : { stepIndex: -1 };
  mon = {
    key: k,
    ctx,
    client,
    sessionId: sid,
    syncedStep: latest.stepIndex,
    emittedStep: latest.stepIndex,
    lastTreeSig: '',
    passiveGen: null,
    passiveBaseStep: latest.stepIndex,
    passiveText: '',
    passiveSawActivity: false,
    passiveIdleTicks: 0,
    unansweredSince: 0,
    idleSince: 0,
    dormantSince: 0,
    waking: false,
    polling: false,
    stopped: false,
    timer: null,
  };
  monitors.set(k, mon);
  scheduleNextPoll(mon, pollNow ? 20 : timing.activePollMs);
  return mon;
}

export function stopSubagentMonitor(ctxKey, sessionId) {
  const k = monKey(ctxKey, sessionId);
  const mon = monitors.get(k);
  if (!mon) return;
  mon.stopped = true;
  clearTimeout(mon.timer);
  mon.timer = null;
  if (mon.passiveGen && !mon.passiveGen.done) {
    closePassiveGen(mon, { status: 'completed', notify: false });
  }
  monitors.delete(k);
}

export function stopAllMonitorsForKey(ctxKey) {
  const prefix = `${ctxKey || 'admin'}::`;
  for (const [k, mon] of [...monitors.entries()]) {
    if (k.startsWith(prefix)) stopSubagentMonitor(ctxKey, mon.sessionId);
  }
}

export function stopAllSubagentMonitors() {
  for (const mon of [...monitors.values()]) {
    stopSubagentMonitor(mon.ctx?.key || 'admin', mon.sessionId);
  }
}

/** 立即同步一次（供手动「同步 / 检查进度」按钮或测试调用）；wake=true 且空闲时可选触发兜底唤醒。 */
export async function syncSessionSubagents(ctx, client, sessionId, { wake = false } = {}) {
  const sid = String(sessionId || '').trim();
  const mon = armSubagentMonitor(ctx, client, sid, { pollNow: false });
  if (!mon) return { synced: 0, woke: false, tree: readSubagentTree(client?.dataDir, sid) };
  await pollMonitor(mon);
  let woke = false;
  if (wake && !client.hasActiveTurn(sid)) {
    const unanswered = unansweredSenders(client.dataDir, sid);
    const db = readDbActivity(client.dataDir, sid);
    if (unanswered.length > 0 && !db.hasRunning) {
      woke = await triggerFallbackWake(mon);
    }
  }
  return {
    synced: mon.syncedStep,
    woke,
    tree: readSubagentTree(client.dataDir, sid),
  };
}

function handleBackgroundPermission(client, payload) {
  const sid = payload?.sessionId;
  const owner = sid ? sessionOwners.get(sid) : null;
  if (!owner || owner.client !== client) return null;
  const mon = armSubagentMonitor(owner.ctx, client, sid, { pollNow: false });
  if (!mon) return null;

  const isFromSubagent = Boolean(payload?.sourceSessionId && payload.sourceSessionId !== sid);
  // 主会话自身后台唤醒的权限申请：先把本次唤醒已落盘的思考 / 工具步骤吐到被动 gen 里，再弹审批卡
  if (!isFromSubagent) {
    const pendingSteps = readTranscriptStepsAfter(client.dataDir, sid, mon.emittedStep);
    if (pendingSteps.length) flushDiskStepsToPassiveGen(mon, pendingSteps, true);
  }

  const gen = ensurePassiveGen(mon);
  addGenPermission(gen, payload);
  mon.passiveSawActivity = true;
  mon.passiveIdleTicks = 0;
  try { genEmit(gen, payload); } catch {}
  noticeAgyPending(owner.ctx, gen);
  publishAgyRun(owner.ctx, gen, { live: true });

  return {
    handled: true,
    timeoutMs: 0,
    onResolved: (resolved) => {
      if (removeGenPermission(gen, resolved.requestId)) {
        publishAgyRun(owner.ctx, gen, { live: true });
      }
      const resolvedSub = Boolean(resolved.sourceSessionId && resolved.sourceSessionId !== sid);
      if (sid && !resolvedSub && resolved.toolCallId && !resolved.auto) {
        const denied = resolved.outcome === 'cancelled' || /^(?:deny|reject)/i.test(String(resolved.optionId || ''));
        noteSessionMeta(owner.ctx?.agyDir, sid, {
          toolApprovals: { [resolved.toolCallId]: denied ? 'denied' : 'allowed' },
        });
      }
      try { genEmit(gen, { type: 'permission-resolved', ...resolved }); } catch {}
      scheduleNextPoll(mon, 200);
    },
  };
}

function handleBackgroundQuestion(client, payload) {
  const sid = payload?.sessionId;
  const owner = sid ? sessionOwners.get(sid) : null;
  if (!owner || owner.client !== client) return null;
  const mon = armSubagentMonitor(owner.ctx, client, sid, { pollNow: false });
  if (!mon) return null;

  // 先把本次后台唤醒已经写出的文字（如「请审阅草案并确认…」）同步到被动 gen，提问卡才会紧跟在说明后面
  const pendingSteps = readTranscriptStepsAfter(client.dataDir, sid, mon.emittedStep);
  if (pendingSteps.length) flushDiskStepsToPassiveGen(mon, pendingSteps, true);

  const gen = ensurePassiveGen(mon);
  gen.pendingQuestion = payload;
  mon.passiveSawActivity = true;
  mon.passiveIdleTicks = 0;
  try { genEmit(gen, payload); } catch {}
  noticeAgyPending(owner.ctx, gen);
  publishAgyRun(owner.ctx, gen, { live: true });

  return {
    handled: true,
    timeoutMs: questionTimeoutMs(owner.ctx),
    onResolved: (resolved) => {
      if (gen.pendingQuestion?.requestId === resolved.requestId) {
        gen.pendingQuestion = null;
        publishAgyRun(owner.ctx, gen, { live: true });
      }
      try { genEmit(gen, { type: 'question-resolved', ...resolved }); } catch {}
      scheduleNextPoll(mon, 200);
    },
  };
}

function resolveActiveBackgroundSessionId(client) {
  const candidates = [];
  for (const mon of monitors.values()) {
    if (mon.client !== client || mon.stopped) continue;
    if (mon.passiveGen && !mon.passiveGen.done) return mon.sessionId;
    if (client.mountedSessions?.has(mon.sessionId)) candidates.push(mon.sessionId);
  }
  if (candidates.length === 1) return candidates[0];
  for (const sid of candidates) {
    if (readDbActivity(client.dataDir, sid).hasRunning) return sid;
  }
  return candidates[0] || null;
}

/** 把多代理保护与后台反向请求处理接到 AcpClient 实例上（幂等）。 */
export function attachAcpBackgroundBridge(client) {
  if (!client || attachedClients.has(client)) return;
  attachedClients.add(client);
  client.setBackgroundHandlers?.({
    hasAliveBackground: (sid) => hasProtectedSubagents(client.dataDir, sid),
    hasAnyProtectedBackground: () => {
      for (const sid of client.mountedSessions?.keys() || []) {
        const tree = readSubagentTree(client.dataDir, sid);
        if (tree.hasActive) return true;
      }
      return false;
    },
    syncDiskTail: (sid) => {
      const owner = sessionOwners.get(sid);
      if (owner) syncDiskTailIntoHistory(owner.ctx.key, client, sid);
    },
    rebuildHistory: (sid) => (client.dataDir ? readFullTranscriptAsUpdates(client.dataDir, sid).updates : []),
    hasSessionOwner: (sid) => sessionOwners.has(sid),
    isBypass: (sid) => {
      const owner = sessionOwners.get(sid);
      return Boolean(owner && getSessionMeta(owner.ctx?.agyDir, sid)?.config?.mode === BYPASS_MODE);
    },
    onPermission: (payload) => handleBackgroundPermission(client, payload),
    onQuestion: (payload) => handleBackgroundQuestion(client, payload),
    resolveSessionId: () => resolveActiveBackgroundSessionId(client),
  });
}
