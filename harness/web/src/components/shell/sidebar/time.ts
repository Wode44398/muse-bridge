// 侧栏会话行与正文命中上的时间。
import { isEn, locale, t } from "../../../lib/i18n.ts";

// ── 时间：今天 = 时刻；昨天；今年 = 月/日；更早 = 年/月/日 ──────────────────────────────
export function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  // 英文：3:04 PM · Yesterday · Sep 28 · Sep 28, 2025（中文照旧手拼数字）
  if (isEn() && diff !== 1) {
    if (diff <= 0) return d.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(locale(), sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  }
  if (diff <= 0) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diff === 1) return t("昨天");
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
