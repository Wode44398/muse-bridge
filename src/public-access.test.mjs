// 公网访问（runtime/public-access.mjs）的契约：四种模式、cloudflared 托管（起停 / 退避重拉 / 先接后拆）、
// 看门狗（/ready 连续失败才重启、本机端口不通不动隧道）、令牌永不回显、维护者的个人脚本在位时锁住、
// NO_AUTH 不许挂公网、远程经隧道进来时不许把自己关在门外；以及管理接口 /api/admin/public-access 与 R2。
// cloudflared 用一个假的 node 脚本代替（打印 trycloudflare 地址 / 命名隧道的 ingress 行，起一个 /ready 回环端口）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-public-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
delete process.env.BRIDGE_CLOUDFLARED;

const pa = await import('./runtime/public-access.mjs');

// —— 假 cloudflared ————————————————————————————————————————————————————————
// 行为由环境变量 / 控制文件决定：FAKE_DIE_MS 多久后自己退出；<控制文件> 存在 = /ready 回 503。
const FAKE = path.join(tmp, 'fake-cloudflared.mjs');
writeFileSync(FAKE, `
import http from 'node:http';
import { existsSync } from 'node:fs';
const a = process.argv.slice(2);
const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : ''; };
const [, mport] = arg('--metrics').split(':');
const ctl = process.env.FAKE_CTL || '';
http.createServer((q, r) => { const bad = ctl && existsSync(ctl); r.writeHead(q.url === '/ready' && !bad ? 200 : 503); r.end(); }).listen(Number(mport), '127.0.0.1');
const say = (s) => process.stderr.write(new Date().toISOString() + ' INF ' + s + '\\n');
if (a.includes('--url')) {
  setTimeout(() => say('|  https://' + (process.env.FAKE_NAME || 'fake-' + process.pid) + '.trycloudflare.com  |'), 150);
} else {
  const tok = process.env.TUNNEL_TOKEN || '';
  if (tok.startsWith('eyJbad')) { say('Provided Tunnel token is not valid'); process.exit(1); }
  setTimeout(() => say('Updated to new configuration config="{\\\\"ingress\\\\":[{\\\\"hostname\\\\":\\\\"*.example.com\\\\"},{\\\\"hostname\\\\":\\\\"bridge.example.com\\\\", \\\\"service\\\\":\\\\"http://localhost:8787\\\\"}]}" version=1 token=' + tok), 150);
}
if (process.env.FAKE_DIE_MS) setTimeout(() => process.exit(3), Number(process.env.FAKE_DIE_MS));
setInterval(() => {}, 1 << 30);
`);

const TOKEN_A = 'eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwtYSIsInMiOiJzZWNyZXQtYWFhYWFhYWFhYWFhYWFhYWEifQ==';
const TOKEN_B = 'eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwtYiIsInMiOiJzZWNyZXQtYmJiYmJiYmJiYmJiYmJiYmIifQ==';
const TOKEN_BAD = 'eyJbad' + 'x'.repeat(60);

const live = new Set();
test.after(() => { for (const m of live) { try { m.dispose(); } catch {} } });

// 本机的「服务端」（看门狗拿它判本机端口通不通）
const local = http.createServer((q, r) => { r.writeHead(200); r.end('ok'); });
await new Promise((r) => local.listen(0, '127.0.0.1', r));
test.after(() => local.close());
const PORT = local.address().port;

let n = 0;
// pubOk.v：true = 公网探针回 200；false = 回 530（Cloudflare 边缘找不到隧道）；数字 = 回这个状态码；Error = 抛出（本机探不通）
// probes.n：公网探针打了几次。extra.timing 只覆盖给出的那几项。
function make(extra = {}) {
  const dataRoot = path.join(tmp, 'd' + (++n));
  mkdirSync(dataRoot, { recursive: true });
  const origins = [];
  const events = [];
  const pubOk = { v: true };
  const probes = { n: 0 };
  const { timing, ...rest } = extra;
  const m = pa.createPublicAccess({
    dataRoot, programRoot: dataRoot, port: PORT, external: null,
    binOverride: process.execPath, binArgsPrefix: [FAKE],
    isOurProcess: async () => false,
    setOrigin: (u) => origins.push(u), publish: (e) => events.push(e), log: () => {},
    fetch: async () => {
      probes.n++;
      if (pubOk.v instanceof Error) throw pubOk.v;
      return { status: typeof pubOk.v === 'number' ? pubOk.v : pubOk.v ? 200 : 530, arrayBuffer: async () => new ArrayBuffer(0) };
    },
    timing: { checkMs: 150, fastCheckMs: 100, probeMs: 1000, publicProbeMs: 1000, graceMs: { quick: 0, token: 0 }, cooldownMs: 0, backoff: [80, 80], stableMs: 60_000, switchWaitMs: { quick: 5000, token: 5000 }, announceMs: 200, ...(timing || {}) },
    ...rest,
  });
  live.add(m);
  return { m, dataRoot, origins, events, pubOk, probes };
}
const until = async (fn, ms = 6000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await new Promise((r) => setTimeout(r, 40)); } };

