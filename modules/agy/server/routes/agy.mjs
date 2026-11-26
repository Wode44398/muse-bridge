// Antigravity 分页 REST 与 SSE 路由：会话列表 / 历史恢复 / 隐藏重命名（收藏、彻底删除、全文搜索见 agy-session-manage.mjs）、在线配置切换、
// 权限与表单提问应答、任务中止与重连重放、守护进程状态与重启、分页设置与项目。

import { createReadStream, realpathSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import path from 'node:path';
import { readBody } from '@bridge/core/runtime/body.mjs';
import { requireCtx } from '@bridge/core/runtime/identity.mjs';
import { writeSseHeaders } from '@bridge/core/runtime/sse.mjs';
import {
  getCurrentGen, getLiveGens, findGenBySession, genWrite, genSubscribe,
} from '@bridge/core/runtime/gen.mjs';
import { isPathInside, streamFile } from '@bridge/core/runtime/http-file.mjs';
import { isHtmlFile, respondHtmlSite } from '@bridge/core/runtime/html-site.mjs';
import { refreshAgentStatus } from '@bridge/core/runtime/agent-status.mjs';
import { pluginOn } from '@bridge/core/plugins/state.mjs';
import { CAPABILITIES } from '@bridge/core/config/capabilities.mjs';
import { getAcpClient, acpFor, acpPrimary, acpClientsOf, restartAgy } from '../acp/index.mjs';
import { isAgyTenant } from '../tenants.mjs';
import { guardBroken, GUARD_BROKEN_MESSAGE } from '../guard/liveness.mjs';
import { registerAgyGuardRoutes } from './agy-guard.mjs';
import { agyDataDir } from '../acp/binary.mjs';
import { agyGenKey } from '../agents/agy.mjs';
import {
  listAgySessions, loadAgySessionDetail, hideSession, hideSessions, restoreSession,
  restoreAllHiddenSessions, countHiddenSessions, renameSession, getSessionMeta,
  rememberSessionConfig, resolveVerifiedSessionCwd,
} from '../sessions.mjs';
import {
  loadAgySettings, saveAgySettings, DEFAULT_AGY_SETTINGS,
} from '../settings.mjs';
import { listProjects, projectOrder, setProjectOrder, createProject, pinProject, renameProject, deleteProject, getProject, authorizeProjectPath } from '../projects.mjs';
import { buildAgySessionTooling } from '../mcp/config.mjs';
import { answerBridgeQuestion } from '../mcp/ask.mjs';
import {
  readAgyAccountInfo,
  resolveAgyLogInfo,
  getAgyCliVersion,
  probeCatalogAndTierIfNeeded,
} from '../cli-ops.mjs';
import { registerAgySettingsRoutes } from './agy-settings.mjs';
import { registerAgyPoolRoutes } from './agy-pool.mjs';
import { getAgyQuota } from '../quota.mjs';
import {
  activeAccountId,
  boundAccountForSession,
  effectivePlan,
  fetchAccountQuota,
  getAccountInternal,
  getActiveAccount,
  hasNonLocalAccounts,
  noteQuotaBuckets,
  smartActive,
} from '../pool/index.mjs';
import { registerAgyInternalRoutes } from './agy-internal.mjs';
import { registerAgySessionManageRoutes } from './agy-session-manage.mjs';
import { registerAgySubagentRoutes } from './agy-subagents.mjs';
import { stopSubagentMonitor, noteSessionOwner, listBackgroundWaitingSessions } from '../subagent-monitor.mjs';
import { runView, publishAgySessions, publishAgyProjects } from '../presence.mjs';
import { listQueue, removeQueued, queueView } from '../queue.mjs';
import { sessionBrainDir } from '../background.mjs';
import { isSessionArtifact } from '../deliverables.mjs';
import { isSwarmFrameFile } from '../swarm.mjs';
import { genEmit } from '@bridge/core/runtime/gen.mjs';

const sendJson = (res, code, obj, extraHeaders = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(obj));
};

async function parseJsonBody(req, res) {
  let parsed;
  try {
    const raw = await readBody(req);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: '请求体不是合法 JSON' });
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
    return null;
  }
  return parsed;
}

// 审批 / 提问按 requestId 应答：请求可能来自主进程，也可能来自桌面版存储进程，逐个试到命中为止。
// 只在这个身份自己名下的进程里找——requestId 是每个进程各自从 1 数起的小整数，跨身份去试就能替别人点允许。
function answerAcross(ctx, fn) {
  let last = null;
  for (const c of acpClientsOf(ctx)) {
    last = fn(c);
    if (last?.ok) return last;
  }
  return last || { ok: false, error: '该请求已结束或不存在' };
}

