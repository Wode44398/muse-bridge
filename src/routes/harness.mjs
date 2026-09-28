// Harness reverse-proxy + 实例池：把 dimensio 底座（独立的 Node 进程，只听 127.0.0.1）挂进 bridge 的
// /api/harness/* 前缀。bridge 只做反代（流式直通，SSE /api/run 原样可用），harness 作为受监管的子进程运行。
//
// ── 多用户（三端拆分 P2，2026-09-28）──
// harness 本身是【单租户】的：一个进程 = 一套会话 / 配置 / 记忆 / 项目表，反代也不告诉它「是谁在请求」。
// 所以多用户的做法是「每个用户一个进程」：
//   · 管理员：沿用原来那个实例（HARNESS_PORT，默认 8799）和它的全部数据，零迁移、行为不变。
//   · 注册用户：按需拉起自己的实例（端口从 DIMENSIO_TENANT_PORT_BASE 往上找空的），所有数据位置经环境变量
//     改道进该用户自己的 .bridge/dimensio/，工作区就是他的私有文件夹；并以「租户模式」启动——访问范围锁死
//     「仅工作空间」、越界一律拒绝不弹审批、看不到扩展中心。
//   · 同时在跑的用户实例有上限（DIMENSIO_MAX_TENANTS，默认 4）；闲置 DIMENSIO_TENANT_IDLE_MS（默认 20 分钟）
//     且没有在跑的轮就排空退出；满了就挤掉最久没用、此刻空闲的那个，都不空闲才回 503。
// 反代按请求者身份（ctx.key）选实例；前端不用改，请求还是走 /api/harness/*。
//
// 准入：requireCtx + ctx.allowDimensio（全局开关 ∩ 按人授权 ∩ dimensio 支持多用户，见 identity.mjs）。

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireCtx } from '../runtime/identity.mjs';
import { PORT as BRIDGE_PORT, ROOT, NATIVE_ROOT, VAULT, config, userRoot } from '../config/index.mjs';
import { PROGRAM_ROOT } from '../runtime/paths.mjs';
import { EXT_REGISTRY_FILE } from '../extensions.mjs';
import { outboundProxyStatus } from '../runtime/net-proxy.mjs';
import { ensureHarnessUp, killTreeAndWait, stopHarnessGracefully } from '../runtime/harness-watchdog.mjs';
import { agentEnabled } from '../runtime/agent-status.mjs';

// harness 是本仓库的子目录；相对本文件解析，worktree 里各自指向自己那份。
const HARNESS_DIR = fileURLToPath(new URL('../../harness', import.meta.url));
// 可经环境变量覆盖：并行 worktree 各跑一份 bridge，就得各带一个 harness，不能共抢 8799。
const HARNESS_PORT = Number(process.env.HARNESS_PORT || 8799);
const HARNESS_HOST = '127.0.0.1';
const PREFIX = '/api/harness';
const INTERNAL_TOKEN_HEADER = 'x-dimensio-internal-token';

const TENANT_MAX = Math.max(1, Number(process.env.DIMENSIO_MAX_TENANTS || config.dimensioMaxTenants || 4));
const TENANT_IDLE_MS = Math.max(60_000, Number(process.env.DIMENSIO_TENANT_IDLE_MS || 20 * 60_000));
const TENANT_PORT_BASE = Number(process.env.DIMENSIO_TENANT_PORT_BASE || HARNESS_PORT + 100);

// bridge 侧 outboundProxy 配置（config.json）映射成 harness 的旋钮：人工强直连/写死
// 要跟着走；auto 探测的结果不下传（那是快照，harness 自己会探测得更及时）。
function outboundKnob() {
  const s = outboundProxyStatus();
  if (s.mode === 'off') return 'off';
  if (s.mode === 'pinned' || s.mode === 'manual') return s.proxy || 'auto';
  return 'auto';
}

// ── 一个 harness 实例（管理员那个，或某个用户的）──────────────────────────────────
class HarnessInstance {
  constructor({ key, port, token, env }) {
    this.key = key;
    this.port = port;
    this.token = token;
    this.envFn = env;              // () => 子进程环境（每次拉起时现算：出站代理旋钮等可能变过）
    this.child = null;             // the supervised harness process (null = not running)
    this.spawnedAt = 0;            // when `child` was started (boot grace for the watchdog)
    this.starting = null;          // in-flight ensure() promise (dedupe concurrent boots)
    this.lastUsed = Date.now();
    this.active = 0;               // 正在代理中的请求数（开着的 SSE 也算）——大于 0 就不回收
  }
  headers() { return { [INTERNAL_TOKEN_HEADER]: this.token }; }
  alive() { return this.child !== null; }

