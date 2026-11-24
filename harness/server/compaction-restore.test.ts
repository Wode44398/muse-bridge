// 压缩回填与 inline 摘要的边角：反复压缩时上一次回填的文件 / 计划照样带下去；回填替模型读文件前先按权限判 Read；
// 回填的预算按真实窗口算（手动压缩的 limit 是此刻的用量）；上一次的回填落在尾部时被换掉而不是叠上去；inline 出错 / 抛错 /
// 碰到输出上限都退回 sidecar；开着思考时 inline 的输出上限不低于主请求；整段压缩紧跟着要做时微压缩不先改写前缀；
// 还在跑的后台任务列在回填里、裁剪时保留。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { COMPACTION_SYSTEM, compactManually, ensureContextFits, estimateTokens } from "./agent/context.ts";
import { RESTORE_HEAD, RESTORE_KIND, renderRestore, trimRestore, type Restore } from "./agent/compaction-restore.ts";
import type { StreamEvent } from "./agent/events.ts";
import { messageKind } from "./agent/injections.ts";
import { defaultProfile, hardenedProfile, type ModelProfile } from "./agent/profile.ts";
import type { PermissionRules } from "./agent/permissions.ts";
import type { CompactionArchive } from "./agent/state.ts";
import type { Msg, ToolDef } from "./agent/turn.ts";
import { isInlineCompactionRequest } from "./test-harness/context-windows.ts";
import { fakeSummary, say, scripted, type Step } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { jobState } from "./tools/bash/state.ts";
import type { BashJob } from "./tools/bash/jobs.ts";
import { readTool } from "./tools/read.ts";
import { ok, type Tool } from "./tools/types.ts";

const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const reply = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
const toolCall = (id: string, name: string, args: Record<string, unknown>): Msg => ({ role: "assistant", content: [{ t: "tool_call", id, name, args }] });
const result = (id: string, okay: boolean, text: string): Msg => ({ role: "user", content: [{ t: "tool_result", id, ok: okay, content: [{ t: "text", text }] }] });
const textOf = (m: Msg | undefined): string => (m ? m.content.map((b) => (b.t === "text" ? b.text : "")).join("") : "");
const restoreOf = (msgs: Msg[]): Msg | undefined => msgs.find((m) => messageKind(m) === RESTORE_KIND);
const summaryOf = (msgs: Msg[]): Msg | undefined => msgs.find((m) => messageKind(m) === "compaction-summary");
const textRounds = (n: number, from = 0): Msg[] => Array.from({ length: n }, (_, i) => [user(`q${from + i}`), reply("r".repeat(4_000))]).flat();

const echoTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("echoed", "echo result");
  },
};

interface Opts {
  contextWindow?: number;
  maxOutputTokens?: number;
  rules?: PermissionRules;
  ownerId?: string;
  archive?: CompactionArchive;
  profile?: ModelProfile;
}

