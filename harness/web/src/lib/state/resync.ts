// 直播镜像的附着、断线对账循环、离开页面时收线与回来接上、挂后台自愈、冷启动续播。
import * as api from "../api.ts";
import { t } from "../i18n.ts";
import { toResume, toSuspend } from "../page-streams.ts";
import type { Chat } from "./chat.svelte.ts";
import { app, flags, LAST_SESSION_KEY, MAX_PARALLEL, rememberSession, RESYNC_TIMEOUT_MS } from "./core.svelte.ts";
import { handleEvent } from "./effects.ts";
import { scheduleListRefresh } from "./global-events.ts";
import { foreground, loadChat, syncConfigTo } from "./pool.ts";
import { applyRecord } from "./record.ts";
import { finishRun, killLive } from "./run.ts";

let lastProbeAt = 0; // 空闲态对账节流（前台）
let lastWakeListAt = Date.now(); // 回前台重拉侧栏的节流（boot 刚拉过）

// 截断重放的补救：以服务端已落盘的记录重建时间线基线，不动直播连接（liveGen
// 不变、abortCtl 不换），随后到达的事件继续往这条基线上追加。
// M1（#26）：整份重建之后，把服务端此刻挂着的问答 / 权限 / 计划卡补回来（它们不在记录里，只在
// runLog 里——而走到整份重建这一步，恰恰就是 runLog 用不上了）。问答卡从记录重建时已经在（id 就是
// tool_call id），不重复加。
function restorePending(chat: Chat, pending: unknown) {
  if (!Array.isArray(pending)) return;
  for (const ev of pending) {
    if (!ev || typeof ev !== "object") continue;
    const id = (ev as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const kind = (ev as { e?: unknown }).e;
    if (kind === "ask" && chat.askRefs.has(id)) continue;
    if (kind === "permission_ask" && chat.permRefs.has(id)) continue;
    if (kind === "plan_ask" && chat.planRefs.has(id)) continue;
    if (kind === "ask" || kind === "permission_ask" || kind === "plan_ask") handleEvent(chat, ev);
  }
}

async function rebuildMirrorBase(chat: Chat, gen: number) {
  if (!chat.id || gen !== chat.liveGen) return;
  const id = chat.id;
  try {
    const rec = await api.getSession(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen || chat.id !== id) return;
    applyRecord(chat, rec);
    chat.running = true; // applyRecord 只重建视图，本轮仍在跑
    if (!chat.activity) chat.activity = t("思考中");
    restorePending(chat, rec.pending);
  } catch { /* 拉不到就维持现状，直播事件照常追加 */ }
}

// 附着直播镜像（发起端断线重连与围观端共用）：服务端在附着瞬间同步重放本轮
// 全部事件再续直播，与 base 重建拼成完整一致的时间线。断流走 scheduleResync
// 自动恢复；只有 mirror_end（本轮真结束）才收尾。
export async function attachStream(chat: Chat, gen: number) {
  if (gen !== chat.liveGen || !chat.id) return;
  chat.curText = null;
  chat.curThinking = null;
  chat.running = true;
  if (!chat.activity) chat.activity = t("思考中");
  chat.abortCtl = new AbortController();
  let sawEnd = false;
  try {
    chat.lastByteAt = Date.now();
    await api.sessionStream(
      chat.id,
      (ev) => {
        if (gen !== chat.liveGen) return;
        if (ev.e === "mirror_end") {
          sawEnd = true;
          return;
        }
        // 服务端明说这一轮的重放日志被截断了（超长轮撞上 runLog 上限）：拼上去
        // 只会得到一条永久错位的时间线。改成用服务端已持久化的记录重建一次基线，
        // 然后【继续吃这条连接的直播事件】——细节有损，但不会错位。
        // 注意不能走 forceResync/reconcileIdle：前者会 ++liveGen 掐掉本连接并重新
        // 附着，而重新附着又会撞上同一条截断日志再报 desync（死循环）；后者在
        // running 时直接 return，什么也不做。
        if (ev.e === "mirror_desync") {
          void rebuildMirrorBase(chat, gen);
          return;
        }
        handleEvent(chat, ev);
      },
      chat.abortCtl.signal,
      () => {
        if (gen === chat.liveGen) chat.lastByteAt = Date.now();
      },
      chat.runId, // 底座是按这一轮切的（applyRecord 刚记下）：服务端此刻在跑的若已是下一轮，409 回来重新对账
    );
  } catch (e: any) {
    // 同 send：主动收线已被世代挡掉；意外死亡（409 = 附着瞬间本轮刚好结束，或已换成下一轮，
    // 对账自然拉到终态 / 新一轮的底座）一律走恢复。
    if (gen !== chat.liveGen) return;
    scheduleResync(chat, gen, 0);
    return;
  }
  if (gen !== chat.liveGen) return;
  if (sawEnd) finishRun(chat, gen);
  else scheduleResync(chat, gen, 0);
}

// ── 断线恢复：对账循环（per-chat，后台会话独立自愈）────────────────────────
export function scheduleResync(chat: Chat, gen: number, delay: number) {
  if (gen !== chat.liveGen) return;
  chat.reconnecting = true;
  // 连试几次都没成 → 说人话，别让用户对着一个永远的「重连中」猜是不是死了。
  // 任务在服务端照跑，网络一通就自动补回来。
  if (chat.running) chat.activity = chat.resyncAttempt >= 3 ? t("重连中（网络不畅）") : t("重连中");
  clearTimeout(chat.resyncTimer);
  chat.resyncTimer = window.setTimeout(() => {
    chat.resyncTimer = 0; // 归零，否则「有没有排着下一次」永远读成有（排障时会被骗）
    void resyncLive(chat, gen);
  }, delay);
}

// 以服务端为真相对账一次：还在跑 → 重建 base + 重新附着；已结束 → 拉终态
// 完整重建（后台期间跑完的答案一分不少）；网络不通 → 退避重试，回前台 /
// 网络恢复事件会立刻再触发。
async function resyncLive(chat: Chat, gen: number) {
  if (gen !== chat.liveGen || !chat.id) return;
  // 前一次对账还在途：【让路重排】，不能直接 return —— forceResync 在对账在途时
  // ++gen，新的一轮在这里被 resyncing 挡掉、旧的一轮回来时被 gen 挡掉，两边都
  // 走人，没人再排定时器 → 永久卡在「重连中」（onWake 才救得回来）。
  if (chat.resyncing) {
    scheduleResync(chat, gen, 300);
    return;
  }
  chat.resyncing = true;
  const id = chat.id;
  try {
    const st = await api.sessionStatus(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen) return;
    if (!st.exists) {
      // 会话已被删除：没有可恢复的东西
      try {
        if (localStorage.getItem(LAST_SESSION_KEY) === id) rememberSession(null);
      } catch { /* ignore */ }
      finishRun(chat, gen);
      return;
    }
    if (st.running) {
      const rec = await api.getSession(id, RESYNC_TIMEOUT_MS);
      if (gen !== chat.liveGen) return;
      if (rec.running && Number.isInteger(rec.runStartMsgCount)) {
        applyRecord(chat, rec, rec.runStartMsgCount);
        chat.resyncAttempt = 0;
        chat.reconnecting = false;
        void attachStream(chat, gen);
        return;
      }
      // 两次请求的窗口里刚好收尾了 → 落到终态分支
      applyRecord(chat, rec);
      finishRun(chat, gen);
      return;
    }
    // 服务端说这个会话没在跑。手里那份还是最新的（指纹一致）→ 直接收尾，
    // 别为了确认「没变」再拉一遍整份转录。recFp 只有完整重建才置位，所以
    // 刚直播过一轮的会话必定不匹配，照常拉。
    if (st.fp && st.fp === chat.recFp) {
      finishRun(chat, gen);
      return;
    }
    const rec = await api.getSession(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen) return;
    applyRecord(chat, rec);
    finishRun(chat, gen);
  } catch {
    if (gen !== chat.liveGen) return;
    chat.resyncAttempt++;
    scheduleResync(chat, gen, Math.min(8_000, 1_000 * 2 ** Math.min(chat.resyncAttempt, 3)));
  } finally {
    chat.resyncing = false;
  }
}

// 撕掉 chat 的当前连接（半开死连接 read() 永远不返回，只能靠世代失效 + abort
// 兜底），立刻走一次对账。
export function forceResync(chat: Chat) {
  if (!chat.id) return;
  const gen = ++chat.liveGen;
  chat.abortCtl?.abort();
  chat.abortCtl = null;
  chat.resyncAttempt = 0;
  scheduleResync(chat, gen, 0);
}

// ── #93：嵌在 bridge 里时，离开 dimensio 页就收掉运行流 ──────────────────────────────────────
// 局域网 http 直连时浏览器每主机只开 6 条连接；运行流挂在模块级的会话上、页面卸载也不收，离开页面后 dimensio 还占着
// 全局事件流 + 最多 3 条运行流，再去 Claude 页看一轮就满了。离开时把运行流收掉（服务端照跑，不停），只留全局事件流
// （侧栏状态与通知靠它）；回到页面（App 重挂 → boot）时按服务端现状接回：还在跑的重放续播，跑完了的拉终态。

// App 卸载时调（只在嵌入态：独立页面不会卸载）
export function suspendLiveStreams() {
  flags.pageAway = true;
  for (const chat of toSuspend(app.chats)) {
    killLive(chat);
    chat.suspended = true;
  }
}

export function resumeLiveStreams() {
  if (flags.pageAway) return; // boot 还没走完人又离开了
  const runningIds = new Set(app.sessions.filter((s) => s.running).map((s) => s.id));
  for (const chat of toResume(app.chats, runningIds)) {
    chat.suspended = false;
    forceResync(chat);
  }
}

// ── 挂后台自愈：watchdog + 回前台/网络恢复对账（遍历活跃池）────────────────
const STALL_HARD_MS = 40_000; // 服务端 10s 一发 ping（2026-10-21 前是 15s）：连丢三个多判死
// 回前台时更急：超过就直接撕掉重连。必须大于一个心跳间隔再加余量（harness 服务端 10s 一发 ping，以前 15s）——以前是 12s，
// 15s 心跳下最近一次 ping 之后 12–15s 内回前台，健康的流也会被判半开撕掉重连（同 bridge 的 web/src/lib/sse.js FR4）
const STALL_WAKE_MS = 22_000;

setInterval(() => {
  if (document.hidden) return; // 后台定时器本就不可靠；回前台由 onWake 兜
  for (const chat of app.chats) {
    if (!chat.running || chat.reconnecting || !chat.abortCtl) continue;
    if (Date.now() - chat.lastByteAt > STALL_HARD_MS) forceResync(chat);
  }
}, 5_000);

let wakeDebounce = 0;
export function onWake() {
  clearTimeout(wakeDebounce);
  wakeDebounce = window.setTimeout(() => {
    if (document.hidden || !app.booted || flags.pageAway) return; // #93：人在 bridge 别的页上，不替页外的会话开连接
    for (const chat of app.chats) {
      if (chat.reconnecting) {
        // 正在退避等待 → 跳过剩余等待立刻重试
        forceResync(chat);
        continue;
      }
      if (chat.running) {
        // 连接名义上还挂着：字节静默超阈值就当半开死连接处理
        if (chat.abortCtl && Date.now() - chat.lastByteAt > STALL_WAKE_MS) forceResync(chat);
      }
    }
    // 回到前台：后台冻结期间（手机锁屏、WebView 挂起）全局事件可能整段错过、连接却没断，侧栏重拉一次（15 秒节流）
    if (Date.now() - lastWakeListAt > 15_000) {
      lastWakeListAt = Date.now();
      scheduleListRefresh("both");
    }
    // 空闲态对账（前台）：上次可能异常收尾（network error / 假完成），服务端也许还在跑
    const chat = app.chat;
    if (chat.id && !chat.running && !chat.reconnecting && Date.now() - lastProbeAt > 5_000) {
      lastProbeAt = Date.now();
      void probeIdle();
    }
  }, 250);
}

async function probeIdle() {
  const chat = app.chat;
  const id = chat.id;
  if (!id) return;
  try {
    const st = await api.sessionStatus(id, RESYNC_TIMEOUT_MS);
    if (id !== chat.id || chat.running || chat.reconnecting) return;
    if (st.running) forceResync(chat); // 服务端还在跑而我们不在场 → 续上直播
  } catch { /* 连不上就下次再说 */ }
}

// 不挂 window focus：桌面瘦客户端里点一下窗口就会触发，误把健康的流当半开（FR4）；回前台由 visibilitychange / pageshow 兜
window.addEventListener("online", onWake);
window.addEventListener("pageshow", onWake);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) onWake();
});

// 冷启动续播：服务端还在跑的会话（进程被杀 / 手机重启 / 别的设备发起）全部
// 接上直播 —— 上次看的那个放前台，其余在后台自转（完成时 toast 提醒）。
// 只在有 running 会话时劫持首页；跑完了的历史会话不打扰，保持 Hero。
export async function resumeRunningSessions() {
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_SESSION_KEY);
  } catch { /* ignore */ }
  const running = app.sessions.filter((s) => s.running).slice(0, MAX_PARALLEL);
  for (const s of running) {
    try {
      await loadChat(s.id);
    } catch { /* 单个失败不影响其余 */ }
  }
  // 上次看的会话在跑 → 抬到前台（前台还是空白 Hero 时才劫持）
  if (last) {
    const c = app.chats.find((x) => x.id === last);
    const fg = app.chat;
    if (c && c !== fg && (c.running || c.reconnecting) && !fg.id && !fg.running && !fg.timeline.length) {
      foreground(c);
      void syncConfigTo(c);
    }
  }
}
