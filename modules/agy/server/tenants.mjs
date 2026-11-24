// 注册用户的 agy：每人一个独立的 `agy acp` 进程，用他自己的一份 agy 配置与数据目录（--gemini-dir）。
//
// 管理员用的那个常驻进程读的是主机上 ~/.gemini（管理员自己的全部 agy 会话、插件、MCP 都在里面），不能让注册用户共用：
// agy 的会话库不按人分，session/list 会把本机所有会话列出来；它自带的文件 / 命令工具也没有围栏。
// 换一个 gemini 目录后（实测）：登录态照旧（凭据不在这个目录里，所有进程共用主机上登录的那个 Google 账号）、
// 会话库是空的、<目录>/config 被当成全局配置——工具调用守卫（guard/）就装在那里，对这个进程的每个会话与子代理生效。
//
// 目录放在服务器数据目录下、不在任何人的文件夹里：用户改不到自己的守卫。

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';
import { PORT } from '@bridge/core/config/index.mjs';
import { mintAgentDeviceToken } from '@bridge/core/runtime/agent-device-token.mjs';
import { memberProcessEnv } from '@bridge/core/runtime/member-boundary.mjs';
import { AcpClient } from './acp/client.mjs';
import { defaultDaemonCwd } from './acp/binary.mjs';
import { installGuard } from './guard/install.mjs';
import { guardBroken, markGuardBroken, GUARD_BROKEN_MESSAGE } from './guard/liveness.mjs';

const TENANT_ROOT = path.join(DATA_ROOT, 'agy', 'tenants');
// 没有在跑的轮、也没人挂着审批时，闲置这么久就把进程收掉（每个 agy 进程带一个 language server，常驻不起）
const IDLE_MS = 10 * 60_000;
// 同时起着的成员进程上限：到了先收一个眼下没在用的，全都在忙就让新来的稍后再试
const MAX_TENANTS = Math.max(1, Number(process.env.BRIDGE_AGY_MAX_TENANTS) || 8);

const tenants = new Map();   // ctx.key -> { client, dir, lastUse }
let idleTimer = null;
let clientFactory = null;    // 测试用：(opts) => AcpClient

/** 这个身份是不是要走自己的 agy 进程（注册用户）；管理员用主机上那个常驻进程。 */
export const isAgyTenant = (ctx) => !!ctx && ctx.kind === 'user' && !!ctx.user;

// 账号 id 进目录名前先过一遍：只留安全字符，再缀一段哈希防止不同 id 规整后撞名
function tenantIdOf(userId) {
  const raw = String(userId || '');
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'u';
  return `${safe}-${createHash('sha256').update(raw).digest('hex').slice(0, 10)}`;
}
const tenantId = (ctx) => tenantIdOf(ctx.user);

/** 这个人的 agy gemini 目录（--gemini-dir）。 */
export function tenantGeminiDir(ctx) {
  return path.join(TENANT_ROOT, tenantId(ctx));
}

const isBusy = (c) => c.turns.size > 0 || c.preparingTurns > 0 || c.pendingPermissions.size > 0 || c.pendingQuestions.size > 0;

// 到上限时腾一个位置：收掉闲得最久的那个；全都在忙就腾不出来
function makeRoom() {
  if (tenants.size < MAX_TENANTS) return true;
  let pick = null;
  for (const [key, t] of tenants) {
    if (isBusy(t.client)) continue;
    if (!pick || t.lastUse < pick.t.lastUse) pick = { key, t };
  }
  if (!pick) return false;
  try { pick.t.client.shutdown(); } catch {}
  tenants.delete(pick.key);
  return true;
}
/** 这个人的 agy 数据目录（会话库、brain 产物都在里面）。 */
export function tenantDataDir(ctx) {
  return path.join(tenantGeminiDir(ctx), 'antigravity-cli');
}
/** 守卫放行读写的产物目录：自带生图的成品、agy 的草稿区。 */
export function tenantArtifactDirs(ctx) {
  const data = tenantDataDir(ctx);
  return [path.join(data, 'brain'), path.join(data, 'scratch')];
}

function ensureIdleTimer() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    for (const [key, t] of tenants) {
      const c = t.client;
      if (isBusy(c)) { t.lastUse = Date.now(); continue; }
      if (Date.now() - t.lastUse > IDLE_MS) {
        try { c.shutdown(); } catch {}
        tenants.delete(key);
      }
    }
    if (!tenants.size) { clearInterval(idleTimer); idleTimer = null; }
  }, 60_000);
  idleTimer.unref?.();
}

