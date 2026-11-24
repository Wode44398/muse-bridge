// 模型档案里可以按家族关掉 / 放松的门禁：完成门禁（verifyGate）、verify:true 写法契约（verifyContract）、Edit 先读（readBeforeEdit）、
// 待办提醒（todoReminderEvery / todoReminderOnlyIncomplete）、只思考不回答的处理（thinkingOnly）。
// 每项两头都测：加固档案（hardened）= 姿态改造前的行为；改成放松值（lean 的默认就是放松值），行为确实变了。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, type TestContext } from "node:test";
import { ANSWER_NUDGE } from "./agent/loop.ts";
import { defaultProfile, hardenedProfile, resolveProfile, type ModelProfile } from "./agent/profile.ts";
import type { StreamEvent } from "./agent/events.ts";
import type { Msg } from "./agent/turn.ts";
import { setBrowserForTests } from "./cdp/pool.ts";
import type { CdpSession } from "./cdp.ts";
import { Sandbox } from "./sandbox.ts";
import { call, say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { bashTool, shell } from "./tools/bash.ts";
import { editTool } from "./tools/edit.ts";
import { evalTool } from "./tools/evaljs.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { networkTool } from "./tools/network.ts";
import { verificationAuditTool } from "./tools/verificationaudit.ts";
import { writeTool } from "./tools/write.ts";
import { ok, type Tool, type ToolContext, type ToolPolicy } from "./tools/types.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
const tmp = (prefix: string) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(r);
  return r;
};

const savedScale = process.env.DIMENSIO_RETRY_SCALE;
process.env.DIMENSIO_RETRY_SCALE = "0.001"; // 只思考的重发走重试退避：测试里把节奏调快
after(() => {
  if (savedScale === undefined) delete process.env.DIMENSIO_RETRY_SCALE;
  else process.env.DIMENSIO_RETRY_SCALE = savedScale;
});
afterEach(() => {
  delete process.env.DIMENSIO_PROFILE_OVERRIDES;
});

// 以加固档案为底改一项（各测试「改成放松值」那一头）
const profileWith = (edit: (p: ModelProfile) => void): ModelProfile => {
  const p = hardenedProfile();
  edit(p);
  return p;
};
const STRICT: ToolPolicy = { verifyContract: "strict", readBeforeEdit: "strict" };
const RELAXED: ToolPolicy = { verifyContract: "lenient", readBeforeEdit: "off" };

function toolCtx(root: string, policy?: ToolPolicy, ownerId?: string): ToolContext {
  return {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 30_000, bashMaxTimeoutMs: 30_000 },
    agentSeesImages: false,
    ...(policy ? { toolPolicy: policy } : {}),
    ...(ownerId ? { ownerId } : {}),
  };
}
const textOf = (content: { t: string; text?: string }[]): string => content.map((b) => (b.t === "text" ? b.text : "")).join("\n");
const kinds = (messages: readonly Msg[]): string[] => messages.flatMap((m) => (m.kind ? [m.kind] : []));
const toolResultText = (messages: readonly Msg[], id: string): string =>
  messages.flatMap((m) => m.content).flatMap((b) => (b.t === "tool_result" && b.id === id ? [textOf(b.content as never)] : [])).join("\n");

