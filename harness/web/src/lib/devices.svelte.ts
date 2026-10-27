// 用户的电脑（设备芯片）：这个会话连着你哪台电脑——dimensio 跑在 bridge 服务端，连上的那台经 Device* 工具让它
// 看屏幕、在你允许时操作（同 Claude 输入框下方那颗，见 bridge web/src/lib/devices.svelte.js）。
//   · 进行中的会话：改选立刻生效（POST /api/devices/link），下一次工具调用就按新的来；
//   · 新对话：选的是草稿，会话建立（第一条消息发出、拿到会话 id）后补写上去；不选 = 自动（恰好一台在线就用它）。
// 服务端没有 devices 能力位、或没接上 bridge 的设备通道（独立跑的 harness）时整颗不出现。
import { linkDevice, listDevices, type DeviceRow } from "./api.ts";
import { app } from "./state.svelte.ts";

export const dev = $state({
  loaded: false,
  available: false,
  enabled: false,
  list: [] as DeviceRow[],
  // 会话 id → link（设备 id / "none" / "" = 自动）
  links: {} as Record<string, string>,
  // 新对话的草稿选择（"" = 自动）
  draft: "",
});

export type { DeviceRow };

export const devicesSupported = () => Boolean(app.compat?.caps?.includes("devices"));

let inflight: Promise<void> | null = null;
let at = 0;
/** 拉设备列表（顺带这个会话的 link）。force = 菜单打开时现拉，否则 15 秒内复用。 */
export function loadDevices(session = "", force = false): Promise<void> {
  if (!devicesSupported()) return Promise.resolve();
  if (!force && inflight) return inflight;
  if (!force && dev.loaded && Date.now() - at < 15_000 && (!session || session in dev.links)) return Promise.resolve();
  inflight = listDevices(session)
    .then((r) => {
      dev.available = r.available === true;
      dev.enabled = r.enabled !== false;
      dev.list = Array.isArray(r.devices) ? r.devices : [];
      if (session) dev.links[session] = r.link || "";
      dev.loaded = true;
      at = Date.now();
    })
    .catch(() => {
      dev.loaded = true;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 改这个会话连哪台（"" = 自动）。失败抛错（菜单里显示）。 */
export async function setSessionDevice(session: string, link: string): Promise<void> {
  const r = await linkDevice(session, link);
  dev.links[session] = r.link || "";
}

export type Effective =
  | { kind: "auto"; device: DeviceRow | null } // 自动：恰好一台在线时就是它
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "linked"; device: DeviceRow };

/** 这个会话此刻实际会用哪台（芯片上显示的那个）。 */
export function effectiveDevice(session: string): Effective {
  const link = session ? (dev.links[session] ?? "") : dev.draft;
  if (link === "none") return { kind: "none" };
  if (link) {
    const d = dev.list.find((x) => x.id === link);
    return d ? { kind: "linked", device: d } : { kind: "missing" };
  }
  const online = dev.list.filter((x) => x.online);
  return { kind: "auto", device: online.length === 1 ? online[0] : null };
}
