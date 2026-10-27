// 设备：用户自己的电脑。Claude 跑在服务端，用户的电脑经桌面客户端登录即登记成「设备」，
// 会话连上一台后，Claude 就能经 mcp__device__* 看它的屏幕、操作它（由设备端的权限档硬拦）。
// 后端：src/routes/devices.mjs。总线 {type:'devices', id, online} 推来就刷新在线状态。
//
// 会话连接哪台设备：
//   · 新会话：输入框下方设备芯片里的选择（draft）随第一条消息带上（chatParams.computer）；
//     没选过（auto）时服务端默认连「发起这一轮的那台桌面客户端」。
//   · 进行中的会话：芯片改选 → POST /api/devices/link，立刻生效（工具每次调用现读）。
import { api } from './api.js';
import { busOn } from './bus.js';
import { getServerBase } from './server.js';
import { isNativeDesktop } from './nativeDesktop.js';

export const devices = $state({
  loaded: false,
  enabled: true,      // 服务端开着设备通道
  list: [],           // 自己的设备（在线的排前）
  err: '',
  link: { sessionId: '', value: '' },   // 当前会话连接的设备 id / 'none' / ''（自动）
  draft: 'auto',      // 新会话的选择：'auto' | 设备 id | 'none'
});

let loading = null;
const msg = (e) => (e && e.body && (e.body.error || (typeof e.body === 'string' ? e.body : ''))) || (e && e.message) || String(e);

/** 本机在当前服务端上的设备 id（只有桌面客户端有；网页 / 手机是 ''）。
 *  device.id() 是一趟 sendSync（主进程还要读盘解密），设备芯片的派生值、菜单每一行都调它（10-21 回归 R2）：
 *  能订阅 device.onState 的壳只问一次，之后跟着推送更新；没有 onState 的老壳照旧每次现问。 */
const devCtl = typeof window !== 'undefined' ? window.BridgeDesktop?.device || null : null;
const canWatchDev = typeof devCtl?.onState === 'function';
let myIdCache = null;
export function thisDeviceId() {
  if (canWatchDev && myIdCache !== null) return myIdCache;
  let id = '';
  try { id = String(devCtl?.id?.() || ''); } catch { return ''; }
  if (canWatchDev) myIdCache = id;
  return id;
}

export function loadDevices(force = false) {
  if (loading && !force) return loading;
  loading = api.get('/api/devices')
    .then((r) => {
      devices.enabled = r.enabled !== false;
      devices.list = Array.isArray(r.devices) ? r.devices : [];
      devices.loaded = true;
      devices.err = '';
    })
    .catch((e) => {
      // 老服务端没有这个接口 / 快照访客：当作没有设备，界面不出芯片
      if (e && (e.status === 404 || e.status === 401 || e.status === 403)) { devices.enabled = false; devices.loaded = true; }
      else devices.err = msg(e);
    })
    .finally(() => { loading = null; });
  return loading;
}

busOn((ev) => {
  if (!ev || ev.type !== 'devices') return;
  const hit = devices.list.find((d) => d.id === ev.id);
  if (hit && typeof ev.online === 'boolean') hit.online = ev.online;
  else loadDevices(true);
});

// 桌面客户端登记 / 上线后（壳推 local-pc:state）也刷一次，设备芯片里马上看得到这台电脑。
// 只在「登记身份 / 连没连上」真变了时才拉（10-21 回归 R1）：这条通道在每条设备操作、每次活动、每次托盘刷新时
// 都推，端口转发的每个 HTTP 请求也算一次——以前每推一次就强拉两遍 /api/devices 并整表重渲染。
// 别人的设备上下线走总线 {type:'devices'}，不靠这里。
if (canWatchDev && isNativeDesktop()) {
  let lastKey = null, regT = 0;
  try {
    devCtl.onState((dev) => {
      if (!dev) return;
      if (typeof dev.deviceId === 'string') myIdCache = dev.deviceId;
      const key = (dev.registered ? 1 : 0) + '|' + (dev.deviceId || '') + '|' + (dev.connected ? 1 : 0);
      if (key === lastKey) return;
      const first = lastKey === null;
      lastKey = key;
      if (first && !devices.loaded) return;   // 开机第一拍：芯片 / 设置页自己会拉
      clearTimeout(regT);
      regT = setTimeout(() => loadDevices(), 500);
    });
  } catch {}
}

/** 会话连接的设备（切会话时调）。 */
let linkReq = '';   // 正在拉的那个会话（非响应式：别让调用方的 effect 依赖上 devices.link，见 10-21 回归 R5）
export async function loadLink(sessionId) {
  if (!sessionId) { linkReq = ''; if (devices.link.sessionId || devices.link.value) devices.link = { sessionId: '', value: '' }; return; }
  if (linkReq === sessionId) return;
  linkReq = sessionId;
  devices.link = { sessionId, value: '' };
  try {
    const r = await api.get('/api/devices/link?sessionId=' + encodeURIComponent(sessionId));
    if (devices.link.sessionId === sessionId) devices.link = { sessionId, value: r.link || '' };
  } catch { /* 老服务端：保持「自动」 */ }
}

