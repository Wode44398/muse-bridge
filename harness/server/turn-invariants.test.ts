// Q3（X11）：请求不变量校验器——每次请求的结构检查、同一次 run 内 system / tools 的稳定检查；
// 测试里违反即失败（脚本化 provider 默认验每次输入），生产路径上只计数、绝不抛。
import assert from "node:assert/strict";
import test from "node:test";
import { RunInvariants, checkTurn } from "./agent/turn-invariants.ts";
import type { Block, Msg, ToolDef, Turn } from "./agent/turn.ts";
import { ScriptedAdapter, say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { ok, type Tool } from "./tools/types.ts";

const text = (s: string): Block => ({ t: "text", text: s });
const user = (...content: Block[]): Msg => ({ role: "user", content });
const assistant = (...content: Block[]): Msg => ({ role: "assistant", content });
const toolCall = (id: string, name = "Read"): Block => ({ t: "tool_call", id, name, args: {} });
const result = (id: string, content: Block[] = [text("out")]): Block => ({ t: "tool_result", id, ok: true, content });
const def = (name: string): ToolDef => ({ name, description: name, parameters: { type: "object", properties: {} } });
const turnOf = (messages: Msg[], extra: Partial<Turn> = {}): Turn => ({
  system: "sys",
  messages,
  tools: [def("Read")],
  budget: { maxOutputTokens: 10 },
  ...extra,
});

test("Q3 合规的请求：工具成对、媒体带数据、工具名不重复——没有违反项", () => {
  const turn = turnOf([
    user(text("look"), { t: "image", mime: "image/png", data: "iVBORw0KGgo=" }),
    assistant(text("reading"), toolCall("a"), toolCall("b")),
    user(result("b"), result("a", [text("x"), { t: "image", mime: "image/png", url: "https://example.invalid/x.png" }])),
    assistant(text("done")),
  ], { tools: [def("Read"), def("Grep")] });
  assert.deepEqual(checkTurn(turn), []);
});

const BAD: { name: string; turn: Turn; expect: RegExp }[] = [
  { name: "没有消息", turn: turnOf([]), expect: /request has no messages/ },
  { name: "空消息", turn: turnOf([user(text("hi")), assistant()]), expect: /message 2: empty assistant message/ },
  { name: "空文本块", turn: turnOf([user(text(""))]), expect: /message 1 block 1: empty text block/ },
  {
    name: "只剩 asset 引用的图片（materialize 漏了）",
    turn: turnOf([user(text("see"), { t: "image", mime: "image/png", asset: "img-1" })]),
    expect: /message 1 block 2: image block carries no data at the provider boundary \(asset img-1 was not materialized\)/,
  },
  {
    name: "工具结果里只剩 asset 的截图",
    turn: turnOf([user(text("go")), assistant(toolCall("a")), user(result("a", [{ t: "image", mime: "image/png", asset: "shot-1" }]))]),
    expect: /message 3 block 1 > block 1: image block carries no data/,
  },
  { name: "空的调用 id", turn: turnOf([user(text("go")), assistant(toolCall("")), user(result(""))]), expect: /tool_call Read with an empty id/ },
  {
    name: "调用 id 跨消息重复",
    turn: turnOf([user(text("go")), assistant(toolCall("a")), user(result("a")), assistant(toolCall("a")), user(result("a"))]),
    expect: /message 4: tool_call id a is used more than once/,
  },
  { name: "调用出现在用户消息里", turn: turnOf([user(text("go"), toolCall("a"))]), expect: /message 1: tool_call a inside a user message/ },
  { name: "结果出现在 assistant 消息里", turn: turnOf([user(text("go")), assistant(toolCall("a"), result("a"))]), expect: /message 2: tool_result a inside an assistant message/ },
  { name: "缺结果（与 R5 修复同一套判定）", turn: turnOf([user(text("go")), assistant(toolCall("a"))]), expect: /message 2: tool_call a has no result/ },
  { name: "工具名重复", turn: turnOf([user(text("go"))], { tools: [def("Read"), def("Read")] }), expect: /tool Read is defined more than once/ },
];

for (const c of BAD) {
  test(`Q3 查得出：${c.name}`, () => {
    assert.match(checkTurn(c.turn).join("\n"), c.expect);
  });
}

test("Q3 同一次 run 内：system 只在报备过的改写后变；工具定义不许变", () => {
  const base = turnOf([user(text("go"))]);
  const run = new RunInvariants();
  assert.deepEqual(run.check(base, 0), []);
  assert.deepEqual(run.check(base, 0), [], "原样重发（重试）不算变");
  assert.match(run.check({ ...base, system: "sys + date" }, 0).join("\n"), /system prompt changed within the run without a declared rewrite/);
  assert.deepEqual(run.check({ ...base, system: "sys + plan" }, 1), [], "报备过（systemRewrites 加一）就放行");
  assert.match(run.check({ ...base, system: "sys + plan", tools: [def("Read"), def("Grep")] }, 1).join("\n"), /tool definitions changed within the run/);
  // 每次 runAgent 一个新实例：跨 run 的变化不归这里管（归 Q4 的前缀判定器）
  assert.deepEqual(new RunInvariants().check({ ...base, system: "next run" }, 0), []);
});

test("Q3 脚本化 provider 默认拿 checkTurn 验每次输入：请求不合法，测试收尾判失败；validate: false 才不查", async () => {
  const bad = turnOf([user(text("see"), { t: "image", mime: "image/png", asset: "img-1" })]);
  const strict = new ScriptedAdapter().next(say("x"));
  for await (const _ of strict.stream(bad)) { /* drain */ }
  assert.throws(() => strict.assertDone(), /请求检查不过：[\s\S]*第 1 次调用：message 1 block 2: image block carries no data/);

  const lax = new ScriptedAdapter({ validate: false }).next(say("x"));
  for await (const _ of lax.stream(bad)) { /* drain */ }
  assert.doesNotThrow(() => lax.assertDone());
});

// 模拟「有人在运行中直接改写 state.system」（比如把日期拼进 system）：这类改写没有报备，会悄悄打断缓存前缀。
function systemMutator(mutate: () => void): Tool {
  return {
    effect: "read",
    concurrencySafe: true,
    def: def("Mutate"),
    async run() {
      mutate();
      return ok("mutated", "done");
    },
  };
}

test("Q3 生产路径：运行中没报备就改 system——loop 照常跑完、只计数并告警一次，绝不抛", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const adapter = scripted(t).next(useTool("m1", "Mutate"), useTool("m2", "Mutate"), say("finished"));
  let n = 0;
  const { state } = loopState(t, adapter, {
    user: "go",
    tools: [systemMutator(() => { state.system = `test (edit ${++n})`; })],
  });
  const { events } = await drive(state, adapter);
  assert.ok(events.some((e) => e.e === "done"), "违规只计数，不能打断这一轮");
  assert.ok(!events.some((e) => e.e === "error"));
  assert.equal(state.invariantViolations, 2, "第 2、3 次请求各记一笔");
  assert.match(state.invariantSamples[0], /system prompt changed within the run without a declared rewrite/);
  const warned = warn.mock.calls.filter((c) => String(c.arguments[0]).includes("request invariant violated"));
  assert.equal(warned.length, 1, "同一条 state 只告警一次，不刷屏");
  // 本用例故意制造违规，核对完清零（否则 loopState 的收尾检查会判它失败——那正是这道检查在测试里的作用）
  state.invariantViolations = 0;
  state.invariantSamples = [];
});

test("Q3 报备过的改写（rewriteSystem）：下一次请求带上新 system，不记违规", async (t) => {
  const adapter = scripted(t).next(useTool("m1", "Mutate"), say("finished"));
  const { state } = loopState(t, adapter, {
    user: "go",
    tools: [systemMutator(() => state.rewriteSystem("test + plan section", "mode"))],
  });
  await drive(state, adapter);
  assert.equal(adapter.inputs[0].system, "test");
  assert.equal(adapter.inputs[1].system, "test + plan section");
  assert.equal(state.invariantViolations, 0);
  assert.equal(state.systemRewrites, 1);
  assert.equal(state.lastSystemRewrite, "mode");
});

test("Q3 检查本身出错也不抛：记一笔「check crashed」，这一轮照常跑完", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(RunInvariants.prototype, "check", () => {
    throw new Error("boom");
  });
  const adapter = scripted(t).next(say("fine"));
  const { state } = loopState(t, adapter, { user: "go" });
  const { events } = await drive(state, adapter);
  assert.ok(events.some((e) => e.e === "done"));
  assert.equal(state.invariantViolations, 1);
  assert.match(state.invariantSamples[0], /request invariant check crashed: boom/);
  state.invariantViolations = 0;
  state.invariantSamples = [];
});
