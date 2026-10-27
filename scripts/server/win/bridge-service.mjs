#!/usr/bin/env node
// The Bridge 服务端的 Windows 守护启动器——Linux 上 systemd 单元（Restart=always + journal + stop）的 Windows 对应物。
// 零依赖，只用 Node 自带模块。
//
// 由计划任务拉起（scripts/server/install-windows.ps1 注册，登录类型 Password：开机即跑、不用登录），它再以子进程
// 拉起 src/server.mjs 并看护：
//   · 重启：子进程以 75 退出（服务端「请求重启」，见 src/runtime/service-control.mjs 的 RESTART_EXIT_CODE）→ 立即拉起；
//     其它退出按退避重启：2 秒起翻倍、封顶 60 秒；一条命稳定跑满 10 分钟，退避清零。
//   · 日志：子进程的 stdout/stderr 追加到 <数据根>/server.out.log，超过 2MB 轮转、保留 .1….5 五代（与旧 task-server.vbs
//     同语义）；启动器自己的事件也写进同一个文件（[bridge-service] + 本地时间），一份日志看全每条命的生与死。
//   · 停止：SIGINT / SIGTERM / SIGBREAK / SIGHUP，或数据根下出现 bridge-service.stop（每 2 秒看一次）→ 先收掉子进程整棵树，
//     再删掉 stop 文件与 pid 文件、自己退出（退出码 0，计划任务不会当失败去重试）。
//   · 立即重启：数据根下出现 bridge-service.restart → 收掉子进程树、马上重新拉起（update.ps1 不带 -NoRestart 时这样换新代码，
//     等同 systemctl restart：在跑的对话会被打断，记录保留）。
//   · 待装依赖：数据根下有 bridge-service.deps（update.ps1 写的）→ 拉起子进程之前先在程序根 / harness 跑 npm ci --omit=dev。
//     Windows 上跑着的服务端锁着 node_modules 里的 .node 原生模块与 SDK 自带的 claude.exe，在线 npm ci 会删到一半报 EPERM、
//     把依赖弄残；这两处的依赖只能在两条命之间装，而那个空档只有启动器站得到。
//   · <数据根>/bridge-service.pid：启动器与子进程的 pid 等（JSON），退出时删。同一数据根只能有一个启动器：
//     pid 文件里的启动器还活着（按进程创建时间核对，防 PID 复用）就退出码 1。
//
// 收进程树不用 taskkill /T：它只按 ParentProcessId 找子进程，父 PID 悬空时会顺着复用的 PID 误杀不相干的进程（记录 #77）。
// 这里与 src/runtime/proc-tree.mjs 同一套规则——取一次进程表，只认创建时间不早于父进程的子孙，叶子先杀、根最后经自己的
// 句柄结束（句柄开着，根的 PID 不会被复用）。规则各留一份：启动器不 import src/ 下任何东西，正被 git pull 改写的代码
// 影响不到看护它的进程。另：libuv 把非 detached 的子进程放进「句柄关闭即杀」的作业对象，所以启动器被硬杀
// （Stop-ScheduledTask）时服务端会跟着没，不会留下占着端口的孤儿；detached 的孙进程只有走 stop 文件才收得干净。
//
// 用法：node scripts/server/win/bridge-service.mjs [--data-root <目录>] [--console]
//   --data-root  数据根：--data-root > 环境变量 BRIDGE_DATA_ROOT > 程序根（本仓库根）。显式给了就以 BRIDGE_DATA_ROOT 传给
//                服务端。计划任务的动作带不了环境变量，install-windows.ps1 就用这个参数传，不另包一层 .cmd。
//   --console    日志同时打到本窗口（手动在前台跑时看；计划任务里别加）
//   --entry      换掉服务端入口（默认 <程序根>/src/server.mjs），测试用
import { spawn, execFile } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESTART_EXIT_CODE = 75;          // 与 src/runtime/service-control.mjs 一致（不 import：理由见上）
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
export const STABLE_MS = 10 * 60_000;
export const LOG_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_KEEP = 5;
export const DEPS_DIRS = Object.freeze(['.', 'harness']);   // 启动器只肯在这两处装依赖（顺序同 update.sh）
const POLL_MS = 2_000;
const STOP_GIVE_UP_MS = 30_000;
const INSTALL_TIMEOUT_MS = 30 * 60_000;

