// 社区插件市场：社区索引（另一把钥匙）的列表与官方合并、含服务端代码要 ack、按通道算更新、吊销自动停用与撤回、
// 不能回退到被吊销的版本；「发布到社区」对着本地假 GitHub 走完 fork → tree → 拉取请求 → 查状态。
// 本地 http 服务同时假扮两个市场与 GitHub API（_setTestHooks / _setGithubHooks / _setAccountHooks）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-community-market-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'installed');

const { createKernel, memoryStore } = await import('../kernel/kernel.mjs');
const { registerAll, linkLocal } = await import('./discover.mjs');
const { BUILTIN_PLUGINS } = await import('./catalog.mjs');
const { MODULE_CATALOG } = await import('../modules/registry.mjs');
const market = await import('./market.mjs');
const pub = await import('./market/publish.mjs');
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const quiet = { log() {}, warn() {}, error() {} };
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';

// ── 假服务：/o/* 官方市场、/c/* 社区市场、/gh/* GitHub API ─────────────────
const files = new Map();
const gh = { calls: [], prs: new Map(), comments: [] };
function ghRoute(method, p, body) {
  gh.calls.push({ method, p, body });
  const R = 'Wode44398/bridge-plugins';
  if (method === 'GET' && p === '/user') return [200, { login: 'octocat' }];
  if (method === 'GET' && p.startsWith(`/repos/${R}/contents/`)) return [404, { message: 'Not Found' }];
  if (method === 'POST' && p === `/repos/${R}/forks`) return [202, { full_name: 'octocat/bridge-plugins', owner: { login: 'octocat' } }];
  if (method === 'GET' && p === '/repos/octocat/bridge-plugins/git/ref/heads/main') return [200, { object: { sha: 'fork1' } }];
  if (method === 'POST' && p === '/repos/octocat/bridge-plugins/merge-upstream') return [200, {}];
  if (method === 'GET' && p === `/repos/${R}/git/ref/heads/main`) return [200, { object: { sha: 'base1' } }];
  if (method === 'GET' && p === `/repos/${R}/git/commits/base1`) return [200, { tree: { sha: 'tree1' } }];
  if (method === 'GET' && p === `/repos/${R}/git/trees/tree1`) return [200, { tree: [{ path: 'community', type: 'tree', sha: 'ct' }] }];
  if (method === 'GET' && p === `/repos/${R}/git/trees/ct`) return [200, { tree: [{ path: 'pub-demo', type: 'tree', sha: 'dt' }] }];
  if (method === 'GET' && p === `/repos/${R}/git/trees/dt?recursive=1`) return [200, { tree: [{ path: 'old.md', type: 'blob' }, { path: 'index.mjs', type: 'blob' }] }];
  if (method === 'POST' && p === '/repos/octocat/bridge-plugins/git/blobs') return [201, { sha: 'blob' + gh.calls.length }];
  if (method === 'POST' && p === '/repos/octocat/bridge-plugins/git/trees') return [201, { sha: 'tree2' }];
  if (method === 'POST' && p === '/repos/octocat/bridge-plugins/git/commits') return [201, { sha: 'c2' }];
  if (method === 'PATCH' && p.startsWith('/repos/octocat/bridge-plugins/git/refs/heads/')) return [422, { message: 'Reference does not exist' }];
  if (method === 'POST' && p === '/repos/octocat/bridge-plugins/git/refs') return [201, { ref: body.ref }];
  if (method === 'GET' && p.startsWith(`/repos/${R}/pulls?state=open`)) return [200, [...gh.prs.values()].filter((x) => x.state === 'open')];
  if (method === 'POST' && p === `/repos/${R}/pulls`) { const pr = { number: 7, html_url: 'https://github.com/' + R + '/pull/7', state: 'open', merged: false, ...body }; gh.prs.set(7, pr); return [201, pr]; }
  if (method === 'PATCH' && p === `/repos/${R}/pulls/7`) return [200, gh.prs.get(7)];
  if (method === 'GET' && p === `/repos/${R}/pulls/7`) return [200, gh.prs.get(7)];
  if (method === 'GET' && p.startsWith(`/repos/${R}/issues/7/comments`)) return [200, gh.comments];
  return [404, { message: 'no fake for ' + method + ' ' + p }];
}
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/gh/')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const [status, obj] = ghRoute(req.method, req.url.slice(3), raw ? JSON.parse(raw) : undefined);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    });
    return;
  }
  const b = files.get(req.url);
  if (!b) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-length': b.length });
  res.end(b);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
