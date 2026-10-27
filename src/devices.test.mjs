// 设备：登记 / 配对 / 令牌鉴权 / 控制通道（SSE 下推 + POST 回传，含流式分块）/ 归属检查 / 会话连接 /
// 老中继兼容路径 / 同机内部接口。真起一个 http 服务，设备侧用 fetch 读 SSE，和真实设备服务走同一条路。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-devices-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.PV_PUBLIC_DOMAIN = 'pv.test';

const { createRouter } = await import('./runtime/router.mjs');
const { registerDeviceRoutes } = await import('./routes/devices.mjs');
const registry = await import('./runtime/device-registry.mjs');
const control = await import('./runtime/device-control.mjs');
const { deviceDispatch, resolveDevice, ownDevices } = await import('./runtime/devices.mjs');
const { ensureHostSecret } = await import('./runtime/host-secret.mjs');
const { deviceLinkFor } = await import('./runtime/chat-prefs.mjs');

// 身份：x-test-id 头 = admin | user:<名字>
const identify = (req) => {
  const who = String(req.headers['x-test-id'] || '');
  if (who === 'admin') return { kind: 'admin', user: null };
  if (who.startsWith('user:')) return { kind: 'user', user: who.slice(5), tier: 'pro', agents: ['claude'] };
  return { kind: 'none', user: null };
};

const router = createRouter();
registerDeviceRoutes(router, { identify });
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const opened = new Set();   // 挂着的 SSE，结束时统一掐断

test.after(() => { for (const c of opened) { try { c.abort(); } catch {} } server.closeAllConnections?.(); server.close(); });

const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ code: r.status, body: await r.json().catch(() => null) }));
const get = (p, headers = {}) => fetch(base + p, { headers }).then(async (r) => ({ code: r.status, body: await r.json().catch(() => null) }));

// 设备服务：挂 SSE，收到 op 交给 handler，按 handler 的返回回传。返回 { close, ops }。
async function fakeDevice(token, handler, { path: p = '/api/device/stream', info = { version: 't-1', tier: 'control', caps: ['fs.chunk'], shell: 'desktop', machineId: 'm1' } } = {}) {
  const ac = new AbortController();
  opened.add(ac);
  const header = Buffer.from(JSON.stringify(info)).toString('base64url');
  const headers = p.startsWith('/d/') ? { 'X-Bridge-Client': header } : { Authorization: 'Bearer ' + token, 'X-Bridge-Client': header };
  const res = await fetch(base + p, { headers, signal: ac.signal });
  assert.equal(res.status, 200);
  const ops = [];
  const resultUrl = p.startsWith('/d/') ? base + p.replace(/stream$/, 'result') : base + '/api/device/result';
  const resultHeaders = p.startsWith('/d/') ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const msg = JSON.parse(line.slice(5));
          ops.push(msg);
          const send = (b) => fetch(resultUrl, { method: 'POST', headers: resultHeaders, body: JSON.stringify({ opId: msg.opId, ...b }) });
          Promise.resolve(handler(msg, send)).then((r) => r !== undefined && send(r)).catch((e) => send({ ok: false, error: String(e.message || e) }));
        }
      }
    } catch { /* 掐断 */ }
  })();
  // 等服务端登记上线
  for (let k = 0; k < 50 && !control.onlineDeviceIds().length; k++) await new Promise((r) => setTimeout(r, 10));
  return { close: () => { ac.abort(); opened.delete(ac); }, ops };
}

const waitOffline = async (id) => { for (let k = 0; k < 100 && control.isDeviceOnline(id); k++) await new Promise((r) => setTimeout(r, 10)); };

test('登记：同一主人同一台机器重登复用设备 id，只换令牌；旧令牌立即失效', async () => {
  const a = await post('/api/devices/register', { name: '书房电脑', platform: 'win32', hostname: 'DESK', machineId: 'mid-1' }, { 'x-test-id': 'admin' });
  assert.equal(a.code, 200);
  assert.ok(a.body.token && a.body.device.id.startsWith('d-'));
  assert.equal(a.body.device.owner, 'admin');
  const b = await post('/api/devices/register', { name: '书房电脑', machineId: 'mid-1' }, { 'x-test-id': 'admin' });
  assert.equal(b.body.device.id, a.body.device.id);
  assert.notEqual(b.body.token, a.body.token);
  assert.equal(registry.authDevice(a.body.token), null);
  assert.equal(registry.authDevice(b.body.token).id, a.body.device.id);
  // 未登录不能登记
  assert.equal((await post('/api/devices/register', { name: 'x' })).code, 401);
});

