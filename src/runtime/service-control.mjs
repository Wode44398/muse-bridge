// 服务控制（三端拆分 P4）：Linux 服务端 / Docker / Windows 计划任务托管的服务端上没有 admin.ps1，也没有桌面壳，
// 控制台的「服务控制」页靠这里——看进程与机器的资源、最近日志；重启交给守护进程（systemd / Docker / pm2 /
// Windows 的 scripts/server/win/bridge-service.mjs）重新拉起：本进程先把 dimensio 实例排空（在跑的轮写明「服务重启」
// 并落盘），再以 75（EX_TEMPFAIL）退出——systemd 的 Restart=always 与 Restart=on-failure、Docker 的 restart 策略、
// Windows 启动器（见 75 立即拉起）都会把它拉起来。没有守护进程时拒绝重启：退了就真停了。
//
// 开源路线 S1-5「更新不把自己踢下线」：重启带上原因（restart | update）。挂起、动手、取消、超时放弃都推给所有在线设备
// （总线 {type:'server.restart'}，见 restartEvent），手机和网页据此说「服务器有 N 个对话在跑，跑完后自动更新」「服务器正在更新，
// 稍后自动重连」，而不是一声不响地掉线。桌面客户端托管的本机服务端装更新也走这里：壳以 reason:'update' 请求「空闲时重启」，
// 本进程等所有人的轮跑完、排空后以 75 退出，壳接住这次退出去跑安装器（client/desktop/main.cjs 的 installUpdate）。
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { listGens } from './gen.mjs';
import { PROGRAM_ROOT } from './paths.mjs';
import { busPublishAll } from './bus.mjs';
import { APP_VERSION_NAME } from '../config/versions.mjs';

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
// 只在「git 部署 + 有守护进程」时可用：以服务用户自己的身份跑更新脚本的「不重启」模式（拉代码、装依赖、重建前端——
// 代码目录本来就归服务用户），输出逐行进日志环；有新代码就接「空闲时重启」。
//   Linux：scripts/server/update.sh --no-restart（systemd / pm2 托管）。
//   Windows：scripts/server/update.ps1 -NoRestart，只认 scripts/server/win/bridge-service.mjs 托管（BRIDGE_SUPERVISED=windows）：
//     跑着的服务端锁着程序根 / harness 的 node_modules，这两处的依赖由启动器在两条命之间装，换别的托管方式没人接这一棒。
//     老的 admin.ps1 + task-server.vbs 部署（维护者的主机）没有守护进程，照旧不在这里更新。
// Docker 部署不走这里（镜像要在宿主机上 docker compose up --build）。
const UPDATE_SH = path.join(PROGRAM_ROOT, 'scripts', 'server', 'update.sh');
const UPDATE_PS1 = path.join(PROGRAM_ROOT, 'scripts', 'server', 'update.ps1');
const update = { running: false, startedAt: 0, finishedAt: 0, exitCode: null, result: '', head: '' };

// 更新命令（按平台）。两个脚本最后都打一行 BRIDGE_UPDATE_RESULT=updated|unchanged <提交>，解析同一套。
export function updateCommand(platform = process.platform) {
  if (platform === 'win32') return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UPDATE_PS1, '-NoRestart']];
  return ['bash', [UPDATE_SH, '--no-restart']];
}

