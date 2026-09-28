// #93：嵌在 bridge 里时，离开 dimensio 页就收掉各会话的运行流、回到页面再接上。
//
// 局域网 http 直连时浏览器对同一主机最多开 6 条连接。dimensio 的运行流挂在模块级的会话上、页面卸载也不收：离开页面后
// 还占着全局事件流 + 最多 3 条运行流，再去 Claude 页看一轮就满了，之后的请求（会话列表、新的附着）一直排队。
// 哪些该收、哪些该接放在这里（纯函数，好在 Node 里测）；真正的收线 / 对账在 state.svelte.ts。
export interface StreamHolder {
  id: string | null;
  running: boolean;
  reconnecting: boolean;
  abortCtl: unknown;
  // 离开页面时被收掉了运行流（或离开期间服务端起了一轮）——回到页面要接上
  suspended: boolean;
}

// 离开页面时要收的：手里有连接的，和正在断线重连的（重连循环还会再开连接）。还没拿到会话 id 的新会话第一轮留着：
// 收了就对不上账、接不回来（回执很快就到，之后照常）。
export function toSuspend<T extends StreamHolder>(chats: readonly T[]): T[] {
  return chats.filter((c) => c.id !== null && (c.abortCtl != null || c.reconnecting));
}

// 回到页面时要接的：离开时收掉的；还有离开期间服务端起了一轮（目标续跑、重启后续跑、别的设备发起）、本地却没在跑的。
export function toResume<T extends StreamHolder>(chats: readonly T[], runningIds: ReadonlySet<string>): T[] {
  return chats.filter(
    (c) => c.id !== null && (c.suspended || (runningIds.has(c.id) && !c.running && c.abortCtl == null && !c.reconnecting)),
  );
}
