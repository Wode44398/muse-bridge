// 档案姿态（agent/profile.ts 的 posture）：默认 lean（按强模型校准），只有实测评分低于阈值的型号 hardened；两层覆盖能强制任一姿态。
// lean 下的行为：不撤回、不追问补验证、半句停下不追问、不提醒待办、不附验证尾注；工具不带 verify 参数、不下发 VerificationAudit
//（模型照旧传了就静默去掉、按普通调用执行）；系统提示词是精简版，按文字标记工作的几个函数对它照样成立。
// 加固姿态下的门禁行为由 verification / loop-gates / answer-nudge / cutoff-nudge 等测试在 hardened 档案下钉着。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";
import { defaultProfile, hardenedProfile, HARDENED_BELOW_II, resolveProfile, setRatingsForTests, type RatingsApi } from "./agent/profile.ts";
import { HARDENED_DEFERRED_FAMILIES } from "./agent/deferred-tools.ts";
import { refreshDynamicContext, refreshPlanSection, systemPrompt } from "./agent/prompt.ts";
import { hardenedCore, leanCore } from "./agent/prompt-core.ts";
import { PLAYBOOKS, playbookMessage } from "./agent/playbooks.ts";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import { plainCheckOutcome, shapeVerifyTools, VERIFY_CONTRACT_MARKER, withoutVerify } from "./agent/verify-tools.ts";
import { ensureProjectKnowledge } from "./knowledge.ts";
import { knowledgeIdle } from "./knowledge-service.ts";
import { CUTOFF_NUDGE } from "./agent/loop.ts";
import { defaultEffort } from "./catalog.ts";
import { setConfig } from "./config.ts";
import { Sandbox } from "./sandbox.ts";
import { buildState } from "./session/build-state.ts";
import { createSession, dropSession, setSessionModel, startRun } from "./session.ts";
import type { PersistedConfig } from "./store.ts";
import { call, say, scripted, ScriptedAdapter, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { ALL_TOOLS } from "./tools/registry.ts";
import { ok, type Tool } from "./tools/types.ts";

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
afterEach(() => {
  delete process.env.DIMENSIO_PROFILE_OVERRIDES;
  setRatingsForTests(undefined);
});

// 评分替身：按型号 id 精确查；全库中位 30
function ratingsWith(table: Record<string, number>): RatingsApi {
  return {
    loadRatings: (j) => j,
    lookupRating: (_index, id) => (Object.hasOwn(table, String(id)) ? { slug: String(id), ii: table[String(id)], version: "v5.0" } : null),
    ratingsSummary: () => ({ version: "v5.0", median: 30 }),
  };
}

// ── 姿态判定 ──────────────────────────────────────────────────────────────────
test("姿态：只有实测评分低于阈值的才 hardened；按中位推的、没评分的、认不出的都是 lean，理由写在档案上", () => {
  assert.equal(HARDENED_BELOW_II, 20);
  setRatingsForTests(ratingsWith({ "weak-1": 12.5, "edge-20": 20, "strong-1": 48 }), {});
  const weak = resolveProfile("custom-0a1b2c3d", "weak-1");
  assert.equal(weak.tier.source, "aa");
  assert.equal(weak.posture, "hardened");
  assert.equal(weak.postureReason, "aa ii 12.5 < 20");
  assert.equal(weak.loop.verifyGate, "on");
  assert.equal(weak.tools.verifyTools, "on");
  assert.equal(resolveProfile("custom-0a1b2c3d", "edge-20").posture, "lean", "等于阈值不算低");
  const strong = resolveProfile("custom-0a1b2c3d", "strong-1");
  assert.equal(strong.posture, "lean");
  assert.equal(strong.postureReason, "aa ii 48 >= 20");
  // 认不出的：按全库中位推（conservative），也不加固
  const unknown = resolveProfile("custom-0a1b2c3d", "never-heard-of-it");
  assert.equal(unknown.tier.source, "median-fallback");
  assert.equal(unknown.posture, "lean");
  assert.equal(unknown.postureReason, "no measured rating (median-fallback)");
  // 评分模块缺席
  setRatingsForTests(null);
  const none = resolveProfile("custom-0a1b2c3d", "weak-1");
  assert.equal(none.posture, "lean");
  assert.equal(none.postureReason, "no rating");
});

test("姿态：环境变量的 posture 键能强制任一姿态（家族的压过 *）；其余项叠在该姿态之上；写错直接抛", () => {
  setRatingsForTests(ratingsWith({ "k3.1-pro": 10, "deepseek-flash": 48 }), {});
  assert.equal(resolveProfile("kimi", "k3.1-pro").posture, "hardened");
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ "*": { posture: "hardened" }, kimi: { posture: "lean", loop: { todoReminderEvery: 7 } } });
  const kimi = resolveProfile("kimi", "k3.1-pro");
  assert.equal(kimi.posture, "lean");
  assert.equal(kimi.postureReason, "DIMENSIO_PROFILE_OVERRIDES.kimi (DIMENSIO_PROFILE_OVERRIDES.* (aa ii 10 < 20))");
  assert.equal(kimi.loop.verifyGate, "off");
  assert.equal(kimi.loop.todoReminderEvery, 7);
  const ds = resolveProfile("openai", "deepseek-flash");
  assert.equal(ds.posture, "hardened");
  assert.equal(ds.postureReason, "DIMENSIO_PROFILE_OVERRIDES.* (aa ii 48 >= 20)");
  assert.deepEqual(
    { gate: ds.loop.verifyGate, todo: ds.loop.todoReminderEvery, read: ds.tools.readBeforeEdit, verify: ds.tools.verifyTools },
    { gate: "on", todo: 5, read: "strict", verify: "on" },
  );
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ "*": { posture: "weak" } });
  assert.throws(() => resolveProfile("kimi", "k3.1-pro"), /posture/);
});