  // Is the harness reachable right now? Cheap GET /api/info with a short timeout.
  // 只认带安全标记、且认这把令牌的进程——占着端口的旧版无鉴权进程不能当成健康实例。
  probe() {
    return new Promise((resolve) => {
      const r = http.request(
        { host: HARNESS_HOST, port: this.port, path: '/api/info', method: 'GET', timeout: 1500, headers: this.headers() },
        (res) => { res.resume(); resolve(res.statusCode === 200 && res.headers['x-dimensio-api-guard'] === '1'); },
      );
      r.on('error', () => resolve(false));
      r.on('timeout', () => { r.destroy(); resolve(false); });
      r.end();
    });
  }

  spawn() {
    if (!existsSync(path.join(HARNESS_DIR, 'server', 'index.ts'))) {
      console.error('[harness] server/index.ts not found at', HARNESS_DIR);
      return null;
    }
    // node runs the .ts entry natively (Node 24). Force PORT so an inherited bridge PORT can't hijack it.
    const c = spawn(process.execPath, ['server/index.ts'], {
      cwd: HARNESS_DIR,
      env: this.envFn(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const tag = this.key === 'admin' ? '[harness] ' : `[harness ${this.key}] `;
    c.stdout.on('data', (d) => process.stdout.write(tag + d));
    c.stderr.on('data', (d) => process.stderr.write(tag + d));
    c.on('exit', (code, sig) => {
      console.log(tag + 'child exited', code, sig || '');
      if (this.child === c) this.child = null;
    });
    this.child = c;
    this.spawnedAt = Date.now();
    return c;
  }

  // Ensure the harness is up and answering. Concurrent callers share one boot.
  // S9（#24）：子进程活着却长时间不应答（主线程冻住）时整树杀掉重拉，见 harness-watchdog.mjs。
  ensure() {
    if (this.starting) return this.starting;
    this.starting = ensureHarnessUp({
      probe: () => this.probe(),
      hasChild: () => this.child !== null,
      childAgeMs: () => Date.now() - this.spawnedAt,
      spawn: () => { this.spawn(); },
      killChild: () => killTreeAndWait(this.child),
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  // Pipe one request through to the harness, streaming both ways (SSE-safe).
  proxy(req, res, url) {
    const { path: upstreamPath, headers } = upstreamRequest(req.headers, url, this.token);
    this.active++;
    this.lastUsed = Date.now();
    let settled = false;
    const done = () => { if (settled) return; settled = true; this.active = Math.max(0, this.active - 1); this.lastUsed = Date.now(); };
    const upstream = http.request(
      { host: HARNESS_HOST, port: this.port, path: upstreamPath, method: req.method, headers },
      (ures) => {
        const h = { ...ures.headers };
        // SSE must not be transformed/buffered by any intermediary.
        if ((h['content-type'] || '').includes('text/event-stream')) h['x-accel-buffering'] = 'no';
        res.writeHead(ures.statusCode || 502, h);
        ures.pipe(res);
      },
    );
    upstream.on('error', (e) => {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'harness unreachable: ' + e.message })); }
      else try { res.end(); } catch {}
      done();
    });
    // Client hang-up → tear down the upstream (aborts an in-flight run).
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); done(); });
    req.pipe(upstream);
  }

  // M8：给 harness 发一个带令牌的请求，2xx 算成功。
  request(method, pathname, body) {
    return new Promise((resolve) => {
      const payload = body === undefined ? null : JSON.stringify(body ?? {});
      const r = http.request(
        {
          host: HARNESS_HOST, port: this.port, path: pathname, method, timeout: 3000,
          headers: { ...this.headers(), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, json }); });
        },
      );
      r.on('error', () => resolve({ ok: false, json: null }));
      r.on('timeout', () => { r.destroy(); resolve({ ok: false, json: null }); });
      r.end(payload || undefined);
    });
  }

  // 有没有在跑的轮（harness /api/busy）。问不到就当忙——宁可晚回收也别腰斩一轮。
  async busy() {
    if (!this.child) return false;
    const r = await this.request('GET', '/api/busy');
    return !r.ok || !!r.json?.running;
  }

  // M8：先让 harness 排空（在跑的轮写明「服务重启」并落盘、收掉 job / 预览），graceMs 内没退才整树强杀。
  stop({ graceMs = 15_000 } = {}) {
    const c = this.child;
    if (!c) return Promise.resolve('gone');
    return stopHarnessGracefully(c, { requestDrain: async () => (await this.request('POST', '/api/admin/retire/commit', { force: true })).ok, graceMs });
  }
}

