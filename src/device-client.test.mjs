// 设备客户端（runtime/device-client.mjs）：bridge 起的同机子进程（Codex 的 stdio MCP 等）经内部设备接口操作用户的电脑。
// 起一个假的 bridge 内部接口（127.0.0.1 随机端口），钉住：只认回环地址 + 主机密钥、Bearer 与请求体、桌面动作自动带
// frameKey 与超时档、错误翻译（没配环境变量 / 连不上 / 超时 / 404 / 5xx / 设备离线 / 档位不够 / 老客户端 / 不跟跳转）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  DeviceError, DESKTOP_SLOW_TIMEOUT_MS, DESKTOP_TIMEOUT_MS,
  desktopOp, deviceApiAvailable, deviceOp, listDevices, timing,
} from './runtime/device-client.mjs';

const SECRET = 'FAKE-host-secret-for-device-client-tests';

// 整体兜底：哪里挂住了也不拖住测试进程
setTimeout(() => { console.error('device-client 测试整体超时'); process.exit(1); }, 60_000).unref();

const saved = { api: process.env.BRIDGE_DEVICE_API, secret: process.env.BRIDGE_DEVICE_SECRET };
function setEnv(api, secret) {
  if (api === undefined) delete process.env.BRIDGE_DEVICE_API; else process.env.BRIDGE_DEVICE_API = api;
  if (secret === undefined) delete process.env.BRIDGE_DEVICE_SECRET; else process.env.BRIDGE_DEVICE_SECRET = secret;
}
test.after(() => setEnv(saved.api, saved.secret));

// 假 bridge：记下每个请求；routes[path] = (req, body) => [status, payload, headers?]（可以是 Promise）
async function fakeBridge(t, routes) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const route = routes[req.url];
    const [status, payload, headers] = route ? await route(req, body) : [404, { error: 'not found' }];
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', ...(headers || {}) });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { requests, api: `http://127.0.0.1:${server.address().port}` };
}

const PC = { id: 'dev-pc', name: '台式机', online: true, sameMachine: true, kind: 'desktop', client: { tier: 'control', version: '7.0.0', os: 'Windows 11' } };
const LAPTOP = { id: 'dev-lap', name: 'Laptop', online: true, sameMachine: false, kind: 'desktop', client: { tier: 'observe', version: '7.0.0', os: 'Windows 11' } };

test('没配 / 配错环境变量：通道不可用，错误说清缺什么', { timeout: 15_000 }, async () => {
  setEnv(undefined, undefined);
  assert.equal(deviceApiAvailable(), false);
  await assert.rejects(listDevices(), (e) => e instanceof DeviceError && e.code === 'NOT_CONFIGURED' && /BRIDGE_DEVICE_API/.test(e.message));

  // 只认回环：主机密钥不出本机（localhost 可被 hosts 改写，也不认）
  for (const api of ['http://localhost:8787', 'http://10.0.0.5:8787', 'https://127.0.0.1:8787', 'http://127.0.0.1:8787/x', 'http://127.0.0.1.evil.example:80']) {
    setEnv(api, SECRET);
    assert.equal(deviceApiAvailable(), false, api);
    await assert.rejects(desktopOp('cursor', {}, { by: 'codex' }), (e) => e.code === 'NOT_CONFIGURED' && /回环/.test(e.message), api);
  }
  setEnv('http://127.0.0.1:8787', 'short');
  assert.equal(deviceApiAvailable(), false);
  await assert.rejects(listDevices(), (e) => e.code === 'NOT_CONFIGURED' && /BRIDGE_DEVICE_SECRET/.test(e.message));

  setEnv('http://127.0.0.1:8787/', SECRET);
  assert.equal(deviceApiAvailable(), true, '末尾斜杠容忍');
  setEnv('http://[::1]:8787', SECRET);
  assert.equal(deviceApiAvailable(), true, 'IPv6 回环也认');
});

