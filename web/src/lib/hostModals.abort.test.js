// node --test web/src/lib/hostModals.abort.test.js
// 插件页面宿主三个弹层（授权框、文件选择器、会话选择器）的取消通道：askGrant / pickFiles / pickSession 的可选 { signal }。
// PluginFrame 卸载、页面换代时 abort，挂着的框按取消收掉——孤儿框留在屏幕上，用户答完结果没人收，
// PluginFrame「同时只挂一个」的闩也要等它关掉才复位（卸载时全部收掉）。
// 做法同 dialogs.test.js：svelte 编译器把真的 .svelte.js 编成客户端模块，api / i18n / toast / dialogState 换成桩；
// 宿主登记（host.ready）手动置真，组件不挂载、不起浏览器。
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

// —— 假环境：模块求值时就注册键盘监听 ——
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { activeElement: null, body: {}, documentElement: {} };

const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);
const dir = mkdtempSync(join(tmpdir(), 'host-modals-test-'));
mkdirSync(join(dir, 'lib'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
for (const f of ['grantDialog.svelte.js', 'filePicker.svelte.js', 'sessionPicker.svelte.js', 'pickerLane.svelte.js']) {
  const js = compileModule(readFileSync(join(here, f), 'utf8'), { filename: f, generate: 'client' }).js.code;
  writeFileSync(join(dir, 'lib', f), fixImports(js));
}
writeFileSync(join(dir, 'lib', 'selfMount.js'), fixImports(readFileSync(join(here, 'selfMount.js'), 'utf8')));
// 桩：api.post 记下每次调用，回包由测试按需改（globalThis.__post）
writeFileSync(join(dir, 'lib', 'api.js'), `export const posts = [];
export const api = { async post(u, b) { posts.push({ u, b }); return globalThis.__post ? globalThis.__post(u, b) : { ok: true, granted: { [b.perm]: '2026-11-13T00:00:00Z' } }; } };`);
writeFileSync(join(dir, 'lib', 'i18n.js'), 'export const t = (s) => s; export const tc = (_c, s) => s; export const tr = (s) => s;');
writeFileSync(join(dir, 'lib', 'toast.svelte.js'), 'export const toasts = []; export const showToast = (m) => { toasts.push(m); };');
writeFileSync(join(dir, 'lib', 'dialogState.svelte.js'), 'export const activeRequest = () => null;');

const G = await import(pathToFileURL(join(dir, 'lib', 'grantDialog.svelte.js')).href);
const F = await import(pathToFileURL(join(dir, 'lib', 'filePicker.svelte.js')).href);
const S = await import(pathToFileURL(join(dir, 'lib', 'sessionPicker.svelte.js')).href);
const L = await import(pathToFileURL(join(dir, 'lib', 'pickerLane.svelte.js')).href);
const A = await import(pathToFileURL(join(dir, 'lib', 'api.js')).href);

// 组件不挂：宿主登记直接置真，kick() 就不去动态 import 组件
G.grantHost.ready = true;
F.filePickHost.ready = true;
S.sessionPickHost.ready = true;

const live = () => G.grantState.queue.filter((r) => !r.closing);
const tick = () => new Promise((r) => setTimeout(r, 0));
// 退场动画（GRANT_EXIT_MS）播完才出队：等它，免得上一个测试的残留并进下一个
const drain = () => new Promise((r) => setTimeout(r, G.GRANT_EXIT_MS + 30));
const ASK = { plugin: 'hello-app', pluginName: 'Hello', appTitle: 'Hello', perm: 'page.chat' };

test('askGrant：已经 abort 的 signal 直接回 false，不入队', async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(await G.askGrant({ ...ASK, signal: ac.signal }), false);
  assert.equal(G.grantState.queue.length, 0);
});

test('askGrant：abort 时这一份回 false、框收掉、不存授权', async () => {
  A.posts.length = 0;
  const ac = new AbortController();
  const p = G.askGrant({ ...ASK, signal: ac.signal });
  assert.equal(live().length, 1);
  ac.abort();
  assert.equal(await p, false);
  assert.equal(live().length, 0, '没人等了，框收掉');
  assert.equal(A.posts.length, 0, '取消不发授权请求');
  await drain();
  assert.equal(G.grantState.queue.length, 0);
});

test('askGrant：合并进同一个框的调用，只撤 abort 的那一份；别人照样拿到「允许」', async () => {
  const ac = new AbortController();
  const a = G.askGrant({ ...ASK, signal: ac.signal });
  const b = G.askGrant({ ...ASK });
  assert.equal(live().length, 1, '同插件同权限并成一个框');
  ac.abort();
  assert.equal(await a, false);
  assert.equal(live().length, 1, '还有人在等，框留着');
  await G.allowGrant(live()[0].id);
  assert.equal(await b, true);
  await drain();
});

test('askGrant：保存途中所有人都撤了——存上的授权撤回去', async () => {
  A.posts.length = 0;
  let release;
  globalThis.__post = (u, b) => (b.allow ? new Promise((r) => { release = () => r({ ok: true, granted: { [b.perm]: 'x' } }); }) : { ok: true, granted: {} });
  const ac = new AbortController();
  const p = G.askGrant({ ...ASK, perm: 'page.files', signal: ac.signal });
  const saving = G.allowGrant(live()[0].id);
  await tick();
  ac.abort();
  assert.equal(await p, false);
  release();
  await saving;
  await tick();
  assert.deepEqual(A.posts.map((x) => x.b.allow), [true, false], '先存、后撤');
  globalThis.__post = null;
  await drain();
});

test('askGrant：正常结算后再 abort 不影响结果，也不会重复结算', async () => {
  const ac = new AbortController();
  const p = G.askGrant({ ...ASK, signal: ac.signal });
  G.denyGrant(live()[0].id);
  assert.equal(await p, false);
  ac.abort();   // 监听已摘，不炸、不动队列
  assert.equal(live().length, 0);
  await drain();
});

test('pickFiles：abort 显示中的那个回 null，排着的接上；abort 排着的只撤它自己', async () => {
  const a1 = new AbortController();
  const a2 = new AbortController();
  const p1 = F.pickFiles({ signal: a1.signal });
  const p2 = F.pickFiles({ multiple: true, signal: a2.signal });
  const p3 = F.pickFiles({});
  assert.equal(F.filePickState.queue.length, 3);
  const id1 = F.activeFilePick().id;
  a2.abort();   // 排着的
  assert.equal(await p2, null);
  assert.equal(F.filePickState.queue.length, 2);
  assert.equal(F.activeFilePick().id, id1, '显示中的不受影响');
  a1.abort();   // 显示中的
  assert.equal(await p1, null);
  assert.equal(F.filePickState.queue.length, 1);
  const r3 = F.activeFilePick();
  assert.ok(r3, '下一个接上');
  F.settleFilePick(r3.id, [{ rel: 'a.txt', name: 'a.txt', size: 3 }]);
  assert.deepEqual(await p3, [{ rel: 'a.txt', ws: '', name: 'a.txt', size: 3 }]);
  assert.equal(L.pickerLane.order.length, 0, '道上清空');
});

test('pickFiles / pickSession：已经 abort 的 signal 直接回 null，不入队', async () => {
  const ac = new AbortController();
  ac.abort();
  assert.equal(await F.pickFiles({ signal: ac.signal }), null);
  assert.equal(await S.pickSession({ signal: ac.signal }), null);
  assert.equal(F.filePickState.queue.length, 0);
  assert.equal(S.sessionPickState.queue.length, 0);
  assert.equal(L.pickerLane.order.length, 0);
});

test('pickSession：abort 回 null；和文件选择器同一条道，abort 后轮到下一个', async () => {
  const ac = new AbortController();
  const ps = S.pickSession({ signal: ac.signal });
  const pf = F.pickFiles({});
  assert.ok(S.activeSessionPick(), '先来的会话选择器在显示');
  assert.equal(F.activeFilePick(), null, '文件选择器在道上排着');
  ac.abort();
  assert.equal(await ps, null);
  const rf = F.activeFilePick();
  assert.ok(rf, '轮到文件选择器');
  F.settleFilePick(rf.id, null);
  assert.equal(await pf, null);
  assert.equal(L.pickerLane.order.length, 0);
});

test('pickSession：正常选完后 abort 不改结果', async () => {
  const ac = new AbortController();
  const p = S.pickSession({ signal: ac.signal });
  S.settleSessionPick(S.activeSessionPick().id, { sessionId: 's-1', title: 'T' });
  ac.abort();
  assert.deepEqual(await p, { sessionId: 's-1', title: 'T' });
});
