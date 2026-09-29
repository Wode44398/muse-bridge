// P10（ZCode E1、Codex X39、hermes N43、D9）：等人处理的卡停在输入框上方。纯函数，不依赖 Svelte。
//
// 以前权限 / 提问 / 计划卡插在时间线里：人往上翻着看记录时，新卡在屏幕外；几张卡同时在等时散落各处；手机上卡片刚冒出来，
// 正好落在指尖要点的位置。现在：
//   · 交互态的卡只在输入框上方的停靠区里渲染一份（从停进来到落定都不移位、不重挂载），时间线原位留一行占位；落定之后时间线
//     照旧显示只读回执。一次只停一张（最早的那张），其余在时间线里排队。
//   · 正在打字就先不停靠：输入停下 1 秒才进来（Codex）；进来后 400ms 内的点击不算（hermes：离发送键只有一指之距）。
//   · 这段草稿开始写的时候卡已经停着，发送就回应这张卡（N43）：权限卡 = 拒绝并附上这段话（文字永远不能批准）、提问 = 作为
//     「其他」答案、计划 = 退回并附上修改意见；卡在别处先定了，这段话改作插话发出（不丢）。
import type { AskItem, Item, PermissionItem, PlanItem } from "./timeline-types.ts";
import { t } from "./i18n.ts";

export type CardItem = PermissionItem | AskItem | PlanItem;

// 正在打字：停下这么久才停靠
export const DOCK_IDLE_MS = 1000;
// 停进来之后这么久内的点击不算
export const DOCK_ARM_MS = 400;

// 返回 boolean 而不是类型谓词：谓词在 false 分支会把 ask / permission / plan 整个排除掉，模板里后面的分支就认不出它们了
export function isPendingCard(it: Item, running: boolean): boolean {
  if (!running) return false;
  switch (it.kind) {
    case "permission":
    case "plan":
      return !it.decided && !it.cancelled;
    case "ask":
      return !it.answered;
    default:
      return false;
  }
}

export function pendingCards(timeline: Item[], running: boolean): CardItem[] {
  if (!running) return [];
  return timeline.filter((it) => isPendingCard(it, running)) as CardItem[];
}

// 停靠区接下来放哪张。current = 此刻停着的；idleMs = 输入框停下多久了。
//   · 停着的那张还在等：不换（一张卡从停进来到落定都待在原处）
//   · 否则最早的一张；正在打字（没停够 DOCK_IDLE_MS）就先空着，wait = 还要等多久再看一次
export function nextDocked(pending: CardItem[], current: string | null, idleMs: number): { id: string | null; wait: number } {
  if (current && pending.some((c) => c.id === current)) return { id: current, wait: 0 };
  const first = pending[0];
  if (!first) return { id: null, wait: 0 };
  if (idleMs < DOCK_IDLE_MS) return { id: null, wait: DOCK_IDLE_MS - idleMs };
  return { id: first.id, wait: 0 };
}

// 草稿的回应对象：草稿开始写的时候停着的那张，而且它现在还停着、还在等。之后才停进来的卡不算——
// 「正打着插话，卡片突然出现」时，这段话不能被当成拒绝附言或提问的答案落到卡上。
export function replyTarget(draftTarget: string | null | undefined, docked: string | null, pending: CardItem[]): CardItem | null {
  if (!draftTarget || draftTarget !== docked) return null;
  return pending.find((c) => c.id === draftTarget) ?? null;
}

// 输入框上方的一行：这段话发出去对这张卡意味着什么
export function replyHint(card: CardItem): string {
  switch (card.kind) {
    case "permission":
      return t("发送 = 拒绝这一步，并把这段话告诉它");
    case "ask":
      return t("发送 = 用这段话回答上面的问题");
    case "plan":
      return t("发送 = 退回计划，附上这段修改意见");
  }
}

// 卡停着、输入框还空着时的占位提示
export function replyPlaceholder(card: CardItem): string {
  switch (card.kind) {
    case "permission":
      return t("要拒绝就写一句为什么（文字只会拒绝、不会批准）");
    case "ask":
      return t("直接写你的回答，或点上面的选项");
    case "plan":
      return t("写修改意见就是退回；批准请点卡片上的按钮");
  }
}

// 时间线里交互态卡片的占位行
export function slotText(card: CardItem, docked: boolean, typing: boolean): string {
  const what = card.kind === "permission" ? t("一次操作等你批准") : card.kind === "ask" ? t("一个问题等你回答") : t("一份计划等你审");
  if (docked) return t("{what}——在输入框上方", { what });
  if (typing) return t("{what}——停下输入后出现在输入框上方", { what });
  return t("{what}——排在上一张之后", { what });
}
