// 工具延迟加载（agent/deferred-tools.ts，对齐 Claude Code 的 tool search）。
// 修前：每次请求都带全部工具的完整说明——全开时约 8.6 万字符，其中 Browser 一个 2 万、操作电脑六件约 1.9 万，绝大多数对话一次都用不上。
// 再修前：没先 ToolSearch 就调推迟的工具必被拦下、白费一轮；「加载过」只从转录现推，整段压缩之后又得重来一遍。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { ensureContextFits } from "./agent/context.ts";
import { deferredGate, deferredLoaded, deferToolDefs, notLoadedResult, stubDef, toolSearchTool, TOOL_SEARCH } from "./agent/deferred-tools.ts";
import { restoreFromRecord } from "./session/build-state.ts";
import { sessionRecord } from "./session.ts";
import type { Msg, ToolDef } from "./agent/turn.ts";
import { dropSession, startRun, type Session } from "./session.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { ALL_TOOLS } from "./tools/registry.ts";
import { ok, type Tool, type ToolContext } from "./tools/types.ts";

const roots: string[] = [];
const sessions: Session[] = [];
after(() => {
  for (const s of sessions) dropSession(s.id);
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* windows 句柄 */
    }
  }
});

const allDefs = (): ToolDef[] => ALL_TOOLS.map((t) => t.def);
const size = (x: unknown) => JSON.stringify(x).length;

test("瘦身：推迟的工具只留第一句 + 怎么取说明；顶层参数的名字、类型、枚举、必填都在，说明文字全去掉；工具表总量至少省三成", () => {
  const defs = allDefs();
  const { defs: out, deferred } = deferToolDefs(defs);
  assert.equal(out.length, defs.length, "工具表一项不增不减（缓存前缀稳定）");
  assert.deepEqual(out.map((d) => d.name), defs.map((d) => d.name), "顺序不变");
  for (const name of [
    "Browser", "ReadPage", "Eval", "Network", "DeviceAct", "BridgeCall", "PullRequest", "Workspace", "Terminal",
    "Workflow", "StartSession", "SendMessage", "ListSessions", "ReadSession", "Preview", "WidgetGuide", "ShowWidget", "ProjectKnowledge",
  ]) {
    assert.ok(deferred.has(name), `${name} 推迟`);
  }
  for (const name of ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Agent", "AskUserQuestion", "WebFetch", "WebSearch", "Skill", "TodoWrite", "Remember", "Recall"]) {
    assert.ok(!deferred.has(name), `${name} 是常用工具，不推迟`);
  }
  const full = deferred.get("Browser")!;
  const stub = out.find((d) => d.name === "Browser")!;
  assert.match(stub.description, /Deferred tool/);
  assert.match(stub.description, new RegExp(`call ${TOOL_SEARCH}`));
  assert.ok(size(stub) < size(full) / 5, `Browser ${size(full)} → ${size(stub)}`);
  assert.deepEqual(Object.keys(stub.parameters.properties ?? {}), Object.keys(full.parameters.properties ?? {}), "顶层参数一个不少");
  assert.deepEqual((stub.parameters.properties as Record<string, { enum?: unknown }>).action.enum, (full.parameters.properties as Record<string, { enum?: unknown }>).action.enum);
  assert.doesNotMatch(JSON.stringify(stub.parameters), /"description"/);
  assert.ok(size([...out, toolSearchTool.def]) < size(defs) * 0.7, `${size(defs)} → ${size([...out, toolSearchTool.def])}`);
});