test.after(() => server.close());

const ko = crypto.generateKeyPairSync('ed25519');
const kc = crypto.generateKeyPairSync('ed25519');
const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
market._setTestHooks({ keys: [{ id: 'o1', spki: spki(ko) }], indexUrl: base + '/o/index.json', community: { keys: [{ id: 'c1', spki: spki(kc) }], indexUrl: base + '/c/community.json' } });
pub._setGithubHooks({ api: base + '/gh' });
pub._setAccountHooks({ gh: async () => 'gho_testtoken0123456789' });

function zipOf(id, version, { page = false } = {}) {
  const dir = path.join(tmp, 'src', id + '-' + version);
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  const m = { id, name: id, version, engines: { pluginApi: 3 }, ...(page ? { ui: { apps: [{ id: 'main', title: id, page: 'web/app.html' }] }, permissions: ['ui'] } : {}) };
  writeFileSync(path.join(dir, 'bridge-plugin.json'), JSON.stringify(m));
  writeFileSync(path.join(dir, 'web', 'app.html'), '<p>hi</p>');
  const list = ['bridge-plugin.json', 'web'];
  if (!page) { writeFileSync(path.join(dir, 'index.mjs'), `export function apply(ctx) { ctx.provide('${id}-impl', '${version}'); }\n`); list.push('index.mjs'); }
  const z = path.join(tmp, id + '-' + version + '.zip');
  execFileSync(tar, ['-a', '-cf', z, '-C', dir, ...list]);
  return readFileSync(z);
}
function ver(prefix, id, version, buf, extra = {}) {
  const name = `/${prefix}/${id}-${version}.zip`;
  files.set(name, buf);
  return { version, engines: { pluginApi: 3 }, url: base + name, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, date: '2026-11-23', notes: 'v' + version, ...extra };
}
function sign(file, obj, key, keyId) {
  const raw = Buffer.from(JSON.stringify(obj, null, 2) + '\n');
  files.set(file, raw);
  files.set(file + '.sig', Buffer.from(JSON.stringify({ keyId, sig: crypto.sign(null, raw, key.privateKey).toString('base64') })));
}
const publishOfficial = (seq, plugins) => sign('/o/index.json', { format: 1, market: 'official', seq, generatedAt: '', plugins }, ko, 'o1');
const publishCommunity = (seq, plugins, revoked = []) => sign('/c/community.json', { format: 1, market: 'community', seq, generatedAt: '', plugins, revoked }, kc, 'c1');

const z = {
  page10: zipOf('memo-pad', '1.0.0', { page: true }),
  srv10: zipOf('weather-card', '1.0.0'),
  srv11: zipOf('weather-card', '1.1.0'),
  srv12: zipOf('weather-card', '1.2.0'),
  dup: zipOf('dup-name', '1.0.0'),
};
const cEntries = () => [
  { id: 'memo-pad', name: '便签', publisher: 'octocat', category: 'app', versions: [ver('c', 'memo-pad', '1.0.0', z.page10, { kind: 'page', caps: [], permissions: ['ui'], commit: 'abcdef1', source: 'https://github.com/x/y/tree/abcdef1/community/memo-pad' })] },
  { id: 'weather-card', name: '天气卡', publisher: 'alice', versions: [ver('c', 'weather-card', '1.1.0', z.srv11, { kind: 'server', caps: ['network'] }), ver('c', 'weather-card', '1.0.0', z.srv10, { kind: 'server', caps: ['network'] })] },
  { id: 'dup-name', name: '和官方重名', publisher: 'mallory', versions: [ver('c', 'dup-name', '1.0.0', z.dup, { kind: 'server' })] },
  { id: 'visualize', name: '冒充内置功能', publisher: 'mallory', versions: [ver('c', 'visualize', '1.0.0', z.dup, { kind: 'server' })] },
  { id: 'no-publisher', name: '没作者', versions: [ver('c', 'no-publisher', '1.0.0', z.dup)] },
];

