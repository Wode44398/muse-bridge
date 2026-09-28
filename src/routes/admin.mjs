// Admin / process-management routes — the server-admin console surface.
//
// 闸门按形态分（FEATURES.remoteAdmin，见 config/index.mjs）：
//   · NO_AUTH（loopback 调试实例）：原样全开；
//   · remoteAdmin 关：仅放行「本机直连 + admin 凭据」的请求（见 localAdmin）。隧道来的请求一律 404。
//   · remoteAdmin 开（服务端形态默认）：管理员身份（admin token 的 Bearer / cookie）远程可达，
//     手机、网页上就能管用户和 agent。这不扩大权限：admin 身份本就能经 Claude 在服务器上执行
//     任意命令，控制台只是把这件事做成了界面。写操作照旧受 server.mjs 的全局 Origin 闸保护。
//
// Also exposes /api/capabilities (the capability snapshot the frontend uses, mirroring
// what's injected into index.html as window.__CAPS__).

import os from 'node:os';
import path from 'node:path';
import { rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { readBody } from '../runtime/body.mjs';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { ROOT, NO_AUTH, EDITION, FEATURES, userRoot } from '../config/index.mjs';
import * as users from '../users.mjs';
import { sessionsDir, sessionPaths } from '../runtime/paths.mjs';
import { readSessionTitle, readSessionMessages, trimTitle } from './sessions.mjs';
import { getLiveGens, listGens } from '../runtime/gen.mjs';
import { contextFor, userIdentity } from '../runtime/identity.mjs';
import { busPublish } from '../runtime/bus.mjs';
import * as claudeAccounts from '../runtime/claude-account.mjs';
import { pendingQuestions } from '../runtime/questions.mjs';
import { getPolicy, setPolicy, registrationOpen } from '../runtime/policy.mjs';
import { quotaState } from '../runtime/quota.mjs';
import { serviceInfo, requestRestart, supervisor, startUpdate } from '../runtime/service-control.mjs';
import { recentLogs } from '../runtime/log-ring.mjs';
import { CLAUDE_MODELS, CLAUDE_EFFORTS } from '../config/capabilities.mjs';

export function registerAdminRoutes(router, { authOk, adminCredential = null, adminGen = '' }) {
  // —— 本地管理员门 ——————————————————————————————————————————
  // NO_AUTH 调试实例照旧全开；remoteAdmin 关着的实例上，admin 面仅对「确实来自本机直连」
  // 且带 admin 凭据的请求开放，三重硬条件缺一不可：
  //   ① TCP 对端是回环地址——LAN/0.0.0.0 直连的 socket 远端不是 127.0.0.1；
  //   ② 不带任何代理/转发痕迹头——经 cloudflared/反代来的请求必带
  //      cf-*/x-forwarded-*（公网攻击者无法让边缘替它摘头），本机直连天然没有；
  //   ③ authOk 过：admin token 的 Bearer/cookie；多用户 bridge_user 会话恒 false。
  // 语义不变式：admin 面永不过隧道、永不上局域网。
  const PROXY_MARKS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'forwarded'];
  const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const localAdmin = (req) => {
    if (NO_AUTH) return true;
    if (!isLoopback(String((req.socket && req.socket.remoteAddress) || ''))) return false;
    for (const h of PROXY_MARKS) if (req.headers[h] != null) return false;
    return authOk(req);
  };
  // 服务端形态（remoteAdmin 开）：admin 身份即可，不论从哪来。
  const adminOk = (req) => (FEATURES.remoteAdmin && !NO_AUTH ? authOk(req) : localAdmin(req));
  const gate = (req, res) => {
    if (adminOk(req)) return true;
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    return false;
  };

  // 探针：「服务端控制台」入口据此决定是否显示（404 → 按钮不出现）。
  // remote 表示这是经远程管理进来的（手机 / 网页），前端据此只摆远程能用的页。
  router.on('GET', '/api/admin/ping', (req, res) => {
    if (!gate(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, scriptAvailable: false, noAuth: NO_AUTH, edition: EDITION, multiUser: FEATURES.multiUser, remote: !localAdmin(req), supervisor: supervisor() }));
  });

  // ---- 服务控制（三端拆分 P4，任何形态都有）：进程 / 机器资源、最近日志、交给守护进程的重启 ----
  const drainAll = async () => { try { await (await import('./harness.mjs')).drainHarnesses(); } catch {} };
  router.on('GET', '/api/admin/service', async (req, res) => {
    if (!gate(req, res)) return;
    let harnessCount = 0;
    try { harnessCount = (await import('./harness.mjs')).harnessEndpoints().length; } catch {}
    J(res, serviceInfo({ dataRoot: ROOT, harnessCount }));
  });
  router.on('GET', '/api/admin/logs', (req, res, url) => {
    if (!gate(req, res)) return;
    const n = Number((url || new URL(req.url, 'http://x')).searchParams.get('n')) || 300;
    J(res, { lines: recentLogs(n) });
  });
  // { mode: 'now' | 'idle' | 'cancel' }：now 立即（打断在跑的轮）、idle 等没有在跑的轮再重启（最多等 30 分钟）。
  router.on('POST', '/api/admin/service/restart', async (req, res) => {
    if (!gate(req, res)) return;
    let b = {}; try { b = JSON.parse(await readBody(req)) || {}; } catch {}
    const mode = b.mode === 'idle' || b.mode === 'cancel' ? b.mode : 'now';
    const r = requestRestart(mode, { drain: drainAll });
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  });
  // 更新：git 部署 + 守护进程托管时，以服务用户跑 scripts/server/update.sh --no-restart，有新代码就等空闲重启
  router.on('POST', '/api/admin/service/update', (req, res) => {
    if (!gate(req, res)) return;
    const r = startUpdate({ drain: drainAll });
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  });
  // 公开端点（无鉴权）：返回的是纯模型/能力枚举，零敏感信息，本就随 window.__CAPS__ 对
  // 所有访问 index.html 的人无条件注入。
  router.on('GET', '/api/capabilities', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(CAPABILITIES));
  });

  // ---- Multi-user management（同上面的闸：主机形态只在本机，服务端形态管理员远程可用）。
  // 附带每个 agent 的全局状态，控制台据此把「全局已关 / 不支持多用户」的勾选框置灰。
  router.on('GET', '/api/admin/users', async (req, res) => {
    if (!gate(req, res)) return;
    // quotaNow：生效额度 + 今天 / 最近 7 天用量（控制台表格里「今天 3/20 轮」那一格）
    const list = users.listUsers().map((u) => ({ ...u, usage: users.getUsage(u.name), quotaNow: quotaState(u.name) }));
    const { agentStatusList } = await import('../runtime/agent-status.mjs');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ users: list, invites: users.listInvites(), agents: agentStatusList(), multiUser: FEATURES.multiUser, registrationOpen: registrationOpen() }));
  });

  router.on('POST', '/api/admin/invite', async (req, res) => {
    if (!gate(req, res)) return;
    // 多用户关着（主机形态）没有注册入口，发邀请码没有意义。
    if (!FEATURES.multiUser) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '这台主机没开多用户，不能注册；要给程序用的账号请直接「新建服务账号」' })); return; }
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch {}
    const tier = users.normTier(b && b.tier); // 'pro' (full) | 'user' (no command line)
    const code = users.createInvite(tier);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, tier }));
  });

  // 管理员直接建账号（不走邀请码）：给朋友预建账号，或建程序用的服务账号。
  // 主机关着多用户时只许建服务账号——普通账号建了也登不上。
  router.on('POST', '/api/admin/user/create', async (req, res) => {
    if (!gate(req, res)) return;
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch {}
    const service = b.service === true || !FEATURES.multiUser;
    const r = await users.createUser(String(b.name || ''), String(b.password || ''), users.normTier(b.tier));
    if (!r.error && service) users.setService(r.name, true);
    if (!r.error && Array.isArray(b.agents)) users.setAgents(r.name, b.agents);
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.error ? r : { ...r, service }));
  });

  // Shared wrapper for the {name,...}-body user mutations.
  const userAction = (fn) => async (req, res) => {
    if (!gate(req, res)) return;
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const r = (await fn(b || {})) || { ok: true };   // fn 可为 async（setPassword 走异步 scrypt）
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  };
  // 改完按人的东西，推一条 me.changed 到该用户的总线：他在线的客户端当场刷新可用 agent 与权限。
  const touched = (b, r) => { if (!r.error) busPublish('u:' + users.normName(String(b.name || '')), { type: 'me.changed' }); return r; };
  // 重置密码 = 这个人所有设备下线（密码多半是因为泄漏 / 忘了才重置的，旧登录不该还活着）。
  router.on('POST', '/api/admin/user/reset', userAction(async (b) => {
    const r = await users.setPassword(String(b.name || ''), String(b.password || ''));
    if (!r.error) users.deleteUserSessions(String(b.name || ''));
    return r;
  }));
  router.on('POST', '/api/admin/user/tier', userAction((b) => touched(b, users.setTier(String(b.name || ''), String(b.tier || '')))));
  router.on('POST', '/api/admin/user/disable', userAction((b) => touched(b, users.setDisabled(String(b.name || ''), b.disabled !== false))));
  // 按人授权：agents = 统一 id 列表（claude/gemini/dimensio…）；snapshot = 能否铸公开聊天快照；
  // service = 服务账号（关掉多用户后仍能登录，给程序用）。
  router.on('POST', '/api/admin/user/agents', userAction((b) => touched(b, users.setAgents(String(b.name || ''), Array.isArray(b.agents) ? b.agents : []))));
  router.on('POST', '/api/admin/user/snapshot', userAction((b) => touched(b, users.setSnapshotGrant(String(b.name || ''), b.snapshot === true))));
  router.on('POST', '/api/admin/user/service', userAction((b) => touched(b, users.setService(String(b.name || ''), b.service === true))));
  router.on('POST', '/api/admin/user/delete', userAction((b) => {
    const r = users.deleteUser(String(b.name || ''));
    // Optional hard purge of the on-disk folder (default off — account row only).
    if (!r.error && b.purge === true) { try { rmSync(userRoot(users.normName(String(b.name || ''))), { recursive: true, force: true }); } catch {} }
    return r;
  }));

  // ---- 额度与注册（三端拆分 P4）：注册开关、注册用户默认额度、全服同时轮数上限、换日时区 ----
  router.on('GET', '/api/admin/policy', (req, res) => {
    if (!gate(req, res)) return;
    J(res, { policy: getPolicy(), multiUser: FEATURES.multiUser, registrationOpen: registrationOpen() });
  });
  router.on('POST', '/api/admin/policy', userAction((b) => {
    const patch = {};
    if (typeof b.register === 'boolean') patch.register = b.register;
    if (b.quota && typeof b.quota === 'object') patch.quota = b.quota;
    if (b.maxUserTurns != null) patch.maxUserTurns = Number(b.maxUserTurns) || 0;
    if (typeof b.timezone === 'string' && b.timezone) patch.timezone = b.timezone.trim();
    const r = setPolicy(patch);
    return r.error ? r : { ...r, registrationOpen: registrationOpen() };
  }));
  // 个人额度覆盖：quota = { dayTurns, weekTurns, dayCostUsd, weekCostUsd }，写了的键覆盖默认、0 = 不限；null = 全跟默认。
  router.on('POST', '/api/admin/user/quota', userAction((b) => touched(b, users.setQuota(String(b.name || ''), b.quota && typeof b.quota === 'object' ? b.quota : null))));

  // ---- 管理员登录（三端拆分 P4）：「用访问令牌登录」与扫码确认铸出的管理员会话，能逐个吊销 ----
  // current = 发这个请求的那一张（前端据此标「本机」、吊销前提醒会把自己登出）。
  router.on('GET', '/api/admin/admin-sessions', (req, res) => {
    if (!gate(req, res)) return;
    const cur = adminCredential ? adminCredential(req) : null;
    J(res, {
      sessions: users.listAdminSessions(adminGen),
      current: cur && cur.via === 'session' ? users.adminSessionIdOf(cur.token) : null,
    });
  });
  router.on('POST', '/api/admin/admin-sessions/revoke', userAction((b) => ({
    ok: true, revoked: users.revokeAdminSessions(b.all === true ? 'all' : [String(b.id || '')]),
  })));

  // ---- Read-only oversight: list / read ANY user's sessions (admin console only) ----
  const userConfig = (name) => path.join(userRoot(name), '.bridge', 'claude');
  router.on('GET', '/api/admin/user/sessions', async (req, res, url) => {
    if (!gate(req, res)) return;
    const name = users.normName(url.searchParams.get('name') || '');
    if (!users.getUser(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such user'); return; }
    const dir = sessionsDir(userRoot(name), userConfig(name));
    let entries = []; try { entries = readdirSync(dir, { withFileTypes: true }); } catch {}
    const files = entries.filter((d) => d.isFile() && d.name.endsWith('.jsonl')).map((d) => {
      const f = path.join(dir, d.name); let mtime = 0, size = 0;
      try { const st = statSync(f); mtime = st.mtimeMs; size = st.size; } catch {}
      return { id: d.name.slice(0, -6), file: f, mtime, size };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, 40);
    const sessions = await Promise.all(files.map(async (f) => ({ id: f.id, mtime: f.mtime, size: f.size, title: trimTitle(await readSessionTitle(f.file)) || '(无标题)' })));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: name, sessions }));
  });
  router.on('GET', '/api/admin/user/session', async (req, res, url) => {
    if (!gate(req, res)) return;
    const name = users.normName(url.searchParams.get('name') || '');
    const id = url.searchParams.get('id') || '';
    if (!users.getUser(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such user'); return; }
    const p = sessionPaths(id, userRoot(name), userConfig(name));
    if (!p || !existsSync(p.file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    const all = await readSessionMessages(p.file);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: name, id, messages: all.slice(-120) }));
  });

  // ========== 调试台扩展：全局监控 + 中止任意 agent + 代任意用户续聊 ==========
  const J = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  // ---- Claude 账号切换（failover / 额度池）。本地管理员控制台专属（gate），永不过隧道。
  // 切换即时全局生效：admin 对话 / 用户沙箱 / 定时路由的下一次 query() 都跟随激活账号的 token。
  router.on('GET', '/api/admin/claude-accounts', (req, res) => {
    if (!gate(req, res)) return;
    J(res, { accounts: claudeAccounts.listAccounts() });
  });
  router.on('POST', '/api/admin/claude-account/active', userAction((b) => claudeAccounts.setActive(String(b.id || ''))));
  router.on('POST', '/api/admin/claude-account/add', userAction((b) => claudeAccounts.addAccount({ label: b.label, token: b.token })));
  router.on('POST', '/api/admin/claude-account/update', userAction((b) => claudeAccounts.updateAccount(String(b.id || ''), { label: b.label, token: b.token })));
  router.on('POST', '/api/admin/claude-account/delete', userAction((b) => claudeAccounts.deleteAccount(String(b.id || ''))));

  // 聚合总览：所有活跃 gen + routines 运行中 + 用户数。一个端点喂满总览面板。
  router.on('GET', '/api/admin/overview', async (req, res) => {
    if (!gate(req, res)) return;
    let running = [];
    try { const rr = await import('../runtime/routines-runner.mjs'); running = [...(rr.routineRunning || [])]; } catch {}
    J(res, { host: { name: os.hostname() }, gens: listGens(), routinesRunning: running, userCount: users.listUsers().length });
  });

  // 列所有 caller 的活跃 Claude 生成
  router.on('GET', '/api/admin/active', (req, res) => { if (!gate(req, res)) return; J(res, { gens: listGens() }); });

  // 按 key（'admin' / 'u:<name>'）中止任意用户的活跃生成（多对话并发：全停；
  // 可选 b.sessionId 只停某一轮）
  router.on('POST', '/api/admin/stop', userAction((b) => {
    const want = String(b.sessionId || '');
    const live = getLiveGens(String(b.key || '')).filter((g) => !want || g.sessionId === want);
    if (!live.length) return { ok: false, error: '该 key 无活跃生成' };
    for (const g of live) { try { g.abort.abort(); } catch {} }
    return { ok: true, stopped: live.length };
  }));

  // 代任意用户续聊（Claude）——contextFor 注入目标用户上下文，会话落到该用户目录
  router.on('POST', '/api/admin/user/chat', async (req, res) => {
    if (!gate(req, res)) return;
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const name = users.normName(String(b.name || ''));
    const who = userIdentity(name, { allowDisabled: true });
    if (!who) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such user'); return; }
    const ctx = contextFor(who);
    const message = String(b.message || '').trim();
    const sessionId = b.sessionId ? String(b.sessionId) : undefined;
    // 代聊也守这个人的 agent 名单：代他用一个他本来用不了的 agent，会话就落进他目录里了。
    if (!ctx.allowClaude) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '该用户没有 Claude 的权限，或它未启用' })); return;
    }
    const { runClaudeChat } = await import('../agents/claude.mjs');
    return runClaudeChat(req, res, { message, sessionId, model: CLAUDE_MODELS.has(b.model) ? b.model : undefined, effort: CLAUDE_EFFORTS.has(b.effort) ? b.effort : undefined, attachments: [], ctx });
  });

  // 代任意用户回答 AskUserQuestion（loopback 信任，直接 settle）
  router.on('POST', '/api/admin/user/answer', async (req, res) => {
    if (!gate(req, res)) return;
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const e = pendingQuestions.get(String(b.qid || ''));
    if (!e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no pending question'); return; }
    e.settle(b.cancelled ? { cancelled: true } : { answers: Array.isArray(b.answers) ? b.answers : [] });
    J(res, { ok: true });
  });

  // 看任意用户的 routines（复用 contextFor 派生其存储路径）
  const userCtx = (url) => { const name = users.normName(url.searchParams.get('name') || ''); const who = userIdentity(name, { allowDisabled: true }); return who ? { name, ctx: contextFor(who) } : null; };
  router.on('GET', '/api/admin/user/routines', async (req, res, url) => {
    if (!gate(req, res)) return; const uc = userCtx(url); if (!uc) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no user'); return; }
    let list = []; try { list = (await import('../routines.mjs')).list(uc.ctx.dataDir); } catch {}
    J(res, { user: uc.name, routines: list });
  });

}