test('纯函数：令牌提取、地址规整、日志解析、平台资产', () => {
  assert.equal(pa.extractTunnelToken('cloudflared.exe service install ' + TOKEN_A), TOKEN_A);
  assert.equal(pa.extractTunnelToken('cloudflared tunnel run --token ' + TOKEN_A + '  '), TOKEN_A);
  assert.equal(pa.extractTunnelToken('不是令牌'), '');
  assert.equal(pa.normalizeOrigin('bridge.example.com/'), 'https://bridge.example.com');
  assert.equal(pa.normalizeOrigin('http://10.0.0.2:8787/app?x=1'), 'http://10.0.0.2:8787');
  assert.equal(pa.normalizeOrigin('ftp://x'), null);
  assert.equal(pa.normalizeOrigin(''), '');
  assert.equal(pa.parseQuickUrl('INF |  https://Abc-Def.trycloudflare.com  |'), 'https://abc-def.trycloudflare.com');
  assert.equal(pa.parseQuickUrl('Requesting new quick Tunnel on https://api.trycloudflare.com...'), '');
  assert.equal(pa.parseIngressHost('Updated to new configuration config="{\\"ingress\\":[{\\"hostname\\":\\"*.a.com\\"},{\\"hostname\\":\\"b.a.com\\"}]}"'), 'b.a.com');
  assert.equal(pa.classifyCfLine('ERR Provided Tunnel token is not valid'), 'badToken');
  assert.equal(pa.classifyCfLine('no free edge addresses left to resolve to'), 'edge');
  assert.equal(pa.cfAsset('win32', 'x64').name, 'cloudflared-windows-amd64.exe');
  assert.equal(pa.cfAsset('win32', 'arm64').name, 'cloudflared-windows-amd64.exe');
  assert.equal(pa.cfAsset('linux', 'arm64').name, 'cloudflared-linux-arm64');
  assert.equal(pa.cfAsset('darwin', 'arm64'), null);
  for (const p of ['win32-x64', 'win32-ia32', 'linux-x64', 'linux-arm64', 'linux-arm', 'linux-ia32']) {
    const [pl, ar] = p.split('-');
    assert.match(pa.cfAsset(pl, ar).sha256, /^[0-9a-f]{64}$/);
  }
});

test('quick：起隧道、拿到地址就换运行态对外地址并推总线；关掉收进程、恢复配置地址', async () => {
  const { m, origins, events } = make();
  await m.init();
  assert.equal(m.status().mode, 'off');
  const r = await m.apply({ mode: 'quick' });
  assert.equal(r.ok, true);
  assert.deepEqual(m.status().lastProbe, { at: 0, ok: false, ms: 0, error: '' }, '还没探过：契约要求是对象，at=0 当占位');
  const s = await until(() => { const x = m.status(); return x.status === 'running' && x.lastProbe.at && x; });
  assert.ok(s, '应该跑起来、并且探过一次公网');
  assert.match(s.url, /^https:\/\/fake-\d+\.trycloudflare\.com$/);
  assert.equal(origins.at(-1), s.url);
  assert.ok(events.some((e) => e.type === 'public-access' && e.url === s.url && e.status === 'running'));
  assert.ok(s.lastProbe && s.lastProbe.ok);
  assert.equal(s.cloudflared.available, true);
  const proc = m._state().cur.proc;
  await m.apply({ mode: 'off' });
  assert.equal(m.status().status, 'stopped');
  assert.equal(origins.at(-1), null, '关掉后恢复配置里的对外地址');
  await until(() => proc.exitCode !== null || proc.signalCode !== null);
  assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'cloudflared 已收掉');
});

