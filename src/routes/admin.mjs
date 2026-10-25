// Admin / process-management routes — the server-admin console surface.
//
// 闸门看 FEATURES.remoteAdmin（见 config/index.mjs，默认开）：
//   · NO_AUTH（loopback 调试实例）：原样全开；
//   · remoteAdmin 开（默认）：管理员身份（admin token 的 Bearer / cookie）远程可达，手机、网页上就能管
//     用户和 agent。这不扩大权限：admin 身份本就能经 Claude 在服务器上执行任意命令，控制台只是把这件事
//     做成了界面。写操作照旧受 server.mjs 的全局 Origin 闸保护。
//   · remoteAdmin 关（config.json 显式 features.remoteAdmin:false）：仅放行「本机直连 + admin 凭据」的请求
//     （见 localAdmin）；隧道 / 局域网来的请求一律 404。
//
// Also exposes /api/capabilities (the capability snapshot the frontend uses, mirroring
// what's injected into index.html as window.__CAPS__).

import os from 'node:os';
import path from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { readBody } from '../runtime/body.mjs';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { ROOT, NO_AUTH, FEATURES, DEPLOY, LISTEN_HOST, userRoot } from '../config/index.mjs';
import * as users from '../users.mjs';
import { sessionsDir, sessionPaths } from '../runtime/paths.mjs';
import { readSessionTitle, readSessionMessages, trimTitle } from './sessions.mjs';
import { getLiveGens, listGens } from '../runtime/gen.mjs';
import { contextFor, userIdentity } from '../runtime/identity.mjs';
import { HOST_OWNER, ownerKey, parseOwnerKey } from '../runtime/principal.mjs';
import { appendAudit } from '../runtime/audit-log.mjs';
import { busPublish } from '../runtime/bus.mjs';
import * as claudeAccounts from '../runtime/claude-account.mjs';
import { pendingQuestions, permAnswerFields } from '../runtime/questions.mjs';
import { getPolicy, setPolicy, registrationOpen } from '../runtime/policy.mjs';
import { quotaState, quotaBlock, billingUser, snapMinterIds } from '../runtime/quota.mjs';
import { consentsOf, accessAllowed, ownerAllows, logAccess, deniedMessage, PROXY_PREFIX, proxyOnlyConversation } from '../runtime/admin-access.mjs';
import { writeSseHeaders, sseWrite } from '../runtime/sse.mjs';
import { setAccountDisabled, setAccountTier, deleteAccount } from '../runtime/account-lifecycle.mjs';
import { accessState, registerAccountAdminRoutes } from './admin-accounts.mjs';
import { serviceInfo, requestRestart, supervisor, startUpdate } from '../runtime/service-control.mjs';
import { recentLogs } from '../runtime/log-ring.mjs';
import { CLAUDE_MODELS, CLAUDE_EFFORTS } from '../config/capabilities.mjs';

