// 插件市场：签名索引、选兼容版本、装 / 更新 / 降级 / 回退、sha256 与 seq 防护、市场版盖内置功能（热换、出错自动退回、恢复内置版）。
// 本地 http 服务假扮市场（_setTestHooks 换测试公钥与索引地址；zip 与索引同源放行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-market-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'installed');

const { createKernel, memoryStore } = await import('../kernel/kernel.mjs');
const { registerAll, installFromArchive, OVERRIDES_DIR } = await import('./discover.mjs');
const { BUILTIN_PLUGINS } = await import('./catalog.mjs');
const { MODULE_CATALOG } = await import('../modules/registry.mjs');
const { BRIDGE_VERSION } = await import('./engines.mjs');
const market = await import('./market.mjs');
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const quiet = { log() {}, warn() {}, error() {} };
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';
const [maj, min] = BRIDGE_VERSION.split('.').map(Number);
const BOUNDED = `>=${maj}.${min} <${maj}.${min + 1}`;

// ── 假市场 ──────────────────────────────────────────────────────────────
const files = new Map();   // 路径 → Buffer
const server = http.createServer((req, res) => {
  const b = files.get(req.url);
  if (!b) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-length': b.length });
  res.end(b);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
test.after(() => server.close());

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
market._setTestHooks({ keys: [{ id: 't1', spki }], indexUrl: base + '/index.json' });

function zipOf(id, version, { engines = { bridge: '>=1' }, body = null } = {}) {
  const dir = path.join(tmp, 'src', id + '-' + version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'bridge-plugin.json'), JSON.stringify({ id, name: id, version, engines }));
  writeFileSync(path.join(dir, 'index.mjs'), body || `export function apply(ctx) { ctx.provide('${id}-impl', '${version}'); }\n`);
  const z = path.join(tmp, id + '-' + version + '.zip');
  execFileSync(tar, ['-a', '-cf', z, '-C', dir, 'bridge-plugin.json', 'index.mjs']);
  return readFileSync(z);
}
function ver(id, version, buf, extra = {}) {
  const name = `/${id}-${version}.zip`;
  files.set(name, buf);
  return { version, engines: { bridge: '>=1' }, url: base + name, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, date: '2026-10-28', notes: 'v' + version, ...extra };
}
function publish(seq, plugins, { key = privateKey, keyId = 't1' } = {}) {
  const raw = Buffer.from(JSON.stringify({ format: 1, market: 'official', seq, generatedAt: new Date().toISOString(), plugins }, null, 2) + '\n');
  files.set('/index.json', raw);
  files.set('/index.json.sig', Buffer.from(JSON.stringify({ keyId, sig: crypto.sign(null, raw, key).toString('base64') })));
}

const demo10 = zipOf('mk-demo', '1.0.0');
const demo11 = zipOf('mk-demo', '1.1.0');
const demo20 = zipOf('mk-demo', '2.0.0', { engines: { bridge: '>=99' } });
const vis10 = zipOf('visualize', '1.0.0', { engines: { bridge: BOUNDED } });
const vis11 = zipOf('visualize', '1.1.0', { engines: { bridge: BOUNDED }, body: 'export function apply() { throw new Error("坏了"); }\n' });
const visOpen = zipOf('visualize', '1.2.0', { engines: { bridge: '>=1' } });
const entries = () => [
  { id: 'mk-demo', name: '演示', description: '演示插件', category: 'integration', versions: [ver('mk-demo', '2.0.0', demo20, { engines: { bridge: '>=99' } }), ver('mk-demo', '1.1.0', demo11), ver('mk-demo', '1.0.0', demo10)] },
  { id: 'visualize', name: '内嵌图表', builtin: true, versions: [ver('visualize', '1.0.0', vis10, { engines: { bridge: BOUNDED } })] },
  { id: 'not-here', name: '别的版本才有的内置功能', builtin: true, versions: [ver('mk-demo', '1.0.0', demo10)] },
];

// 内核：内置功能与 agent 扩展只留 visualize（门控型，apply 是空的）开着，别把真功能拉起来
const off = {};
for (const e of BUILTIN_PLUGINS) if (e.id !== 'visualize') off[e.id] = { enabled: false };
for (const m of MODULE_CATALOG) off[m.id] = { enabled: false };
const kernel = createKernel({ store: memoryStore({ plugins: off }), logger: quiet });
await registerAll(kernel);
await kernel.start();

test('签名不对的索引不采用', async () => {
  const other = crypto.generateKeyPairSync('ed25519');
  publish(1, entries(), { key: other.privateKey });
  const r = await market.marketOverview(kernel, { refresh: true });
  assert.equal(r.plugins.length, 0);
  assert.match(r.market.error, /签名对不上/);
  publish(1, entries(), { keyId: 'nope' });
  await assert.rejects(market.getIndex({ refresh: true }), /不认识/);
});

test('列表：兼容版本、安装状态、这台没有的内置功能不列', async () => {
  publish(2, entries());
  const r = await market.marketOverview(kernel, { refresh: true });
  assert.equal(r.market.ok, true);
  assert.equal(r.market.seq, 2);
  const demo = r.plugins.find((p) => p.id === 'mk-demo');
  assert.equal(demo.state, 'none');
  assert.equal(demo.latest.version, '1.1.0');               // 2.0.0 要 bridge >=99，跳过
  assert.match(demo.versions[0].problem, />=99/);
  const vis = r.plugins.find((p) => p.id === 'visualize');
  assert.equal(vis.state, 'builtin');
  assert.equal(vis.update, true);                            // 内置功能有可用的市场版 = 提示更新
  assert.equal(r.plugins.some((p) => p.id === 'not-here'), false);
  assert.deepEqual(market.pendingUpdates(kernel), ['visualize']);
});

test('装最新兼容版、装指定旧版（降级）、回退回来', async () => {
  const p = await market.installFromMarket(kernel, 'mk-demo');
  assert.equal(p.version, '1.1.0');
  assert.equal(kernel.service('mk-demo-impl'), '1.1.0');
  assert.equal(kernel.readState().sources['mk-demo'].market, 'official');
  await market.installFromMarket(kernel, 'mk-demo', '1.0.0');
  assert.equal(kernel.service('mk-demo-impl'), '1.0.0');
  let r = await market.marketOverview(kernel);
  const demo = r.plugins.find((x) => x.id === 'mk-demo');
  assert.equal(demo.current, '1.0.0');
  assert.equal(demo.update, true);
  assert.equal(demo.rollback, '1.1.0');
  await market.rollbackInstalled(kernel, 'mk-demo');
  assert.equal(kernel.service('mk-demo-impl'), '1.1.0');
  assert.equal(kernel.readState().sources['mk-demo'].version, '1.1.0');
  // 从 1.1.0 再退回 1.0.0：退掉的 1.1.0 不再提示「有更新」
  await market.rollbackInstalled(kernel, 'mk-demo');
  assert.equal(kernel.service('mk-demo-impl'), '1.0.0');
  assert.equal((await market.marketOverview(kernel)).plugins.find((x) => x.id === 'mk-demo').update, false);
  await market.installFromMarket(kernel, 'mk-demo');
  assert.equal(kernel.service('mk-demo-impl'), '1.1.0');
  await assert.rejects(market.installFromMarket(kernel, 'mk-demo', '2.0.0'), />=99/);
});

test('sha256 对不上不装；索引 seq 变小不采用', async () => {
  const bad = entries();
  bad[0].versions[1] = { ...bad[0].versions[1], sha256: 'a'.repeat(64) };
  publish(3, bad);
  await market.getIndex({ refresh: true });
  await assert.rejects(market.installFromMarket(kernel, 'mk-demo', '1.1.0'), /sha256/);
  assert.equal(kernel.service('mk-demo-impl'), '1.1.0');
  publish(2, entries());
  const m = await market.getIndex({ refresh: true });
  assert.equal(m.index.seq, 3);                             // 还是缓存的第 3 版
  assert.match(m.error, /比上次见过的旧/);
  publish(4, entries());
  assert.equal((await market.getIndex({ refresh: true })).index.seq, 4);
});

test('内置功能的 id 不能用上传 zip 占', async () => {
  await assert.rejects(installFromArchive(kernel, vis10), /内置功能/);
});

test('市场版盖内置功能：热换上、出错自动退回、恢复内置版后同版本不再提示', async () => {
  await market.installFromMarket(kernel, 'visualize', '1.0.0');
  let p = kernel.get('visualize');
  assert.equal(p.source, 'builtin');
  assert.equal(p.active, true);
  assert.deepEqual({ v: p.extra.override.version, a: p.extra.override.active }, { v: '1.0.0', a: true });
  assert.equal(kernel.service('visualize-impl'), '1.0.0');
  assert.ok(existsSync(path.join(OVERRIDES_DIR, 'visualize', 'bridge-plugin.json')));

  // 1.1.0 的 apply 抛错 → 内核换回内置实现，插件照常开着
  const es = entries();
  es[1].versions.unshift(ver('visualize', '1.1.0', vis11, { engines: { bridge: BOUNDED } }));
  publish(5, es);
  await market.getIndex({ refresh: true });
  await market.installFromMarket(kernel, 'visualize');
  p = kernel.get('visualize');
  assert.equal(p.active, true);
  assert.equal(p.status, 'active');
  assert.equal(p.extra.override.active, false);
  assert.match(p.extra.override.error, /已退回内置版.*坏了/);
  assert.equal(kernel.hasService('visualize-impl'), false);
  // 坏掉的这一版不再提示更新
  assert.equal((await market.marketOverview(kernel)).plugins.find((x) => x.id === 'visualize').update, false);

  // 回退到上一份市场版 1.0.0
  await market.rollbackInstalled(kernel, 'visualize');
  p = kernel.get('visualize');
  assert.equal(p.extra.override.active, true);
  assert.equal(kernel.service('visualize-impl'), '1.0.0');

  // 恢复内置版
  await market.restoreBuiltinVersion(kernel, 'visualize');
  p = kernel.get('visualize');
  assert.equal(p.extra.override, null);
  assert.equal(p.active, true);
  assert.equal(kernel.hasService('visualize-impl'), false);
  assert.equal(existsSync(path.join(OVERRIDES_DIR, 'visualize')), false);
  publish(6, entries());
  const v = (await market.marketOverview(kernel, { refresh: true })).plugins.find((x) => x.id === 'visualize');
  assert.equal(v.state, 'builtin');
  assert.equal(v.update, false);                            // 恢复时换下的 1.0.0 不再提示
});

test('盖内置功能的版本 engines 没上界：装不了', async () => {
  const es = entries();
  es[1].versions = [ver('visualize', '1.2.0', visOpen)];
  publish(7, es);
  const r = await market.marketOverview(kernel, { refresh: true });
  const v = r.plugins.find((x) => x.id === 'visualize');
  assert.equal(v.latest, null);
  assert.match(v.blocked, /适用到哪一版/);
  await assert.rejects(market.installFromMarket(kernel, 'visualize', '1.2.0'), /适用到哪一版/);
});

test('重启后按磁盘上的市场版登记（restart 前后一致）', async () => {
  const es = entries();
  publish(8, es);
  await market.getIndex({ refresh: true });
  await market.installFromMarket(kernel, 'visualize', '1.0.0');
  const k2 = createKernel({ store: memoryStore({ plugins: off }), logger: quiet });
  await registerAll(k2);
  await k2.start();
  const p = k2.get('visualize');
  assert.equal(p.extra.override.active, true);
  assert.equal(p.version, '1.0.0');
  assert.equal(k2.service('visualize-impl'), '1.0.0');
  await k2.stop();
});
