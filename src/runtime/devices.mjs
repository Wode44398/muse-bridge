// 设备的「对 agent 一侧」：归属检查、目标解析、派发。路由（routes/devices.mjs）与 agent 工具
// （mcp/device-tools.mjs）都经这里，不直接碰 device-control。
//
// 规则：
//   · 一台设备只给它的主人（owner = 身份 key）的 agent 用；管理员的排障口（/api/devices/op、rc.mjs）可以指任何设备。
//   · 会话「连接」到一台设备后，工具省略 device 参数就是它；没连接时，主人恰好只有一台在线设备就用那台。
//   · 设备自己报权限档（tier：off/observe/control）；这里只做提示与早拒，真正的硬闸在设备服务里。

import { pluginOr } from '../plugins/state.mjs';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { config } from '../config/index.mjs';
import { listDevices, deviceById } from './device-registry.mjs';
import { dispatch, isDeviceOnline, deviceRuntime } from './device-control.mjs';
import { deviceAudit } from './device-audit.mjs';
import { ownerAllows, logAccess, deniedMessage } from './admin-access.mjs';
import { isLocalDirect } from './host-secret.mjs';

/** 设备通道总开关：config.json devices=false 关掉（默认开）。 */
// 插件「设备」（plugins/catalog.mjs）：开关原是 config.json 的 devices，现在由插件管（默认值仍取 config.devices）。
export function devicesEnabled() {
  return process.env.BRIDGE_DEVICES !== '0' && pluginOr('devices', config.devices !== false);
}

// 本机指纹：和设备服务自报的 machineId 用同一算法（sha256('bridge-machine:' + 系统机器 id) 取前 32 位），
// 相等即「这台设备就是 bridge 所在的机器」——服务端装在自己电脑上时，Claude 的 Read/Bash 本来就作用在它上面。
// 10-21：以前第一次用到时同步 execFileSync('reg', …)（300–500ms，整个事件循环陪着等，每次重启后第一次列设备 / 第一轮对话
// 都卡一下）。现在异步取：启动时 server.mjs 调 primeServerMachineId() 预热；没取到之前 serverMachineId() 回 ''
//（sameMachine 那 0.3 秒里算 false，只影响展示和设备工具的说明文字），并顺手触发预热。
let machineIdMemo = null;
let machineIdPending = null;
export function primeServerMachineId() {
  if (machineIdMemo !== null) return Promise.resolve(machineIdMemo);
  if (machineIdPending) return machineIdPending;
  machineIdPending = (async () => {
    let raw = '';
    try {
      if (process.platform === 'win32') {
        const out = await new Promise((resolve) => {
          execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
        });
        raw = (/MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out) || [])[1] || '';
      } else {
        for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
          try { raw = (await fsp.readFile(f, 'utf8')).trim(); if (raw) break; } catch {}
        }
      }
    } catch {}
    if (!raw) raw = 'host:' + os.hostname();
    machineIdMemo = createHash('sha256').update('bridge-machine:' + raw.trim().toLowerCase()).digest('hex').slice(0, 32);
    machineIdPending = null;
    return machineIdMemo;
  })();
  return machineIdPending;
}
export function serverMachineId() {
  if (machineIdMemo !== null) return machineIdMemo;
  primeServerMachineId();
  return '';
}

/**
 * 这台设备就是 bridge 所在的电脑（服主自己那台）：挂上来时是本机直连（info.local，服务端判的，不是设备自报），
 * 或自报的机器指纹与本机相同；带上 req 时这次请求本身是本机直连也算。客户端更新据此分流（runtime/client-release.mjs）。
 */
export function onServerMachine(d, req = null) {
  if (req && isLocalDirect(req)) return true;
  const info = d ? (deviceRuntime(d.id).info || d.client || null) : null;
  if (!info) return false;
  if (info.local === true) return true;
  const mid = serverMachineId();
  return !!(mid && info.machineId && info.machineId === mid);
}

/**
 * 服务端所在电脑上那个在线、能远程更新的桌面客户端（打包形态的本机服务端就由它托管，更新它 = 连同服务端一起更新）。
 * 有多台取最近挂上来的；没有回 null。
 */
export function serverHostDevice() {
  let best = null, bestSince = -1;
  for (const d of listDevices({ owner: null })) {
    const rt = deviceRuntime(d.id);
    if (!rt.online || !rt.info || rt.info.shell !== 'desktop' || !rt.info.update || !onServerMachine(d)) continue;
    if (rt.since > bestSince) { best = d; bestSince = rt.since; }
  }
  return best;
}

/** 给前端 / 工具看的设备：注册信息 + 在线状态。不含令牌哈希与机器指纹。 */
export function publicDevice(d) {
  if (!d) return null;
  const rt = deviceRuntime(d.id);
  const info = rt.info || d.client || null;
  return {
    id: d.id,
    name: d.name,
    owner: d.owner,
    kind: d.kind,
    platform: d.platform || '',
    hostname: d.hostname || (info && info.hostname) || '',
    createdAt: d.createdAt || '',
    lastSeenAt: d.lastSeenAt || '',
    lastOnlineAt: d.lastOnlineAt || '',
    lastOfflineAt: d.lastOfflineAt || '',
    revoked: !!d.revoked,
    sameMachine: !!(info && info.machineId && info.machineId === serverMachineId()),
    online: rt.online,
    since: rt.since,
    inflight: rt.inflight,
    lastOp: rt.lastOp,
    lastOpAt: rt.lastOpAt,
    client: info ? {
      version: info.version || '', os: info.os || '', user: info.user || '',
      tier: info.tier || (info.desktop ? 'control' : (info.remote ? 'workspace' : '')),
      caps: Array.isArray(info.caps) ? info.caps : [],
      shell: info.shell || '',
      update: !!info.update,
    } : null,
  };
}