test('控制通道：派发 → 设备执行 → 回传；归属检查；掉线即拒在途 op', async () => {
  const reg = await post('/api/devices/register', { name: '笔记本', machineId: 'mid-2' }, { 'x-test-id': 'user:alice' });
  const { token, device } = reg.body;
  const dev = await fakeDevice(token, (msg) => (msg.op === 'hang' ? undefined
    : msg.op === 'sysinfo' ? { ok: true, result: { hostname: 'LAPTOP', by: msg.meta?.by } } : { ok: false, error: '未知 op' }));
  const alice = { kind: 'user', key: 'u:alice' };
  assert.equal(control.isDeviceOnline(device.id), true);
  const r = await deviceDispatch(alice, device.id, 'sysinfo', {}, { by: 'claude' });
  assert.deepEqual(r, { hostname: 'LAPTOP', by: 'claude' });
  await assert.rejects(deviceDispatch(alice, device.id, 'nope', {}), /未知 op/);
  // 别人的设备：普通用户派不到；管理员默认也派不到（工具场景），排障口（by:'admin'）可以
  await assert.rejects(deviceDispatch({ kind: 'user', key: 'u:bob' }, device.id, 'sysinfo', {}), /不属于你/);
  await assert.rejects(deviceDispatch({ kind: 'admin', key: 'admin' }, device.id, 'sysinfo', {}, { by: 'claude' }), /不属于你/);
  // 排障口派到成员的电脑还要成员自己允许过「查看我的电脑」（开源路线 S2-7，runtime/admin-access.mjs），并在他那边记一笔
  await assert.rejects(deviceDispatch({ kind: 'admin', key: 'admin' }, device.id, 'sysinfo', {}, { by: 'admin' }), /没有允许管理员查看他的电脑/);
  await assert.rejects(deviceDispatch({ kind: 'admin', key: 'admin' }, device.id, 'desktop', { action: 'screenshot' }, { by: 'admin', anyOwner: true }), /没有允许管理员查看他的电脑/);
  // 远程更新客户端不用他允许（不看他电脑上的东西）：放行到设备那边（假设备不认这个 op）
  await assert.rejects(deviceDispatch({ kind: 'admin', key: 'admin' }, device.id, 'client.update', {}, { by: 'admin', anyOwner: true }), /未知 op/);
  const users = await import('./users.mjs');
  const acc = await import('./runtime/admin-access.mjs');
  await users.createUser('alice', 'password123', 'user');
  acc.setConsents('alice', { device: true });
  assert.equal((await deviceDispatch({ kind: 'admin', key: 'admin' }, device.id, 'sysinfo', {}, { by: 'admin' })).hostname, 'LAPTOP');
  assert.equal(acc.accessLog('alice', 1)[0].action, 'device');
  // 设备侧自报的权限档进了对外形状
  const mine = ownDevices(alice);
  assert.equal(mine[0].client.tier, 'control');
  assert.deepEqual(mine[0].client.caps, ['fs.chunk']);
  // 挂一个永不回的 op，再掐断设备 → 立刻拒，不等超时
  const pending = deviceDispatch(alice, device.id, 'hang', {}, { timeoutMs: 30_000 }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 30));
  dev.close();
  const e = await pending;
  assert.match(String(e.message), /断开/);
  await waitOffline(device.id);
  await assert.rejects(deviceDispatch(alice, device.id, 'sysinfo', {}), /离线/);
});

test('流式 op：设备分块回传，onChunk 逐块收到，最后一条结束', async () => {
  const reg = await post('/api/devices/register', { name: '流', machineId: 'mid-3' }, { 'x-test-id': 'admin' });
  const dev = await fakeDevice(reg.body.token, async (msg, send) => {
    for (const c of ['a', 'b', 'c']) await send({ ok: true, partial: true, chunk: c });
    return { ok: true, result: { n: 3 } };
  });
  const got = [];
  const r = await deviceDispatch({ kind: 'admin', key: 'admin' }, reg.body.device.id, 'pty.read', {}, { onChunk: (c) => got.push(c), channel: 'terminal' });
  assert.deepEqual(got, ['a', 'b', 'c']);
  assert.deepEqual(r, { n: 3 });
  dev.close();
  await waitOffline(reg.body.device.id);
});

