// 后台 job 表与前台调用表：以前是 bash.ts 的模块级变量，拆成多个模块后收进这一个对象，各模块经它读写同一份。
import type { BashJob, JobListener } from "./jobs.ts";

export const jobState = {
  // 后台 job 的事件订阅者（job-notify.ts 经 onBackgroundJobs 订阅）
  jobListeners: new Set<JobListener>(),
  jobs: new Map<string, BashJob>(),
  jobSeq: 0,
  // R14（K37）：正在前台跑的 Bash 调用（会话 + 调用 id → 转后台的开关）。界面上的「转后台」经 API 按到这里；只认同一个会话的。
  foreground: new Map<string, () => boolean>(),
};