// ── 管理员实例：与拆分前完全一样 ──────────────────────────────────────────────────
// Process-local capability shared only with the supervised child. A browser can
// never supply or learn it; bridge user auth remains the public gate.
const ADMIN_TOKEN = process.env.DIMENSIO_INTERNAL_TOKEN || randomBytes(32).toString('base64url');
const admin = new HarnessInstance({
  key: 'admin',
  port: HARNESS_PORT,
  token: ADMIN_TOKEN,
  env: () => ({
    ...process.env,
    PORT: String(HARNESS_PORT),
    // bridge 自己的端口：harness 的 Preview 工具「回收端口」时一律拒绝碰它（services.ts
    // hostPorts）——以前 Preview(start, port=8787) 会 taskkill /T 把 bridge 整棵进程树带走。
    BRIDGE_PORT: String(BRIDGE_PORT),
    DIMENSIO_HOST: HARNESS_HOST,
    DIMENSIO_INTERNAL_TOKEN: ADMIN_TOKEN,
    // 扩展中心注册表（技能对 dimensio 的渐进披露注入）：同为「env 只传路径、内容现读」，
    // 装/删扩展不需要重启 harness，新会话现读生效。见 harness/server/extensions.ts。
    BRIDGE_EXTENSIONS_FILE: EXT_REGISTRY_FILE,
    // 出站代理只传「人意」不传快照：off/写死原样转达，auto 让 harness 自己探测
    // 并每分钟自愈（见 harness/server/net-proxy.ts）。继承的 HTTP(S)_PROXY 是
    // bridge 当下的探测快照，harness 只把它当候选，不当配置。
    DIMENSIO_OUTBOUND_PROXY: outboundKnob(),
  }),
});

// ── 用户实例 ──────────────────────────────────────────────────────────────────
const tenants = new Map();          // ctx.key ('u:<name>') -> HarnessInstance

// 用户实例的数据全落在他自己的 .bridge/dimensio/ 下；工作区 = 他的私有文件夹。
function tenantDirs(user) {
  const home = userRoot(user);
  const d = path.join(home, '.bridge', 'dimensio');
  return {
    home, d,
    SESSIONS_DIR: path.join(d, 'sessions'),
    MEMORY_DIR: path.join(d, 'memory'),
    KNOWLEDGE_DIR: path.join(d, 'knowledge'),
    DIMENSIO_CONFIG_FILE: path.join(d, 'runtime-config.json'),
    DIMENSIO_QUICK_FILE: path.join(d, 'quick.json'),
    DIMENSIO_QUICK_ROOT: path.join(d, 'quick'),
    PROJECTS_FILE: path.join(d, 'projects.json'),
    PROJECTS_ROOT: home,
    WORKSPACE_DIR: home,
    DIMENSIO_GLOBAL_GUIDE: path.join(d, 'GUIDE.md'),
  };
}

// 用户实例不该从 bridge 进程继承的东西：管理员的扩展注册表、bridge 的数据根指针，以及 bridge 自己的开关。provider 的 key 照常继承（大家共用服务器上配的那份，
// 同共用 Claude 订阅一个道理）——harness 的 Bash / 预览子进程本来就只拿白名单环境。
const TENANT_ENV_DROP = [
  /^BRIDGE_/, /^DIMENSIO_/, /^HARNESS_/, /^SESSIONS_DIR$/, /^MEMORY_DIR$/, /^KNOWLEDGE_DIR$/, /^PROJECTS_(FILE|ROOT)$/, /^WORKSPACE_DIR$/,
  /^SANDBOX_ACCESS$/, /^PV_PUBLIC_DOMAIN$/, /^CLAUDE_CODE_OAUTH_TOKEN$/, /^TUNNEL_TOKEN$/,
];

