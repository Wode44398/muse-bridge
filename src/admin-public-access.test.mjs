// 控制台管理接口：/api/admin/public-access 的契约（GET / POST / restart，令牌不回显，非管理员 404），
// R2（远程管理不许停服务 / 停隧道 / 动开机自启），以及 R9（/control/* 只认同机直连、未授权审计限频）。
// 真起 http 服务，「远程」用 X-Forwarded-For 头模拟（经隧道 / 反代来的请求必带转发痕迹）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-adminpa-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_CLIENT_UPDATE_FEED = '';   // 不去 GitHub 拉清单
// 没有守护进程：万一 409 闸门失灵，重启 / 更新接口也只会回 400「没有守护进程托管」，不会让测试进程退出或去跑 update 脚本
for (const k of ['BRIDGE_SUPERVISED', 'INVOCATION_ID', 'JOURNAL_STREAM', 'pm_id', 'PM2_HOME']) delete process.env[k];

// 假 cloudflared：快速隧道打印一个 trycloudflare 地址，/ready 恒通（同 public-access.test.mjs 的简化版）
const FAKE = path.join(tmp, 'fake-cloudflared.mjs');
writeFileSync(FAKE, `
import http from 'node:http';
const a = process.argv.slice(2);
const i = a.indexOf('--metrics');
http.createServer((q, r) => { r.writeHead(q.url === '/ready' ? 200 : 404); r.end(); }).listen(Number(a[i + 1].split(':')[1]), '127.0.0.1');
if (a.includes('--url')) setTimeout(() => process.stderr.write('INF |  https://adm-' + process.pid + '.trycloudflare.com  |\\n'), 100);
setInterval(() => {}, 1 << 30);
`);

const { createRouter } = await import('./runtime/router.mjs');
const { registerAdminRoutes } = await import('./routes/admin.mjs');
const { registerDeviceRoutes } = await import('./routes/devices.mjs');
const { initPublicAccess } = await import('./runtime/public-access.mjs');
const { readDeviceAudit } = await import('./runtime/device-audit.mjs');
const { PROGRAM_ROOT } = await import('./runtime/paths.mjs');
const { ensureHostSecret } = await import('./runtime/host-secret.mjs');

const ADMIN = 'admin-token-for-tests-0123456789';
const authOk = (req) => req.headers.authorization === 'Bearer ' + ADMIN;
const identify = (req) => (authOk(req) ? { kind: 'admin', user: null } : { kind: 'none', user: null });
const router = createRouter();
registerAdminRoutes(router, { authOk });
registerDeviceRoutes(router, { identify });
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;
const pa = initPublicAccess({
  dataRoot: tmp, programRoot: tmp, port, noAuth: false, external: null, which: () => null,
  binOverride: process.execPath, binArgsPrefix: [FAKE], isOurProcess: async () => false,
  fetch: async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
  timing: { graceMs: { quick: 0, token: 0 }, fastCheckMs: 200, checkMs: 500, switchWaitMs: { quick: 5000, token: 5000 } },
});
test.after(() => { pa.dispose(); server.closeAllConnections?.(); server.close(); });

