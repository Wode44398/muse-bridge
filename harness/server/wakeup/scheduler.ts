// 定时唤醒到点开轮：按账本（store.ts）给每个待触发的唤醒挂定时器，到点取走、组一条 harness 片段（kind wakeup），交给后台任务
// 通知那套投递（job-notify.ts queueAutoNotice）——会话收工了就开一轮，正在跑（用户正在对话、别的入口开的轮）就在两步之间注入；
// 自动开轮的上限与后台任务通知合并计数，满了攒到用户下一条消息时附上。
// 服务重启：启动时把盘上的读回来重新挂；错过的时间点在启动后尽快补触发（错开几秒，别一起挤进来），片段里写明晚了多久。
// 这一轮不算用户发话：离开模式不因它关掉，需要批准的调用照「有没有人在场」的平常规矩处理（离开模式下按离开的偏好落定）。
import { queueAutoNotice, registerAutoKind, defang } from "../job-notify.ts";
import { onWakeupsChanged, pendingWakeups, takeWakeup, wakeupOwners, WAKEUP_KIND, type Wakeup } from "./store.ts";

export const WAKEUP_HEAD = "[Scheduled wakeup]";
const LABEL = "（定时唤醒）";
const OVERDUE_FIRST_MS = 5_000; // 启动时已经过点的：这么久之后补触发第一个
const OVERDUE_GAP_MS = 2_000; // 之后每个再错开这么久
const LATE_NOTE_MS = 60_000; // 晚了超过这么久才在片段里说「晚了多久」

registerAutoKind(WAKEUP_KIND, LABEL);

const timers = new Map<string, Map<string, NodeJS.Timeout>>(); // 会话 id → 唤醒 id → 定时器

const mins = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 120 ? `${m} minute${m === 1 ? "" : "s"}` : `${Math.round(m / 60)} hours`;
};

/** 到点那一轮的首条（给模型看；界面上一行提示，见 web 的 wakeup-notice.ts）。 */
export function wakeupText(w: Wakeup, now = Date.now()): string {
  const late = now - w.dueAt;
  const lines = [
    `${WAKEUP_HEAD} ${w.id}, scheduled ${mins(now - w.createdAt)} ago.${w.reason ? ` Reason: ${defang(w.reason)}` : ""}`,
    ...(late > LATE_NOTE_MS ? [`It fired ${mins(late)} late (the server was down or restarting when it was due).`] : []),
    "",
    defang(w.prompt),
    "",
    "The harness started this on your schedule; it is not a message from the user, who may not be watching right now.",
  ];
  return lines.join("\n");
}

function fire(owner: string, id: string): void {
  timers.get(owner)?.delete(id);
  const w = takeWakeup(owner, id);
  if (!w) return; // 已经取消了
  console.log(`[wakeup] ${owner.slice(0, 8)}: ${w.id} fired${Date.now() - w.dueAt > LATE_NOTE_MS ? ` (${mins(Date.now() - w.dueAt)} late)` : ""}`);
  queueAutoNotice(owner, { text: wakeupText(w), kind: WAKEUP_KIND });
}

// 这个会话的定时器按账本重挂（加了、取消了、清掉了都走这里）
function arm(owner: string, overdueDelay = OVERDUE_FIRST_MS): void {
  const mine = timers.get(owner) ?? new Map<string, NodeJS.Timeout>();
  timers.set(owner, mine);
  const list = pendingWakeups(owner);
  const keep = new Set(list.map((w) => w.id));
  for (const [id, t] of mine) {
    if (keep.has(id)) continue;
    clearTimeout(t);
    mine.delete(id);
  }
  const now = Date.now();
  let overdue = 0;
  for (const w of list) {
    if (mine.has(w.id)) continue;
    const wait = w.dueAt > now ? w.dueAt - now : overdueDelay + OVERDUE_GAP_MS * overdue++;
    const t = setTimeout(() => fire(owner, w.id), wait);
    t.unref?.();
    mine.set(w.id, t);
  }
  if (!mine.size) timers.delete(owner);
}

let off: (() => void) | null = null;
/** 服务启动时挂上（index.ts）：读回盘上的，之后跟着账本的改动挂 / 撤定时器。测试按需调。 */
export function startWakeups(): () => void {
  if (off) return () => {};
  const unsubscribe = onWakeupsChanged((owner) => arm(owner, 0));
  for (const owner of wakeupOwners()) arm(owner);
  off = () => {
    unsubscribe();
    for (const mine of timers.values()) for (const t of mine.values()) clearTimeout(t);
    timers.clear();
    off = null;
  };
  return off;
}

/** 测试用：此刻挂着几个定时器。 */
export function armedWakeups(owner: string): number {
  return timers.get(owner)?.size ?? 0;
}