test('列设备：GET 内部接口、带主机密钥、不带请求体', { timeout: 15_000 }, async (t) => {
  let enabled = true;
  const bridge = await fakeBridge(t, {
    '/api/internal/devices': () => [200, { enabled, devices: enabled ? [PC, LAPTOP] : [] }],
  });
  setEnv(bridge.api, SECRET);
  assert.equal(deviceApiAvailable(), true);
  const list = await listDevices();
  assert.equal(list.enabled, true);
  assert.deepEqual(list.devices.map((d) => d.id), ['dev-pc', 'dev-lap']);
  assert.deepEqual(bridge.requests, [{ method: 'GET', url: '/api/internal/devices', auth: `Bearer ${SECRET}`, body: null }]);
  enabled = false;
  assert.deepEqual(await listDevices(), { enabled: false, devices: [] });
});

test('桌面动作：op=desktop，自动带 frameKey=by，超时按动作分档；device 省略就不传', { timeout: 15_000 }, async (t) => {
  const bridge = await fakeBridge(t, {
    '/api/internal/device-op': (req, body) => [200, { ok: true, device: { id: 'dev-pc', name: '台式机', tier: 'control' }, result: { echo: body.args.action } }],
  });
  setEnv(bridge.api, SECRET);
  const shot = await desktopOp('screenshot', { display: 0, frameKey: 'spoof' }, { device: '台式机', by: 'codex' });
  assert.deepEqual(shot, { device: { id: 'dev-pc', name: '台式机', tier: 'control' }, result: { echo: 'screenshot' } });
  await desktopOp('batch', { actions: [{ action: 'wait', ms: 10 }] }, { by: 'dimensio' });
  await desktopOp('wait_for_window', { query: '保存' }, { by: 'codex' });
  await desktopOp('uia_action', { uiaAction: 'invoke', ref: 3, value: '' }, { by: 'codex' });

  assert.ok(bridge.requests.every((r) => r.method === 'POST' && r.url === '/api/internal/device-op' && r.auth === `Bearer ${SECRET}`));
  const bodies = bridge.requests.map((r) => r.body);
  assert.deepEqual(bodies[0], {
    op: 'desktop', args: { display: 0, action: 'screenshot', frameKey: 'codex' }, timeoutMs: DESKTOP_TIMEOUT_MS, by: 'codex', device: '台式机',
  }, '调用方塞的 frameKey 不算数：坐标帧按 by 归属');
  assert.equal(bodies[1].timeoutMs, DESKTOP_SLOW_TIMEOUT_MS, 'batch 自带等待，超时放宽');
  assert.equal(bodies[1].args.frameKey, 'dimensio');
  assert.equal('device' in bodies[1], false, '没指定设备就交给 bridge 挑（恰好一台在线）');
  assert.equal(bodies[2].timeoutMs, DESKTOP_SLOW_TIMEOUT_MS, 'wait_for_window 同样放宽');
  assert.deepEqual(bodies[3].args, { uiaAction: 'invoke', ref: 3, value: '', action: 'uia_action', frameKey: 'codex' }, 'uia_action 的子动作放 uiaAction');
});

test('通用 op：参数原样转发，timeoutMs 夹在 1s～310s，by 默认 agent', { timeout: 15_000 }, async (t) => {
  const bridge = await fakeBridge(t, {
    '/api/internal/device-op': () => [200, { ok: true, device: { id: 'dev-pc', name: '台式机', tier: 'control' }, result: { exitCode: 0 } }],
  });
  setEnv(bridge.api, SECRET);
  const r = await deviceOp('shell', { command: 'echo hi' }, { device: 'dev-pc', timeoutMs: 999_999, by: 'codex' });
  assert.deepEqual(r.result, { exitCode: 0 });
  await deviceOp('fs.stat', { path: 'C:/x' }, { timeoutMs: 5 });
  assert.deepEqual(bridge.requests[0].body, { op: 'shell', args: { command: 'echo hi' }, timeoutMs: 310_000, by: 'codex', device: 'dev-pc' });
  assert.deepEqual(bridge.requests[1].body, { op: 'fs.stat', args: { path: 'C:/x' }, timeoutMs: 1000, by: 'agent' });
});