// ── 工具形状 ──────────────────────────────────────────────────────────────────
test("工具形状：lean 去掉 Bash / Eval / Network 的 verify（Network 连带 expectedStatus）与 VerificationAudit，顺序不变；hardened 原样", () => {
  const lean = shapeVerifyTools(ALL_TOOLS, "off");
  const names = lean.map((t) => t.def.name);
  assert.ok(!names.includes("VerificationAudit"));
  assert.deepEqual(names, ALL_TOOLS.map((t) => t.def.name).filter((n) => n !== "VerificationAudit"));
  for (const t of lean) {
    if (["Bash", "Eval", "Network"].includes(t.def.name)) assert.ok(!("verify" in t.def.parameters.properties), `${t.def.name} 不该有 verify`);
    assert.doesNotMatch(JSON.stringify(t.def.parameters), /verify:true/, t.def.name);
  }
  // Browser / DeviceAct 的 verify 是命中检查开关（关了更快），不归验证证据，两种姿态都留着
  for (const n of ["Browser", "DeviceAct"]) assert.ok("verify" in lean.find((t) => t.def.name === n)!.def.parameters.properties, n);
  // Browser 的 dprprobe：hardened 原文是收尾硬规定 + 「算验证证据」；lean 没有门禁与证据，换成中性陈述，其余说明与执行原样
  const browserOn = ALL_TOOLS.find((t) => t.def.name === "Browser")!;
  const browserOff = lean.find((t) => t.def.name === "Browser")!;
  assert.match(browserOn.def.description, /canvas\/WebGL pages MUST pass this probe once after edits before being declared done\. Counts as verification evidence\./);
  assert.doesNotMatch(browserOff.def.description, /MUST pass this probe|verification evidence|declared done/);
  assert.match(browserOff.def.description, /after editing a canvas\/WebGL page it is worth running once\./);
  assert.equal(browserOff.run, browserOn.run, "只换说明，执行原样");
  assert.deepEqual(browserOff.def.parameters, browserOn.def.parameters);
  const network = lean.find((t) => t.def.name === "Network")!;
  assert.ok(!("expectedStatus" in network.def.parameters.properties));
  assert.deepEqual(shapeVerifyTools(ALL_TOOLS, "on"), [...ALL_TOOLS]);
  // 原工具不被改动
  const bash = ALL_TOOLS.find((t) => t.def.name === "Bash")!;
  assert.ok("verify" in bash.def.parameters.properties);
});

