// Claude Code 运行组件的定位与首启下载（claude-cli.mjs）：
//   · 源码直跑（SDK 旁边有同版本平台包）：不给 SDK 传路径，行为同以前——本仓库自己就是这种布局，顺带验一遍；
//   · 平台包不在 / 版本不对：从下载源拿 npm 的平台包 tgz，流式解出可执行文件，按 manifest 的 sha256 与大小校验后落位
//     数据根，换源有记录；下次启动直接认数据根里那份（不再联网）；
//   · 校验不过、卡住不动：丢掉半截文件，状态如实报人话；发消息时抛 CLAUDE_CLI_NOT_READY（status.mjs 翻成错误卡片）；
//   · 按速度换源：给了 Content-Length 时进度按压缩包算；太慢换下一个源，后面的都不通再回到嫌慢的里面最快的那个；
//   · 下载不成时退而用本机任意版本（标明版本不一致）；没开自动下载（Muse Bridge 默认）且什么都没有 → missing，提示装 Claude Code；
//   · tar 解析经得起任意切块、pax 长路径头、目录条目。
// 下载源是本机假 registry；SDK、平台包、「可执行文件」都是临时目录里造的（MZ 开头的随机字节），不碰网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
const root = mkdtempSync(path.join(tmpdir(), 'claude-cli-'));
// 数据根先指到临时目录再导入（paths.mjs 导入时就定下数据根；错误卡片那条要导入 status.mjs → config/index.mjs）
const statusRoot = path.join(root, 'status');
mkdirSync(statusRoot, { recursive: true });
writeFileSync(path.join(statusRoot, 'config.json'), JSON.stringify({ token: 'test-token-0123456789abcdef0123456789' }));
const prevRoot = process.env.BRIDGE_DATA_ROOT;
process.env.BRIDGE_DATA_ROOT = statusRoot;
test.after(() => {
  if (prevRoot === undefined) delete process.env.BRIDGE_DATA_ROOT; else process.env.BRIDGE_DATA_ROOT = prevRoot;
  rmSync(root, { recursive: true, force: true });
});
const { createClaudeCli, extractTarEntry, isNativeExe, notReadyError, platformKeys, sdkInfo } = await import('./claude-cli.mjs');

// ── 假 registry：path → (req, res) ──（顶层 await 都放在第一个 test 之前：中途再 await，根测试的 after 会提前跑）
const routes = new Map();
const reg = http.createServer((req, res) => {
  const h = routes.get(req.url);
  if (!h) { res.writeHead(404); res.end('not found'); return; }
  h(req, res);
});
await new Promise((ok) => reg.listen(0, '127.0.0.1', ok));
test.after(() => { reg.close(); reg.closeAllConnections(); });
const REG = `http://127.0.0.1:${reg.address().port}`;

