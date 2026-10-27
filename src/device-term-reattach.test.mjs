// 设备终端：设备重连时新连接挤掉的是半开旧连接（隧道 / NAT 吞了 FIN，旧连接没收到 close）——
// 以前旧连接上的 pty.open（不设超时）一直挂在在途表里，终端卡在「打开中」、输入被拒（10-21 复现，R6）。
// 现在 'online' 一来没结束的终端就重开，并撤掉上一条 pty.open：新连接上收到新的 pty.open，在途只剩一条。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-term-reattach-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const registry = await import('./runtime/device-registry.mjs');
const control = await import('./runtime/device-control.mjs');
const term = await import('./runtime/device-term.mjs');

function fakeRes() {
  const r = new EventEmitter();
  r.frames = [];
  r.writeHead = () => {};
  r.write = (s) => { const m = /^data: (.*)\n\n$/s.exec(s); if (m) r.frames.push(JSON.parse(m[1])); return true; };
  r.end = () => { setImmediate(() => r.emit('close')); };
  return r;
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('新连接挤掉半开旧连接：终端在新连接上重开，旧的 pty.open 撤出在途表', async () => {
  const { device } = registry.registerDevice({ owner: 'admin', name: 'X', machineId: 'm-reattach' });
  const ctx = { kind: 'admin', key: 'admin' };
  const res1 = fakeRes();
  control.attachDevice(device.id, res1, { info: { caps: ['pty'] } });
  const t = term.ensureDeviceTerm(ctx, device.id, { cols: 80, rows: 24 });
  assert.deepEqual(res1.frames.map((f) => f.op), ['pty.open']);
  assert.equal(control.deviceRuntime(device.id).inflight, 1);

  const res2 = fakeRes();
  control.attachDevice(device.id, res2, { info: { caps: ['pty'] } });
  await tick();
  assert.deepEqual(res2.frames.map((f) => f.op), ['pty.open'], '新连接上重新要终端');
  assert.equal(control.deviceRuntime(device.id).inflight, 1, '旧的那条撤掉了，不再泄漏');
  assert.equal(t.state, 'opening');

  // 设备在新连接上回快照 → 终端恢复 live，能打字
  const op = res2.frames[0].opId;
  control.settleResult(device.id, { opId: op, ok: true, partial: true, chunk: { type: 'snapshot', d: 'PS> ' } });
  await tick();
  assert.equal(t.state, 'live');
  assert.equal(term.writeDeviceTerm(device.id, 'dir\r'), true);

  control.abortDevice(device.id, 'test done');   // 先断开：kill 就不必等一个不会回话的假设备
  await term.killDeviceTerm(device.id);
});

test('对照：真掉线（旧连接先 close）照旧 offline → 重连后重开', async () => {
  const { device } = registry.registerDevice({ owner: 'admin', name: 'Y', machineId: 'm-reattach-2' });
  const ctx = { kind: 'admin', key: 'admin' };
  const res3 = fakeRes();
  control.attachDevice(device.id, res3, { info: { caps: ['pty'] } });
  const t = term.ensureDeviceTerm(ctx, device.id, { cols: 80, rows: 24 });
  res3.emit('close');
  await tick();
  assert.equal(t.state, 'offline');
  const res4 = fakeRes();
  control.attachDevice(device.id, res4, { info: { caps: ['pty'] } });
  await tick();
  assert.deepEqual(res4.frames.map((f) => f.op), ['pty.open']);
  control.abortDevice(device.id, 'test done');   // 先断开：kill 就不必等一个不会回话的假设备
  await term.killDeviceTerm(device.id);
});