test('目标解析：会话连接 > 恰好一台在线；none = 明确不连', async () => {
  const owner = { kind: 'user', key: 'u:carol' };
  assert.match(resolveDevice(owner).error, /还没有可用的设备/);
  const one = await post('/api/devices/register', { name: 'A', machineId: 'c-1' }, { 'x-test-id': 'user:carol' });
  const two = await post('/api/devices/register', { name: 'B', machineId: 'c-2' }, { 'x-test-id': 'user:carol' });
  assert.match(resolveDevice(owner).error, /都不在线/);
  const d1 = await fakeDevice(one.body.token, () => ({ ok: true, result: 1 }));
  assert.equal(resolveDevice(owner).device.id, one.body.device.id);
  const d2 = await fakeDevice(two.body.token, () => ({ ok: true, result: 2 }));
  for (let k = 0; k < 50 && !control.isDeviceOnline(two.body.device.id); k++) await new Promise((r) => setTimeout(r, 10));
  assert.match(resolveDevice(owner).error, /2 台设备在线/);
  assert.equal(resolveDevice(owner, { linked: two.body.device.id }).device.name, 'B');
  assert.equal(resolveDevice(owner, { want: 'a' }).device.name, 'A');   // 名字不分大小写
  assert.match(resolveDevice(owner, { linked: 'none' }).error, /不连接设备/);
  d1.close(); d2.close();
  await waitOffline(one.body.device.id); await waitOffline(two.body.device.id);
});

test('会话连接接口：只能连自己的设备，none 与清空都行', async () => {
  const mine = await post('/api/devices/register', { name: 'D', machineId: 'd-1' }, { 'x-test-id': 'user:dave' });
  const other = await post('/api/devices/register', { name: 'E', machineId: 'e-1' }, { 'x-test-id': 'user:erin' });
  const sid = '0b7a3c3e-1111-2222-3333-444455556666';
  const H = { 'x-test-id': 'user:dave' };
  assert.equal((await post('/api/devices/link', { sessionId: sid, link: other.body.device.id }, H)).code, 404);
  assert.equal((await post('/api/devices/link', { sessionId: sid, link: mine.body.device.id }, H)).body.link, mine.body.device.id);
  assert.equal((await get('/api/devices/link?sessionId=' + sid, H)).body.link, mine.body.device.id);
  assert.equal((await post('/api/devices/link', { sessionId: sid, link: 'none' }, H)).body.link, 'none');
  assert.equal((await post('/api/devices/link', { sessionId: sid, link: '' }, H)).body.link, '');
  // 存在 dave 自己的数据目录里，erin 读不到
  assert.equal(deviceLinkFor({ dataDir: path.join(tmp, 'users', 'erin', '.bridge') }, sid), null);
});

test('远程协助已下线：/pair 与铸码接口都没了；老中继路径 /d/<令牌>/control/* 照认', async () => {
  assert.notEqual((await post('/api/devices/pair-code', { name: '朋友电脑' }, { 'x-test-id': 'admin' })).code, 200);
  assert.notEqual((await post('/pair', { code: 'AAAA-AAAA' })).code, 200);
  const reg = await post('/api/devices/register', { name: '老路径', machineId: 'legacy-path-1' }, { 'x-test-id': 'admin' });
  const token = reg.body.token;
  const d = registry.authDevice(token);
  // 老客户端：能力 URL 挂流、回传
  const dev = await fakeDevice(token, () => ({ ok: true, result: 'pong' }), { path: '/d/' + token + '/control/stream', info: { version: 'old-1.0', desktop: true } });
  assert.equal(await deviceDispatch({ kind: 'admin', key: 'admin' }, d.id, 'ping', {}), 'pong');
  // 老客户端的 AI 上游路径一律 410
  assert.equal((await post('/d/' + token + '/v1/anthropic/v1/messages', {})).code, 410);
  // bootstrap 只回身份
  const boot = await get('/d/' + token + '/bootstrap');
  assert.equal(boot.body.device.id, d.id);
  assert.deepEqual(boot.body.upstreams, []);
  dev.close();
  await waitOffline(d.id);
});

test('吊销：当场断开并拒绝再连；删除只收已吊销的', async () => {
  const reg = await post('/api/devices/register', { name: 'R', machineId: 'r-1' }, { 'x-test-id': 'admin' });
  const dev = await fakeDevice(reg.body.token, () => ({ ok: true, result: 1 }));
  const id = reg.body.device.id;
  assert.equal((await post('/api/devices/action', { id, action: 'delete' }, { 'x-test-id': 'admin' })).code, 400);
  assert.equal((await post('/api/devices/action', { id, action: 'revoke' }, { 'x-test-id': 'admin' })).code, 200);
  await waitOffline(id);
  assert.equal(control.isDeviceOnline(id), false);
  const again = await fetch(base + '/api/device/stream', { headers: { Authorization: 'Bearer ' + reg.body.token } });
  assert.equal(again.status, 401);
  assert.equal((await post('/api/devices/action', { id, action: 'delete' }, { 'x-test-id': 'admin' })).code, 200);
  assert.equal(registry.deviceById(id), null);
  dev.close();
});

