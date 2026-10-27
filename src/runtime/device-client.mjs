// 设备客户端：bridge 拉起的同机子进程经 bridge 的内部接口操作用户登记的电脑（设备）。
//
// 背景：bridge 改成「服务端跑 agent、用户电脑当设备」——桌面客户端用设备令牌对 bridge 开一条出站 SSE，
// bridge 把 op 推下去执行（runtime/device-control.mjs）。Claude 在 bridge 进程里直接用 mcp__device__*；
// bridge 起的子进程走这里的内部接口，操作的是【管理员名下】的设备。用在 Codex 的 stdio MCP
// （modules/codex/server/mcp/codex-local-pc-server.mjs）；dimensio 的 harness 有一份 TS 版
// （harness/server/tools/localpc.ts），两边的取舍保持一致。
//
// 只认两个环境变量（父进程拼好传进来）：
//   BRIDGE_DEVICE_API     bridge 的本机地址，形如 http://127.0.0.1:8787——只认回环，主机密钥不出本机
//   BRIDGE_DEVICE_SECRET  主机密钥（config.json remotePcSecret，见 runtime/host-secret.mjs）
// 刻意不 import config/index.mjs：子进程里加载它会读 / 生成 config.json，有副作用。
//
// 接口（routes/devices.mjs；主机密钥 + 本机直连，否则一律 404）：
//   GET  /api/internal/devices    → { enabled, devices: [{ id, name, online, sameMachine, client: { tier, version, os, … }, … }] }
//   POST /api/internal/device-op  → { ok: true, device: { id, name, tier }, result } | { ok: false, error }（HTTP 恒 200，失败看 ok）
// 目标设备：device 参数（id 或名字）> 恰好一台在线（多台在线时 bridge 回错让你指定）。
// 权限档由设备自己硬拦（observe 只能看，control 才能动）；被拒时这里按设备自报的档位补一句「怎么办」。

const LOOPBACK_API = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/i;
const MIN_SECRET = 20;   // 同 host-secret.mjs：短于它的密钥 bridge 会重新生成，不可能是真的

// 只读的观察动作；其余（点击、输入、窗口管理、batch……）都要设备开着 control 档
const OBSERVE_ACTIONS = new Set(['active_window', 'windows', 'processes', 'displays', 'cursor', 'screenshot', 'zoom', 'uia_tree', 'wait_for_window']);
// 2026-10-20 坐标帧重做之后才有的动作：老客户端会回「未知桌面动作」
const NEW_ACTIONS = new Set(['zoom', 'wait_for_window', 'triple_click', 'wait', 'batch']);
// 自带等待（批内等待合计封顶 30 秒、整批 100 秒；等窗口最多 60 秒），超时跟着放宽
const SLOW_ACTIONS = new Set(['batch', 'wait_for_window']);
export const DESKTOP_TIMEOUT_MS = 45_000;
export const DESKTOP_SLOW_TIMEOUT_MS = 120_000;
// slackMs：bridge 等设备的时间到点会回一句可读的错（「设备未在 N 秒内响应」），这边多等这么久，让那句错先到；
// listMs：列设备的上限。只有测试会改它们（把等待缩短）。
export const timing = { slackMs: 15_000, listMs: 8_000 };

/**
 * 设备操作失败。message 是给 agent 看的可读说明；code 供调用方分支：
 *   NOT_CONFIGURED 没接上设备通道 · UNREACHABLE 连不上 bridge · TIMEOUT 超时 · REJECTED 内部接口不认（密钥 / 来源）·
 *   HTTP bridge 回了别的错误 · FAILED bridge 或设备回 ok:false（没有设备、离线、没指定、档位不够、执行出错……）
 */
export class DeviceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
  }
}

function channel() {
  const api = String(process.env.BRIDGE_DEVICE_API || '').trim().replace(/\/+$/, '');
  const secret = String(process.env.BRIDGE_DEVICE_SECRET || '').trim();
  if (!api && !secret) {
    return { error: '没有接上 bridge 的设备通道（缺环境变量 BRIDGE_DEVICE_API / BRIDGE_DEVICE_SECRET）：这个进程不是 bridge 拉起的，或 bridge 关掉了设备通道（config.json devices=false）。' };
  }
  if (!LOOPBACK_API.test(api)) return { error: `BRIDGE_DEVICE_API 必须是本机回环地址（形如 http://127.0.0.1:8787），现在是「${api || '空'}」。` };
  if (secret.length < MIN_SECRET) return { error: '缺主机密钥 BRIDGE_DEVICE_SECRET（或长度不对）——请从 bridge 重新开一个会话。' };
  return { api, secret };
}

/** 设备通道接上了：两个环境变量都在、格式对。不代表此刻有设备在线。 */
export function deviceApiAvailable() {
  return !channel().error;
}

const isTimeout = (e) => Boolean(e && (e.name === 'TimeoutError' || e.name === 'AbortError'));

function transportError(e, api, timeoutMs) {
  if (isTimeout(e)) {
    return new DeviceError(`等 bridge 回应超时（${Math.round(timeoutMs / 1000)} 秒）——设备可能卡住了或网络断了；先 status 看它还在不在线。`, 'TIMEOUT');
  }
  const why = e?.cause?.code || e?.cause?.message || e?.message || String(e);
  return new DeviceError(`连不上 bridge（${api}，${why}）——bridge 可能没在运行或正在重启，稍后再试。`, 'UNREACHABLE');
}

