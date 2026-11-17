// 控制台调试钩子 window.__hx。
import { app, flags, toast } from "./core.svelte.ts";
import { switchVendor } from "./config.ts";
import { handleEvent } from "./effects.ts";
import { refreshProjects, refreshSessions } from "./lists.ts";
import { newChat, openSession } from "./pool.ts";
import { forceResync, onWake, resumeLiveStreams, suspendLiveStreams } from "./resync.ts";
import { send, stop } from "./run.ts";

// 调试钩子：控制台可直接驱动状态（本地工具，顺手留着排障用）。
// live 组：排障断线自愈用 —— dropConn() 模拟网络层断流（abort 当前连接、
// 世代不动，走自动恢复）；stall() 把 lastByteAt 拨旧模拟半开死连接。
// 多会话版：chats() 一览活跃池，live 组默认操作前台，可传 idx 指定。
(window as any).__hx = {
  app, newChat, toast, openSession, refreshSessions, refreshProjects, switchVendor,
  send, stop,
  handleEvent: (ev: any) => handleEvent(app.chat, ev),
  chats: () =>
    app.chats.map((c, i) => ({
      i,
      id: c.id,
      title: c.title,
      fg: c === app.chat,
      running: c.running,
      reconnecting: c.reconnecting,
      items: c.timeline.length,
      gen: c.liveGen,
      conn: c.abortCtl !== null,
      suspended: c.suspended,
      idleMs: Date.now() - c.lastByteAt,
    })),
  live: {
    state: (i?: number) => {
      const c = i === undefined ? app.chat : app.chats[i];
      return c && {
        gen: c.liveGen,
        conn: c.abortCtl !== null,
        lastByteAt: c.lastByteAt,
        idleMs: Date.now() - c.lastByteAt,
        reconnecting: c.reconnecting,
        running: c.running,
        resyncAttempt: c.resyncAttempt,
        resyncing: c.resyncing,
        timerSet: c.resyncTimer !== 0,
        buffered: c.pendingText.length + c.pendingThinking.length,
      };
    },
    dropConn: (i?: number) => (i === undefined ? app.chat : app.chats[i])?.abortCtl?.abort(),
    stall: (ms = 60_000, i?: number) => {
      const c = i === undefined ? app.chat : app.chats[i];
      if (c) c.lastByteAt = Date.now() - ms;
    },
    forceResync: (i?: number) => {
      const c = i === undefined ? app.chat : app.chats[i];
      if (c) forceResync(c);
    },
    onWake,
    // #93：模拟离开 / 回到 dimensio 页（嵌入态由 App 卸载与 boot 触发）
    suspend: suspendLiveStreams,
    resume: () => {
      flags.pageAway = false;
      resumeLiveStreams();
    },
  },
};
