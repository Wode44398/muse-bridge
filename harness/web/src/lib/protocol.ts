// M10（D8）：前端这一侧的协议版本号与兼容判断（纪律见 server/protocol.ts）。纯函数，服务端测试直接引用。
//
// 这份前端会被打进离线 apk、一装就是很久：服务端抬了 minClient（不再服务这么老的前端）时，要能明说「请更新 App」，
// 而不是拿着看不懂的数据静默出错；反过来服务端比这个前端要求的还老，也要明说。

export const CLIENT_PROTOCOL = 1;
// 还能配合的最老服务端。0 = M10 之前、不报协议号的也行（能力靠逐个探端点，见 api.detectFeatures）
export const MIN_SERVER = 0;

export interface Compat {
  server: number; // 服务端协议号（0 = 没报，M10 之前）
  clientTooOld: boolean; // 服务端不再服务这么老的前端：请更新 App
  serverTooOld: boolean; // 服务端比这个前端要求的还老：请更新服务端
  caps: string[] | null; // 服务端报的能力位；null = 没报（旧后端），调用方回退到逐个探测
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

// info = GET /api/info 的响应（形状不对就当旧后端）
export function compat(info: unknown, client = CLIENT_PROTOCOL, minServer = MIN_SERVER): Compat {
  const p = (info as { protocol?: unknown } | null)?.protocol as { version?: unknown; minClient?: unknown; capabilities?: unknown } | undefined;
  const server = num(p?.version);
  const raw = p?.capabilities;
  const caps = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : null;
  return {
    server,
    clientTooOld: client < num(p?.minClient),
    serverTooOld: server < minServer,
    caps: server > 0 ? caps : null,
  };
}

// 前端按能力位决定的功能（与 api.Features 一一对应）。服务端的 CAPABILITIES 必须覆盖这些名字（protocol.test.ts 核对）。
export const FEATURE_CAPS = ["sessions", "files", "projects"] as const;
export type FeatureCap = (typeof FEATURE_CAPS)[number];

export function featuresFromCaps(caps: readonly string[]): Record<FeatureCap, boolean> {
  return { sessions: caps.includes("sessions"), files: caps.includes("files"), projects: caps.includes("projects") };
}

// 事件流请求在查询串里报前端的协议号（不能用自定义头：离线 apk 跨源访问 bridge，预检只放行 Content-Type / Authorization）
export function withProto(path: string, client = CLIENT_PROTOCOL): string {
  return `${path}${path.includes("?") ? "&" : "?"}proto=${client}`;
}
