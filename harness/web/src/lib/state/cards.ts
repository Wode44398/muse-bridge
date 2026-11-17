// 权限卡、计划卡、问答卡的裁决回传，以及输入框里的话落到停着的卡上。
import * as api from "../api.ts";
import { t, tr } from "../i18n.ts";
import { haptic } from "../touch.ts";
import type { Chat } from "./chat.svelte.ts";
import { app, toast } from "./core.svelte.ts";
import { settleCursors } from "./effects.ts";
import { refreshSessions } from "./lists.ts";
import { forceResync } from "./resync.ts";
import { killLive } from "./run.ts";

// P10：卡片落定的结果——ok 送达；gone 卡已经失效（超时 / 这一轮已结束 / 别的设备先定了）；failed 没送达（网络）。
// quiet：输入框里的话落到卡上（N43）时由调用方自己说明，这里不另弹提示。
export type CardReply = "ok" | "gone" | "failed";

// 权限卡：把裁决回传。乐观置位，服务端广播 permission_resolved 再确认（幂等）。
// scope："prefix" = 本会话按前缀允许（记下卡片上显示的那几条前缀规则）；"deny_stop" = 拒绝并停止这一轮
// P10：note = 拒绝时附的话（N43：输入框里的话落到卡上——文字只走拒绝方向）
export async function decidePermission(
  id: string,
  decision: "once" | "session" | "deny" | "deny_stop",
  scope?: "prefix",
  note?: string,
  quiet = false,
): Promise<CardReply> {
  const chat = app.chat;
  const ref = chat.permRefs.get(id);
  if (!chat.id || !ref || ref.decided) return "gone";
  ref.decided = decision;
  if (scope) ref.scope = scope;
  if (note && decision === "deny") ref.note = note;
  haptic("light");
  // P6：拒绝并停止 = 服务端一步拒掉并停下这一轮。本端照停止键的做法先断开实时流（停下来的 aborted 不当错误显示），
  // 再送裁决；没送达就重新接上。
  const stopping = decision === "deny_stop";
  if (stopping) killLive(chat);
  try {
    const res = await api.decidePermission(chat.id, id, decision, scope, note);
    if (res && res.ok === false) {
      // P7：卡片已经失效（超时按拒绝处理了 / 这一轮已结束）——别装作点成功了
      ref.decided = null;
      ref.scope = undefined;
      ref.note = undefined;
      ref.cancelled = true;
      if (!quiet) toast(t("这张卡已经失效了（超时或这一轮已结束），没送达"));
      if (stopping) forceResync(chat);
      return "gone";
    }
  } catch {
    ref.decided = null; // 没送达 → 退回可点，用户可重试
    ref.scope = undefined;
    ref.note = undefined;
    if (!quiet) toast(t("没送达，请再点一次"));
    if (stopping) forceResync(chat);
    return "failed";
  }
  if (stopping) {
    settleCursors(chat);
    chat.running = false;
    chat.activity = "";
    chat.runId = null;
    if (app.features.sessions) refreshSessions();
  }
  return "ok";
}

// 计划卡：批准 / 退回（退回可带一句修改意见）。
export async function decidePlan(id: string, approved: boolean, note?: string, quiet = false): Promise<CardReply> {
  const chat = app.chat;
  const ref = chat.planRefs.get(id);
  if (!chat.id || !ref || ref.decided) return "gone";
  ref.decided = approved ? "approved" : "returned";
  if (!approved && note) ref.note = note;
  haptic("light");
  try {
    const res = await api.decidePlan(chat.id, id, approved, note);
    if (res && res.ok === false) {
      // P7：计划卡已经失效（超时 / 这一轮已结束）
      ref.decided = null;
      ref.note = undefined;
      ref.cancelled = true;
      if (!quiet) toast(t("这份计划的审批已经失效了（超时或这一轮已结束），没送达"));
      return "gone";
    }
  } catch {
    ref.decided = null;
    ref.note = undefined;
    if (!quiet) toast(t("没送达，请再点一次"));
    return "failed";
  }
  return "ok";
}

// P10（N43）：输入框里的话落到停着的那张卡上。权限卡 = 拒绝并附上这段话（文字永远不能批准）；提问 = 每题都以这段话作
// 「其他」答案；计划 = 退回并附上这段话。卡已经不在等了（别的设备先定了 / 失效了）返回 "gone"，由调用方改作插话。
export async function replyToCard(chat: Chat, id: string, text: string): Promise<CardReply> {
  const perm = chat.permRefs.get(id);
  if (perm) return perm.decided || perm.cancelled ? "gone" : decidePermission(id, "deny", undefined, text, true);
  const plan = chat.planRefs.get(id);
  if (plan) return plan.decided || plan.cancelled ? "gone" : decidePlan(id, false, text, true);
  const ask = chat.askRefs.get(id);
  if (ask) return ask.answered ? "gone" : answerAsk(id, ask.questions.map(() => ({ selected: [text], custom: true })), true);
  return "gone";
}

// 提交一个 AskUserQuestion 回答。answers 与卡片问题同序。乐观标记已答（随后的
// ask_answer 事件再确认一次，幂等）；POST 失败则回滚，允许重试。
export async function answerAsk(
  id: string,
  answers: { selected: string[]; custom?: boolean }[],
  quiet = false,
): Promise<CardReply> {
  const chat = app.chat;
  const ref = chat.askRefs.get(id);
  if (!ref || ref.answered || !chat.id) return "gone";
  ref.answered = true;
  ref.questions.forEach((q, i) => {
    ref.selected[q.id] = answers[i]?.selected ?? [];
  });
  chat.activity = t("思考中");
  haptic("light");
  try {
    const res = await api.answerAsk(chat.id, id, answers);
    if (!res?.ok) {
      // 服务端说这个 ask 已失效（P7 超时 / 这一轮已结束 / 被别的设备先答了）。答案没送到 agent——以前保持已答视图、
      // 不吭声，用户以为答上了。现在说一声，并清掉本端写上去的所选；别的设备先答的（ask_answer 已经写回来、和本端
      // 这次不一样）留着。按内容比，不按引用比：Svelte 5 的深代理读回来的不是原数组。
      const mine = ref.questions.every((q, i) => JSON.stringify(ref.selected[q.id] ?? []) === JSON.stringify(answers[i]?.selected ?? []));
      if (mine) ref.questions.forEach((q) => (ref.selected[q.id] = []));
      if (!quiet) toast(t("这个问题已经失效了（超时或这一轮已结束），这次的答案没送到"));
      return "gone";
    }
  } catch (e: any) {
    if (!quiet) toast(t("回答失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    ref.answered = false; // 回滚，让用户重试
    ref.questions.forEach((q) => (ref.selected[q.id] = []));
    return "failed";
  }
  return "ok";
}
