// Claude 工作时保持唤醒（runtime/keep-awake.mjs）：换成假驱动，验证有轮在跑才抓、收尾后余量期再放、
// 设置关掉立即放、电池时按「电池时也保持」决定、codex 的轮不算。真 PowerShell 驱动另有 Windows 冒烟（见文末）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-keepawake-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const G = await import('./runtime/gen.mjs');
const S = await import('./runtime/claude-settings.mjs');
const K = await import('./runtime/keep-awake.mjs');

const admin = { kind: 'admin', key: 'admin', dataDir: path.join(tmp, 'admin'), shell: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假驱动：记录 hold 调用；电池状态可改
let battery = false;
const log = [];
let made = 0;
function fakeDriver() {
  made++;
  let alive = true;
  return {
    pid: 0, onExit: null,
    async hold(on) { log.push(on ? 'on' : 'off'); return true; },
    async onBattery() { return battery; },
    close() { alive = false; log.push('close'); },
    alive: () => alive,
  };
}
K._setKeepAwakeDriver(fakeDriver, { lingerMs: 40, pollMs: 30 });
K.initKeepAwake();

const gen = (sid) => ({ sessionId: sid, done: false, subscribers: new Set(), events: [] });

test('有轮在跑才抓；收尾后余量期过了才放', async () => {
  const g = gen('s1');
  G.tryStartGen('admin', g);
  await sleep(5);
  assert.deepEqual(log, ['on']);
  assert.equal(K.keepAwakeState().holding, true);
  G.genFinish(g);
  await sleep(10);
  assert.equal(K.keepAwakeState().holding, true, '余量期内不放');
  // 余量期内又开一轮：不重复抓
  const g2 = gen('s2');
  G.tryStartGen('admin', g2);
  await sleep(5);
  assert.deepEqual(log, ['on']);
  G.genFinish(g2);
  await sleep(70);
  assert.deepEqual(log, ['on', 'off', 'close']);
  assert.equal(K.keepAwakeState().holding, false);
  log.length = 0;
});

test('codex 的轮不算', async () => {
  const g = gen('c1');
  G.tryStartGen('codex:admin', g);
  await sleep(5);
  assert.deepEqual(log, []);
  G.genFinish(g);
});

test('设置关掉：在跑也立即放；再打开接着抓', async () => {
  const g = gen('s3');
  G.tryStartGen('admin', g);
  await sleep(5);
  assert.deepEqual(log, ['on']);
  S.setClaudeSettings(admin, { keepAwake: false });
  await sleep(5);
  assert.deepEqual(log, ['on', 'off', 'close']);
  S.setClaudeSettings(admin, { keepAwake: true });
  G.genFinish(g);
  const g2 = gen('s4');
  G.tryStartGen('admin', g2);
  await sleep(5);
  assert.equal(log.at(-1), 'on');
  G.genFinish(g2);
  await sleep(70);
  log.length = 0;
});

test('电池：「电池时也保持」关着时拔电就放、插回再抓', async () => {
  S.setClaudeSettings(admin, { keepAwakeOnBattery: false });
  battery = true;
  const g = gen('s5');
  G.tryStartGen('admin', g);
  await sleep(10);
  assert.deepEqual(log, [], '在用电池：不抓');
  battery = false;
  await sleep(50);   // 轮询间隔 30ms
  assert.deepEqual(log, ['on']);
  battery = true;
  await sleep(50);
  assert.deepEqual(log, ['on', 'off']);
  // 改成电池时也保持：设置变化即时生效
  S.setClaudeSettings(admin, { keepAwakeOnBattery: true });
  await sleep(10);
  assert.deepEqual(log, ['on', 'off', 'on']);
  G.genFinish(g);
  await sleep(70);
  assert.equal(K.keepAwakeState().holding, false);
});

test('轮在跑时设置关 → 开：立刻重新抓（主机设置变化两个方向都即时生效）', async () => {
  S.setClaudeSettings(admin, { keepAwakeOnBattery: true });
  battery = false;
  log.length = 0;
  const g = gen('s6');
  G.tryStartGen('admin', g);
  await sleep(5);
  assert.deepEqual(log, ['on']);
  S.setClaudeSettings(admin, { keepAwake: false });
  await sleep(5);
  assert.deepEqual(log, ['on', 'off', 'close']);
  assert.equal(K.keepAwakeState().holding, false);
  assert.equal(K.keepAwakeState().wanted, true, '设置关掉只放请求，在跑的轮还算着');
  S.setClaudeSettings(admin, { keepAwake: null });   // 恢复默认（开）
  await sleep(5);
  assert.deepEqual(log, ['on', 'off', 'close', 'on'], '同一轮还在跑：重新抓');
  assert.equal(K.keepAwakeState().holding, true);
  G.genFinish(g);
  await sleep(70);
  assert.equal(K.keepAwakeState().holding, false);
  assert.equal(K.keepAwakeState().wanted, false);
  log.length = 0;
});

test('开跑时设置关着、中途打开：立刻抓；余量期里打开也抓、余量期过了照放', async () => {
  S.setClaudeSettings(admin, { keepAwake: false });
  const g = gen('s7');
  G.tryStartGen('admin', g);
  await sleep(5);
  assert.deepEqual(log, []);
  S.setClaudeSettings(admin, { keepAwake: null });
  await sleep(5);
  assert.deepEqual(log, ['on']);
  // 收尾后余量期内关 → 开：仍按余量期放手，不会一直撑着
  G.genFinish(g);
  await sleep(5);
  S.setClaudeSettings(admin, { keepAwake: false });
  await sleep(5);
  S.setClaudeSettings(admin, { keepAwake: null });
  await sleep(70);
  assert.equal(K.keepAwakeState().holding, false);
  assert.equal(K.keepAwakeState().wanted, false);
  log.length = 0;
});

test('不走 gen 台账的运行（定时任务）用 holdKeepAwake 计数；放手函数重复调无害', async () => {
  const un = K.holdKeepAwake();
  await sleep(5);
  assert.deepEqual(log, ['on']);
  assert.equal(K.keepAwakeState().live, 1);
  un(); un();
  assert.equal(K.keepAwakeState().live, 0);
  await sleep(70);
  assert.deepEqual(log, ['on', 'off', 'close']);
  log.length = 0;
});