// ── 默认值与评测覆盖 ───────────────────────────────────────────────────────────
test("开关的默认值（lean）都是放松值、加固档案是改造前的现状；评测覆盖能按家族设，写错取值直接抛", () => {
  const p = defaultProfile();
  assert.equal(p.loop.verifyGate, "off");
  assert.equal(p.loop.todoReminderEvery, 0);
  assert.equal(p.loop.todoReminderOnlyIncomplete, true);
  assert.equal(p.loop.thinkingOnly, "retry");
  assert.equal(p.loop.verifyFootnote, "off");
  assert.equal(p.tools.verifyContract, "lenient");
  assert.equal(p.tools.readBeforeEdit, "off");
  assert.equal(p.tools.verifyTools, "off");
  const h = hardenedProfile();
  assert.equal(h.loop.verifyGate, "on");
  assert.equal(h.loop.todoReminderEvery, 5);
  assert.equal(h.loop.thinkingOnly, "nudge");
  assert.equal(h.loop.verifyFootnote, "on");
  assert.equal(h.tools.verifyContract, "strict");
  assert.equal(h.tools.readBeforeEdit, "strict");
  assert.equal(h.tools.verifyTools, "on");

  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({
    kimi: {
      posture: "hardened",
      loop: { verifyGate: "off", thinkingOnly: "retry", todoReminderEvery: 10, todoReminderOnlyIncomplete: false },
      tools: { verifyContract: "lenient", readBeforeEdit: "off" },
    },
  });
  const kimi = resolveProfile("kimi", "k3.1-pro");
  assert.equal(kimi.loop.verifyGate, "off");
  assert.equal(kimi.loop.thinkingOnly, "retry");
  assert.equal(kimi.loop.todoReminderEvery, 10);
  assert.equal(kimi.loop.todoReminderOnlyIncomplete, false);
  assert.equal(kimi.tools.verifyContract, "lenient");
  assert.equal(kimi.tools.readBeforeEdit, "off");
  // 深合并：没点名的项按覆盖里定的姿态（hardened）走
  assert.equal(kimi.posture, "hardened");
  assert.equal(kimi.loop.verifyFootnote, "on");
  assert.equal(kimi.tools.verifyTools, "on");
  assert.equal(kimi.loop.maxAnswerNudges, 1);
  assert.equal(kimi.loop.emptyResponseRetries, 1);
  assert.equal(kimi.tools.subset, null);
  // 别的家族不受影响
  const other = resolveProfile("openai", "deepseek-flash");
  assert.equal(other.posture, "lean");
  assert.equal(other.loop.verifyGate, "off");
  assert.equal(other.tools.readBeforeEdit, "off");

  for (const bad of [
    { loop: { verifyGate: "of" } },
    { loop: { thinkingOnly: "resend" } },
    { loop: { todoReminderEvery: -1 } },
    { loop: { todoReminderEvery: 2.5 } },
    { loop: { todoReminderOnlyIncomplete: "yes" } },
    { tools: { verifyContract: "loose" } },
    { tools: { readBeforeEdit: false } },
    { tools: { verifyTools: true } },
    { loop: { verifyFootnote: "no" } },
    { posture: "weak" },
  ]) {
    process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ "*": bad });
    assert.throws(() => resolveProfile("kimi", "k3.1-pro"), /取值不对的开关/, JSON.stringify(bad));
  }
});

// ── 完成门禁 verifyGate ───────────────────────────────────────────────────────
const fakeEdit: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: { name: "Edit", description: "fake edit", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("edited", "edited");
  },
};
const AUDIT_REASON = "This synthetic profile test contains no durable cross-session project knowledge.";

test("verifyGate on（加固档案）：改了代码没验证就收尾——撤回答复、追问补验证", async (t) => {
  const adapter = scripted(t).next(
    useTool("e1", "Edit", { path: "a.ts" }),
    say("done"),
    useTool("va", "VerificationAudit", { decision: "blocked", reason: "The required external test service is unavailable in this isolated test environment." }),
    say("final"),
  );
  const { state } = loopState(t, adapter, { tools: [fakeEdit, verificationAuditTool], user: "改一下", profile: hardenedProfile() });
  const { events } = await drive(state, adapter);
  assert.ok(kinds(state.messages).includes("verify-nudge"));
  assert.ok(events.some((e) => e.e === "turn_discard"));
});

