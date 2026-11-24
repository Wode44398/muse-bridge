// 定时唤醒（server/wakeup/scheduler.ts 的 [Scheduled wakeup] 片段）在时间线上的一行提示（纯函数：服务端测试直接导入）。
import { t } from "./i18n.ts";

export const WAKEUP_KIND = "wakeup";

export function wakeupNoticeText(text: string): string {
  const reason = /^\[Scheduled wakeup\][^\n]*?Reason: ([^\n]+)/.exec(text)?.[1]?.trim() ?? "";
  const late = /It fired (\d+ \w+) late/.test(text);
  if (reason) return late ? t("定时唤醒（晚了一会儿）：{reason}", { reason }) : t("定时唤醒：{reason}", { reason });
  return late ? t("定时唤醒（晚了一会儿）") : t("定时唤醒");
}
