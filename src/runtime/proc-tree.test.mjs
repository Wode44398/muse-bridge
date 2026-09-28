// #77：bridge 侧整树收尸不再用 taskkill /T（真起进程树的用例在 harness-watchdog.test.mjs：主线程冻住且带孙进程）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { descendantsOf, killChildTreeSafe, parseProcTable } from './proc-tree.mjs';

test('#77 descendantsOf：悬空父 PID 指过来的旧进程链不收（Windows 上 wscript → cmd → node 的启动链就是这种）', () => {
  const table = [
    { pid: 1000, ppid: 500, created: 100, name: 'node.exe' }, // 根：bridge 拉起的 harness（复用了一个旧 PID）
    { pid: 1001, ppid: 1000, created: 150, name: 'msedge.exe' },
    { pid: 1002, ppid: 1001, created: 151, name: 'msedge.exe' },
    { pid: 2000, ppid: 1000, created: 50, name: 'wscript.exe' }, // 更早就在：它的父进程早退了，PID 1000 后来被复用
    { pid: 2001, ppid: 2000, created: 51, name: 'cmd.exe' },
    { pid: 2002, ppid: 2001, created: 52, name: 'node.exe' }, // bridge
  ];
  assert.deepEqual(descendantsOf(1000, table), [1000, 1001, 1002]);
  assert.deepEqual(descendantsOf(9999, table), []);
});

test('#77 parseProcTable 逐行解析，残行跳过', () => {
  assert.deepEqual(parseProcTable('7\t4\t123\tx.exe\r\nbad\r\n'), [{ pid: 7, ppid: 4, created: 123, name: 'x.exe' }]);
});

test('#77 Node 已经收到退出的子进程不再按 PID 去杀（PID 可能已被复用）', async () => {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => child.once('exit', r));
  assert.deepEqual(await killChildTreeSafe(child), []);
});
