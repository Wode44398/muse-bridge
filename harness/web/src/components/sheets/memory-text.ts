// 记忆面板的文案表：类型 / 可信度 / 状态的中文名、条目问题码的人话、服务端英文校验原文的翻译。
// 列表行与展开的详情共用（纯函数，不碰 DOM）。
import type { MemoryMeta } from "../../lib/api.ts";

export const TYPE_LABEL: Record<MemoryMeta["type"], string> = { user: "偏好", feedback: "做法", project: "项目", reference: "参考" };
export const CONF_LABEL: Record<MemoryMeta["confidence"], string> = {
  user_confirmed: "你确认过",
  verified: "验证过",
  observed: "观察到",
  inferred: "推测",
};
export const STATUS_LABEL: Record<MemoryMeta["status"], string> = {
  proposed: "待确认",
  active: "生效中",
  stale: "已失效",
  superseded: "已被替代",
  rejected: "已驳回",
};

// 条目自带的问题码（issues[]）→ 人话；认不出的原样给；unverified-legacy-metadata 不给人看
const ISSUE_TEXT: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^missing-why$/, () => "缺「Why:」"],
  [/^missing-how-to-apply$/, () => "缺「How to apply:」"],
  [/^expired$/, () => "已过期"],
  [/^missing-anchor:(.+)$/, (m) => `挂靠的文件不在了：${m[1]}`],
  [/^invalid-anchor:(.+)$/, (m) => `挂靠路径不合法：${m[1]}`],
  [/^active-topic-conflict:(.+)$/, (m) => `同一主题有多条生效：${m[1]}`],
  [/^sensitive-content$/, () => "疑似含密钥（正文已隐藏）"],
  [/^missing-evidence$/, () => "缺证据"],
  [/^missing-verification-time$/, () => "缺验证时间"],
  [/^active-but-inferred$/, () => "只是推测却标了生效"],
  [/^legacy-schema$/, () => "旧格式"],
  [/^missing-topic$/, () => "缺主题"],
  [/^missing-description$/, () => "缺说明"],
  [/^injection-pattern$/, () => "疑似提示注入：模型那边只看得到标题，全文只有你能看"],
  [/^external-session$/, () => "写它的会话读过外部内容（网页、搜索、浏览器），你确认后才生效"],
];
export function issueText(issue: string): string {
  for (const [re, say] of ISSUE_TEXT) {
    const m = issue.match(re);
    if (m) return say(m);
  }
  return issue === "unverified-legacy-metadata" ? "" : issue;
}
// 列表上的「⚠ n」按过滤掉隐藏项之后的条数算
export const issuesOf = (m: MemoryMeta): string[] => (m.issues ?? []).map(issueText).filter(Boolean);

export function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : iso;
}

export const originText = (m: MemoryMeta): string =>
  m.origin === "user" ? "你写的" : m.origin === "model" ? (m.attended === false ? "模型写的（没人在场）" : "模型写的") : "";

// K9：写成 active、但因为注入特征 / 外部内容会话被扣成待确认的，也归「待确认」——那是在等你拍板
export type MemoryGroup = "proposed" | "active" | "other";
export const groupOf = (m: MemoryMeta): MemoryGroup =>
  m.declaredStatus === "proposed" || m.status === "proposed" ? "proposed" : m.status === "active" ? "active" : "other";

// 服务端的校验原文是英文：常见的几条说成人话，认不出的原样给
const PROBLEM_TEXT: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/must include a Why: section/, () => "要有一段「Why:」——为什么是这样"],
  [/must include a How to apply: section/, () => "要有一段「How to apply:」——以后遇到时怎么做"],
  [/cannot already be expired/, () => "已经过了到期时间——去掉或改掉到期时间"],
  [/anchor does not exist: (.+)$/, (m) => `它挂靠的文件已经不在了：${m[1]}`],
  [/credential or private key/, () => "内容里疑似有密钥——只记在哪、别记值"],
  [/needs a one-sentence description/, () => "要有一句话的说明"],
  [/needs a title/, () => "要有标题"],
  [/needs content/, () => "正文不能为空"],
];
export function explain(error: string): string[] {
  const parts = /problems, fix them all in one retry: (.*)$/.exec(error)?.[1]?.split(/;\s*\(\d+\)\s*/) ?? [error];
  return parts
    .map((p) => p.replace(/^\(\d+\)\s*/, "").trim())
    .filter(Boolean)
    .map((p) => {
      for (const [re, say] of PROBLEM_TEXT) {
        const m = p.match(re);
        if (m) return say(m);
      }
      return p;
    });
}
