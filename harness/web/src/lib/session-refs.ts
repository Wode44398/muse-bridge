// 引用会话（把会话块拖进输入框）：前端的纯函数部分。不依赖 Svelte 与浏览器——Node 测试里直接跑，state.svelte.ts 用它们。
import type { SessionRefView } from "./timeline-types.ts";
import { t } from "./i18n.ts";

export const MAX_SESSION_REFS = 3; // 与服务端 session-refs.ts 的 MAX_REFS 同值

// 历史里消息上的 refs（形状不对的不要，最多 MAX_SESSION_REFS 个）
export function sessionRefsFrom(raw: unknown): SessionRefView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is { id: string; title: string } => !!r && typeof r.id === "string" && !!r.id && typeof r.title === "string")
    .slice(0, MAX_SESSION_REFS)
    .map((r) => ({ id: r.id, title: r.title }));
}

// 往输入框的引用里加一个。引用自己、超过上限的不加，给一句话；重复的不加、不打扰。
// 没加时 list 原样返回（同一个数组），调用方据此判断。
export function withSessionRef(
  list: SessionRefView[],
  ref: SessionRefView,
  selfId: string | null | undefined,
): { list: SessionRefView[]; note?: string } {
  if (!ref.id) return { list };
  if (selfId && ref.id === selfId) return { list, note: t("不能引用对话自己") };
  if (list.some((r) => r.id === ref.id)) return { list };
  if (list.length >= MAX_SESSION_REFS) return { list, note: t("一条消息最多引用 {n} 个对话", { n: MAX_SESSION_REFS }) };
  return { list: [...list, ref] };
}