/** 这个身份自己的设备（含在线状态），在线的排前面。 */
export function ownDevices(ctx) {
  if (!ctx || !ctx.key) return [];
  return listDevices({ owner: ctx.key }).map(publicDevice)
    .sort((a, b) => (b.online - a.online) || String(b.lastOnlineAt).localeCompare(String(a.lastOnlineAt)));
}

/**
 * 解析工具要操作的设备。want = 工具参数里的 id 或名字；linked = 会话连接的设备 id。
 * 返回 { device } 或 { error }（error 是给 agent 看的可读说明）。
 */
export function resolveDevice(ctx, { want = '', linked = '' } = {}) {
  const mine = ownDevices(ctx);
  if (!mine.length) return { error: '你还没有可用的设备。要让我操作你的电脑：在电脑上装 bridge 桌面客户端并登录同一个账号（登录即自动登记）。' };
  const pick = (key) => mine.find((d) => d.id === key) || mine.find((d) => d.name === key) || mine.find((d) => d.name.toLowerCase() === String(key).toLowerCase());
  let d = null;
  if (want) {
    d = pick(want);
    if (!d) return { error: `找不到设备「${want}」。你的设备：${mine.map((x) => `${x.name}[${x.id}]${x.online ? '' : '（离线）'}`).join('、')}` };
  } else if (linked === 'none') {
    return { error: '这个会话设成了「不连接设备」——请用户在输入框下方的设备芯片里选一台，或者调 devices(use=设备名) 连上。' };
  } else if (linked) {
    d = mine.find((x) => x.id === linked) || null;
    if (!d) return { error: '这个会话连接的设备已经不存在了（被删除或吊销）——请在输入框下方的设备芯片里重新选。' };
  } else {
    const online = mine.filter((x) => x.online);
    if (online.length === 1) d = online[0];
    else if (!online.length) return { error: '你的设备都不在线（桌面客户端没开，或在客户端里关掉了「允许 agent 操作这台电脑」）。' };
    else return { error: `你有 ${online.length} 台设备在线，请在 device 参数里指定一台：${online.map((x) => `${x.name}[${x.id}]`).join('、')}` };
  }
  if (!d.online) return { error: `设备「${d.name}」当前离线（桌面客户端没开，或对方关掉了「允许 agent 操作这台电脑」）。` };
  return { device: d };
}

// 终端（pty.*）与端口转发（http.*）只能经各自的模块派（runtime/device-term.mjs、device-forward.mjs）：
// 设备侧对「已开着的终端里打字」不再逐条问人，所以绝不能让 agent 的工具 / 内部接口 / 排障口直接发 pty.write。
const CHANNEL_OPS = [['pty.', 'terminal'], ['http.', 'forward']];

/**
 * 派一条 op 到设备并等结果。ctx 决定归属：非管理员只能派到自己的设备；管理员默认也只派自己的，
 * opts.anyOwner=true（排障口）才能指别人的。opts.channel 见上面的 CHANNEL_OPS。
 */
export async function deviceDispatch(ctx, deviceId, op, args = {}, { timeoutMs = 60_000, onChunk = null, by = 'agent', session = '', title = '', anyOwner = false, channel = '', signal = null, audit = true } = {}) {
  const d = deviceById(String(deviceId || ''));
  if (!d || d.revoked) throw new Error('设备不存在或已被吊销');
  const admin = ctx && ctx.kind === 'admin';
  if (d.owner !== (ctx && ctx.key) && !(admin && (anyOwner || by === 'admin' || by === 'rc'))) throw new Error('这台设备不属于你');
  // 管理员对成员的电脑（截屏 / 系统信息 / 派操作）：要那个成员在自己设置里允许过（开源路线 S2-7，runtime/admin-access.mjs）。
  // 例外：控制台「远程更新」（client.update）只是让 bridge 客户端自己升级、不看也不碰他电脑上的东西，不用他允许——照样在他那边记一笔。
  const crossOwner = admin && d.owner !== ctx.key;
  if (crossOwner && op !== 'client.update' && !ownerAllows(d.owner, 'device')) throw new Error(deniedMessage('device'));
  if (!op) throw new Error('缺 op');
  for (const [prefix, ch] of CHANNEL_OPS) if (String(op).startsWith(prefix) && channel !== ch) throw new Error(`${op} 只能经${ch === 'terminal' ? '终端面板' : '端口转发'}使用`);
  if (!isDeviceOnline(d.id)) throw new Error(`设备「${d.name}」当前离线`);
  if (crossOwner) logAccess(d.owner, { action: 'device', what: d.name, detail: String(op).slice(0, 40) });
  const meta = { by, ...(session ? { session } : {}), ...(title ? { title: String(title).slice(0, 80) } : {}) };
  // 终端按键、转发的每个请求量大且是人在用：不逐条进审计（开终端 / 建转发由各自模块记一条）
  if (!audit) return dispatch(d.id, op, args, { timeoutMs, onChunk, signal, meta });
  const t0 = Date.now();
  try {
    const r = await dispatch(d.id, op, args, { timeoutMs, onChunk, signal, meta });
    deviceAudit({ ev: 'op', device: d.id, op, by, ...(session ? { session } : {}), ms: Date.now() - t0, ok: true });
    return r;
  } catch (e) {
    deviceAudit({ ev: 'op', device: d.id, op, by, ...(session ? { session } : {}), ms: Date.now() - t0, ok: false, err: String(e?.message || e).slice(0, 120) });
    throw e;
  }
}

/** 某身份当前有没有在线设备（决定要不要给这一轮注入设备工具）。 */
export function hasOnlineDevice(ctx) {
  return ownDevices(ctx).some((d) => d.online);
}

export { isDeviceOnline };
