// U11：前台会话的 Bash 后台 job（任务面板「后台命令」一节 + 工作台「任务」钮上的在跑点）。
//
// job 只活在服务端的 job 表里：跨轮活着，结束时也不往时间线上发事件，所以按需拉——
//   ① 前台会话换了；② 时间线上的 Bash 行提到了新的 job id（起 job、转后台、poll、kill 都会带上 jobN）；
//   ③ 有在跑的就每 3 秒拉一次（页面藏起来不拉）。
// 驱动这三条的 effect 挂在 Dock 上（Dock 关着时没人看，也就不拉）。服务端没报 "jobs" 能力位（旧后端）就什么都不做。
import { app } from "./state.svelte.ts";
import { killSessionJob, listSessionJobs, type JobInfo } from "./api.ts";

export type { JobInfo };

export const jobs = $state({
  sessionId: "",
  list: [] as JobInfo[],
  // 拉到这份列表时的本机时刻：运行中的 job 显示 elapsedMs + (现在 − fetchedAt)
  fetchedAt: 0,
});

export function jobsSupported(): boolean {
  return Boolean(app.compat?.caps?.includes("jobs"));
}

// 时间线上 Bash 行提到过的 job id，连同那一行的状态——有新 job、或者某行跑完了，这串就会变
export function jobMentions(timeline: readonly unknown[]): string {
  const out: string[] = [];
  for (const it of timeline as Array<{ kind?: string; name?: string; status?: string; summary?: string; args?: Record<string, unknown> }>) {
    if (it?.kind !== "tool" || it.name !== "Bash") continue;
    // O6：wait 也算提到了 job；id 带启动标记（job3-k2x9）
    const ref = [it.summary ?? "", it.args?.poll, it.args?.wait, it.args?.kill].filter((v) => typeof v === "string").join(" ");
    const ids = ref.match(/\bjob\d+(?:-[a-z0-9]+)?\b/g);
    if (ids) out.push(`${ids.join("+")}:${it.status ?? ""}`);
  }
  return out.join(",");
}

// 这个会话当前的 job 列表（切了会话、旧列表还没换掉时给空）
export function currentJobs(): JobInfo[] {
  return jobs.sessionId && jobs.sessionId === (app.chat.id ?? "") ? jobs.list : [];
}

let inflight: Promise<void> | null = null;
let inflightId = "";
export function refreshJobs(): Promise<void> {
  const id = app.chat.id ?? "";
  if (!id || !jobsSupported()) {
    if (jobs.sessionId !== id || jobs.list.length) {
      jobs.sessionId = id;
      jobs.list = [];
    }
    return Promise.resolve();
  }
  if (inflight && inflightId === id) return inflight;
  inflightId = id;
  const p: Promise<void> = listSessionJobs(id)
    .then((list) => {
      if ((app.chat.id ?? "") !== id) return; // 等回来时已经切走了
      jobs.sessionId = id;
      jobs.list = list;
      jobs.fetchedAt = Date.now();
    })
    .catch(() => {
      /* 断线 / 旧后端：下次再拉 */
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

export async function stopJob(jobId: string): Promise<void> {
  const id = app.chat.id ?? "";
  if (!id) return;
  await killSessionJob(id, jobId);
  await refreshJobs();
}
