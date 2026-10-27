// bridge-service.mjs（Windows 守护启动器）的契约：75 立即重启、其它退出 2 秒起翻倍退避、日志超过上限轮转只留 5 代、
// bridge-service.stop 让它收掉整棵子进程树后整体退出、bridge-service.restart 立即重启、待装依赖在两条命之间装、
// 同一数据根只许一个启动器、残留的 pid / stop 文件不挡路。
//
// 整机演练用临时数据根 + 假服务端（--entry）+ 假 npm（BRIDGE_SERVICE_NPM_CLI），不碰仓库里任何运行时文件；
// 起过的进程一律在 finally 里收尸（只收测试开始后创建、PID 记在临时数据根里的 node.exe），整体超时就收尸自杀。
//
//   node --test scripts/server/win/bridge-service.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Backoff, RotatingLog, descendantsOf, launcherAlive, parseArgs, processTable, serviceFiles,
  BACKOFF_MAX_MS, LOG_MAX_BYTES, PROGRAM_ROOT, RESTART_EXIT_CODE,
} from './bridge-service.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(HERE, 'bridge-service.mjs');
const isWin = process.platform === 'win32';
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function waitFor(fn, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`等不到：${what}`);
    await nap(100);
  }
}

test('退避：75 立即拉起；其它 2 秒起翻倍、封顶 60 秒；稳定满 10 分钟清零；秒退的 75 连三次改走退避', () => {
  const b = new Backoff();
  assert.equal(b.next(RESTART_EXIT_CODE, 60_000), 0);
  assert.equal(b.next(1, 1_000), 2_000);
  assert.equal(b.next(3, 1_000), 4_000);
  assert.equal(b.next(3, 1_000), 8_000);
  for (let i = 0; i < 10; i++) b.next(3, 1_000);
  assert.equal(b.next(3, 1_000), BACKOFF_MAX_MS);
  assert.equal(b.next(3, 10 * 60_000), 2_000, '稳定跑满 10 分钟后退避清零');
  assert.equal(b.next(RESTART_EXIT_CODE, 30_000), 0);

  const storm = new Backoff();
  assert.equal(storm.next(RESTART_EXIT_CODE, 100), 0);
  assert.equal(storm.next(RESTART_EXIT_CODE, 100), 0);
  assert.equal(storm.next(RESTART_EXIT_CODE, 100), 2_000, '刚起就要重启、连着三次：按退避来');
  assert.equal(storm.next(RESTART_EXIT_CODE, 5_000), 0, '正常活过一阵再要重启：照旧立即');
});

test('参数：--data-root 两种写法、--entry、--console；缺值或不认识的参数报错', () => {
  assert.deepEqual(parseArgs(['--data-root', 'D:\\x y']), { dataRoot: 'D:\\x y', entry: '', console: false, help: false });
  assert.equal(parseArgs(['--data-root=C:\\d']).dataRoot, 'C:\\d');
  assert.equal(parseArgs(['--entry', 'a.mjs', '--console']).console, true);
  assert.throws(() => parseArgs(['--data-root']), /缺参数/);
  assert.throws(() => parseArgs(['--port', '1']), /不认识/);
});

