// 「怎么连上它」：地址列表、启动日志几行（不含凭据）、探活与 server-info、配对票接口约定与终端配对流程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveDeployProfile, DEFAULTS_VERSION } from '../config/deploy-profile.mjs';
import {
  accessUrls, announceAccess, checkLanReachable, formatTicket, lanIPv4s, mintConnect, probe, renderQr, runPairing, serverInfo, startupLines, waitHealthy,
} from './access.mjs';

const NEW = { defaultsVersion: DEFAULTS_VERSION };
const server = resolveDeployProfile({ env: { BRIDGE_SUPERVISED: 'systemd' }, platform: 'linux', config: NEW });
const docker = resolveDeployProfile({ env: { BRIDGE_DEPLOY: 'docker' }, platform: 'linux', config: NEW });
const desktop = resolveDeployProfile({ env: {}, platform: 'win32', config: {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('局域网地址：只要 IPv4、去掉回环与 169.254，私网段排前面', () => {
  const ips = lanIPv4s({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '203.0.113.9', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    wlan0: [{ address: '192.168.1.20', family: 4, internal: false }],
    ll: [{ address: '169.254.3.3', family: 'IPv4', internal: false }],
  });
  assert.deepEqual(ips, ['192.168.1.20', '203.0.113.9']);
});

test('地址列表：只听本机时没有局域网；Docker 说宿主机端口映射；公网放最后', () => {
  const loop = accessUrls({ deploy: server, port: 8787, bindHost: '127.0.0.1', lan: ['192.168.1.20'] });
  assert.deepEqual(loop.map((u) => u.kind), ['local']);
  const wild = accessUrls({ deploy: server, port: 8787, bindHost: '0.0.0.0', lan: ['192.168.1.20'], publicOrigin: 'https://b.example.com/' });
  assert.deepEqual(wild.map((u) => u.url), ['http://127.0.0.1:8787', 'http://192.168.1.20:8787', 'https://b.example.com']);
  const one = accessUrls({ deploy: server, port: 8787, bindHost: '192.168.1.5' });
  assert.deepEqual(one.map((u) => u.url), ['http://127.0.0.1:8787', 'http://192.168.1.5:8787']);
  const dk = accessUrls({ deploy: docker, port: 8787, env: { BRIDGE_PUBLISH_PORT: '18787', BRIDGE_BIND: '0.0.0.0' } });
  assert.equal(dk[0].url, 'http://127.0.0.1:18787');
  assert.match(dk[1].url, /<这台服务器的局域网 IP>:18787/);
  assert.equal(accessUrls({ deploy: docker, port: 8787, env: {} }).length, 1, '默认只映射到宿主机 127.0.0.1');
});

test('启动日志：无界面形态打地址 / 令牌 / 配对；桌面形态只在首次启动提一句；不含任何凭据', () => {
  const env = { BRIDGE_CLI: 'sudo bridgectl' };
  const text = startupLines({ deploy: server, port: 8787, bindHost: '127.0.0.1', tokenHashOnly: true, env }).join('\n');
  assert.match(text, /接入  : 本机 http:\/\/127\.0\.0\.1:8787/);
  assert.match(text, /只听本机/);
  assert.match(text, /只存哈希/);
  assert.match(text, /sudo bridgectl pair/);
  assert.match(text, /sudo bridgectl access/);
  assert.deepEqual(startupLines({ deploy: desktop, port: 8787, bindHost: '0.0.0.0' }), []);
  assert.equal(startupLines({ deploy: desktop, port: 8787, bindHost: '0.0.0.0', fresh: true }).length, 1);
  assert.match(startupLines({ deploy: docker, port: 8787, env: { BRIDGE_CLI: 'docker compose exec bridge node src/cli.mjs' } }).join('\n'),
    /docker compose exec bridge node src\/cli\.mjs show-token/);
});

test('探活、等起来、server-info（带管理员令牌才给）', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    if (req.url === '/api/app/server-info' && req.headers.authorization === 'Bearer T') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ publicOrigin: 'https://q.trycloudflare.com', multiUser: false }));
      return;
    }
    res.writeHead(401); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.deepEqual(await probe(port), { up: true, status: 200 });
    assert.equal(await waitHealthy(port, { timeoutMs: 2000 }), true);
    assert.equal((await serverInfo(port, 'T')).publicOrigin, 'https://q.trycloudflare.com');
    assert.equal(await serverInfo(port, 'wrong'), null);
    assert.equal(await serverInfo(port, ''), null);
  } finally { await new Promise((r) => srv.close(r)); }
  assert.equal((await probe(port)).up, false);
  assert.equal(await waitHealthy(port, { timeoutMs: 500 }), false);
});

