// 成员自建的自定义服务：连之前先看地址是不是公网的（2026-10-28，维护者：成员也能自己加自定义服务）。
//
// 以前成员实例（租户）一律不许加自定义服务——替用户连任意地址 = SSRF：成员把接口地址填成 http://127.0.0.1:8787（bridge 本体）、
// 云主机的元数据地址 169.254.169.254、内网别的机器，服务端就替他去打，回包还会经「检测连接 / 测试」的报错原样带回来。
// 现在放开，但成员自己加的服务只能连公网：主机名解析出的每个地址都不能落在本机 / 内网 / 链路本地 / 组播这些段里，
// 拉型号、检测、探测、测试、保存、真对话（适配器发请求前）都过这一道；跟随重定向也关掉（公网地址 302 到内网一样能绕）。
// 管理员共享给成员的服务不过这道——地址是管理员定的，成员改不了。
// 服务器确实要让成员连内网（比如内网部署的 vLLM），设 DIMENSIO_TENANT_PRIVATE_ENDPOINTS=1。
//
// 198.18.0.0/15 不拦：Clash 一类代理的 fake-ip 模式把所有域名都解析到这一段，拦了成员就什么都连不上。
import { lookup } from "node:dns/promises";
import net from "node:net";
import { tenantMode } from "./tenant.ts";

/** 这个实例上，成员自建的服务要不要过地址把关。 */
export function privateEndpointsBlocked(): boolean {
  return tenantMode() && process.env.DIMENSIO_TENANT_PRIVATE_ENDPOINTS !== "1";
}

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || // 本网络
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 运营商 NAT / Tailscale
    (a === 169 && b === 254) || // 链路本地（云主机元数据）
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 协议保留、192.0.2.0/24 文档段
    a >= 224 // 组播与保留
  );
}

/** 本机 / 内网 / 链路本地 / 组播这类不该替成员去连的地址。 */
export function isPrivateAddress(ip: string): boolean {
  const s = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (net.isIPv4(s)) return privateV4(s);
  if (!net.isIPv6(s)) return true; // 认不出的一律当内网
  if (s === "::" || s === "::1") return true;
  // 内嵌 IPv4 的写法（::ffff:127.0.0.1、::ffff:7f00:1、NAT64 64:ff9b::7f00:1）按里面那个 IPv4 判
  const embedded = /^(?:::ffff:(?:0:)?|64:ff9b::)(.+)$/.exec(s);
  if (embedded) {
    const tail = embedded[1];
    if (net.isIPv4(tail)) return privateV4(tail);
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (m) {
      const hi = parseInt(m[1], 16);
      const lo = parseInt(m[2], 16);
      return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  const first = parseInt(s.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 唯一本地
    (first & 0xffc0) === 0xfe80 || // fe80::/10 链路本地
    (first & 0xff00) === 0xff00 // 组播
  );
}

const refuse = (host: string) =>
  Object.assign(new Error(`这台服务器上，自己添加的服务只能连公网地址（${host} 是本机或内网地址）。要连内网服务，请管理员添加后共享给成员。`), {
    status: 400,
  });

/** 成员实例：地址落在本机 / 内网就抛（400，人话）。别的实例、或服务器放开了内网，什么都不做。 */
export async function assertPublicEndpoint(url: string): Promise<void> {
  if (!privateEndpointsBlocked()) return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw Object.assign(new Error("接口地址格式不对"), { status: 400 });
  }
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (isPrivateAddress(bare)) throw refuse(host);
    return;
  }
  if (bare === "localhost" || bare.endsWith(".localhost")) throw refuse(host);
  let addrs: { address: string }[];
  try {
    addrs = await lookup(bare, { all: true, verbatim: true });
  } catch {
    return; // 解析不了：照常去连，请求自己会报「连不上」
  }
  if (addrs.some((a) => isPrivateAddress(a.address))) throw refuse(host);
}
