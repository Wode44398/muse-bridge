// Linux 保持唤醒驱动（systemd-inhibit）：抓 / 放锁跟着子进程走，子进程意外没了按「驱动死了」报回去；电源状态读 sysfs。
// 用一个常驻的 node 子进程冒充 systemd-inhibit（Windows 上也能跑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inhibitArgs, inhibitDriver, readOnBattery, _resetInhibitDenied } from './keep-awake-inhibit.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LONG = [process.execPath, '-e', 'setInterval(() => {}, 1e9)'];

function powerDir(entries) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-power-'));
  for (const [name, files] of Object.entries(entries)) {
    mkdirSync(path.join(root, name));
    for (const [f, v] of Object.entries(files)) writeFileSync(path.join(root, name, f), v + '\n');
  }
  return root;
}

test('电源：交流在线 → 插着电；只剩电池 → 用电池；台式机没有电池 → 插着电；目录不在 → 读不出来', () => {
  assert.equal(readOnBattery(powerDir({ AC: { type: 'Mains', online: 1 }, BAT0: { type: 'Battery', status: 'Charging' } })), false);
  assert.equal(readOnBattery(powerDir({ AC: { type: 'Mains', online: 0 }, BAT0: { type: 'Battery', status: 'Discharging' } })), true);
  assert.equal(readOnBattery(powerDir({ BAT0: { type: 'Battery', status: 'Discharging' } })), true);
  assert.equal(readOnBattery(powerDir({ BAT0: { type: 'Battery', status: 'Full' } })), false);
  assert.equal(readOnBattery(powerDir({ AC: { type: 'Mains', online: 1 } })), false);
  assert.equal(readOnBattery(powerDir({ hidpp_battery_0: { type: 'Battery', scope: 'Device', status: 'Discharging' } })), null, '无线鼠标的电池不算');
  assert.equal(readOnBattery(path.join(os.tmpdir(), 'no-such-power-dir-' + Date.now())), null);
});

test('没有 systemd-inhibit：不给驱动（keep-awake 照旧什么都不做）', () => {
  assert.equal(inhibitDriver({ bin: null }), null);
});

test('被抑制的命令是 cat（读 stdin 到 EOF），不是 sleep infinity', () => {
  const a = inhibitArgs();
  assert.deepEqual(a.slice(0, 2), ['--what=sleep:idle', '--mode=block']);
  assert.equal(a[a.length - 1], 'cat');
  assert.ok(!a.includes('infinity'));
});

test('本进程被硬杀（exit 钩子来不及跑）：被抑制的命令读到 stdin EOF 自己退出，锁不会留下', async () => {
  const mod = pathToFileURL(path.join(import.meta.dirname, 'keep-awake-inhibit.mjs')).href;
  // 冒充 cat：读 stdin，读到 EOF 才退出
  const fakeCat = [process.execPath, '-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1e9)"];
  const code = `import { inhibitDriver } from ${JSON.stringify(mod)};
    const d = inhibitDriver({ argv: ${JSON.stringify(fakeCat)}, graceMs: 1500 });
    console.log((await d.hold(true)) ? 'PID ' + d.pid : 'FAIL');
    setInterval(() => {}, 1e9);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const pid = await new Promise((resolve, reject) => {
      let buf = '';
      parent.stdout.on('data', (c) => {
        buf += c;
        const m = /PID (\d+)/.exec(buf);
        if (m) resolve(Number(m[1])); else if (/FAIL/.test(buf)) reject(new Error('没抓到锁'));
      });
      parent.once('exit', () => reject(new Error('父进程先退了')));
    });
    assert.ok(alive(pid));
    parent.kill('SIGKILL');
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
    assert.equal(alive(pid), false, '父进程死了，冒充 systemd-inhibit 的子进程跟着退出');
  } finally { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); }
});

test('抓锁 = 起子进程、放锁 = 结束它；close 收尸', async () => {
  const d = inhibitDriver({ argv: LONG });
  assert.ok(d);
  assert.equal(await d.hold(true), true);
  const pid = d.pid;
  assert.ok(pid && alive(pid));
  assert.equal(await d.hold(true), true, '重复抓不起第二个');
  assert.equal(d.pid, pid);
  assert.equal(await d.hold(false), true);
  await sleep(300);
  assert.equal(alive(pid), false);
  assert.equal(d.alive(), true, '主动放锁不算驱动死了');
  assert.equal(await d.hold(true), true);
  const pid2 = d.pid;
  d.close();
  await sleep(300);
  assert.equal(alive(pid2), false);
  assert.equal(d.alive(), false);
  assert.equal(await d.hold(true), false, '关掉之后不再抓');
});

test('抓不到锁（子进程马上退了）回 false；拿着锁时子进程意外没了，按驱动死了报回去', async () => {
  // graceMs 放宽：满载跑全量单测时 node 起一个进程都可能超过 400ms；它一退出 hold 就回，不会真等这么久
  _resetInhibitDenied();
  const bad = inhibitDriver({ argv: [process.execPath, '-e', 'process.exit(1)'], graceMs: 15_000 });
  assert.equal(await bad.hold(true), false);
  assert.equal(bad.pid, null);
  _resetInhibitDenied();
  const d = inhibitDriver({ argv: LONG });
  let exited = 0;
  d.onExit = () => { exited++; };
  assert.equal(await d.hold(true), true);
  process.kill(d.pid, 'SIGTERM');
  await sleep(400);
  assert.equal(exited, 1);
  assert.equal(d.alive(), false);
});

test('被拒之后歇一阵：这段时间里不再起子进程（重建驱动也一样）；放锁打断等待不算被拒', async () => {
  _resetInhibitDenied();
  const marker = path.join(mkdtempSync(path.join(os.tmpdir(), 'bridge-inhibit-')), 'runs');
  // 每起一次就往标记文件里追加一个字符，然后马上退出（= 被拒）
  const deny = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(1)`];
  const runs = () => { try { return readFileSync(marker, 'utf8').length; } catch { return 0; } };
  const a = inhibitDriver({ argv: deny, graceMs: 15_000, denyBackoffMs: 60_000 });
  assert.equal(await a.hold(true), false);
  assert.equal(runs(), 1);
  assert.equal(await a.hold(true), false);
  const b = inhibitDriver({ argv: deny, graceMs: 15_000, denyBackoffMs: 60_000 });
  assert.equal(await b.hold(true), false);
  assert.equal(runs(), 1, '歇着的时候一个子进程都不起');
  a.close(); b.close();

  // 抓锁的等待期内自己放掉：不记成被拒，下一次照常抓
  _resetInhibitDenied();
  const c = inhibitDriver({ argv: LONG, graceMs: 2_000 });
  const pending = c.hold(true);
  await sleep(200);
  await c.hold(false);
  assert.equal(await pending, false);
  assert.equal(await c.hold(true), true, '没有进入被拒的歇息期');
  c.close();
  await sleep(200);
});
