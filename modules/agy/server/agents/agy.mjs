// Antigravity 聊天入参校验与主分支：驱动常驻 ACP 进程并将事件流桥接到共享 gen / SSE 重放缓冲。

import { existsSync, readFileSync } from 'node:fs';
import { writeSseHeaders, startMultiHeartbeat } from '@bridge/core/runtime/sse.mjs';
import {
  findGenBySession, setCurrentGen, genEmit, genSubscribe, genFinish, retireGen,
} from '@bridge/core/runtime/gen.mjs';
import { mimeType } from '@bridge/core/runtime/http-file.mjs';
import { questionTimeoutMs } from '@bridge/core/runtime/questions.mjs';
import { devicesEnabled, ownDevices } from '@bridge/core/runtime/devices.mjs';
import { agentDeviceLink, setAgentDeviceLink } from '@bridge/core/runtime/agent-device-links.mjs';
import { acpFor } from '../acp/index.mjs';
import { extractConfigSummary } from '../events.mjs';
import { foldAgyPath } from '../paths.mjs';
import { collectDeliverableAttachments, extractDeliverablePaths } from '../deliverables.mjs';
import {
  getSessionMeta, noteSessionMeta, rememberSessionConfig, resolveVerifiedSessionCwd,
} from '../sessions.mjs';
import { loadAgySettings } from '../settings.mjs';
import { getProject, authorizeProjectPath } from '../projects.mjs';
import { buildAgySessionTooling } from '../mcp/config.mjs';
import {
  agyGenKey, publishAgyRun, publishAgySessions, noticeAgyPending, noticeAgyEnd,
} from '../presence.mjs';
import { enqueue, listQueue, takeNext, drainQueue, queueView } from '../queue.mjs';
import { agyUpstreamEvents, noteSessionLabel } from '../pool/index.mjs';
import { vizPlatform } from '@bridge/core/mcp/visualize.mjs';
import { steerAgyTurn } from '../steer.mjs';
import { makeBackgroundWaiter, sessionBrainDir } from '../background.mjs';
import { readDbActivity, hasProtectedSubagents } from '../subagents.mjs';
import {
  armSubagentMonitor,
  finishPassiveGenForSession,
  markSessionTranscriptSynced,
  noteSessionOwner,
} from '../subagent-monitor.mjs';
import { runAgyUserTurnHooks, runAgyTurnEndHooks } from '../turn-hooks.mjs';
import { isAgyTenant, guardLivenessOn, tripTenantGuard } from '../tenants.mjs';
import { makeGuardWatch, GUARD_BROKEN_MESSAGE } from '../guard/liveness.mjs';

export { extractDeliverablePaths, agyGenKey };

const ACP_IMAGE_EXT = /\.(?:png|jpe?g|webp|gif)$/i;

const replyJson = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

// 界面附件（用户气泡里那几张图 / 文件卡）：只留显示要用的字段，截长防滥用
function cleanUserAtts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 20)) {
    if (!a || typeof a !== 'object' || typeof a.path !== 'string' || !a.path) continue;
    out.push({
      path: a.path.slice(0, 1000),
      name: String(a.name || '').slice(0, 200),
      ...(a.kind ? { kind: String(a.kind).slice(0, 20) } : {}),
      ...(a.isImage ? { isImage: true } : {}),
      ...(a.isDir ? { isDir: true } : {}),
      ...(Number.isFinite(Number(a.size)) ? { size: Number(a.size) } : {}),
    });
  }
  return out;
}

function buildPromptBlocks(message, attachments = []) {
  const blocks = [];
  const nonImageFiles = [];

  for (const file of attachments) {
    if (typeof file !== 'string' || !existsSync(file)) continue;
    if (ACP_IMAGE_EXT.test(file)) {
      try {
        const data = readFileSync(file).toString('base64');
        const mime = mimeType(file, { fallback: 'image/png' });
        blocks.push({ type: 'image', mimeType: mime, data });
        continue;
      } catch {
        // 读取图片失败时降级为路径提示，由内置文件工具自行读取
      }
    }
    nonImageFiles.push(file);
  }

  const attPrefix = nonImageFiles.length
    ? '本轮附加文件路径：\n' + nonImageFiles.map((p) => '- ' + p).join('\n') + '\n\n'
    : '';
  const fullText = (attPrefix + String(message ?? '')).trim();
  if (fullText || !blocks.length) {
    blocks.unshift({ type: 'text', text: fullText });
  }
  return blocks;
}