const off = {};
for (const e of BUILTIN_PLUGINS) if (e.id !== 'visualize') off[e.id] = { enabled: false };
for (const m of MODULE_CATALOG) off[m.id] = { enabled: false };
const kernel = createKernel({ store: memoryStore({ plugins: off }), logger: quiet });
await registerAll(kernel);
await kernel.start();

test('社区市场还没开张（404）：空列表、不算错误', async () => {
  publishOfficial(1, []);
  const r = await market.marketOverview(kernel, { refresh: true });
  assert.equal(r.community.market.ok, true);
  assert.equal(r.community.market.empty, true);
  assert.equal(r.community.market.error, null);
  assert.deepEqual(r.community.plugins, []);
});

test('列表：作者、种类、能力；与官方重名、内置功能、没作者的条目不列；钥匙不能串用', async () => {
  publishOfficial(2, [{ id: 'dup-name', name: '官方的', versions: [ver('o', 'dup-name', '1.0.0', z.dup)] }]);
  publishCommunity(1, cEntries());
  const r = await market.marketOverview(kernel, { refresh: true });
  const ids = r.community.plugins.map((p) => p.id).sort();
  assert.deepEqual(ids, ['memo-pad', 'weather-card']);
  const w = r.community.plugins.find((p) => p.id === 'weather-card');
  assert.equal(w.publisher, 'alice');
  assert.equal(w.channel, 'community');
  assert.equal(w.latest.version, '1.1.0');
  assert.equal(w.latest.kind, 'server');
  assert.deepEqual(w.latest.caps, ['network']);
  assert.match(w.report, /issues\/new\?template=report-plugin\.yml/);
  assert.equal(r.community.plugins.find((p) => p.id === 'memo-pad').latest.kind, 'page');
  // 社区钥匙签的东西放到官方地址：官方不认
  sign('/o/index.json', { format: 1, market: 'official', seq: 3, generatedAt: '', plugins: [] }, kc, 'c1');
  const r2 = await market.marketOverview(kernel, { refresh: true });
  assert.match(r2.market.error, /不认识/);
  publishOfficial(4, [{ id: 'dup-name', name: '官方的', versions: [ver('o', 'dup-name', '1.0.0', z.dup)] }]);
});

test('安装：纯页面直接装；含服务端代码不带 ack 要确认；内置功能 / 官方 id 装不了', async () => {
  await market.marketOverview(kernel, { refresh: true });
  const p = await market.installFromMarket(kernel, 'memo-pad', '', { channel: 'community' });
  assert.equal(p.id, 'memo-pad');
  assert.equal(kernel.readState().sources['memo-pad'].market, 'community');
  assert.equal(kernel.readState().sources['memo-pad'].publisher, 'octocat');
  await assert.rejects(market.installFromMarket(kernel, 'weather-card', '1.0.0', { channel: 'community' }), (e) => e.status === 428 && e.needAck.publisher === 'alice' && e.needAck.capLabels[0] === '访问网络');
  assert.equal(kernel.get('weather-card'), null);
  await market.installFromMarket(kernel, 'weather-card', '1.0.0', { channel: 'community', ack: true });
  assert.equal(kernel.service('weather-card-impl'), '1.0.0');
  await assert.rejects(market.installFromMarket(kernel, 'dup-name', '', { channel: 'community', ack: true }), /官方插件的名字/);
  await assert.rejects(market.installFromMarket(kernel, 'visualize', '', { channel: 'community', ack: true }), /社区市场里没有|内置功能/);
});

