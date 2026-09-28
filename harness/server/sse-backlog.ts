// M9（N34）：慢 watcher 有界。SSE 写不过去时 Node 把数据无限期攒在进程内存里——一台半开连接的手机能让一整轮的输出
// （含每个工具结果）常驻，直到连接超时。直播积压超过上限就断开这台设备：客户端照常走断线对账、重新附着，拿到的是
// 压实过的重放（run-log.ts），不丢东西。
//
// 附着时的重放是同步一次写进去的（大轮可能几 MB），不算积压：arm() 在重放写完之后调，之后的积压才开始算；基线取
// arm 那一刻的缓冲量（重放先进先出排空，超出基线 + 上限的部分就是直播攒下的）。不这样做，一附着就被自己断开、
// 客户端重连再断，死循环。

export const LIVE_BACKLOG_LIMIT = 8 << 20;

export interface BacklogGuard {
  arm(): void;
  over(): boolean;
}

export function backlogGuard(res: { readonly writableLength: number }, limit = LIVE_BACKLOG_LIMIT): BacklogGuard {
  let base = 0;
  let armed = false;
  return {
    arm() {
      base = res.writableLength;
      armed = true;
    },
    over() {
      return armed && res.writableLength > base + limit;
    },
  };
}