test("verifyGate=off：改了代码不验证也照常收尾，不追问、不撤回", async (t) => {
  const adapter = scripted(t).next(useTool("e1", "Edit", { path: "a.ts" }), say("done"));
  const { state } = loopState(t, adapter, { tools: [fakeEdit], user: "改一下", profile: profileWith((p) => (p.loop.verifyGate = "off")) });
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 2);
  assert.ok(!kinds(state.messages).includes("verify-nudge"));
  assert.ok(!events.some((e) => e.e === "turn_discard"));
  assert.deepEqual(events.at(-1), events.find((e) => e.e === "done"));
  assert.equal(state.dirtySinceVerify, true, "证据账照记：只是不追问");
});

test("verifyGate=off：答复与 MemoryAudit 同一轮交上来时直接收尾（默认会因为没验证落回门禁）", async (t) => {
  const adapter = scripted(t).next(
    useTool("e1", "Edit", { path: "a.ts" }),
    [{ e: "text_delta", text: "改好了。" }, call("ma", "MemoryAudit", { decision: "none", reason: AUDIT_REASON }), { e: "turn_done", stopReason: "tool_use" }],
  );
  const { state } = loopState(t, adapter, {
    tools: [fakeEdit, memoryAuditTool],
    memoryAudit: true,
    user: "改一下",
    profile: profileWith((p) => (p.loop.verifyGate = "off")),
  });
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 2);
  assert.equal(events.at(-1)?.e, "done");
  assert.ok(!kinds(state.messages).includes("verify-nudge"));
});

// ── verify:true 写法契约 verifyContract ────────────────────────────────────────
test("verifyContract：Bash 只读命令带 verify——strict 打回并记失败证据；lenient 照常执行、不记证据", async () => {
  const root = tmp("dimensio-relax-bash-");
  const strict = await bashTool.run({ command: "echo hi", verify: true }, toolCtx(root, STRICT));
  assert.equal(strict.ok, false);
  assert.match(textOf(strict.content), /cannot be used as completion evidence/);
  assert.equal(strict.verification?.passed, false);
  // 不挂策略 = strict
  const bare = await bashTool.run({ command: "echo hi", verify: true }, toolCtx(root));
  assert.deepEqual(bare, strict);

  const lenient = await bashTool.run({ command: "echo hi", verify: true }, toolCtx(root, RELAXED));
  assert.equal(lenient.ok, true);
  assert.match(textOf(lenient.content), /hi/);
  assert.match(textOf(lenient.content), /NOT recorded as verification evidence/);
  assert.equal(lenient.verification, undefined);
});

test("verifyContract：吞退出码的 || 带 verify——strict 不执行（verify:true needs）；lenient 照常执行、不记证据", async () => {
  const root = tmp("dimensio-relax-bash-or-");
  const strict = await bashTool.run({ command: "false || true", verify: true }, toolCtx(root, STRICT));
  assert.equal(strict.ok, false);
  assert.match(textOf(strict.content), /verify:true needs/);
  assert.equal(strict.verification, undefined);

  const lenient = await bashTool.run({ command: "false || true", verify: true }, toolCtx(root, RELAXED));
  assert.doesNotMatch(textOf(lenient.content), /verify:true needs/);
  assert.match(textOf(lenient.content), /NOT recorded as verification evidence/);
  assert.equal(lenient.verification, undefined);
  if (shell.kind === "bash") assert.equal(lenient.ok, true);
  // 写法合格的检查在 lenient 下照旧记证据
  const real = await bashTool.run({ command: "node -e \"process.exit(0)\"", verify: true }, toolCtx(root, RELAXED));
  assert.equal(real.verification?.passed, true);
});

function fakePage(value: unknown): CdpSession {
  return {
    alive: true,
    url: "http://fake.test/",
    eval: async () => value,
    networkEntries: () => [{ id: "r1", t: 0, method: "GET", url: "http://fake.test/api/x", status: 200, size: 0, state: "done" }],
    dialogsSince: () => [],
    dialogSeq: 0,
    dialogReported: 0,
  } as unknown as CdpSession;
}