test('更新按通道算：社区装的只看社区；官方同 id 条目当 taken', async () => {
  const r = await market.marketOverview(kernel);
  const w = r.community.plugins.find((p) => p.id === 'weather-card');
  assert.equal(w.state, 'installed');
  assert.equal(w.current, '1.0.0');
  assert.equal(w.update, true);
  assert.ok(r.updates.some((u) => u.id === 'weather-card' && u.channel === 'community'));
  assert.ok(market.pendingUpdates(kernel).includes('weather-card'));
  await market.installFromMarket(kernel, 'weather-card', '', { channel: 'community', ack: true });
  assert.equal(kernel.service('weather-card-impl'), '1.1.0');
  assert.equal(market.pendingUpdates(kernel).includes('weather-card'), false);
});

test('吊销：已装的当前版本被下架 → 停用、记原因、不能再启用、不能回退过去；撤回后开回来', async () => {
  publishCommunity(2, cEntries(), [{ id: 'weather-card', versions: ['1.1.0'], reason: '偷偷上传数据' }]);
  const hits = [];
  market.setRevokeNotifier((h) => hits.push(...h));
  let r = await market.marketOverview(kernel, { refresh: true });
  assert.equal(kernel.get('weather-card').enabled, false);
  assert.equal(hits[0]?.id, 'weather-card');
  assert.equal(market.isRevoked(kernel, 'weather-card').reason, '偷偷上传数据');
  const w = r.community.plugins.find((p) => p.id === 'weather-card');
  assert.equal(w.revoked.reason, '偷偷上传数据');
  assert.deepEqual(w.versions.map((v) => v.version), ['1.0.0']);   // 被吊销的版本不再列
  await assert.rejects(market.installFromMarket(kernel, 'weather-card', '1.1.0', { channel: 'community', ack: true }), /已被下架/);
  // 再对一次不重复提醒
  await market.marketOverview(kernel, { refresh: true });
  assert.equal(hits.length, 1);
  // 撤回吊销：记录清掉、我们停的开回来
  publishCommunity(3, cEntries(), []);
  r = await market.marketOverview(kernel, { refresh: true });
  assert.equal(market.isRevoked(kernel, 'weather-card'), null);
  assert.equal(kernel.get('weather-card').enabled, true);
});

test('吊销旧版后不能回退过去；装上没被吊销的新版自动恢复开关', async () => {
  // 回收区里是 1.0.0；把它吊销
  publishCommunity(4, cEntries(), [{ id: 'weather-card', versions: ['1.0.0'], reason: '旧版有漏洞' }]);
  await market.marketOverview(kernel, { refresh: true });
  await assert.rejects(market.rollbackInstalled(kernel, 'weather-card'), /不能回退/);
  // 当前 1.1.0 被吊销、新出 1.2.0
  const e = cEntries();
  e[1].versions.unshift(ver('c', 'weather-card', '1.2.0', z.srv12, { kind: 'server', caps: ['network'] }));
  publishCommunity(5, e, [{ id: 'weather-card', versions: ['1.1.0'], reason: '坏了' }]);
  await market.marketOverview(kernel, { refresh: true });
  assert.equal(kernel.get('weather-card').enabled, false);
  await market.installFromMarket(kernel, 'weather-card', '', { channel: 'community', ack: true });
  assert.equal(kernel.service('weather-card-impl'), '1.2.0');
  assert.equal(kernel.get('weather-card').enabled, true);
  assert.equal(market.isRevoked(kernel, 'weather-card'), null);
});

test('社区市场关掉：不列、不拉', async () => {
  market._setTestHooks({ keys: [{ id: 'o1', spki: spki(ko) }], indexUrl: base + '/o/index.json' });
  const r = await market.marketOverview(kernel, { refresh: true });
  assert.equal(r.community.market.off, true);
  assert.deepEqual(r.community.plugins, []);
  market._setTestHooks({ keys: [{ id: 'o1', spki: spki(ko) }], indexUrl: base + '/o/index.json', community: { keys: [{ id: 'c1', spki: spki(kc) }], indexUrl: base + '/c/community.json' } });
});