export function registerAdminRoutes(router, { authOk, adminCredential = null, adminGen = '' }) {
  // —— 本地管理员门 ——————————————————————————————————————————
  // 「本机直连」的判据（localAdmin），NO_AUTH 调试实例恒真；三重硬条件缺一不可：
  //   ① TCP 对端是回环地址——LAN/0.0.0.0 直连的 socket 远端不是 127.0.0.1；
  //   ② 不带任何代理/转发痕迹头——经 cloudflared/反代来的请求必带
  //      cf-*/x-forwarded-*（公网攻击者无法让边缘替它摘头），本机直连天然没有；
  //   ③ authOk 过：admin token 的 Bearer/cookie；多用户 bridge_user 会话恒 false。
  // remoteAdmin 关时整个 admin 面只认它；remoteAdmin 开（默认）时 admin 面对管理员身份远程开放。
  const PROXY_MARKS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'cf-ray', 'x-real-ip', 'forwarded'];
  const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  const localAdmin = (req) => {
    if (NO_AUTH) return true;
    if (!isLoopback(String((req.socket && req.socket.remoteAddress) || ''))) return false;
    for (const h of PROXY_MARKS) if (req.headers[h] != null) return false;
    return authOk(req);
  };
  // remoteAdmin 开（默认）：admin 身份即可，不论从哪来。
  const adminOk = (req) => (FEATURES.remoteAdmin && !NO_AUTH ? authOk(req) : localAdmin(req));
  const gate = (req, res) => {
    if (adminOk(req)) return true;
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    return false;
  };

  // 探针：「服务端控制台」入口据此决定是否显示（404 → 按钮不出现）。
  // remote 表示这是经远程管理进来的（手机 / 网页），前端据此只摆远程能用的页。
  // deploy：部署形态摘要（config/deploy-profile.mjs）——控制台据此说清「这是哪种部署、默认值从哪来」；
  // ping 与「服务控制」的小卡片（SaService，读 /api/admin/service）共用。listenHost 是实际监听的地址。
  const deployInfo = Object.freeze({ profile: DEPLOY.profile, label: DEPLOY.label, source: DEPLOY.source, headless: DEPLOY.headless, listenHost: LISTEN_HOST });
  router.on('GET', '/api/admin/ping', (req, res) => {
    if (!gate(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, scriptAvailable: false, noAuth: NO_AUTH, multiUser: FEATURES.multiUser, remote: !localAdmin(req), supervisor: supervisor(),
      deploy: deployInfo }));
  });

  // ---- 服务控制（三端拆分 P4，任何形态都有）：进程 / 机器资源、最近日志、交给守护进程的重启 ----
  const drainAll = async () => { try { await (await import('./harness.mjs')).drainHarnesses(); } catch {} };
  router.on('GET', '/api/admin/service', async (req, res) => {
    if (!gate(req, res)) return;
    let harnessCount = 0;
    try { harnessCount = (await import('./harness.mjs')).harnessEndpoints().length; } catch {}
    J(res, { ...serviceInfo({ dataRoot: ROOT, harnessCount }), deploy: deployInfo });
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

  // ---- Multi-user management（同上面的闸：remoteAdmin 关时只在本机，开着时管理员远程可用）。
  // 附带每个 agent 的全局状态，控制台据此把「全局已关 / 不支持多用户」的勾选框置灰。
  router.on('GET', '/api/admin/users', async (req, res) => {
    if (!gate(req, res)) return;
    // quotaNow：生效额度 + 今天 / 最近 7 天用量（控制台表格里「今天 3/20 轮」那一格）
    // adminAccess：这个成员允许了管理员什么（看内容 / 代聊代答，runtime/admin-access.mjs），控制台据此置灰入口
    // snapMinter：手上有聊天快照的号（程序用的账号这类）；还没标服务账号的，「改用推荐值」前控制台点名提醒
    const minters = snapMinterIds();
    const list = users.listUsers().map((u) => ({ ...u, usage: users.getUsage(u.name), quotaNow: quotaState(u.name), adminAccess: consentsOf(u.id || u.name), snapMinter: minters.has(u.id || u.name) }));
    const { agentStatusList } = await import('../runtime/agent-status.mjs');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // access：「给别人用」开关的已存 / 运行中取值、隔离等级与可放心发的档位（routes/admin-accounts.mjs）
    res.end(JSON.stringify({ users: list, invites: users.listInvites(), agents: agentStatusList(), multiUser: FEATURES.multiUser, registrationOpen: registrationOpen(), access: accessState() }));
  });

  router.on('POST', '/api/admin/invite', async (req, res) => {
    if (!gate(req, res)) return;
    // 多用户关着（features.multiUser=false）没有注册入口，发邀请码没有意义。
    if (!FEATURES.multiUser) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '这台主机没开多用户，不能注册；要给程序用的账号请直接「新建服务账号」' })); return; }
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch {}
    const tier = users.normTier(b && b.tier); // 'pro' = 完全信任（有命令行，等同管理员）| 'user' = 普通（没有命令行）
    // 场景二默认只发普通档：完全信任的码要 ack:true（管理员看过「等同管理员」的说明并确认）。
    if (tier === users.TIER_FULL && b.ack !== true) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: users.FULL_TRUST_NEEDS_ACK, needAck: true })); return; }
    const days = Number(b.days);
    const code = users.createInvite(tier, { ack: b.ack === true, ...(days > 0 && days <= 90 ? { ttlMs: days * 86400000 } : {}) });
    const inv = users.listInvites().find((i) => i.code === code);
    audit(req, 'invite', { meta: { tier, code, ...(days > 0 && days <= 90 ? { days } : {}) } });   // code 只以哈希前缀进审计（codeHash），与作废那条对得上
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, tier, expiresAt: inv ? inv.expiresAt : null }));
  });

  // 管理员直接建账号（不走邀请码）：给朋友预建账号，或建程序用的服务账号。
  // 主机关着多用户时只许建服务账号——普通账号建了也登不上。
  router.on('POST', '/api/admin/user/create', async (req, res) => {
    if (!gate(req, res)) return;
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch {}
    const service = b.service === true || !FEATURES.multiUser;
    const wantTier = users.normTier(b.tier);
    // 直接建完全信任账号同样要 ack（见上面邀请码）。
    if (wantTier === users.TIER_FULL && b.ack !== true) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: users.FULL_TRUST_NEEDS_ACK, needAck: true })); return; }
    const r = await users.createUser(String(b.name || ''), String(b.password || ''), wantTier, { trustAck: wantTier === users.TIER_FULL ? Date.now() : 0 });
    if (!r.error && service) users.setService(r.name, true);
    if (!r.error && Array.isArray(b.agents)) users.setAgents(r.name, b.agents);
    if (!r.error) audit(req, 'user/create', { target: userKey(r.name), meta: { tier: r.tier, service } });
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.error ? r : { ...r, service }));
  });

  // 手机设置门：只开给「改了也断不了连接」的那一小撮配置——Claude 账号、
  // 额度与注册。admin 身份（Bearer / cookie）即可、不论从哪来，同 /api/agents 与
  // /api/extensions；服务控制、隧道、客户端配对、管理员会话这些一改就可能把自己关在门外的，仍走上面的 gate。
  const settingsGate = (req, res) => {
    if (NO_AUTH || authOk(req) || adminOk(req)) return true;
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    return false;
  };

  // 审计（runtime/audit-log.mjs）：建删账号、改档位 / 额度 / 授权、Claude 账号与策略改动、查看别人的数据、
  // 代聊、代答审批，一律落 _system/audit。actor 恒为主机身份；via = 哪一张凭据（'master' 主令牌 / 'noauth'
  // 本机调试实例 / 管理员会话 id）。只记动作名与白名单字段（safeMeta），令牌、密码、对话内容不进审计。
  const adminVia = (req) => { const c = req && adminCredential ? adminCredential(req) : null; return !c ? '' : c.via === 'session' ? users.adminSessionIdOf(c.token) : c.via; };
  // 被操作的账号 → 它的 owner 键（与 contextFor 的 ctx.key 同一把：账号还在就按库里解析，删掉的按名字兜底）。
  const userKey = (name) => {
    const who = name ? userIdentity(String(name), { allowDisabled: true }) : null;
    if (who && who.user) return ownerKey('user', who.user);
    const n = users.normName(String(name || ''));
    return n ? ownerKey('user', n) : '';
  };
  const audit = (req, action, { target = '', meta } = {}) => { appendAudit({ actor: HOST_OWNER, via: adminVia(req), action, target, scope: target, meta }); };
  const routeAction = (req) => String((req && req.url) || '').split('?')[0].replace(/^\/api\/admin\//, '');

  // Shared wrapper for the {name,...}-body user mutations.
  const actionWith = (g) => (fn) => async (req, res) => {
    if (!g(req, res)) return;
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const target = b && b.name ? userKey(b.name) : String((b && b.key) || '');   // 先解析：删号之后就查不到了
    const r = (await fn(b || {})) || { ok: true };   // fn 可为 async（setPassword 走异步 scrypt）
    // id 由服务端生成的动作（加 Claude 账号）：请求体里没有 id，把结果里的补进审计，与之后 update / delete 的 meta.id 对得上
    if (!r.error) audit(req, routeAction(req), { target, meta: b && r.id && !b.id ? { ...b, id: r.id } : b });
    res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  };
  const userAction = actionWith(gate);
  const settingsAction = actionWith(settingsGate);
  // 改完按人的东西，推一条 me.changed 到该用户的总线：他在线的客户端当场刷新可用 agent 与权限。
  const touched = (b, r) => { if (!r.error) { const k = userKey(b.name); if (k) busPublish(k, { type: 'me.changed' }); } return r; };
  // 重置密码 = 这个人所有设备下线（密码多半是因为泄漏 / 忘了才重置的，旧登录不该还活着）。
  router.on('POST', '/api/admin/user/reset', userAction(async (b) => {
    const r = await users.setPassword(String(b.name || ''), String(b.password || ''));
    if (!r.error) users.deleteUserSessions(String(b.name || ''));
    return r;
  }));
  // 升为完全信任要 ack:true（管理员看过「等同管理员」的说明）；降为普通随时可以，且当场生效——
  // 在跑的轮、侧栏终端、停放的 CLI 一并收掉（runtime/account-lifecycle.mjs setAccountTier）。
  router.on('POST', '/api/admin/user/tier', userAction(async (b) => touched(b, await setAccountTier(String(b.name || ''), String(b.tier || ''), { ack: b.ack === true }))));
  // 停用 = 登录失效 + 在跑的轮中止；启用即恢复（runtime/account-lifecycle.mjs）。
  router.on('POST', '/api/admin/user/disable', userAction((b) => touched(b, setAccountDisabled(String(b.name || ''), b.disabled !== false))));
  // 按人授权：agents = 统一 id 列表（claude / dimensio）；snapshot = 能否铸公开聊天快照；
  // service = 服务账号（关掉多用户后仍能登录，给程序用）。
  router.on('POST', '/api/admin/user/agents', userAction((b) => touched(b, users.setAgents(String(b.name || ''), Array.isArray(b.agents) ? b.agents : []))));
  router.on('POST', '/api/admin/user/snapshot', userAction((b) => touched(b, users.setSnapshotGrant(String(b.name || ''), b.snapshot === true))));
  router.on('POST', '/api/admin/user/service', userAction((b) => touched(b, users.setService(String(b.name || ''), b.service === true))));
  // 删号联动清理：会话、在跑的轮、聊天快照、邀请记录、用量一并收掉；
  // 数据 mode:'purge'（连目录删，默认）| 'archive'（挪进 <usersRoot>/_archive/）。老界面传 purge:true/false → 删 / 归档。
  router.on('POST', '/api/admin/user/delete', userAction((b) => deleteAccount(String(b.name || ''), {
    mode: b.mode === 'archive' || (b.mode == null && b.purge === false) ? 'archive' : 'purge',
  })));
  // 「给别人用」开关、确认完全信任、改登录名、作废邀请码（routes/admin-accounts.mjs）
  registerAccountAdminRoutes(router, { gate, userAction, touched });

  // ---- 额度与注册（三端拆分 P4）：注册开关、注册用户默认额度、全服同时轮数上限、换日时区 ----
  router.on('GET', '/api/admin/policy', (req, res) => {
    if (!settingsGate(req, res)) return;
    J(res, { policy: getPolicy(), multiUser: FEATURES.multiUser, registrationOpen: registrationOpen() });
  });
  router.on('POST', '/api/admin/policy', settingsAction((b) => {
    const patch = {};
    if (typeof b.register === 'boolean') patch.register = b.register;
    if (b.quota && typeof b.quota === 'object') patch.quota = b.quota;
    if (b.maxUserTurns != null) patch.maxUserTurns = Number(b.maxUserTurns) || 0;
    // 每人并发、每人定时任务数、成员的高消耗功能开关、「改用推荐值」
    if (b.maxParallelPerUser != null) patch.maxParallelPerUser = Number(b.maxParallelPerUser) || 0;
    if (b.maxRoutinesPerUser != null) patch.maxRoutinesPerUser = Number(b.maxRoutinesPerUser) || 0;
    if (b.member && typeof b.member === 'object') patch.member = b.member;
    if (b.preset === 'recommended') patch.preset = 'recommended';
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

  // ---- 管理员可见性（runtime/admin-access.mjs）：默认只看元数据（会话标题、时间、用量）；
  // 看内容、代聊代答要成员自己在设置里允许，做了就在他那边记一笔。管理员自己（主机身份）的数据不经过这里。
  const consentDenied = (res, kind, why = kind) => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: deniedMessage(why), code: 'consent', need: kind })); };
  // 在跑的轮：没允许看内容的成员，提问原文不给（只留 key / 会话 id / 时间这些元数据）
  const gensForAdmin = () => listGens().map((g) => (ownerAllows(g.key, 'view') ? g : { ...g, userText: '', hidden: true }));
  // 这段对话是不是从头到尾都是管理员代发的（找不到、读不了一律按「不是」，要「查看」才能接着聊）
  async function proxyOnlySession(sid, ctx) {
    try {
      const p = sessionPaths(sid, ctx.cwd, ctx.configDir);
      if (!p || !existsSync(p.file)) return false;
      return proxyOnlyConversation(await readSessionMessages(p.file));
    } catch { return false; }
  }

  // ---- Read-only oversight: list / read ANY user's sessions (admin console only) ----
  // 目录按账号 id（老账号 id = 用户名，新账号是「名字-随机串」），参数传登录名或 id 都行。
  const acctRoot = (name) => userRoot(users.accountIdOf(name) || name);
  const userConfig = (name) => path.join(acctRoot(name), '.bridge', 'claude');
  router.on('GET', '/api/admin/user/sessions', async (req, res, url) => {
    if (!gate(req, res)) return;
    const name = users.normName(url.searchParams.get('name') || '');
    if (!users.getUser(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such user'); return; }
    const dir = sessionsDir(acctRoot(name), userConfig(name));
    let entries = []; try { entries = readdirSync(dir, { withFileTypes: true }); } catch {}
    const files = entries.filter((d) => d.isFile() && d.name.endsWith('.jsonl')).map((d) => {
      const f = path.join(dir, d.name); let mtime = 0, size = 0;
      try { const st = statSync(f); mtime = st.mtimeMs; size = st.size; } catch {}
      return { id: d.name.slice(0, -6), file: f, mtime, size };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, 40);
    const sessions = await Promise.all(files.map(async (f) => ({ id: f.id, mtime: f.mtime, size: f.size, title: trimTitle(await readSessionTitle(f.file)) || '(无标题)' })));
    audit(req, 'user/view', { target: userKey(name), meta: { what: 'sessions' } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: name, sessions }));
  });
  router.on('GET', '/api/admin/user/session', async (req, res, url) => {
    if (!gate(req, res)) return;
    const name = users.normName(url.searchParams.get('name') || '');
    const id = url.searchParams.get('id') || '';
    if (!users.getUser(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such user'); return; }
    if (!accessAllowed(name, 'view')) return consentDenied(res, 'view');
    const p = sessionPaths(id, acctRoot(name), userConfig(name));
    if (!p || !existsSync(p.file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    const all = await readSessionMessages(p.file);
    logAccess(name, { action: 'view_session', what: id });
    audit(req, 'user/view', { target: userKey(name), meta: { what: 'session', sessionId: id } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: name, id, messages: all.slice(-120) }));
  });

  // ========== 调试台扩展：全局监控 + 中止任意 agent + 代任意用户续聊 ==========
  const J = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  // ---- Claude 账号切换（failover）。手机设置也能管（settingsGate：改坏了也断不了连接）。
  // 切换即时全局生效：admin 对话 / 用户沙箱 / 定时路由的下一次 query() 都跟随激活账号的 token。
  router.on('GET', '/api/admin/claude-accounts', (req, res) => {
    if (!settingsGate(req, res)) return;
    // apiKeyMode：现在是不是走按量 API Key（'env' / 'desktop' 号池令牌不生效、'config' 号池里加了令牌就改用订阅号、
    // 'config-unused' config.json 里的 key 因号池有令牌没在用、'' 没走 key），见 claude-account.mjs
    J(res, { accounts: claudeAccounts.listAccounts(), apiKeyMode: claudeAccounts.apiKeyMode() });
  });
  router.on('POST', '/api/admin/claude-account/active', settingsAction((b) => claudeAccounts.setActive(String(b.id || ''))));
  // 调整顺序：delta=-1 上移 / 1 下移。
  router.on('POST', '/api/admin/claude-account/move', settingsAction((b) => claudeAccounts.moveAccount(String(b.id || ''), Number(b.delta) || 0)));
  router.on('POST', '/api/admin/claude-account/add', settingsAction((b) => claudeAccounts.addAccount({ label: b.label, token: b.token })));
  router.on('POST', '/api/admin/claude-account/update', settingsAction((b) => claudeAccounts.updateAccount(String(b.id || ''), { label: b.label, token: b.token })));
  router.on('POST', '/api/admin/claude-account/delete', settingsAction((b) => claudeAccounts.deleteAccount(String(b.id || ''))));

  // 聚合总览：所有活跃 gen + routines 运行中 + 用户数。一个端点喂满总览面板。
  router.on('GET', '/api/admin/overview', async (req, res) => {
    if (!gate(req, res)) return;
    let running = [];
    try { const rr = await import('../runtime/routines-runner.mjs'); running = [...(rr.routineRunning || [])]; } catch {}
    J(res, { host: { name: os.hostname() }, gens: gensForAdmin(), routinesRunning: running, userCount: users.listUsers().length });
  });

  // 列所有 caller 的活跃 Claude 生成
  router.on('GET', '/api/admin/active', (req, res) => { if (!gate(req, res)) return; J(res, { gens: gensForAdmin() }); });

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
    // 代聊要成员自己允许；代发的消息带「管理员代发」标记，他在自己的会话里看得见。
    if (!accessAllowed(name, 'assist')) return consentDenied(res, 'assist');
    // actor = 主机身份、scope = 被代的这个人：数据照旧落他的目录、记他的账，「是谁发的」留在 ctx.actor。
    const ctx = contextFor({ ...who, actor: HOST_OWNER });
    const raw = String(b.message || '').trim();
    if (!raw) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '消息是空的' })); return; }
    const message = PROXY_PREFIX + raw;
    const sessionId = b.sessionId ? String(b.sessionId) : undefined;
    // 代聊也守这个人的 agent 名单：代他用一个他本来用不了的 agent，会话就落进他目录里了。
    if (!ctx.allowClaude) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '该用户没有 Claude 的权限，或它未启用' })); return;
    }
    // 接着代聊一段已有的对话：回复带着那段对话的上下文流回控制台，等于读了它——还要成员允许「查看」。
    // 例外是从头到尾都是管理员代发的会话（管理员自己代聊开的，成员没在里面说过话）：只开「协助」也能接着聊。
    if (sessionId && !accessAllowed(name, 'view') && !(await proxyOnlySession(sessionId, ctx))) return consentDenied(res, 'view', 'continue');
    // 额度：代聊的轮算被代的人的，开跑前先查（轮数由 runClaudeChat 自己记，它里面还会再查一次）。
    const billTo = billingUser(ctx);
    const block = billTo ? quotaBlock(billTo) : null;
    if (block) { writeSseHeaders(res); sseWrite(res, { type: 'error', kind: 'quota', title: block.title, message: block.message }); res.end(); return; }
    audit(req, 'user/chat', { target: ctx.key, meta: { agent: 'claude', sessionId: sessionId || '' } });
    logAccess(name, { action: 'chat', what: sessionId || '', detail: 'Claude' });
    const { runClaudeChat } = await import('../agents/claude.mjs');
    // 代聊按无人值守处理（permissionPolicy 'host'）：控制台没有审批卡，固定 default + 宿主放行（runtime/permissions.mjs）
    return runClaudeChat(req, res, { message, sessionId, model: CLAUDE_MODELS.has(b.model) ? b.model : undefined, effort: CLAUDE_EFFORTS.has(b.effort) ? b.effort : undefined, attachments: [], ctx, permissionPolicy: 'host', plain: true });   // plain：代聊页只渲染文本，不挂内嵌图表
  });

  // 代任意用户回答 AskUserQuestion（loopback 信任，直接 settle）
  router.on('POST', '/api/admin/user/answer', async (req, res) => {
    if (!gate(req, res)) return;
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const e = pendingQuestions.get(String(b.qid || ''));
    if (!e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no pending question'); return; }
    // 代答别人的提问 / 审批要那个成员允许；主机自己的、没有属主的老条目照旧。
    if (!ownerAllows(String(e.ownerKey || ''), 'assist')) return consentDenied(res, 'assist');
    // choice：sessions MCP 的 offer 卡（新会话 / 在这里做），同 /api/answer
    const choice = typeof b.choice === 'string' ? b.choice.slice(0, 40) : undefined;
    // 审批卡的 decision / mode / feedback 同 /api/answer 透传（questions.mjs permAnswerFields）
    e.settle(b.cancelled ? { cancelled: true } : { answers: Array.isArray(b.answers) ? b.answers : [], ...permAnswerFields(b), ...(choice ? { choice } : {}) });
    audit(req, 'user/answer', { target: String(e.ownerKey || ''), meta: { qid: String(b.qid || ''), kind: String(e.kind || '') } });
    if (parseOwnerKey(String(e.ownerKey || ''))?.kind === 'user') logAccess(String(e.ownerKey), { action: 'answer', what: String(e.kind || '') });
    J(res, { ok: true });
  });

  // 看任意用户的 routines（复用 contextFor 派生其存储路径）。这里只解析身份；
  // 「查看了别人的数据」的审计在真把数据交出去之后再写（viewed），带上 req 才知道是哪一张管理员凭据（via）。
  const userCtx = (url) => {
    const name = users.normName(url.searchParams.get('name') || ''); const who = userIdentity(name, { allowDisabled: true });
    if (!who) return null;
    return { name, ctx: contextFor(who) };
  };
  const viewed = (req, uc, what, meta) => audit(req, 'user/view', { target: userKey(uc.name), meta: { what, ...(meta || {}) } });
  router.on('GET', '/api/admin/user/routines', async (req, res, url) => {
    if (!gate(req, res)) return; const uc = userCtx(url); if (!uc) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no user'); return; }
    let list = []; try { list = (await import('../routines.mjs')).list(uc.ctx.dataDir); } catch {}
    // 没允许看内容：只给名字、时间、状态这些元数据，提示词与结果预览不给
    const metaOnly = !accessAllowed(uc.name, 'view');
    if (metaOnly) list = list.map((r) => ({ ...r, prompt: '', lastPreview: '', hidden: true }));
    else if (list.length) logAccess(uc.name, { action: 'view_routines' });
    viewed(req, uc, 'routines', metaOnly ? { hidden: true } : null);
    J(res, { user: uc.name, routines: list });
  });
}