test("verifyContract：Eval 返回非布尔——strict 判为畸形；lenient 当普通求值交回。false 在两档都是失败的检查", async (t) => {
  const owner = "relax-eval-owner";
  t.after(() => setBrowserForTests(owner, null));
  const root = tmp("dimensio-relax-eval-");
  setBrowserForTests(owner, fakePage({ ok: true }));
  const strict = await evalTool.run({ js: "x", verify: true }, toolCtx(root, STRICT, owner));
  assert.equal(strict.ok, false);
  assert.match(textOf(strict.content), /verify:true needs the expression to evaluate to a boolean/);
  assert.equal(strict.verification, undefined);

  const lenient = await evalTool.run({ js: "x", verify: true }, toolCtx(root, RELAXED, owner));
  assert.equal(lenient.ok, true);
  assert.match(textOf(lenient.content), /"ok": true/);
  assert.match(textOf(lenient.content), /NOT recorded as verification evidence/);
  assert.equal(lenient.verification, undefined);

  setBrowserForTests(owner, fakePage(false));
  for (const policy of [STRICT, RELAXED]) {
    const failed = await evalTool.run({ js: "x", verify: true }, toolCtx(root, policy, owner));
    assert.equal(failed.ok, false);
    assert.equal(failed.verification?.passed, false);
  }
});

test("verifyContract：Network verify 缺 filter / expectedStatus——strict 打回并记失败；lenient 当普通列表交回", async (t) => {
  const owner = "relax-net-owner";
  t.after(() => setBrowserForTests(owner, null));
  const root = tmp("dimensio-relax-net-");
  setBrowserForTests(owner, fakePage(true));
  const strict = await networkTool.run({ action: "list", verify: true }, toolCtx(root, STRICT, owner));
  assert.equal(strict.summary, "network assertion invalid");
  assert.equal(strict.verification?.passed, false);

  const lenient = await networkTool.run({ action: "list", verify: true }, toolCtx(root, RELAXED, owner));
  assert.equal(lenient.ok, true);
  assert.match(textOf(lenient.content), /api\/x/);
  assert.match(textOf(lenient.content), /NOT recorded as verification evidence/);
  assert.equal(lenient.verification, undefined);

  // 合格的断言两档一样
  for (const policy of [STRICT, RELAXED]) {
    const res = await networkTool.run({ action: "list", verify: true, filter: "/api/x", expectedStatus: 200 }, toolCtx(root, policy, owner));
    assert.equal(res.verification?.passed, true);
  }
});

test("verifyContract：loop 按会话档案把策略交给工具（lenient 的会话里只读命令带 verify 不被打回）", async (t) => {
  for (const [contract, expect] of [["strict", /cannot be used as completion evidence/], ["lenient", /NOT recorded as verification evidence/]] as const) {
    const adapter = scripted(t).next(useTool("b1", "Bash", { command: "echo hi", verify: true }), say("done"));
    const { state } = loopState(t, adapter, { tools: [bashTool], user: "看一下", profile: profileWith((p) => (p.tools.verifyContract = contract)) });
    await drive(state, adapter);
    assert.match(toolResultText(state.messages, "b1"), expect, contract);
  }
});

