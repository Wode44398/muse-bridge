// #93：局域网 http 直连时浏览器每主机只开 6 条连接，dimensio 离开页面后还占着「全局事件流 + 最多 3 条运行流」。
//
// 修前：运行流挂在模块级的会话上、页面卸载也不收——离开 dimensio 页再去 Claude 页看一轮就凑满 6 条，之后会话列表、
// 新的附着一直排队（09-25 只读普查：两个仓全是 fetch 读 SSE，每条都占连接池）。
// 修后：嵌在 bridge 里时 App 卸载就收掉运行流（服务端照跑），只留全局事件流；回到页面 boot 时按服务端现状接回。
// 这里测「收哪些、接哪些」（web/src/lib/page-streams.ts）；真正的收线 / 对账走 state.svelte.ts 的 killLive / forceResync。
import assert from "node:assert/strict";
import test from "node:test";
import { toResume, toSuspend, type StreamHolder } from "../web/src/lib/page-streams.ts";

const chat = (id: string | null, over: Partial<StreamHolder> = {}): StreamHolder => ({
  id,
  running: false,
  reconnecting: false,
  abortCtl: null,
  suspended: false,
  ...over,
});

test("#93 离开页面时收：手里有连接的、正在断线重连的；还没拿到会话 id 的新会话第一轮留着；空闲的不动", () => {
  const live = chat("a", { running: true, abortCtl: new AbortController() });
  const reconnecting = chat("b", { running: true, reconnecting: true });
  const firstRun = chat(null, { running: true, abortCtl: new AbortController() });
  const idle = chat("d");
  assert.deepEqual(toSuspend([live, reconnecting, firstRun, idle]), [live, reconnecting]);
  assert.deepEqual(toSuspend([]), []);
});

test("#93 回到页面时接：离开时收掉的；离开期间服务端起了一轮、本地没在跑的；已经接着的、空闲的不动", () => {
  const suspended = chat("a", { running: true, suspended: true });
  const startedWhileAway = chat("b");
  const idle = chat("c");
  const attached = chat("d", { running: true, abortCtl: new AbortController() });
  const reconnecting = chat("e", { running: true, reconnecting: true });
  const noId = chat(null, { suspended: true });
  assert.deepEqual(
    toResume([suspended, startedWhileAway, idle, attached, reconnecting, noId], new Set(["b", "d", "e"])),
    [suspended, startedWhileAway],
  );
});
