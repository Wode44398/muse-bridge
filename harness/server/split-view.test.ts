// 分屏（09-26：在宽屏下，会话也可以拖动进行分屏，即多会话）。
//
// 修前：正文区只放得下一个会话，想同时盯两个对话只能来回切。
// 修后：把侧栏的会话块拖进正文区的左 / 右半边 = 两格并排（每一格有自己的顶栏、对话流、输入框；点哪一格、焦点落进哪一格，
// 发送、档位、工作区就跟着哪一格走）。在侧栏点开别的会话换的是有焦点的那一格；拖的是另一格的会话 = 两格对调；
// 当前是空白新对话 = 直接打开、不分屏；拖的就是当前对话 / 已经在这一格 = 不接。
// 分屏里另一格也看得见：它的卡片停下来等人时不再弹「后台对话在等你」。
import assert from "node:assert/strict";
import test from "node:test";
import { paneLeft, placeInSplit, splitDropLabel, splitDropPlan, withFocusedReplaced } from "../web/src/lib/split.ts";
import { reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";

test("分屏 放格：没分屏时与当前对话左右并排；已分屏换掉那一格；已经在格里、就是当前这个 = 不动", () => {
  assert.deepEqual(placeInSplit([], "A", "B", 1), ["A", "B"]);
  assert.deepEqual(placeInSplit([], "A", "B", 0), ["B", "A"]);
  assert.equal(placeInSplit([], "A", "A", 1), null, "自己不跟自己分屏");
  assert.deepEqual(placeInSplit(["A", "B"], "B", "C", 0), ["C", "B"]);
  assert.deepEqual(placeInSplit(["A", "B"], "B", "C", 1), ["A", "C"]);
  assert.equal(placeInSplit(["A", "B"], "B", "A", 1), null, "已经在左格：只挪焦点，同一个会话不占两格");
});

test("分屏 侧栏点开别的会话换的是有焦点的那一格；点开的就在另一格 = 格子不动；关掉一格留下另一格", () => {
  assert.deepEqual(withFocusedReplaced(["A", "B"], "A", "C"), ["C", "B"]);
  assert.deepEqual(withFocusedReplaced(["A", "B"], "B", "C"), ["A", "C"]);
  assert.deepEqual(withFocusedReplaced(["A", "B"], "A", "B"), ["A", "B"], "点开的是另一格：只挪焦点");
  assert.deepEqual(withFocusedReplaced([], "A", "C"), [], "没分屏：格子这回事不存在");
  assert.equal(paneLeft(["A", "B"], "A"), "B");
  assert.equal(paneLeft(["A", "B"], "B"), "A");
  assert.equal(paneLeft(["A", "B"], "C"), null);
  assert.equal(paneLeft([], "A"), null);
});

test("分屏 会话块拖进正文区：空白新对话直接打开；并排放左 / 右；分屏中换格、对调；当前这个 / 已在这一格不接；提示对得上", () => {
  const base = { split: false, blank: false, currentId: "A", paneIds: [] as string[], draggedId: "B" };
  assert.deepEqual(splitDropPlan({ ...base, blank: true, currentId: null, side: 1 }), { kind: "open" });
  assert.deepEqual(splitDropPlan({ ...base, side: 1 }), { kind: "split", side: 1 });
  assert.deepEqual(splitDropPlan({ ...base, side: 0 }), { kind: "split", side: 0 });
  assert.deepEqual(splitDropPlan({ ...base, draggedId: "A", side: 1 }), { kind: "none" }, "拖的就是当前对话");
  const split = { split: true, blank: false, currentId: "B", paneIds: ["A", "B"] };
  assert.deepEqual(splitDropPlan({ ...split, draggedId: "C", side: 0 }), { kind: "replace", side: 0 });
  assert.deepEqual(splitDropPlan({ ...split, draggedId: "B", side: 0 }), { kind: "swap", side: 0 }, "右格的拖到左边 = 对调");
  assert.deepEqual(splitDropPlan({ ...split, draggedId: "B", side: 1 }), { kind: "none" }, "已经在这一格");
  assert.deepEqual(splitDropPlan({ ...split, blank: true, draggedId: "C", side: 1 }), { kind: "replace", side: 1 }, "分屏中有焦点的一格是空白也照常换格");
  assert.deepEqual(
    [
      { kind: "open" },
      { kind: "split", side: 0 },
      { kind: "split", side: 1 },
      { kind: "replace", side: 0 },
      { kind: "replace", side: 1 },
      { kind: "swap", side: 0 },
      { kind: "swap", side: 1 },
      { kind: "none" },
    ].map((p) => splitDropLabel(p as Parameters<typeof splitDropLabel>[0])),
    ["打开这个对话", "在左边分屏打开", "在右边分屏打开", "在左格打开", "在右格打开", "换到左格", "换到右格", ""],
  );
});

function newModel(): TimelineModel {
  return {
    id: "s1", runId: null, title: "另一格", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0,
  };
}
function effects(visible: boolean | undefined, toasts: string[]): TimelineEffects {
  return {
    foreground: false,
    ...(visible === undefined ? {} : { visible }),
    scheduleFlush: () => {},
    cancelFlush: () => {},
    toast: (t: string) => void toasts.push(t),
    rememberSession: () => {},
    openBrowserPane: () => {},
    setGlobal: () => {},
    refill: () => {},
    setBrowser: () => {},
  };
}

test("分屏 另一格停下来等人（提问 / 权限 / 计划）：看得见就不弹「后台对话在等你」；真在后台照弹；老调用方不传 visible 按前台判", () => {
  const events = [
    { e: "ask", id: "q1", questions: [{ id: "q1:0", header: "h", question: "?", multiSelect: false, options: [{ label: "a" }] }] },
    { e: "permission_ask", id: "p1", tool: "Bash", subject: "ls" },
    { e: "plan_ask", id: "pl1", plan: "做这些" },
  ];
  for (const [visible, want] of [[true, 0], [false, 3], [undefined, 3]] as const) {
    const toasts: string[] = [];
    const m = newModel();
    for (const ev of events) reduceTimeline(m, ev, effects(visible, toasts));
    assert.equal(toasts.length, want, `visible=${visible}：${toasts.join(" / ")}`);
    assert.equal(m.timeline.length, 3, "卡片照常进时间线");
  }
});