/** 这个注册用户的 agy 进程（懒启动；闲置自动退出，下次用到再起）。 */
export function tenantClient(ctx) {
  if (!isAgyTenant(ctx)) throw new Error('tenantClient: 不是注册用户身份');
  // 守卫被认定没生效的（guard/liveness.mjs）：不再给他起进程
  if (guardBroken(ctx.key)) throw Object.assign(new Error(GUARD_BROKEN_MESSAGE), { status: 503 });
  let t = tenants.get(ctx.key);
  if (!t) {
    if (!makeRoom()) throw Object.assign(new Error('同时在用 Antigravity 的成员已到上限，请稍后再试。'), { status: 503 });
    const dir = tenantGeminiDir(ctx);
    const user = ctx.user;
    const opts = {
      label: 'tenant:' + tenantId(ctx),
      extraArgs: ['--gemini-dir', dir],
      // 不把 bridge 自己的环境变量原样交给成员的进程：里面有 bridge 的内部变量与各种密钥（BRIDGE_*、*_TOKEN、*_KEY…），
      // 成员在自己的 agy 里跑一句 `Get-ChildItem env:` 就全看见了。与成员的 Claude CLI 同一套清洗；
      // 完全信任档保留真实用户目录与代理变量（agy 的登录态在用户目录里，联网要走代理）。
      env: memberProcessEnv(process.env, { shell: true }),
      // 占位目录落在系统临时目录下（不进主仓库，避免把主仓库 AGENTS.md 注入成员会话），各进程按人分槽
      daemonCwd: defaultDaemonCwd(`tenant-${tenantId(ctx)}`, DATA_ROOT),
      logFile: path.join(dir, 'acp.log'),
      dataDir: path.join(dir, 'antigravity-cli'),
      // 每次起进程前重装守卫：脚本、令牌、端口都以此刻为准。装不上就不起进程——没有守卫的 agy 不能给注册用户用
      beforeSpawn: () => installGuard({
        configDir: path.join(dir, 'config'),
        api: `http://127.0.0.1:${PORT}`,
        token: mintAgentDeviceToken(user, 'agy'),
      }),
    };
    t = { client: clientFactory ? clientFactory(opts, ctx) : new AcpClient(opts), dir, lastUse: Date.now() };
    tenants.set(ctx.key, t);
    ensureIdleTimer();
  }
  t.lastUse = Date.now();
  return t.client;
}

/** 已经起着的那个（不为了查状态去起进程）；没有返回 null。 */
export function peekTenantClient(ctx) {
  return isAgyTenant(ctx) ? (tenants.get(ctx.key)?.client || null) : null;
}

export function shutdownTenant(ctx) {
  const t = isAgyTenant(ctx) ? tenants.get(ctx.key) : null;
  if (!t) return false;
  try { t.client.shutdown(); } catch {}
  tenants.delete(ctx.key);
  return true;
}

/**
 * 账号被停用 / 删除 / 降成普通档：收掉他的 agy 进程（在跑的轮由调用方先中止）；purge 时连他的 agy 数据一起删
 *（会话库、产物、守卫配置——账号都没了，留着就是没人管的残留）。key = 身份键（u:<账号 id>）。
 */
export function endTenantByKey(key, { userId = '', purge = false } = {}) {
  const t = tenants.get(String(key || ''));
  let stopped = false;
  if (t) {
    try { t.client.shutdown(); } catch {}
    tenants.delete(String(key));
    stopped = true;
  }
  let purged = false;
  if (purge && userId) {
    const dir = path.join(TENANT_ROOT, tenantIdOf(userId));
    // 目录名由账号 id 算出来，必须确实在租户根下面一层才删
    if (path.dirname(dir) === TENANT_ROOT) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); purged = true; } catch {}
    }
  }
  return { stopped, purged };
}

/** 守卫没生效：记下来、收掉他的进程（在跑的轮由调用方中止）。之后 tenantClient 不再给他起。 */
export function tripTenantGuard(ctx, why = '') {
  if (!isAgyTenant(ctx)) return;
  markGuardBroken(ctx.key, why);
  shutdownTenant(ctx);
}

// 测试里成员进程换成假 agy（不会来问守卫）时默认不探活；专门测探活的用例自己打开
let livenessInTest = false;
export const guardLivenessOn = () => !clientFactory || livenessInTest;
export function setGuardLivenessForTest(on) { livenessInTest = !!on; }

/** 成员进程的概况（控制台用）：起着几个、几个在忙。 */
export function tenantStats() {
  let busy = 0;
  for (const t of tenants.values()) if (isBusy(t.client)) busy++;
  return { count: tenants.size, busy, max: MAX_TENANTS };
}

export function shutdownTenants() {
  for (const t of tenants.values()) { try { t.client.shutdown(); } catch {} }
  tenants.clear();
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

/** 全部租户进程（管理员控制台的状态、空闲重启的忙闲判断用）。 */
export function allTenantClients() {
  return [...tenants.values()].map((t) => t.client);
}

export function setTenantClientFactoryForTest(fn) {
  shutdownTenants();
  clientFactory = fn || null;
}

process.once('exit', () => { try { shutdownTenants(); } catch {} });