const H = (remote = false, extra = {}) => ({ Authorization: 'Bearer ' + ADMIN, 'Content-Type': 'application/json', ...(remote ? { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '203.0.113.9' } : {}), ...extra });
const call = async (method, p, body, headers = H()) => {
  const r = await fetch(base + p, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { code: r.status, body: await r.json().catch(() => null) };
};

test('GET 契约：字段齐全；非管理员 404', async () => {
  const r = await call('GET', '/api/admin/public-access');
  assert.equal(r.code, 200);
  for (const k of ['mode', 'status', 'url', 'lastProbe', 'cloudflared', 'log', 'hint']) assert.ok(k in r.body, '缺字段 ' + k);
  assert.equal(r.body.mode, 'off');
  for (const k of ['available', 'version', 'path', 'downloading']) assert.ok(k in r.body.cloudflared, '缺 cloudflared.' + k);
  assert.ok(Array.isArray(r.body.log));
  const anon = await fetch(base + '/api/admin/public-access');
  assert.equal(anon.status, 404);
});

test('POST manual / off：应用后回同结构；参数错误 400 带 error；令牌永不回显', async () => {
  const bad = await call('POST', '/api/admin/public-access', { mode: 'whatever' });
  assert.equal(bad.code, 400);
  assert.match(bad.body.error, /模式/);
  const m = await call('POST', '/api/admin/public-access', { mode: 'manual', url: 'https://bridge.example.net/x' });
  assert.equal(m.code, 200);
  assert.equal(m.body.mode, 'manual');
  assert.equal(m.body.url, 'https://bridge.example.net');
  const tok = 'eyJ' + 'a'.repeat(80);
  // 先把令牌存进去（切到 off，带令牌：不起隧道，令牌照存）
  const o = await call('POST', '/api/admin/public-access', { mode: 'off', token: tok });
  assert.equal(o.code, 200);
  assert.equal(o.body.mode, 'off');
  const g = await call('GET', '/api/admin/public-access');
  assert.equal(g.body.hasToken, true);
  assert.ok(!JSON.stringify(g.body).includes(tok), 'GET 不回显令牌');
  const rs = await call('POST', '/api/admin/public-access/restart', {});
  assert.equal(rs.code, 400, 'off 时重启报错');
});

test('总览带公网访问摘要', async () => {
  const r = await call('GET', '/api/admin/overview');
  assert.equal(r.code, 200);
  assert.ok(r.body.publicAccess && 'mode' in r.body.publicAccess);
  assert.equal(typeof r.body.publicAccess.lastProbe, 'object', 'lastProbe 恒是对象（还没探过 at=0）');
  assert.equal(r.body.publicAccess.lastProbe.at, 0);
});

// fetch 改不了 Host 头：经隧道进来的请求用 node:http 发（Host = 隧道地址，带转发痕迹 = 远程）
const raw = (method, p, body, headers) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : '';
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let s = ''; res.setEncoding('utf8'); res.on('data', (d) => (s += d));
    res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ code: res.statusCode, body: j }); });
  });
  req.on('error', reject);
  req.end(data);
});

test('经快速隧道临时地址远程连着：重启 / 更新服务端、换命名隧道却没给地址 → 409；取消等待重启照常', async () => {
  const on = await call('POST', '/api/admin/public-access', { mode: 'quick' });
  assert.equal(on.code, 200);
  let s = null;
  for (let i = 0; i < 100 && !s; i++) { const g = await call('GET', '/api/admin/public-access'); if (g.body.url) s = g.body; else await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(s, '快速隧道拿到了地址');
  const viaTunnel = { ...H(true), Host: new URL(s.url).host };
  try {
    for (const [p, body] of [['/api/admin/service/restart', { mode: 'now' }], ['/api/admin/service/restart', { mode: 'idle' }], ['/api/admin/service/update', {}]]) {
      const x = await raw('POST', p, body, viaTunnel);
      assert.equal(x.code, 409, p + ' ' + JSON.stringify(body));
      assert.match(x.body.error, /临时地址/);
    }
    const c = await raw('POST', '/api/admin/service/restart', { mode: 'cancel' }, viaTunnel);
    assert.equal(c.code, 200, '取消等待重启不受限');
    // 对外地址一栏留空（界面会带上 url: ''，覆盖掉以前存过的地址）
    const tk = await raw('POST', '/api/admin/public-access', { mode: 'token', token: 'eyJ' + 'a'.repeat(80), url: '' }, viaTunnel);
    assert.equal(tk.code, 409, '换命名隧道却不知道新地址');
    assert.match(tk.body.error, /还不知道新的对外地址/);
    assert.equal((await call('GET', '/api/admin/public-access')).body.mode, 'quick', '没动');
  } finally {
    await call('POST', '/api/admin/public-access', { mode: 'off' });
  }
});

// 数据根不在程序目录的实例（本测试就是）不托管本机服务：就算程序目录里有 admin.ps1，也不显示进程控制、动作一律 409。
// 先只走只读的 ping / status 确认闸门在（ping 和动作看的是同一个开关）；断言不过就停在这里，不会往下发动作。
test('测试实例（数据根≠程序目录）：不托管本机服务——ping 报没有脚本、状态按降级、动作 409', async () => {
  assert.equal((await call('GET', '/api/admin/ping')).body.scriptAvailable, false);
  const st = await call('GET', '/api/admin/status');
  assert.equal(st.code, 200);
  assert.equal(st.body.unavailable, true);
  const r = await call('POST', '/api/admin/action', { action: 'restart-tunnel' });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /不托管本机服务/);
});