// ── Edit 先读 readBeforeEdit ──────────────────────────────────────────────────
test("readBeforeEdit：strict 没读过就否决（规划阶段与执行两处）；off 照改、仍要求唯一命中；Write 覆盖仍要先读", async () => {
  const root = tmp("dimensio-relax-edit-");
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "alpha\nbeta\nalpha2\n");

  const strict = toolCtx(root, STRICT);
  const veto = await editTool.prepare!({ path: "a.txt", old_string: "beta", new_string: "BETA" }, strict);
  assert.equal(veto?.veto?.summary, "not read");
  const refused = await editTool.run({ path: "a.txt", old_string: "beta", new_string: "BETA" }, strict);
  assert.equal(refused.ok, false);
  assert.match(textOf(refused.content), /You must Read a\.txt before editing it/);
  assert.equal(fs.readFileSync(file, "utf8"), "alpha\nbeta\nalpha2\n");
  // 不挂策略 = strict
  assert.equal((await editTool.prepare!({ path: "a.txt", old_string: "beta", new_string: "BETA" }, toolCtx(root)))?.veto?.summary, "not read");

  const off = toolCtx(root, RELAXED);
  assert.equal(await editTool.prepare!({ path: "a.txt", old_string: "beta", new_string: "BETA" }, off), null);
  const applied = await editTool.run({ path: "a.txt", old_string: "beta", new_string: "BETA" }, off);
  assert.equal(applied.ok, true, textOf(applied.content));
  assert.equal(fs.readFileSync(file, "utf8"), "alpha\nBETA\nalpha2\n");
  assert.equal(off.readFileState.has(path.resolve(file)), false, "没读过的文件不记成读过");
  // 唯一命中、找不到照旧报
  const ambiguous = await editTool.run({ path: "a.txt", old_string: "alpha", new_string: "x" }, off);
  assert.equal(ambiguous.summary, "ambiguous");
  const missing = await editTool.run({ path: "a.txt", old_string: "gamma", new_string: "x" }, off);
  assert.equal(missing.summary, "no match");
  // Write 覆盖已有文件的先读要求不归这个开关管
  const wVeto = await writeTool.prepare!({ path: "a.txt", content: "over" }, off);
  assert.equal(wVeto?.veto?.summary, "not read");
  const wRun = await writeTool.run({ path: "a.txt", content: "over" }, off);
  assert.equal(wRun.ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), "alpha\nBETA\nalpha2\n");
});

test("readBeforeEdit：loop 按会话档案把策略交给 Edit", async (t) => {
  for (const mode of ["strict", "off"] as const) {
    const adapter = scripted(t).next(useTool("e1", "Edit", { path: "notes.md", old_string: "old", new_string: "new" }), say("done"));
    const { state, root } = loopState(t, adapter, { tools: [editTool], user: "改一下", profile: profileWith((p) => (p.tools.readBeforeEdit = mode)) });
    fs.writeFileSync(path.join(root, "notes.md"), "old text\n");
    await drive(state, adapter);
    assert.equal(fs.readFileSync(path.join(root, "notes.md"), "utf8"), mode === "off" ? "new text\n" : "old text\n", mode);
  }
});

// ── 待办提醒 todoReminderEvery / todoReminderOnlyIncomplete ─────────────────────
const probe: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Probe", description: "probe", parameters: { type: "object", properties: { n: { type: "number" } } } },
  async run() {
    return ok("probed", "probe");
  },
};

async function reminderRequests(t: TestContext, profile: ModelProfile, allDone: boolean): Promise<number[]> {
  const steps = Array.from({ length: 6 }, (_, i) => useTool(`p${i}`, "Probe", { n: i }));
  const adapter = scripted(t).next(...steps, say("done"));
  const { state } = loopState(t, adapter, { tools: [probe], user: "探一下", profile });
  state.todos = [
    { content: "第一步", status: "completed" },
    { content: "第二步", status: allDone ? "completed" : "in_progress" },
  ];
  await drive(state, adapter);
  return adapter.inputs.flatMap((turn, i) => (turn.messages.at(-1)?.kind === "todo" ? [i] : []));
}

