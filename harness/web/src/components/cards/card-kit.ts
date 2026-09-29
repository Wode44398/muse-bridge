// 交互卡共用的小工具（只给 components/cards/ 用）：等待窗口、剩余时间文案、卡片草稿。
// 纯 TS，不碰 DOM。
import type { CardItem } from "../../lib/card-dock.ts";
import { t } from "../../lib/i18n.ts";

// P7：卡片从出现到作废的窗口（分钟）。卡片事件只带 deadlineAt、不带出现的时刻，尺寸线要知道「满」是多长，
// 就照服务端的定值估（server/session.ts 的 INTERACTION_TIMEOUT_MIN：提问 10 分钟、plan 档提问 60 分钟、
// 权限 10 分钟、计划 60 分钟）。停进来时实测的剩余比这还长（服务端倍率调大）就以实测为准。
const WINDOW_MIN = { ask: 10, askPlan: 60, permission: 10, plan: 60 } as const;

export function cardWindowMs(kind: CardItem["kind"], planMode: boolean): number {
  const min = kind === "ask" ? (planMode ? WINDOW_MIN.askPlan : WINDOW_MIN.ask) : WINDOW_MIN[kind];
  return min * 60_000;
}

const pad = (n: number) => String(n).padStart(2, "0");

// 剩余时间：9:41 / 0:05 / 1:02:03（向上取整：还剩 0.4 秒也算 0:01，到 0:00 才是真到点）
export function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// 读屏用：还剩 9 分 41 秒
export function leftLabel(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? t("还剩 {m} 分 {s} 秒", { m, s: s % 60 }) : t("还剩 {s} 秒", { s });
}

// Q12：卡片乐观落定就离开停靠区；POST 没送达会退回可点、重新停进来（组件重新挂载）。以前问答卡选了一半的
// 选项、权限卡选的「这一条 / 按前缀」随之丢掉。草稿挂在条目对象上（WeakMap：条目随会话被回收，草稿跟着走），
// 重新挂载时照原样恢复。
export interface AskDraft {
  sel: Record<string, string[]>;
  customText: Record<string, string>;
  customOpen: Record<string, boolean>;
  step: number;
}
export const askDrafts = new WeakMap<object, AskDraft>();
export const scopeDrafts = new WeakMap<object, "exact" | "prefix">();