// 假的配对接口：按 routes/pair.mjs 的约定回票、长轮询、作废
const TICKET = (n) => ({ id: 'id' + n, code: '1234567' + n, codeText: '1234 567' + n, url: 'http://192.168.1.5:8787/?connect=id' + n + '.sec',
  origin: 'http://192.168.1.5:8787', reachable: true, expiresAt: Date.now() + 180_000 });
async function fakePair(script) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ route: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const step = script(req.url, calls.filter((c) => c.route === req.url).length, req.headers.authorization) || { status: 404 };
      res.writeHead(step.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(step.body || {}));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, calls, close: () => new Promise((r) => srv.close(r)) };
}

test('领票：按顺序试凭据（令牌不对就试主机密钥）；旧服务端回 unsupported；连不上回 down', async () => {
  const s = await fakePair((route, n, auth) => (route === '/api/pair/connect'
    ? (auth === 'Bearer host-secret' ? { body: TICKET(1) } : { status: 401, body: { error: '请先登录' } }) : null));
  try {
    const r = await mintConnect(s.port, ['', 'stale-token', 'host-secret']);
    assert.equal(r.ok, true);
    assert.equal(r.auth, 'host-secret');
    assert.equal(r.ticket.codeText, '1234 5671');
    assert.equal(s.calls.length, 2, '空凭据不发');
    assert.deepEqual(s.calls[0].body, { via: 'cli' });
    assert.equal((await mintConnect(s.port, ['stale-token'])).reason, 'unauthorized');
  } finally { await s.close(); }
  const old = await fakePair(() => ({ status: 404 }));
  try { assert.equal((await mintConnect(old.port, ['tok'])).reason, 'unsupported'); } finally { await old.close(); }
  assert.equal((await mintConnect(1, ['tok'])).reason, 'down');
});

test('领票带 origin（pair --origin=…）：交给服务端当码里的地址；runPairing 透传', async () => {
  const s = await fakePair((route) => (route === '/api/pair/connect' ? { body: TICKET(1) } : null));
  try {
    await mintConnect(s.port, ['T'], { origin: 'http://192.168.1.10:18787' });
    assert.deepEqual(s.calls[0].body, { via: 'cli', origin: 'http://192.168.1.10:18787' });
    await runPairing({ port: s.port, auths: ['T'], json: true, origin: 'http://192.168.1.10:18787', out: () => {}, err: () => {}, onSigint: () => {} });
    assert.deepEqual(s.calls[1].body, { via: 'cli', origin: 'http://192.168.1.10:18787' });
  } finally { await s.close(); }
});

test('终端配对：出码 → 等到已连接退出 0；过期自动换一张；--json 只打 JSON；作废了退 1', async () => {
  const run = async (script, opts = {}) => {
    const s = await fakePair(script);
    const out = [], err = [];
    try {
      const code = await runPairing({ port: s.port, auths: ['T'], cli: 'sudo bridgectl', out: (l) => out.push(l), err: (l) => err.push(l),
        onSigint: () => {}, qr: { ansi: false }, ...opts });
      return { code, text: out.join('\n'), err: err.join('\n'), calls: s.calls };
    } finally { await s.close(); }
  };
  let r = await run((route) => (route === '/api/pair/connect' ? { body: TICKET(1) }
    : route === '/api/pair/connect/wait' ? { body: { status: 'redeemed', device: 'Android · The Bridge App', ip: '192.168.1.9', kind: 'admin' } } : null));
  assert.equal(r.code, 0);
  assert.match(r.text, /配对码：1234 5671/);
  assert.match(r.text, /✓ 已连接：Android · The Bridge App（192\.168\.1\.9），以管理员身份登录/);
  assert.ok(r.calls.find((c) => c.route === '/api/pair/connect/wait').body.id === 'id1');

  r = await run((route, n) => (route === '/api/pair/connect' ? { body: TICKET(n) }
    : route === '/api/pair/connect/wait' ? { body: { status: n === 1 ? 'expired' : 'redeemed', device: 'iPhone' } } : null));
  assert.equal(r.code, 0);
  assert.match(r.text, /上一张过期了，换一张/);
  assert.match(r.text, /配对码：1234 5672/);

  r = await run((route) => (route === '/api/pair/connect' ? { body: TICKET(1) } : { body: { status: 'expired' } }), { once: true });
  assert.equal(r.code, 1);
  assert.match(r.text, /过期了；需要时运行 sudo bridgectl pair/);

  r = await run((route) => (route === '/api/pair/connect' ? { body: TICKET(1) } : null), { json: true });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.text).code, '12345671');

  r = await run((route) => (route === '/api/pair/connect' ? { body: TICKET(1) } : { body: { status: 'cancelled' } }));
  assert.equal(r.code, 1);
  assert.match(r.text, /被作废了/);

  r = await run(() => ({ status: 404 }));
  assert.equal(r.code, 1);
  assert.match(r.err, /还不支持扫码配对/);
});

