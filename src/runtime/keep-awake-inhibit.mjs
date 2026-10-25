// 保持唤醒的 Linux 实现（开源路线 S1-7）：systemd-inhibit 持有一把 block 型的 sleep:idle 抑制锁。
//
// 驱动接口与 keep-awake.mjs 的 Windows 驱动一致：{ pid, onExit, hold(on), ask(cmd), onBattery(), close(), alive() }，
// keep-awake.mjs 的 makeDriver 在 Linux（非容器）上换成 inhibitDriver() 即可，状态机一行不用改。
//   hold(true)   起一个 `systemd-inhibit --what=sleep:idle --mode=block --who=… --why=… cat`：锁跟着这个子进程活；
//                子进程 400ms 内就退了 = 没拿到锁（没有 logind、polkit 拒绝等），回 false
//   hold(false)  结束它（锁随之释放）
//   onBattery()  读 /sys/class/power_supply：有交流电源在线 → false；只有电池 → true；读不出来（台式机、虚拟机）→ false
// 跟着 bridge 走（和 Windows 驱动「stdin 读到 EOF 就自己退出」同一个办法）：被抑制的命令是 `cat`，标准输入是接到本进程的
// 管道、我们从不往里写——本进程不管怎么死的（SIGKILL、OOM、原生模块崩溃，exit 钩子来不及跑），管道写端随之关闭，cat 读到
// EOF 退出，systemd-inhibit 跟着退出、锁随之释放。不靠 exit 钩子，也不靠 systemd 的 cgroup（源码直跑、pm2、nohup 都没有）。
// 正常放锁：关管道 + SIGTERM（systemd-inhibit 被结束时会给子进程发 SIGTERM）。
// 没有 systemd-inhibit（容器、非 systemd 的发行版）→ inhibitDriver() 回 null，keep-awake 照旧什么都不做。
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { whichSync } from './which.mjs';

const WHO = 'The Bridge';
const WHY = 'Claude 正在工作（有轮在跑）';

// 被拒之后歇一阵再试：系统服务的 bridge 用户、开了 linger 但没登录的用户服务，在 polkit 眼里都不是「活动会话」，
// 默认策略不给 block 型睡眠锁——每有一轮开跑就起一个注定马上退出的子进程没意义。只在第一次被拒时说一声。
const DENY_BACKOFF_MS = 10 * 60_000;
let deniedUntil = 0;
let deniedLogged = false;
/** 单测用：清掉「被拒过」的记忆。 */
export function _resetInhibitDenied() { deniedUntil = 0; deniedLogged = false; }

/** systemd-inhibit 的参数：被抑制的命令是 `cat`（读标准输入直到 EOF——本进程死了它就退出，见文件头）。 */
export function inhibitArgs() {
  return ['--what=sleep:idle', '--mode=block', '--who=' + WHO, '--why=' + WHY, 'cat'];
}

/** /sys/class/power_supply 下的电源状态：true = 只靠电池，false = 插着电或没有电池，null = 读不出来。 */
export function readOnBattery(root = '/sys/class/power_supply') {
  let names;
  try { names = readdirSync(root); } catch { return null; }
  let sawMains = false, mainsOnline = false, sawBattery = false;
  for (const n of names) {
    const rd = (f) => { try { return readFileSync(path.join(root, n, f), 'utf8').trim(); } catch { return ''; } };
    const type = rd('type');
    if (type === 'Mains' || type === 'USB' || type === 'USB_C' || type === 'USB_PD') {
      sawMains = true;
      if (rd('online') === '1') mainsOnline = true;
    } else if (type === 'Battery') {
      if (rd('scope') !== 'Device') sawBattery = true;   // 无线鼠标之类的「设备电池」不算
    }
  }
  if (mainsOnline) return false;
  if (sawBattery && sawMains) return true;
  if (sawBattery) {
    // 只有电池条目、没有交流适配器条目：看电池自己报的状态
    for (const n of names) {
      try {
        if (readFileSync(path.join(root, n, 'type'), 'utf8').trim() !== 'Battery') continue;
        const st = readFileSync(path.join(root, n, 'status'), 'utf8').trim();
        if (st === 'Discharging') return true;
      } catch {}
    }
    return false;
  }
  return sawMains ? false : null;
}