// ── tar 造包 ──
function header(name, size, type) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data || '');
    if (e.pax) {
      const rec = (k, v) => { const body = ` ${k}=${v}\n`; let len = body.length + 1; while (String(len).length + body.length !== len) len = String(len).length + body.length; return Buffer.from(len + body); };
      const pax = rec('path', e.name);
      parts.push(header('PaxHeader', pax.length, 'x'), pax, pad(pax.length));
    }
    parts.push(header(e.pax ? 'short-name' : e.name, data.length, e.type || '0'), data, pad(data.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const fakeExe = (n) => Buffer.concat([Buffer.from('MZ'), randomBytes(n - 2)]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
function* chunks(buf) {
  let i = 0;
  while (i < buf.length) { const n = 1 + Math.floor(Math.random() * 700); yield buf.subarray(i, i + n); i += n; }
}

test('tar：任意切块、pax 长路径、目录条目都解得对', async () => {
  const bin = fakeExe(5000);
  const long = 'package/' + 'x'.repeat(120) + '/claude.exe';
  const tar = makeTar([
    { name: 'package/', type: '5' },
    { name: 'package/package.json', data: '{"name":"p"}' },
    { name: long, data: bin, pax: true },
    { name: 'package/README.md', data: 'readme' },
  ]);
  for (let round = 0; round < 5; round++) {
    const got = [];
    const found = await extractTarEntry(Readable.from(chunks(tar)), (n) => n === long, (b) => { got.push(Buffer.from(b)); });
    assert.equal(found, true);
    assert.ok(Buffer.concat(got).equals(bin));
  }
  const none = await extractTarEntry(Readable.from(chunks(tar)), (n) => n === 'package/nope', () => {});
  assert.equal(none, false);
});

// ── 假 SDK 布局 ──
function fakeSdk(name, { bundledVersion = null, cliVersion = '9.9.1', bin } = {}) {
  const nm = path.join(root, name, 'node_modules', '@anthropic-ai');
  const sdkDir = path.join(nm, 'claude-agent-sdk');
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(path.join(sdkDir, 'sdk.mjs'), 'export {};\n');
  if (bundledVersion) {
    const p = path.join(nm, 'claude-agent-sdk-win32-x64');
    mkdirSync(p, { recursive: true });
    writeFileSync(path.join(p, 'package.json'), JSON.stringify({ version: bundledVersion }));
    writeFileSync(path.join(p, 'claude.exe'), fakeExe(100));
  }
  return {
    main: path.join(sdkDir, 'sdk.mjs'), dir: sdkDir, version: '9.9.9', cliVersion,
    manifest: { version: cliVersion, platforms: { 'win32-x64': { binary: 'claude.exe', checksum: sha(bin), size: bin.length } } },
  };
}

const tgzPath = (base) => `/${base}/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-9.9.9.tgz`;
const quiet = () => {};
const base = (dataRoot, sdk, extra = {}) => ({
  // Muse Bridge 默认不下载：测下载路径的用例显式打开（BRIDGE_CLAUDE_CLI_DOWNLOAD=1）
  dataRoot, sdk, keys: ['win32-x64'], env: { BRIDGE_CLAUDE_CLI_DOWNLOAD: '1' }, config: () => ({}), localExact: () => null, localAny: () => [], log: quiet, ...extra,
});

test('源码直跑：SDK 旁边有同版本平台包 → 不传路径（SDK 自己找）', async () => {
  const sdk = fakeSdk('direct', { bundledVersion: '9.9.9', bin: fakeExe(64) });
  const cli = createClaudeCli(base(path.join(root, 'd0'), sdk, { fetch: () => { throw new Error('不该联网'); } }));
  await cli.init();
  const st = cli.status();
  assert.equal(st.state, 'ready');
  assert.equal(st.source, 'sdk');
  assert.deepEqual(cli.options(), {});
  assert.match(cli.binPath(), /claude-agent-sdk-win32-x64[\\/]claude\.exe$/);
});

test('本仓库的真 SDK：平台包在、版本对得上 → 走 SDK 自带的（正式服行为不变）', () => {
  const info = sdkInfo();
  assert.ok(info && info.version && info.cliVersion, 'sdkInfo');
  const key = platformKeys()[0];
  assert.ok(info.manifest?.platforms?.[key]?.checksum, 'manifest 里有本平台：' + key);
  const cli = createClaudeCli({ dataRoot: path.join(root, 'real'), env: {}, config: () => ({}), log: quiet, fetch: () => { throw new Error('不该联网'); } });
  assert.equal(cli.status().source, 'sdk');
  assert.deepEqual(cli.options(), {});
  assert.ok(isNativeExe(cli.binPath()));
});

test('没有平台包：从下载源拿、校验、落位数据根；换源有记录；下次启动不再联网', async () => {
  const bin = fakeExe(300_000);
  const sdk = fakeSdk('dl', { bundledVersion: '9.0.0', bin });   // 版本不对的旧平台包不算
  routes.set(tgzPath('good'), (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(gzipSync(makeTar([{ name: 'package/package.json', data: '{}' }, { name: 'package/claude.exe', data: bin }, { name: 'package/LICENSE.md', data: 'x' }])));
  });
  const dataRoot = path.join(root, 'd1');
  let fetches = 0;
  const cli = createClaudeCli(base(dataRoot, sdk, { registries: [REG + '/missing', REG + '/good'], fetch: (...a) => { fetches++; return fetch(...a); } }));
  assert.throws(() => cli.options(), (e) => e.code === 'CLAUDE_CLI_NOT_READY');   // 刚开始下
  await cli.ensure({ force: true });
  const st = cli.status();
  assert.equal(st.state, 'ready', JSON.stringify(st));
  assert.equal(st.source, 'download');
  assert.equal(st.version, '9.9.1');
  assert.deepEqual(st.attempts.map((a) => [a.host.endsWith(String(reg.address().port)), a.error && a.error.replace(/（.*）$/, '')]), [[true, '下载源上没有 Claude Code 运行组件 claude-agent-sdk-win32-x64@9.9.9'], [true, null]]);
  const p = cli.options().pathToClaudeCodeExecutable;
  assert.ok(p.startsWith(path.join(dataRoot, '.bin', 'claude-code', '9.9.1-win32-x64')));
  assert.ok(readFileSync(p).equals(bin));
  const stamp = JSON.parse(readFileSync(path.join(path.dirname(p), 'install.json'), 'utf8'));
  assert.equal(stamp.sha256, sha(bin));
  assert.equal(readdirSync(path.dirname(p)).filter((n) => n.endsWith('.part')).length, 0);
  // 重启：直接认数据根里那份
  const n = fetches;
  const again = createClaudeCli(base(dataRoot, sdk, { registries: [REG + '/good'], fetch: () => { fetches++; throw new Error('不该联网'); } }));
  await again.init();
  assert.equal(again.status().source, 'download');
  assert.equal(fetches, n);
});

test('校验不过：丢掉半截文件、报人话；发消息抛 CLAUDE_CLI_NOT_READY，错误卡片照它显示', async () => {
  const bin = fakeExe(4096);
  const sdk = fakeSdk('bad', { bin });
  sdk.manifest.platforms['win32-x64'].checksum = '0'.repeat(64);
  routes.set(tgzPath('tampered'), (req, res) => { res.writeHead(200); res.end(gzipSync(makeTar([{ name: 'package/claude.exe', data: bin }]))); });
  const dataRoot = path.join(root, 'd2');
  const cli = createClaudeCli(base(dataRoot, sdk, { registries: [REG + '/tampered'] }));
  await cli.ensure({ force: true });
  const st = cli.status();
  assert.equal(st.state, 'failed');
  assert.equal(st.error, '下载的文件校验不通过（可能不完整或被改动过），已丢弃');
  const dir = path.join(dataRoot, '.bin', 'claude-code', '9.9.1-win32-x64');
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
  let err;
  try { cli.options(); } catch (e) { err = e; }
  assert.equal(err.code, 'CLAUDE_CLI_NOT_READY');
  assert.equal(err.title, 'Claude Code 运行组件还没就绪');
  assert.equal(err.hint, '下载的文件校验不通过（可能不完整或被改动过），已丢弃。管理员可以在「设置 › Claude」里重试，或在运行 bridge 服务端的电脑上安装 Claude Code。');
});

test('下载停住：超时换源 / 报「下载停住了」；下载中的状态带进度', async () => {
  const bin = fakeExe(200_000);
  const sdk = fakeSdk('stall', { bin });
  const tgz = gzipSync(makeTar([{ name: 'package/claude.exe', data: bin }]), { level: 0 });
  routes.set(tgzPath('stall'), (req, res) => { res.writeHead(200); res.write(tgz.subarray(0, Math.floor(tgz.length / 2))); /* 然后不动了 */ });
  const cli = createClaudeCli(base(path.join(root, 'd3'), sdk, { registries: [REG + '/stall'], stallTimeoutMs: 400 }));
  const job = cli.ensure({ force: true });
  let mid = null;
  for (let i = 0; i < 50 && !(mid && mid.progress && mid.progress.done > 0); i++) { await new Promise((r) => setTimeout(r, 20)); mid = cli.status(); }
  assert.equal(mid.state, 'downloading');
  // 这个假源不给 Content-Length（分块传输）→ 进度退回按解开的字节算
  assert.ok(mid.progress.done > 0 && mid.progress.total === bin.length && mid.progress.packed === false);
  assert.match(notReadyError(mid).hint, /^已下载 \d+%（\d+ \/ 0 MB），完成后再发一次即可。$/);
  await job;
  assert.match(cli.status().error, /^下载停住了：60 秒没有收到新数据（127\.0\.0\.1:\d+）$/);
});

test('下载不成：退而用本机任意版本（标明不一致）；关了自动下载又什么都没有 → missing', async () => {
  const sdk = fakeSdk('fallback', { bin: fakeExe(64) });
  const local = path.join(root, 'local-claude.exe');
  writeFileSync(local, fakeExe(64));
  const cli = createClaudeCli(base(path.join(root, 'd4'), sdk, { registries: [REG + '/missing'], localAny: () => [{ path: local, version: '9.0.5' }] }));
  await cli.ensure({ force: true });
  const st = cli.status();
  assert.equal(st.state, 'ready');
  assert.equal(st.source, 'local-mismatch');
  assert.equal(st.version, '9.0.5');
  assert.match(st.error, /^下载源上没有/);
  assert.deepEqual(cli.options(), { pathToClaudeCodeExecutable: local });

  const off = createClaudeCli(base(path.join(root, 'd5'), sdk, { env: {}, fetch: () => { throw new Error('不该联网'); } }));   // env 什么都不设 = 默认不下载
  await off.init();
  assert.equal(off.status().state, 'missing');
  assert.equal(off.status().download, false);
  assert.throws(() => off.options(), (e) => e.hint === '需要 Claude Code 9.9.1：管理员可以在运行 bridge 服务端的电脑上安装它，或在服务端 config.json 里用 claudeCliPath 指定位置。');
});

test('显式指定（claudeCliPath）优先；本机已装的同版本排在下载之前', async () => {
  const sdk = fakeSdk('explicit', { bin: fakeExe(64) });
  const mine = path.join(root, 'my-claude.exe');
  writeFileSync(mine, fakeExe(64));
  const a = createClaudeCli(base(path.join(root, 'd6'), sdk, { config: () => ({ claudeCliPath: mine }), fetch: () => { throw new Error('不该联网'); } }));
  assert.deepEqual(a.options(), { pathToClaudeCodeExecutable: mine });
  assert.equal(a.status().source, 'config');
  const b = createClaudeCli(base(path.join(root, 'd7'), sdk, { localExact: (want) => (want === '9.9.1' ? { path: mine, version: want } : null), fetch: () => { throw new Error('不该联网'); } }));
  assert.equal(b.status().source, 'local');
  assert.deepEqual(b.options(), { pathToClaudeCodeExecutable: mine });
});

test('按速度换源：进度按压缩包算；太慢就换下一个；后面的都不通就回到嫌慢的里面最快的那个下完', async () => {
  const bin = fakeExe(400_000);
  const sdk = fakeSdk('slow', { bin });
  const tgz = gzipSync(makeTar([{ name: 'package/claude.exe', data: bin }]), { level: 0 });
  const hits = {};
  // 第一次来：给 Content-Length，然后每 100ms 只发 perTick 字节；再来：全速发完
  const slowRoute = (name, perTick) => routes.set(tgzPath(name), (req, res) => {
    hits[name] = (hits[name] || 0) + 1;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(tgz.length) });
    if (hits[name] > 1) { res.end(tgz); return; }
    let i = 0;
    const iv = setInterval(() => {
      if (i >= tgz.length) { clearInterval(iv); res.end(); return; }
      res.write(tgz.subarray(i, i + perTick));
      i += perTick;
    }, 100);
    res.on('close', () => clearInterval(iv));
  });
  slowRoute('slowA', 200);
  slowRoute('slowC', 50);
  slowRoute('slowD', 200);
  routes.set(tgzPath('fast'), (req, res) => { res.writeHead(200, { 'content-length': String(tgz.length) }); res.end(tgz); });
  const quick = { slowWindowMs: 300, slowRate: 50_000 };
  const norm = (a) => a.error && a.error.replace(/约 \d+ KB\/s/, '约 N KB/s').replace(/127\.0\.0\.1:\d+/, 'H');

  // ① 慢源在前、快源在后：下载中的进度按压缩包算；量过一次嫌慢就放弃，换到快的
  const a = createClaudeCli(base(path.join(root, 'd8'), sdk, { registries: [REG + '/slowA', REG + '/fast'], ...quick }));
  const job = a.ensure({ force: true });
  let mid = null;
  for (let i = 0; i < 100 && !(mid && mid.progress && mid.progress.done > 0); i++) { await new Promise((r) => setTimeout(r, 20)); mid = a.status(); }
  assert.equal(mid.state, 'downloading');
  assert.deepEqual([mid.progress.packed, mid.progress.total], [true, tgz.length]);
  assert.equal(mid.size, bin.length);   // 解开后的大小另给（磁盘占用、界面「解开后约」）
  await job;
  let st = a.status();
  assert.deepEqual([st.state, st.source], ['ready', 'download'], JSON.stringify(st));
  assert.deepEqual(st.attempts.map(norm), ['下载太慢（约 N KB/s，H），已换下一个下载源', null]);
  assert.equal(hits.slowA, 1);

  // ② 两个慢源、最后一个不通：回到两个慢源里较快的那个（这回不嫌慢，下完为止）
  const b = createClaudeCli(base(path.join(root, 'd9'), sdk, { registries: [REG + '/slowC', REG + '/slowD', REG + '/missing'], ...quick }));
  await b.ensure({ force: true });
  st = b.status();
  assert.deepEqual([st.state, st.source], ['ready', 'download'], JSON.stringify(st));
  assert.deepEqual(st.attempts.map(norm), [
    '下载太慢（约 N KB/s，H），已换下一个下载源', '下载太慢（约 N KB/s，H），已换下一个下载源',
    '下载源上没有 Claude Code 运行组件 claude-agent-sdk-win32-x64@9.9.9（H）', null,
  ]);
  assert.deepEqual([hits.slowC, hits.slowD], [1, 2]);
  assert.ok(readFileSync(b.options().pathToClaudeCodeExecutable).equals(bin));
});

test('错误卡片：classifyError 认 CLAUDE_CLI_NOT_READY 与 SDK 自己的「找不到二进制」', async () => {
  const { classifyError } = await import('./status.mjs');
  const e = notReadyError({ state: 'downloading', progress: { done: 50 * 1048576, total: 200 * 1048576 } });
  assert.deepEqual(classifyError(e), { kind: 'engine', title: 'Claude Code 运行组件还在下载', hint: '已下载 25%（50 / 200 MB），完成后再发一次即可。' });
  const sdkErr = new Error('Native CLI binary for win32-x64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.');
  assert.equal(classifyError(sdkErr).kind, 'engine');
});