test("骨架里的数组一律带 items（有的 provider 不认没有 items 的数组）", () => {
  const walk = (p: unknown): void => {
    if (!p || typeof p !== "object") return;
    const o = p as Record<string, unknown>;
    if (o.type === "array") assert.ok(o.items, "数组带 items");
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  for (const d of deferToolDefs(allDefs()).defs) walk(d.parameters);
});

const ctxWith = (deferred: Map<string, ToolDef>): ToolContext =>
  ({ deferredTools: deferred }) as unknown as ToolContext;

test("ToolSearch：按名字加载整族（Browser 带上 ReadPage / Eval / Network），按关键词也找得到；结果带 meta.loadedTools", async () => {
  const { deferred } = deferToolDefs(allDefs());
  const r = await toolSearchTool.run({ names: ["Browser"] }, ctxWith(deferred));
  assert.equal(r.ok, true);
  assert.deepEqual(r.meta?.loadedTools, ["Browser", "ReadPage", "Eval", "Network"]);
  const text = r.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.ok(text.includes(deferred.get("Browser")!.description), "完整说明原样给出");
  assert.match(text, /Parameters \(JSON schema\)/);
  const q = await toolSearchTool.run({ query: "pull request" }, ctxWith(deferred));
  assert.ok((q.meta?.loadedTools as string[]).includes("PullRequest"));
  const sel = await toolSearchTool.run({ query: "select:Preview,PullRequest" }, ctxWith(deferred));
  assert.deepEqual(sel.meta?.loadedTools, ["Preview", "PullRequest"], "select:A,B 按名字点");
  const bad = await toolSearchTool.run({ names: ["Read"] }, ctxWith(deferred));
  assert.equal(bad.ok, false);
  assert.match(bad.content.map((b) => (b.t === "text" ? b.text : "")).join(""), /Not deferred tools: Read/);
});

test("「加载过没有」从对话里现推：有说明结果、或调用过（不算正在判定的这一次）", () => {
  const msgs: Msg[] = [{ role: "assistant", content: [{ t: "tool_call", id: "c1", name: "Workspace", args: {} }] }];
  assert.equal(deferredLoaded(msgs, "Workspace", "c1"), false, "正在判定的这一次不算");
  assert.equal(deferredLoaded(msgs, "Workspace"), true, "之前调用过");
  const viaSearch: Msg[] = [{ role: "user", content: [{ t: "tool_result", id: "s1", ok: true, content: [], meta: { loadedTools: ["Browser", "Eval"] } }] }];
  assert.equal(deferredLoaded(viaSearch, "Eval"), true);
  assert.equal(deferredLoaded(viaSearch, "Network"), false);
});

const WORKSPACE_DEF: ToolDef = {
  name: "Workspace",
  description: "Look at the user's workspace view. It has many details the model must read first.",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["view"], description: "What to do." } }, required: ["action"] },
};

test("没加载说明就调：参数过得了完整 schema 就直接执行，结果后附完整说明、记进会话状态；之后再调不再附", async (t) => {
  let runs = 0;
  const fake: Tool = { effect: "read", concurrencySafe: true, def: WORKSPACE_DEF, run: async () => (runs++, ok("viewed", "the view")) };
  const adapter = scripted(t).next(useTool("w1", "Workspace", { action: "view" }), useTool("w2", "Workspace", { action: "view" }), say("看过了"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "defer-"));
  roots.push(root);
  const session = attachSession(adapter, root, { tools: [fake, toolSearchTool] });
  sessions.push(session);
  session.state!.ctx.deferredTools = new Map([["Workspace", WORKSPACE_DEF]]);
  session.state!.tools = [stubDef(WORKSPACE_DEF), toolSearchTool.def];
  await startRun(session, "看看我的工作区").done;
  assert.equal(runs, 2, "两次都执行了，没有白费一轮");
  const first = JSON.stringify(adapter.inputs[1].messages.at(-1));
  assert.match(first, /the view/);
  assert.match(first, /deferred tool instructions, now loaded/);
  assert.match(first, /It has many details the model must read first/);
  const second = JSON.stringify(adapter.inputs[2].messages.at(-1));
  assert.match(second, /the view/);
  assert.doesNotMatch(second, /deferred tool instructions/, "加载过就不再附");
  const r1 = session.state!.messages.flatMap((m) => m.content).find((b) => b.t === "tool_result" && b.id === "w1");
  assert.ok(r1 && r1.t === "tool_result" && r1.ok);
  assert.deepEqual(r1.meta?.loadedTools, ["Workspace"], "微压缩据此不清掉说明");
  assert.ok(session.state!.loadedTools.has("Workspace"));
});

