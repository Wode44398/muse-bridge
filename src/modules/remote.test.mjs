// 功能扩展「从 GitHub 安装」（modules/remote.mjs）：本地 http 服务假扮 GitHub（发版清单 + 离线包 + 重定向），
// BRIDGE_BUILD_ID 模拟打包好的主程序。vertex 当「没装」（跳过仓库内置），dimensio 是仓库内置，公开版不提供 codex。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-modremote-'));
process.env.BRIDGE_DATA_ROOT = path.join(tmp, 'data');
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'vertex,codex';
process.env.BRIDGE_EDITION = 'public';
process.env.BRIDGE_CLIENT_UPDATE_FEED = 'https://github.com/Wode44398/claude-bridge-releases/releases/latest/download/latest.json';
const BUILD = '2026.10.24.0150+abc1234';
const VERSION = '2026.10.24.0150';
process.env.BRIDGE_BUILD_ID = BUILD;
mkdirSync(process.env.BRIDGE_DATA_ROOT, { recursive: true });
mkdirSync(process.env.VAULT_PATH, { recursive: true });
writeFileSync(path.join(process.env.BRIDGE_DATA_ROOT, 'config.json'), JSON.stringify({ port: 8787, token: 'modremote-test-token-0123456789' }));

const { PENDING_DIR } = await import('./registry.mjs');
const remote = await import('./remote.mjs');
const { trustedUrl, _setTestHooks, releaseSource, installFromRelease, modulesOverviewRemote } = remote;

