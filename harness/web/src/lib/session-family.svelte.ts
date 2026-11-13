// 会话协作的前端状态：服务端台账（GET /api/family）的快照，侧栏挂子会话、工具行链会话都读它；以及「打开某个相关会话」。
// 纯逻辑（信封解析、侧栏缩进、工具行目标）在 session-family.ts。
// 重拉时机：会话列表每次重拉时跟着拉（state.svelte.ts refreshSessions）——派生、删会话、收件箱变化服务端都会发 list_changed。
import * as api from "./api.ts";
import { t } from "./i18n.ts";
import type { FamilyAgent, FamilyState } from "./session-family.ts";

export const family: FamilyState = $state({ links: {}, inbox: {}, working: [] });

let inflight: Promise<void> | null = null;
let unsupported = false; // 旧后端没有这个接口：别每次列表重拉都打一个 404
export function refreshFamily(): Promise<void> {
  if (unsupported) return Promise.resolve();
  inflight ??= api
    .getFamily()
    .then((r) => {
      family.links = r?.links ?? {};
      family.inbox = r?.inbox ?? {};
      family.working = Array.isArray(r?.working) ? r.working : [];
    })
    .catch((e: { status?: number }) => {
      if (e?.status === 404) unsupported = true;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// 嵌在 bridge 里时，Claude 会话由宿主打开：bridge 的 HarnessPage 接这个事件（preventDefault = 接住了），换到 Claude 页打开它
export const HOST_OPEN_SESSION = "dimensio:open-session";

export async function openFamilySession(id: string, agent: FamilyAgent): Promise<void> {
  if (!id) return;
  if (agent === "claude") {
    const ev = new CustomEvent(HOST_OPEN_SESSION, { cancelable: true, detail: { agent, id } });
    const handled = !window.dispatchEvent(ev);
    if (!handled) {
      const { toast } = await import("./state.svelte.ts");
      toast(t("这是 bridge 里的 Claude 会话，到 bridge 的 Claude 页打开它"));
    }
    return;
  }
  const { openSession } = await import("./state.svelte.ts");
  await openSession(id);
}
