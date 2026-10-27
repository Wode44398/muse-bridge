// 回归（2026-10-21 R1 / R2 / R5）：桌面壳里设备数据层的三个放大器。
//   R2  thisDeviceId() 每调一次就是一趟 sendSync（主进程读盘解密）：能订阅 device.onState 的壳只问一次，之后跟推送走；
//   R1  local-pc:state 每条设备操作都推（端口转发的每个 HTTP 请求也算），以前每推一次强拉两遍 /api/devices：
//       现在只有登记身份 / 连接状态真变了才在 500ms 防抖后拉一次；
//   R5  loadLink 同一会话连调不重复请求（调用方 effect 也不再依赖它读写的 devices.link）。
// 做法同 pr.watch.test.js：用 svelte 编译器把真的 devices.svelte.js 编成客户端模块（依赖换成桩），配一个假 BridgeDesktop。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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

const STUBS = {
  'api.js': `export const calls = []; export const api = {
    async get(u) { calls.push(u); return u.startsWith('/api/devices/link') ? { link: '' } : { enabled: true, devices: [{ id: 'dev-A', name: 'A', online: true }] }; },
    async post() { return {}; } };`,
  'bus.js': `export const busOn = () => () => {};`,
  'server.js': `export const getServerBase = () => '';`,
  'nativeDesktop.js': `export const isNativeDesktop = () => true;`,
};

// 假壳：device.id 计数，device.onState 可手动推
let idCalls = 0;
const stateFns = [];
globalThis.window = {
  BridgeDesktop: { device: { id: () => { idCalls++; return 'dev-A'; }, onState: (fn) => { stateFns.push(fn); return () => {}; } } },
  addEventListener() {}, removeEventListener() {},
};
const push = (dev) => { for (const fn of stateFns) fn(dev); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);
const dir = mkdtempSync(join(tmpdir(), 'devices-state-test-'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
for (const [f, src] of Object.entries(STUBS)) writeFileSync(join(dir, f), src);
const out = compileModule(readFileSync(join(here, 'devices.svelte.js'), 'utf8'), { filename: 'devices.svelte.js', generate: 'client' }).js.code;
writeFileSync(join(dir, 'devices.svelte.js'), fixImports(out));
const m = await import(pathToFileURL(join(dir, 'devices.svelte.js')).href);
const { calls } = await import(pathToFileURL(join(dir, 'api.js')).href);
const count = (pred) => calls.filter(pred).length;

test('R2：thisDeviceId 只问壳一次，之后跟着 onState 推来的 deviceId 走', () => {
  assert.equal(m.thisDeviceId(), 'dev-A');
  assert.equal(m.thisDeviceId(), 'dev-A');
  assert.equal(idCalls, 1);
  push({ registered: true, deviceId: 'dev-B', connected: true });
  assert.equal(m.thisDeviceId(), 'dev-B');
  assert.equal(idCalls, 1);
});

test('R1：操作类推送不重拉 /api/devices；登记 / 连接状态真变了才防抖拉一次', async () => {
  await m.loadDevices();
  const base = count((u) => u === '/api/devices');
  for (let i = 0; i < 20; i++) push({ registered: true, deviceId: 'dev-B', connected: true, lastOp: 'http.request', lastOpAt: i });
  await sleep(650);
  assert.equal(count((u) => u === '/api/devices'), base);
  push({ registered: true, deviceId: 'dev-B', connected: false });
  push({ registered: true, deviceId: 'dev-B', connected: true });
  await sleep(650);
  assert.equal(count((u) => u === '/api/devices'), base + 1);
});

test('R5：loadLink 同一会话连调只请求一次，换会话再回来才重拉', async () => {
  const link = (u) => u.startsWith('/api/devices/link');
  const n0 = count(link);
  await Promise.all([m.loadLink('s1'), m.loadLink('s1'), m.loadLink('s1')]);
  assert.equal(count(link) - n0, 1);
  await m.loadLink('s2');
  await m.loadLink('s1');
  assert.equal(count(link) - n0, 3);
  await m.loadLink('');
  assert.equal(m.devices.link.sessionId, '');
});