test("工具形状：lean 下模型照旧传了 verify，进工具之前静默去掉、按普通调用执行（规划阶段同样）", async () => {
  const seen: Record<string, unknown>[] = [];
  const fake: Tool = {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Bash", description: "fake", parameters: { type: "object", properties: { command: { type: "string" }, verify: { type: "boolean" } } } },
    prepare: (args) => {
      seen.push({ prepare: true, ...args });
      return null;
    },
    async run(args) {
      seen.push(args);
      return ok("ran", "ran");
    },
  };
  const shaped = withoutVerify(fake);
  assert.deepEqual(Object.keys(shaped.def.parameters.properties), ["command"]);
  await shaped.prepare!({ command: "npm test", verify: true }, {} as never);
  const res = await shaped.run({ command: "npm test", verify: true }, {} as never);
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [{ prepare: true, command: "npm test" }, { command: "npm test" }]);
  assert.equal(withoutVerify(ALL_TOOLS.find((t) => t.def.name === "Read")!), ALL_TOOLS.find((t) => t.def.name === "Read"), "没有验证参数的工具原样返回");
});

// 型号用目录里的 deepseek-flash、按它的默认思考档（实测评分在阈值之上 → lean；关掉思考的那一档评分在阈值之下）
function cfgFor(root: string): PersistedConfig {
  const thinking = defaultEffort("openai", "deepseek-flash");
  setConfig({ provider: "openai", model: "deepseek-flash", thinking, apiKey: "DUMMY-posture-key", workspace: root, permissionMode: "auto", access: "workspace" });
  return { provider: "openai", model: "deepseek-flash", thinking, permissionMode: "auto", permissionRules: { allow: [], deny: [], ask: [] }, workspace: root, access: "workspace" } as PersistedConfig;
}
const bashDef = (state: ReturnType<typeof buildState>) => state.tools.find((d) => d.name === "Bash");

test("建会话：lean 的工具表不带 verify / VerificationAudit、system 是精简版；hardened 原样；姿态写回会话配置，恢复时沿用", (t) => {
  t.mock.method(console, "log", () => {});
  const root = tmp("dimensio-posture-ws-");
  const leanCfg = cfgFor(root);
  const lean = buildState(leanCfg);
  assert.equal(lean.profile.posture, "lean");
  assert.equal(leanCfg.posture, "lean", "姿态随会话配置落盘");
  assert.ok(!lean.tools.some((d) => d.name === "VerificationAudit") && !lean.toolMap.has("VerificationAudit"));
  assert.ok(bashDef(lean) && !("verify" in bashDef(lean)!.parameters.properties));
  assert.equal(lean.toolMap.get("Bash")!.def, bashDef(lean), "执行用的工具与下发的定义是同一份形状");
  assert.equal(lean.toolMap.get("Bash")!.shellCwd, true, "包过的 Bash 仍带会话当前目录的标记（派发层按它注入 / 抹掉隐藏键）");
  assert.match(lean.system, /## Working/);
  assert.doesNotMatch(lean.system, /verify:true|VerificationAudit/);
  assert.equal(lean.profile.loop.verifyGate, "off");

  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ "*": { posture: "hardened" } });
  const hardCfg = cfgFor(root);
  const hard = buildState(hardCfg);
  assert.equal(hard.profile.posture, "hardened");
  assert.equal(hardCfg.posture, "hardened");
  assert.ok(hard.tools.some((d) => d.name === "VerificationAudit"));
  assert.ok("verify" in bashDef(hard)!.parameters.properties);
  assert.ok(hard.system.includes(VERIFY_CONTRACT_MARKER));

  // 恢复（或重建）时姿态按会话定下的那个：此刻覆盖表强制 hardened，lean 会话照样是 lean 的 system、工具表与门禁
  const resumedLean = buildState(leanCfg, lean.system);
  assert.equal(resumedLean.profile.posture, "lean");
  assert.equal(resumedLean.profile.postureReason, "pinned by session");
  assert.equal(JSON.stringify(resumedLean.tools), JSON.stringify(lean.tools));
  assert.equal(resumedLean.profile.loop.verifyGate, "off");
  delete process.env.DIMENSIO_PROFILE_OVERRIDES;
  // 反过来：hardened 会话在评分判 lean 的此刻恢复，照样 hardened
  const resumedHard = buildState(hardCfg, hard.system);
  assert.equal(resumedHard.profile.posture, "hardened");
  assert.equal(JSON.stringify(resumedHard.tools), JSON.stringify(hard.tools));
  assert.equal(resumedHard.profile.loop.verifyGate, "on");

  // 姿态改造之前写的老会话（记录里没有 posture）：那时一律是加固形态，按 hardened 恢复——system 原样沿用，它点名的
  // verify / VerificationAudit 照样在，门禁也照当初
  const legacyCfg = cfgFor(root);
  const resumed = buildState(legacyCfg, hard.system);
  assert.equal(resumed.system, hard.system);
  assert.equal(resumed.profile.posture, "hardened");
  assert.match(resumed.profile.postureReason, /legacy/);
  assert.equal(legacyCfg.posture, "hardened", "从此记下，之后按它沿用");
  assert.equal(resumed.profile.tools.verifyTools, "on");
  assert.equal(resumed.profile.loop.verifyGate, "on");
  assert.ok(resumed.tools.some((d) => d.name === "VerificationAudit"));
  assert.ok("verify" in bashDef(resumed)!.parameters.properties);
});