test('日志轮转：超过上限就轮转、只留 5 代，越新的代号越小', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-svc-log-'));
  const file = path.join(dir, 'server.out.log');
  const log = new RotatingLog(file, { maxBytes: 1000, keep: 5 });
  try {
    for (let i = 0; i < 20; i++) log.write(`chunk-${i}`.padEnd(599, '.') + '\n');   // 每两块轮转一次，共 9 次
  } finally { log.close(); }
  try {
    const gens = readdirSync(dir).sort();
    assert.deepEqual(gens, ['server.out.log', 'server.out.log.1', 'server.out.log.2', 'server.out.log.3', 'server.out.log.4', 'server.out.log.5']);
    assert.match(readFileSync(file, 'utf8'), /chunk-19/);
    assert.match(readFileSync(`${file}.1`, 'utf8'), /chunk-16[\s\S]*chunk-17/);
    assert.match(readFileSync(`${file}.5`, 'utf8'), /chunk-8/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('descendantsOf：只认创建时间不早于父进程的子孙；根的创建时间对不上（PID 被复用）就一个都不认', () => {
  const table = [
    { pid: 10, ppid: 1, created: 1_000, name: 'node.exe' },
    { pid: 11, ppid: 10, created: 1_100, name: 'node.exe' },
    { pid: 13, ppid: 11, created: 1_200, name: 'chrome.exe' },
    { pid: 12, ppid: 10, created: 900, name: 'old.exe' },      // 比根还早：悬空父 PID 指过来的旧进程
  ];
  assert.deepEqual(descendantsOf(10, table), [10, 11, 13]);
  assert.deepEqual(descendantsOf(10, table, 1_005), [10, 11, 13]);
  assert.deepEqual(descendantsOf(10, table, 60_000), []);
  assert.deepEqual(descendantsOf(99, table), []);
});

test('launcherAlive：自己、死掉的 PID、创建时间或命令行对不上的都不算；真在跑的那个算', { timeout: 60_000 }, async () => {
  assert.equal(await launcherAlive({ pid: process.pid, startedAt: Date.now() }), false);
  assert.equal(await launcherAlive({ pid: 'x', startedAt: 1 }), false);
  assert.equal(await launcherAlive(null), false);
  const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await once(gone, 'exit');
  assert.equal(await launcherAlive({ pid: gone.pid, startedAt: Date.now() }), false);
  if (!isWin) return;
  const t0 = Date.now();
  // 命令行里带上 bridge-service，扮成一个启动器；另一个是不相干的 node
  const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'bridge-service-probe'], { stdio: 'ignore', windowsHide: true });
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    assert.equal(await launcherAlive({ pid: live.pid, startedAt: t0 }), true);
    assert.equal(await launcherAlive({ pid: live.pid, startedAt: t0 - 3_600_000 }), false, '同一个 PID、创建时间差一小时：是复用 PID 的别的进程');
    assert.equal(await launcherAlive({ pid: other.pid, startedAt: t0 }), false, '时间对得上、但跑的不是 bridge-service');
  } finally { live.kill(); other.kill(); }
});

// ── 整机演练 ────────────────────────────────────────────────────────────────────────────────
const FAKE_SERVER = String.raw`
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const D = process.env.BRIDGE_DATA_ROOT;
const ev = (s) => fs.appendFileSync(path.join(D, 'events.txt'), s + '\n');
const runsFile = path.join(D, 'runs.txt');
const run = (fs.existsSync(runsFile) ? Number(fs.readFileSync(runsFile, 'utf8')) : 0) + 1;
fs.writeFileSync(runsFile, String(run));
fs.writeFileSync(path.join(D, 'server-' + run + '.pid'), String(process.pid));
ev('start ' + run + ' ' + Date.now() + ' ' + process.env.BRIDGE_SUPERVISED + ' ' + process.pid);
console.log('fake-server run ' + run + ' up');
const quit = (code) => { ev('exit ' + run + ' ' + Date.now() + ' ' + code); process.exit(code); };
if (run === 1) setTimeout(() => quit(75), 150);
else if (run === 2 || run === 3) setTimeout(() => quit(3), 150);
else {
  // 长命的一条：起一个 detached 孙进程（child.kill() 够不着它，只有收整棵树才收得掉）
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
  g.unref();
  fs.writeFileSync(path.join(D, 'grandchild-' + run + '.pid'), String(g.pid));
  if (run === 5) { const block = ('y'.repeat(1023) + '\n').repeat(64); for (let i = 0; i < 240; i++) process.stdout.write(block); }
  fs.writeFileSync(path.join(D, 'run-' + run + '-ready'), '1');
  setInterval(() => {}, 1000);
}
`;
const FAKE_NPM = String.raw`
require('fs').appendFileSync(process.env.FAKE_NPM_OUT, process.cwd() + '|' + process.argv.slice(2).join(' ') + '|' + Date.now() + '\n');
`;