/**
 * @param {object} [o]
 * @param {string|null} [o.bin]       systemd-inhibit 路径（默认在 PATH 里找；找不到 → 回 null）
 * @param {string[]} [o.argv]         单测用：整条命令换成别的（[可执行文件, ...参数]）
 * @param {string} [o.powerRoot]      单测用：电源目录
 * @param {number} [o.graceMs]        起来后撑过这么久没退出才算拿到锁（systemd-inhibit 被拒时几乎立刻退出）
 * @param {number} [o.denyBackoffMs]  被拒之后多久内不再起子进程（模块级记忆，keep-awake 重建驱动也不清）
 */
export function inhibitDriver({ bin = undefined, argv = null, powerRoot = '/sys/class/power_supply', graceMs = 400, denyBackoffMs = DENY_BACKOFF_MS } = {}) {
  const exe = argv ? argv[0] : (bin === undefined ? whichSync('systemd-inhibit') : bin);
  if (!exe) return null;
  const args = argv ? argv.slice(1) : inhibitArgs();
  let child = null;
  let closed = false;

  const stop = () => {
    const c = child;
    child = null;
    if (!c) return;
    try { c.stdin && c.stdin.end(); } catch {}
    if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGTERM'); } catch {} }
  };
  const onProcessExit = () => stop();
  process.on('exit', onProcessExit);

  const drv = {
    pid: null,
    onExit: null,
    async hold(on) {
      if (closed) return false;
      if (!on) { stop(); drv.pid = null; return true; }
      if (child) return true;
      if (Date.now() < deniedUntil) return false;
      // stdin 接管道且从不写：本进程一死管道断开，被抑制的 cat 读到 EOF 退出、锁随之释放（见文件头）
      const c = spawn(exe, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: false });
      if (c.stdin) c.stdin.on('error', () => {});   // 子进程先退了再关管道会 EPIPE，不要紧
      child = c;
      drv.pid = c.pid || null;
      // 刚起就退了：没拿到锁
      const ok = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        c.once('error', () => done(false));
        c.once('exit', () => done(false));
        setTimeout(() => done(true), graceMs);
      });
      if (!ok) {
        if (child !== c) return false;   // 等待期间被我们自己放掉了（hold(false) / close），不算被拒
        child = null;
        drv.pid = null;
        deniedUntil = Date.now() + denyBackoffMs;
        if (!deniedLogged) {
          deniedLogged = true;
          console.log('[keep-awake] systemd-inhibit 没拿到睡眠锁（没有活动的登录会话，或 polkit 不允许）：这次不阻止睡眠，'
            + Math.max(1, Math.round(denyBackoffMs / 60_000)) + ' 分钟后再试');
        }
        return false;
      }
      // 拿着锁时子进程自己没了（logind 重启、被人杀了）：锁已经丢了。按 Windows 驱动的约定当「驱动死了」报给
      // keep-awake（onExit + alive() 变 false），它下一次评估时会重建驱动、重新要锁。我们自己 stop() 的不算——那时 child 已置空。
      c.once('exit', () => {
        if (child !== c) return;
        child = null;
        drv.pid = null;
        if (!closed) {
          closed = true;
          process.removeListener('exit', onProcessExit);
          if (drv.onExit) drv.onExit();
        }
      });
      return true;
    },
    async ask(cmd) {
      if (cmd === 'power') { const b = readOnBattery(powerRoot); return b === null ? 'ac=?' : 'ac=' + (b ? 0 : 1); }
      return child ? 'holding pid=' + child.pid : 'idle';
    },
    async onBattery() { return readOnBattery(powerRoot); },
    close() {
      if (closed) return;
      closed = true;
      stop();
      process.removeListener('exit', onProcessExit);
      if (drv.onExit) drv.onExit();
    },
    alive: () => !closed,
  };
  return drv;
}