// 集成衔接：工具线的 Write 先读档位与扩大的推迟范围、压缩线的摘要方式，都跟着姿态走；hardened 等于改造前
test("建会话：lean 用 any 先读档、推迟范围扩大、摘要 inline；hardened 用 full、推迟回到改造前的五族、摘要走旁路", (t) => {
  t.mock.method(console, "log", () => {});
  const root = tmp("dimensio-posture-integ-");
  const lean = buildState(cfgFor(root));
  assert.equal(lean.profile.tools.readBeforeWrite, "any");
  assert.equal(lean.profile.side.summary.mode, "inline");
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ "*": { posture: "hardened" } });
  try {
    const hard = buildState(cfgFor(root));
    assert.equal(hard.profile.tools.readBeforeWrite, "full");
    assert.equal(hard.profile.side.summary.mode, "sidecar");
    assert.deepEqual(hard.profile.tools.deferredFamilies, HARDENED_DEFERRED_FAMILIES);
    const legacy = new Set(HARDENED_DEFERRED_FAMILIES.flat());
    const hardDeferred = [...(hard.ctx.deferredTools?.keys() ?? [])];
    assert.ok(hardDeferred.every((n) => legacy.has(n)), `hardened 只推迟改造前的五族：${hardDeferred.join(",")}`);
    for (const name of ["Workflow", "ProjectKnowledge", "StartSession"]) {
      if (!lean.toolMap.has(name)) continue;
      assert.ok(lean.ctx.deferredTools?.has(name), `lean 推迟 ${name}`);
      assert.ok(!hard.ctx.deferredTools?.has(name), `hardened 不推迟 ${name}`);
      assert.ok(!hard.tools.find((d) => d.name === name)?.description.includes("[Deferred tool"), `hardened 的 ${name} 是完整说明`);
    }
  } finally {
    delete process.env.DIMENSIO_PROFILE_OVERRIDES;
  }
});

