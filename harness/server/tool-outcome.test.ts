// U8a（kimi K36、Codex X43、ZCode E4）：工具行第二行只说结果 + 工具组只折叠只读探索 + 展开的工具行摆执行事实。
//
// 修前：工具行的结果挤在第一行最右边、而且是英文还把主体重复一遍（「bash: npm test (exit 0)」），手机上被参数挤没；翻历史时
// 那一栏换成了输出的第一行；工具组把连续的一切工具都收进「执行了 N 步」，改了哪些文件、跑了什么命令得点开才知道；展开一个
// Edit 看到的是一坨参数 JSON。
// 修后：工具给出中文结果行 outcome（随 tool_end 发出、记进落盘的 tool_result.meta，历史里也有）；组卡只收看文件、搜代码、查
// 网页这些只读探索，动作单独成行；展开的 Edit / Write / Bash 用权限卡同一个组件摆改前改后、写入内容、命令。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Sandbox } from "./sandbox.ts";
import { runAgent } from "./agent/loop.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { editTool } from "./tools/edit.ts";
import { globTool } from "./tools/glob.ts";
import { grepTool } from "./tools/grep.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { ok, type Tool, type ToolContext } from "./tools/types.ts";
import { feedUnits } from "../web/src/lib/feed-units.ts";
import { toolPreview } from "../web/src/lib/tool-preview.ts";
import { reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";
import type { Item } from "../web/src/lib/timeline-types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function ctxAt(): ToolContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-u8-"));
  roots.push(root);
  return { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 5000, bashMaxTimeoutMs: 5000 }, agentSeesImages: false };
}

test("U8 工具行第二行只说结果：Read / Edit / Write / Grep / Glob 给出中文 outcome", async () => {
  const ctx = ctxAt();
  const root = ctx.sandbox.root;
  fs.writeFileSync(path.join(root, "a.txt"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
  const partial = await readTool.run({ path: "a.txt", offset: 5, limit: 10 }, ctx);
  assert.equal(partial.outcome, "读了第 5–14 行（共 30 行）");
  const whole = await readTool.run({ path: "a.txt" }, ctx);
  assert.equal(whole.outcome, "读了全部 30 行");
  const edited = await editTool.run({ path: "a.txt", old_string: "line 12", new_string: "line 12\nline 12b" }, ctx);
  assert.equal(edited.outcome, "改了 1 处（+2 −1 行）");
  const created = await writeTool.run({ path: "b.md", content: "# 标题\n\n正文" }, ctx);
  assert.equal(created.outcome, "新建 · 3 行");
  await readTool.run({ path: "b.md" }, ctx);
  const over = await writeTool.run({ path: "b.md", content: "新的" }, ctx);
  assert.equal(over.outcome, "覆盖 · 1 行");
  const found = await grepTool.run({ pattern: "line 1", path: "." }, ctx);
  assert.match(found.outcome ?? "", /^\d+ 处匹配（1 个文件）$/);
  const none = await grepTool.run({ pattern: "不存在的词", path: "." }, ctx);
  assert.equal(none.outcome, "没有匹配");
  const files = await globTool.run({ pattern: "*.txt" }, ctx);
  assert.equal(files.outcome, "找到 1 个文件");
});

const probe: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Probe", description: "probe", parameters: { type: "object", properties: {} } },
  async run() {
    return { ...ok("probed x", "ok"), outcome: "查到 3 条" };
  },
};

function model(): TimelineModel {
  return {
    id: "s1", runId: null, title: "", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0,
  };
}
const fx: TimelineEffects = {
  foreground: true, scheduleFlush: () => {}, cancelFlush: () => {}, toast: () => {}, rememberSession: () => {},
  openBrowserPane: () => {}, setGlobal: () => {}, refill: () => {}, setBrowser: () => {},
};

test("U8 结果行随 tool_end 发出、记进落盘的 tool_result.meta（翻历史重建工具行也有）；前端收下", async (t) => {
  const adapter = scripted(t).next(calls(call("p1", "Probe")), say("好"));
  const { state } = loopState(t, adapter, { tools: [probe], user: "查" });
  const events: Record<string, unknown>[] = [];
  for await (const ev of runAgent(state, new AbortController().signal)) events.push(ev as unknown as Record<string, unknown>);
  const end = events.find((e) => e.e === "tool_end")!;
  assert.equal(end.outcome, "查到 3 条");
  const result = state.messages.flatMap((m) => m.content).find((b) => b.t === "tool_result" && b.id === "p1");
  assert.equal(result && result.t === "tool_result" ? (result.meta as Record<string, unknown> | undefined)?.outcome : undefined, "查到 3 条");
  const m = model();
  for (const ev of events) reduceTimeline(m, ev, fx);
  const row = m.timeline.find((it) => it.kind === "tool");
  assert.equal(row && row.kind === "tool" ? row.outcome : undefined, "查到 3 条");
});

const tool = (id: string, name: string): Item => ({ kind: "tool", id, name, args: {}, status: "ok", summary: "", output: "", open: false });
const think = (): Item => ({ kind: "thinking", text: "想", open: false, live: false });

test("U8 工具组只收只读探索：看文件、搜代码收成组卡，改文件、跑命令、工作流单独成行", () => {
  const tl: Item[] = [think(), tool("r1", "Read"), tool("g1", "Grep"), tool("b1", "Bash"), tool("r2", "Read"), tool("f1", "Glob"), think(), tool("e1", "Edit"), tool("w1", "Workflow")];
  const units = feedUnits(tl, false);
  const shape = units.map((u) =>
    u.f ? "折" : u.g ? `组[${u.items.map((x) => (x.kind === "tool" ? x.name : "思")).join(",")}]` : u.a ? "卡" : u.item.kind === "tool" ? u.item.name : "思",
  );
  assert.deepEqual(shape, ["组[思,Read,Grep]", "Bash", "组[Read,Glob,思]", "Edit", "Workflow"]);
  // 只有一次探索、段太短：不收
  assert.deepEqual(feedUnits([tool("r1", "Read"), tool("b1", "Bash")], false).map((u) => u.g), [false, false]);
  // 这一轮还在跑、组在最后：标 live（组卡只露当前一步）
  const live = feedUnits([tool("r1", "Read"), tool("r2", "Read"), tool("r3", "Grep")], true);
  assert.equal(live.length, 1);
  assert.equal(live[0].g && live[0].live, true);
});

test("U8 展开的工具行摆执行事实：Edit 改前 / 改后、Write 写入内容开头、Bash 命令；别的工具照旧摆参数", () => {
  assert.deepEqual(toolPreview("Edit", { path: "a.ts", old_string: "x", new_string: "y", replace_all: true }), {
    kind: "diff", path: "a.ts", old: "x", new: "y", replaceAll: true,
  });
  const w = toolPreview("Write", { path: "b.md", content: Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n") });
  assert.equal(w?.kind, "write");
  if (w?.kind === "write") {
    assert.equal(w.lines, 50);
    assert.equal(w.head.split("\n").length, 40);
    assert.equal(w.truncated, true);
  }
  assert.deepEqual(toolPreview("Bash", { command: "npm test", background: true }), { kind: "command", command: "npm test", background: true });
  assert.equal(toolPreview("Read", { path: "a.ts" }), null);
  assert.equal(toolPreview("Edit", {}), null);
});
