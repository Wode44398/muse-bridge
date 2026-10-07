// 瘦身 P0-2：待办提醒只挂在下一次请求的末尾、不进转录。以前每 5 轮持久写进一份、从不回收——09-16 的日历会话里攒了约 100 份
// 几乎一样的旧清单，全留在上下文里。这里钉住：提醒照常按节奏出现在请求里；只出现那一次；转录里一份都没有；下一次请求在它的
// 位置断开时向前缀判定器报备了原因（ephemeral-tail，不是 unexplained）。
import assert from "node:assert/strict";
import test from "node:test";
import type { RewriteKind } from "./agent/prefix-audit.ts";
import type { Turn } from "./agent/turn.ts";
import { messageKind } from "./agent/injections.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { ok, type Tool } from "./tools/types.ts";

const look: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Look", description: "fake read", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("looked", "nothing new");
  },
};

const REMINDER = "[Reminder — your current todo list]";
const lastText = (turn: Turn): string => {
  const m = turn.messages.at(-1)!;
  const b = m.content.find((x) => x.t === "text");
  return m.role === "user" && b && b.t === "text" ? b.text : "";
};

test("P0-2 待办提醒：按节奏挂在请求末尾一次，不进转录，断点报备为 ephemeral-tail", async (t) => {
  const steps = Array.from({ length: 7 }, (_, i) => useTool(`l${i}`, "Look"));
  const adapter = scripted(t).next(...steps, say("做完了"));
  const { state } = loopState(t, adapter, { tools: [look], user: "分几步看一遍" });
  state.todos = [
    { content: "第一步", status: "completed" },
    { content: "第二步", status: "in_progress" },
  ];
  const declared: RewriteKind[] = [];
  const noteRewrite = state.prefix.noteRewrite.bind(state.prefix);
  state.prefix.noteRewrite = (kind) => {
    declared.push(kind);
    noteRewrite(kind);
  };

  await drive(state, adapter);

  const withReminder = adapter.inputs.map((turn, i) => (lastText(turn).startsWith(REMINDER) ? i : -1)).filter((i) => i >= 0);
  // 5 轮没看到清单才提醒：第 6 次请求（下标 5）带着它；之后只差两轮，不会再来一次
  assert.deepEqual(withReminder, [5], "提醒只挂在第 6 次请求末尾");
  assert.match(lastText(adapter.inputs[5]), /\[~\] 第二步/);
  assert.ok(!lastText(adapter.inputs[6]).startsWith(REMINDER), "下一次请求不再带它");
  assert.equal(
    state.messages.filter((m) => messageKind(m) === "todo").length,
    0,
    "转录里一份待办提醒都没有",
  );
  assert.equal(state.ephemeralTail, null);
  assert.ok(declared.includes("ephemeral-tail"), "下一次请求在提醒的位置断开——要报备原因");
});

test("P0-2 待办提醒：新的一条用户消息进来时，上一轮没送出的提醒作废", (t) => {
  const { state } = loopState(t, scripted(t), {});
  state.ephemeralTail = `${REMINDER}\n[ ] 旧的`;
  state.addUserMessage("换个话题");
  assert.equal(state.ephemeralTail, null);
  const turn = state.toTurn();
  assert.equal(lastText(turn), "换个话题");
});
