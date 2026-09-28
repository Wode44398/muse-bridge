// M9（#26、K25、X32）：runLog 压实。
//
// runLog 是「另一台设备中途附着时重放给它的本轮快照」，不是逐字日志。以前每个 text_delta、每个转发的子 agent 正文
// delta 都单独存一条：长轮、大工作流很快撞上 20 万条上限，之后附着的设备只能按记录重建（在途正文丢了，#26），
// 常驻内存与每次附着穿隧道重放的量也跟着涨。现在按「重放结果等价」压实：
//   · 主 agent 的正文 / 思考 delta 只与紧挨着的上一条同类合并——中间隔了任何事件都不合（那条事件可能已经收掉了
//     当前正文条目，比如 tool_start、turn_start）；
//   · 子 agent 的正文 delta 与「这个子 agent 的上一条事件」合并（只要那条也是它的正文 delta）。别的子 agent 的事件
//     夹在中间不影响——前端按子 agent 各自累加正文；它自己的事件夹在中间就不合（它的 turn_start 会清空正文）。
// 在线 watcher 收到的仍是逐条原事件；日志里的 delta 存的是副本，合并只改副本。
// 重放等价由 run-log.test.ts 用前端真 reducer 核对（压实前后归约出的时间线逐项相同）。

export type LoggedEvent = Record<string, unknown>;

// 每份 runLog（数组身份）各一张「子 agent id → 它最后一条事件的下标」：runLog 换新数组（新一轮、收尾留尾巴）就自然作废
const lastOfSubagent = new WeakMap<LoggedEvent[], Map<string, number>>();

function indexOf(log: LoggedEvent[]): Map<string, number> {
  let m = lastOfSubagent.get(log);
  if (!m) lastOfSubagent.set(log, (m = new Map()));
  return m;
}

const SUBAGENT_EVENTS = new Set(["subagent_start", "subagent_event", "subagent_suspended", "subagent_end"]);

function isTextDelta(inner: unknown): inner is { e: "text_delta"; text?: unknown } {
  return Boolean(inner) && (inner as { e?: unknown }).e === "text_delta";
}

// 追加一条事件（能合并就合并）。返回 false = 日志已满（cap 条），这条没记进去——调用方据此标记截断。
export function appendRunLog(log: LoggedEvent[], ev: LoggedEvent, cap: number): boolean {
  const e = ev.e;
  if (e === "text_delta" || e === "thinking_delta") {
    const last = log[log.length - 1];
    if (last && last.e === e) {
      last.text = `${last.text ?? ""}${ev.text ?? ""}`;
      return true;
    }
    if (log.length >= cap) return false;
    log.push({ ...ev });
    return true;
  }
  const sub = SUBAGENT_EVENTS.has(String(e)) ? String(ev.id ?? "") : "";
  if (e === "subagent_event" && isTextDelta(ev.ev)) {
    const at = indexOf(log).get(sub);
    const prev = at === undefined ? undefined : log[at];
    if (prev && prev.e === "subagent_event" && isTextDelta(prev.ev)) {
      const inner = prev.ev as { text?: unknown };
      inner.text = `${inner.text ?? ""}${ev.ev.text ?? ""}`;
      return true;
    }
    if (log.length >= cap) return false;
    log.push({ ...ev, ev: { ...(ev.ev as object) } });
    indexOf(log).set(sub, log.length - 1);
    return true;
  }
  if (log.length >= cap) return false;
  log.push(ev);
  if (sub) indexOf(log).set(sub, log.length - 1);
  return true;
}