test("会话中途切思考档跨过评分阈值：姿态不翻，工具表、门禁、system 都不变（生产路径 setSessionModel → rebindModel）", async (t) => {
  t.mock.method(console, "log", () => {});
  const root = tmp("dimensio-posture-switch-");
  const cfg = cfgFor(root);
  // deepseek-flash：默认档实测评分在阈值之上（lean），关掉思考那一档在阈值之下（单独解析是 hardened）
  assert.equal(resolveProfile("openai", "deepseek-flash", { effort: cfg.thinking }).posture, "lean");
  assert.equal(resolveProfile("openai", "deepseek-flash", { effort: "off" }).posture, "hardened");
  const session = createSession();
  const run = startRun(session, "你好");
  session.state!.adapter = scripted(t).next(say("你好！"));
  await run.done;
  const before = session.state!;
  assert.equal(before.profile.posture, "lean");
  assert.equal(session.cfg?.posture, "lean");

  const r = setSessionModel(session, { thinking: "off" });
  assert.equal(r.ok, true, r.error);
  const rebuilt = session.state!;
  assert.notEqual(rebuilt, before, "换档照旧按新档重建");
  assert.equal(rebuilt.budget.thinking, "off");
  assert.equal(rebuilt.profile.posture, "lean");
  assert.equal(JSON.stringify(rebuilt.tools), JSON.stringify(before.tools), "同一会话工具表不变");
  assert.equal(rebuilt.system, before.system);
  assert.equal(rebuilt.profile.loop.verifyGate, "off");
  assert.equal(rebuilt.profile.tools.readBeforeEdit, "off");
  assert.equal(rebuilt.profile.loop.verifyFootnote, "off");
  assert.ok(!rebuilt.toolMap.has("VerificationAudit"));
  assert.equal(session.cfg?.posture, "lean");
  dropSession(session.id);
});

// ── loop 行为 ─────────────────────────────────────────────────────────────────
const fakeEdit: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: { name: "Edit", description: "fake edit", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("edited", "edited");
  },
};

test("lean：改了代码没验证就收尾——不撤回、不追问补验证、不附「未验证」尾注", async (t) => {
  const adapter = scripted(t).next(useTool("e1", "Edit", { path: "a.ts" }), say("改好了"));
  const { state } = loopState(t, adapter, { tools: [fakeEdit], user: "改一下", finalFootnotes: true });
  const { events } = await drive(state, adapter);
  assert.equal(adapter.callCount, 2);
  assert.ok(!events.some((e) => e.e === "turn_discard"));
  assert.ok(!state.messages.some((m) => m.kind === "verify-nudge"));
  const last = state.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.deepEqual(last.content.flatMap((b) => (b.t === "text" ? [b.text] : [])), ["改好了"]);
  assert.equal(events.at(-1)?.e, "done");
});

test("lean：认得出的检查运行（跑完、退出码归属得到）给项目知识留验证记录；后台、管道、只读命令、超时不记", () => {
  const bash = (args: Record<string, unknown>, text: string, okFlag = true) =>
    plainCheckOutcome({ name: "Bash", args }, { ok: okFlag, summary: "", content: [{ t: "text", text }] });
  assert.deepEqual(bash({ command: "npm test" }, "$ npm test\n# pass 4\n[exit 0]"), { passed: true, detail: "npm test (exit 0)" });
  assert.deepEqual(bash({ command: "cd web && npx tsc --noEmit" }, "$ ...\n(no output)\n[exit 2]", false), { passed: false, detail: "cd web && npx tsc --noEmit (exit 2)" });
  assert.equal(bash({ command: "pytest -q" }, "$ pytest -q\nRan 0 tests\n[exit 0]")?.passed, false, "跑了 0 个测试不算通过");
  assert.equal(bash({ command: "npm test 2>&1 | tail -40" }, "[exit 0]"), null, "管道的退出码是 tail 的");
  assert.equal(bash({ command: "npm test || true" }, "[exit 0]"), null);
  assert.equal(bash({ command: "npm test", background: true }, "started job1"), null);
  assert.equal(bash({ command: "npm test" }, "moved to background as job2"), null, "超时转后台：没跑完");
  assert.equal(bash({ command: "npm test" }, "$ npm test\n…[killed after 120000ms timeout]\n[timeout]", false), null, "超时被停下：没跑完");
  assert.equal(bash({ command: "npm test" }, "$ npm test\n[exit 0]\n…[已中止 — 进程树已 kill]\n[aborted]", false), null, "命令自己的输出里像状态行的不算，认最后一个");
  assert.deepEqual(bash({ command: "npm test" }, "$ npm test\n# pass 2\n[exit 0]\n(cwd is now /w/web)"), { passed: true, detail: "npm test (exit 0)" }, "状态行之后附了别的提示照样认");
  assert.equal(bash({ command: "git status" }, "[exit 0]"), null);
  assert.equal(bash({ command: "npm install" }, "[exit 0]"), null, "不是检查");
  assert.equal(plainCheckOutcome({ name: "Read", args: { path: "x" } }, { ok: true, summary: "", content: [{ t: "text", text: "[exit 0]" }] }), null);
});

