// 「上次看到的样子」（lib/lastKnown.js）与吃它的状态模块：
//   · 记下的值冷启动能原样读回；换了人（登录态快照里的身份变了）不认上一个人的；存储冻结（正在切服务器）时不写
//   · 吃快照的状态模块（agentSettings / modelHub）带着快照求值不抛：快照是在模块求值时就读的，
//     那里出错整个 App 起不来（键表写在状态声明后面就是一次 TDZ，冷启动白屏）
// 做法同 modelHub.test.js：svelte 编译器把真的模块编成客户端模块，依赖换成桩；localStorage 用内存版。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const SV = {
  'svelte': pathToFileURL(join(svelteRoot, 'src', 'index-client.js')).href,
  'svelte/internal/client': pathToFileURL(join(svelteRoot, 'src', 'internal', 'client', 'index.js')).href,
  'svelte/internal/disclose-version': pathToFileURL(join(svelteRoot, 'src', 'internal', 'disclose-version.js')).href,
  'svelte/internal/flags/legacy': pathToFileURL(join(svelteRoot, 'src', 'internal', 'flags', 'legacy.js')).href,
};
const fixImports = (code) => code.replace(/from\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, s) => (SV[s] ? `from '${SV[s]}'` : m));
const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);

// 内存版 localStorage + window（lastKnown 只用到这几样）
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
};
globalThis.window = globalThis;
const flushTimers = () => new Promise((r) => setTimeout(r, 450));

const dir = mkdtempSync(join(tmpdir(), 'lastknown-test-'));
mkdirSync(join(dir, 'lib'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
writeFileSync(join(dir, 'lib', 'lastKnown.js'), readFileSync(join(here, 'lastKnown.js'), 'utf8'));
writeFileSync(join(dir, 'lib', 'serverProfiles.js'), 'export const cacheNamespace = () => "";');
writeFileSync(join(dir, 'lib', 'accountVault.js'), 'export const bootCacheTag = () => "";');
writeFileSync(join(dir, 'lib', 'store.js'), 'export const storeGet = (k) => localStorage.getItem(k);');
for (const f of ['agentSettings.svelte.js', 'modelHub.svelte.js']) {
  const js = compileModule(readFileSync(join(here, f), 'utf8'), { filename: f, generate: 'client' }).js.code;
  writeFileSync(join(dir, 'lib', f), fixImports(js));
}
writeFileSync(join(dir, 'lib', 'api.js'), 'export const api = { get: async () => ({}), post: async () => ({}) };');
writeFileSync(join(dir, 'lib', 'i18n.js'), 'export const t = (s) => s; export const tr = (s) => s;');
writeFileSync(join(dir, 'lib', 'state.svelte.js'), 'export const me = { kind: "admin" };');
writeFileSync(join(dir, 'lib', 'claudeProviders.svelte.js'), 'export const cpSummaryText = () => "";');
writeFileSync(join(dir, 'lib', 'settingsNav.svelte.js'), 'export const openSettingsFromChat = () => true;');

const LK = await import(pathToFileURL(join(dir, 'lib', 'lastKnown.js')).href);
const setMe = (m) => localStorage.setItem('bridge-me', JSON.stringify(m));

test('记下的值能读回；同一个值不重复写', async () => {
  setMe({ kind: 'admin', user: null, uid: null });
  LK.remember('t.a', { x: 1, list: [1, 2] });
  assert.equal(LK.recall('t.a'), undefined, '攒着还没写');
  await flushTimers();
  assert.deepEqual(LK.recall('t.a'), { x: 1, list: [1, 2] });
  const key = [...mem.keys()].find((k) => k.endsWith(':t.a'));
  const before = mem.get(key);
  LK.remember('t.a', { x: 1, list: [1, 2] });
  await flushTimers();
  assert.equal(mem.get(key), before);
});

test('换了人不认上一个人的快照；没登录不写', async () => {
  setMe({ kind: 'admin', user: null, uid: null });
  LK.remember('t.b', 'admin-data');
  await flushTimers();
  assert.equal(LK.recall('t.b'), 'admin-data');
  setMe({ kind: 'user', user: 'amy', uid: 'u1' });
  assert.equal(LK.recall('t.b'), undefined);
  setMe({ kind: 'none' });
  LK.remember('t.c', 1);
  await flushTimers();
  assert.equal([...mem.keys()].some((k) => k.endsWith(':t.c')), false);
});

test('正在切服务器（存储冻结）时不写；forget 之后读不到', async () => {
  setMe({ kind: 'admin' });
  window.__bridgeStoreFrozen = true;
  LK.remember('t.d', 1);
  await flushTimers();
  window.__bridgeStoreFrozen = false;
  assert.equal(LK.recall('t.d'), undefined);
  LK.remember('t.e', 2);
  await flushTimers();
  assert.equal(LK.recall('t.e'), 2);
  LK.forget('t.e');
  assert.equal(LK.recall('t.e'), undefined);
});

test('吃快照的状态模块带着快照求值：起始值就是上次那份', async () => {
  setMe({ kind: 'admin' });
  LK.remember('ags', { agents: { agents: [{ id: 'claude' }, { id: 'agy' }] }, poolOk: true, accounts: [{ id: 'a1' }], usage: { a1: { five_hour: { pct: 3 } } } });
  LK.remember('hub', { ok: true, v2: true, services: [{ id: 's1' }] });
  await flushTimers();
  const { ags } = await import(pathToFileURL(join(dir, 'lib', 'agentSettings.svelte.js')).href);
  const { hub } = await import(pathToFileURL(join(dir, 'lib', 'modelHub.svelte.js')).href);
  assert.deepEqual(ags.agents.agents.map((a) => a.id), ['claude', 'agy']);
  assert.equal(ags.poolOk, true);
  assert.equal(ags.usage.a1.five_hour.pct, 3);
  assert.equal(ags.usageBusy, false, '忙闲不从快照来');
  assert.equal(hub.ok, true);
  assert.equal(hub.services[0].id, 's1');
});