test('重启快速隧道也先接后拆：新地址连上后先推 public-access.next（旧的还活着），留一会儿再拆旧的（S1-1）', async () => {
  // 等待都给足：全量测试负载下假 cloudflared 起得慢，6 秒的默认等待会超时（until 超时回的是假值，s0.url 就成了 undefined）；
  // 先接后拆的窗口也放宽，免得轮询还没看到 next 就已经转正（都是偶发失败）
  const { m, events, origins } = make({ timing: { announceMs: 4000 } });
  await m.init();
  await m.apply({ mode: 'quick' });
  const s0 = await until(() => { const x = m.status(); return x.status === 'running' && x.url && x; }, 30_000);
  assert.ok(s0, '快速隧道先跑起来');
  const old = m._state().cur;
  const p = m.restart();
  const nextEv = await until(() => events.find((e) => e.type === 'public-access.next'), 30_000);
  assert.ok(nextEv, '新地址连上后先推一条 next');
  assert.match(nextEv.url, /^https:\/\/fake-\d+\.trycloudflare\.com$/);
  assert.notEqual(nextEv.url, s0.url);
  assert.equal(nextEv.from, s0.url);
  assert.equal(old.alive(), true, '推 next 的时候旧隧道还在（经它连着的设备收得到）');
  assert.equal(m.status().url, s0.url, '还没转正：对外地址仍是旧的');
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(m.status().url, nextEv.url, '转正后对外地址换成新的');
  assert.equal(origins.at(-1), nextEv.url);
  await until(() => !old.alive(), 30_000);
  assert.equal(old.alive(), false, '留够时间后旧隧道拆掉');
  await m.apply({ mode: 'off' });
});

test('换成命名隧道（地址要变）：新隧道连上后先推新地址，再拆旧的快速隧道', async () => {
  const { m, events } = make();
  await m.init();
  await m.apply({ mode: 'quick' });
  await until(() => m.status().status === 'running' && m.status().url);
  const r = await m.apply({ mode: 'token', token: TOKEN_A, url: 'https://mine.example.org' });
  assert.equal(r.ok, true);
  const nx = events.filter((e) => e.type === 'public-access.next');
  assert.equal(nx.at(-1)?.url, 'https://mine.example.org');
  assert.equal(m.status().url, 'https://mine.example.org');
  // 同一个命名隧道重启：地址不变，不推 next
  const before = events.filter((e) => e.type === 'public-access.next').length;
  await m.restart();
  assert.equal(events.filter((e) => e.type === 'public-access.next').length, before);
  await m.apply({ mode: 'off' });
});

test('token：令牌只进环境变量与 0600 配置文件，任何状态 / 日志都不回显；对外地址从 ingress 认出来', async () => {
  const { m, dataRoot } = make();
  await m.init();
  const r = await m.apply({ mode: 'token', token: 'cloudflared service install ' + TOKEN_A });
  assert.equal(r.ok, true);
  const s = await until(() => { const x = m.status(); return x.status === 'running' && x.url && x; });
  assert.equal(s.url, 'https://bridge.example.com', '取第一个非通配主机名');
  assert.equal(s.hasToken, true);
  const dump = JSON.stringify(m.status());
  assert.ok(!dump.includes(TOKEN_A), '状态里不能有令牌');
  assert.ok(m.status().log.some((l) => l.includes('token=***')), '日志里的令牌被抹掉');
  const saved = JSON.parse(readFileSync(path.join(dataRoot, 'public-access.json'), 'utf8'));
  assert.equal(saved.token, TOKEN_A);
  assert.ok(!m._state().cur.proc.spawnargs.join(' ').includes(TOKEN_A), '令牌不进进程参数');
  // 命名隧道：服务端重启后还是同一个域名，经它远程连着的照样能重启服务端
  assert.equal(m.selfCutReason({}, { host: 'bridge.example.com', server: true }), '');
  // 手填的对外地址优先
  await m.apply({ mode: 'token', url: 'https://my.example.org' });
  assert.equal(m.status().url, 'https://my.example.org');
  await m.apply({ mode: 'off' });
});

