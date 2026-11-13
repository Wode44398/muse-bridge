// 通知：dimensio 在等你批准权限 / 回答提问 / 审计划，或一轮做完时，经 bridge 的推送渠道提醒你（手机 App 的后台服务、
// 插件登记的通知渠道如飞书 / Telegram），三类各由偏好开关（与 Claude 的「通知」三项同名同义）。
//
// 界面开着的时候页面自己会提醒（页面隐藏 → 系统通知，可见但不在那个会话 → 应用内提示），它同样认这三个开关。这里补的是
// 「没有一个界面看着」的情形：各个界面经 POST /api/sessmgmt/presence 报「我可见、在看哪个会话」，最近 45 秒内有界面可见就不推
//（人就在 App 前，界面里已经有卡片 / 提示了），否则推一条。等待按卡片 id 去重；做完的只认真做完或出错的轮（人停的不算），
// 后面紧跟着排队的话要发的也不算（马上又开一轮）。正文只放终态事实，不放命令、路径、模型原文（锁屏通知的规矩）。
import { pushToBridge } from "../bridge-events.ts";
import { prefValue } from "../prefs.ts";

const PRESENCE_MS = 45_000;
const presence = new Map<string, { visible: boolean; session: string | null; at: number }>();
const CLIENT_RE = /^[A-Za-z0-9_-]{4,80}$/;

export function notePresence(client: unknown, visible: unknown, session: unknown): boolean {
  if (typeof client !== "string" || !CLIENT_RE.test(client)) return false;
  presence.set(client, { visible: visible === true, session: typeof session === "string" && session ? session.slice(0, 80) : null, at: Date.now() });
  if (presence.size > 200) {
    const now = Date.now();
    for (const [k, v] of presence) if (now - v.at > PRESENCE_MS) presence.delete(k);
  }
  return true;
}

export function someoneLooking(now = Date.now()): boolean {
  for (const v of presence.values()) if (v.visible && now - v.at < PRESENCE_MS) return true;
  return false;
}

export type NotifyKind = "permission" | "ask" | "plan" | "done" | "error";

export function notifyAllowed(kind: NotifyKind): boolean {
  if (kind === "permission" || kind === "plan") return prefValue<boolean>("notifyPermission");
  if (kind === "ask") return prefValue<boolean>("notifyQuestion");
  return prefValue<boolean>("notifyTaskComplete");
}

// 三项偏好给界面与手机 App 的原生通知服务（/api/pending 带上）
export function notifyPrefs(): { permission: boolean; question: boolean; done: boolean } {
  return { permission: prefValue<boolean>("notifyPermission"), question: prefValue<boolean>("notifyQuestion"), done: prefValue<boolean>("notifyTaskComplete") };
}

function nameOf(title: string): string {
  const s = String(title ?? "").replace(/\s+/g, " ").trim();
  return s ? `「${s.length > 24 ? s.slice(0, 24) + "…" : s}」` : "一个对话";
}

export function noticeText(kind: NotifyKind, title: string, tool?: string): { title: string; message: string } {
  const who = nameOf(title);
  switch (kind) {
    case "permission":
      return { title: "dimensio · 在等你批准", message: tool ? `${who}在等你批准（${tool}）` : `${who}在等你批准` };
    case "ask":
      return { title: "dimensio · 在等你回答", message: `${who}在等你回答` };
    case "plan":
      return { title: "dimensio · 提交了计划，等你审", message: `${who}提交了计划，等你审` };
    case "error":
      return { title: "dimensio · 出错了", message: `${who}这一轮出错停下了` };
    default:
      return { title: "dimensio · 完成", message: `${who}这一轮跑完了` };
  }
}

const pushed = new Set<string>();
// 返回是否真的推了（测试与日志用）
export function maybePush(kind: NotifyKind, dedupe: string, sessionId: string, title: string, tool?: string): boolean {
  if (pushed.has(dedupe)) return false;
  pushed.add(dedupe);
  if (pushed.size > 500) pushed.delete(pushed.values().next().value!);
  if (!notifyAllowed(kind) || someoneLooking()) return false;
  const text = noticeText(kind, title, tool);
  return pushToBridge({ ...text, sessionId, level: kind === "error" ? "warn" : "info" });
}

// 测试用
export function resetNotify(): void {
  presence.clear();
  pushed.clear();
}
