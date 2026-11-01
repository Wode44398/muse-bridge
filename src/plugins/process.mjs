// 插件的托管子进程：ctx.process.spawn(name, { command, args?, cwd?, env?, restart?, maxRestarts?, hidden?, health? })
// args / env 可以是函数（每次启动、重启时现算）。
//
// 插件要拉起外部程序（QQ 协议端、本地模型服务……）时用它，别自己 child_process.spawn：
//   · 停用 / 改配置 / 重载 / bridge 退出时按【进程树】关掉。Windows 上 child.kill() 只打到直接子进程，经 cmd / bat 起的
//     真干活的孙进程会变孤儿（见记忆 feedback_process_cleanup 第 5 条），所以一律 taskkill /PID <pid> /T /F；
//     只杀自己登记的 pid，绝不按映像名杀（taskkill /IM 会误杀别人的同名进程）。
//   · pid 记进 plugin-data/<id>/.pids；bridge 被硬杀没来得及收尸时，下次这个插件第一次 spawn 前先清掉上次的残留
//     （按 pid + 映像名双重核对，pid 被别的程序复用了就不碰）。
//   · restart: 'on-failure'（缺省）退出码非 0 / 被信号杀时按 1s、2s、4s… 最长 60s 退避重启；稳定跑满 10 分钟清零计数；
//     超过 maxRestarts（缺省 5）停在 failed。'always' 正常退出也重启；'never' 不重启。
//   · stdout / stderr 写进 plugin-data/<id>/logs/<name>.log（满 2MB 轮转一份 .1），p.tail(n) 取最后几行；
//     Windows 上缺省不弹黑窗（windowsHide）。
//   · 状态（starting / running / backoff / stopped / failed / unhealthy、pid、重启次数、最后退出码、健康）自动并进插件状态块。
//   · health: { check: async () => bool, every?: 60s, failAfter?: 3, grace?: 120s, timeout?: 20s }：进程活着但不干活
//     （比如 QQ 掉线、端口不应答）时，连续 failAfter 次检查不过就按进程树重启；启动后 grace 内不判。重启 maxRestarts 次
//     还是不健康就停在 unhealthy（进程留着，不再重启），发 'unhealthy' 事件 { givenUp: true }——插件可以接着 ctx.notify 叫人。
//     每次判定不健康都发 'unhealthy' { fails, restarts, givenUp: false }；恢复时发 'healthy'。

import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import path from 'node:path';

const LOG_MAX = 2 * 1024 * 1024;
const STABLE_MS = 10 * 60_000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

// 整棵进程树收掉。Windows：taskkill /T /F（按 pid）；其余：对进程组发 SIGTERM，2 秒后 SIGKILL。
export function killTree(pid) {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve());
      return;
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } resolve(); }, 2000).unref?.();
  });
}

// pid 现在对应的映像名（核对残留用）；查不到 = ''。
function imageOf(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 }, (err, out) => {
        const m = !err && /^"([^"]+)","(\d+)"/m.exec(String(out || ''));
        resolve(m && Number(m[2]) === Number(pid) ? m[1].toLowerCase() : '');
      });
      return;
    }
    try { resolve(readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase()); } catch { resolve(''); }
  });
}