test('同机内部接口：主机密钥 + 本机直连；带隧道头一律 404', async () => {
  const secret = ensureHostSecret();
  assert.ok(secret.length >= 20);
  const H = { Authorization: 'Bearer ' + secret };
  const list = await get('/api/internal/devices', H);
  assert.equal(list.code, 200);
  assert.equal(list.body.enabled, true);
  assert.equal((await get('/api/internal/devices', { Authorization: 'Bearer nope' })).code, 404);
  assert.equal((await get('/api/internal/devices', { ...H, 'CF-Connecting-IP': '1.2.3.4' })).code, 404);
  const reg = await post('/api/devices/register', { name: 'I', machineId: 'i-1' }, { 'x-test-id': 'admin' });
  const dev = await fakeDevice(reg.body.token, (msg) => ({ ok: true, result: { op: msg.op, action: msg.args.action, by: msg.meta.by } }));
  const r = await post('/api/internal/device-op', { device: 'I', op: 'desktop', args: { action: 'cursor' }, by: 'codex' }, H);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.result, { op: 'desktop', action: 'cursor', by: 'codex' });
  dev.close();
  await waitOffline(reg.body.device.id);
});

test('同机内部接口·按人令牌（注册用户的 dimensio）：只看得见、只派得到自己的设备；op 限于设备工具那几样；会话连接按 <by>:<会话>；账号停用 / 收回授权当场失效', async () => {
  const users = await import('./users.mjs');
  const { mintAgentDeviceToken } = await import('./runtime/agent-device-token.mjs');
  const made = await users.createUser('frank', 'password123', 'pro');
  assert.ok(made.ok, made.error);
  users.setAgents('frank', ['claude', 'dimensio']);
  const H = { Authorization: 'Bearer ' + mintAgentDeviceToken(made.id) };
  // frank 两台、管理员一台，都在线
  const a = await post('/api/devices/register', { name: 'F1', machineId: 'f-1' }, { 'x-test-id': 'user:' + made.id });
  const b = await post('/api/devices/register', { name: 'F2', machineId: 'f-2' }, { 'x-test-id': 'user:' + made.id });
  const adm = await post('/api/devices/register', { name: 'ADM', machineId: 'adm-1' }, { 'x-test-id': 'admin' });
  const echo = (msg) => ({ ok: true, result: { op: msg.op, by: msg.meta.by, session: msg.meta.session || '' } });
  const d1 = await fakeDevice(a.body.token, echo);
  const d2 = await fakeDevice(b.body.token, echo);
  const d3 = await fakeDevice(adm.body.token, echo);
  for (const id of [a.body.device.id, b.body.device.id, adm.body.device.id]) {
    for (let k = 0; k < 50 && !control.isDeviceOnline(id); k++) await new Promise((r) => setTimeout(r, 10));
  }
  const list = await get('/api/internal/devices?by=dimensio', H);
  assert.equal(list.code, 200);
  assert.deepEqual(list.body.devices.map((d) => d.name).sort(), ['F1', 'F2']);
  // 管理员的设备：按名字也找不到；主机密钥那条路不受影响
  assert.match((await post('/api/internal/device-op', { device: 'ADM', op: 'desktop', args: {}, by: 'dimensio' }, H)).body.error, /找不到设备/);
  // 设备工具用不到的 op 一律拒（终端 / 转发 / 客户端更新这些）
  for (const op of ['sysinfo', 'client.update', 'pty.write', 'http.request']) {
    assert.match((await post('/api/internal/device-op', { device: 'F1', op, args: {}, by: 'dimensio' }, H)).body.error, /不支持的设备操作/, op);
  }
  const ok = await post('/api/internal/device-op', { device: 'F1', op: 'shell', args: { command: 'whoami' }, by: 'dimensio' }, H);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.result.by, 'dimensio');
  assert.deepEqual(ok.body.device.caps, ['fs.chunk']);
  // 两台在线、没连接：要指定；连上 F2 之后省略 device 就是它，别的会话不受影响
  const sid = '7d1c0e8a-aaaa-bbbb-cccc-111122223333';
  assert.match((await post('/api/internal/device-op', { op: 'desktop', args: {}, by: 'dimensio', session: sid }, H)).body.error, /2 台设备在线/);
  assert.equal((await post('/api/internal/device-link', { by: 'dimensio', session: sid, link: 'f2' }, H)).body.link, b.body.device.id);
  assert.equal((await get(`/api/internal/devices?by=dimensio&session=${sid}`, H)).body.link, b.body.device.id);
  const viaLink = await post('/api/internal/device-op', { op: 'fs.list', args: { path: 'C:\\' }, by: 'dimensio', session: sid }, H);
  assert.equal(viaLink.body.device.name, 'F2');
  assert.equal(viaLink.body.result.session, sid);
  assert.equal((await get('/api/internal/devices?by=dimensio&session=00000000-0000-0000-0000-000000000000', H)).body.link, '');
  assert.match((await post('/api/internal/device-link', { by: 'dimensio', session: sid, link: 'ADM' }, H)).body.error, /找不到设备/);
  assert.equal((await post('/api/internal/device-link', { by: 'dimensio', session: sid, link: 'none' }, H)).body.link, 'none');
  assert.match((await post('/api/internal/device-op', { op: 'desktop', args: {}, by: 'dimensio', session: sid }, H)).body.error, /不连接设备/);
  // 端口转发：列表只有自己的；老客户端不支持
  assert.deepEqual((await post('/api/internal/device-forward', { action: 'list' }, H)).body, { ok: true, forwards: [] });
  assert.match((await post('/api/internal/device-forward', { action: 'open', device: 'F1', port: 5173 }, H)).body.error, /还不支持端口转发/);
  // 改过的签名、经隧道来的、账号停用 / 不再授权 dimensio：一律 404
  const bad = H.Authorization.slice(0, -2) + (H.Authorization.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await get('/api/internal/devices', { Authorization: bad })).code, 404);
  assert.equal((await get('/api/internal/devices', { ...H, 'CF-Connecting-IP': '1.2.3.4' })).code, 404);
  users.setAgents('frank', ['claude']);
  assert.equal((await get('/api/internal/devices', H)).code, 404);
  users.setAgents('frank', ['claude', 'dimensio']);
  users.setDisabled('frank', true);
  assert.equal((await get('/api/internal/devices', H)).code, 404);
  users.setDisabled('frank', false);
  assert.equal((await get('/api/internal/devices', H)).code, 200);
  d1.close(); d2.close(); d3.close();
  for (const id of [a.body.device.id, b.body.device.id, adm.body.device.id]) await waitOffline(id);
});

