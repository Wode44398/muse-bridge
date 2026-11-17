// 把时间线归约（timeline-reducer.ts）接到 Chat 的批量落地定时器、toast 与全局指示器上；事件入口 handleEvent。
import { WIDE_MQ } from "../breakpoints.ts";
import * as tl from "../timeline-reducer.ts";
import { onCollabEvent } from "../workspace-collab.svelte.ts";
import type { Item } from "../timeline-types.ts";
import type { Chat } from "./chat.svelte.ts";
import { app, flags, paneVisible, rememberSession, STREAM_FLUSH_MS, toast } from "./core.svelte.ts";
import { openDock } from "./dock.ts";

// ── 时间线归约（逻辑在 timeline-reducer.ts；这里只把 Chat 的定时器、toast、全局指示器接成 effects）──
function flushControl(chat: Chat): tl.FlushControl {
  return {
    scheduleFlush: () => {
      if (chat.flushTimer) return;
      chat.flushTimer = window.setTimeout(() => {
        chat.flushTimer = 0;
        flushStream(chat);
      }, STREAM_FLUSH_MS);
    },
    cancelFlush: () => {
      if (chat.flushTimer) {
        clearTimeout(chat.flushTimer);
        chat.flushTimer = 0;
      }
    },
  };
}

function effectsFor(chat: Chat): tl.TimelineEffects {
  return {
    ...flushControl(chat),
    foreground: chat === app.chat, // 只有前台会话允许弹面板 / 改全局指示器 / 记忆 lastSession
    visible: paneVisible(chat), // 分屏里另一格也看得见：「后台对话在等你」这类提示不用弹
    toast,
    rememberSession,
    // 分栏形态（≥700，与 App 的布局门槛同一条线）才自动展开浏览器面板；手机只亮胶囊。用户这一轮亲手关过就不再弹
    openBrowserPane: () => {
      if (flags.browserAutoMuted) return;
      if (matchMedia(WIDE_MQ).matches) openDock("browser");
    },
    setGlobal: (patch) => {
      if (app.config) app.config = { ...app.config, ...(patch as any) };
    },
    refill: (text) => {
      app.refill = text;
    },
    setBrowser: (url) => {
      // 服务端按会话各开一份浏览器（能力位 browser-session）：app.browser 只代表前台会话的那份（lib/browser-mount.svelte.ts），
      // 后台会话的浏览器动了不该点亮前台的灯。旧后端全进程一个浏览器，照旧全局记。
      if (chat !== app.chat && app.compat?.caps?.includes("browser-session")) return;
      app.browser = { url };
    },
  };
}

export const pushItem = (chat: Chat, item: Item): any => tl.pushItem(chat, item);
export const flushStream = (chat: Chat) => tl.flushStream(chat, flushControl(chat));
export const dropStream = (chat: Chat) => tl.dropStream(chat, flushControl(chat));
export const settleCursors = (chat: Chat) => tl.settleCursors(chat, flushControl(chat));

// ── 事件归约（per-chat：后台会话的事件写进它自己的时间线）────────────────────
export function handleEvent(chat: Chat, ev: any) {
  if (onCollabEvent(chat, ev)) return; // 工作区协同的事件（workspace / terminal）不进时间线
  tl.reduceTimeline(chat, ev, effectsFor(chat));
}
