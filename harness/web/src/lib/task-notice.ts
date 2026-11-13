// 后台任务通知（server/job-notify.ts 的 <task-notification> 片段）在时间线上的一行提示（纯函数：服务端测试直接导入）。
import { isEn, t } from "./i18n.ts";

export const TASK_NOTIFICATION_KIND = "task-notification";

export function taskNoticeText(text: string): string {
  const sep = isEn() ? ", " : "、";
  const ends = [...text.matchAll(/Background job (\S+) finished: ([^\n]+)/g)].map((m) => `${m[1]} (${m[2].trim()})`);
  if (ends.length) return t("后台任务跑完了：{list}", { list: ends.join(sep) });
  const watched = [...new Set([...text.matchAll(/Background job (\S+) \(still running\) printed/g)].map((m) => m[1]))];
  if (watched.length) return t("后台任务输出了在盯的内容：{list}", { list: watched.join(sep) });
  return t("后台任务通知");
}