export async function handleAgyChat(req, res, { parsed, message, sessionId, ctx, attachments, client = null }) {
  const settings = loadAgySettings(ctx.agyDir);
  const savedMeta = sessionId ? getSessionMeta(ctx.agyDir, sessionId) : null;

  let projectId = '';
  let workDir = '';

  if (sessionId) {
    // 续聊以服务端已确认的会话归属为准，禁止客户端借请求参数篡改项目或工作目录；
    // 且此处绝不提前落盘元数据，防止伪造的不存在 sessionId 产生幽灵会话。
    if (savedMeta?.projectId) {
      if (parsed.agyProjectId && String(parsed.agyProjectId) !== savedMeta.projectId) {
        return replyJson(res, 400, { error: '不能把已有会话切换到另一个项目' });
      }
      projectId = savedMeta.projectId;
    }
    const verifiedCwd = savedMeta?.cwd || await resolveVerifiedSessionCwd(ctx, sessionId);
    if (verifiedCwd) {
      if (parsed.cwd && foldAgyPath(parsed.cwd) !== foldAgyPath(verifiedCwd)) {
        return replyJson(res, 400, { error: '不能更改已有会话的工作目录' });
      }
      try { workDir = authorizeProjectPath(ctx, verifiedCwd); }
      catch (err) { return replyJson(res, err?.status || 400, { error: err?.message || '工作目录不可用' }); }
    } else if (projectId) {
      const proj = getProject(ctx.agyProjects, projectId);
      if (!proj) return replyJson(res, 400, { error: '项目不存在或无权访问' });
      try { workDir = authorizeProjectPath(ctx, proj.path); }
      catch (err) { return replyJson(res, err?.status || 400, { error: err?.message || '项目路径不可用' }); }
    } else if (settings.defaultCwd) {
      try { workDir = authorizeProjectPath(ctx, settings.defaultCwd); }
      catch { workDir = ctx.cwd; }
    } else {
      workDir = ctx.cwd;
    }
  } else {
    projectId = parsed.agyProjectId ? String(parsed.agyProjectId) : '';
    if (!projectId && !parsed.cwd && settings.defaultProjectId) {
      const defProj = getProject(ctx.agyProjects, settings.defaultProjectId);
      if (defProj) projectId = defProj.id;
    }
    if (projectId) {
      const proj = getProject(ctx.agyProjects, projectId);
      if (!proj) return replyJson(res, 400, { error: '项目不存在或无权访问' });
      try { workDir = authorizeProjectPath(ctx, proj.path); }
      catch (err) { return replyJson(res, err?.status || 400, { error: err?.message || '项目路径不可用' }); }
    } else if (parsed.cwd) {
      try { workDir = authorizeProjectPath(ctx, parsed.cwd); }
      catch (err) { return replyJson(res, err?.status || 400, { error: err?.message || '工作目录不可用' }); }
    } else if (settings.defaultCwd) {
      try { workDir = authorizeProjectPath(ctx, settings.defaultCwd); }
      catch { workDir = ctx.cwd; }
    } else {
      workDir = ctx.cwd;
    }
  }

  const extraDirs = [...(Array.isArray(savedMeta?.additionalDirectories) ? savedMeta.additionalDirectories : [])];
  if (!sessionId && Array.isArray(settings.additionalDirectories)) {
    for (const cfgDir of settings.additionalDirectories) {
      try {
        const authDir = authorizeProjectPath(ctx, cfgDir);
        if (!extraDirs.some((d) => foldAgyPath(d) === foldAgyPath(authDir))) {
          extraDirs.push(authDir);
        }
      } catch {}
    }
  }
  if (Array.isArray(parsed.additionalDirectories)) {
    for (const rawDir of parsed.additionalDirectories.slice(0, 8)) {
      try {
        const authDir = authorizeProjectPath(ctx, rawDir);
        if (!extraDirs.some((d) => foldAgyPath(d) === foldAgyPath(authDir))) {
          extraDirs.push(authDir);
        }
      } catch (err) {
        return replyJson(res, err?.status || 400, { error: err?.message || '附加工作目录不可用' });
      }
    }
  }

  const files = attachments([workDir, ...extraDirs]);
  if (!message && !files.length) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('empty message');
    return;
  }

  // 真人发的这一条（排队的也算）：会话协作清零连续自动续、拉取请求清零连续唤醒（turn-hooks.mjs）
  runAgyUserTurnHooks(ctx, sessionId);

  const model = typeof parsed.agyModel === 'string' && parsed.agyModel.trim()
    ? parsed.agyModel.trim().slice(0, 120)
    : undefined;
  const thoughtLevel = typeof parsed.agyThoughtLevel === 'string' && parsed.agyThoughtLevel.trim()
    ? parsed.agyThoughtLevel.trim().slice(0, 40)
    : (typeof parsed.agyEffort === 'string' && parsed.agyEffort.trim() ? parsed.agyEffort.trim().slice(0, 40) : undefined);
  const mode = typeof parsed.agyMode === 'string' && parsed.agyMode.trim()
    ? parsed.agyMode.trim().slice(0, 40)
    : undefined;

  return runAgyChat(req, res, {
    message,
    sessionId,
    cwd: workDir,
    projectId: projectId || null,
    model,
    thoughtLevel,
    mode,
    additionalDirectories: extraDirs,
    attachments: files,
    userAtts: cleanUserAtts(parsed.agyAtts),
    // 发送端（哪台电脑 / 手机发来的）与设备芯片里的选择：设备工具的默认目标、图表出图宽度按它
    client,
    computer: typeof parsed.agyComputer === 'string' ? parsed.agyComputer.slice(0, 40) : '',
    // queue：这个会话还在跑就排队、不在跑就直接开跑；两种都回 JSON（客户端另挂 /api/agy/attach 看直播）
    queue: parsed.queue === true,
    // steer：这个会话还在跑就中途插话（做完手头这一步就读到），不在跑就直接开跑；同样回 JSON
    steer: parsed.steer === true,
    ctx,
    // 这一轮从哪种屏幕发起：内嵌图表的绘制规范按它给（手机 App / 窄屏拿手机版）
    vizPlatform: vizPlatform({ phone: parsed.client === 'apk', narrow: parsed.narrow === true }),
  });
}