test('整机演练：残留文件不挡路 → 装依赖 → 75 立即 / 退避 2s、4s → 单实例 → restart 收树重启 → 日志轮转 → stop 收树退出',
  { skip: !isWin && '收进程树按 Windows 的进程表核对，只在 Windows 上演练', timeout: 120_000 }, async () => {
    const D = mkdtempSync(path.join(os.tmpdir(), 'bridge-svc-it-'));
    const files = serviceFiles(D);
    const testStart = Date.now();
    const launchers = [];
    const pidsFrom = (prefix) => readdirSync(D).filter((f) => f.startsWith(prefix) && f.endsWith('.pid')).map((f) => Number(readFileSync(path.join(D, f), 'utf8')));
    const cleanup = async () => {
      for (const l of launchers) if (l.exitCode === null && l.signalCode === null) { try { l.kill(); } catch { /* 没了 */ } }
      // 孤儿只收「测试开始后创建、PID 记在临时数据根里的 node.exe」，别撞上复用了 PID 的别人
      const strays = [...pidsFrom('server-'), ...pidsFrom('grandchild-')].filter(alive);
      if (strays.length) {
        const table = await processTable();
        for (const pid of strays) {
          const row = table.find((r) => r.pid === pid);
          if (row && row.created >= testStart - 1_000 && /^node(\.exe)?$/i.test(row.name)) { try { process.kill(pid); } catch { /* 没了 */ } }
        }
      }
      await nap(300);
      rmSync(D, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    };
    const watchdog = setTimeout(() => { console.error('整机演练超时：收尸后自杀'); cleanup().finally(() => process.exit(1)); }, 150_000);
    watchdog.unref();

    try {
      const fakeServer = path.join(D, 'fake-server.cjs');
      const fakeNpm = path.join(D, 'fake-npm.cjs');
      const npmOut = path.join(D, 'npm-calls.txt');
      writeFileSync(fakeServer, FAKE_SERVER);
      writeFileSync(fakeNpm, FAKE_NPM);

      // 上一个启动器硬死后留下的东西：pid 文件（PID 已不在）、没人处理的 stop 文件；外加 update.ps1 写的待装依赖
      const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
      await once(gone, 'exit');
      writeFileSync(files.pid, JSON.stringify({ pid: gone.pid, startedAt: Date.now() - 60_000 }));
      writeFileSync(files.stop, '');
      writeFileSync(files.deps, '\uFEFF' + JSON.stringify({ dirs: ['.', 'harness', '../evil'], head: 'abc1234def' }));

      const env = { ...process.env, BRIDGE_SERVICE_NPM_CLI: fakeNpm, FAKE_NPM_OUT: npmOut };
      delete env.BRIDGE_SUPERVISED;
      const launch = () => {
        const l = spawn(process.execPath, [LAUNCHER, '--data-root', D, '--entry', fakeServer], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        l.stdout.resume();
        l.stderr.resume();
        launchers.push(l);
        return l;
      };
      const L1 = launch();
      await waitFor(() => existsSync(path.join(D, 'run-4-ready')), 40_000, '第 4 条命起来');

      const logText = () => readFileSync(files.log, 'utf8');
      const events = readFileSync(path.join(D, 'events.txt'), 'utf8').trim().split(/\r?\n/).map((l) => l.split(' '));
      const at = (kind, run) => Number(events.find((e) => e[0] === kind && e[1] === String(run))?.[2]);
      for (const e of events.filter((x) => x[0] === 'start')) assert.equal(e[3], 'windows', '子进程带 BRIDGE_SUPERVISED=windows');
      assert.ok(at('start', 2) - at('exit', 1) < 1_500, `75 要立即拉起，实际隔了 ${at('start', 2) - at('exit', 1)}ms`);
      const gap2 = at('start', 3) - at('exit', 2);
      const gap3 = at('start', 4) - at('exit', 3);
      assert.ok(gap2 >= 1_800 && gap2 < 5_000, `第一次失败退避约 2 秒，实际 ${gap2}ms`);
      assert.ok(gap3 >= 3_800 && gap3 < 8_000, `第二次失败退避约 4 秒，实际 ${gap3}ms`);

      const calls = readFileSync(npmOut, 'utf8').trim().split(/\r?\n/).map((l) => l.split('|'));
      assert.deepEqual(calls.map((c) => c[1]), ['ci --omit=dev --no-audit --no-fund', 'ci --omit=dev --no-audit --no-fund']);
      assert.equal(calls[0][0].toLowerCase(), PROGRAM_ROOT.toLowerCase());
      assert.equal(calls[1][0].toLowerCase(), path.join(PROGRAM_ROOT, 'harness').toLowerCase());
      assert.equal(existsSync(files.deps), false, '装完删掉 bridge-service.deps');
      assert.ok(at('start', 1) >= Number(calls[1][2]), '依赖在拉起服务端之前装');
      assert.equal(existsSync(files.stop), false, '启动前就留着的 stop 文件被清掉、没把新启动器停了');
      const early = logText();
      for (const s of ['清掉残留的 pid 文件', '清掉启动前就留着的 bridge-service.stop', '不认的目录，跳过：../evil', '依赖装好了（abc1234def）',
        '服务端请求重启（退出码 75），立即拉起', '2 秒后重启', '4 秒后重启']) assert.ok(early.includes(s), `日志里该有「${s}」`);

      const pidRec = JSON.parse(readFileSync(files.pid, 'utf8'));
      const server4 = Number(readFileSync(path.join(D, 'server-4.pid'), 'utf8'));
      const grand4 = Number(readFileSync(path.join(D, 'grandchild-4.pid'), 'utf8'));
      assert.equal(pidRec.pid, L1.pid);
      assert.equal(pidRec.child, server4);
      assert.equal(pidRec.state, 'running');

      // 同一数据根再起一个：拒绝、退出码 1，在跑的那条命不受影响
      const L2 = launch();
      const [code2] = await once(L2, 'exit');
      assert.equal(code2, 1);
      assert.ok(logText().includes(`同一数据根已有启动器在跑（pid ${L1.pid}）`));
      assert.ok(alive(server4));

      // restart：收掉第 4 条命整棵树（含 detached 孙进程）、立即拉起第 5 条（它会灌 15MB 日志）
      writeFileSync(files.restart, '');
      await waitFor(() => existsSync(path.join(D, 'run-5-ready')), 30_000, 'restart 后第 5 条命起来');
      assert.equal(existsSync(files.restart), false);
      await waitFor(() => !alive(server4) && !alive(grand4), 5_000, '第 4 条命连同孙进程被收掉');

      await waitFor(() => existsSync(`${files.log}.5`), 10_000, '日志轮转到第 5 代');
      assert.equal(existsSync(`${files.log}.6`), false, '只留 5 代');
      for (let i = 1; i <= 5; i++) {
        const size = statSync(`${files.log}.${i}`).size;
        assert.ok(size >= LOG_MAX_BYTES && size < LOG_MAX_BYTES + 512 * 1024, `.${i} 的大小 ${size} 应当刚过 2MB`);
      }

      // stop：收掉整棵树、删 stop 与 pid 文件、退出码 0
      const server5 = Number(readFileSync(path.join(D, 'server-5.pid'), 'utf8'));
      const grand5 = Number(readFileSync(path.join(D, 'grandchild-5.pid'), 'utf8'));
      writeFileSync(files.stop, '');
      const [code1] = await once(L1, 'exit');
      assert.equal(code1, 0);
      await waitFor(() => !alive(server5) && !alive(grand5), 5_000, '第 5 条命连同孙进程被收掉');
      assert.equal(existsSync(files.stop), false, 'stop 文件处理后删掉');
      assert.equal(existsSync(files.pid), false, '退出时删 pid 文件');
      assert.match(logText(), /收到停止请求（数据根下出现 bridge-service\.stop）[\s\S]*启动器退出/);
    } finally {
      clearTimeout(watchdog);
      await cleanup();
    }
  });