export function registerAgyRoutes(router, { identify }) {
  const agyCtx = (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return null;
    if (!ctx.allowAgy) {
      sendJson(res, 403, { error: 'Antigravity 未启用，或你的账号没有使用权限' });
      return null;
    }
    // 守卫被认定没生效的成员：他的进程不再起，所有接口统一答这一句（不然各处取进程时各抛各的）
    if (isAgyTenant(ctx) && guardBroken(ctx.key)) {
      sendJson(res, 503, { error: GUARD_BROKEN_MESSAGE });
      return null;
    }
    return ctx;
  };

  // 主机上那个 agy 的事（账号登出、全局 MCP 服务与插件、CLI 升级）：只给主机管理员。
  // 注册成员用自己单独的进程，但登录态、agy 的全局配置是主机的；这几样又都能在主机上执行任意命令。
  const hostAdminCtx = (req, res) => {
    const ctx = agyCtx(req, res);
    if (!ctx) return null;
    if (ctx.kind !== 'admin') {
      sendJson(res, 403, { error: '这项设置只有主机管理员能动' });
      return null;
    }
    return ctx;
  };

  const genKeyOf = (ctx) => agyGenKey(ctx.key);

  // ── 守护进程状态 / 重启 / 登出 ──────────────────────────────────────────────
  router.on('GET', '/api/agy/status', async (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const client = acpPrimary(ctx);
    const host = ctx.kind === 'admin';
    if (url.searchParams.get('ensure') === '1' && !client.status().running && !client.stoppedAfterCrashes) {
      try { await client.ensureStarted(); } catch {}
    }
    if (url.searchParams.get('probe') === '1' && !client.stoppedAfterCrashes) {
      await probeCatalogAndTierIfNeeded(client);
    }
    const status = client.status();
    const cliVersion = await getAgyCliVersion(client);
    const localAccount = readAgyAccountInfo(host ? client : getAcpClient());
    const activeAcct = getActiveAccount();
    const hostAccount = hasNonLocalAccounts() && activeAcct && activeAcct.source !== 'local'
      ? {
        ...localAccount,
        authed: true,
        email: activeAcct.email || localAccount.email,
        tier: activeAcct.tierName || localAccount.tier || effectivePlan(activeAcct) || null,
        localAuthed: localAccount.authed,
        poolAccount: {
          id: activeAcct.id,
          label: activeAcct.label,
          email: activeAcct.email,
          plan: effectivePlan(activeAcct),
          source: activeAcct.source,
        },
      }
      : {
        ...localAccount,
        localAuthed: localAccount.authed,
        ...(activeAcct ? {
          poolAccount: {
            id: activeAcct.id,
            label: activeAcct.label,
            email: activeAcct.email || localAccount.email || '',
            plan: effectivePlan(activeAcct),
            source: activeAcct.source,
          },
        } : {}),
      };
    // 服务器上的路径（CLI 装在哪、进程的占位目录、日志文件）只给主机管理员
    const shown = host ? status : { ...status, cliPath: '', daemonCwd: '', logFile: '', dataDir: '' };
    sendJson(res, 200, {
      ...shown,
      cliVersion,
      // 登录与号池属于主机管理员：成员只需要知道「登没登上」，邮箱、号池细节与日志位置不给
      account: host
        ? hostAccount
        : { authed: hasNonLocalAccounts() || localAccount.authed, email: null, authMethod: null, tier: null },
      logInfo: host ? resolveAgyLogInfo(client) : null,
      hiddenCount: countHiddenSessions(ctx.agyDir),
      // 没选文件夹就发消息时会话实际落到的目录（工作空间根）：前端文件夹芯片据此如实显示
      defaultCwd: ctx.cwd || '',
      fallbackCapabilities: CAPABILITIES.agy || null,
    }, { 'Cache-Control': 'no-store' });
  });

  // 账号模型额度（开口仪表中间那个数字 + 弹层明细）：按当前活动号（智能分派时按会话绑定号）查询；
  // 本机默认号优先读 agy 内嵌 language server（1–2ms）并反哺号池缓存，OAuth 池内号直查 CCPA。
  router.on('GET', '/api/agy/quota', async (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const host = ctx.kind === 'admin';
    const force = url.searchParams.get('force') === '1';
    const sid = String(url.searchParams.get('session') || '').trim();
    const targetId = (smartActive() && sid && boundAccountForSession(sid)) || activeAccountId();
    const acct = targetId ? getAccountInternal(targetId) : null;
    const accountTag = host && acct
      ? { id: acct.id, label: acct.label, email: acct.email, plan: effectivePlan(acct), source: acct.source }
      : null;

    if (acct && (acct.refreshToken || acct.source === 'slot')) {
      const q = await fetchAccountQuota(acct.id, { force });
      sendJson(res, 200, {
        buckets: q?.buckets || [],
        at: q?.at || Date.now(),
        error: q?.error || null,
        ...(q?.stale ? { stale: true } : {}),
        ...(accountTag ? { account: accountTag } : {}),
      }, { 'Cache-Control': 'no-store' });
      return;
    }

    const q = await getAgyQuota(acpPrimary(ctx), { force });
    if (!q.error && Array.isArray(q.buckets) && q.buckets.length) {
      if (acct) noteQuotaBuckets(acct.id, q.buckets, q.at);
      sendJson(res, 200, accountTag ? { ...q, account: accountTag } : q, { 'Cache-Control': 'no-store' });
      return;
    }
    if (acct) {
      const direct = await fetchAccountQuota(acct.id, { force });
      if (direct && !direct.error && direct.buckets?.length) {
        sendJson(res, 200, {
          buckets: direct.buckets,
          at: direct.at,
          error: null,
          ...(accountTag ? { account: accountTag } : {}),
        }, { 'Cache-Control': 'no-store' });
        return;
      }
    }
    sendJson(res, 200, accountTag ? { ...q, account: accountTag } : q, { 'Cache-Control': 'no-store' });
  });

  router.on('POST', '/api/agy/restart', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    for (const live of getLiveGens(genKeyOf(ctx))) {
      try { live.abort.abort(); } catch {}
    }
    try {
      // 成员重启的是他自己的那个进程，碰不到主机上的常驻进程和别人的
      const status = isAgyTenant(ctx) ? await acpPrimary(ctx).restart({ remountIdle: true }) : await restartAgy({ remountIdle: true });
      refreshAgentStatus();
      sendJson(res, 200, { ok: true, status });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
  });

  router.on('POST', '/api/agy/logout', async (req, res) => {
    const ctx = hostAdminCtx(req, res); if (!ctx) return;
    try {
      await getAcpClient().logout();
      refreshAgentStatus();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
  });

  // ── 分页设置读写 ────────────────────────────────────────────────────────────
  router.on('GET', '/api/agy/settings', (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    sendJson(res, 200, {
      settings: loadAgySettings(ctx.agyDir),
      defaults: DEFAULT_AGY_SETTINGS,
      hiddenCount: countHiddenSessions(ctx.agyDir),
      phonePluginOn: pluginOn('phone-files'),
    }, { 'Cache-Control': 'no-store' });
  });

  router.on(['POST', 'PUT'], '/api/agy/settings', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const prevSettings = loadAgySettings(ctx.agyDir);
    const patch = { ...body };
    try {
      if (typeof patch.defaultCwd === 'string' && patch.defaultCwd.trim()) {
        patch.defaultCwd = authorizeProjectPath(ctx, patch.defaultCwd.trim());
      }
      if (patch.defaultProjectId) {
        const proj = getProject(ctx.agyProjects, String(patch.defaultProjectId));
        if (!proj) {
          sendJson(res, 400, { error: '默认项目不存在' });
          return;
        }
        patch.defaultCwd = proj.path;
      } else if (patch.defaultProjectId === '') {
        patch.defaultCwd = patch.defaultCwd || '';
      }
      if (Array.isArray(patch.additionalDirectories)) {
        const authedDirs = [];
        for (const rawDir of patch.additionalDirectories.slice(0, 16)) {
          if (typeof rawDir !== 'string' || !rawDir.trim()) continue;
          authedDirs.push(authorizeProjectPath(ctx, rawDir.trim()));
        }
        patch.additionalDirectories = authedDirs;
      }
    } catch (err) {
      sendJson(res, err?.status || 400, { ok: false, error: err?.message || '工作目录授权校验失败' });
      return;
    }
    const settings = saveAgySettings(ctx.agyDir, patch);
    // agy 内部会跨会话池化复用 stdio MCP 子进程；Bridge 工具开关变更时请求在空闲点静默重启刷新工具列表，
    // 若当前有准备中或在跑的轮次则自动顺延至最后一轮收尾后再重启，绝不误杀在途对话。
    // 调试模式同理：它在系统提示里，而系统提示只在挂载会话时带给 agy，换过进程重新挂载才用得上新的。
    if (JSON.stringify(prevSettings.bridgeTools) !== JSON.stringify(settings.bridgeTools)
      || prevSettings.debugMode !== settings.debugMode) {
      acpPrimary(ctx).requestIdleRestart({ remountIdle: false }).catch(() => {});
    }
    sendJson(res, 200, { ok: true, settings, phonePluginOn: pluginOn('phone-files') });
  });

  registerAgySettingsRoutes(router, { agyCtx: hostAdminCtx, parseJsonBody, sendJson });
  registerAgyPoolRoutes(router, { agyCtx: hostAdminCtx, parseJsonBody, sendJson });
  registerAgyGuardRoutes(router, { parseJsonBody, sendJson });
  registerAgyInternalRoutes(router, { parseJsonBody, sendJson });
  registerAgySessionManageRoutes(router, { agyCtx, parseJsonBody, sendJson });
  registerAgySubagentRoutes(router, { agyCtx, parseJsonBody, sendJson });

  // ── 项目管理（cwd 分组）────────────────────────────────────────────────────
  router.on('GET', '/api/agy/projects', (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    sendJson(res, 200, { projects: listProjects(ctx.agyProjects), order: projectOrder(ctx.agyProjects) });
  });

  router.on('POST', '/api/agy/project/order', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const order = setProjectOrder(ctx.agyProjects, ctx, body.paths);
      publishAgyProjects(ctx, { why: 'order' });
      sendJson(res, 200, { ok: true, order });
    } catch (err) {
      sendJson(res, err?.status || 400, { error: err?.message || '无法保存工作空间顺序' });
    }
  });

  router.on('POST', '/api/agy/project/create', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const project = createProject(ctx.agyProjects, ctx, body);
      publishAgyProjects(ctx, { projectId: project.id, why: 'create' });
      sendJson(res, 200, { ok: true, project, projects: listProjects(ctx.agyProjects), order: projectOrder(ctx.agyProjects) });
    } catch (err) {
      sendJson(res, err?.status || 400, { error: err?.message || '无法创建项目' });
    }
  });

  router.on('POST', '/api/agy/project/pin', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const pinned = body.pinned !== false;
      const project = pinProject(ctx.agyProjects, ctx, {
        id: body.id || body.projectId || '',
        path: body.path || '',
        pinned,
      });
      publishAgyProjects(ctx, { projectId: project?.id || String(body.id || ''), why: pinned ? 'pin' : 'unpin' });
      sendJson(res, 200, { ok: true, project, projects: listProjects(ctx.agyProjects), order: projectOrder(ctx.agyProjects) });
    } catch (err) {
      sendJson(res, err?.status || 400, { error: err?.message || '无法置顶工作空间' });
    }
  });

  // 只改侧栏显示名，不动磁盘目录
  router.on('POST', '/api/agy/project/rename', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const project = renameProject(ctx.agyProjects, ctx, {
        id: body.id || body.projectId || '',
        path: body.path || '',
        name: typeof body.name === 'string' ? body.name : '',
      });
      publishAgyProjects(ctx, { projectId: project.id, why: 'rename' });
      sendJson(res, 200, { ok: true, project, projects: listProjects(ctx.agyProjects), order: projectOrder(ctx.agyProjects) });
    } catch (err) {
      sendJson(res, err?.status || 400, { error: err?.message || '无法重命名工作空间' });
    }
  });

  router.on('POST', '/api/agy/project/delete', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    try {
      const result = deleteProject(ctx.agyProjects, ctx, {
        id: body.id || body.projectId || '',
        path: body.path || '',
      });
      if (result.project) {
        const curSettings = loadAgySettings(ctx.agyDir);
        if (curSettings.defaultProjectId === result.project.id) {
          saveAgySettings(ctx.agyDir, { defaultProjectId: '', defaultCwd: '' });
        }
      }
      publishAgyProjects(ctx, { projectId: result.project?.id || String(body.id || ''), why: 'delete' });
      sendJson(res, 200, { ok: true, deleted: result.deleted, projects: listProjects(ctx.agyProjects), order: projectOrder(ctx.agyProjects) });
    } catch (err) {
      sendJson(res, err?.status || 400, { error: err?.message || '无法移除工作空间' });
    }
  });

  // ── 会话列表 / 详情恢复 / 重命名 / 隐藏与恢复 ───────────────────────────────
  router.on('GET', '/api/agy/sessions', async (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const result = await listAgySessions(ctx, {
      cwd: url.searchParams.get('cwd') || '',
      projectId: url.searchParams.get('projectId') || '',
      query: url.searchParams.get('q') || '',
      includeHidden: url.searchParams.get('includeHidden') === '1',
      refresh: url.searchParams.get('refresh') === '1',
    });
    sendJson(res, 200, result);
  });

  const handleGetSession = async (req, res, url, explicitId = '') => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const id = String(explicitId || url.searchParams.get('id') || '').trim();
    if (!id) { sendJson(res, 400, { error: '缺少会话 id' }); return; }
    try {
      const detail = await loadAgySessionDetail(ctx, id, {
        cwd: url.searchParams.get('cwd') || '',
        fp: url.searchParams.get('fp') || '',
      });
      sendJson(res, 200, detail);
    } catch (err) {
      sendJson(res, err?.status || 500, { error: err?.message || '加载会话失败' });
    }
  };

  router.on('GET', '/api/agy/session', (req, res, url) => handleGetSession(req, res, url));
  router.prefix('GET', '/api/agy/session/', (req, res, url) => {
    const tail = decodeURIComponent(url.pathname.slice('/api/agy/session/'.length)).replace(/\/+$/, '');
    if (!tail || tail.includes('/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    return handleGetSession(req, res, url, tail);
  });

  router.on('POST', '/api/agy/session/delete', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const id = String(body.id || body.sessionId || '').trim();
    if (!id) { sendJson(res, 400, { error: '缺少会话 id' }); return; }
    hideSession(ctx.agyDir, id);
    stopSubagentMonitor(ctx.key, id);
    const owner = acpFor(ctx, id);
    await owner.closeSession(id).catch(() => {});
    owner.forgetSession(id);
    publishAgySessions(ctx, { sessionId: id, why: 'hide' });
    sendJson(res, 200, { ok: true, hidden: true });
  });

  router.on('POST', '/api/agy/sessions/hide', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const rawIds = Array.isArray(body.ids) ? body.ids : [];
    const ids = [...new Set(rawIds.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 500);
    if (!ids.length) { sendJson(res, 400, { error: '缺少会话 id' }); return; }
    const hidden = hideSessions(ctx.agyDir, ids);
    for (const id of hidden) {
      stopSubagentMonitor(ctx.key, id);
      const owner = acpFor(ctx, id);
      await owner.closeSession(id).catch(() => {});
      owner.forgetSession(id);
    }
    if (hidden.length > 0) {
      publishAgySessions(ctx, { why: 'hide' });
    }
    sendJson(res, 200, { ok: true, hidden: hidden.length, ids: hidden });
  });

  router.on('POST', '/api/agy/session/restore', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const id = String(body.id || body.sessionId || '').trim();
    if (!id) { sendJson(res, 400, { error: '缺少会话 id' }); return; }
    restoreSession(ctx.agyDir, id);
    publishAgySessions(ctx, { sessionId: id, why: 'restore' });
    sendJson(res, 200, { ok: true });
  });

  router.on('POST', '/api/agy/sessions/restore-all', (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const restored = restoreAllHiddenSessions(ctx.agyDir);
    publishAgySessions(ctx, { why: 'restore' });
    sendJson(res, 200, { ok: true, restored });
  });

  router.on('POST', '/api/agy/session/rename', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const id = String(body.id || body.sessionId || '').trim();
    if (!id) { sendJson(res, 400, { error: '缺少会话 id' }); return; }
    const meta = renameSession(ctx.agyDir, id, body.title ?? '');
    publishAgySessions(ctx, { sessionId: id, why: 'rename' });
    sendJson(res, 200, { ok: true, title: meta?.customTitle || meta?.title || '' });
  });

  // ── 会话内实时切换模型 / 思考档位 / 模式 ────────────────────────────────────
  router.on('POST', '/api/agy/config', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const sessionId = String(body.sessionId || body.id || '').trim();
    if (!sessionId) { sendJson(res, 400, { error: '缺少 sessionId' }); return; }

    const settings = loadAgySettings(ctx.agyDir);
    const meta = getSessionMeta(ctx.agyDir, sessionId);
    const verifiedCwd = meta?.cwd || await resolveVerifiedSessionCwd(ctx, sessionId);
    let sessionCwd = verifiedCwd;
    if (!sessionCwd && body.cwd) {
      try { sessionCwd = authorizeProjectPath(ctx, body.cwd); } catch {}
    }
    if (!sessionCwd) sessionCwd = settings.defaultCwd || ctx.cwd;

    const resolvedMountCwd = verifiedCwd || sessionCwd;
    const extraDirs = Array.isArray(meta?.additionalDirectories) ? meta.additionalDirectories : [];
    const tooling = buildAgySessionTooling({ ctx, settings, cwd: resolvedMountCwd, additionalDirectories: extraDirs });
    const sessionMeta = {
      cwd: resolvedMountCwd,
      forceCwd: !!verifiedCwd,
      mcpServers: tooling.mcpServers,
      additionalDirectories: extraDirs,
      systemPromptAppend: tooling.systemPromptAppend,
    };

    try {
      const client = acpFor(ctx, sessionId);
      noteSessionOwner(ctx, client, sessionId);
      client.noteTooling?.(tooling.toolingSig);   // 改配置也会挂载会话：工具清单变了同样先换进程
      let out;
      if (body.configId) {
        out = await client.setConfigOption(sessionId, body.configId, body.value, sessionMeta);
      } else if (body.modeId) {
        out = await client.setMode(sessionId, body.modeId, sessionMeta);
      } else if (body.modelId) {
        out = await client.setModel(sessionId, body.modelId, sessionMeta);
      } else {
        sendJson(res, 400, { error: '请提供 configId、modeId 或 modelId' });
        return;
      }

      rememberSessionConfig(ctx.agyDir, sessionId, {
        ...(out.model ? { model: out.model } : {}),
        ...(out.thoughtLevel ? { thought_level: out.thoughtLevel } : {}),
        ...(out.mode ? { mode: out.mode } : {}),
      }, verifiedCwd ? { cwd: verifiedCwd } : {});

      sendJson(res, 200, { ok: true, sessionId, ...out });
    } catch (err) {
      sendJson(res, err?.status || 500, { ok: false, error: err?.message || '切换配置失败' });
    }
  });

  // ── 权限审批与表单提问回答 ──────────────────────────────────────────────────
  router.on('POST', '/api/agy/permission', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const requestId = String(body.requestId ?? body.id ?? '');
    if (!requestId) { sendJson(res, 400, { error: '缺少 requestId' }); return; }

    const outcome = body.outcome === 'cancelled' || body.cancel === true ? 'cancelled' : 'selected';
    const optionId = body.optionId || (body.allow === true ? 'allow' : (body.allow === false ? 'deny' : ''));
    try {
      const r = answerAcross(ctx, (c) => c.answerPermission(requestId, { optionId, outcome }));
      sendJson(res, r.ok ? 200 : 409, r);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
  });

  router.on('POST', '/api/agy/question', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const requestId = String(body.requestId ?? body.id ?? '');
    if (!requestId) { sendJson(res, 400, { error: '缺少 requestId' }); return; }

    const action = body.action || (body.cancel === true ? 'cancel' : 'accept');
    const content = body.content && typeof body.content === 'object' ? body.content : {};
    // bridge 自己弹的确认卡（发短信、开自动合并之类，mcp/ask.mjs）不在 ACP 那边
    const own = answerBridgeQuestion(ctx, requestId, { action, content });
    if (own) { sendJson(res, own.ok ? 200 : 409, own); return; }
    try {
      const r = answerAcross(ctx, (c) => c.answerQuestion(requestId, { action, content }));
      sendJson(res, r.ok ? 200 : 409, r);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
  });

  // ── 在跑状态探测 / 断线重放挂载 / 停止当前轮 ────────────────────────────────
  router.on('GET', '/api/agy/active', (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const key = genKeyOf(ctx);
    const wantedSid = String(url.searchParams.get('session') || '').trim();
    const liveAll = getLiveGens(key);
    const gen = wantedSid ? findGenBySession(key, wantedSid) : getCurrentGen(key);
    const active = !!(gen && !gen.done);

    sendJson(res, 200, {
      active,
      sessionId: active ? (gen.sessionId || null) : null,
      cwd: active ? (gen.cwd || '') : '',
      projectId: active ? (gen.projectId || null) : null,
      userText: active ? (gen.userText || '') : '',
      startedAt: active ? (gen.startedAt || 0) : 0,
      backgroundWake: active ? Boolean(gen.backgroundWake) : false,
      pendingPermission: active ? (gen.pendingPermission || null) : null,
      pendingPermissions: active ? (Array.isArray(gen.pendingPermissions) ? gen.pendingPermissions : (gen.pendingPermission ? [gen.pendingPermission] : [])) : [],
      pendingQuestion: active ? (gen.pendingQuestion || null) : null,
      // 排着队的消息（这一轮收尾后依次发出，见 queue.mjs）
      queue: active && gen.sessionId ? listQueue(key, gen.sessionId) : [],
      // pending：这个会话眼下在等审批（permission）/ 等回答（question）/ 没在等（''）——侧栏的「在等你」点
      // 这一轮正等着的后台子代理（agy 自带生图等）：[{ id, typeName, kind, startedAt }]
      background: active && Array.isArray(gen.background) ? gen.background : [],
      activeSessions: liveAll.map((g) => runView(g)),
      // 这一轮说完了、后台还在跑的会话（侧栏的空心环；之后的变化走总线 agy.subagents 的 bgWaiting）
      bgSessions: listBackgroundWaitingSessions(ctx.key),
      // 这台服务端会为 agy 发会话消息通知（/api/active 的 notices，带 agent:'agy'）：桌面壳据此不再自己按快照猜「跑完了」
      notices: true,
    });
  });

  // ── 排队消息：撤回一条 / 立即发送一条（停下手头这一步，马上把它作为下一轮发出去）──────────
  router.on('POST', '/api/agy/queue/remove', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const sid = String(body.sessionId || '').trim();
    const id = String(body.id || '').trim();
    if (!sid || !id) { sendJson(res, 400, { error: '缺少 sessionId 或 id' }); return; }
    const key = genKeyOf(ctx);
    const item = removeQueued(key, sid, id);
    const items = listQueue(key, sid);
    const gen = findGenBySession(key, sid);
    if (item && gen && !gen.done) genEmit(gen, { type: 'queue', sessionId: sid, items });
    sendJson(res, item ? 200 : 404, item ? { ok: true, item: queueView(item), queue: items } : { ok: false, error: '这条已经发出去或被撤回了', queue: items });
  });

  router.on('POST', '/api/agy/queue/send-now', async (req, res) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const sid = String(body.sessionId || '').trim();
    const id = String(body.id || '').trim();
    if (!sid || !id) { sendJson(res, 400, { error: '缺少 sessionId 或 id' }); return; }
    const key = genKeyOf(ctx);
    const gen = findGenBySession(key, sid);
    if (!gen || gen.done) { sendJson(res, 409, { ok: false, error: '这一轮已经结束，排着的消息会自动发出' }); return; }
    if (!listQueue(key, sid).some((x) => x.id === id)) { sendJson(res, 404, { ok: false, error: '这条已经发出去或被撤回了' }); return; }
    // 收尾处按这个 id 取下一条（agents/agy.mjs settleQueue），其余的继续排着
    gen.sendQueuedId = id;
    try { gen.abort.abort(); } catch {}
    sendJson(res, 200, { ok: true });
  });

  router.on(['GET', 'POST'], '/api/agy/attach', (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const key = genKeyOf(ctx);
    const wantedSid = String(url.searchParams.get('session') || '').trim();
    const gen = wantedSid ? findGenBySession(key, wantedSid) : getCurrentGen(key);
    if (!gen) { res.writeHead(204); res.end(); return; }

    writeSseHeaders(res);
    genWrite(res, {
      type: 'attach',
      agent: 'agy',
      userText: gen.userText || '',
      sessionId: gen.sessionId || null,
      cwd: gen.cwd || '',
      projectId: gen.projectId || null,
      done: !!gen.done,
      backgroundWake: Boolean(gen.backgroundWake),
      elapsedMs: Math.max(0, Date.now() - (gen.startedAt || Date.now())),
      // turn：这一轮的标识（开跑时刻）；userAtts：这一轮用户附的图 / 文件（别的设备挂上来、排队消息开跑时气泡里要有）
      turn: gen.startedAt || 0,
      ...(Array.isArray(gen.userAtts) && gen.userAtts.length ? { userAtts: gen.userAtts } : {}),
      queue: !gen.done && gen.sessionId ? listQueue(key, gen.sessionId) : [],
    });
    for (const ev of gen.events) genWrite(res, ev);
    if (gen.done) { res.end(); return; }
    genSubscribe(gen, res);
  });

  router.on('POST', '/api/agy/stop', async (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    let body = {};
    try {
      const raw = await readBody(req);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
      }
    } catch {}

    const key = genKeyOf(ctx);
    const targetSid = String(body.sessionId || body.id || url.searchParams.get('session') || '').trim();
    const gen = targetSid ? findGenBySession(key, targetSid) : getCurrentGen(key);

    if (gen && !gen.done) {
      try { gen.abort.abort(); } catch {}
    } else if (targetSid) {
      acpFor(ctx, targetSid).cancelSession(targetSid);
    }

    sendJson(res, 200, { ok: true, sessionId: gen?.sessionId || targetSid || null });
  });

  // ── 交付产物文件与网页预览流式读取（严格限制在 uploads / 会话 cwd / 项目目录 / additionalDirectories）──
  router.on('GET', '/api/agy/artifact', async (req, res, url) => {
    const ctx = agyCtx(req, res); if (!ctx) return;
    const id = String(url.searchParams.get('id') || '').trim();
    const requested = String(url.searchParams.get('path') || '').trim();
    if (!requested) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('missing path'); return; }

    try {
      const file = realpathSync(requested);
      const st = statSync(file);
      if (!st.isFile()) throw Object.assign(new Error('not found'), { status: 404 });

      // agy 的运行日志（设置页「查看日志」）：里面有所有人的提示词片段，只给主机管理员
      const logInfo = ctx.kind === 'admin' ? resolveAgyLogInfo(getAcpClient()) : null;
      const isAgyLogFile = ctx.kind === 'admin' && (
        (logInfo?.path && file === (() => { try { return realpathSync(logInfo.path); } catch { return ''; } })())
        || isPathInside(file, path.join(agyDataDir(), 'log'))
      ) && /\.log$/i.test(file);

      // 会话自己的产物目录（agy 自带生图的成品、用户发图时落盘的 .user_uploaded 原图）与 Swarm 成员登记的进度截图：
      // 只放行成品 / 上传原图 / 白名单帧，agy 的内部记录（.system_generated）一律拒绝
      let inArtifactDir = false;
      if (id) {
        const dataDir = acpFor(ctx, id).dataDir;
        try { inArtifactDir = isSessionArtifact(file, realpathSync(sessionBrainDir(dataDir, id))); } catch {}
        if (!inArtifactDir) {
          try { inArtifactDir = isSwarmFrameFile(dataDir, id, file); } catch {}
        }
      }

      const roots = [ctx.uploads].filter(Boolean);
      if (id) {
        const meta = getSessionMeta(ctx.agyDir, id);
        const verifiedCwd = meta?.cwd || await resolveVerifiedSessionCwd(ctx, id);
        if (!meta && !verifiedCwd && !inArtifactDir) {
          throw Object.assign(new Error('not found'), { status: 404 });
        }
        if (verifiedCwd) {
          try { roots.push(authorizeProjectPath(ctx, verifiedCwd)); } catch {}
        }
        if (meta?.projectId) {
          const proj = getProject(ctx.agyProjects, meta.projectId);
          if (proj?.path) roots.push(authorizeProjectPath(ctx, proj.path));
        }
        if (Array.isArray(meta?.additionalDirectories)) {
          for (const extraDir of meta.additionalDirectories) {
            try { roots.push(authorizeProjectPath(ctx, extraDir)); } catch {}
          }
        }
      }
      if (!isAgyLogFile && !inArtifactDir && !roots.some((root) => isPathInside(file, root))) {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }
      if (url.searchParams.get('site') === '1' && isHtmlFile(file)) {
        return respondHtmlSite(res, file, roots.filter((root) => isPathInside(file, root)));
      }

      // 附件卡的预览图（thumb=1 / grid）：图片缩一档、视频抽一帧，与工作空间文件列表同一套缓存（thumb-cache/）。
      // 出不了图一律 404，前端回落成类型图标卡；核心缩略图模块按需加载（平时不用就不进这条路由的依赖）。
      const thumbTier = url.searchParams.get('thumb');
      if (thumbTier === '1' || thumbTier === 'grid') {
        const { THUMB_TIERS, THUMB_EXT, THUMB_VIDEO_EXT, imageThumb } = await import('@bridge/core/routes/file-preview.mjs');
        const { LIST_THUMB_EXT } = await import('@bridge/core/routes/file-thumb.mjs');
        const ext = path.extname(file).slice(1).toLowerCase();
        const isVideo = THUMB_VIDEO_EXT.has(ext);
        let thumb = null;
        if (THUMB_EXT.has(ext) || isVideo || LIST_THUMB_EXT.has(ext)) {
          try { thumb = await imageThumb(file, st, isVideo, THUMB_TIERS[thumbTier]); } catch {}
        }
        if (res.destroyed) return;
        if (!thumb) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no thumb'); return; }
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400' });
        pipeline(createReadStream(thumb), res, () => {});
        return;
      }

      const dlName = url.searchParams.get('name') || path.basename(file);
      streamFile(req, res, file, {
        stat: st,
        name: dlName,
        safeMime: true,
        cacheControl: 'private, max-age=3600',
        downloadName: dlName,
        download: url.searchParams.get('dl') === '1',
      });
    } catch (err) {
      if (res.headersSent) { try { res.destroy(err); } catch {} return; }
      // 成员一律答「没有」：不然拿「不存在 / 无权」两种回答就能探出服务器上哪些文件存在
      const status = ctx.kind === 'admin' ? (err?.status || 404) : 404;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(status === 403 ? 'forbidden' : 'not found');
    }
  });
}