test('码里的局域网地址把关：服务端只听本机时标「手机连不上」并说清怎么办；公网 / --origin / Docker 不探', async () => {
  const lanTicket = { ...TICKET(1), via: 'lan' };
  // 知道实际监听地址：回环 → 连不上；所有网卡 → 不动
  assert.equal((await checkLanReachable(lanTicket, { bindHost: '127.0.0.1' })).reachable, false);
  assert.equal((await checkLanReachable(lanTicket, { bindHost: '0.0.0.0' })).reachable, true);
  // 不知道（命令行）：本机探一下码里的地址
  const deadFetch = async () => { throw new Error('ECONNREFUSED'); };
  const okFetch = async () => ({ ok: true });
  const dead = await checkLanReachable(lanTicket, { fetchImpl: deadFetch });
  assert.equal(dead.reachable, false);
  assert.equal(dead.why, 'loopback');
  assert.equal((await checkLanReachable(lanTicket, { fetchImpl: okFetch })).reachable, true);
  for (const opts of [{ origin: 'http://192.168.1.10:8787' }, { docker: true }]) {
    assert.equal((await checkLanReachable(lanTicket, { ...opts, fetchImpl: deadFetch })).reachable, true);
  }
  assert.equal((await checkLanReachable({ ...TICKET(1), via: 'public' }, { fetchImpl: deadFetch })).reachable, true);
  const text = formatTicket(dead, { qr: { ansi: false }, cli: 'sudo bridgectl' });
  assert.match(text, /服务端只听本机（127\.0\.0\.1）/);
  assert.match(text, /--lan 重跑/);

  // runPairing 里接上了：服务端回 reachable:true、via:'lan'，本机探不通 → --json 里 reachable:false
  const s = await fakePair((route) => (route === '/api/pair/connect' ? { body: { ...TICKET(1), via: 'lan', origin: 'http://127.0.0.1:1' } } : null));
  try {
    const out = [];
    await runPairing({ port: s.port, auths: ['T'], json: true, out: (l) => out.push(l), err: () => {}, onSigint: () => {} });
    assert.equal(JSON.parse(out[0]).reachable, false);
  } finally { await s.close(); }
});

test('码里的地址手机连不上：打出票面与改法就退 1，不进等待、不换新码；--force-wait 照等', async () => {
  const unreachable = { ...TICKET(1), via: 'local', origin: 'http://127.0.0.1:8787', reachable: false };
  const script = (route) => (route === '/api/pair/connect' ? { body: unreachable }
    : route === '/api/pair/connect/wait' ? { body: { status: 'redeemed', device: 'iPhone' } } : null);
  let s = await fakePair(script);
  try {
    const out = [];
    const code = await runPairing({ port: s.port, auths: ['T'], cli: 'sudo bridgectl', out: (l) => out.push(l), err: () => {},
      onSigint: () => {}, qr: { ansi: false } });
    assert.equal(code, 1);
    const text = out.join('\n');
    assert.match(text, /配对码：1234 5671/, '票面照样打出来（App 里手填配对码仍可用）');
    assert.match(text, /手机连不上/);
    assert.match(text, /先不等了.*sudo bridgectl pair/);
    assert.doesNotMatch(text, /等待手机连接/);
    assert.equal(s.calls.filter((c) => c.route === '/api/pair/connect').length, 1, '不换新码');
    assert.equal(s.calls.filter((c) => c.route === '/api/pair/connect/wait').length, 0, '不进等待');
    assert.equal(s.calls.filter((c) => c.route === '/api/pair/connect/cancel').length, 0, '票不作废');
  } finally { await s.close(); }
  s = await fakePair(script);
  try {
    const code = await runPairing({ port: s.port, auths: ['T'], out: () => {}, err: () => {}, onSigint: () => {}, qr: { ansi: false }, forceWait: true });
    assert.equal(code, 0);
    assert.equal(s.calls.filter((c) => c.route === '/api/pair/connect/wait').length, 1);
  } finally { await s.close(); }
});

