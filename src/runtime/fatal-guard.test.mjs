// 进程级兜底的回归。
//
// 体检实测：一个 spawn ENOENT（未监听的 'error' 事件）就足以让整台常驻 bridge 退出，
// 直播流 / PTY / CDP 会话 / 正在跑的轮全部一起没。这里验证两件事：
//   ① 孤立的未捕获异常与未处理拒绝【不再】掐死进程；
//   ② 但同一窗口里反复触发时，进程会主动退出（交给 watchdog 做干净重启），
//      而不是一瘸一拐地活着。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
// Windows 上 --eval 里的裸绝对路径不是合法 ESM 说明符，必须给 file:// URL。
const GUARD = new URL('./fatal-guard.mjs', import.meta.url).href;

// 在子进程里跑一段用了兜底的代码，回收退出码与 stderr。
function runChild(body, timeoutMs = 10_000) {
  const src = `import { installFatalGuard } from ${JSON.stringify(GUARD)};\n`
    + `installFatalGuard('test');\n${body}\n`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', src], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
}

test('孤立的未捕获异常不再掐死进程，但会带完整堆栈喊出来', async () => {
  const { code, err } = await runChild(`
    setTimeout(() => { throw new Error('boom-isolated'); }, 10);
    setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 400);
  `);
  assert.equal(code, 0, '进程应当活过这次未捕获异常');
  assert.match(err, /fatal-guard\/test\] uncaughtException/);
  assert.match(err, /boom-isolated/);
  assert.match(err, /at /, '日志里必须有堆栈，否则事后查不出是谁炸的');
});

test('未处理的 Promise 拒绝同样被接住', async () => {
  const { code, err } = await runChild(`
    Promise.reject(new Error('boom-rejected'));
    setTimeout(() => process.exit(0), 400);
  `);
  assert.equal(code, 0);
  assert.match(err, /unhandledRejection/);
  assert.match(err, /boom-rejected/);
});

test('未挂 error 监听的 spawn 失败——正是体检里打死进程的那条——现在活得下来', async () => {
  const { code, err } = await runChild(`
    import { spawn } from 'node:child_process';
    const c = spawn('C:/definitely/not/here/msedge.exe', ['--headless=new'], { stdio: 'ignore', windowsHide: true });
    c.on('exit', () => {});
    setTimeout(() => process.exit(0), 600);
  `);
  assert.equal(code, 0);
  assert.match(err, /ENOENT/);
});

test('同一窗口内反复触发 = 进程已坏，主动退出交给守护重启', async () => {
  const { code, err } = await runChild(`
    for (let i = 0; i < 6; i++) setTimeout(() => { throw new Error('boom-' + i); }, 10 + i);
    setTimeout(() => { console.log('SHOULD-NOT-REACH'); process.exit(0); }, 3000);
  `);
  assert.equal(code, 1, '连环炸应当以退出码 1 收场');
  assert.match(err, /主动退出/);
});