export const PROGRAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const USAGE = `用法：node scripts/server/win/bridge-service.mjs [--data-root <目录>] [--console]
  --data-root <目录>  数据根（默认：环境变量 BRIDGE_DATA_ROOT，再没有就是程序根）
  --console           日志同时打到本窗口（手动前台跑时用）
  --entry <文件>      服务端入口（默认 <程序根>/src/server.mjs，测试用）
控制（都放在数据根下）：bridge-service.stop 停止 · bridge-service.restart 立即重启 · 日志 server.out.log
`;

export function serviceFiles(dataRoot) {
  return {
    log: path.join(dataRoot, 'server.out.log'),
    pid: path.join(dataRoot, 'bridge-service.pid'),
    stop: path.join(dataRoot, 'bridge-service.stop'),
    restart: path.join(dataRoot, 'bridge-service.restart'),
    deps: path.join(dataRoot, 'bridge-service.deps'),
  };
}

export function parseArgs(argv) {
  const out = { dataRoot: '', entry: '', console: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    const value = () => {
      if (eq > 0) return a.slice(eq + 1);
      if (i + 1 >= argv.length) throw new Error(`${key} 后面缺参数`);
      return String(argv[++i]);
    };
    if (key === '--data-root') out.dataRoot = value();
    else if (key === '--entry') out.entry = value();
    else if (key === '--console') out.console = true;
    else if (key === '-h' || key === '--help') out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

// 退避：next(退出码, 这条命活了多久) → 等多少毫秒再拉起。
export class Backoff {
  constructor({ base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS, stable = STABLE_MS } = {}) {
    this.base = base;
    this.max = max;
    this.stable = stable;
    this.current = 0;
    this.quickRestarts = 0;
  }

  next(code, lifetimeMs) {
    if (lifetimeMs >= this.stable) this.current = 0;
    if (code === RESTART_EXIT_CODE) {
      // 服务端主动请求重启：立即拉起。连着三次刚起来（3 秒内）就要重启算异常风暴，改走退避，免得空转烧 CPU。
      this.quickRestarts = lifetimeMs < 3_000 ? this.quickRestarts + 1 : 0;
      if (this.quickRestarts < 3) return 0;
    } else {
      this.quickRestarts = 0;
    }
    this.current = this.current ? Math.min(this.current * 2, this.max) : this.base;
    return this.current;
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} 秒`;
  if (s < 7200) return `${Math.round(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}

// 追加写、超过上限就轮转：最老的一代出局，其余后移一位，当前这份成为 .1（与 task-server.vbs 一致）。
// 改名失败（有人开着它又不许删，比如 Get-Content -Wait）就先接着写，再多写 256KB 后重试，不每块都去撞。
export class RotatingLog {
  constructor(file, { maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP, mirror = null, rotate = true } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.mirror = mirror;
    this.canRotate = rotate;
    this.fd = null;
    this.size = 0;
    this.retryAt = 0;
    this.open();
  }

  open() {
    try {
      this.fd = openSync(this.file, 'a');
      this.size = fstatSync(this.fd).size;
    } catch {
      this.fd = null;
    }
  }

  rotate() {
    if (this.fd != null) { try { closeSync(this.fd); } catch { /* 已经关了 */ } this.fd = null; }
    let err = null;
    try {
      rmSync(`${this.file}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      renameSync(this.file, `${this.file}.1`);
    } catch (e) {
      err = e;
    }
    this.open();
    this.retryAt = err ? this.size + 256 * 1024 : 0;
    if (err) this.raw(Buffer.from(`[bridge-service] ${stamp()} 日志轮转失败（${err.code || err.message}），先接着写这一份\n`));
  }

  raw(buf) {
    if (this.fd == null) this.open();
    if (this.fd != null) {
      try {
        let off = 0;
        while (off < buf.length) off += writeSync(this.fd, buf, off, buf.length - off);
        this.size += buf.length;
      } catch { /* 盘满之类：日志丢一块，服务照跑 */ }
    }
    if (this.mirror) { try { this.mirror.write(buf); } catch { /* 窗口关了 */ } }
  }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (this.canRotate && this.size >= this.maxBytes && this.size >= this.retryAt) this.rotate();
    this.raw(buf);
  }

  close() {
    if (this.fd != null) { try { closeSync(this.fd); } catch { /* 已经关了 */ } this.fd = null; }
  }
}

// ── 进程表与收进程树（同 src/runtime/proc-tree.mjs 的规则）────────────────────────────────
// 制表符用 [char]9 拼：PowerShell 单引号字符串里的 `t 不转义。
const TABLE_SCRIPT =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { ' +
  '$t = 0; if ($_.CreationDate) { $t = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; ' +
  '($_.ProcessId, $_.ParentProcessId, $t, $_.Name) -join [char]9 }';

export function parseProcTable(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const [pid, ppid, created, name] = line.trim().split('\t');
    if (!pid || !ppid || created === undefined) continue;
    const row = { pid: Number(pid), ppid: Number(ppid), created: Number(created), name: name ?? '' };
    if (Number.isInteger(row.pid) && Number.isInteger(row.ppid) && Number.isFinite(row.created)) rows.push(row);
  }
  return rows;
}

// 从 rootPid 往下收，只认创建时间不早于父进程的子孙；根排第一。给了 rootCreatedNear（我们拉起它的时刻）时，
// 表里这个 PID 的创建时间对不上就一个都不认——那已经是复用了这个 PID 的别的进程。
export function descendantsOf(rootPid, table, rootCreatedNear = null) {
  const root = table.find((p) => p.pid === rootPid);
  if (!root) return [];
  if (rootCreatedNear != null && root.created > 0 && Math.abs(root.created - rootCreatedNear) > 10_000) return [];
  const kids = new Map();
  for (const p of table) {
    if (p.pid === p.ppid) continue;
    const list = kids.get(p.ppid);
    if (list) list.push(p);
    else kids.set(p.ppid, [p]);
  }
  const out = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p.pid);
    for (const c of kids.get(p.pid) ?? []) if (c.created >= p.created) queue.push(c);
  }
  return out;
}

function powershell(script, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve({ err, stdout: String(stdout ?? '') }));
  });
}

export async function processTable() {
  return parseProcTable((await powershell(TABLE_SCRIPT)).stdout);
}

// 某个 PID 的创建时间（毫秒）、进程名、命令行：null = 没有这个进程；undefined = 查不了。
// 别人账号的进程，非管理员查不到命令行（空串），只能凭创建时间与进程名。
async function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const { stdout } = await powershell(
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
    'if ($p) { $t = 0; if ($p.CreationDate) { $t = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }; ' +
    '($t, $p.Name, [string]$p.CommandLine) -join [char]9 } else { "none" }');
  const out = stdout.trim();
  if (!out) return undefined;
  if (out === 'none') return null;
  const [created, name = '', ...cmd] = out.split('\t');
  return { created: Number(created) || 0, name, cmd: cmd.join('\t') };
}

// pid 文件里记的那个启动器还活着吗（同一个进程，不是复用了 PID 的别人）：创建时间对得上（记的是 Node 初始化的时刻，
// 开机时杀毒扫描能让它比系统记的创建时间晚好几秒，所以放宽到一分钟），而且是跑着 bridge-service 的 node。
export async function launcherAlive(rec) {
  const pid = Number(rec?.pid);
  const startedAt = Number(rec?.startedAt);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !Number.isFinite(startedAt)) return false;
  try { process.kill(pid, 0); } catch (e) { if (e?.code === 'ESRCH') return false; }
  if (process.platform !== 'win32') {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('bridge-service'); } catch { return true; }
  }
  const info = await processInfo(pid);
  if (info === undefined) return true;              // 查不了：保守当它还活着（退出码 1，计划任务一分钟后再试）
  if (!info) return false;
  if (info.created && Math.abs(info.created - startedAt) > 60_000) return false;
  if (info.name && !/^node(\.exe)?$/i.test(info.name)) return false;
  if (info.cmd && !info.cmd.includes('bridge-service')) return false;
  return true;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

async function claimPidFile(file, rec, say) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(rec, null, 2), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
    let other = null;
    try { other = readJson(file); } catch {
      await nap(300);                               // 可能另一个启动器刚建好文件、还没写完
      try { other = readJson(file); } catch { /* 真坏了 */ }
    }
    if (other && await launcherAlive(other)) {
      say(`同一数据根已有启动器在跑（pid ${other.pid}），本实例退出`);
      return false;
    }
    say(`清掉残留的 pid 文件（${other ? `记的启动器 pid ${other.pid} 已经不在` : '内容读不懂'}）`);
    try { rmSync(file, { force: true }); } catch { /* 下一轮再试 */ }
  }
  say('抢不到 pid 文件，本实例退出');
  return false;
}

