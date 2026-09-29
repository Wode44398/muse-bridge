// 记忆面板的文案表：类型 / 可信度 / 状态的中文名、条目问题码的人话、服务端英文校验原文的翻译；
// 还有四类 / 字形 / 经历的名字与短日期、「多久以前」（memory-viz.ts 要给服务端测试直接 import，碰不了翻译层，文案都放这里）。
// 列表行与展开的详情共用（纯函数，不碰 DOM）。
import type { MemoryMeta } from "../../lib/api.ts";
import { isEn, locale, t, tc, tr } from "../../lib/i18n.ts";
import type { Glyph, Lane, MemoryHistoryWhy } from "./memory-viz.ts";

export const TYPE_LABEL: Record<MemoryMeta["type"], string> = { user: t("偏好"), feedback: t("做法"), project: t("项目"), reference: t("参考") };
export const CONF_LABEL: Record<MemoryMeta["confidence"], string> = {
  user_confirmed: t("你确认过"),
  verified: t("验证过"),
  observed: t("观察到"),
  inferred: t("推测"),
};
export const STATUS_LABEL: Record<MemoryMeta["status"], string> = {
  proposed: t("待确认"),
  active: t("生效中"),
  stale: t("已失效"),
  superseded: t("已被替代"),
  rejected: t("已驳回"),
};

// 四类（统计卡 / 分组标题 / 空组提示），归类口径见 memory-viz.ts 的 laneOf
export const LANE_TEXT: Record<Lane, { label: string; hint: string; empty: string }> = {
  proposed: { label: t("待确认"), hint: t("等你确认才生效"), empty: t("没有等你确认的记忆") },
  held: { label: t("被隔离"), hint: t("写着生效，却没进提示"), empty: t("没有被隔离的记忆") },
  active: { label: t("生效"), hint: t("进每个新对话的提示"), empty: t("还没有生效的记忆") },
  retired: { label: t("已退场"), hint: t("失效、被替代、驳回"), empty: t("没有退场的记忆") },
};
export const GLYPH_TEXT: Record<Glyph, string> = {
  proposed: t("待确认"),
  held: t("被隔离"),
  active: t("生效中"),
  stale: t("已失效"),
  superseded: t("已被替代"),
  rejected: t("已驳回"),
};
// 经历（每一份旧版是怎么来的）：是事件名不是按钮——「改写 / 删除 / 驳回 / 撤销驳回」在英文里走名词语境，别和按钮上的动词撞
export const HISTORY_TEXT: Record<MemoryHistoryWhy, string> = {
  overwrite: tc("名词", "改写"),
  delete: tc("名词", "删除"),
  retire: t("退场"),
  superseded: t("被替代"),
  reject: tc("名词", "驳回"),
  restore: tc("名词", "撤销驳回"),
};

// 条目自带的问题码（issues[]）→ 人话；认不出的原样给；unverified-legacy-metadata 不给人看
const ISSUE_TEXT: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^missing-why$/, () => t("缺「Why:」")],
  [/^missing-how-to-apply$/, () => t("缺「How to apply:」")],
  [/^expired$/, () => t("已过期")],
  [/^missing-anchor:(.+)$/, (m) => t("挂靠的文件不在了：{path}", { path: m[1] })],
  [/^invalid-anchor:(.+)$/, (m) => t("挂靠路径不合法：{path}", { path: m[1] })],
  [/^active-topic-conflict:(.+)$/, (m) => t("同一主题有多条生效：{ids}", { ids: m[1] })],
  [/^sensitive-content$/, () => t("疑似含密钥（正文已隐藏）")],
  [/^missing-evidence$/, () => t("缺证据")],
  [/^missing-verification-time$/, () => t("缺验证时间")],
  [/^active-but-inferred$/, () => t("只是推测却标了生效")],
  [/^legacy-schema$/, () => t("旧格式")],
  [/^missing-topic$/, () => t("缺主题")],
  [/^missing-description$/, () => t("缺说明")],
  [/^injection-pattern$/, () => t("疑似提示注入：模型那边只看得到标题，全文只有你能看")],
  [/^external-session$/, () => t("写它的会话读过外部内容（网页、搜索、浏览器），你确认后才生效")],
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
  m.origin === "user" ? t("你写的") : m.origin === "model" ? (m.attended === false ? t("模型写的（没人在场）") : t("模型写的")) : "";

// ── 短日期与「多久以前」 ────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const msOf = (iso?: string) => {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : NaN;
};

// 短日期：今年「9/28」、往年「2025/9/28」；英文按界面语言写月名（Sep 28 / Sep 28, 2025）
export function fmtShortDate(iso?: string, now = Date.now()): string {
  const ts = msOf(iso);
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (isEn()) {
    const opts: Intl.DateTimeFormatOptions = sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" };
    return new Intl.DateTimeFormat(locale(), opts).format(d);
  }
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return sameYear ? md : `${d.getFullYear()}/${md}`;
}

// 多久以前（按天粗分）：今天 / 昨天 / n 天前（两周内）/ n 周前（两个月内）/ n 个月前（一年内）/ 更早给短日期。
// 只给档位与数：英文里它总嵌在句中（Updated today、most recently 3 days ago），大小写与语序跟着整句走，
// 所以文案由调用处按整句各取一键（MemoryOverview 的「最近 …」、MemoryDetail 的「召回 … 次，最近 …」）。
// n = 天 / 周 / 月数；date 只在 k = "date" 时有值（一年以上给短日期）
export type Ago = { k: "today" | "yesterday" | "days" | "weeks" | "months" | "date"; n: number; date: string };
export function agoOf(iso?: string, now = Date.now()): Ago | null {
  const ts = msOf(iso);
  if (!Number.isFinite(ts)) return null;
  const days = Math.floor((now - ts) / DAY);
  if (days <= 0) return { k: "today", n: 0, date: "" };
  if (days === 1) return { k: "yesterday", n: 1, date: "" };
  if (days < 14) return { k: "days", n: days, date: "" };
  if (days < 60) return { k: "weeks", n: Math.round(days / 7), date: "" };
  if (days < 365) return { k: "months", n: Math.round(days / 30.44), date: "" };
  return { k: "date", n: days, date: fmtShortDate(iso, now) };
}

// K9：写成 active、但因为注入特征 / 外部内容会话被扣成待确认的，也归「待确认」——那是在等你拍板
export type MemoryGroup = "proposed" | "active" | "other";
export const groupOf = (m: MemoryMeta): MemoryGroup =>
  m.declaredStatus === "proposed" || m.status === "proposed" ? "proposed" : m.status === "active" ? "active" : "other";

// 服务端的校验原文是英文：常见的几条说成人话，认不出的原样给
const PROBLEM_TEXT: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/must include a Why: section/, () => t("要有一段「Why:」——为什么是这样")],
  [/must include a How to apply: section/, () => t("要有一段「How to apply:」——以后遇到时怎么做")],
  [/cannot already be expired/, () => t("已经过了到期时间——去掉或改掉到期时间")],
  [/anchor does not exist: (.+)$/, (m) => t("它挂靠的文件已经不在了：{path}", { path: m[1] })],
  [/credential or private key/, () => t("内容里疑似有密钥——只记在哪、别记值")],
  [/needs a one-sentence description/, () => t("要有一句话的说明")],
  [/needs a title/, () => t("要有标题")],
  [/needs content/, () => t("正文不能为空")],
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
      return tr(p); // 认不出的：英文校验原文原样；服务端的中文报错（工作空间不对之类）走字典
    });
}