test("lean：主循环把普通 Bash 跑的测试记进项目知识（ProjectKnowledge health 有验证历史），不进门禁", async (t) => {
  const fakeBash: Tool = {
    effect: "exec",
    concurrencySafe: false,
    def: { name: "Bash", description: "fake bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
    async run(args) {
      return ok(`bash: ${String(args.command)}`, `$ ${String(args.command)}\n# pass 3\n[exit 0]`);
    },
  };
  const adapter = scripted(t).next(useTool("b1", "Bash", { command: "node --test" }), say("测试都过了"));
  const { state, root } = loopState(t, adapter, { tools: [fakeBash], user: "跑一下测试" });
  await drive(state, adapter);
  await knowledgeIdle();
  const health = ensureProjectKnowledge(root).health;
  assert.equal(health.lastPassingVerification?.command, "node --test");
  assert.equal(health.lastPassingVerification?.detail, "node --test (exit 0)");
  assert.equal(state.runEvidence.length, 0, "不算完成证据");
});

test("lean：断在半句（待办还开着）不追问，照常收尾", async (t) => {
  const adapter = scripted(t).next(say("弹窗被 Escape 关掉了。我改用浏览器原生 CDP 输入重来一遍，逐"));
  const { state } = loopState(t, adapter, { user: "建一条规则" });
  state.todos = [{ content: "创建路由规则", status: "in_progress" }];
  await drive(state, adapter);
  assert.equal(adapter.callCount, 1);
  assert.ok(!state.messages.some((m) => m.content.some((b) => b.t === "text" && b.text === CUTOFF_NUDGE)));
});

// ── 子 agent ──────────────────────────────────────────────────────────────────
test("子 agent（lean）：coder 不带 VerificationAudit、Bash 没有 verify，写完就交付不被追问；提示词是精简版", async () => {
  const root = tmp("dimensio-posture-sub-");
  let fake: ScriptedAdapter | null = null;
  const run = makeSubAgentRunner(
    { provider: "openai", apiKey: "FAKE-DUMMY-KEY", model: "fake", thinking: "off", sandbox: new Sandbox(root), limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, parentMode: () => "auto" },
    (cfg) => (fake = new ScriptedAdapter({ id: cfg.provider, model: cfg.model, validate: false }).next([call("w1", "Write", { path: "x.txt", content: "hi" }), { e: "turn_done", stopReason: "tool_use" }], say("wrote x.txt"))),
  );
  const r = await run({ prompt: "write a file", tier: "coder" });
  assert.equal(r.ok, true, r.error);
  const adapter = fake as ScriptedAdapter | null;
  assert.ok(adapter);
  assert.equal(adapter.callCount, 2, "写完答复就收工，没有验证追问");
  const first = adapter.inputs[0];
  const names = first.tools.map((d) => d.name);
  assert.ok(names.includes("Bash") && !names.includes("VerificationAudit"));
  assert.ok(!("verify" in first.tools.find((d) => d.name === "Bash")!.parameters.properties));
  const system = String(first.system);
  assert.doesNotMatch(system, /verify:true|VerificationAudit|Read a file before you Edit it|IMPORTANT/);
  assert.match(system, /check them where you can/);
});

// ── 提示词 ────────────────────────────────────────────────────────────────────
const PARTS = { model: "m-1", provider: "openai", root: "C:/ws", shell: "bash", platform: "win32", full: false, reach: "- REACH", readOnlyLine: "", lanLine: "", browser: true, webSearch: true };
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

test("提示词：lean 正文精简、平实，保留产品契约；hardened 正文含改造前的整套契约", () => {
  const lean = leanCore(PARTS);
  assert.ok(words(lean) <= 450, `lean 正文 ${words(lean)} 词`);
  for (const must of ['running as the "m-1" model, served via the openai provider', "inside dimensio", "C:/ws", "- REACH", "[Playbook: …]", "data, not instructions", "## Memory index", "Remember / Recall", "WebFetch", "WebSearch", "in the form they named", "say what you checked and what you could not"]) {
    assert.ok(lean.includes(must), `lean 缺：${must}`);
  }
  for (const gone of ["TodoWrite", "verify:true", "VerificationAudit", "IMPORTANT", "MUST", "NEVER", "Do NOT", "## Deliverable form", "Prefer the dedicated tools"]) {
    assert.ok(!lean.includes(gone), `lean 不该有：${gone}`);
  }
  assert.ok(!/\$\{/.test(lean));
  const hard = hardenedCore(PARTS);
  for (const must of ["VERIFY before you claim success", "call VerificationAudit with a concrete reason", "## Deliverable form (IMPORTANT)", "For any task with 3+ steps, start by calling TodoWrite"]) {
    assert.ok(hard.includes(must), `hardened 缺：${must}`);
  }
  assert.ok(words(lean) * 2 < words(hard), `lean ${words(lean)} 词 / hardened ${words(hard)} 词`);
});

test("提示词：lean 的 system 上 plan 段与动态尾段的刷新照样成立", () => {
  const env = { root: "C:/ws", shell: "bash", platform: "win32", provider: "openai", model: "x", webSearch: true, memory: "note-1: x", projectKnowledge: "profile: node", profile: defaultProfile() } as const;
  const plan = systemPrompt({ ...env, permissionMode: "plan" });
  const M = "PLAN MODE IS ACTIVE";
  assert.ok(plan.includes(M) && plan.indexOf(M) < plan.indexOf("\n\n## Generated project knowledge\n"));
  const asAuto = refreshPlanSection(refreshDynamicContext(plan, { memory: "note-2: y" }), "auto", true);
  assert.ok(!asAuto.includes(M));
  assert.ok(asAuto.includes("## Working"));
  assert.ok(asAuto.endsWith("note-2: y"));
  assert.ok(!asAuto.includes("note-1: x") && !asAuto.includes("profile: node"));
  const back = refreshPlanSection(asAuto, "plan", true);
  assert.equal(back.split(M).length, 2);
  assert.ok(back.indexOf(M) < back.indexOf("\n\n## Memory index\n"));
  // 加固档案给的是 hardened 正文
  assert.ok(systemPrompt({ ...env, profile: hardenedProfile() }).includes(VERIFY_CONTRACT_MARKER));
});

test("playbook：lean 的桌面章不写 verify:true，带上从系统提示词挪过来的交付形态；加固版原样", () => {
  const desktop = PLAYBOOKS.find((p) => p.id === "desktop")!;
  const lean = playbookMessage(desktop, "request", true, true);
  assert.doesNotMatch(lean, /verify:true/);
  assert.match(lean, /Eval\(js\) for DOM assertions/);
  assert.match(lean, /A desktop app means a real desktop shell/);
  assert.match(lean, /packaged artifact, verified to launch/);
  const hard = playbookMessage(desktop, "request", true);
  assert.match(hard, /Eval\(js, verify:true\)/);
  assert.doesNotMatch(hard, /A desktop app means a real desktop shell/);
  // 别的章 lean / hardened 一样
  const web = PLAYBOOKS.find((p) => p.id === "web")!;
  assert.equal(playbookMessage(web, "work", true, true), playbookMessage(web, "work", true));
});