export function updateAvailability(platform = process.platform) {
  // 部署脚本自带更新路径的形态（比如 Muse Bridge 的 tar 包 + 发布目录部署）在服务单元里写明该怎么更新，控制台照原话显示
  const hint = String(process.env.BRIDGE_UPDATE_HINT || '').trim();
  if (hint) return hint;
  // 桌面客户端托管的本机服务端（壳设 BRIDGE_SUPERVISED=desktop）：程序随客户端安装包一起换，不在这里拉代码。
  // 控制台可能是从手机远程打开的：说清是「那台电脑上的桌面客户端」，路径同桌面设置（SettingsDesktop）的「连接与更新」页。
  if (supervisor() === 'desktop') return '由桌面客户端托管：在那台电脑的桌面客户端里「设置 › 连接与更新 › 软件更新」更新（服务端随客户端安装包一起换）';
  if (platform === 'win32') {
    if (supervisor() !== 'windows') return '没有被 Windows 启动器托管（老的计划任务部署走 git + admin.ps1，不在这里更新）；要在控制台更新，用 scripts/server/install-windows.ps1 装成计划任务';
    if (!existsSync(path.join(PROGRAM_ROOT, '.git'))) return '不是 git 部署（找不到 .git）';
    if (!existsSync(UPDATE_PS1)) return '缺少 scripts/server/update.ps1';
    return '';
  }
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
  const [cmd, args] = updateCommand();
  console.log('[update] 控制台发起更新：' + (process.platform === 'win32' ? 'scripts/server/update.ps1 -NoRestart' : 'scripts/server/update.sh --no-restart'));
  const child = spawn(cmd, args, { cwd: PROGRAM_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const pipe = (stream, warn) => {
    let buf = '';
    stream.setEncoding('utf8');   // 中文跨块到达时不切坏
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '').replace(/\x1b\[[0-9;]*m/g, '');   // PowerShell 的行尾是 CRLF
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
      requestRestart('idle', { drain, reason: 'update', version: String(update.head || '').slice(0, 12) });
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
let lastLive = 0;
// 这次挂起 / 动手的原因：'restart'（控制台重启、扩展装卸后重启）| 'update'（装更新：git 部署拉完新代码、桌面客户端要装新版）
let pendingReason = 'restart';
let pendingVersion = '';   // 'update' 时要换成的版本（桌面客户端的版本号 / git 提交），只用于提示
let publish = defaultPublish;
export const IDLE_WAIT_MAX = 30 * 60 * 1000;

function defaultPublish(ev) { try { busPublishAll(ev); } catch {} }
const cleanReason = (r) => (r === 'update' ? 'update' : 'restart');
const cleanVersion = (v) => String(v || '').replace(/[^\w.+-]/g, '').slice(0, 40);

export function restartState() {
  const pending = !!idleTimer;
  const active = pending || going;
  return {
    pending, since: idleSince || 0, going,
    reason: active ? pendingReason : '',
    version: active ? pendingVersion : '',
    deadline: pending ? idleSince + IDLE_WAIT_MAX : 0,
    live: pending ? liveTurns().length : 0,
  };
}

// 推给所有在线设备（含普通成员与快照访客：服务器要停一下，谁都该知道）。不带任何凭据，只有原因、要换的版本、在跑的轮数。
//   phase：'pending' 挂起等空闲（live = 还剩几轮）| 'going' 马上排空退出 | 'cancelled' 取消了 | 'expired' 等了 30 分钟还有轮在跑，放弃
//   current：现在这个进程的版本——重连后版本号不同，前端就说「服务器已更新到 x」
export function restartEvent(phase, extra = {}) {
  return { type: 'server.restart', phase, reason: pendingReason, version: pendingVersion, current: APP_VERSION_NAME, at: Date.now(), ...extra };
}
const emit = (phase, extra) => publish(restartEvent(phase, extra));

function clearIdle(phase = '') {
  const had = !!idleTimer;
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null; idleSince = 0; lastLive = 0;
  if (had && phase) emit(phase);
}

// mode：'now' 立即（在跑的轮会被打断）| 'idle' 等到没有在跑的轮再重启（最多等 30 分钟，超时自动放弃）| 'cancel'。
// drain：退出前的排空（dimensio 实例），最多等 20 秒。reason / version：见上（只影响提示与日志，退出码都是 75）。
// publish：测试注入；默认推总线。
export function requestRestart(mode, { drain = null, exit = (c) => process.exit(c), reason = 'restart', version = '', publish: pub = null } = {}) {
  if (pub) publish = pub;
  if (mode === 'cancel') {
    if (idleTimer) console.log('[service] 已取消等待' + (pendingReason === 'update' ? '更新' : '重启'));
    clearIdle('cancelled');
    return { ok: true, restart: restartState() };
  }
  if (!supervisor()) return { error: '没有守护进程托管（systemd / Docker / pm2），重启后不会自己起来——请在服务器上手动重启。' };
  if (going) return { ok: true, restart: restartState() };
  // 已经挂着一个「空闲时重启」又来一个更新请求：按更新说（更新本来就要重启）；反过来不降级
  if (!idleTimer || cleanReason(reason) === 'update') { pendingReason = cleanReason(reason); pendingVersion = cleanVersion(version); }
  const go = () => {
    clearIdle();
    going = true;
    emit('going', { live: 0 });
    setTimeout(async () => {
      console.log('[service] ' + (pendingReason === 'update' ? '为装更新' : '控制台请求') + '重启：排空后退出，交给 ' + supervisor() + ' 拉起');
      try { if (drain) await Promise.race([drain(), new Promise((r) => setTimeout(r, 20_000))]); } catch {}
      exit(RESTART_EXIT_CODE);
    }, 600);
  };
  const live = liveTurns().length;
  if (mode === 'idle' && live) {
    if (!idleTimer) {
      idleSince = Date.now();
      lastLive = live;
      console.log(`[service] 还有 ${live} 轮在跑，等跑完再${pendingReason === 'update' ? '更新' : '重启'}（最多等 30 分钟）`);
      idleTimer = setInterval(() => {
        const n = liveTurns().length;
        if (!n) go();
        else if (Date.now() - idleSince > IDLE_WAIT_MAX) { console.log('[service] 等空闲' + (pendingReason === 'update' ? '更新' : '重启') + '超过 30 分钟，已放弃'); clearIdle('expired'); }
        else if (n !== lastLive) { lastLive = n; emit('pending', { live: n, since: idleSince, deadline: idleSince + IDLE_WAIT_MAX }); }
      }, 5000);
      idleTimer.unref?.();
    }
    emit('pending', { live, since: idleSince, deadline: idleSince + IDLE_WAIT_MAX });
    return { ok: true, restart: restartState(), live };
  }
  go();
  return { ok: true, restart: restartState() };
}