test("不能直接执行的：参数过不了完整 schema、或是不看说明写不对的工具（Workflow / Browser）——不执行、回完整说明并记为已加载", () => {
  const deferred = new Map([
    ["Workspace", WORKSPACE_DEF],
    ["Workflow", { ...WORKSPACE_DEF, name: "Workflow", description: "Run a workflow script. Script API details." }],
  ]);
  const bad = deferredGate("Workspace", { action: "bogus" }, deferred);
  assert.equal(bad.run, false);
  if (!bad.run) {
    const text = bad.res.content.map((b) => (b.t === "text" ? b.text : "")).join("");
    assert.match(text, /arguments do not match its parameters/);
    assert.match(text, /\$\.action: must be one of "view"/);
    assert.match(text, /was NOT run/);
    assert.deepEqual(bad.res.meta?.loadedTools, ["Workspace"]);
  }
  const missing = deferredGate("Workspace", {}, deferred);
  assert.equal(missing.run, false, "缺必填同样回说明");
  const wf = deferredGate("Workflow", { action: "view" }, deferred);
  assert.equal(wf.run, false, "Workflow 参数对得上也先看说明");
  assert.equal(deferredGate("Workspace", { action: "view" }, deferred).run, true);
  assert.equal(notLoadedResult("Workspace", deferred).ok, false);
  assert.match(stubDef(WORKSPACE_DEF).description, /also runs directly/);
  assert.match(stubDef(deferred.get("Workflow")!).description, /before the first use/);
});

test("加载过记在会话状态、随会话落盘：转录被整段压缩掉之后也不再附说明，恢复出来的会话照样认", async (t) => {
  let runs = 0;
  const fake: Tool = { effect: "read", concurrencySafe: true, def: WORKSPACE_DEF, run: async () => (runs++, ok("viewed", "the view")) };
  const adapter = scripted(t).next(useTool("w1", "Workspace", { action: "view" }), say("一"), useTool("w2", "Workspace", { action: "view" }), say("二"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "defer-persist-"));
  roots.push(root);
  const session = attachSession(adapter, root, { tools: [fake, toolSearchTool] });
  sessions.push(session);
  const state = session.state!;
  state.ctx.deferredTools = new Map([["Workspace", WORKSPACE_DEF]]);
  state.tools = [stubDef(WORKSPACE_DEF), toolSearchTool.def];
  await startRun(session, "看一下").done;
  // 整段压缩：之前的调用与说明都不在转录里了
  state.messages = [{ role: "user", content: [{ t: "text", text: "[summary] 之前看过工作区" }] }, { role: "assistant", content: [{ t: "text", text: "好" }] }];
  await startRun(session, "再看一下").done;
  assert.equal(runs, 2);
  assert.doesNotMatch(JSON.stringify(adapter.inputs[3].messages.at(-1)), /deferred tool instructions/, "压缩后仍算加载过");
  const rec = sessionRecord(session)!;
  assert.deepEqual(rec.tools?.loaded, ["Workspace"]);
  const other = attachSession(scripted(t), root, { tools: [fake] });
  sessions.push(other);
  restoreFromRecord(other.state!, rec);
  assert.ok(other.state!.loadedTools.has("Workspace"), "恢复出来的会话照样认");
});

test("微压缩不清推迟工具的说明（清了模型会照着骨架瞎填参数，还当自己加载过）", async (t) => {
  const adapter = scripted(t, { capabilities: { contextWindow: 30_000 } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "defer-micro-"));
  roots.push(root);
  const session = attachSession(adapter, root);
  sessions.push(session);
  const state = session.state!;
  const big = (tag: string) => `${tag} ${"x".repeat(24_000)}`;
  const msgs: Msg[] = [{ role: "user", content: [{ t: "text", text: "任务" }] }];
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: "assistant", content: [{ t: "tool_call", id: `c${i}`, name: i === 0 ? TOOL_SEARCH : "Grep", args: { i } }] });
    msgs.push({
      role: "user",
      content: [{ t: "tool_result", id: `c${i}`, ok: true, content: [{ t: "text", text: big(`out${i}`) }], ...(i === 0 ? { meta: { loadedTools: ["Browser"] } } : {}) }],
    });
  }
  for (let i = 0; i < 6; i++) msgs.push({ role: i % 2 ? "user" : "assistant", content: [{ t: "text", text: `tail ${i}` }] });
  state.messages = msgs;
  const fit = await ensureContextFits(state);
  assert.equal(fit.compacted, true);
  const results = state.messages.flatMap((m) => m.content).filter((b) => b.t === "tool_result");
  const text = (id: string) => {
    const b = results.find((x) => x.t === "tool_result" && x.id === id);
    return b && b.t === "tool_result" ? JSON.stringify(b.content) : "";
  };
  assert.match(text("c0"), /out0 x{100}/, "说明原样留着");
  assert.match(text("c1"), /old tool output elided/, "别的旧输出照常清");
});
