// 拉取请求的展示文案（纯函数：state.svelte.ts 的提示条与 PR 卡共用，不碰 DOM、不引状态）。
import { isEn, t, tc } from "./i18n.ts";

// 自动修复叫醒的那一轮首条（harness 片段 kind ci-event，正文是 bridge 拼的 <ci-monitor-event>）：界面上只给一行
export function ciEventNotice(text: string): string {
  const pr = /(\S+ PR #\d+)/.exec(text)?.[1] ?? "";
  const what: string[] = [];
  if (/项 CI 检查失败/.test(text)) what.push(t("CI 失败"));
  if (/合并冲突/.test(text)) what.push(t("合并冲突"));
  if (/条新的评审意见/.test(text)) what.push(t("新评审意见"));
  const list = what.join(isEn() ? ", " : "、");
  if (pr && list) return t("自动修复 · {pr}：{what}", { pr, what: list });
  return t("收到拉取请求事件（自动修复）");
}

export const stateLabel = (s: string): string =>
  s === "open"
    ? t("打开")
    : s === "draft"
      ? t("草稿")
      : s === "queued"
        ? t("合并队列中")
        : s === "merged"
          ? t("已合并")
          : s === "closed"
            ? tc("claude", "已关闭")
            : s;

export const reviewLabel = (d: string | null | undefined): string =>
  d === "APPROVED" ? t("已批准") : d === "CHANGES_REQUESTED" ? t("需修改") : d === "REVIEW_REQUIRED" ? t("待审查") : "";

// gh 不可用的原因（bridge 的 github.mjs REASONS 同一套键）
export function ghReason(r: string | undefined): string {
  switch (r) {
    case "gh_not_installed":
      return t("未安装 GitHub CLI（gh）");
    case "gh_not_authenticated":
      return t("请运行 gh auth login 登录");
    case "rate_limited":
      return t("触发 GitHub 限流，正在自动重试");
    case "network":
      return t("无法连接 GitHub，请检查网络");
    default:
      return t("请确认 gh 已安装并已登录");
  }
}

// 自动修复暂停的原因（bridge pr-monitor 的 fix.paused）
export function pausedLabel(p: string): string {
  if (p === "streak") return t("连续自动修复了 5 次都没有人发话，已暂停");
  if (p === "daily") return t("今天的自动修复次数用完了，已暂停");
  return t("自动修复已暂停");
}

export const conflicting = (p: { mergeable?: string; mergeStateStatus?: string }): boolean =>
  p.mergeable === "CONFLICTING" || p.mergeStateStatus === "DIRTY";