// npm：优先用和本进程同一个 Node 旁边的 npm-cli.js（不经 .cmd / .ps1 外壳），找不到再走 PATH。
export function npmCommand(args) {
  const cli = process.env.BRIDGE_SERVICE_NPM_CLI   // 测试用：换成假的 npm
    || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return [process.execPath, [cli, ...args]];
  if (process.platform === 'win32') return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['npm', ...args].join(' ')]];
  return ['npm', args];
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n${USAGE}`); return 2; }
  if (args.help) { process.stdout.write(USAGE); return 0; }

  const explicitData = args.dataRoot || process.env.BRIDGE_DATA_ROOT || '';
  const dataRoot = path.resolve(explicitData || PROGRAM_ROOT);
  const entry = args.entry ? path.resolve(args.entry) : path.join(PROGRAM_ROOT, 'src', 'server.mjs');
  mkdirSync(dataRoot, { recursive: true });
  const files = serviceFiles(dataRoot);
  // 抢到 pid 文件之前不轮转：被拒的第二个启动器不该去动正在用的日志
  const log = new RotatingLog(files.log, { mirror: args.console ? process.stdout : null, rotate: false });
  const say = (msg) => log.write(`[bridge-service] ${stamp()} ${msg}\n`);

  const me = {
    pid: process.pid,
    startedAt: Math.round(performance.timeOrigin),
    node: process.execPath,
    programRoot: PROGRAM_ROOT,
    dataRoot,
    entry,
    state: 'starting',
    child: null,
    childStartedAt: null,
    updatedAt: Date.now(),
  };
  if (!(await claimPidFile(files.pid, me, say))) { log.close(); return 1; }
  log.canRotate = true;
  const writePid = (patch) => {
    Object.assign(me, patch, { updatedAt: Date.now() });
    try { writeFileSync(files.pid, JSON.stringify(me, null, 2)); } catch { /* 下次再写 */ }
  };
  const dropPid = () => {
    try { if (readJson(files.pid).pid === process.pid) rmSync(files.pid, { force: true }); } catch { /* 已经没了 */ }
  };
  process.on('exit', dropPid);

  say(`启动器起来了 pid=${process.pid} node=${process.version} 程序根=${PROGRAM_ROOT} 数据根=${dataRoot}`);
  for (const f of [files.stop, files.restart]) {
    if (!existsSync(f)) continue;
    try { rmSync(f, { force: true }); } catch { /* 下面的轮询还会看到它 */ }
    say(`清掉启动前就留着的 ${path.basename(f)}（那是给上一个启动器的）`);
  }

  const backoff = new Backoff();
  let child = null;          // 当前这条命 { proc, startedAt }
  let installer = null;      // 正在跑的 npm ci { proc, startedAt }
  let stopping = false;
  let stopWhy = '';
  let restartAsked = false;
  let wakeUp = null;
  const wake = () => { const w = wakeUp; wakeUp = null; if (w) w(); };
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { wakeUp = null; resolve(); }, ms);
    wakeUp = () => { clearTimeout(t); resolve(); };
  });

  // 收掉一棵进程树：叶子先，根最后经自己的句柄。根在查表期间退了、或表里那个 PID 的创建时间对不上，就不按 PID 去杀。
  const killTree = async (proc, startedAt, what) => {
    if (!proc || proc.pid == null || proc.exitCode !== null || proc.signalCode !== null) return;
    let rest = [];
    if (process.platform === 'win32') rest = descendantsOf(proc.pid, await processTable(), startedAt).slice(1).reverse();
    for (const pid of rest) { try { process.kill(pid); } catch { /* 已经没了 */ } }
    if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill(); } catch { /* 已经没了 */ } }
    say(`收掉${what}进程树：${[proc.pid, ...rest.slice().reverse()].join('、')}`);
  };

  let finished = false;
  let poll = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (poll) clearInterval(poll);
    try { rmSync(files.stop, { force: true }); } catch { /* 删不掉也要退 */ }
    say(`启动器退出（${stopWhy || '结束'}）`);
    dropPid();
    log.close();
  };

  const requestStop = (why) => {
    if (stopping) return;
    stopping = true;
    stopWhy = why;
    say(`收到停止请求（${why}）：收掉子进程树后退出`);
    writePid({ state: 'stopping' });
    wake();
    if (child) killTree(child.proc, child.startedAt, '服务端');
    if (installer) killTree(installer.proc, installer.startedAt, 'npm');
    // 兜底：收尸卡住也别永远挂着——启动器一退，作业对象会带走直接子进程
    setTimeout(() => { say('收尸超时，直接退出'); finish(); process.exit(0); }, STOP_GIVE_UP_MS).unref();
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => requestStop(`收到 ${sig}`));
  const crash = (e) => {
    say(`启动器自己出错，退出：${e?.stack || e}`);
    try { child?.proc.kill(); } catch { /* 作业对象会兜底 */ }
    stopWhy = '启动器出错';
    finish();
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

  poll = setInterval(() => {
    if (stopping) return;
    if (existsSync(files.stop)) { requestStop('数据根下出现 bridge-service.stop'); return; }
    if (!existsSync(files.restart)) return;
    try { rmSync(files.restart, { force: true }); } catch { /* 下一轮再删 */ }
    if (restartAsked) return;
    restartAsked = true;
    say('收到 bridge-service.restart：收掉服务端进程树、立即重启');
    if (child) killTree(child.proc, child.startedAt, '服务端');
    else wake();
  }, POLL_MS);

  const runProcess = (cmd, cmdArgs, opts) => {
    const startedAt = Date.now();
    const proc = spawn(cmd, cmdArgs, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    proc.stdout.on('data', (b) => log.write(b));
    proc.stderr.on('data', (b) => log.write(b));
    return { proc, startedAt };
  };

  const runInstaller = (npmArgs, cwd) => new Promise((resolve) => {
    let run;
    try {
      const [cmd, cmdArgs] = npmCommand(npmArgs);
      run = runProcess(cmd, cmdArgs, { cwd, env: process.env });
    } catch (e) {
      say(`起不来 npm：${e?.message || e}`);
      resolve(-1);
      return;
    }
    installer = run;
    let settled = false;
    const timer = setTimeout(() => {
      say(`npm 跑了 ${INSTALL_TIMEOUT_MS / 60_000} 分钟还没完，收掉`);
      killTree(run.proc, run.startedAt, 'npm');
    }, INSTALL_TIMEOUT_MS);
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (installer === run) installer = null;
      resolve(code);
    };
    run.proc.on('error', (e) => { say(`npm 出错：${e?.message || e}`); if (run.proc.pid == null) done(-1); });
    run.proc.on('exit', (code) => done(code ?? -1));
  });

  const installDeps = async () => {
    let rec;
    try { rec = readJson(files.deps); } catch (e) {
      if (e?.code === 'ENOENT') return;
      say('bridge-service.deps 读不懂，删掉、不装');
      try { rmSync(files.deps, { force: true }); } catch { /* 下次再说 */ }
      return;
    }
    // PowerShell 5.1 的 ConvertTo-Json 偶尔把单元素数组写成标量，两种都认
    const asked = Array.isArray(rec?.dirs) ? rec.dirs.map(String) : typeof rec?.dirs === 'string' ? [rec.dirs] : [];
    const odd = asked.filter((d) => !DEPS_DIRS.includes(d));
    if (odd.length) say(`bridge-service.deps 里有不认的目录，跳过：${odd.join('、')}`);
    const dirs = DEPS_DIRS.filter((d) => asked.includes(d));
    if (dirs.length) {
      writePid({ state: 'installing-deps' });
      await sleep(1000);                              // 上一条命刚退，让系统把映像文件的锁放干净
      for (const d of dirs) {
        if (stopping) return;
        say(`装依赖（服务端停着，node_modules 没人占）：${d === '.' ? '程序根' : d} › npm ci --omit=dev`);
        const code = await runInstaller(['ci', '--omit=dev', '--no-audit', '--no-fund'], path.join(PROGRAM_ROOT, d));
        if (stopping) return;
        if (code !== 0) {
          say(`装依赖失败（${d}，退出码 ${code}）：bridge-service.deps 留着，下次拉起前再试；这次先照常拉起服务端`);
          return;
        }
      }
      say(`依赖装好了${rec?.head ? `（${String(rec.head).slice(0, 12)}）` : ''}`);
    }
    try { rmSync(files.deps, { force: true }); } catch { /* 下次再删 */ }
  };

  const runChild = () => new Promise((resolve) => {
    const env = { ...process.env, BRIDGE_SUPERVISED: 'windows' };
    if (explicitData) env.BRIDGE_DATA_ROOT = dataRoot;
    let run;
    try {
      run = runProcess(process.execPath, [entry], { cwd: PROGRAM_ROOT, env });
    } catch (e) {
      say(`拉不起服务端：${e?.message || e}`);
      resolve({ code: -1, lifetime: 0 });
      return;
    }
    const { proc, startedAt } = run;
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      if (child === run) child = null;
      writePid({ child: null, childStartedAt: null, state: stopping ? 'stopping' : 'restarting' });
      resolve({ code, lifetime: Date.now() - startedAt });
    };
    proc.on('error', (e) => { say(`服务端进程出错：${e?.message || e}`); if (proc.pid == null) done(-1); });
    proc.on('exit', (code, signal) => {
      say(`服务端 pid ${proc.pid} 退出：${code != null ? `退出码 ${code}` : `信号 ${signal}`}，这条命活了 ${fmtDur(Date.now() - startedAt)}`);
      done(code ?? -1);
    });
    if (proc.pid != null) {
      child = run;
      writePid({ child: proc.pid, childStartedAt: startedAt, state: 'running' });
      say(`拉起服务端 pid ${proc.pid}：${path.relative(PROGRAM_ROOT, entry) || entry}`);
    }
  });

  while (!stopping) {
    if (existsSync(files.deps)) await installDeps();
    if (stopping) break;
    restartAsked = false;                             // 装依赖期间要的重启：马上就拉起了，算数
    const { code, lifetime } = await runChild();
    if (stopping) break;
    if (restartAsked) { restartAsked = false; continue; }
    const delay = backoff.next(code, lifetime);
    if (!delay) {
      say(code === RESTART_EXIT_CODE ? '服务端请求重启（退出码 75），立即拉起' : '立即拉起');
      continue;
    }
    say(`${Math.round(delay / 1000)} 秒后重启（退避：2 秒起翻倍、封顶 60 秒，稳定跑满 10 分钟清零）`);
    writePid({ state: 'backoff' });
    await sleep(delay);
    restartAsked = false;
  }
  finish();
  return 0;
}

// 直接运行才开工；被测试 import 时只导出上面的函数。按真实路径比，联接 / 符号链接下也认得出自己。
function invokedDirectly() {
  try {
    if (!process.argv[1]) return false;
    return path.relative(realpathSync(fileURLToPath(import.meta.url)), realpathSync(path.resolve(process.argv[1]))) === '';
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then((code) => process.exit(code), (e) => {
    process.stderr.write(`${e?.stack || e}\n`);
    process.exit(1);
  });
}
