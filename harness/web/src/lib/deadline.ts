// P7：阻塞卡片上的「几点前没人处理会怎样」——只显示本地时钟的时:分，不跑秒表（每张卡一个定时器不值当）。
// 中文照旧 24 小时制「HH:MM」；英文按当地习惯交给 Intl（12 小时制「3:04 PM」）。
import { isEn, locale } from "./i18n.ts";

export function clockOf(at: number): string {
  const d = new Date(at);
  if (isEn()) return new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit" }).format(d);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
