// P8（K35、E2）：全局事件通道上的会话状态变化 → 要不要通知、怎么通知。纯函数，便于测试。
//   · 只对【新出现】的等待发（按卡片 id 去重）；连上时快照里已经在等的只作基线，不补发（ZCode 的规矩）。
//   · 人在不在看：页面隐藏（锁屏、切到别的 App）→ 系统通知；页面可见但不是这个会话 → 应用内提示；
//     正看着这个会话 → 什么都不发（卡片就在眼前）。已经挂着直播的后台会话，应用内提示由时间线归约器发，这里不重复。
//   · 通知正文只放终态事实（在等你批准 / 回答 / 审计划、哪个工具、跑完了），不放命令、路径和模型原文。
import { t } from "./i18n.ts";

export interface WaitingInfo {
  kind: "permission" | "ask" | "plan";
  id: string;
  tool?: string;
}

export interface StatusEvent {
  id: string;
  title: string;
  running: boolean;
  waiting: WaitingInfo | null;
}

export interface NotifyState {
  notified: Set<string>; // 已经为之通知过的卡片 id
  wasRunning: Map<string, boolean>;
}

export interface NotifyView {
  hidden: boolean; // 页面不可见
  foregroundId: string | null; // 眼前这个会话
  residentIds: ReadonlySet<string>; // 已经挂着直播的会话（归约器会自己提示）
}

export interface Notice {
  system?: { title: string; text: string };
  toast?: string;
}

// 标题与正文分开成整句（英文里主语、大小写、语序都跟中文不同，不能拼）
function waitTitle(kind: WaitingInfo["kind"]): string {
  if (kind === "permission") return t("dimensio · 在等你批准");
  if (kind === "ask") return t("dimensio · 在等你回答");
  return t("dimensio · 提交了计划，等你审");
}

function waitText(kind: WaitingInfo["kind"], who: string, tool?: string): string {
  if (kind === "permission") return tool ? t("{name}在等你批准（{tool}）", { name: who, tool }) : t("{name}在等你批准", { name: who });
  if (kind === "ask") return t("{name}在等你回答", { name: who });
  return t("{name}提交了计划，等你审", { name: who });
}

function name(title: string): string {
  const s = title.replace(/\s+/g, " ").trim();
  return s ? t("「{title}」", { title: s.length > 24 ? s.slice(0, 24) + "…" : s }) : t("一个对话");
}

// 快照：已经在等的记为通知过（基线），记下谁在跑
export function applySnapshot(state: NotifyState, rows: StatusEvent[]): void {
  for (const row of rows) {
    if (row.waiting) state.notified.add(row.waiting.id);
    state.wasRunning.set(row.id, row.running);
  }
}

export function noticeFor(state: NotifyState, ev: StatusEvent, view: NotifyView): Notice | null {
  const was = state.wasRunning.get(ev.id) ?? false;
  state.wasRunning.set(ev.id, ev.running);
  const watching = !view.hidden && view.foregroundId === ev.id;
  const resident = view.residentIds.has(ev.id);
  if (ev.waiting && !state.notified.has(ev.waiting.id)) {
    state.notified.add(ev.waiting.id);
    if (watching) return null;
    const text = waitText(ev.waiting.kind, name(ev.title), ev.waiting.tool);
    if (view.hidden) return { system: { title: waitTitle(ev.waiting.kind), text } };
    return resident ? null : { toast: text };
  }
  if (was && !ev.running && !ev.waiting) {
    if (watching) return null;
    const text = t("{name}这一轮跑完了", { name: name(ev.title) });
    if (view.hidden) return { system: { title: t("dimensio · 完成"), text } };
    return resident ? null : { toast: text };
  }
  return null;
}
