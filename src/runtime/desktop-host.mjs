// 桌面壳（bridge-client / 主机台附着形态）的「原生浏览器宿主」发现。
// 宿主 = Electron 壳暴露的一对能力：remote-debugging 端口（CDP 附着）+ loopback
// broker（创建/关闭 WebContentsView target，URL 自带随机 secret）。
//
// 三条来源，按优先级：
//   1) env（BRIDGE_DESKTOP_CDP_PORT / BRIDGE_DESKTOP_BROKER）——客户端/服务端形态
//      壳 spawn bridge 时直传，进程树内永远最新；
//   2) 运行中注册（POST /api/desktop/browser-host）——附着形态生产 bridge 由计划任务
//      托管、env 传不进来，壳连上后主动注册 + 60s 心跳；
//   3) 落盘文件（DATA_ROOT/desktop-host.json）——给 harness 子进程（spawn 早于注册也
//      没关系，launch 时现读）和 bridge 自己重启后用。
//
// 使用方（src/runtime/cdp.mjs 与 harness/server/cdp.ts）每次 launch 现取现探活：
// broker 不应答（壳没开/已退出）→ 回落原 headless Chrome 路径，永不硬依赖壳。

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';

export const DESKTOP_HOST_FILE = path.join(DATA_ROOT, 'desktop-host.json');

let mem = null; // { cdpPort, brokerUrl }

function normalize(info) {
  const cdpPort = Number(info?.cdpPort || 0);
  const brokerUrl = String(info?.brokerUrl || '').replace(/\/+$/, '');
  // broker 必须是本机回环（它就是壳进程里的 http server）；别的一律拒绝。
  // S10：新壳没有调试端口（cdpPort 为 0，CDP 经 broker 转发）；旧壳照旧带端口。
  if (!Number.isInteger(cdpPort) || cdpPort < 0 || cdpPort > 65535 || !/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/.test(brokerUrl)) {
    throw new Error('cdpPort/brokerUrl 非法');
  }
  return { cdpPort, brokerUrl };
}

export function registerDesktopHost(info) {
  const next = normalize(info);
  const changed = !mem || mem.cdpPort !== next.cdpPort || mem.brokerUrl !== next.brokerUrl;
  mem = next;
  if (changed) {
    // 心跳每分钟来一次，内容没变就不重写文件（免得 harness 侧无谓重读、磁盘白转）。
    try { writeFileSync(DESKTOP_HOST_FILE, JSON.stringify(next)); } catch { /* 文件失败只影响 harness，内存路径照常 */ }
  }
  return next;
}

export function clearDesktopHost() {
  mem = null;
  try { rmSync(DESKTOP_HOST_FILE, { force: true }); } catch { /* best effort */ }
}

export function desktopHostInfo() {
  const envBroker = String(process.env.BRIDGE_DESKTOP_BROKER || '').replace(/\/+$/, '');
  if (envBroker) {
    // S10：新壳只传 broker（没有调试端口）；env 与注册 / 文件过同一道校验
    try { return { ...normalize({ cdpPort: process.env.BRIDGE_DESKTOP_CDP_PORT, brokerUrl: envBroker }), source: 'env' }; } catch { return null; }
  }
  if (mem) return { ...mem, source: 'register' };
  try {
    const j = JSON.parse(readFileSync(DESKTOP_HOST_FILE, 'utf8'));
    return { ...normalize(j), source: 'file' };
  } catch { return null; }
}

// broker 活着吗（== 壳还在跑）。无 secret 也能撞出 404——凡有 HTTP 应答都算活；
// 拒连/超时 = 壳已退出（或文件残留过期）。
export async function probeDesktopHost(info, timeoutMs = 1200) {
  try {
    await fetch(info.brokerUrl + '/target', { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch { return false; }
}

// S10：/json/* 与调试 WebSocket 的基址。broker 应答 /json/version（带回环的 webSocketDebuggerUrl）= 新壳，CDP 经 broker
// 转发、壳上没有调试端口；broker 应答了但不认这条（旧壳回 404）= 还开着调试端口的旧壳，用端口。broker 不应答 = 壳不在。
export async function resolveCdpBase(info, timeoutMs = 1200) {
  let res;
  try {
    res = await fetch(info.brokerUrl + '/json/version', { signal: AbortSignal.timeout(timeoutMs) });
  } catch { return null; }
  if (res.ok) {
    const v = await res.json().catch(() => null);
    if (typeof v?.webSocketDebuggerUrl === 'string' && v.webSocketDebuggerUrl.startsWith('ws://127.0.0.1:')) {
      return { cdpBase: info.brokerUrl, proxy: true };
    }
  } else {
    await res.body?.cancel().catch(() => {});
  }
  return info.cdpPort > 0 ? { cdpBase: `http://127.0.0.1:${info.cdpPort}`, proxy: false } : null;
}

// 「现在可用的宿主」一步到位：有配置、broker 应答、并且认得出 CDP 基址才返回，否则 null（调用方回落 headless）。
export async function liveDesktopHost(timeoutMs = 1200) {
  const info = desktopHostInfo();
  if (!info) return null;
  const cdp = await resolveCdpBase(info, timeoutMs);
  return cdp ? { ...info, ...cdp } : null;
}