test('失败翻译：bridge / 设备的原话照给，再按设备自报的档位补一句怎么办', { timeout: 15_000 }, async (t) => {
  let reply = { ok: false, error: '当前是只观察模式，不能执行 click' };
  const bridge = await fakeBridge(t, {
    '/api/internal/devices': () => [200, { enabled: true, devices: [LAPTOP, { ...PC, online: false }] }],
    '/api/internal/device-op': () => [200, reply],
  });
  setEnv(bridge.api, SECRET);

  // observe 档 + 动手的动作：原话 + 去客户端改「控制」（名字不分大小写也认得出是哪台）
  await assert.rejects(desktopOp('click', { x: 1, y: 2 }, { device: 'laptop', by: 'codex' }), (e) =>
    e instanceof DeviceError && e.code === 'FAILED' && e.message.startsWith('当前是只观察模式') && /「只观察」档/.test(e.message) && /Laptop/.test(e.message));

  // 观察动作失败不扯档位（没指定设备 = 唯一在线的 Laptop）
  reply = { ok: false, error: '截图失败：安全桌面' };
  await assert.rejects(desktopOp('screenshot', {}, { by: 'codex' }), (e) => e.code === 'FAILED' && e.message === '截图失败：安全桌面');

  // 老客户端不认新动作
  reply = { ok: false, error: '未知桌面动作：zoom' };
  await assert.rejects(desktopOp('zoom', { region: [0, 0, 10, 10] }, { by: 'codex' }), (e) => /客户端版本较旧/.test(e.message) && /「zoom」/.test(e.message));

  // 设备离线：bridge 的原话已经够清楚，不再补
  reply = { ok: false, error: '设备「台式机」当前离线（桌面客户端没开，或对方关掉了「允许 agent 操作这台电脑」）。' };
  await assert.rejects(desktopOp('click', {}, { device: 'dev-pc', by: 'codex' }), (e) => e.message === reply.error);

  // 非桌面 op 的 ok:false：FAILED、原样
  reply = { ok: false, error: '你还没有可用的设备。' };
  await assert.rejects(deviceOp('shell', { command: 'x' }), (e) => e instanceof DeviceError && e.code === 'FAILED' && e.message === '你还没有可用的设备。');
  reply = { ok: false };
  await assert.rejects(deviceOp('shell', { command: 'x' }), (e) => e.code === 'FAILED' && /没给原因/.test(e.message));
});

test('传输层：404=密钥不对、5xx 带原话、连不上、超时、不跟跳转', { timeout: 20_000 }, async (t) => {
  const bridge = await fakeBridge(t, {
    '/api/internal/devices': () => [404, { error: 'not found' }],
    '/api/internal/device-op': () => [500, { error: 'boom' }],
  });
  setEnv(bridge.api, SECRET);
  await assert.rejects(listDevices(), (e) => e.code === 'REJECTED' && /主机密钥/.test(e.message));
  await assert.rejects(deviceOp('desktop', { action: 'cursor' }), (e) => e.code === 'HTTP' && /HTTP 500/.test(e.message) && /boom/.test(e.message));

  // 连不上：端口上没人
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(() => r()));
  setEnv(`http://127.0.0.1:${deadPort}`, SECRET);
  await assert.rejects(listDevices(), (e) => e.code === 'UNREACHABLE' && /连不上 bridge/.test(e.message));

  // 超时：按 timeoutMs + slack 放弃，不傻等
  const slow = await fakeBridge(t, {
    '/api/internal/device-op': () => new Promise((r) => setTimeout(() => r([200, { ok: true, result: {} }]), 3000)),
  });
  setEnv(slow.api, SECRET);
  const keep = timing.slackMs;
  timing.slackMs = 0;
  try {
    const t0 = Date.now();
    await assert.rejects(deviceOp('desktop', { action: 'cursor' }, { timeoutMs: 1000 }), (e) => e.code === 'TIMEOUT' && /超时/.test(e.message));
    assert.ok(Date.now() - t0 < 2500, `用了 ${Date.now() - t0}ms`);
  } finally { timing.slackMs = keep; }

  // 不跟跳转：主机密钥只发给配的那个地址
  const sink = await fakeBridge(t, { '/api/internal/devices': () => [200, { enabled: true, devices: [] }] });
  const hop = await fakeBridge(t, { '/api/internal/devices': () => [302, {}, { Location: sink.api + '/api/internal/devices' }] });
  setEnv(hop.api, SECRET);
  await assert.rejects(listDevices(), (e) => e instanceof DeviceError && e.code === 'UNREACHABLE');
  assert.equal(sink.requests.length, 0);
});