test("待办提醒：加固档案每 5 个工具回合一次、只在有没做完的项时；可改间隔、可关、可在全部完成时也提醒；lean 默认不提醒", async (t) => {
  const dflt = hardenedProfile();
  assert.deepEqual(await reminderRequests(t, dflt, false), [5]);
  assert.deepEqual(await reminderRequests(t, dflt, true), [], "全部完成：默认不提醒");
  assert.deepEqual(await reminderRequests(t, defaultProfile(), false), [], "lean：不提醒");
  assert.deepEqual(await reminderRequests(t, profileWith((p) => (p.loop.todoReminderEvery = 2)), false), [2, 4, 6]);
  assert.deepEqual(await reminderRequests(t, profileWith((p) => (p.loop.todoReminderEvery = 0)), false), []);
  assert.deepEqual(
    await reminderRequests(t, profileWith((p) => { p.loop.todoReminderEvery = 2; p.loop.todoReminderOnlyIncomplete = false; }), true),
    [2, 4, 6],
  );
});

// ── 只思考不回答 thinkingOnly ──────────────────────────────────────────────────
const thinkOnly = (text: string): StreamEvent[] => [{ e: "thinking_delta", text }, { e: "turn_done", stopReason: "end" }];
const EMPTY: StreamEvent[] = [{ e: "turn_done", stopReason: "end" }];
const userTexts = (msgs: readonly Msg[]): string[] =>
  msgs.filter((m) => m.role === "user").flatMap((m) => m.content.flatMap((b) => (b.t === "text" ? [b.text] : [])));

test("thinkingOnly nudge（加固档案）：只思考就要收尾——追加一句追问再问一次", async (t) => {
  const adapter = scripted(t).next(thinkOnly("想了想"), say("答复"));
  const { state } = loopState(t, adapter, { user: "问个事", profile: hardenedProfile() });
  await drive(state, adapter);
  assert.ok(userTexts(adapter.inputs[1].messages).includes(ANSWER_NUDGE));
  assert.ok(kinds(state.messages).includes("answer-nudge"));
});

test("thinkingOnly=retry：不追加追问，同一份请求原样重发；拿到答复照常收尾", async (t) => {
  const adapter = scripted(t).next(thinkOnly("想了想"), say("答复"));
  const { state } = loopState(t, adapter, { user: "问个事", profile: profileWith((p) => (p.loop.thinkingOnly = "retry")) });
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 2);
  assert.deepEqual(adapter.inputs[1].messages, adapter.inputs[0].messages, "重发的是同一份请求");
  assert.ok(!kinds(state.messages).includes("answer-nudge"));
  assert.equal(events.at(-1)?.e, "done");
  const last = state.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.deepEqual(last.content.filter((b) => b.t === "text").map((b) => (b.t === "text" ? b.text : "")), ["答复"]);
});

test("thinkingOnly=retry：重发次数用 emptyResponseRetries（与空响应共用一份），用完仍只有思考就照常收尾、不报错", async (t) => {
  const retry = profileWith((p) => (p.loop.thinkingOnly = "retry"));
  {
    const adapter = scripted(t).next(thinkOnly("一"), thinkOnly("二"));
    const { state } = loopState(t, adapter, { user: "问个事", profile: retry });
    const { events } = await drive(state, adapter);
    assert.equal(adapter.callCount, 2, "默认重发 1 次");
    assert.equal(events.at(-1)?.e, "done");
    assert.ok(!events.some((e) => e.e === "error"));
    assert.ok(!kinds(state.messages).includes("answer-nudge"));
  }
  {
    const adapter = scripted(t).next(thinkOnly("一"), thinkOnly("二"), say("答复"));
    const { state } = loopState(t, adapter, { user: "问个事", profile: profileWith((p) => { p.loop.thinkingOnly = "retry"; p.loop.emptyResponseRetries = 2; }) });
    await drive(state, adapter);
    assert.equal(adapter.callCount, 3);
  }
  {
    // 先空响应用掉了这次调用的重发机会，接着只思考就不再重发
    const adapter = scripted(t).next(EMPTY, thinkOnly("一"));
    const { state } = loopState(t, adapter, { user: "问个事", profile: retry });
    const { events } = await drive(state, adapter);
    assert.equal(adapter.callCount, 2);
    assert.equal(events.at(-1)?.e, "done");
  }
});