test('迁移：并入老中继的 devices.json，令牌哈希原样可用', async () => {
  const token = 'legacy-token-' + 'x'.repeat(30);
  const { createHash } = await import('node:crypto');
  const file = path.join(tmp, 'relay-devices.json');
  writeFileSync(file, JSON.stringify({ devices: [{ id: 'd-abcdef123456', name: '杭州VPS', platform: 'win32', tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: '2026-07-22T00:00:00Z', revoked: false }], pairings: [] }));
  const r = await post('/api/devices/import-relay', { path: file }, { 'x-test-id': 'admin' });
  assert.deepEqual([r.body.added, r.body.skipped], [1, 0]);
  const d = registry.authDevice(token);
  assert.equal(d.id, 'd-abcdef123456');
  assert.equal(d.kind, 'legacy');
  assert.equal(d.owner, 'admin');
  const again = await post('/api/devices/import-relay', { path: file }, { 'x-test-id': 'admin' });
  assert.deepEqual([again.body.added, again.body.skipped], [0, 1]);
  // 普通用户不能导入
  assert.equal((await post('/api/devices/import-relay', { path: file }, { 'x-test-id': 'user:alice' })).code, 403);
  assert.ok(JSON.parse(readFileSync(registry.DEVICES_PATH, 'utf8')).devices.length >= 1);
});

// ── 终端与端口转发 ───────────────────────────────────────────────────────────

const term = await import('./runtime/device-term.mjs');
const forward = await import('./runtime/device-forward.mjs');
const { registerPreviewHostRoutes } = await import('./routes/preview-host.mjs');
registerPreviewHostRoutes(router);   // 中间件总在路由之前跑，注册顺序无所谓

// 读一条 SSE，事件推进 events；返回 { events, close }
async function sse(p, headers) {
  const ac = new AbortController();
  opened.add(ac);
  const res = await fetch(base + p, { headers, signal: ac.signal });
  const events = [];
  if (res.ok) {
    (async () => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (line) events.push(JSON.parse(line.slice(5)));
          }
        }
      } catch { /* 掐断 */ }
    })();
  }
  return { status: res.status, body: res.ok ? null : await res.json().catch(() => null), events, close: () => { ac.abort(); opened.delete(ac); } };
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 15)); } return false; };

// 假设备的终端：pty.open 记下流的 opId 并先吐一句提示符；pty.write 把输入回显到那条流上；pty.kill 结束那条流
function ptyHandler(state) {
  return async (msg, send) => {
    if (msg.op === 'pty.open') {
      state.openOp = msg.opId; state.opens = (state.opens || 0) + 1; state.lastOpen = msg;
      if (state.snapshot != null) await send({ ok: true, partial: true, chunk: { type: 'snapshot', d: state.snapshot } });
      else await send({ ok: true, partial: true, chunk: { type: 'data', d: 'PS> ' } });
      return undefined;   // 长流：shell 退出才结束
    }
    if (msg.op === 'pty.write') {
      state.writes = [...(state.writes || []), msg.args.d];
      await fetch(base + '/api/device/result', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: JSON.stringify({ opId: state.openOp, ok: true, partial: true, chunk: { type: 'data', d: 'echo:' + msg.args.d } }) });
      return { ok: true, result: { ok: true } };
    }
    if (msg.op === 'pty.resize') { state.size = [msg.args.cols, msg.args.rows]; return { ok: true, result: { ok: true } }; }
    if (msg.op === 'pty.kill') {
      await fetch(base + '/api/device/result', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token }, body: JSON.stringify({ opId: state.openOp, ok: true, result: { exitCode: 0 } }) });
      return { ok: true, result: { ok: true } };
    }
    return { ok: false, error: '未知 op ' + msg.op };
  };
}