test('换令牌先接后拆：新令牌连不上就保留旧隧道、配置退回；连得上才拆旧的', async () => {
  const { m, dataRoot } = make();
  await m.init();
  await m.apply({ mode: 'token', token: TOKEN_A });
  await until(() => m.status().status === 'running');
  const old = m._state().cur;
  const bad = await m.apply({ mode: 'token', token: TOKEN_BAD });
  assert.match(bad.error, /令牌无效|没连上/);
  assert.equal(m._state().cur, old, '旧隧道还是当前隧道');
  assert.ok(old.alive());
  assert.equal(JSON.parse(readFileSync(path.join(dataRoot, 'public-access.json'), 'utf8')).token, TOKEN_A, '配置退回旧令牌');
  const ok = await m.apply({ mode: 'token', token: TOKEN_B });
  assert.equal(ok.ok, true);
  assert.notEqual(m._state().cur, old);
  await until(() => !old.alive());
  assert.equal(old.alive(), false, '新的连上后旧的被拆');
  await m.apply({ mode: 'off' });
});

test('意外退出按退避重拉', async () => {
  process.env.FAKE_DIE_MS = '300';
  const { m } = make();
  try {
    await m.init();
    await m.apply({ mode: 'quick' });
    const first = m._state().cur;
    const again = await until(() => m._state().cur && m._state().cur !== first && m._state().cur.alive());
    assert.ok(again, '退出后重新拉起');
    assert.ok(m.status().restarts >= 1);
  } finally {
    delete process.env.FAKE_DIE_MS;
    await m.apply({ mode: 'off' });
  }
});

test('看门狗：/ready 连续失败才重启隧道；本机端口不通时不动隧道', async () => {
  const ctl = path.join(tmp, 'ready-bad');
  process.env.FAKE_CTL = ctl;
  const { m } = make();
  try {
    await m.init();
    await m.apply({ mode: 'token', token: TOKEN_A });
    await until(() => m.status().status === 'running');
    const first = m._state().cur;
    writeFileSync(ctl, '1');
    const swapped = await until(() => m._state().cur && m._state().cur !== first);
    assert.ok(swapped, '/ready 连续失败后重启了隧道');
  } finally {
    try { (await import('node:fs')).rmSync(ctl, { force: true }); } catch {}
    await m.apply({ mode: 'off' });
  }
  // 本机端口拒连：看门狗不动隧道
  writeFileSync(ctl, '1');
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port; await new Promise((r) => dead.close(r));
  const { m: m2 } = make({ port: deadPort });
  try {
    await m2.init();
    await m2.apply({ mode: 'token', token: TOKEN_A });
    const first = m2._state().cur;
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(m2._state().cur, first, '本机端口不通时不重启隧道');
    assert.ok(m2.status().log.some((l) => l.includes('问题不在隧道')));
  } finally {
    (await import('node:fs')).rmSync(ctl, { force: true });
    delete process.env.FAKE_CTL;
    await m2.apply({ mode: 'off' });
  }
});

test('manual：只探活不起进程；探不通给人话', async () => {
  const { m, origins, pubOk } = make();
  await m.init();
  assert.match((await m.apply({ mode: 'manual' })).error, /对外地址/);
  assert.match((await m.apply({ mode: 'manual', url: 'ftp://x' })).error, /对外地址不对/);
  await m.apply({ mode: 'manual', url: 'bridge.example.net' });
  assert.equal(origins.at(-1), 'https://bridge.example.net');
  assert.equal(m._state().cur, null);
  assert.ok(await until(() => m.status().status === 'running'));
  pubOk.v = false;
  await m.restart();
  assert.ok(await until(() => m.status().status === 'error'));
  assert.match(m.status().hint, /打不开 https:\/\/bridge\.example\.net/);
  await m.apply({ mode: 'off' });
});