function setup(t: test.TestContext, steps: Step[], opts: Opts = {}) {
  const adapter = scripted(t, { capabilities: { contextWindow: opts.contextWindow ?? 40_000, maxOutputTokens: opts.maxOutputTokens ?? 32_000 } }).next(...steps);
  const { state, root } = loopState(t, adapter, {
    tools: [echoTool, readTool],
    profile: opts.profile ?? defaultProfile(),
    ...(opts.rules ? { permissionRules: opts.rules } : {}),
    ...(opts.ownerId ? { ctx: { ownerId: opts.ownerId } } : {}),
    ...(opts.archive ? { compactionArchive: opts.archive } : {}),
  });
  return { adapter, state, root };
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

// 中段里改了 n 个文件（f0 最早），之后是一长段纯文本问答
function editHistory(n: number, rounds = 24): Msg[] {
  const msgs: Msg[] = [user("改一遍这些文件")];
  for (let i = 0; i < n; i++) msgs.push(toolCall(`w${i}`, "Write", { path: `src/f${i}.ts`, content: "x" }), result(`w${i}`, true, `wrote src/f${i}.ts`));
  msgs.push(...textRounds(rounds));
  return msgs;
}

function memArchive(): { files: Map<string, string>; archive: CompactionArchive } {
  const files = new Map<string, string>();
  let n = 0;
  return {
    files,
    archive: {
      plan: (count) => {
        n++;
        return Array.from({ length: count }, (_, k) => `/arch/compacted-${n}-${k + 1}.txt`);
      },
      write: async (list) => {
        for (const f of list) files.set(f.path, f.text);
      },
    },
  };
}

// ── 反复压缩 ──────────────────────────────────────────────────────────────────
test("反复压缩：两次之间没有新改动，上一次回填的文件照样回填、已读状态照样记上（改动调用已经被换成摘要）", async (t) => {
  const { state, root } = setup(t, [say(fakeSummary("notes 1")), say(fakeSummary("notes 2"))]);
  writeFiles(root, { "src/f0.ts": "export const f0 = 0;\n", "src/f1.ts": "export const f1 = 1;\n" });
  state.messages = editHistory(2);
  await compactManually(state);
  assert.match(textOf(restoreOf(state.messages)), /### src\/f1\.ts[\s\S]*### src\/f0\.ts/);
  assert.match(textOf(restoreOf(state.messages)), /if an Edit says you must Read the file first/, "已读状态不落盘：措辞不把话说死");
  // 之后只聊天、不改文件；回填那条落进第二次的中段
  state.messages.push(...textRounds(24, 100));
  assert.ok(!state.messages.some((m) => m.content.some((b) => b.t === "tool_call" && b.name === "Write")), "改动调用已经不在转录里");
  await compactManually(state);
  const text = textOf(restoreOf(state.messages));
  assert.match(text, /### src\/f1\.ts \(lines 1-2 of 2\)[\s\S]*### src\/f0\.ts \(lines 1-2 of 2\)/, "上一次回填的文件仍在、顺序不变");
  assert.equal(state.messages.filter((m) => messageKind(m) === RESTORE_KIND).length, 1);
  assert.deepEqual(state.ctx.readFileState.get(path.join(root, "src", "f1.ts"))?.readRanges, [[1, 2]], "已读状态照样记上");
});

test("反复压缩：plan 模式下的待批计划第二次压缩后仍在回填里；归档里也留着这一节", async (t) => {
  const mem = memArchive();
  const { state } = setup(t, [say(fakeSummary("notes 1")), say(fakeSummary("notes 2"))], { archive: mem.archive });
  state.permissionMode = "plan";
  state.messages = [
    user("先做计划"),
    toolCall("p1", "ExitPlanMode", { plan: "## Plan\n1. change src/a.ts\n2. run npm test" }),
    result("p1", false, "The user sent the plan back: also cover src/b.ts"),
    ...textRounds(28),
  ];
  await compactManually(state);
  assert.match(textOf(restoreOf(state.messages)), /## Plan awaiting approval\nYou are still in plan mode[\s\S]*1\. change src\/a\.ts/);
  state.messages.push(...textRounds(24, 100));
  await compactManually(state);
  const text = textOf(restoreOf(state.messages));
  assert.match(text, /## Plan awaiting approval\nYou are still in plan mode\. The last plan you submitted with ExitPlanMode is not approved \(the response was: The user sent the plan back: also cover src\/b\.ts\):\n## Plan\n1\. change src\/a\.ts\n2\. run npm test/);
  assert.equal((text.match(/## Plan awaiting approval/g) ?? []).length, 1, "不叠成两节");
  const second = [...mem.files.entries()].filter(([p]) => p.startsWith("/arch/compacted-2")).map(([, v]) => v).join("\n");
  assert.match(second, /working state re-attached after an earlier compaction[\s\S]*## Plan awaiting approval[\s\S]*1\. change src\/a\.ts/, "归档里留着待批计划");
  assert.doesNotMatch(second, /## Todo list/);
});

test("反复压缩：上一次的回填落在这次的尾部里——换成新的一条，不叠两条", async (t) => {
  const { state } = setup(t, [say(fakeSummary("notes"))]);
  state.todos = [{ content: "NEW TODO", status: "in_progress" }];
  const oldRestore: Msg = {
    role: "user",
    origin: "harness",
    kind: RESTORE_KIND,
    internal: true,
    content: [{ t: "text", text: `${RESTORE_HEAD} Working state as of the compaction, re-attached after the summary above.\n\n## Todo list\n[ ] OLD TODO` }],
  };
  // 上一条摘要很大（压掉它就够了），回填与之后的几条都在尾部预算里
  state.messages = [
    user("task"),
    { role: "user", origin: "harness", kind: "compaction-summary", content: [{ t: "text", text: `[Earlier context summary]\n${"old notes. ".repeat(6_000)}` }] },
    oldRestore,
    user("接着来"),
    reply("好"),
  ];
  await compactManually(state);
  const restores = state.messages.filter((m) => messageKind(m) === RESTORE_KIND);
  assert.equal(restores.length, 1, "只有一条回填");
  assert.match(textOf(restores[0]), /NEW TODO/);
  assert.doesNotMatch(JSON.stringify(state.messages), /OLD TODO/, "尾部里那条旧回填被拿掉了");
  const at = state.messages.findIndex((m) => messageKind(m) === "compaction-summary");
  assert.equal(state.messages[at + 1], restores[0], "新回填紧跟摘要");
  assert.equal(textOf(state.messages.at(-2)), "接着来", "尾部其余原样");
});

// ── 权限 ──────────────────────────────────────────────────────────────────────
test("回填替模型读文件：用户的 Read 拒绝规则命中的文件不回填、不记已读（Edit 没被拦也一样）", async (t) => {
  const { state, root } = setup(t, [say(fakeSummary("notes"))], { rules: { allow: [], deny: ["Read(src/f1.ts)"], ask: [] } });
  writeFiles(root, { "src/f0.ts": "export const f0 = 0;\n", "src/f1.ts": "SECRET_BODY = 1\n" });
  state.messages = editHistory(2);
  await compactManually(state);
  const text = textOf(restoreOf(state.messages));
  assert.match(text, /### src\/f0\.ts/);
  assert.doesNotMatch(text, /f1\.ts|SECRET_BODY/);
  assert.equal(state.ctx.readFileState.has(path.join(root, "src", "f1.ts")), false);
});

test("回填替模型读文件：要弹卡问的（ask 规则）也不回填；会话里没有 Read 工具就一个都不回填", async (t) => {
  const asked = setup(t, [say(fakeSummary("notes"))], { rules: { allow: [], deny: [], ask: ["Read(src/f0.ts)"] } });
  writeFiles(asked.root, { "src/f0.ts": "a\n", "src/f1.ts": "b\n" });
  asked.state.messages = editHistory(2);
  await compactManually(asked.state);
  const text = textOf(restoreOf(asked.state.messages));
  assert.match(text, /### src\/f1\.ts/);
  assert.doesNotMatch(text, /### src\/f0\.ts/);

  const adapter = scripted(t, { capabilities: { contextWindow: 40_000, maxOutputTokens: 32_000 } }).next(say(fakeSummary("notes")));
  const { state, root } = loopState(t, adapter, { tools: [echoTool], profile: defaultProfile() });
  writeFiles(root, { "src/f0.ts": "a\n" });
  state.messages = editHistory(1);
  await compactManually(state);
  assert.equal(restoreOf(state.messages), undefined);
});

// ── 预算 ──────────────────────────────────────────────────────────────────────
test("回填的预算按真实窗口算：大窗口上用量不高时手动压缩，改过的文件整份回填而不是被裁光 / 只给开头", async (t) => {
  const { state, root } = setup(t, [say(fakeSummary("notes"))], { contextWindow: 200_000 });
  const body = Array.from({ length: 100 }, (_, k) => `export const v${k} = "${"z".repeat(50)}";`).join("\n");
  writeFiles(root, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`src/f${i}.ts`, body])));
  state.messages = editHistory(5);
  const before = estimateTokens(state.system, state.messages);
  assert.ok(before < 40_000, `用量 ${before} token，远低于 20 万窗口`);
  await compactManually(state);
  const text = textOf(restoreOf(state.messages));
  for (let i = 0; i < 5; i++) assert.match(text, new RegExp(`### src/f${i}\\.ts \\(lines 1-100 of 100\\)\\n`), `f${i} 整份回填`);
  assert.ok(estimateTokens(state.system, state.messages) < before, "压完仍比压前短");
});

test("回填：还在跑的后台任务列在回填里；裁剪一路裁到底也保留它与待办", async (t) => {
  const owner = "restore-jobs-owner";
  const job = { id: "job-fake-1", command: "npm test", done: false, owner, startedAt: Date.now(), waiters: new Set() } as unknown as BashJob;
  jobState.jobs.set(job.id, job);
  t.after(() => jobState.jobs.delete(job.id));
  const { state } = setup(t, [say(fakeSummary("notes"))], { ownerId: owner });
  state.todos = [{ content: "等测试", status: "in_progress" }];
  state.messages = editHistory(0, 30);
  await compactManually(state);
  const text = textOf(restoreOf(state.messages));
  assert.match(text, /## Background jobs still running\njob-fake-1 \(\$ npm test; running 1 min\)\. Bash\(wait:"<id>"\)/);

  let r: Restore | null = { todos: "[~] 等测试", plan: "a plan", jobs: "job-fake-1 ($ npm test; running 1 min)", files: [{ abs: "/a", rel: "a", text: "### a", tokens: 1, read: { mtimeMs: 0, content: "", readRanges: [], complete: true } }] };
  let last = r;
  while (r) {
    last = r;
    r = trimRestore(r);
  }
  assert.deepEqual({ todos: last.todos, plan: last.plan, jobs: last.jobs, files: last.files.length }, { todos: "[~] 等测试", plan: "", jobs: "job-fake-1 ($ npm test; running 1 min)", files: 0 });
  assert.match(textOf(renderRestore(last)!), /## Todo list[\s\S]*## Background jobs still running/);
});

// ── inline 退回 sidecar ────────────────────────────────────────────────────────
test("退回 sidecar：inline 流里来了 error 事件、请求直接抛错、碰到输出上限（stopReason=length）——都改由旁路写，不提交半截摘要", async (t) => {
  const cases: [string, Step][] = [
    ["error 事件", [{ e: "error", kind: "overloaded", retriable: true } as StreamEvent]],
    ["抛错", { throws: "socket hang up" }],
    ["碰到输出上限", say(`${fakeSummary("HALF")}\n## 6. Errors`, "length")],
  ];
  for (const [label, step] of cases) {
    const { adapter, state } = setup(t, [step, say(fakeSummary("SIDECAR NOTES"))]);
    state.messages = [user("task"), ...textRounds(30)];
    await compactManually(state);
    assert.equal(adapter.callCount, 2, label);
    assert.ok(isInlineCompactionRequest(adapter.inputs[0]), `${label}：先试的 inline`);
    assert.equal(adapter.inputs[1].system, COMPACTION_SYSTEM, `${label}：退回旁路`);
    const summary = textOf(summaryOf(state.messages));
    assert.match(summary, /SIDECAR NOTES/, label);
    assert.doesNotMatch(summary, /HALF/, `${label}：半截摘要没提交`);
  }
});

test("inline 开着思考：输出上限不低于主请求（思考也吃 max_tokens）；关思考时按摘要自己的预算", async (t) => {
  const thinking = setup(t, [say(fakeSummary("notes"))], { contextWindow: 100_000, maxOutputTokens: 64_000 });
  thinking.state.budget = { maxOutputTokens: 30_000, thinking: "high" };
  thinking.state.messages = [user("task"), ...textRounds(30)];
  await compactManually(thinking.state);
  const a = thinking.adapter.inputs[0];
  assert.ok(isInlineCompactionRequest(a));
  assert.equal(a.budget.thinking, "high");
  assert.ok(a.budget.maxOutputTokens >= 30_000, `inline 输出上限 ${a.budget.maxOutputTokens}`);

  const plain = setup(t, [say(fakeSummary("notes"))], { contextWindow: 100_000, maxOutputTokens: 64_000 });
  plain.state.budget = { maxOutputTokens: 30_000, thinking: "off" };
  plain.state.messages = [user("task"), ...textRounds(30)];
  await compactManually(plain.state);
  const b = plain.adapter.inputs[0];
  assert.ok(isInlineCompactionRequest(b));
  assert.ok(b.budget.maxOutputTokens < 30_000, `关思考：按摘要预算 ${b.budget.maxOutputTokens}`);
});

// ── 微压缩与 inline 的先后 ─────────────────────────────────────────────────────
// 中段有几条大工具输出（微压缩能腾出 4000+ token），但腾完仍在触发线上：不先就地改写，inline 请求的前缀与上一轮相同
function microThenFull(t: test.TestContext, slack: number, steps: Step[] = []) {
  const msgs: Msg[] = [user("task")];
  for (let i = 0; i < 3; i++) msgs.push(toolCall(`e${i}`, "Echo", {}), result(`e${i}`, true, `${i}${"o".repeat(7_000)}`));
  msgs.push(...textRounds(36));
  const est = estimateTokens("test", msgs);
  // 触发线 = 窗口 − 1.3 万；slack = 用量超过触发线多少
  const { adapter, state } = setup(t, steps, { contextWindow: est - slack + 13_000 });
  state.messages = msgs;
  return { adapter, state };
}

test("微压缩腾完仍要整段压缩：不先改写旧工具输出，inline 请求原样带着它们（前缀与上一轮主请求相同）", async (t) => {
  const { adapter, state } = microThenFull(t, 7_000, [say(fakeSummary("notes"))]);
  const original = JSON.stringify(state.messages);
  const fit = await ensureContextFits(state);
  assert.equal(fit.compacted, true);
  assert.equal(adapter.callCount, 1);
  const inline = adapter.inputs[0];
  assert.ok(isInlineCompactionRequest(inline), "走 inline");
  assert.doesNotMatch(JSON.stringify(inline.messages), /old tool output elided/, "请求里没有微压缩的占位");
  assert.equal(JSON.stringify(inline.messages.slice(0, -1)), original, "前缀就是压缩前的转录");
  assert.ok(summaryOf(state.messages));
});

test("微压缩腾完就回到线下：照旧只做微压缩，不整段压缩", async (t) => {
  const { adapter, state } = microThenFull(t, 2_000);
  const fit = await ensureContextFits(state);
  assert.equal(fit.compacted, true);
  assert.equal(adapter.callCount, 0, "没有发摘要请求");
  assert.match(JSON.stringify(state.messages), /old tool output elided/);
  assert.equal(summaryOf(state.messages), undefined);
});

test("整段压缩熔断了：腾得出就照做微压缩（不因为「要整段压缩」而跳过）", async (t) => {
  const { adapter, state } = microThenFull(t, 7_000);
  state.compactionFailures = 3;
  const fit = await ensureContextFits(state);
  assert.equal(fit.compacted, true);
  assert.equal(adapter.callCount, 0);
  assert.match(JSON.stringify(state.messages), /old tool output elided/, "熔断了：腾得出就照做微压缩");
});

// ── 延迟加载的工具（集成衔接）─────────────────────────────────────────────────
const deferredDef = (name: string): ToolDef => ({ name, description: `${name} FULL-DOCS-${name}`, parameters: { type: "object", properties: {} } });
const searchResult = (id: string, names: string[]): Msg => ({
  role: "user",
  content: [{ t: "tool_result", id, ok: true, content: [{ t: "text", text: names.map((n) => `## ${n}\n${n} FULL-DOCS-${n}`).join("\n\n") }], meta: { loadedTools: names } }],
});

test("压缩后已加载的延迟工具不丢：说明在中段里的回填一份说明、仍算已加载；说明还在尾部里的不重复回填", async (t) => {
  const { state } = setup(t, [say(fakeSummary("notes"))]);
  state.ctx.deferredTools = new Map([["Preview", deferredDef("Preview")], ["Workflow", deferredDef("Workflow")], ["PullRequest", deferredDef("PullRequest")]]);
  state.loadedTools = new Set(["Preview", "Workflow"]);
  state.messages = [
    user("task"),
    toolCall("s1", "ToolSearch", { names: ["Preview"] }),
    searchResult("s1", ["Preview"]),
    ...textRounds(26),
    toolCall("s2", "ToolSearch", { names: ["Workflow"] }),
    searchResult("s2", ["Workflow"]),
    reply("ok"),
  ];
  await compactManually(state);
  const text = textOf(restoreOf(state.messages));
  assert.match(text, /## Loaded deferred tools \(full instructions\)[\s\S]*## Preview\nPreview FULL-DOCS-Preview/, "说明在中段里：回填一份");
  assert.doesNotMatch(text, /FULL-DOCS-Workflow/, "说明还在尾部里：不重复");
  assert.doesNotMatch(text, /PullRequest/, "没加载过的不回填");
  assert.deepEqual([...state.loadedTools].sort(), ["Preview", "Workflow"], "压缩后仍算已加载");
});

test("回填裁剪先丢延迟工具的说明；被裁掉的那几件回到未加载（下次调用照常附上说明）", async (t) => {
  const r: Restore = { todos: "[ ] t", plan: "p", jobs: "", files: [], tools: { names: ["Preview"], text: "## Preview", tokens: 3 }, loadedInTail: [] };
  const once = trimRestore(r)!;
  assert.equal(once.tools, undefined);
  assert.equal(once.plan, "p", "说明先于计划被裁");

  // 窗口很小：说明放不下合计预算，就不回填，提交后它回到未加载
  const { state } = setup(t, [say(fakeSummary("notes"))]);
  state.ctx.deferredTools = new Map([["Preview", { ...deferredDef("Preview"), description: "x ".repeat(20_000) }]]);
  state.loadedTools = new Set(["Preview"]);
  state.messages = [user("task"), toolCall("s1", "ToolSearch", { names: ["Preview"] }), searchResult("s1", ["Preview"]), ...textRounds(26)];
  await compactManually(state);
  assert.doesNotMatch(textOf(restoreOf(state.messages)), /Loaded deferred tools/);
  assert.equal(state.loadedTools.has("Preview"), false);
});

test("回填措辞按档案：lean（Edit 不要求先读）不说别的文件都要先 Read；hardened 照旧说", async (t) => {
  for (const [profile, strict] of [[defaultProfile(), false], [hardenedProfile(), true]] as const) {
    const { state, root } = setup(t, [say(fakeSummary("notes"))], { profile });
    writeFiles(root, { "src/f0.ts": "export const f0 = 0;\n" });
    state.messages = editHistory(1);
    await compactManually(state);
    const text = textOf(restoreOf(state.messages));
    assert.match(text, /### src\/f0\.ts/);
    assert.equal(/Any other file must be Read before you edit it/.test(text), strict, profile.posture);
  }
});

test("回填认工具的路径别名：模型写 Edit({filePath}) 改过的文件照样回填", async (t) => {
  const { state, root } = setup(t, [say(fakeSummary("notes"))]);
  writeFiles(root, { "src/alias.ts": "export const a = 1;\n" });
  state.messages = [user("改"), toolCall("e1", "Edit", { filePath: "src/alias.ts", old_string: "0", new_string: "1" }), result("e1", true, "edited"), ...textRounds(26)];
  await compactManually(state);
  assert.match(textOf(restoreOf(state.messages)), /### src\/alias\.ts/);
});