// R2：远程管理不许做会把自己关在门外的 admin.ps1 动作。
// 本机若真有 admin.ps1（维护者的主机 / 它的 worktree），一旦闸门失灵就会真去停正式服——这台机器上不跑这条，
// 只在没有 admin.ps1 的环境（CI / Linux / 公开版）里验。
const realScript = process.platform === 'win32' && existsSync(path.join(PROGRAM_ROOT, 'admin.ps1'));
test('R2：远程来的停服务 / 停隧道 / 开机自启一律 403', { skip: realScript ? '本机有真 admin.ps1，不冒险' : false }, async () => {
  for (const action of ['stop-server', 'stop-tunnel', 'remove', 'install']) {
    const r = await call('POST', '/api/admin/action', { action }, H(true));
    assert.equal(r.code, 403, action);
    assert.match(r.body.error, /远程管理不能执行/);
  }
});

test('R2：ping 报出是不是远程来的', async () => {
  assert.equal((await call('GET', '/api/admin/ping', null, H(true))).body.remote, true);
  assert.equal((await call('GET', '/api/admin/ping')).body.remote, false);
});

test('R9：/control/dispatch、/control/devices 只认同机直连；未授权审计按 IP 限频', async () => {
  const secret = ensureHostSecret();
  const remote = { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.7', 'X-Bridge-Host-Secret': secret, Authorization: 'Bearer ' + secret };
  const d1 = await fetch(base + '/control/dispatch', { method: 'POST', headers: remote, body: '{}' });
  assert.equal(d1.status, 404, '经隧道 / 反代来的派发当不存在');
  const d2 = await fetch(base + '/control/devices', { headers: remote });
  assert.equal(d2.status, 404);
  const local = await fetch(base + '/control/devices');
  assert.equal(local.status, 404, '同机但没密钥也不给');
  const count = async () => (await readDeviceAudit({ limit: 500 })).filter((e) => e.ev === 'unauthorized' && e.ip === '192.0.2.44').length;
  const before = await count();
  for (let i = 0; i < 5; i++) await fetch(base + '/d/' + 'x'.repeat(24) + '/control/stream', { headers: { 'CF-Connecting-IP': '192.0.2.44' } });
  await new Promise((r) => setTimeout(r, 300));   // 审计是异步 appendFile
  const after = await count();
  assert.equal(after - before, 1, '同一个 IP 一分钟只记一条');
});

test('R9：直连（不是本机 cloudflared 转进来的）伪造 CF-Connecting-IP 绕不过限频', async (t) => {
  // 从 127.0.0.2 发起：socket 对端不是 127.0.0.1，等同局域网 / 公网直连 8787
  const direct = (fake) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, localAddress: '127.0.0.2', path: '/d/' + 'y'.repeat(24) + '/control/stream', headers: { 'CF-Connecting-IP': fake } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  try { await direct('10.9.0.0'); } catch { t.skip('这台机器不能从 127.0.0.2 发起连接'); return; }
  for (let i = 1; i <= 6; i++) assert.equal(await direct('10.9.0.' + i), 401);
  await new Promise((r) => setTimeout(r, 300));   // 审计是异步 appendFile
  const all = (await readDeviceAudit({ limit: 2000 })).filter((e) => e.ev === 'unauthorized');
  assert.equal(all.filter((e) => e.ip === '127.0.0.2').length, 1, '按真实来源（socket 对端）限频：7 个请求只记一条');
  assert.ok(!all.some((e) => /^10\.9\.0\./.test(String(e.ip))), '伪造的来源不进审计');
});
