// 服务控制：Linux 服务端上控制台的「服务控制」页靠这里——
// 看进程与机器的资源、最近日志；重启交给守护进程（systemd / Docker / pm2）重新拉起：本进程先把 dimensio 实例
// 排空（在跑的轮写明「服务重启」并落盘），再以 75（EX_TEMPFAIL）退出——systemd 的 Restart=always 与
// Restart=on-failure、Docker 的 restart 策略都会把它拉起来。没有守护进程时拒绝重启：退了就真停了。
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { listGens } from './gen.mjs';
import { PROGRAM_ROOT } from './paths.mjs';

export const RESTART_EXIT_CODE = 75;

// 谁在托管这个进程。显式声明（BRIDGE_SUPERVISED=systemd 之类，一键脚本写进单元文件）优先。
export function supervisor() {
  const declared = String(process.env.BRIDGE_SUPERVISED || '').trim();
  if (declared) return declared;
  if (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) return 'systemd';
  if (existsSync('/.dockerenv') || process.env.container === 'docker') return 'docker';
  if (process.env.pm_id != null || process.env.PM2_HOME) return 'pm2';
  return null;
}

const liveTurns = () => listGens().filter((g) => !g.done);

function disk(dir) {
  try {
    const s = statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

// ── 更新（控制台「服务控制 → 更新」）────────────────────────────────────────
// 只在「git 部署 + Linux + 有守护进程」时可用：以服务用户自己的身份跑 scripts/server/update.sh --no-restart
// （拉代码、装依赖、重建前端——代码目录本来就归服务用户），输出逐行进日志环；有新代码就接「空闲时重启」。
// Docker 部署不走这里（镜像要在宿主机上 docker compose up --build）。
const UPDATE_SH = path.join(PROGRAM_ROOT, 'scripts', 'server', 'update.sh');
const update = { running: false, startedAt: 0, finishedAt: 0, exitCode: null, result: '', head: '' };

export function updateAvailability() {
  // 部署脚本自带更新路径的形态（比如 Muse 的 tar 包部署）在单元里写明该怎么更新，控制台照原话显示
  const hint = String(process.env.BRIDGE_UPDATE_HINT || '').trim();
  if (hint) return hint;
  if (process.platform === 'win32') return '主机端走 git + admin.ps1，不在这里更新';
  if (supervisor() === 'docker') return 'Docker 部署：在服务器上 git pull && docker compose up -d --build';
  if (!supervisor()) return '没有守护进程托管，更新后没法自动重启';
  if (!existsSync(path.join(PROGRAM_ROOT, '.git'))) return '不是 git 部署（找不到 .git）';
  if (!existsSync(UPDATE_SH)) return '缺少 scripts/server/update.sh';
  return '';
}
export function updateState() { return { ...update, blocked: updateAvailability() }; }

export function startUpdate({ drain = null } = {}) {
  const why = updateAvailability();
  if (why) return { error: why };
  if (update.running) return { error: '已经在更新了' };
  Object.assign(update, { running: true, startedAt: Date.now(), finishedAt: 0, exitCode: null, result: '', head: '' });
  console.log('[update] 控制台发起更新：scripts/server/update.sh --no-restart');
  const child = spawn('bash', [UPDATE_SH, '--no-restart'], { cwd: PROGRAM_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (stream, warn) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, '');
        buf = buf.slice(i + 1);
        const m = /^BRIDGE_UPDATE_RESULT=(\w+)\s*(\S*)/.exec(line);
        if (m) { update.result = m[1]; update.head = m[2]; continue; }
        if (line.trim()) (warn ? console.warn : console.log)('[update] ' + line);
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);
  child.on('error', (e) => { update.running = false; update.exitCode = -1; update.finishedAt = Date.now(); console.error('[update] 起不来：' + (e?.message || e)); });
  child.on('close', (code) => {
    update.running = false; update.exitCode = code; update.finishedAt = Date.now();
    if (code !== 0) { console.error(`[update] 失败（退出码 ${code}），没有重启；看上面的日志`); return; }
    if (update.result === 'updated') {
      console.log('[update] 新代码已就位，等所有对话跑完就重启');
      requestRestart('idle', { drain });
    } else console.log('[update] 已经是最新，不用重启');
  });
  return { ok: true, update: updateState() };
}

export function serviceInfo({ dataRoot, harnessCount = 0 } = {}) {
  const m = process.memoryUsage();
  const turns = liveTurns();
  return {
    supervisor: supervisor(),
    platform: process.platform,
    pid: process.pid,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    rss: m.rss, heapUsed: m.heapUsed,
    loadavg: os.loadavg(), cpus: os.cpus().length,
    memTotal: os.totalmem(), memFree: os.freemem(),
    disk: dataRoot ? disk(dataRoot) : null,
    liveTurns: turns.length,
    liveKeys: [...new Set(turns.map((g) => g.key))].length,
    harnessInstances: harnessCount,
    restart: restartState(),
    update: updateState(),
  };
}

let idleTimer = null;
let idleSince = 0;
let going = false;
const IDLE_WAIT_MAX = 30 * 60 * 1000;

export function restartState() { return { pending: !!idleTimer, since: idleSince || 0, going }; }

function clearIdle() { if (idleTimer) clearInterval(idleTimer); idleTimer = null; idleSince = 0; }

// mode：'now' 立即（在跑的轮会被打断）| 'idle' 等到没有在跑的轮再重启（最多等 30 分钟，超时自动放弃）| 'cancel'。
// drain：退出前的排空（dimensio 实例），最多等 20 秒。
export function requestRestart(mode, { drain = null, exit = (c) => process.exit(c) } = {}) {
  if (mode === 'cancel') { clearIdle(); return { ok: true, restart: restartState() }; }
  if (!supervisor()) return { error: '没有守护进程托管（systemd / Docker / pm2），重启后不会自己起来——请在服务器上手动重启。' };
  if (going) return { ok: true, restart: restartState() };
  const go = () => {
    clearIdle();
    going = true;
    setTimeout(async () => {
      console.log('[service] 控制台请求重启：排空后退出，交给 ' + supervisor() + ' 拉起');
      try { if (drain) await Promise.race([drain(), new Promise((r) => setTimeout(r, 20_000))]); } catch {}
      exit(RESTART_EXIT_CODE);
    }, 600);
  };
  if (mode === 'idle' && liveTurns().length) {
    if (!idleTimer) {
      idleSince = Date.now();
      idleTimer = setInterval(() => {
        if (!liveTurns().length) go();
        else if (Date.now() - idleSince > IDLE_WAIT_MAX) { console.log('[service] 等空闲重启超过 30 分钟，已放弃'); clearIdle(); }
      }, 5000);
      idleTimer.unref?.();
    }
    return { ok: true, restart: restartState(), live: liveTurns().length };
  }
  go();
  return { ok: true, restart: restartState() };
}