test('维护者的个人脚本在位：锁住 quick / token / manual，按 off 报；NO_AUTH 一律不许', async () => {
  const pr = path.join(tmp, 'boss');
  mkdirSync(pr, { recursive: true });
  writeFileSync(path.join(pr, 'admin.ps1'), '');
  writeFileSync(path.join(pr, 'task-tunnel.vbs'), '');
  const { m, origins } = make({ external: undefined, programRoot: pr, platform: 'win32' });
  await m.init();
  assert.equal(m.status().managedBy?.kind, 'script');
  assert.match((await m.apply({ mode: 'quick' })).error, /由本机脚本（admin\.ps1 \/ task-tunnel\.vbs）托管/);
  // 手填的对外地址也不行：它会持久覆盖运行态的 PUBLIC_ORIGIN（设备拿到的地址、分享链接、扫码登录）
  assert.match((await m.apply({ mode: 'manual', url: 'https://other.example.com' })).error, /对外地址由本机脚本/);
  assert.ok(!origins.includes('https://other.example.com'));
  assert.equal(m.status().mode, 'off');
  assert.match(m.status().hint, /由本机脚本（admin\.ps1 \/ task-tunnel\.vbs）托管/);
  assert.equal(m._state().cur, null);
  // 锁住之前就存过「自己的域名」：启动时也不拿它覆盖对外地址，按 off 报
  const pre = make({ external: undefined, programRoot: pr, platform: 'win32' });
  writeFileSync(path.join(pre.dataRoot, 'public-access.json'), JSON.stringify({ mode: 'manual', token: '', url: 'https://saved.example.com' }));
  await pre.m.init();
  assert.equal(pre.m.status().mode, 'off');
  assert.ok(!pre.origins.includes('https://saved.example.com'), '存着的手填地址不生效');
  assert.match((await pre.m.restart()).error, /托管/);
  const { m: na } = make({ noAuth: true });
  await na.init();
  assert.match((await na.apply({ mode: 'quick' })).error, /调试实例/);
  assert.equal(na.status().available, false);
});

test('远程经隧道进来：不许关掉 / 换掉正在用的隧道；本机直连不受限', async () => {
  const { m } = make();
  await m.init();
  await m.apply({ mode: 'quick' });
  const s = await until(() => { const x = m.status(); return x.url && x; });
  const host = new URL(s.url).host;
  assert.match(m.selfCutReason({ mode: 'off' }, { host }), /关在门外/);
  assert.match(m.selfCutReason({ mode: 'manual', url: 'x.com' }, { host }), /关在门外/);
  assert.match(m.selfCutReason({}, { host, restart: true }), /新地址/);
  // 服务端重启 / 更新：cloudflared 跟着收掉、新进程再申请，临时地址必变
  assert.match(m.selfCutReason({}, { host, server: true }), /服务端一重启/);
  assert.equal(m.selfCutReason({}, { host, server: true, local: true }), '', '本机直连照常能重启');
  assert.equal(m.selfCutReason({}, { host: '192.168.1.5:8787', server: true }), '', '经局域网连着的不受影响');
  // → 命名隧道：先接后拆，新的一连上旧的快速隧道就拆了——得事先知道新地址
  assert.match(m.selfCutReason({ mode: 'token', token: TOKEN_A }, { host }), /还不知道新的对外地址/);
  assert.match(m.selfCutReason({ mode: 'token', token: TOKEN_A, url: '' }, { host }), /还不知道新的对外地址/);
  assert.equal(m.selfCutReason({ mode: 'token', token: TOKEN_A, url: 'bridge.example.com' }, { host }), '', '填了对外地址就放行');
  assert.equal(m.selfCutReason({ mode: 'off' }, { host, local: true }), '');
  assert.equal(m.selfCutReason({ mode: 'off' }, { host: '192.168.1.5:8787' }), '', '不是经这条隧道来的');
  await m.apply({ mode: 'off' });
});

test('看门狗：快速隧道本机探不通（解析失败 / 超时）不换地址、给人话；Cloudflare 连续回 530 才换', async () => {
  const { m, pubOk } = make({ timing: { quickPublicFails: 3 } });
  try {
    await m.init();
    await m.apply({ mode: 'quick' });
    assert.ok(await until(() => { const x = m.status(); return x.status === 'running' && x.lastProbe.ok; }));
    const first = m._state().cur;
    // 本机经公网探自己不通（fake-ip / TUN、DNS 负缓存）：外面可能好好的，不动隧道
    pubOk.v = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    assert.ok(await until(() => m.status().lastProbe.error === '域名解析失败'));
    await new Promise((r) => setTimeout(r, 1200));   // 远超 3 次探活
    assert.equal(m._state().cur, first, '本机探不通不换地址');
    assert.equal(m.status().status, 'running');
    assert.match(m.status().hint, /从这台机器经公网打不开 .*域名解析失败/);
    // 回了别的状态码（边缘认得这条隧道，比如 502）同样不换
    pubOk.v = 502;
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(m._state().cur, first, '502 不换地址');
    // Cloudflare 边缘明确说找不到这条隧道：连续几次才换一个临时地址
    pubOk.v = false;
    const swapped = await until(() => m._state().cur && m._state().cur !== first);
    assert.ok(swapped, '连续 530 后换了地址');
    assert.ok(m.status().log.some((l) => l.includes('找不到这条隧道')));
  } finally {
    pubOk.v = true;
    await m.apply({ mode: 'off' });
  }
});