export async function runAgyChat(req, res, {
  message,
  sessionId,
  cwd,
  projectId = null,
  model,
  thoughtLevel,
  mode,
  additionalDirectories = [],
  attachments = [],
  userAtts = [],
  queue = false,
  steer = false,
  client = null,
  computer = '',
  internalWake = false,
  ctx,
  vizPlatform: turnVizPlatform = 'desktop',
}) {
  const genKey = agyGenKey(ctx?.key || 'admin');
  // 先把进程取到手：成员的进程可能起不了（同时在用的人到上限、守卫被认定没生效），这时还没回任何东西，直接答错误
  let acp;
  try {
    acp = acpFor(ctx, sessionId);
  } catch (err) {
    if (res) replyJson(res, err?.status || 503, { error: err?.message || 'Antigravity 暂时不可用' });
    return;
  }
  if (sessionId) {
    noteSessionOwner(ctx, acp, sessionId);
    const liveSame = findGenBySession(genKey, sessionId);
    if (liveSame && !liveSame.done) {
      // 被动后台监视 gen 不是在跑的 session/prompt 轮：用户发新消息时先干净收掉它，不阻拦正常对话
      if (liveSame.backgroundWake && !acp.hasActiveTurn(sessionId)) {
        finishPassiveGenForSession(ctx?.key || 'admin', sessionId);
      } else {
        if (steer && res) {
          const done = steerAgyTurn(liveSame, { ctx, sessionId, message, attachments, userAtts, blocks: buildPromptBlocks(message, attachments) });
          if (done.ok) return replyJson(res, 200, { ok: true, steered: true, sessionId, steer: done.steer });
          // 这一轮还在挂载会话、没到能收消息的那一步（或正在被停下）：改成排队，别把话丢了
          queue = true;
        }
        if (queue && res) {
          // 这一轮还在跑：先排着，收尾后自动作为下一轮发出去（见 queue.mjs）
          const item = enqueue(genKey, sessionId, {
            text: message, attachments, atts: userAtts, opts: { model, thoughtLevel, mode }, client, vizPlatform: turnVizPlatform,
          });
          if (!item) return replyJson(res, 429, { error: '排队的消息太多了，先等它处理几条' });
          const items = listQueue(genKey, sessionId);
          genEmit(liveSame, { type: 'queue', sessionId, items });
          return replyJson(res, 200, { ok: true, queued: true, sessionId, item: queueView(item), queue: items });
        }
        if (res) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '该 Antigravity 会话已有任务正在执行，请等待完成或先停止当前任务' }));
        }
        return;
      }
    }
  }

  // queue / steer 请求撞上「其实已经跑完了」：直接开跑，回 JSON，客户端自己去挂直播
  if ((queue || steer) && res) {
    replyJson(res, 200, { ok: true, queued: false, started: true, sessionId: sessionId || null });
    res = null;
  }
  if (res) writeSseHeaders(res);
  const abort = new AbortController();
  let settleGen;
  const gen = {
    agent: 'agy',
    sessionId: sessionId || null,
    cwd: cwd || '',
    projectId: projectId || null,
    vizPlatform: turnVizPlatform === 'mobile' ? 'mobile' : 'desktop',
    // 后台兜底唤醒（internalWake）不展示成用户气泡，直接作为助手的续接回复附在对话末尾
    userText: internalWake ? '' : message,
    userAtts: internalWake ? [] : userAtts,
    internalWake: Boolean(internalWake),
    backgroundWake: Boolean(internalWake),
    turnOrigin: client?.origin || null,
    deviceLink: '',
    events: [],
    subscribers: new Set(),
    abort,
    done: false,
    startedAt: Date.now(),
    pendingPermission: null,
    pendingQuestion: null,
    settled: new Promise((resolve) => { settleGen = resolve; }),
  };

  setCurrentGen(genKey, gen);
  if (res) genSubscribe(gen, res);
  const send = (obj) => genEmit(gen, obj);
  const hb = startMultiHeartbeat(gen.subscribers);

  const settings = loadAgySettings(ctx?.agyDir);
  const savedMeta = sessionId ? getSessionMeta(ctx?.agyDir, sessionId) : null;
  const workDir = savedMeta?.cwd || cwd || settings.defaultCwd || ctx?.cwd || process.cwd();
  const effectiveProjectId = savedMeta?.projectId || projectId || null;
  gen.cwd = workDir;
  gen.projectId = effectiveProjectId;

  const desiredConfig = {
    ...(savedMeta?.config || {}),
    ...(!sessionId && settings.defaultModel ? { model: settings.defaultModel } : {}),
    ...(!sessionId && settings.defaultThoughtLevel ? { thought_level: settings.defaultThoughtLevel } : {}),
    ...(!sessionId && settings.defaultMode ? { mode: settings.defaultMode } : {}),
    ...(model ? { model } : {}),
    ...(thoughtLevel ? { thought_level: thoughtLevel } : {}),
    ...(mode ? { mode } : {}),
  };

  const promptBlocks = buildPromptBlocks(message, attachments);
  const { mcpServers, systemPromptAppend: effectiveSystemPrompt, toolingSig } = buildAgySessionTooling({
    ctx, settings, cwd: workDir, additionalDirectories,
  });
  let mountedSid = null;
  let sawMultiAgentTool = false;
  // 成员的进程：盯着守卫是不是真的在把关，没在就当场停（guard/liveness.mjs）
  let guardWatch = isAgyTenant(ctx) && guardLivenessOn() ? makeGuardWatch(ctx.key) : null;
  let guardTripped = false;
  // 这一轮收尾时替 agy 等自带生图子代理的回报，到了就续接；其余多代理交给 subagent-monitor.mjs 持续跟踪
  const background = makeBackgroundWaiter({
    dataDir: acp.dataDir,
    gen,
    send,
    onChange: () => publishAgyRun(ctx, gen),
    isAutoWaking: (sid) => readDbActivity(acp.dataDir, sid).hasRunning,
  });
  // 收尾时定下来：接着跑的那条排队消息
  let nextItem = null;
  const sidNow = () => mountedSid || sessionId || null;
  // 这一轮的结局交代排队的话怎么办：正常完成 → 取队首接着跑；人按了停止 → 整队退回输入框，
  // 除非点的是某条的「立即发送」（gen.sendQueuedId）；出错 → 整队退回。
  const settleQueue = (status) => {
    const sid = sidNow();
    if (!sid) return {};
    const wantId = gen.sendQueuedId || '';
    if (status === 'completed' || (status === 'interrupted' && wantId)) {
      nextItem = takeNext(genKey, sid, status === 'interrupted' ? wantId : '');
      return nextItem ? { next: queueView(nextItem), queue: listQueue(genKey, sid) } : {};
    }
    const back = drainQueue(genKey, sid).map(queueView);
    return back.length ? { queueReturned: back, queue: [] } : {};
  };
  // 续聊：一开跑别的设备就该看到；新会话要等 onSession 拿到 id
  if (sessionId) publishAgyRun(ctx, gen);

  // 这个会话连哪台电脑（device_* 工具的默认目标）：已经选过的不动；没选过时——新会话用设备芯片里的选择，
  // 其次是发起这条消息的那台桌面客户端（同 Claude：从哪台电脑发起就连哪台，之后从手机接着聊也还是它）。
  const myDevices = devicesEnabled() ? ownDevices(ctx) : [];
  const owns = (id) => myDevices.some((d) => d.id === id);
  const originPc = client?.fromComputer && owns(client.fromComputer) ? client.fromComputer : '';
  const picked = computer === 'none' || owns(computer) ? computer : '';
  gen.deviceLink = picked || originPc;
  const linkSession = (sid) => {
    if (!sid || !gen.deviceLink || !myDevices.length) return;
    try { if (!agentDeviceLink(ctx, 'agy', sid)) setAgentDeviceLink(ctx, 'agy', sid, gen.deviceLink); } catch {}
  };
  linkSession(sessionId);
  if (sessionId) noteSessionLabel(sessionId, savedMeta?.customTitle || savedMeta?.title || message);

  const onAccountSwitch = (ev) => {
    if (!ev) return;
    const curSid = sidNow();
    if (ev.sid && curSid && ev.sid !== curSid) return;
    send({
      type: 'account_switch',
      from: ev.from || '',
      to: ev.to || '',
      fromLabel: ev.fromLabel || '',
      toLabel: ev.toLabel || '',
      reason: ev.reason || '',
      group: ev.group || '',
      model: ev.model || '',
      sid: ev.sid || curSid || '',
      at: ev.at || Date.now(),
    });
  };
  agyUpstreamEvents.on('switch', onAccountSwitch);

  try {
    const result = await acp.runPrompt({
      sessionId,
      cwd: workDir,
      promptBlocks,
      mcpServers,
      systemPromptAppend: effectiveSystemPrompt,
      additionalDirectories,
      desiredConfig,
      toolingSig,
      signal: abort.signal,
      // 审批一直等到有人点（同 Claude 的逐次审批；人不在时靠通知叫回来）；表单提问按「提问无人回答时」那项设置
      permissionTimeoutMs: 0,
      questionTimeoutMs: questionTimeoutMs(ctx),
      onIdle: background.onIdle,
      onSession: (snapshot) => {
        const sid = snapshot.sessionId;
        mountedSid = sid;
        gen.sessionId = sid;
        noteSessionOwner(ctx, acp, sid);
        linkSession(sid);
        noteSessionLabel(sid, snapshot.title || savedMeta?.customTitle || savedMeta?.title || message);
        const summary = extractConfigSummary(snapshot.configOptions, snapshot.modes, snapshot.models);
        // 仅在 ACP 实际完成 session/new 或 session/resume 后才写入本地会话侧车表
        rememberSessionConfig(ctx?.agyDir, sid, {
          ...(summary.model ? { model: summary.model } : {}),
          ...(summary.thoughtLevel ? { thought_level: summary.thoughtLevel } : {}),
          ...(summary.mode ? { mode: summary.mode } : {}),
        }, {
          cwd: workDir,
          projectId: effectiveProjectId,
          additionalDirectories,
          hidden: false,
        });
        send({
          type: 'session',
          sessionId: sid,
          cwd: workDir,
          projectId: effectiveProjectId,
          ...summary,
          configOptions: snapshot.configOptions || [],
          modes: snapshot.modes || null,
          models: snapshot.models || null,
          tier: snapshot.tier || null,
        });
        publishAgyRun(ctx, gen);
      },
      onEvent: (evt) => {
        if (evt.type === 'title' && mountedSid) {
          noteSessionMeta(ctx?.agyDir, mountedSid, { title: evt.title, cwd: workDir, projectId: effectiveProjectId });
          noteSessionLabel(mountedSid, evt.title);
          publishAgySessions(ctx, { sessionId: mountedSid, why: 'title' });
        } else if (evt.type === 'config' && mountedSid) {
          rememberSessionConfig(ctx?.agyDir, mountedSid, {
            model: evt.model || undefined,
            thought_level: evt.thoughtLevel || undefined,
            mode: evt.mode || undefined,
          });
        } else if (evt.type === 'mode' && mountedSid) {
          rememberSessionConfig(ctx?.agyDir, mountedSid, { mode: evt.modeId });
        }
        if ((evt.type === 'tool' || evt.type === 'tool-update') && evt.tool?.name) {
          const tn = String(evt.tool.name).toLowerCase();
          const isImageSub = tn === 'invoke_subagent' && /image/i.test(String(evt.tool.args?.TypeName || ''));
          if (!isImageSub && (tn === 'invoke_subagent' || tn === 'send_message' || tn === 'run_workflow' || tn === 'swarm' || tn === 'post_message' || tn === 'read_board' || tn === 'swarm_wait' || tn === 'schedule')) {
            sawMultiAgentTool = true;
            if (mountedSid) armSubagentMonitor(ctx, acp, mountedSid);
          }
        }
        if (guardWatch && guardWatch(evt)) {
          guardWatch = null;
          guardTripped = true;
          try { abort.abort(); } catch {}
          tripTenantGuard(ctx, `工具 ${evt.tool?.name || evt.tool?.title || ''} 执行完了，守卫却没被问过`);
        }
        send(evt);
      },
      onPermission: (perm) => {
        gen.pendingPermission = perm;
        send(perm);
        noticeAgyPending(ctx, gen);
        publishAgyRun(ctx, gen);
      },
      onPermissionResolved: (resolved) => {
        if (gen.pendingPermission?.requestId === resolved.requestId) {
          gen.pendingPermission = null;
          publishAgyRun(ctx, gen);
        }
        // 自动放行的不记审批结果（重开历史时也就不挂「已允许」）
        if (mountedSid && resolved.toolCallId && !resolved.auto) {
          const denied = resolved.outcome === 'cancelled' || /^(?:deny|reject)/i.test(String(resolved.optionId || ''));
          noteSessionMeta(ctx?.agyDir, mountedSid, {
            toolApprovals: { [resolved.toolCallId]: denied ? 'denied' : 'allowed' },
          });
        }
        send({ type: 'permission-resolved', ...resolved });
      },
      onQuestion: (q) => {
        gen.pendingQuestion = q;
        send(q);
        noticeAgyPending(ctx, gen);
        publishAgyRun(ctx, gen);
      },
      onQuestionResolved: (resolved) => {
        if (gen.pendingQuestion?.requestId === resolved.requestId) {
          gen.pendingQuestion = null;
          publishAgyRun(ctx, gen);
        }
        send({ type: 'question-resolved', ...resolved });
      },
    });

    const convId = mountedSid || result.sessionId || null;
    runAgyTurnEndHooks(ctx, gen, { status: result.status || 'completed', text: result.text || '' });
    // 本轮用时与 token（输出 + 思考）：给消息底部状态栏；记进会话元数据，重新打开时最后一轮也能显示
    const elapsedMs = Math.max(0, Date.now() - (gen.startedAt || Date.now()));
    const turnTokens = result.usage
      ? (Number(result.usage.outputTokens) || 0) + (Number(result.usage.thoughtTokens) || 0)
      : 0;
    if (mountedSid) {
      noteSessionMeta(ctx?.agyDir, mountedSid, {
        cwd: workDir,
        projectId: effectiveProjectId,
        additionalDirectories,
        hidden: false,
        lastTurnStatus: result.status || 'completed',
        ...(!internalWake ? {
          lastTurnStats: {
            ms: elapsedMs,
            tokens: turnTokens,
            status: result.status || 'completed',
            prompt: String(gen.lastUserText ?? message ?? '').slice(0, 200),
            at: new Date().toISOString(),
          },
        } : {}),
        ...(result.status === 'interrupted' && !internalWake
          ? {
            appendInterruptedTurn: {
              prompt: String(gen.lastUserText ?? message ?? ''),
              partialText: String((gen.lastUserText != null ? result.segText : result.text) || ''),
              at: new Date().toISOString(),
            },
          }
          : {}),
      });
    }

    // 交付物严格限制在上传目录、当前会话工作目录及已授权的附加目录内（管理员亦不豁免，与 /api/agy/artifact 边界对齐）
    const assistantAttachments = collectDeliverableAttachments(result.text, {
      workDir,
      additionalDirectories,
      uploads: ctx?.uploads,
      // agy 自带的生图把成品存在会话自己的产物目录里（不在工作目录）
      artifactDir: sessionBrainDir(acp.dataDir, convId),
    });

    if (guardTripped) {
      send({
        type: 'error',
        status: 'failed',
        message: GUARD_BROKEN_MESSAGE,
        result: result.text || '',
        sessionId: convId,
        elapsedMs,
        ...settleQueue('failed'),
      });
      noticeAgyEnd(ctx, gen, { kind: 'error', text: GUARD_BROKEN_MESSAGE });
    } else if (result.status === 'interrupted') {
      send({
        type: 'interrupted',
        result: result.text || '',
        status: 'interrupted',
        sessionId: convId,
        usage: result.usage || undefined,
        contextUsage: result.contextUsage || undefined,
        attachments: assistantAttachments,
        elapsedMs,
        ...settleQueue('interrupted'),
      });
    } else if (result.isError || result.status === 'failed' || result.status === 'timed_out') {
      const errMsg = 'Antigravity 调用失败：' + (result.errorMsg || '未知错误');
      send({
        type: 'error',
        status: result.status || 'failed',
        message: errMsg,
        result: result.text || '',
        sessionId: convId,
        attachments: assistantAttachments,
        elapsedMs,
        ...settleQueue('failed'),
      });
      noticeAgyEnd(ctx, gen, { kind: 'error', text: errMsg });
    } else {
      const queued = settleQueue('completed');
      send({
        type: 'done',
        result: result.text || '',
        status: 'completed',
        isError: false,
        cost: 0,
        sessionId: convId,
        usage: result.usage || undefined,
        contextUsage: result.contextUsage || undefined,
        attachments: assistantAttachments,
        elapsedMs,
        ...queued,
      });
      // 后面还排着话要接着跑：这一轮不算「做完了」，等最后一轮再通知
      if (!nextItem) noticeAgyEnd(ctx, gen, { kind: 'done', text: result.text || '' });
    }
  } catch (err) {
    const errMsg = guardTripped ? GUARD_BROKEN_MESSAGE : 'Antigravity 调用失败：' + String(err?.message || err);
    send({
      type: 'error',
      status: 'failed',
      message: errMsg,
      sessionId: mountedSid || sessionId || null,
      ...settleQueue('failed'),
    });
    noticeAgyEnd(ctx, gen, { kind: 'error', text: errMsg });
  } finally {
    agyUpstreamEvents.off('switch', onAccountSwitch);
    gen.pendingPermission = null;
    gen.pendingQuestion = null;
    clearInterval(hb);
    genFinish(gen);
    retireGen(genKey, gen);
    settleGen?.();
    // 排着的下一条：同步登记新一轮（客户端收到上面的终止事件后会立刻来挂直播，那时新 gen 必须已经在了）
    if (nextItem && sidNow()) {
      const it = nextItem;
      runAgyChat(null, null, {
        message: it.text,
        sessionId: sidNow(),
        cwd: workDir,
        projectId: effectiveProjectId,
        model: it.opts?.model,
        thoughtLevel: it.opts?.thoughtLevel,
        mode: it.opts?.mode,
        additionalDirectories,
        attachments: it.attachments,
        userAtts: it.atts,
        client: it.client || client,
        vizPlatform: it.vizPlatform || turnVizPlatform,
        ctx,
      }).catch((err) => console.error('[agy] 排队消息开跑失败：', err?.message || err));
    } else {
      publishAgyRun(ctx, gen, { live: false });
      const finalSid = sidNow();
      if (finalSid && acp?.dataDir) {
        markSessionTranscriptSynced(ctx?.key || 'admin', acp, finalSid);
        if (sawMultiAgentTool || hasProtectedSubagents(acp.dataDir, finalSid)) {
          armSubagentMonitor(ctx, acp, finalSid, { pollNow: true });
        }
      }
    }
  }
}
