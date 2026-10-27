// S9（#24）：dimensio（harness）活着却不应答时整树换掉。
//
// 修前：bridge 只在 harness 子进程退出时才重拉；主线程被一次灾难性正则冻住时进程还活着，
// ensureHarness 轮询 20 秒后回 503，之后每次请求都是 503，永远不换人。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ensureHarnessUp, killTreeAndWait, stopHarnessGracefully } from './harness-watchdog.mjs';

// 假时钟 + 假子进程：sleep 只推进时间；probe 在「冻住」期间一律失败，重拉后恢复。
function rig({ age = 60_000, alive = true, answers = [], hungUntilRespawn = false }) {
  let t = 0;
  let childAlive = alive;
  let fresh = false;
  const script = [...answers];
  const calls = { kill: 0, spawn: 0, killedAt: -1 };
  const deps = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    log: () => {},
    probe: async () => {
      if (fresh) return true;
      if (script.length) return script.shift();
      return !hungUntilRespawn;
    },
    hasChild: () => childAlive,
    childAgeMs: () => age,
    spawn: () => { calls.spawn++; childAlive = true; fresh = true; },
    killChild: async () => { calls.kill++; calls.killedAt = t; childAlive = false; },
  };
  return { deps, calls, exitChild: () => { childAlive = false; } };
}

test('应答正常：不杀、不重拉', async () => {
  const { deps, calls } = rig({ answers: [true] });
  assert.equal(await ensureHarnessUp(deps), true);
  assert.deepEqual([calls.kill, calls.spawn], [0, 0]);
});

test('早过了启动期、连续 30 秒一次都没答上 = 冻住：整树杀掉再重拉', async () => {
  const { deps, calls } = rig({ hungUntilRespawn: true });
  assert.equal(await ensureHarnessUp(deps), true, '重拉之后能应答');
  assert.equal(calls.kill, 1);
  assert.equal(calls.spawn, 1);
  assert.ok(calls.killedAt >= 30_000, `整整一个窗口之后才动手（实际 ${calls.killedAt}ms）`);
});

test('启动期内不应答只是还没起来：不杀', async () => {
  const { deps, calls } = rig({ age: 5_000, answers: [false, false, false, false, false, true] });
  assert.equal(await ensureHarnessUp(deps), true);
  assert.deepEqual([calls.kill, calls.spawn], [0, 0]);
});

test('短暂卡顿（窗口内又答上了）：不杀', async () => {
  const { deps, calls } = rig({ answers: [false, false, false, true] });
  assert.equal(await ensureHarnessUp(deps), true);
  assert.deepEqual([calls.kill, calls.spawn], [0, 0]);
});

test('没有子进程：直接拉起', async () => {
  const { deps, calls } = rig({ alive: false, hungUntilRespawn: true });
  assert.equal(await ensureHarnessUp(deps), true);
  assert.deepEqual([calls.kill, calls.spawn], [0, 1]);
});

test('窗口里子进程自己退了：不必再杀，直接重拉', async () => {
  const r = rig({ hungUntilRespawn: true });
  const probe = r.deps.probe;
  let n = 0;
  r.deps.probe = async () => { if (++n === 3) r.exitChild(); return probe(); };
  assert.equal(await ensureHarnessUp(r.deps), true);
  assert.deepEqual([r.calls.kill, r.calls.spawn], [0, 1]);
});

test(
  'killTreeAndWait 整树杀掉主线程冻住的子进程（连它拉起的孙进程），并等到它真的退出',
  { skip: process.platform !== 'win32' ? '整树杀走的是 Windows taskkill /T' : false, timeout: 60_000 },
  async () => {
    // 子进程：拉起一个孙进程、报出它的 pid，然后把自己的主线程冻住。两者都自带 2 分钟寿命上限，
    // 就算杀失败也不会永远漏在机器上。
    const src = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
      console.log(String(g.pid));
      const t = Date.now(); while (Date.now() - t < 120000) {}
    `;
    const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const grandPid = await new Promise((resolve) => child.stdout.once('data', (b) => resolve(Number(String(b).trim()))));
    assert.ok(grandPid > 0);
    const t0 = Date.now();
    await killTreeAndWait(child, 15_000);
    assert.ok(child.exitCode !== null || child.signalCode !== null, '子进程已经退出');
    assert.ok(Date.now() - t0 < 15_000, '没有空等到超时');
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      try { process.kill(grandPid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { gone = true; }
    }
    assert.ok(gone, '孙进程也被整树带走');
  },
);

// M8（K27 / N36）：bridge 计划内退出时先让 harness 排空，排不掉才整树强杀。
// 修前：直接 child.kill()——Windows 上是 TerminateProcess，在跑的轮被腰斩、最后几秒的转录没落盘。
function fakeChild() {
  const c = new EventEmitter();
  c.exitCode = null;
  c.signalCode = null;
  c.exit = () => { c.exitCode = 0; c.emit('exit', 0, null); };
  return c;
}

test('M8：harness 接了排空请求并自己退出 → 不强杀', async () => {
  const c = fakeChild();
  let killed = 0;
  const out = await stopHarnessGracefully(c, {
    requestDrain: async () => { setTimeout(() => c.exit(), 20); return true; },
    killTree: async () => { killed++; },
    graceMs: 2000,
  });
  assert.equal(out, 'drained');
  assert.equal(killed, 0);
});

test('M8：排空请求发不出去（旧 harness / 已冻住）→ 整树强杀兜底', async () => {
  const c = fakeChild();
  let killed = 0;
  const out = await stopHarnessGracefully(c, {
    requestDrain: async () => false,
    killTree: async () => { killed++; c.exit(); },
  });
  assert.equal(out, 'killed');
  assert.equal(killed, 1);
});

test('M8：接了请求却在期限内没退 → 强杀，不无限等', async () => {
  const c = fakeChild();
  let killed = 0;
  const t0 = Date.now();
  const out = await stopHarnessGracefully(c, {
    requestDrain: async () => true,
    killTree: async () => { killed++; c.exit(); },
    graceMs: 50,
  });
  assert.equal(out, 'killed');
  assert.equal(killed, 1);
  assert.ok(Date.now() - t0 < 2000);
});

test('M8：子进程早已退出 → 什么都不做', async () => {
  const c = fakeChild();
  c.exit();
  let asked = 0;
  const out = await stopHarnessGracefully(c, { requestDrain: async () => { asked++; return true; } });
  assert.equal(out, 'gone');
  assert.equal(asked, 0);
});