test('看门狗：宽限期内不打公网探针（免得系统 DNS 把新域名的「不存在」缓存下来）', async () => {
  const { m, probes } = make({ timing: { graceMs: { quick: 60_000, token: 60_000 } } });
  try {
    await m.init();
    await m.apply({ mode: 'quick' });
    assert.ok(await until(() => m.status().status === 'running'), '宽限期里 /ready 通、拿到地址就算跑起来了');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(probes.n, 0, '宽限期内一次公网探针都没打');
    assert.equal(m.status().lastProbe.at, 0);
  } finally {
    await m.apply({ mode: 'off' });
  }
});

test('看门狗：本机端口按监听地址探（BRIDGE_HOST 是具体地址时 127.0.0.1 上没人，不能因此永远不自愈）', async (t) => {
  // 服务端只听 127.0.0.2（模拟 BRIDGE_HOST=某个具体地址）：同端口的 127.0.0.1 恒拒连
  const only = http.createServer((q, r) => { r.writeHead(200); r.end('ok'); });
  try { await new Promise((res, rej) => { only.once('error', rej); only.listen(0, '127.0.0.2', res); }); }
  catch { t.skip('这台机器不能监听 127.0.0.2'); return; }
  const p = only.address().port;
  const ctl = path.join(tmp, 'ready-bad-host');
  process.env.FAKE_CTL = ctl;
  const { m } = make({ port: p, localTarget: 'http://127.0.0.2:' + p });
  try {
    await m.init();
    await m.apply({ mode: 'token', token: TOKEN_A });
    await until(() => m.status().status === 'running');
    const first = m._state().cur;
    writeFileSync(ctl, '1');
    const swapped = await until(() => m._state().cur && m._state().cur !== first);
    assert.ok(swapped, '/ready 连续失败、本机 127.0.0.2 端口是通的 → 重启隧道');
    assert.ok(!m.status().log.some((l) => l.includes('问题不在隧道')));
  } finally {
    (await import('node:fs')).rmSync(ctl, { force: true });
    delete process.env.FAKE_CTL;
    await m.apply({ mode: 'off' });
    only.close();
  }
});

// 先接后拆的等待期间旧隧道意外退出：不许按新配置另起一条没人跟踪的 cloudflared（审查复现过：dispose 后仍留孤儿）
async function raceRig(extra = {}) {
  const { spawn } = await import('node:child_process');
  const spawned = [];
  const ctl = path.join(tmp, 'ready-bad-race-' + (++n));
  process.env.FAKE_CTL = ctl;
  const rig = make({
    spawn: (...a) => { const p = spawn(...a); spawned.push(p); return p; },
    timing: { checkMs: 60_000, fastCheckMs: 60_000, ...(extra.timing || {}) },
  });
  const aliveProcs = () => spawned.filter((x) => x.exitCode === null && x.signalCode === null);
  return { ...rig, spawned, ctl, aliveProcs };
}

test('先接后拆：等新隧道期间旧的意外退出 → 不另起没人跟踪的隧道；转正后只剩一条，dispose 收干净', async () => {
  const { m, ctl, aliveProcs, dataRoot } = await raceRig();
  const fs = await import('node:fs');
  try {
    await m.init();
    await m.apply({ mode: 'quick' });
    await until(() => m._state().cur?.url);
    const old = m._state().cur;
    writeFileSync(ctl, '1');                              // 新隧道暂时连不上（/ready 503）
    const p = m.apply({ mode: 'token', token: TOKEN_A }); // 先接后拆：等新的连上
    await new Promise((r) => setTimeout(r, 600));
    old.proc.kill();                                      // 等待期间旧的意外退出
    await new Promise((r) => setTimeout(r, 1200));        // 退避（80ms）早该触发过了
    assert.equal(aliveProcs().length, 1, '只有在等的那条新隧道，没有按新配置另起的');
    fs.rmSync(ctl, { force: true });                      // 新隧道连上
    const r = await p;
    assert.equal(r.ok, true);
    const cur = m._state().cur;
    assert.equal(cur.mode, 'token');
    assert.deepEqual(aliveProcs().map((x) => x.pid), [cur.proc.pid], '转正后只剩当前这一条');
    assert.deepEqual(JSON.parse(readFileSync(path.join(dataRoot, 'public-access.pid'), 'utf8')).pids, [cur.proc.pid]);
    m.dispose();
    assert.ok(await until(() => aliveProcs().length === 0, 3000), 'dispose 之后没有孤儿');
  } finally {
    fs.rmSync(ctl, { force: true });
    delete process.env.FAKE_CTL;
    m.dispose();
  }
});