async function call(pathname, body, timeoutMs) {
  const ch = channel();
  if (ch.error) throw new DeviceError(ch.error, 'NOT_CONFIGURED');
  let res;
  try {
    res = await fetch(ch.api + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + ch.secret,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',   // 主机密钥只发给这一个地址，不跟任何跳转
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw transportError(e, ch.api, timeoutMs);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { if (isTimeout(e)) throw transportError(e, ch.api, timeoutMs); }
  if (res.status === 404) {
    // 内部接口对密钥不对、非本机直连一律装作不存在
    throw new DeviceError('bridge 不认这次内部调用（404）：主机密钥对不上（bridge 换过密钥——请新开会话或重启这个 agent），或这台 bridge 版本过旧、还没有设备接口。', 'REJECTED');
  }
  if (!res.ok) throw new DeviceError(`bridge 返回 HTTP ${res.status}${data?.error ? '：' + String(data.error).slice(0, 300) : ''}`, 'HTTP');
  if (!data || typeof data !== 'object') throw new DeviceError('bridge 的回包不是 JSON（版本不匹配？）', 'HTTP');
  return data;
}

/** 管理员名下的设备（在线的排前）。enabled=false = bridge 关掉了设备通道。 */
export async function listDevices() {
  const data = await call('/api/internal/devices', undefined, timing.listMs);
  return { enabled: data.enabled !== false, devices: Array.isArray(data.devices) ? data.devices : [] };
}

/**
 * 派一条 op 到设备并等结果。
 * @param {string} op       设备 op（desktop / shell / fs.* …）
 * @param {object} args     op 参数
 * @param {object} [o]
 * @param {string} [o.device]     目标设备 id 或名字；省略 = 恰好一台在线时用那台
 * @param {number} [o.timeoutMs]  bridge 等设备回应的上限（bridge 侧夹在 1s～310s）
 * @param {string} [o.by]         谁在操作（codex / dimensio）：设备侧提示与审计用
 * @returns {Promise<{ device: { id: string, name: string, tier: string } | null, result: any }>}
 */
export async function deviceOp(op, args = {}, { device = '', timeoutMs = DESKTOP_TIMEOUT_MS, by = 'agent' } = {}) {
  const to = Math.min(310_000, Math.max(1000, Number(timeoutMs) || DESKTOP_TIMEOUT_MS));
  const body = { op: String(op || ''), args: args && typeof args === 'object' ? args : {}, timeoutMs: to, by: String(by || 'agent') };
  if (device) body.device = String(device);
  const data = await call('/api/internal/device-op', body, to + timing.slackMs);
  if (data.ok !== true) throw new DeviceError(String(data.error || '设备操作失败（bridge 没给原因）').slice(0, 800), 'FAILED');
  return { device: data.device || null, result: data.result === undefined ? null : data.result };
}

/**
 * 桌面动作（op=desktop）。自动带 frameKey=by：坐标帧按调用方各记各的，与 Claude 同时操作同一台设备也不会
 * 互相覆盖「最近一张截图」。uia_action 的子动作放在 args.uiaAction（设备侧换回执行层要的形状）。
 * 结果结构与执行层（runtime/remote-control-desktop.mjs desktopOp）相同，排版见 mcp/desktop-format.mjs。
 */
export async function desktopOp(action, args = {}, { device = '', by = 'agent', timeoutMs } = {}) {
  const a = String(action || '');
  const payload = { ...(args && typeof args === 'object' ? args : {}), action: a, frameKey: String(by || 'agent') };
  const limit = timeoutMs ?? (SLOW_ACTIONS.has(a) ? DESKTOP_SLOW_TIMEOUT_MS : DESKTOP_TIMEOUT_MS);
  try {
    return await deviceOp('desktop', payload, { device, by, timeoutMs: limit });
  } catch (e) {
    if (e instanceof DeviceError && e.code === 'FAILED') throw await explainDesktopFailure(e, a, device);
    throw e;
  }
}

// 设备回的拒绝措辞由客户端定，这里不猜原文：按设备自报的权限档补一句「怎么办」。
async function explainDesktopFailure(err, action, want) {
  if (NEW_ACTIONS.has(action) && /未知桌面动作/.test(err.message)) {
    return new DeviceError(`${err.message}\n设备的客户端版本较旧，还不支持「${action}」——请对方更新客户端；眼下用单步 screenshot / click / type 代替。`, 'FAILED');
  }
  let d = null;
  try { d = pickDevice((await listDevices()).devices, want); } catch { /* 查不到就原样报 */ }
  if (!d || !d.online) return err;
  const name = `设备「${d.name}」`;
  const tier = d.client?.tier || '';
  let hint = '';
  if (tier === 'off') hint = `${name}关掉了 agent 控制——请用户在那台电脑的 bridge 客户端里重新打开。`;
  else if (tier === 'workspace') hint = `${name}没开桌面控制（老客户端只开了命令与文件）——请对方更新客户端，或在托盘里勾选「允许远程桌面控制」。`;
  else if (tier === 'observe' && !OBSERVE_ACTIONS.has(action)) hint = `${name}现在是「只观察」档：能看不能动。要让我操作，请用户在那台电脑的 bridge 客户端里把权限改成「控制」。`;
  return hint ? new DeviceError(`${err.message}\n${hint}`, 'FAILED') : err;
}

// 同 bridge 的解析顺序（runtime/devices.mjs resolveDevice）：id > 名字 > 名字不分大小写；没指定就看是不是恰好一台在线
function pickDevice(devices, want) {
  const key = String(want || '').trim();
  if (key) {
    return devices.find((d) => d.id === key) || devices.find((d) => d.name === key)
      || devices.find((d) => String(d.name || '').toLowerCase() === key.toLowerCase()) || null;
  }
  const online = devices.filter((d) => d.online);
  return online.length === 1 ? online[0] : null;
}