function tenantEnv(user, port, token, { shell }) {
  const dirs = tenantDirs(user);
  const base = {};
  for (const [k, v] of Object.entries(process.env)) if (!TENANT_ENV_DROP.some((re) => re.test(k))) base[k] = v;
  // 共用管理员那份厂商 key 文件（harness 默认读 harness/.env；管理员实例若经 HARNESS_ENV_FILE 指了别处就跟着走）。
  const envFile = process.env.HARNESS_ENV_FILE || path.join(HARNESS_DIR, '.env');
  // 不许碰的位置（命令里出现就拒）：bridge 的数据根 / 程序目录 / 用户根（自己的目录除外）/ 管理员工作区。
  const deny = [ROOT, PROGRAM_ROOT, NATIVE_ROOT, VAULT].filter(Boolean).join(path.delimiter);
  return {
    ...base,
    PORT: String(port),
    BRIDGE_PORT: String(BRIDGE_PORT),
    DIMENSIO_HOST: HARNESS_HOST,
    DIMENSIO_INTERNAL_TOKEN: token,
    DIMENSIO_OUTBOUND_PROXY: outboundKnob(),
    HARNESS_ENV_FILE: envFile,
    SESSIONS_DIR: dirs.SESSIONS_DIR,
    MEMORY_DIR: dirs.MEMORY_DIR,
    KNOWLEDGE_DIR: dirs.KNOWLEDGE_DIR,
    DIMENSIO_CONFIG_FILE: dirs.DIMENSIO_CONFIG_FILE,
    DIMENSIO_QUICK_FILE: dirs.DIMENSIO_QUICK_FILE,
    DIMENSIO_QUICK_ROOT: dirs.DIMENSIO_QUICK_ROOT,
    PROJECTS_FILE: dirs.PROJECTS_FILE,
    PROJECTS_ROOT: dirs.PROJECTS_ROOT,
    WORKSPACE_DIR: dirs.WORKSPACE_DIR,
    DIMENSIO_GLOBAL_GUIDE: dirs.DIMENSIO_GLOBAL_GUIDE,
    // 租户模式（harness 侧的锁定见 harness/server/tenant.ts）：
    DIMENSIO_TENANT: '1',
    SANDBOX_ACCESS: 'workspace',
    DIMENSIO_READONLY_PATHS: '',
    DIMENSIO_DENY_PATHS: deny,
    DIMENSIO_TENANT_SHELL: shell ? '1' : '0',
    // 子进程的隔离 HOME 与 $WORKSPACE_TMP 各用各的（默认是整机共用的临时目录，彼此看得见）。
    DIMENSIO_CHILD_HOME: path.join(dirs.d, 'child-home'),
    DIMENSIO_SCRATCH_DIR: path.join(dirs.d, 'tmp'),
    // 不传 BRIDGE_DATA_ROOT / BRIDGE_ROOT / 扩展注册表：租户模式下 harness 也一概不认 bridge 的集成件
    // （paths.ts bridgeRootCandidates 返回空）。
  };
}

// 找一个空端口（从 base 往上，跳过别的实例正占着的）。
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, HARNESS_HOST);
  });
}
async function allocPort() {
  const used = new Set([HARNESS_PORT, ...[...tenants.values()].map((t) => t.port)]);
  for (let p = TENANT_PORT_BASE; p < TENANT_PORT_BASE + 400; p++) {
    if (used.has(p) || p === BRIDGE_PORT) continue;
    if (await portFree(p)) return p;
  }
  return null;
}

// 满了：挤掉最久没用、此刻没有请求在走、也没有在跑的轮的那个。挤不动返回 false。
async function makeRoom() {
  const idle = [...tenants.values()].filter((t) => t.active === 0).sort((a, b) => a.lastUsed - b.lastUsed);
  for (const t of idle) {
    if (await t.busy()) continue;
    tenants.delete(t.key);
    await t.stop();
    console.log(`[harness] 用户实例 ${t.key} 让位（上限 ${TENANT_MAX}）`);
    return true;
  }
  return false;
}

let tenantLock = Promise.resolve();   // 建实例串行化：两个请求同时进来别给同一个人拉两份
function tenantFor(ctx) {
  const run = tenantLock.then(async () => {
    let t = tenants.get(ctx.key);
    if (t) return t;
    if (tenants.size >= TENANT_MAX && !(await makeRoom())) return null;
    const port = await allocPort();
    if (!port) return null;
    const dirs = tenantDirs(ctx.user);
    for (const k of ['SESSIONS_DIR', 'MEMORY_DIR', 'KNOWLEDGE_DIR', 'DIMENSIO_QUICK_ROOT']) { try { mkdirSync(dirs[k], { recursive: true }); } catch {} }
    const token = randomBytes(32).toString('base64url');
    const shell = !!ctx.shell;
    t = new HarnessInstance({ key: ctx.key, port, token, env: () => tenantEnv(ctx.user, port, token, { shell }) });
    t.shell = shell;
    tenants.set(ctx.key, t);
    return t;
  });
  tenantLock = run.catch(() => {});
  return run;
}

// 闲置回收：没有请求在走、闲了够久、也没有在跑的轮 → 排空退出。
const reaper = setInterval(async () => {
  for (const t of [...tenants.values()]) {
    if (t.active > 0 || Date.now() - t.lastUsed < TENANT_IDLE_MS) continue;
    if (await t.busy()) continue;
    if (tenants.get(t.key) !== t) continue;
    tenants.delete(t.key);
    await t.stop();
    console.log(`[harness] 用户实例 ${t.key} 闲置回收`);
  }
}, 60_000);
reaper.unref?.();