function tailFile(file, lines) {
  try {
    const st = statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
    const all = buf.toString('utf8').split(/\r?\n/);
    if (all.length && all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } catch { return []; }
}

export function makeProcessService(ctx) {
  const procs = new Map();   // name → handle
  let cleaned = null;        // 首次 spawn 前清理上次残留（只做一次）
  const pidFile = () => path.join(ctx.dataDir, '.pids');
  const logDir = () => path.join(ctx.dataDir, 'logs');
  const readPids = () => { try { const j = JSON.parse(readFileSync(pidFile(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
  const writePids = () => {
    const out = {};
    for (const [n, h] of procs) if (h.pid) out[n] = { pid: h.pid, image: h.image, at: h.startedAt };
    try { mkdirSync(ctx.dataDir, { recursive: true }); writeFileSync(pidFile(), JSON.stringify(out)); } catch {}
  };

  async function cleanStale() {
    const old = readPids();
    for (const [n, rec] of Object.entries(old)) {
      if (!rec || !rec.pid || procs.has(n)) continue;
      const img = await imageOf(rec.pid);
      if (img && rec.image && img === rec.image) {
        ctx.warn(`清理上次没收掉的子进程 ${n}（pid ${rec.pid}）`);
        await killTree(rec.pid);
      }
    }
    try { rmSync(pidFile(), { force: true }); } catch {}
  }

  ctx.onDispose(async () => {
    const all = [...procs.values()];
    await Promise.all(all.map((h) => h.stop()));
    procs.clear();
    try { rmSync(pidFile(), { force: true }); } catch {}
  });

  function spawnManaged(name, opts = {}) {
    if (!ctx.alive) throw new Error('插件已停用');
    if (!NAME_RE.test(String(name || ''))) throw new Error('子进程名只能用字母、数字、- 和 _（≤32 字）');
    if (procs.has(name)) throw new Error(`子进程「${name}」已经在管着了（先 stop，或换个名字）`);
    const command = String(opts.command || '');
    if (!command) throw new Error('ctx.process.spawn 要 command');
    // args / env 可以给函数：每次（重新）启动时现算——比如换了登录账号，下次重启就带上新参数，不用整个插件重启
    const argsNow = () => { const a = typeof opts.args === 'function' ? opts.args() : opts.args; return Array.isArray(a) ? a.map(String) : []; };
    const envNow = () => { const e = typeof opts.env === 'function' ? opts.env() : opts.env; return e && typeof e === 'object' ? e : {}; };
    const policy = ['on-failure', 'always', 'never'].includes(opts.restart) ? opts.restart : 'on-failure';
    const maxRestarts = Number.isInteger(opts.maxRestarts) ? Math.max(0, opts.maxRestarts) : 5;
    const ee = new EventEmitter();
    ee.on('error', () => {});   // 'error' 没人听时 EventEmitter 会抛，别让插件因此崩
    const hc = opts.health && typeof opts.health.check === 'function' ? {
      check: opts.health.check,
      every: Math.max(5_000, Number(opts.health.every) || 60_000),
      failAfter: Math.max(1, Math.floor(Number(opts.health.failAfter) || 3)),
      grace: Math.max(0, Number(opts.health.grace ?? 120_000)),
      timeout: Math.max(1_000, Number(opts.health.timeout) || 20_000),
    } : null;
    const health = { ok: null, fails: 0, restarts: 0, lastCheck: null, lastError: '' };
    const logFile = path.join(logDir(), name + '.log');
    // .bat / .cmd 不能直接 spawn（Node 18.20+ / 20.12+ 起要 shell），套一层 cmd /d /s /c；收尸照样按树收得到。
    const isBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(command);
    const exe = isBatch ? (process.env.ComSpec || 'cmd.exe') : command;
    const argvOf = (args) => (isBatch ? ['/d', '/s', '/c', `"${command}"${args.length ? ' ' + args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ') : ''}`] : args);
    const h = {
      name, pid: 0, state: 'starting', restarts: 0, lastExit: null, startedAt: 0, image: path.basename(exe).toLowerCase(),
      child: null, timer: null, stopping: false,
      on: (ev, fn) => { ee.on(ev, fn); return h; },
      tail: (n = 200) => tailFile(logFile, Math.max(1, Math.min(2000, n))),
      async stop() {
        h.stopping = true;
        clearTimeout(h.timer);
        const pid = h.pid;
        if (pid) await killTree(pid);
        h.state = 'stopped';
        h.pid = 0;
        writePids();
        ee.emit('state', h.state);
      },
      async restart() {
        await h.stop();
        if (!ctx.alive) return;
        h.stopping = false;
        h.restarts = 0;
        health.restarts = 0; health.fails = 0; health.ok = null;
        start();
      },
      info: () => ({
        name, state: h.state, pid: h.pid || null, restarts: h.restarts, lastExit: h.lastExit, since: h.startedAt || null,
        ...(hc ? { health: { ok: health.ok, fails: health.fails, restarts: health.restarts, lastCheck: health.lastCheck, lastError: health.lastError } } : {}),
      }),
    };
    // 健康检查：只在 running（或已判 unhealthy 但进程还在）时查；启动后 grace 内不判
    let checking = false;
    const healthTick = async () => {
      if (!hc || checking || !ctx.alive || h.stopping) return;
      if (h.state !== 'running' && h.state !== 'unhealthy') return;
      if (h.startedAt && Date.now() - h.startedAt < hc.grace) return;
      checking = true;
      let ok = false;
      try {
        ok = !!(await Promise.race([Promise.resolve().then(hc.check), new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('检查超时')), hc.timeout); t.unref?.(); })]));
        if (!ok) health.lastError = '检查没通过';
      } catch (e) { ok = false; health.lastError = String(e?.message || e).slice(0, 200); }
      finally { checking = false; }
      health.lastCheck = Date.now();
      if (!ctx.alive || h.stopping) return;
      if (ok) {
        const was = health.ok;
        health.ok = true; health.fails = 0; health.lastError = '';
        if (h.state === 'unhealthy') setState('running');
        if (h.startedAt && Date.now() - h.startedAt > STABLE_MS) health.restarts = 0;
        if (was === false) ee.emit('healthy', {});
        return;
      }
      health.ok = false;
      health.fails += 1;
      if (health.fails < hc.failAfter || h.state === 'unhealthy') return;
      if (health.restarts >= maxRestarts) {
        setState('unhealthy');
        log(`[bridge] ${new Date().toISOString()} 健康检查连续不过，已重启 ${health.restarts} 次仍不行，不再重启（${health.lastError}）\n`);
        ctx.warn(`子进程 ${name} 重启 ${health.restarts} 次后仍不健康：${health.lastError}`);
        ee.emit('unhealthy', { fails: health.fails, restarts: health.restarts, givenUp: true, error: health.lastError });
        return;
      }
      health.restarts += 1;
      log(`[bridge] ${new Date().toISOString()} 健康检查连续 ${health.fails} 次不过（${health.lastError}），重启（第 ${health.restarts} 次）\n`);
      ctx.warn(`子进程 ${name} 不健康（${health.lastError}），重启第 ${health.restarts} 次`);
      ee.emit('unhealthy', { fails: health.fails, restarts: health.restarts, givenUp: false, error: health.lastError });
      health.fails = 0;
      const keep = health.restarts;
      await h.stop();
      if (!ctx.alive) return;
      h.stopping = false;
      health.restarts = keep;
      start();
    };
    if (hc) {
      const timer = setInterval(() => { healthTick().catch(() => {}); }, hc.every);
      timer.unref?.();
      ctx.onDispose(() => clearInterval(timer));
    }
    const log = (s) => {
      try {
        mkdirSync(logDir(), { recursive: true });
        try { if (statSync(logFile).size > LOG_MAX) renameSync(logFile, logFile + '.1'); } catch {}
        appendFileSync(logFile, s);
      } catch {}
    };
    const setState = (s) => { h.state = s; ee.emit('state', s); };
    function start() {
      if (!ctx.alive || h.stopping) return;
      setState('starting');
      let child;
      let args = [];
      try {
        args = argsNow();
        child = spawn(exe, argvOf(args), {
          cwd: opts.cwd || ctx.dataDir,
          env: { ...process.env, ...envNow() },
          windowsHide: opts.hidden !== false,
          windowsVerbatimArguments: isBatch,
          detached: process.platform !== 'win32',   // 非 Windows：自成进程组，killTree 能整组收
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        log(`[bridge] 启动失败：${e?.message || e}\n`);
        onExit(null, null, e);
        return;
      }
      h.child = child;
      h.pid = child.pid || 0;
      h.startedAt = Date.now();
      log(`\n[bridge] ${new Date().toISOString()} 启动 ${command} ${args.join(' ')}（pid ${h.pid}）\n`);
      writePids();
      child.stdout?.on('data', (d) => { log(d.toString()); ee.emit('stdout', d); });
      child.stderr?.on('data', (d) => { log(d.toString()); ee.emit('stderr', d); });
      child.once('error', (e) => { log(`[bridge] 进程出错：${e?.message || e}\n`); });
      child.once('spawn', () => { if (h.child === child) setState('running'); });
      child.once('exit', (code, signal) => onExit(code, signal, null, child));
    }
    function onExit(code, signal, err, child) {
      if (child && h.child !== child) return;
      h.child = null;
      h.pid = 0;
      h.lastExit = err ? String(err.message || err) : signal ? signal : code;
      writePids();
      log(`[bridge] ${new Date().toISOString()} 退出（${signal ? '信号 ' + signal : '退出码 ' + code}）\n`);
      ee.emit('exit', { code, signal });
      if (h.stopping || !ctx.alive) { setState('stopped'); return; }
      const failed = !!err || signal != null || code !== 0;
      if (policy === 'never' || (policy === 'on-failure' && !failed)) { setState(failed ? 'failed' : 'stopped'); return; }
      if (h.startedAt && Date.now() - h.startedAt > STABLE_MS) h.restarts = 0;
      if (h.restarts >= maxRestarts) { setState('failed'); ctx.warn(`子进程 ${name} 连续重启 ${maxRestarts} 次仍失败，不再重启`); return; }
      const delay = Math.min(60_000, 1000 * 2 ** h.restarts);
      h.restarts += 1;
      setState('backoff');
      h.timer = setTimeout(start, delay);
      h.timer.unref?.();
    }
    procs.set(name, h);
    if (!cleaned) cleaned = cleanStale().catch(() => {});
    cleaned.then(() => { if (ctx.alive && procs.get(name) === h && !h.stopping) start(); });
    return h;
  }

  return {
    spawn: spawnManaged,
    get: (name) => procs.get(name) || null,
    list: () => [...procs.values()].map((h) => h.info()),
  };
}

export const _test = { tailFile, imageOf };
