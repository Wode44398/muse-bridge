import { desktopHostPorts } from "./desktop-host.ts";

// S1（#38①）：agent 的 Browser / WebFetch 不许碰 dimensio 自己的控制面。harness 的 API
// 已经只认令牌（api-auth.ts），这里是纵深一层：agent 的浏览器不停在 harness / bridge /
// 开发页 / 桌面壳的回环端口上（桌面壳的 Electron 调试端口上挂着已登录的 bridge UI），
// WebFetch 也不去敲这些端口。只看回环地址：公网、局域网和普通 dev server 一概不管。
// 桌面壳调试端口的根治（改 pipe、拆开 agent 视图与 bridge UI）在阶段 2 的 S10。

export const DEV_UI_PORT = 5178;

export function controlPlanePorts(): Set<number> {
  const ports = new Set<number>([DEV_UI_PORT]);
  const add = (v: unknown) => {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
  };
  add(process.env.PORT || 8799); // harness 自己
  add(process.env.BRIDGE_PORT); // 托管它的 bridge
  for (const p of desktopHostPorts()) add(p); // 桌面壳：Electron 调试端口 + broker
  for (const p of (process.env.DIMENSIO_CONTROL_PORTS ?? "").split(",")) add(p.trim());
  return ports;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h === "0.0.0.0") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // IPv4 映射：WHATWG URL 会把 [::ffff:127.0.0.1] 规范成 [::ffff:7f00:1]。
  return /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(h);
}

function blockedMessage(target: string): string {
  return (
    `${target} is dimensio's own control plane (harness / bridge / dev UI / desktop shell). ` +
    `Agent tools may not drive it. To change settings, permissions or the session, tell the user ` +
    `what to change and let them do it in the UI.`
  );
}

// 拒绝理由；null = 放行。URL 解析不了的交给调用方原有的校验去报错。
export function controlPlaneUrlBlock(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return null;
  if (!isLoopbackHost(u.hostname)) return null;
  const port = Number(u.port || (u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80));
  return controlPlanePorts().has(port) ? blockedMessage(u.host) : null;
}

// Browser(attach) 用：按回环端口判。
export function controlPlanePortBlock(port: number): string | null {
  return controlPlanePorts().has(port) ? blockedMessage(`127.0.0.1:${port}`) : null;
}