// 档位变了（Pro ↔ 普通 = 有没有命令行）：旧实例按旧档位起的，下次请求前换一份。
async function instanceFor(ctx) {
  if (ctx.kind !== 'user') return admin;
  const t = await tenantFor(ctx);
  if (t && t.shell !== !!ctx.shell && t.active === 0) {
    tenants.delete(ctx.key);
    await t.stop();
    return tenantFor(ctx);
  }
  return t;
}

// bridge 进程内其他直连 harness 的调用方用：harness 的 API 一律只认令牌（S1），不再放行「回环 + 无 Origin」。
export function harnessInternalHeaders() { return admin.headers(); }
// 所有在跑的实例（预览子域路由要挨个问它们的服务注册表）。
export function harnessEndpoints() {
  return [admin, ...tenants.values()].filter((t) => t.alive()).map((t) => ({ host: HARNESS_HOST, port: t.port, headers: t.headers() }));
}

// M15（kimi K32）：远端的凭证不往 harness 带——bridge 的 Authorization / Cookie 与地址栏里的 ?token=（GET 资源用）只在 bridge
// 这一层鉴权时用，harness 只认进程内能力令牌、根本不读它们。以前原样转过去：harness 或它起的工具哪天把请求头 / URL 记进
// 日志、诊断包，管理员令牌就跟着落了盘。
const STRIP_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
export function upstreamRequest(reqHeaders, url, token = ADMIN_TOKEN) {
  let search = url.search || '';
  if (url.searchParams?.has('token')) {
    const params = new URLSearchParams(url.search);
    params.delete('token');
    const qs = params.toString();
    search = qs ? `?${qs}` : '';
  }
  const headers = { ...reqHeaders };
  delete headers.host;
  delete headers.connection;
  for (const h of STRIP_HEADERS) delete headers[h];
  delete headers[INTERNAL_TOKEN_HEADER];
  headers[INTERNAL_TOKEN_HEADER] = token;
  return { path: url.pathname.slice(PREFIX.length) + search, headers };
}

export function registerHarnessRoutes(router, { identify }) {
  router.use(async (req, res, url) => {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return; // not ours
    // dimensio 这个 agent 关着（设置「Agent」页）：一律 403，不拉起 harness 进程。
    if (!agentEnabled('dimensio')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'dimensio 未启用' }));
      return false;
    }
    // 登录 + allowDimensio（全局开关 ∩ 按人授权 ∩ dimensio 支持多用户）。requireCtx 失败已写 401。
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return false;
    if (!ctx.allowDimensio) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'dimensio 未启用，或你的账号没有使用权限' }));
      return false;
    }
    const inst = await instanceFor(ctx);
    if (!inst) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `同时在用 dimensio 的人太多了（上限 ${TENANT_MAX}），请稍后再试` }));
      return false;
    }
    const up = await inst.ensure();
    if (!up) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'harness 启动失败' })); return false; }
    inst.proxy(req, res, url);
    return false; // handled — stop dispatch
  });
}

// Don't leave orphaned harnesses behind when the bridge goes down. Installing a
// SIGINT/SIGTERM listener disables Node's default signal exit, so the handler must
// explicitly finish the shutdown.
// M8：先让每个实例排空（在跑的轮写明「服务重启」并落盘、收掉 job / 预览），15 秒内没退才整树强杀。
let shuttingDown = false;
function shutdownForSignal() {
  if (shuttingDown) return;
  shuttingDown = true;
  const all = [admin, ...tenants.values()].filter((t) => t.alive());
  if (!all.length) { setImmediate(() => process.exit(0)); return; }
  const hard = setTimeout(() => process.exit(0), 20_000);
  hard.unref();
  void Promise.allSettled(all.map((t) => t.stop())).finally(() => process.exit(0));
}
// 控制台「重启服务」（runtime/service-control.mjs）用：同一套排空，但不替调用方退出进程。
export function drainHarnesses() {
  shuttingDown = true;
  const all = [admin, ...tenants.values()].filter((t) => t.alive());
  return Promise.allSettled(all.map((t) => t.stop()));
}
process.once('SIGINT', shutdownForSignal);
process.once('SIGTERM', shutdownForSignal);
process.once('exit', () => { for (const t of [admin, ...tenants.values()]) if (t.child) try { t.child.kill(); } catch {} });
