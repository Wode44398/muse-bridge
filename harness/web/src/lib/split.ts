// 分屏（宽屏多会话）的纯逻辑：两格里放谁、会话块拖进正文区落在哪一格会发生什么。不依赖 Svelte——Node 测试里直接跑；
// state.svelte.ts（放格、换格、关格）与 App.svelte（正文区的落点）用它。
import { t } from "./i18n.ts";

export type Side = 0 | 1;

// 有焦点的那一格换成 next；next 已经在另一格里 = 格子不动（只是焦点挪过去）。没分屏 = 原样
export function withFocusedReplaced<T>(panes: readonly T[], focused: T, next: T): T[] {
  if (panes.length !== 2 || panes.includes(next)) return [...panes];
  const out = [...panes];
  const at = out.indexOf(focused);
  out[at >= 0 ? at : 0] = next;
  return out;
}

// 把 chat 放进 side 那一格：没分屏 = 与当前对话左右并排；已分屏 = 换掉那一格。null = 不用动（已经在某一格里 / 就是当前这个）
export function placeInSplit<T>(panes: readonly T[], current: T, chat: T, side: Side): T[] | null {
  if (panes.includes(chat)) return null;
  if (panes.length !== 2) {
    if (chat === current) return null;
    return side === 0 ? [chat, current] : [current, chat];
  }
  const out = [...panes];
  out[side] = chat;
  return out;
}

// 关掉一格之后剩下的那个；closing 不在格里 = null
export function paneLeft<T>(panes: readonly T[], closing: T): T | null {
  if (panes.length !== 2 || !panes.includes(closing)) return null;
  return panes.find((c) => c !== closing) ?? null;
}

// 会话块拖进正文区、手在 side 那一半时，松手会怎样
export type SplitDrop =
  | { kind: "open" } // 当前是空白新对话：直接打开，不分屏
  | { kind: "split"; side: Side } // 与当前对话并排，放在 side 那边
  | { kind: "replace"; side: Side } // 分屏中：换掉 side 那一格
  | { kind: "swap"; side: Side } // 分屏中：拖的是另一格的会话 = 两格对调（它到 side 这边）
  | { kind: "none" }; // 不接：拖的就是当前对话 / 已经在这一格
export function splitDropPlan(o: {
  split: boolean;
  blank: boolean;
  currentId: string | null;
  paneIds: readonly (string | null)[];
  draggedId: string;
  side: Side;
}): SplitDrop {
  if (!o.split) {
    if (o.blank) return { kind: "open" };
    if (o.draggedId === o.currentId) return { kind: "none" };
    return { kind: "split", side: o.side };
  }
  const at = o.paneIds.indexOf(o.draggedId);
  if (at === o.side) return { kind: "none" };
  if (at >= 0) return { kind: "swap", side: o.side };
  return { kind: "replace", side: o.side };
}
// 幽灵下方那行提示
export function splitDropLabel(plan: SplitDrop): string {
  switch (plan.kind) {
    case "open":
      return t("打开这个对话");
    case "split":
      return plan.side === 0 ? t("在左边分屏打开") : t("在右边分屏打开");
    case "replace":
      return plan.side === 0 ? t("在左格打开") : t("在右格打开");
    case "swap":
      return plan.side === 0 ? t("换到左格") : t("换到右格");
    default:
      return "";
  }
}