test('发布到社区：预检拦下坏插件；好插件走 fork → tree（删掉多余旧文件）→ 拉取请求；查状态', async () => {
  const dir = path.join(tmp, 'dev', 'pub-demo');
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(dir, 'bridge-plugin.json'), JSON.stringify({ id: 'pub-demo', name: '发布演示', version: '1.0.0', description: '演示', engines: { pluginApi: 3 } }));
  writeFileSync(path.join(dir, 'index.mjs'), 'export function apply(ctx) { eval("1"); }\n');
  writeFileSync(path.join(dir, 'README.md'), '# 演示');
  writeFileSync(path.join(dir, 'web', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1');
  writeFileSync(path.join(dir, 'a.test.mjs'), '');
  await linkLocal(kernel, dir);

  const bad = await pub.precheck(kernel, 'pub-demo', { notes: '第一版' });
  assert.equal(bad.report.ok, false);
  assert.ok(bad.report.errors.some((e) => e.code === 'dynamic-code'));
  await assert.rejects(pub.publishToCommunity(kernel, 'pub-demo', { notes: '第一版' }), (e) => e.status === 400 && e.report && !e.report.ok);

  writeFileSync(path.join(dir, 'index.mjs'), "import fs from 'node:fs';\nexport function apply(ctx) { return fs.existsSync('.'); }\n");
  const good = await pub.precheck(kernel, 'pub-demo', { notes: '第一版' });
  assert.equal(good.report.ok, true, JSON.stringify(good.report.errors));
  assert.deepEqual(good.report.caps, ['files']);
  assert.equal(good.login, 'octocat');
  assert.deepEqual(good.files.map((f) => f.path).sort(), ['README.md', 'bridge-plugin.json', 'index.mjs', 'web/logo.png']);   // node_modules、测试文件不交

  gh.calls.length = 0;
  const r = await pub.publishToCommunity(kernel, 'pub-demo', { notes: '第一版' });
  assert.equal(r.number, 7);
  assert.equal(r.version, '1.0.0');
  const treeCall = gh.calls.find((c) => c.method === 'POST' && c.p.endsWith('/git/trees'));
  const paths = treeCall.body.tree.map((t) => t.path + (t.sha === null ? ' ×' : '')).sort();
  assert.deepEqual(paths, ['community/pub-demo/README.md', 'community/pub-demo/bridge-plugin.json', 'community/pub-demo/index.mjs', 'community/pub-demo/market.json', 'community/pub-demo/old.md ×', 'community/pub-demo/web/logo.png']);
  assert.equal(treeCall.body.base_tree, 'tree1');
  assert.ok(gh.calls.some((c) => c.method === 'POST' && c.p.endsWith('/git/blobs')));             // 图片走 blob
  const market0 = JSON.parse(treeCall.body.tree.find((t) => t.path.endsWith('market.json')).content);
  assert.equal(market0.notes['1.0.0'], '第一版');
  const prCall = gh.calls.find((c) => c.method === 'POST' && c.p.endsWith('/pulls'));
  assert.equal(prCall.body.head, 'octocat:community/pub-demo');
  assert.match(prCall.body.body, /读写服务器上的文件/);

  assert.equal((await pub.submissionStatus('pub-demo')).status, 'checking');
  gh.comments.push({ body: '<!-- community-intake -->\n❌ 自动检查没通过：pub-demo v1.0.0\n- 某条原因', created_at: new Date().toISOString() });
  pub._resetStatusCache();
  const s = await pub.submissionStatus('pub-demo');
  assert.equal(s.status, 'failed');
  assert.match(s.report, /某条原因/);
  gh.prs.get(7).merged = true;
  pub._resetStatusCache();
  assert.equal((await pub.submissionStatus('pub-demo')).status, 'merged');
  // 再发一次：已有开着的拉取请求就沿用，不新开
  gh.prs.get(7).merged = false;
  gh.calls.length = 0;
  await pub.publishToCommunity(kernel, 'pub-demo', { notes: '第一版' });
  assert.equal(gh.calls.filter((c) => c.method === 'POST' && c.p.endsWith('/pulls')).length, 0);
});
