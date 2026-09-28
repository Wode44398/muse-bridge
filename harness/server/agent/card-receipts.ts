// #103：权限卡、计划卡的回执随工具结果的 meta 落盘（provider 不发 meta，与 U8 的 outcome 同一条路）。以前这两种卡只由
// permission_ask / plan_ask 事件生成、裁决没进消息：刷新或换台设备打开会话，「已允许一次 · 在手机上」「计划已批准」就没了，
// 批的是哪一档、谁在哪台设备上定的、拒绝时附的话都找不回来。
// 卡片 id 与直播时同一个——前端断线对账（mergeTimeline 按指纹比）认得出是同一张卡。没弹卡的（离开模式直接拒、本会话已允许
// 过直接放行）没有回执：直播里也没有那张卡。
import type { ApprovalPreview } from "../tools/types.ts";
import type { DecidedBy } from "./events.ts";

// 判定对象（命令原文等）存这么多字；卡上的执行事实（preview）本身已按 PREVIEW_CAP 截过
const SUBJECT_CAP = 2000;

export interface PermissionReceipt {
  id: string;
  tool: string;
  subject: string;
  rule?: string;
  // null = 卡片没等到人就作废了（cancelled 说是超时还是这一轮先结束了）
  decided: "once" | "session" | "deny" | "deny_stop" | null;
  cancelled?: "timeout" | "withdrawn";
  // 「本会话都允许」记下的规则，scope "prefix" = 选的是按前缀
  rules?: string[];
  scope?: "prefix";
  by?: DecidedBy;
  // 拒绝时附的话
  note?: string;
  why?: string;
  preview?: ApprovalPreview;
  noSession?: boolean;
}

export interface PlanReceipt {
  id: string;
  decided: "approved" | "returned" | "handoff" | null;
  cancelled?: "timeout" | "withdrawn";
  by?: DecidedBy;
  // 退回时的修改意见
  note?: string;
}

export interface PermissionCardRequest {
  tool: string;
  subject: string;
  rule?: string;
  why?: string;
  preview?: ApprovalPreview;
  noSession?: boolean;
}

export interface PermissionCardVerdict {
  card?: string;
  decision: "once" | "session" | "deny";
  note?: string;
  unanswered?: boolean;
  timedOut?: boolean;
  stop?: boolean;
  rules?: string[];
  by?: DecidedBy;
  prefix?: boolean;
}

export function permissionReceipt(req: PermissionCardRequest, v: PermissionCardVerdict): PermissionReceipt | undefined {
  if (!v.card) return undefined;
  const base = {
    id: v.card,
    tool: req.tool,
    subject: req.subject.length > SUBJECT_CAP ? `${req.subject.slice(0, SUBJECT_CAP)}…` : req.subject,
    ...(req.rule ? { rule: req.rule } : {}),
    ...(req.why ? { why: req.why } : {}),
    ...(req.preview ? { preview: req.preview } : {}),
    ...(req.noSession ? { noSession: true } : {}),
  };
  if (v.unanswered) return { ...base, decided: null, cancelled: v.timedOut ? "timeout" : "withdrawn" };
  const by = v.by ? { by: v.by } : {};
  if (v.decision === "deny") {
    const note = v.note?.trim();
    return { ...base, decided: v.stop ? "deny_stop" : "deny", ...by, ...(note ? { note } : {}) };
  }
  if (v.decision === "session") {
    return { ...base, decided: "session", ...by, ...(v.rules?.length ? { rules: v.rules } : {}), ...(v.prefix ? { scope: "prefix" as const } : {}) };
  }
  return { ...base, decided: "once", ...by };
}

export function planReceipt(v: {
  card?: string;
  approved: boolean;
  note?: string;
  unanswered?: boolean;
  timedOut?: boolean;
  handoff?: boolean;
  by?: DecidedBy;
}): PlanReceipt | undefined {
  if (!v.card) return undefined;
  if (v.unanswered) return { id: v.card, decided: null, cancelled: v.timedOut ? "timeout" : "withdrawn" };
  return {
    id: v.card,
    decided: v.handoff ? "handoff" : v.approved ? "approved" : "returned",
    ...(v.by ? { by: v.by } : {}),
    ...(!v.approved && v.note ? { note: v.note } : {}),
  };
}
