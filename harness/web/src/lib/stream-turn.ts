// Pure timeline bookkeeping shared by the live reducer. Keeping this free of
// Svelte/browser globals lets the replacement semantics run in Node tests.
export interface StreamTurnState<Item = unknown> {
  timeline: Item[];
  streamTurnIndex: number | null;
  turnStartTimelineLength: number;
}

// Returns the items that were dropped, so the caller can release anything that
// pointed at them (the tool/ask id → item maps). Without that, every retry and
// every verification-gate retraction left dangling entries whose items are no
// longer on the timeline: a late tool_end then mutated an orphan (invisible
// update) and the maps grew for the life of the chat.
//
// U2（#46）：插话不属于这一轮的模型输出——被门禁撤回 / 上游重放的只是模型那一段。插话气泡挪到剪切点之后
// 留着（并算作这一轮之前的内容，之后再剪也不动它），不然用户看着自己的话凭空消失，自然反应是再发一遍，
// 模型就收到两条同样的指令。
function trimCurrentTurn<Item>(state: StreamTurnState<Item>): Item[] {
  const cut = state.timeline.splice(Math.min(state.turnStartTimelineLength, state.timeline.length));
  const kept = cut.filter(isSteerItem);
  if (kept.length) {
    state.timeline.push(...kept);
    state.turnStartTimelineLength = state.timeline.length;
  }
  return kept.length ? cut.filter((it) => !isSteerItem(it)) : cut;
}

const isSteerItem = (it: unknown): boolean => (it as { kind?: unknown; steer?: unknown } | null)?.kind === "user" &&
  (it as { steer?: unknown }).steer === true;

// U2（#46）：插话气泡对号入座——按 id（本机乐观上屏的气泡与回来的 steer_queued 是同一个 id）。旧服务端不带
// id 时退回按文本，但只在这一轮里找（到这一轮自己的用户消息为止）：以前扫整条时间线，历史里说过一次「继续」，
// 别的设备这一轮再说「继续」就被吞掉了。返回下标，没有 = -1。
export function findSteerItem<Item>(timeline: Item[], ev: { id?: unknown; text?: unknown }): number {
  const id = typeof ev.id === "string" && ev.id ? ev.id : null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const it = timeline[i] as { kind?: unknown; steer?: unknown; steerId?: unknown; text?: unknown } | null;
    if (it?.kind !== "user") continue;
    if (it.steer !== true) {
      if (!id) return -1;
      continue;
    }
    if (id ? it.steerId === id : it.text === ev.text) return i;
  }
  return -1;
}

// Returns true for a replay of the same provider turn. A retry must replace
// any partial text it streamed before the upstream connection failed.
export function startStreamTurn<Item>(
  state: StreamTurnState<Item>,
  index: number,
): { replayed: boolean; dropped: Item[] } {
  if (state.streamTurnIndex === index) {
    return { replayed: true, dropped: trimCurrentTurn(state) };
  }
  state.streamTurnIndex = index;
  state.turnStartTimelineLength = state.timeline.length;
  return { replayed: false, dropped: [] };
}

// Verification gates retract only the no-tool turn that just tried to finish.
// Ignore stale/out-of-order discard events rather than deleting a newer turn.
export function discardStreamTurn<Item>(
  state: StreamTurnState<Item>,
  index: number,
): { discarded: boolean; dropped: Item[] } {
  if (state.streamTurnIndex !== index) return { discarded: false, dropped: [] };
  return { discarded: true, dropped: trimCurrentTurn(state) };
}

export function resetStreamTurn(state: StreamTurnState): void {
  state.streamTurnIndex = null;
  state.turnStartTimelineLength = state.timeline.length;
}
