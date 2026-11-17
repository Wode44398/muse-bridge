// 全局事件通道（所有会话的状态变化、侧栏结构变化）与系统通知。
import * as api from "../api.ts";
import { applySnapshot, noticeFor, type NotifyState, type StatusEvent } from "../notify-policy.ts";
import type { SessionMeta } from "./chat.svelte.ts";
import { app, flags, toast } from "./core.svelte.ts";
import { refreshProjects, refreshSessions } from "./lists.ts";
import { forceResync } from "./resync.ts";

// ── P8（K30、K35、X34）：全局事件通道 ──────────────────────────────────────────
// 一条长连接收所有会话的状态变化：侧栏的「运行中 / 等你」随之更新（不必轮询整张列表），并在人没看着时通知——
// 页面隐藏（锁屏、切走）发系统通知（apk 里走原生 showNotification，浏览器里走 Notification），页面可见但不在
// 那个会话就应用内提示。去重与基线规则在 notify-policy.ts。WebView 被冻结后这里就收不到了——那种情况由 bridge
// apk 的原生服务轮询 /api/pending 兜底。
const notifyState: NotifyState = { notified: new Set(), wasRunning: new Map() };
let globalStarted = false;

export function startGlobalEvents() {
  if (globalStarted) return;
  globalStarted = true;
  void (async () => {
    let backoff = 1000;
    for (;;) {
      const ctl = new AbortController();
      let aliveAt = Date.now();
      // 半开的死连接：服务端 10 秒一个 ping，45 秒没有任何字节就撕掉重连
      const watchdog = setInterval(() => {
        if (Date.now() - aliveAt > 45_000) ctl.abort();
      }, 10_000);
      try {
        await api.globalEvents(
          (ev) => {
            backoff = 1000;
            onGlobalEvent(ev);
          },
          ctl.signal,
          () => (aliveAt = Date.now()),
        );
      } catch (e: any) {
        if (e?.status === 404) {
          clearInterval(watchdog);
          return; // 旧后端没有全局通道：不再连（列表照旧靠刷新）
        }
      }
      clearInterval(watchdog);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  })();
}

let listRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function applyStatus(id: string, running: boolean, waiting: SessionMeta["waiting"]) {
  const row = app.sessions.find((s) => s.id === id);
  if (row) {
    row.running = running;
    row.waiting = waiting;
  } else if (running && !listRefreshTimer) {
    // 列表里还没有它（别的设备刚新建的）：合并一下再刷新整张列表
    listRefreshTimer = setTimeout(() => {
      listRefreshTimer = null;
      void refreshSessions();
    }, 1500);
  }
}

// 侧栏结构变了（任何设备上新建 / 删除会话、换快照、存为工作空间、项目增改）：合并一下再重拉。
let listChangeTimer: ReturnType<typeof setTimeout> | null = null;
let listChangeWhat = new Set<"sessions" | "projects">();
export function scheduleListRefresh(what: "sessions" | "projects" | "both") {
  if (what !== "projects") listChangeWhat.add("sessions");
  if (what !== "sessions") listChangeWhat.add("projects");
  if (listChangeTimer) return;
  listChangeTimer = setTimeout(() => {
    listChangeTimer = null;
    const w = listChangeWhat;
    listChangeWhat = new Set();
    if (w.has("projects") && app.features.projects) void refreshProjects();
    if (w.has("sessions") && app.features.sessions) void refreshSessions();
  }, 300);
}

let globalSnapshots = 0;

// ── 会话管理（lib/sessmgmt.svelte.ts）的挂钩：它登记自己的全局事件处理（queue / suggestion / session_title，返回 true =
// 已处理）与系统通知的分类开关（权限请求 / 提问 / 任务完成）。放成可登记的钩子而不是直接 import：那边要 import 这里的 app。
export const sessHooks = {
  global: [] as ((ev: any) => boolean)[],
  notifyAllowed: (_kind: "permission" | "ask" | "plan" | "done") => true,
};

function onGlobalEvent(ev: any) {
  for (const h of sessHooks.global) if (h(ev)) return;
  if (ev?.e === "snapshot") {
    const rows = (Array.isArray(ev.sessions) ? ev.sessions : []) as StatusEvent[];
    applySnapshot(notifyState, rows);
    for (const row of rows) applyStatus(row.id, row.running, row.waiting?.kind ?? null);
    // 断线重连：断开期间的 list_changed 都错过了，整张重拉一次（第一次连上时 boot 刚拉过，不重复）
    if (globalSnapshots++ > 0) scheduleListRefresh("both");
    return;
  }
  if (ev?.e === "list_changed") {
    scheduleListRefresh(ev.what === "sessions" || ev.what === "projects" ? ev.what : "both");
    return;
  }
  if (ev?.e !== "session_status") return;
  const status = ev as StatusEvent;
  applyStatus(status.id, status.running, status.waiting?.kind ?? null);
  // O7：服务端自己起的一轮（目标续跑的下一轮、重启后续跑）——本地开着这个对话却没在跑，接上直播
  // #93：人不在 dimensio 页就先记着，回到页面再接（页外不开运行流）
  const open = app.chats.find((c) => c.id === status.id);
  if (status.running && open && !open.running && !open.reconnecting) {
    if (flags.pageAway) open.suspended = true;
    else forceResync(open);
  }
  const resident = new Set(app.chats.filter((c) => c.id && c.abortCtl).map((c) => c.id as string));
  const notice = noticeFor(notifyState, status, {
    hidden: typeof document !== "undefined" && document.hidden,
    foregroundId: app.chat.id,
    residentIds: resident,
  });
  if (!notice) return;
  if (notice.toast) toast(notice.toast);
  // 会话管理：通知分类开关只管系统通知（应用内提示照旧）。有 waiting 的通知必然出自「新挂上的卡」那一支
  if (notice.system && sessHooks.notifyAllowed(status.waiting ? status.waiting.kind : "done")) systemNotify(notice.system.title, notice.system.text);
}

function notifyEnabled(): boolean {
  try {
    return localStorage.getItem("bridge-notify") !== "0";
  } catch {
    return true; // 读不到设置就照常
  }
}

// apk 壳（新版）里：发起一轮时拉起原生跟踪服务（此刻必在前台，Android 12+ 才准启前台服务）。App 退后台 / 锁屏、
// WebView 被冻结之后，由它轮询 /api/pending 发「等你处理」「跑完了」通知。旧壳没有这个方法就什么都不做。
export function startNativeWatch() {
  if (!notifyEnabled()) return;
  try {
    (window as any).AndroidStore?.startHarnessWatch?.();
  } catch { /* 旧壳 */ }
}

// 系统通知：apk 壳里走原生 showNotification；浏览器里用 Notification（已授权时）。尊重 bridge 设置页的「通知」开关。
// 原生跟踪服务在跑时交给它发（同一件事不响两次）。
function systemNotify(title: string, text: string) {
  if (!notifyEnabled()) return;
  try {
    const native = (window as any).AndroidStore;
    if (native?.isHarnessWatching?.()) return;
    if (native?.showNotification) {
      native.showNotification(title, text);
      return;
    }
  } catch { /* 落到浏览器通知 */ }
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(title, { body: text });
  } catch { /* 没有通知能力就算了 */ }
}