test('pty.* / http.* 只能经各自模块派；频率护栏不算终端按键；timeoutMs 0 不超时、signal 撤掉后设备回传 404', async () => {
  const reg = await post('/api/devices/register', { name: '通道', machineId: 'mid-ch' }, { 'x-test-id': 'user:erin' });
  const erin = { kind: 'user', key: 'u:erin' };
  const id = reg.body.device.id;
  let lateStatus = 0;
  const dev = await fakeDevice(reg.body.token, async (msg, send) => {
    if (msg.op === 'slow') {
      // 等服务端撤掉这个 op 之后再回一块：应拿到 404
      await new Promise((r) => setTimeout(r, 120));
      lateStatus = (await send({ ok: true, partial: true, chunk: 'late' })).status;
      return undefined;
    }
    return { ok: true, result: { op: msg.op } };
  });
  try {
    await assert.rejects(deviceDispatch(erin, id, 'pty.write', { d: 'x' }), /只能经终端面板/);
    await assert.rejects(deviceDispatch(erin, id, 'http.request', { port: 1 }), /只能经端口转发/);
    // 终端按键：300 条也不触发每分钟 240 的护栏
    for (let i = 0; i < 300; i++) await deviceDispatch(erin, id, 'pty.write', { d: String(i) }, { channel: 'terminal', audit: false });
    // timeoutMs 0：不设超时；signal 撤掉立即拒，设备之后的回传拿 404
    const ac = new AbortController();
    const p = deviceDispatch(erin, id, 'slow', {}, { timeoutMs: 0, signal: ac.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    assert.match(String((await p).message), /已取消/);
    assert.ok(await until(() => lateStatus !== 0), '设备应收到回传结果');
    assert.equal(lateStatus, 404);
  } finally { dev.close(); await waitOffline(id); }
});

test('设备终端：只给主人开；开、看、写、改尺寸；掉线等重连并补快照；关掉后再开是新终端', async () => {
  const reg = await post('/api/devices/register', { name: '我的台式机', machineId: 'mid-term' }, { 'x-test-id': 'user:frank' });
  const { token, device } = reg.body;
  const who = { 'x-test-id': 'user:frank' };
  const state = { token };
  // 老客户端（没报 pty 能力）：409 带原因
  const old = await fakeDevice(token, ptyHandler(state), { info: { version: 'old', tier: 'control', caps: ['fs'], shell: 'desktop' } });
  const refused = await sse(`/api/devices/term/stream?id=${device.id}`, who);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /不支持终端/);
  old.close();
  await waitOffline(device.id);

  const info = { version: 'new', tier: 'control', caps: ['fs', 'pty', 'http'], shell: 'desktop' };
  let dev = await fakeDevice(token, ptyHandler(state), { info });
  // 别人（含管理员）开不了这台电脑的终端
  assert.equal((await sse(`/api/devices/term/stream?id=${device.id}`, { 'x-test-id': 'user:gina' })).status, 404);
  assert.equal((await sse(`/api/devices/term/stream?id=${device.id}`, { 'x-test-id': 'admin' })).status, 404);

  const view = await sse(`/api/devices/term/stream?id=${device.id}&cols=90&rows=20`, who);
  assert.equal(view.status, 200);
  assert.ok(await until(() => view.events.length > 0));
  assert.equal(view.events[0].type, 'hello');
  assert.ok(await until(() => view.events.some((e) => e.type === 'data' && e.d === 'PS> ')));
  assert.deepEqual([state.lastOpen.args.cols, state.lastOpen.args.rows], [90, 20]);
  assert.equal(state.lastOpen.meta.by, 'user');
  assert.equal((await post('/api/devices/term/input', { id: device.id, d: 'dir\r' }, who)).body.ok, true);
  assert.ok(await until(() => view.events.some((e) => e.type === 'data' && e.d === 'echo:dir\r')));
  await post('/api/devices/term/resize', { id: device.id, cols: 120, rows: 40 }, who);
  assert.ok(await until(() => state.size && state.size[0] === 120));
  // 第二个页面进来：先拿到快照
  const view2 = await sse(`/api/devices/term/stream?id=${device.id}`, who);
  assert.ok(await until(() => view2.events.some((e) => e.type === 'snapshot' && e.d.includes('PS> echo:dir'))));
  view2.close();

  // 设备掉线：不算终端结束，推 offline；同一台设备重新连上 → 服务端自动重开，设备补快照，推 online
  dev.close();
  assert.ok(await until(() => view.events.some((e) => e.type === 'offline')), '掉线应推 offline');
  assert.ok(!view.events.some((e) => e.type === 'exit'), '掉线不是退出');
  assert.equal((await post('/api/devices/term/input', { id: device.id, d: 'x' }, who)).body.ok, false);
  state.snapshot = 'PS> echo:dir\r\n(恢复)';
  dev = await fakeDevice(token, ptyHandler(state), { info });
  assert.ok(await until(() => view.events.some((e) => e.type === 'online')), '重连应推 online');
  assert.ok(await until(() => view.events.some((e) => e.type === 'snapshot' && e.d.includes('(恢复)'))));
  assert.equal(state.opens, 2);

  // 关掉：推 exit；再开是新的一次 pty.open
  state.snapshot = null;
  assert.equal((await post('/api/devices/term/kill', { id: device.id }, who)).body.ok, true);
  assert.ok(await until(() => view.events.some((e) => e.type === 'exit')));
  view.close();
  const view3 = await sse(`/api/devices/term/stream?id=${device.id}`, who);
  assert.ok(await until(() => state.opens === 3));
  view3.close();
  await post('/api/devices/term/kill', { id: device.id }, who);
  dev.close();
  await waitOffline(device.id);
});

test('端口转发：建 / 列 / 删；/fwd/<令牌>/ 同源入口隔离（sandbox、去 Cookie 与 Set-Cookie）；pv- 子域入口原样；访问方断开即撤 op', async () => {
  const reg = await post('/api/devices/register', { name: '开发机', machineId: 'mid-fwd' }, { 'x-test-id': 'user:hank' });
  const { token, device } = reg.body;
  const who = { 'x-test-id': 'user:hank' };
  const seen = [];
  let streamStopped = false;
  const dev = await fakeDevice(token, async (msg, send) => {
    if (msg.op !== 'http.request') return { ok: false, error: '未知 op' };
    seen.push(msg.args);
    const a = msg.args;
    if (a.path.startsWith('/events')) {
      await send({ ok: true, partial: true, chunk: { type: 'head', status: 200, headers: { 'content-type': 'text/event-stream' } } });
      for (let i = 0; i < 200; i++) {
        const r = await send({ ok: true, partial: true, chunk: { type: 'body', b64: Buffer.from(`data: ${i}\n\n`).toString('base64') } });
        if (r.status === 404) { streamStopped = true; return undefined; }
        await new Promise((r2) => setTimeout(r2, 20));
      }
      return { ok: true, result: { bytes: 0 } };
    }
    await send({ ok: true, partial: true, chunk: { type: 'head', status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'sid=evil; Path=/', 'x-up': '1' } } });
    await send({ ok: true, partial: true, chunk: { type: 'body', b64: Buffer.from('hello ').toString('base64') } });
    await send({ ok: true, partial: true, chunk: { type: 'body', b64: Buffer.from(a.method + ' ' + a.path + (a.body ? ' ' + Buffer.from(a.body, 'base64').toString() : '')).toString('base64') } });
    return { ok: true, result: { bytes: 1 } };
  }, { info: { version: 'new', tier: 'control', caps: ['http'], shell: 'desktop' } });
  try {
    // 只能给自己的设备建
    assert.equal((await post('/api/devices/forwards', { id: device.id, port: 5173 }, { 'x-test-id': 'user:ivy' })).code, 400);
    assert.equal((await post('/api/devices/forwards', { id: device.id, port: 70000 }, who)).code, 400);
    const made = await post('/api/devices/forwards', { id: device.id, port: 5173, label: 'vite' }, who);
    assert.equal(made.code, 200);
    const f = made.body.forward;
    assert.match(f.token, forward.FORWARD_TOKEN_RE);
    assert.equal(f.urls.local.endsWith(`/fwd/${f.token}/`), true);
    // 同一设备同一端口：返回原来那条
    assert.equal((await post('/api/devices/forwards', { id: device.id, port: 5173 }, who)).body.forward.token, f.token);
    assert.equal((await get('/api/devices/forwards', who)).body.forwards.length, 1);
    assert.equal((await get('/api/devices/forwards', { 'x-test-id': 'user:ivy' })).body.forwards.length, 0);

    // 同源入口：不带斜杠先补斜杠
    const bare = await fetch(`${base}/fwd/${f.token}`, { redirect: 'manual' });
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get('location'), `/fwd/${f.token}/`);
    const r = await fetch(`${base}/fwd/${f.token}/api/x?q=1`, { headers: { Cookie: 'bridge_auth=secret', 'X-Test': 'y' } });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'hello GET /api/x?q=1');
    assert.match(r.headers.get('content-security-policy') || '', /^sandbox/);
    assert.equal(r.headers.get('set-cookie'), null, '同源入口不许种 Cookie');
    assert.equal(r.headers.get('x-up'), '1');
    const last = seen.at(-1);
    assert.equal(last.port, 5173);
    assert.equal(last.headers.cookie, undefined, 'bridge 的 Cookie 不转给本机服务');
    assert.equal(last.headers['x-test'], 'y');
    // POST 带体
    const pr = await fetch(`${base}/fwd/${f.token}/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"m":1}' });
    assert.equal(await pr.text(), 'hello POST /v1/chat {"m":1}');
    // 不认识的令牌
    assert.equal((await fetch(`${base}/fwd/dzzzzzzzzzzzzzzzzzzzzzzzzz/`)).status, 404);
    // 预览子域入口：独立源，不加 sandbox，本机服务的 Cookie 原样
    assert.equal(f.urls.preview, `https://pv-${f.token}.pv.test/`);
    const viaHost = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: server.address().port, path: '/page', headers: { Host: `pv-${f.token}.pv.test` } }, (rs) => {
        let b = ''; rs.on('data', (c) => { b += c; }); rs.on('end', () => resolve({ status: rs.statusCode, headers: rs.headers, body: b }));
      });
      rq.on('error', reject); rq.end();
    });
    assert.equal(viaHost.status, 200);
    assert.equal(viaHost.body, 'hello GET /page');
    assert.equal(viaHost.headers['content-security-policy'], undefined);
    assert.match(String(viaHost.headers['set-cookie'] || ''), /sid=evil/);

    // 访问方中途断开：服务端撤掉 op，设备下一块回传拿 404 就停
    const ac = new AbortController();
    const sr = await fetch(`${base}/fwd/${f.token}/events`, { signal: ac.signal });
    const reader = sr.body.getReader();
    await reader.read();
    ac.abort();
    assert.ok(await until(() => streamStopped, 5000), '访问方断开后设备应停止推送');

    // 删掉：入口立即失效
    assert.equal((await post('/api/devices/forwards/remove', { token: f.token }, { 'x-test-id': 'user:ivy' })).code, 404);
    assert.equal((await post('/api/devices/forwards/remove', { token: f.token }, who)).code, 200);
    assert.equal((await fetch(`${base}/fwd/${f.token}/`)).status, 404);
  } finally { dev.close(); await waitOffline(device.id); }
});

