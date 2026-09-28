import assert from "node:assert/strict";
import test from "node:test";
import {
  discardStreamTurn,
  resetStreamTurn,
  startStreamTurn,
  type StreamTurnState,
} from "../web/src/lib/stream-turn.ts";

test("same-index retry replaces partial output without touching prior timeline items", () => {
  const state: StreamTurnState<string> = {
    timeline: ["user", "tool", "partial thinking", "partial text"],
    streamTurnIndex: 4,
    turnStartTimelineLength: 2,
  };

  assert.deepEqual(startStreamTurn(state, 4), {
    replayed: true,
    dropped: ["partial thinking", "partial text"],
  });
  assert.deepEqual(state.timeline, ["user", "tool"]);

  state.timeline.push("replayed text");
  assert.deepEqual(discardStreamTurn(state, 4), { discarded: true, dropped: ["replayed text"] });
  assert.deepEqual(state.timeline, ["user", "tool"]);
});

test("discard ignores a stale turn and reset protects completed history", () => {
  const state: StreamTurnState<string> = {
    timeline: ["old answer"],
    streamTurnIndex: null,
    turnStartTimelineLength: 1,
  };

  assert.deepEqual(startStreamTurn(state, 5), { replayed: false, dropped: [] });
  state.timeline.push("new provisional answer");
  assert.deepEqual(discardStreamTurn(state, 4), { discarded: false, dropped: [] });
  assert.deepEqual(state.timeline, ["old answer", "new provisional answer"]);

  resetStreamTurn(state);
  assert.deepEqual(discardStreamTurn(state, 5), { discarded: false, dropped: [] });
  assert.deepEqual(state.timeline, ["old answer", "new provisional answer"]);
});
