// Claude 工作时保持唤醒（官方 Desktop「Keep computer awake while Claude works」/「Keep awake on battery power」，
// 2026-10-20）。主机级设置 keepAwake / keepAwakeOnBattery（config.json 的 claudeHost，仅管理员可改）。
//
// 语义（与官方一致）：有 Claude 轮在跑（含后台任务挂起中的轮）时阻止系统【空闲】睡眠，屏幕照常可以关；
// 合上笔记本盖子、手动睡眠不拦。全部轮收尾后再撑约 1 分钟才放手（紧接着的下一轮、自动续跑不必反复抓放）。
// 「使用电池时也保持唤醒」关着时：拔了电源就放手，插回去再抓（在跑期间每分钟看一次电源）。
//
// 实现：Windows 上起一个常驻小 PowerShell 子进程，用 SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)
// 持有唤醒请求（powercfg /requests 里能看到它挂在 SYSTEM 下），按行收命令：on / off / power（回电源状态）。
// 子进程必须跟着 bridge 走——① 读 stdin 读到 EOF（父进程退出 / 被杀，管道一断）就清掉请求自己退出；
// ② 父进程 exit 钩子按 PID taskkill /T /F 兜底；③ 放手时直接关掉它，不留闲置进程。
// 非 Windows 平台不做（no-op）。
//
// 挂点：gen.mjs 的在跑台账（onLiveGensChange，只数 Claude 的轮，排除 codex:）+ 主机设置变化（onClaudeHostSettings）
// + 不走 gen 的 Claude 运行（Routines 定时任务直接调 query()）用 holdKeepAwake() 计数。
//
// 状态分两层：wanted 只由「在跑的数量 + 收尾余量期」决定；设置开关 / 电池只决定 wanted 时要不要真向系统要唤醒。
// 所以设置关掉只放掉请求、不动 wanted——轮还在跑时再打开，立刻重新抓（「主机设置变化即时生效」两个方向都成立）。
import { spawn, spawnSync } from 'node:child_process';
import { onLiveGensChange, countLiveGens } from './gen.mjs';
import { claudeHostSettings, onClaudeHostSettings } from './claude-settings.mjs';

let LINGER_MS = 60_000;       // 最后一轮收尾后再撑多久
let POWER_POLL_MS = 60_000;   // 在跑期间看电源的间隔（只在「电池时也保持」关着时轮询）