test('客户端更新：新设备走 /api/device/client/*；老客户端经 /d/<令牌>/client/version 拿到的下载路径要能在它的基址下用', async () => {
  const dist = path.join(tmp, 'client-dist');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, 'bridge-client-setup-9.9.9.exe'), 'EXE-BYTES');
  writeFileSync(path.join(dist, 'latest.json'), JSON.stringify({ version: '9.9.9', file: 'bridge-client-setup-9.9.9.exe', sha256: 'x', downloadPath: '/client/download' }));
  process.env.BRIDGE_CLIENT_DIST = dist;
  try {
    const reg = await post('/api/devices/register', { name: '升级机', machineId: 'mid-up' }, { 'x-test-id': 'admin' });
    const auth = { Authorization: 'Bearer ' + reg.body.token };
    const fresh = await get('/api/device/client/version?current=1.0.0', auth);
    assert.equal(fresh.code, 200);
    assert.equal(fresh.body.version, '9.9.9');
    assert.equal(fresh.body.downloadPath, '/api/device/client/download');
    assert.equal(fresh.body.file, undefined, '本机文件路径不外露');
    const legacy = await get(`/d/${reg.body.token}/client/version?current=1.0.0`);
    assert.equal(legacy.body.downloadPath, '/client/download');
    const dl = await fetch(`${base}/d/${reg.body.token}${legacy.body.downloadPath}`);
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'EXE-BYTES');
    const dl2 = await fetch(base + fresh.body.downloadPath, { headers: auth });
    assert.equal(await dl2.text(), 'EXE-BYTES');
    // 管理员的设备列表顺带给出最新版本（控制台标「落后」用），不含本机路径
    const all = await get('/api/devices?all=1', { 'x-test-id': 'admin' });
    assert.equal(all.body.release.version, '9.9.9');
    assert.equal(all.body.release.file, undefined);
  } finally { delete process.env.BRIDGE_CLIENT_DIST; }
});
