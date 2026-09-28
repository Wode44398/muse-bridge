import { existsSync, readFileSync } from "node:fs";

// ── 桌面壳原生浏览器宿主（bridge-client / 主机台）────────────────────────────
// 壳把 WebContentsView broker（loopback、URL 自带 secret）交给我们：env 直传（壳 spawn bridge → bridge spawn harness，进程树
// 继承），或附着形态经 bridge 注册后落盘 BRIDGE_DESKTOP_HOST_FILE（本进程可能早于注册启动，所以每次 launch 现读现探活）。
// broker 不应答 → 回落 headless，壳缺席不影响功能。
// S10（#89 方案 2）：新壳没有 Electron 调试端口（cdpPort 为 0），CDP 经 broker 转发（/json/version、/json/list、
// /devtools/*）；还开着调试端口的旧壳照旧用端口。与 bridge 的 src/runtime/desktop-host.mjs 同一口径。
// 从 cdp.ts 拆出来，是因为控制面黑名单（control-plane.ts）也要知道壳的端口。
export interface DesktopHost {
  cdpPort: number; // 0 = 新壳（没有调试端口）
  brokerUrl: string;
}

const BROKER_RE = /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/;

function normalize(cdpPortRaw: unknown, brokerRaw: unknown): DesktopHost | null {
  const cdpPort = Number(cdpPortRaw || 0);
  const brokerUrl = String(brokerRaw || "").replace(/\/+$/, "");
  if (!Number.isInteger(cdpPort) || cdpPort < 0 || cdpPort > 65535 || !BROKER_RE.test(brokerUrl)) return null;
  return { cdpPort, brokerUrl };
}

export function desktopHostInfo(): DesktopHost | null {
  const envBroker = String(process.env.BRIDGE_DESKTOP_BROKER || "").replace(/\/+$/, "");
  if (envBroker) return normalize(process.env.BRIDGE_DESKTOP_CDP_PORT, envBroker);
  const file = process.env.BRIDGE_DESKTOP_HOST_FILE || "";
  if (!file || !existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return normalize(j?.cdpPort, j?.brokerUrl);
  } catch {
    return null; // 文件损坏当没有
  }
}

// 壳暴露在回环上的端口：broker 端口，以及旧壳的 Electron 调试端口（上面挂着已登录的 bridge UI）。
export function desktopHostPorts(): number[] {
  const info = desktopHostInfo();
  if (!info) return [];
  const ports = info.cdpPort > 0 ? [info.cdpPort] : [];
  try {
    const brokerPort = Number(new URL(info.brokerUrl).port);
    if (brokerPort > 0) ports.push(brokerPort);
  } catch {
    /* brokerUrl 已在 desktopHostInfo 里校验过形状 */
  }
  return ports;
}

// S10：/json/* 与调试 WebSocket 的基址。broker 应答 /json/version（带回环的 webSocketDebuggerUrl）= 新壳，CDP 经 broker
// 转发；broker 应答了但不认这条（旧壳回 404）= 还开着调试端口的旧壳，用端口；broker 不应答 = 壳不在（null）。
export async function resolveCdpBase(info: DesktopHost, timeoutMs = 1200): Promise<{ cdpBase: string; proxy: boolean } | null> {
  let res: Response;
  try {
    res = await fetch(`${info.brokerUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
  if (res.ok) {
    const v = (await res.json().catch(() => null)) as { webSocketDebuggerUrl?: unknown } | null;
    if (typeof v?.webSocketDebuggerUrl === "string" && v.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:")) {
      return { cdpBase: info.brokerUrl, proxy: true };
    }
  } else {
    await res.body?.cancel().catch(() => {});
  }
  return info.cdpPort > 0 ? { cdpBase: `http://127.0.0.1:${info.cdpPort}`, proxy: false } : null;
}
