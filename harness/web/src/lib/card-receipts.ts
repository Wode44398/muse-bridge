// #103：历史里重建已落定的权限卡、计划卡。服务端把回执随 tool_result.meta 落盘（见 server/agent/card-receipts.ts）：
// meta.permissions = 这次调用弹过的权限卡（策略转问一张、越界只读再一张），meta.plan = ExitPlanMode 的计划卡。
// 卡片 id 与直播时同一个——断线对账（mergeTimeline 按指纹比）认得出是同一张卡，不会从这里开始整段重渲染。
// 回执落盘之前的旧记录：权限卡没有可重建的数据；计划卡按 ExitPlanMode 结果的固定开头认出结论（计划正文就在调用参数里）。
// 刻意不依赖 Svelte / 浏览器全局，好在 Node 里直接测。
import type { ApprovalPreview, DecidedBy, PermissionItem, PlanItem } from "./timeline-types.ts";

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function decidedBy(v: any): DecidedBy | undefined {
  return v && typeof v.id === "string" && v.id && typeof v.label === "string" ? { id: v.id, label: v.label } : undefined;
}

function cancelledOf(v: unknown): "timeout" | "withdrawn" | undefined {
  return v === "timeout" || v === "withdrawn" ? v : undefined;
}

const PERMISSION_DECISIONS = new Set(["once", "session", "deny", "deny_stop"]);

export function permissionItemsFromMeta(meta: any): PermissionItem[] {
  const out: PermissionItem[] = [];
  for (const r of Array.isArray(meta?.permissions) ? meta.permissions : []) {
    const id = text(r?.id);
    const tool = text(r?.tool);
    if (!id || !tool) continue;
    const decided: PermissionItem["decided"] = PERMISSION_DECISIONS.has(r.decided) ? r.decided : null;
    const cancelled = decided ? undefined : cancelledOf(r.cancelled);
    if (!decided && !cancelled) continue;
    const rules = Array.isArray(r.rules) ? r.rules.filter((s: unknown): s is string => typeof s === "string") : [];
    const by = decidedBy(r.by);
    out.push({
      kind: "permission",
      id,
      tool,
      subject: typeof r.subject === "string" ? r.subject : "",
      decided,
      ...(text(r.rule) ? { rule: r.rule } : {}),
      ...(cancelled ? { cancelled: true, ...(cancelled === "timeout" ? { cancelReason: "timeout" as const } : {}) } : {}),
      // 回执里「记下的规则」：按前缀选的放 prefixRules，否则放 sessionRules（与 PermissionCard 的 recorded 同一个取法）
      ...(decided === "session" && rules.length ? (r.scope === "prefix" ? { scope: "prefix" as const, prefixRules: rules } : { sessionRules: rules }) : {}),
      ...(by ? { by } : {}),
      ...(text(r.note) ? { note: r.note } : {}),
      ...(text(r.why) ? { why: r.why } : {}),
      ...(r.preview && typeof r.preview === "object" && typeof r.preview.kind === "string" ? { preview: r.preview as ApprovalPreview } : {}),
      ...(r.noSession === true ? { noSession: true } : {}),
    });
  }
  return out;
}

function resultText(block: any): string {
  return (Array.isArray(block?.content) ? block.content : []).map((b: any) => (b?.t === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

// ExitPlanMode 的一次调用 → 计划卡（没弹过卡的——离开模式、没人在场、参数不对——返回 null）
export function planItemFromResult(callId: string, args: any, block: any): PlanItem | null {
  const plan = typeof args?.plan === "string" ? args.plan.trim() : "";
  if (!plan) return null;
  const r = block?.meta?.plan;
  if (r && typeof r === "object") {
    const id = text(r.id);
    const decided: PlanItem["decided"] = r.decided === "approved" || r.decided === "returned" || r.decided === "handoff" ? r.decided : null;
    const cancelled = decided ? undefined : cancelledOf(r.cancelled);
    if (!id || (!decided && !cancelled)) return null;
    const by = decidedBy(r.by);
    return {
      kind: "plan",
      id,
      plan,
      decided,
      ...(cancelled ? { cancelled: true, ...(cancelled === "timeout" ? { cancelReason: "timeout" as const } : {}) } : {}),
      ...(by ? { by } : {}),
      ...(decided !== "approved" && text(r.note) ? { note: r.note } : {}),
    };
  }
  // 旧记录：认 ExitPlanMode 结果的固定开头（server/tools/exitplanmode.ts）
  const said = resultText(block);
  const base = { kind: "plan" as const, id: `plan:${callId}`, plan };
  if (said.startsWith("The user APPROVED")) return { ...base, decided: "approved" };
  if (said.startsWith("The user is carrying this plan out in a NEW session")) return { ...base, decided: "handoff" };
  if (said.startsWith("The user did NOT approve")) {
    const m = /Their feedback: ([\s\S]*?)\nRevise the plan accordingly/.exec(said);
    return { ...base, decided: "returned", ...(m?.[1]?.trim() ? { note: m[1].trim() } : {}) };
  }
  if (said.startsWith("Nobody reviewed the plan within")) return { ...base, decided: null, cancelled: true, cancelReason: "timeout" };
  if (said.startsWith("The run ended before the user decided on the plan")) return { ...base, decided: null, cancelled: true };
  return null;
}

// 回执插在它那一行工具后面（同一次调用的几张卡按先后排）；找不到那一行就接在末尾
export function insertAfter<T>(items: T[], anchor: T | undefined, extra: T[]): void {
  if (!extra.length) return;
  const i = anchor === undefined ? -1 : items.lastIndexOf(anchor);
  if (i < 0) items.push(...extra);
  else items.splice(i + 1, 0, ...extra);
}