test('Ctrl+C：作废当前这张再退出 130', async () => {
  let sigint = null, exited = null;
  const s = await fakePair((route) => (route === '/api/pair/connect' ? { body: TICKET(1) }
    : route === '/api/pair/connect/cancel' ? { body: { ok: true } } : null));
  try {
    const p = runPairing({ port: s.port, auths: ['T'], out: () => {}, err: () => {}, qr: { ansi: false },
      onSigint: (fn) => { sigint = fn; }, exit: (c) => { exited = c; } });
    await sleep(300);
    await sigint();
    assert.equal(exited, 130);
    assert.ok(s.calls.some((c) => c.route === '/api/pair/connect/cancel' && c.body.id === 'id1'));
    void p;
  } finally { await s.close(); }
});

test('终端二维码：带颜色时每行收尾复位、留白是白色；不带颜色走 runtime/qr.mjs 的字符画；票面写全', () => {
  const ansi = renderQr('https://example.com/?connect=abc', { ansi: true }).split('\n');
  assert.ok(ansi.every((l) => l.endsWith('\x1b[0m')));
  assert.ok(ansi[0].includes('\x1b[97;107m'));
  const plain = renderQr('https://example.com/?connect=abc', { ansi: false });
  assert.ok(!plain.includes('\x1b['));
  assert.ok(/[█▀▄]/.test(plain));
  const t = formatTicket({ ...TICKET(1), reachable: false }, { qr: { ansi: false }, now: TICKET(1).expiresAt - 125_000 });
  assert.match(t, /配对码：1234 5671/);
  assert.match(t, /2 分 5 秒后过期/);
  assert.match(t, /手机连不上/);
  const dk = formatTicket({ ...TICKET(1), origin: 'http://127.0.0.1:8787', reachable: false }, { qr: { ansi: false }, docker: true, cli: 'docker compose exec bridge node src/cli.mjs' });
  assert.match(dk, /容器里看不到宿主机的地址/);
  assert.match(dk, /docker compose exec bridge node src\/cli\.mjs pair --origin=http:\/\/<这台机器的局域网 IP>:<端口>/);
  assert.ok(!formatTicket(TICKET(1), { qr: { ansi: false }, docker: true }).includes('注意'), '连得上就不提示');
});

test('首次启动的前台终端才自己出码；日志（非终端）、非首次、BRIDGE_PAIR_BANNER=0、NO_AUTH 都只打几行或不打', async () => {
  const s = await fakePair((route) => (route === '/api/pair/connect' ? { body: TICKET(9) } : null));
  try {
    const go = (opts) => { const out = []; announceAccess({ deploy: server, port: s.port, bindHost: '127.0.0.1', token: 'SECRET-TOKEN-XYZ', log: (l) => out.push(l), delayMs: 10, env: { NO_COLOR: '1' }, ...opts }); return out; };
    const notty = go({ fresh: true, stdout: { isTTY: false } });
    const later = go({ fresh: false, stdout: { isTTY: true } });
    const off = go({ fresh: true, stdout: { isTTY: true }, env: { BRIDGE_PAIR_BANNER: '0' } });
    const tty = go({ fresh: true, stdout: { isTTY: true } });
    const none = go({ fresh: true, stdout: { isTTY: true }, noAuth: true });
    await sleep(400);
    assert.equal(s.calls.length, 1, '只有首次 + 终端那一次领了票');
    assert.deepEqual(s.calls[0].body, { via: 'terminal' });
    assert.match(tty.join('\n'), /配对码：1234 5679/);
    assert.ok(!tty.join('\n').includes('\x1b['), 'NO_COLOR 时不带转义');
    for (const o of [notty, later, off]) assert.ok(!o.join('\n').includes('配对码：'));
    assert.equal(none.length, 0);
    assert.ok(notty.every((l) => !l.includes('SECRET-TOKEN-XYZ')), '日志里没有令牌');
  } finally { await s.close(); }
});