// —— 离线包 ——
const BSDTAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';
function makeZip(name, manifest) {
  const dir = path.join(tmp, 'src-' + name);
  mkdirSync(path.join(dir, 'server'), { recursive: true });
  writeFileSync(path.join(dir, 'bridge-module.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'server', 'index.mjs'), 'export const ok = true;\n');
  const zip = path.join(tmp, name + '.zip');
  execFileSync(BSDTAR, ['-a', '-cf', zip, '-C', dir, 'bridge-module.json', 'server'], { windowsHide: true });
  const buf = readFileSync(zip);
  return { buf, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
const good = makeZip('vertex-good', { id: 'vertex', version: VERSION, buildId: BUILD, entry: 'server/index.mjs' });
const otherBuild = makeZip('vertex-other', { id: 'vertex', version: VERSION, buildId: '2026.10.24.0150+fffffff', entry: 'server/index.mjs' });

// —— 假 GitHub：A 是 github.com，B 是资产域（下载 302 过去），C 不在白名单 ——
let routes = {};
const hits = [];
function serve() {
  const s = http.createServer((req, res) => {
    const key = s.name + req.url;
    hits.push(key);
    const r = routes[key];
    if (!r) { res.writeHead(404); res.end('not found'); return; }
    if (r.redirect) { res.writeHead(302, { location: r.redirect }); res.end(); return; }
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    res.writeHead(r.status || 200, { 'content-length': body.length });
    res.end(body);
  });
  return s;
}
const servers = { A: serve(), B: serve(), C: serve() };
const origin = {};
for (const [n, s] of Object.entries(servers)) {
  s.name = n;
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  origin[n] = 'http://127.0.0.1:' + s.address().port;
}
after(() => { for (const s of Object.values(servers)) s.close(); rmSync(tmp, { recursive: true, force: true }); });

const REL = `/Wode44398/claude-bridge-releases/releases/download/v${VERSION}`;
const hooks = (extra = {}) => _setTestHooks({ origins: [origin.A, origin.B], manifestUrl: (repo, v) => `${origin.A}/${repo}/releases/download/v${v}/latest.json`, ...extra });
const manifest = ({ buildId = BUILD, modules } = {}) => ({
  version: VERSION, buildId, file: 'setup.exe', sha256: 'a'.repeat(64), mirrors: [`https://github.com${REL}/setup.exe`],
  modules: modules ?? { vertex: { file: 'bridge-module-vertex.zip', size: good.size, sha256: good.sha256, version: VERSION, mirrors: [origin.A + REL + '/bridge-module-vertex.zip'] } },
});
// 发版清单与离线包都像真 GitHub 一样先 302 到资产域
function publish(m, zips = { 'bridge-module-vertex.zip': good.buf }) {
  routes = {
    ['A' + REL + '/latest.json']: { redirect: origin.B + '/assets/latest.json' },
    'B/assets/latest.json': { body: m },
  };
  for (const [name, buf] of Object.entries(zips)) {
    routes['A' + REL + '/' + name] = { redirect: origin.B + '/assets/' + name };
    routes['B/assets/' + name] = { body: buf };
  }
}
const pendingManifest = () => path.join(PENDING_DIR, 'vertex', 'bridge-module.json');

beforeEach(() => {
  rmSync(PENDING_DIR, { recursive: true, force: true });
  rmSync(path.join(process.env.BRIDGE_DATA_ROOT, 'client-dist'), { recursive: true, force: true });
  hits.length = 0;
  hooks();
});

test('白名单：只认 https 的 GitHub 发版 / 资产域，别的一律不下', () => {
  _setTestHooks({});
  for (const u of [
    'https://github.com/Wode44398/claude-bridge-releases/releases/download/v1/x.zip',
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x',
    'https://objects.githubusercontent.com/x', 'https://GitHub.com/a',
  ]) assert.equal(trustedUrl(u), true, u);
  for (const u of [
    'http://github.com/a', 'https://github.com.evil.example/a', 'https://evil.example/github.com/a', 'https://user:pw@github.com/a',
    'https://github.com:8443/a', 'https://raw.githubusercontent.com/a', 'https://some-bucket.oss-example.com/x.zip', 'file:///etc/passwd', 'not a url',
  ]) assert.equal(trustedUrl(u), false, u);
});

test('正常路径：按本机版本拉清单（不碰 releases/latest），下载校验后排进 .pending', async () => {
  publish(manifest());
  const ov0 = await modulesOverviewRemote({ waitMs: 3000 });
  const v0 = ov0.modules.find((m) => m.id === 'vertex');
  assert.equal(v0.remote.action, 'install');
  assert.equal(v0.remote.version, VERSION);
  assert.equal(ov0.release.ok, true);
  assert.equal(ov0.release.from, 'github');
  const r = await installFromRelease('vertex');
  assert.equal(r.ok, true);
  assert.equal(r.from, 'github');
  assert.equal(JSON.parse(readFileSync(pendingManifest(), 'utf8')).buildId, BUILD);
  assert.ok(hits.includes('A' + REL + '/latest.json'), '拉的是这一版的清单');
  assert.ok(!hits.some((h) => /releases\/latest/.test(h)), '不碰 releases/latest');
  assert.ok(hits.includes('B/assets/bridge-module-vertex.zip'), '跟着重定向到资产域下载');
  const v1 = (await modulesOverviewRemote()).modules.find((m) => m.id === 'vertex');
  assert.equal(v1.pending.action, 'install');
  assert.equal(v1.remote.action, null, '排着同一版就不再出按钮');
});

test('sha256 不符：丢弃，不排进 .pending', async () => {
  publish(manifest({ modules: { vertex: { file: 'bridge-module-vertex.zip', size: good.size, sha256: 'b'.repeat(64), version: VERSION, mirrors: [origin.A + REL + '/bridge-module-vertex.zip'] } } }));
  await assert.rejects(installFromRelease('vertex'), (e) => /sha256 不符/.test(e.message));
  assert.equal(existsSync(pendingManifest()), false);
});

test('大小不符：服务器给的长度和清单对不上，当场断', async () => {
  publish(manifest({ modules: { vertex: { file: 'bridge-module-vertex.zip', size: good.size + 10, sha256: good.sha256, version: VERSION, mirrors: [origin.A + REL + '/bridge-module-vertex.zip'] } } }));
  await assert.rejects(installFromRelease('vertex'), (e) => /大小不对/.test(e.message));
  assert.equal(existsSync(pendingManifest()), false);
});

test('buildId 不符：GitHub 上这一版的清单不是同一次打包 → 不给装、给理由', async () => {
  publish(manifest({ buildId: '2026.10.24.0150+fffffff' }));
  const src = await releaseSource({ refresh: true });
  assert.equal(src.ok, false);
  assert.equal(src.code, 'mismatch');
  const v = (await modulesOverviewRemote()).modules.find((m) => m.id === 'vertex');
  assert.equal(v.remote.action, null);
  assert.match(v.remote.reason, /不是同一次打包/);
  await assert.rejects(installFromRelease('vertex'), (e) => e.status === 409 && e.code === 'mismatch');
});

test('buildId 不符：清单对得上但包里的打包号不对 → installModuleArchive 拒成 409', async () => {
  publish(manifest({ modules: { vertex: { file: 'bridge-module-vertex.zip', size: otherBuild.size, sha256: otherBuild.sha256, version: VERSION, mirrors: [origin.A + REL + '/bridge-module-vertex.zip'] } } }),
    { 'bridge-module-vertex.zip': otherBuild.buf });
  await assert.rejects(installFromRelease('vertex'), (e) => e.status === 409 && /不是同一次打包/.test(e.message));
  assert.equal(existsSync(pendingManifest()), false);
});

test('非白名单域名：镜像不是 GitHub 的不下；GitHub 重定向到白名单外也不跟', async () => {
  publish(manifest({ modules: { vertex: { file: 'x.zip', size: good.size, sha256: good.sha256, version: VERSION, mirrors: [origin.C + '/x.zip', 'https://evil.example/x.zip'] } } }));
  routes['C/x.zip'] = { body: good.buf };
  await assert.rejects(installFromRelease('vertex'), (e) => e.status === 409 && e.code === 'untrusted');
  assert.ok(!hits.includes('C/x.zip'), '白名单外的地址一个字节都没请求');
  publish(manifest());
  hooks();   // 换了发版清单：丢掉缓存
  routes['A' + REL + '/bridge-module-vertex.zip'] = { redirect: origin.C + '/x.zip' };
  routes['C/x.zip'] = { body: good.buf };
  await assert.rejects(installFromRelease('vertex'), (e) => /不是 GitHub 的下载地址/.test(e.message));
  assert.ok(!hits.includes('C/x.zip'), '重定向到白名单外不跟');
  assert.equal(existsSync(pendingManifest()), false);
});

test('内置扩展不给装；公开版不提供 codex', async () => {
  publish(manifest());
  const ov = await modulesOverviewRemote({ waitMs: 3000 });
  const d = ov.modules.find((m) => m.id === 'dimensio');
  assert.equal(d.builtin, true);
  assert.equal(d.remote.action, null);
  assert.match(d.remote.reason, /内置/);
  await assert.rejects(installFromRelease('dimensio'), (e) => e.status === 409 && e.code === 'builtin');
  assert.equal(ov.modules.some((m) => m.id === 'codex'), false, '公开版不列 codex');
  await assert.rejects(installFromRelease('codex'), (e) => e.status === 409 && e.code === 'not-offered');
  await assert.rejects(installFromRelease('nope'), (e) => e.status === 400);
});

test('不出按钮的理由：没公开发布（404）、连不上 GitHub、发版里没有、源码部署、更新源关了', async () => {
  routes = {};
  let src = await releaseSource({ refresh: true });
  assert.equal(src.code, 'not-found');
  assert.match(src.reason, /私有版/);

  _setTestHooks({ origins: [origin.A, origin.B, 'http://127.0.0.1:1'], manifestUrl: () => 'http://127.0.0.1:1/latest.json' });
  src = await releaseSource({ refresh: true });
  assert.equal(src.code, 'offline');
  assert.match(src.reason, /连不上 GitHub/);

  hooks();
  publish(manifest({ modules: {} }));
  const v = (await modulesOverviewRemote({ refresh: true, waitMs: 3000 })).modules.find((m) => m.id === 'vertex');
  assert.equal(v.remote.code, 'absent');

  const saved = process.env.BRIDGE_BUILD_ID;
  delete process.env.BRIDGE_BUILD_ID;
  try {
    assert.equal((await releaseSource()).code, 'source');
    await assert.rejects(installFromRelease('vertex'), (e) => e.code === 'source');
  } finally { process.env.BRIDGE_BUILD_ID = saved; }

  process.env.BRIDGE_CLIENT_UPDATE_FEED = '';
  try { assert.equal((await releaseSource()).code, 'feed-off'); }
  finally { process.env.BRIDGE_CLIENT_UPDATE_FEED = 'https://github.com/Wode44398/claude-bridge-releases/releases/latest/download/latest.json'; }
});

test('本地发版目录的清单对得上：直接用安装包旁的离线包，不联网', async () => {
  routes = {};
  const dist = path.join(process.env.BRIDGE_DATA_ROOT, 'client-dist');
  mkdirSync(path.join(dist, 'modules'), { recursive: true });
  writeFileSync(path.join(dist, 'modules', 'bridge-module-vertex.zip'), good.buf);
  writeFileSync(path.join(dist, 'latest.json'), JSON.stringify({ version: VERSION, buildId: BUILD, sha256: 'a'.repeat(64),
    modules: { vertex: { file: 'bridge-module-vertex.zip', size: good.size, sha256: good.sha256, version: VERSION, mirrors: ['https://github.com' + REL + '/bridge-module-vertex.zip'] } } }));
  const r = await installFromRelease('vertex');
  assert.equal(r.from, 'local');
  assert.equal(hits.length, 0, '没有发任何请求');
  assert.ok(statSync(pendingManifest()).isFile());
});

test('HTTP：只给管理员；POST /api/modules/install 装完回 overview', async () => {
  publish(manifest());
  const { createRouter } = await import('../runtime/router.mjs');
  const { registerModuleAdminRoutes } = await import('../routes/modules.mjs');
  const router = createRouter();
  registerModuleAdminRoutes(router, { identify: (req) => (req.headers['x-test-admin'] ? { kind: 'admin' } : { kind: 'none' }) });
  const srv = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const anon = await fetch(base + '/api/modules/install', { method: 'POST', body: JSON.stringify({ id: 'vertex' }) });
    assert.equal(anon.status, 401);
    const r = await fetch(base + '/api/modules/install', { method: 'POST', headers: { 'x-test-admin': '1', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'vertex' }) });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.overview.modules.find((m) => m.id === 'vertex').pending.action, 'install');
    const g = await (await fetch(base + '/api/modules', { headers: { 'x-test-admin': '1' } })).json();
    assert.equal(g.release.ok, true);
    const bad = await fetch(base + '/api/modules/install', { method: 'POST', headers: { 'x-test-admin': '1' }, body: JSON.stringify({ id: 'dimensio' }) });
    assert.equal(bad.status, 409);
  } finally { srv.close(); }
});