// PowerShell 端：行协议，一条命令回一行。ES_CONTINUOUS=0x80000000、ES_SYSTEM_REQUIRED=0x00000001；
// on/off 回「ok <本线程之前的状态>」（冒烟时据此确认请求真挂在这条线程上）。
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace BridgeKeepAwake -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
[StructLayout(LayoutKind.Sequential)] public struct PowerStatus { public byte AC; public byte Flag; public byte Pct; public byte Saver; public int Life; public int Full; }
[DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out PowerStatus s);
'@
$out = [Console]::Out
$out.WriteLine('ready'); $out.Flush()
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($l -eq $null) { break }
  switch ($l.Trim()) {
    'on'    { $p = [BridgeKeepAwake.Native]::SetThreadExecutionState([uint32]2147483649); $out.WriteLine('ok ' + $p.ToString('X8')) }
    'off'   { $p = [BridgeKeepAwake.Native]::SetThreadExecutionState([uint32]2147483648); $out.WriteLine('ok ' + $p.ToString('X8')) }
    'power' { $s = New-Object BridgeKeepAwake.Native+PowerStatus; [void][BridgeKeepAwake.Native]::GetSystemPowerStatus([ref]$s); $out.WriteLine('ac=' + $s.AC + ' flag=' + $s.Flag) }
    default { $out.WriteLine('?') }
  }
  $out.Flush()
}
[void][BridgeKeepAwake.Native]::SetThreadExecutionState([uint32]2147483648)
`;

// —— Windows 驱动：一个子进程 + 请求/应答队列 ——
function winDriver() {
  const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  const waiters = [];   // 等回应的 resolve，按发送顺序
  let buf = '', dead = false, ready = false;
  const readyP = new Promise((resolve) => { waiters.push((line) => { ready = line === 'ready'; resolve(ready); }); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(line);
    }
  });
  const onGone = () => { dead = true; while (waiters.length) waiters.shift()(null); if (drv.onExit) drv.onExit(); };
  child.on('exit', onGone);
  child.on('error', onGone);
  child.stdin.on('error', () => {});
  const ask = (cmd) => new Promise((resolve) => {
    if (dead) return resolve(null);
    waiters.push(resolve);
    try { child.stdin.write(cmd + '\n'); } catch { resolve(null); }
  });
  const drv = {
    pid: child.pid,
    onExit: null,
    async hold(on) { if (!(await readyP)) return false; return /^ok\b/.test((await ask(on ? 'on' : 'off')) || ''); },
    async ask(cmd) { if (!(await readyP)) return null; return ask(cmd); },
    // true = 在用电池；false = 插着电（或台式机没有电池）；null = 读不出来
    async onBattery() {
      if (!(await readyP)) return null;
      const r = await ask('power');
      const m = /ac=(\d+)/.exec(r || '');
      if (!m) return null;
      const ac = Number(m[1]);
      return ac === 0 ? true : ac === 1 ? false : null;
    },
    close() {
      if (dead) return;
      // 关 stdin → 脚本读到 EOF，清掉请求后自己退；3 秒没退再按 PID 整树结束
      try { child.stdin.end(); } catch {}
      const t = setTimeout(() => { if (!dead) killTree(child.pid); }, 3000);
      if (t.unref) t.unref();
    },
    alive: () => !dead,
  };
  return drv;
}

function killTree(pid) {
  if (!pid) return;
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch {}
}

let makeDriver = () => (process.platform === 'win32' ? winDriver() : null);

// —— 状态机 ——
let drv = null;
let holding = false;          // 已经向系统要了唤醒
let wanted = false;           // 现在该不该要（有轮在跑或在余量期内）
let lingerTimer = null, pollTimer = null;
let started = false;
let seq = 0;                  // 并发的 evaluate 只让最新那次落定
let external = 0;             // 不走 gen 台账的 Claude 运行（holdKeepAwake，目前是 Routines 定时任务）

const liveClaude = () => countLiveGens((key) => !String(key).startsWith('codex:')) + external;

// 放掉唤醒请求、关掉子进程（不动 wanted / 余量计时：那只由在跑数量决定）
function drop(why) {
  clearInterval(pollTimer); pollTimer = null;
  if (drv) {
    const d = drv; drv = null;
    if (holding) d.hold(false).catch(() => {});
    d.close();
  }
  if (holding) console.log(`[keep-awake] released (${why})`);
  holding = false;
}

// 真闲下来了（余量期走完、没有在跑的）：不再想要，并放掉
function release(why) {
  clearTimeout(lingerTimer); lingerTimer = null;
  wanted = false;
  drop(why);
}

async function apply() {
  const my = ++seq;
  const hs = claudeHostSettings();
  if (!hs.keepAwake) { drop('setting off'); return; }
  if (!wanted) { drop('idle'); return; }
  if (!drv) {
    drv = makeDriver();
    if (!drv) return;   // 非 Windows：不做
    drv.onExit = () => { if (drv && !drv.alive()) { drv = null; holding = false; } };
  }
  let want = true;
  if (!hs.keepAwakeOnBattery) {
    const bat = await drv.onBattery().catch(() => null);
    if (my !== seq) return;
    if (bat === true) want = false;
    if (!pollTimer) {
      pollTimer = setInterval(() => { apply().catch(() => {}); }, POWER_POLL_MS);
      if (pollTimer.unref) pollTimer.unref();
    }
  } else if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (my !== seq || !drv) return;
  if (want === holding) return;
  const ok = await drv.hold(want).catch(() => false);
  if (my !== seq) return;
  if (ok) {
    holding = want;
    console.log(want ? `[keep-awake] holding (${liveClaude()} live turn(s))` : '[keep-awake] paused (on battery)');
  }
}

function onLive() {
  const n = liveClaude();
  if (n > 0) {
    clearTimeout(lingerTimer); lingerTimer = null;
    if (!wanted) { wanted = true; apply().catch(() => {}); }
    return;
  }
  if (!wanted || lingerTimer) return;
  lingerTimer = setTimeout(() => { lingerTimer = null; if (liveClaude() === 0) release('idle'); }, LINGER_MS);
  if (lingerTimer.unref) lingerTimer.unref();
}

/** 服务启动时调一次：挂上在跑台账与主机设置的观察者、注册退出收尸。 */
export function initKeepAwake() {
  if (started) return;
  started = true;
  onLiveGensChange(onLive);
  // 主机设置变化：按此刻在跑的数量重算一次再落定（关 → 开时轮还在跑，要立刻重新抓）
  onClaudeHostSettings(() => { if (liveClaude() > 0) { clearTimeout(lingerTimer); lingerTimer = null; wanted = true; } apply().catch(() => {}); });
  // 父进程退出兜底：stdin 断了子进程本会自退，这里再按 PID 整树结束一次（同步，exit 钩子里只能同步）
  process.on('exit', () => { if (drv && drv.pid) killTree(drv.pid); });
  onLive();
}

/**
 * 不登记 gen 的 Claude 运行（Routines 定时任务）开跑时调：计入「在跑」，返回放手函数（收尾时调，重复调无害）。
 * 没 initKeepAwake 的进程（单测、脚本）只计数，不起子进程。
 */
export function holdKeepAwake() {
  external++;
  if (started) onLive();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    external = Math.max(0, external - 1);
    if (started) onLive();
  };
}

/** 状态（单测 / 调试）。 */
export function keepAwakeState() { return { wanted, holding, pid: drv ? drv.pid || null : null, live: liveClaude() }; }

// —— 单测钩子：换驱动、缩短时长 ——
export function _setKeepAwakeDriver(factory, { lingerMs, pollMs } = {}) {
  if (factory) makeDriver = factory;   // 不传 = 保留平台驱动，只改时长（冒烟用）
  if (lingerMs != null) LINGER_MS = lingerMs;
  if (pollMs != null) POWER_POLL_MS = pollMs;
}
export function _keepAwakeApply() { return apply(); }
export function _keepAwakeAsk(cmd) { return drv && drv.ask ? drv.ask(cmd) : Promise.resolve(null); }
