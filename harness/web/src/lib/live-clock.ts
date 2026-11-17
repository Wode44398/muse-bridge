// 直播时本机看到的时刻：工具开跑的时刻、思考块开始的时刻与想了多久。
// 只给界面用（工具组 / 工具行行尾走秒、思考行分档与「已思考 N 秒」），刻意不放进时间线条目本身：
// 条目是「事件归约出来的数据」，同一串事件什么时候重放都要归约出逐项相同的时间线（压实日志、对账合并都靠这一点）；
// 墙钟时刻放进去，重放一次就全不相等了。历史重建、对账换进来的条目这里查不到 = 不显示计时。
// 纯 TS、不碰 DOM：归约器在 Node 测试里也会写它。
export interface LiveClock {
  t0: number;
  ms?: number;
}

const clocks = new WeakMap<object, LiveClock>();

export function markStart(item: object, now = Date.now()): void {
  clocks.set(item, { t0: now });
}

// 思考块结束：记下想了多久（只记一次）
export function markEnd(item: object, now = Date.now()): void {
  const c = clocks.get(item);
  if (c && c.ms === undefined) c.ms = Math.max(0, now - c.t0);
}

export function liveClock(item: object): LiveClock | undefined {
  return clocks.get(item);
}