/** 改当前会话连接的设备（id / 'none' / '' = 自动）。 */
export async function setLink(sessionId, value) {
  const prev = devices.link;
  devices.link = { sessionId, value };
  try {
    const r = await api.post('/api/devices/link', { sessionId, link: value });
    devices.link = { sessionId, value: r.link || '' };
  } catch (e) {
    devices.link = prev;
    throw new Error(msg(e));
  }
}

/** 设备芯片上要显示的那台：会话连接的 > 新会话草稿 > 这台桌面客户端（自动）> 恰好一台在线。 */
export function effectiveDevice(sessionId) {
  const pick = sessionId ? devices.link.value : (devices.draft === 'auto' ? '' : devices.draft);
  if (pick === 'none') return { none: true };
  if (pick) return devices.list.find((d) => d.id === pick) || { missing: true, id: pick };
  const mine = thisDeviceId();
  if (mine) { const d = devices.list.find((x) => x.id === mine); if (d) return { ...d, auto: true }; }
  const online = devices.list.filter((d) => d.online);
  return online.length === 1 ? { ...online[0], auto: true } : null;
}

export async function renameDevice(id, name) { await api.post('/api/devices/action', { id, action: 'rename', name }); await loadDevices(true); }
export async function revokeDevice(id) { await api.post('/api/devices/action', { id, action: 'revoke' }); await loadDevices(true); }
export async function deleteDevice(id) { await api.post('/api/devices/action', { id, action: 'delete' }); await loadDevices(true); }
export async function stopDevice(id) { await api.post('/api/devices/action', { id, action: 'stop' }); await loadDevices(true); }

/** 设备的状态一句话（设置页、控制台共用）。 */
export function deviceStatusLine(d, tr = (s) => s) {
  if (!d) return '';
  if (d.revoked) return tr('已吊销');
  if (!d.online) return d.lastOnlineAt ? tr('离线') : tr('还没连上过');
  const tier = d.client?.tier;
  if (tier === 'control') return tr('在线 · 可操作');
  if (tier === 'observe') return tr('在线 · 只看，动手前问你');
  return tr('在线');
}

// ── 端口转发：把自己电脑上的本机端口接到 bridge（routes/devices.mjs 的 /api/devices/forwards）──
export const forwards = $state({ loaded: false, list: [], previewDomain: false, err: '' });

export function loadForwards() {
  return api.get('/api/devices/forwards')
    .then((r) => { forwards.list = Array.isArray(r.forwards) ? r.forwards : []; forwards.previewDomain = !!r.previewDomain; forwards.loaded = true; forwards.err = ''; })
    .catch((e) => { forwards.loaded = true; forwards.err = msg(e); });
}
export async function addForward(id, port, label = '') {
  try { const r = await api.post('/api/devices/forwards', { id, port: Number(port), label }); await loadForwards(); return r.forward; }
  catch (e) { throw new Error(msg(e)); }
}
export async function dropForward(token) {
  try { await api.post('/api/devices/forwards/remove', { token }); await loadForwards(); }
  catch (e) { throw new Error(msg(e)); }
}
/** 给人看 / 复制的地址：有预览子域用它（网页应用的根路径资源才对），否则用路径入口。 */
export function forwardShareUrl(f) {
  const u = f?.urls || {};
  if (u.preview) return u.preview;
  if (/^https?:/.test(u.path || '')) return u.path;
  try { return new URL(u.path || '', getServerBase() || location.origin).href; } catch { return u.path || ''; }
}

// ── 这台电脑（只有桌面客户端有）：设备档位 off / observe / control 与设备通道状态 ──
// 档位由桌面壳持久化并在设备服务里硬拦（window.BridgeDesktop.localPc）；这里只是读写与订阅。
const lpCtl = typeof window !== 'undefined' ? window.BridgeDesktop?.localPc || null : null;
export const thisComputer = $state({ supported: !!lpCtl, mode: 'off', active: false, lastAction: '', source: '', shortcut: '', device: null });
function applyLp(s) {
  if (!s) return;
  thisComputer.mode = s.mode || 'off';
  thisComputer.active = !!s.active;
  thisComputer.lastAction = s.lastAction || '';
  thisComputer.source = s.source || '';
  thisComputer.shortcut = s.shortcut || '';
  thisComputer.device = s.device || null;
}
export function refreshThisComputer() { lpCtl?.state().then(applyLp).catch(() => {}); }
if (lpCtl) {
  refreshThisComputer();
  try { lpCtl.onState?.(applyLp); } catch {}
}
export async function setThisComputerMode(mode) {
  if (!lpCtl) return;
  try { applyLp(await lpCtl.setMode(mode)); } catch {}
  setTimeout(refreshThisComputer, 250);
}
export function stopThisComputer() { lpCtl?.stop().then(applyLp).catch(() => {}); setTimeout(refreshThisComputer, 200); }