test('先接后拆：新的没连上、旧的也在等待期间退了 → 配置退回旧的、按旧配置重拉；dispose 也收在等的那条', async () => {
  const { m, ctl, aliveProcs, dataRoot } = await raceRig({ timing: { switchWaitMs: { quick: 1500, token: 1500 } } });
  const fs = await import('node:fs');
  try {
    await m.init();
    await m.apply({ mode: 'quick' });
    await until(() => m._state().cur?.url);
    const old = m._state().cur;
    writeFileSync(ctl, '1');
    const p = m.apply({ mode: 'token', token: TOKEN_A });
    await new Promise((r) => setTimeout(r, 400));
    old.proc.kill();
    const r = await p;
    assert.match(r.error, /原来的隧道也意外退出了/);
    assert.equal(JSON.parse(readFileSync(path.join(dataRoot, 'public-access.json'), 'utf8')).mode, 'quick', '配置退回旧的');
    fs.rmSync(ctl, { force: true });
    const back = await until(() => { const c = m._state().cur; return c && c !== old && c.alive() && c; });
    assert.ok(back, '按旧配置重新拉起');
    assert.equal(back.mode, 'quick');
    await until(() => aliveProcs().length === 1);
    assert.equal(aliveProcs().length, 1);
    // 再来一次先接后拆，等待中直接 dispose：在等的那条也要收掉
    writeFileSync(ctl, '1');
    const p2 = m.apply({ mode: 'token', token: TOKEN_A });
    await until(() => aliveProcs().length === 2);
    m.dispose();
    await p2;
    assert.ok(await until(() => aliveProcs().length === 0, 3000), 'dispose 收掉当前的与在等的');
  } finally {
    fs.rmSync(ctl, { force: true });
    delete process.env.FAKE_CTL;
    m.dispose();
  }
});

test('缺 cloudflared 时按平台下载并校验：哈希不对就丢弃给人话，对了就装上', async () => {
  const body = Buffer.from('fake-cloudflared-binary-'.repeat(1000));
  const good = { name: 'cf-test', size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const fetchBin = async () => ({ ok: true, status: 200, body: new Blob([body]).stream() });
  // 哈希不对
  const { m: bad, dataRoot: d1 } = make({ binOverride: '', binArgsPrefix: null, which: () => null, fetch: fetchBin, asset: { ...good, sha256: '0'.repeat(64) } });
  await bad.init();
  const r1 = await bad.apply({ mode: 'quick' });
  assert.equal(r1.ok, true, '下载在后台，请求不干等');
  await until(() => !bad.status().cloudflared.downloading && bad.status().status === 'error');
  assert.match(bad.status().hint, /SHA-256 校验不对/);
  assert.equal(existsSync(path.join(d1, '.bin', 'cloudflared-' + pa.CF_VERSION, process.platform === 'win32' ? 'cloudflared.exe.partial' : 'cloudflared.partial')), false, '半截文件已删');
  await bad.apply({ mode: 'off' });
  // 哈希对：装上（起进程会失败——假二进制不是程序——但可用性要对）
  const { m: ok, dataRoot: d2 } = make({ binOverride: '', binArgsPrefix: null, which: () => null, fetch: fetchBin, asset: good });
  await ok.init();
  await ok.apply({ mode: 'quick' });
  await until(() => ok.status().cloudflared.available);
  assert.equal(ok.status().cloudflared.available, true);
  assert.ok(existsSync(path.join(d2, '.bin', 'cloudflared-' + pa.CF_VERSION, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')));
  await ok.apply({ mode: 'off' });
});
