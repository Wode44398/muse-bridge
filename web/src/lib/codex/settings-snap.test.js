// Antigravity 号池（lib/agy/pool.svelte.js）与 Codex 设置（lib/codex/settings.svelte.js）的上次快照：
//   · 带着快照求值不抛（键表在状态声明之前，否则 TDZ 冷启动白屏），起始值就是上次那份，标 snap、不标 loaded
//   · 拉到的数据会记回去；忙闲、登录流程不进快照；401/403/404 把快照作废
// 做法同 lib/lastKnown.test.js：svelte 编译器把真的模块编成客户端模块，依赖换成桩；localStorage 用内存版。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..');
const require = createRequire(join(lib, '..', '..', 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const SV = {
  'svelte': pathToFileURL(join(svelteRoot, 'src', 'index-client.js')).href,
  'svelte/internal/client': pathToFileURL(join(svelteRoot, 'src', 'internal', 'client', 'index.js')).href,
  'svelte/internal/disclose-version': pathToFileURL(join(svelteRoot, 'src', 'internal', 'disclose-version.js')).href,
  'svelte/internal/flags/legacy': pathToFileURL(join(svelteRoot, 'src', 'internal', 'flags', 'legacy.js')).href,
};
const fixImports = (code) => code.replace(/from\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, s) => (SV[s] ? `from '${SV[s]}'` : m));
const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k),
};
globalThis.window = globalThis;
const flushTimers = () => new Promise((r) => setTimeout(r, 450));

const dir = mkdtempSync(join(tmpdir(), 'agycx-snap-test-'));
for (const d of ['lib', 'lib/agy', 'lib/codex']) mkdirSync(join(dir, d), { recursive: true });
const put = (rel, code) => writeFileSync(join(dir, rel), code);
const compile = (rel) => put(rel, fixImports(compileModule(readFileSync(join(lib, rel.slice(4)), 'utf8'), { filename: rel, generate: 'client' }).js.code));
put('package.json', '{"type":"module"}');
put('lib/lastKnown.js', readFileSync(join(lib, 'lastKnown.js'), 'utf8'));
put('lib/serverProfiles.js', 'export const cacheNamespace = () => "";');
put('lib/accountVault.js', 'export const bootCacheTag = () => "";');
put('lib/store.js', 'export const storeGet = (k) => localStorage.getItem(k);');
put('lib/i18n.js', 'export const t = (s) => s; export const tr = (s) => s;');
put('lib/state.svelte.js', 'export const me = { kind: "admin" };');
put('lib/bus.js', 'export const busOn = () => () => {};');
// 接口桩：按路径回应；globalThis.__fail 设了状态码时那条路径抛错
put('lib/api.js', `export const api = {
  get: async (p) => { const f = globalThis.__fail?.[p.split('?')[0]]; if (f) { const e = new Error('x'); e.status = f; throw e; } return globalThis.__resp?.[p.split('?')[0]] ?? {}; },
  post: async () => ({}),
};`);
put('lib/agy/api.js', `import { api } from '../api.js';
export const agyApi = { pool: () => api.get('/api/agy/pool'), poolUsage: () => api.get('/api/agy/pool/usage') };`);
put('lib/agy/pool-logic.js', readFileSync(join(lib, 'agy', 'pool-logic.js'), 'utf8'));
compile('lib/agy/pool.svelte.js');
compile('lib/codex/settings.svelte.js');

const LK = await import(pathToFileURL(join(dir, 'lib', 'lastKnown.js')).href);
localStorage.setItem('bridge-me', JSON.stringify({ kind: 'admin' }));
LK.remember('agyPool', { accounts: [{ id: 'a1', label: '默认账号' }], usage: { a1: { gemini_weekly: { usedPct: 18 } } }, router: { settings: { enabled: false } }, localAuthed: true });
LK.remember('codex', { admin: true, settings: { idleStopMinutes: 30 }, choices: {}, pool: { accounts: [{ id: 'c1', limits: null }], logins: [{ flowId: 'f' }] }, archived: [], archivedLoaded: true, busy: 'x' });
await flushTimers();
const { agyPool, loadAgyPool } = await import(pathToFileURL(join(dir, 'lib', 'agy', 'pool.svelte.js')).href);
const { cx, loadCodexSettings, loadCodexPool } = await import(pathToFileURL(join(dir, 'lib', 'codex', 'settings.svelte.js')).href);

test('冷开第一帧：号池账号行带用量，Codex 各组都在；标 snap、不标 loaded，忙闲不从快照来', () => {
  assert.equal(agyPool.accounts[0].id, 'a1');
  assert.equal(agyPool.usage.a1.gemini_weekly.usedPct, 18);
  assert.equal(agyPool.snap, true);
  assert.equal(agyPool.usageLoaded, true);
  assert.equal(agyPool.loaded, false);
  assert.equal(cx.admin, true);
  assert.equal(cx.settings.idleStopMinutes, 30);
  assert.equal(cx.snap, true);
  assert.equal(cx.loaded, false);
  assert.equal(cx.busy, '');
});

test('拉到的数据记回去；登录流程不进快照', async () => {
  globalThis.__resp = {
    '/api/agy/pool': { accounts: [{ id: 'a1' }, { id: 'a2' }] },
    '/api/agy/pool/usage': { usage: { a2: { tp_5h: { usedPct: 5 } } } },
    '/api/codex/pool/usage': { accounts: [{ id: 'c1', limits: { x: 1 } }], logins: [{ flowId: 'g' }] },
  };
  await loadAgyPool({ usage: true });
  await loadCodexPool({ usage: true });
  await new Promise((r) => setTimeout(r, 20));
  await flushTimers();
  assert.equal(agyPool.snap, false);
  assert.deepEqual(LK.recall('agyPool').accounts.map((a) => a.id), ['a1', 'a2']);
  assert.equal(LK.recall('agyPool').usage.a2.tp_5h.usedPct, 5);
  assert.equal(LK.recall('codex').pool.accounts[0].limits.x, 1);
  assert.equal('logins' in LK.recall('codex').pool, false);
  assert.equal('flows' in LK.recall('codex'), false);
});

test('断网留着上次的；403 作废快照', async () => {
  globalThis.__fail = { '/api/codex/settings': 500 };
  await loadCodexSettings();
  assert.equal(cx.settings.idleStopMinutes, 30, '断网 / 5xx 不清空');
  globalThis.__fail = { '/api/codex/settings': 403, '/api/agy/pool': 403 };
  await loadCodexSettings();
  await loadAgyPool({ usage: false });
  assert.equal(cx.settings, null);
  assert.equal(cx.admin, false);
  assert.equal(LK.recall('codex'), undefined);
  assert.deepEqual(agyPool.accounts, []);
  assert.equal(LK.recall('agyPool'), undefined);
});
