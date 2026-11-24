// 模型档案（agent/profile.ts）P0：家族识别、智力分档（评分模块缺席 / 测试替身两种）、loop 默认值等于原模块常量、
// 各挂点真的读档案（改档案就改行为，档案不变就和接入前一样）。逐字节不变的总锁在 model-profile-golden.test.ts。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";
import {
  defaultLoopProfile,
  defaultProfile,
  hardenedProfile,
  familyKey,
  FAMILY_OVERRIDES,
  MODEL_FAMILIES,
  profileProviderExtras,
  resolveFamily,
  resolveProfile,
  resolveTier,
  setRatingsForTests,
  type ModelFamily,
  type ModelProfile,
  type RatingsApi,
} from "./agent/profile.ts";
import {
  DENIALS_BEFORE_STOP,
  EMPTY_RESPONSE_RETRIES,
  MAX_ANSWER_NUDGES,
  MAX_CUTOFF_NUDGES,
  MAX_LENGTH_CONTINUES,
  MAX_PARALLEL_TOOLS,
  RETRY_ATTEMPTS,
} from "./agent/loop.ts";
import { TODO_REMIND_TURNS } from "./agent/loop/limits.ts";
import { GUARD_DEFAULTS, LoopGuard } from "./agent/loop-guard.ts";
import { isRunawayRepetition, REPETITION_DEFAULTS } from "./agent/repetition.ts";
import { SUBMIT_ATTEMPTS, SUBMIT_NUDGES } from "./agent/subagent.ts";
import { SUMMARY_BUDGET } from "./agent/context.ts";
import { DEFERRED_FAMILIES, deferToolDefs, HARDENED_DEFERRED_FAMILIES, notLoadedResult } from "./agent/deferred-tools.ts";
import { AgentState } from "./agent/state.ts";
import { CATALOG } from "./catalog.ts";
import { Sandbox } from "./sandbox.ts";
import { calls, call, say, scripted, ScriptedAdapter } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { ok, type Tool } from "./tools/types.ts";
import type { ToolDef } from "./agent/turn.ts";

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
afterEach(() => setRatingsForTests(undefined));

// ── loop 默认值 = 原常量 ───────────────────────────────────────────────────────
test("加固档案的 loop 逐项等于各模块原来的常量（也等于姿态改造前的字面值）；lean 只在门禁 / 追问 / 提醒几项上不同", () => {
  const loop = hardenedProfile().loop;
  assert.deepEqual(loop, {
    maxAnswerNudges: MAX_ANSWER_NUDGES,
    maxCutoffNudges: MAX_CUTOFF_NUDGES,
    lengthContinues: MAX_LENGTH_CONTINUES,
    emptyResponseRetries: EMPTY_RESPONSE_RETRIES,
    retryAttempts: RETRY_ATTEMPTS,
    maxParallelTools: MAX_PARALLEL_TOOLS,
    denialsBeforeStop: DENIALS_BEFORE_STOP,
    guard: { ...GUARD_DEFAULTS, sameArgsFail: { ...GUARD_DEFAULTS.sameArgsFail }, sameToolFail: { ...GUARD_DEFAULTS.sameToolFail } },
    repetition: { ...REPETITION_DEFAULTS },
    submitAttempts: SUBMIT_ATTEMPTS,
    submitNudges: SUBMIT_NUDGES,
    noopBashResample: false,
    stopWhenAttended: false,
    verifyGate: "on",
    todoReminderEvery: TODO_REMIND_TURNS,
    todoReminderOnlyIncomplete: true,
    thinkingOnly: "nudge",
    verifyFootnote: "on",
  });
  // 字面值：常量本身被人改了也要红（那是行为变化，得有意为之）
  assert.deepEqual(loop, {
    maxAnswerNudges: 1,
    maxCutoffNudges: 2,
    lengthContinues: 3,
    emptyResponseRetries: 1,
    retryAttempts: 10,
    maxParallelTools: 8,
    denialsBeforeStop: 3,
    guard: { repeatStop: 12, repeatStopEvery: 4, sameArgsFail: { note: 2, stop: 5 }, sameToolFail: { note: 3, stop: 8 }, cycleStop: 3, history: 24 },
    repetition: { minChars: 400, window: 60, scanTail: 200_000, looseCoverage: 0.5, strictDistinctLines: 0.5, strictShortCoverage: 0.8 },
    submitAttempts: 3,
    submitNudges: 2,
    noopBashResample: false,
    stopWhenAttended: false,
    verifyGate: "on",
    todoReminderEvery: 5,
    todoReminderOnlyIncomplete: true,
    thinkingOnly: "nudge",
    verifyFootnote: "on",
  });
  // lean（默认）：不撤回不追问补验证、半句停下不追问、不提醒待办、只思考就原样重发、不附验证尾注；其余（含被截断的续写）照旧
  assert.deepEqual(defaultLoopProfile(), {
    ...loop,
    maxCutoffNudges: 0,
    verifyGate: "off",
    todoReminderEvery: 0,
    thinkingOnly: "retry",
    verifyFootnote: "off",
  });
});

test("默认档案（lean）的其余各块：提示词 default、工具不裁且不带验证形状、不发采样参数、不挂 providerExtras、摘要 inline（跟主请求同档思考，输出基准 8000）", () => {
  const p = defaultProfile();
  assert.equal(p.posture, "lean");
  assert.deepEqual(p.prompt, { variant: "default", patches: [] });
  assert.equal(p.tools.editFormat, "str_replace");
  assert.equal(p.tools.deferredFamilies, DEFERRED_FAMILIES);
  assert.equal(p.tools.subset, null);
  assert.deepEqual(p.tools.pathAliases, {});
  assert.equal(p.tools.verifyContract, "lenient");
  assert.equal(p.tools.readBeforeEdit, "off");
  assert.equal(p.tools.verifyTools, "off");
  assert.deepEqual(p.sampling, {});
  assert.deepEqual(p.providerExtras, {});
  assert.equal(profileProviderExtras(p), undefined);
  assert.deepEqual(p.side.summary, { ...SUMMARY_BUDGET });
  assert.deepEqual(p.side.summary, { mode: "inline", maxOutputTokens: 8000, thinking: "inherit" });
  assert.deepEqual(p.tier, { ii: null, subs: {}, derived: false, source: "none", conservative: false });
  assert.equal(p.tools.readBeforeWrite, "any");
  // 加固档案的工具契约 = 改造前的现状（Write 读全才许覆盖、推迟回到改造前的五族）；压缩摘要走旁路（集成时定：弱模型不接着原对话写摘要）
  const h = hardenedProfile();
  assert.equal(h.posture, "hardened");
  assert.deepEqual(
    { verifyContract: h.tools.verifyContract, readBeforeEdit: h.tools.readBeforeEdit, verifyTools: h.tools.verifyTools, readBeforeWrite: h.tools.readBeforeWrite },
    { verifyContract: "strict", readBeforeEdit: "strict", verifyTools: "on", readBeforeWrite: "full" },
  );
  assert.deepEqual(h.tools.deferredFamilies, HARDENED_DEFERRED_FAMILIES);
  assert.deepEqual(h.side.summary, { ...SUMMARY_BUDGET, mode: "sidecar" });
  // 每轮自动召回：lean 关（记忆索引常驻 system），hardened 照旧开
  assert.deepEqual(p.memory, { autoRecall: false });
  assert.deepEqual(h.memory, { autoRecall: true });
  const { posture: _p, postureReason: _r, tools: _t, loop: _l, side: _s, memory: _m, ...restH } = h;
  const { posture: _p2, postureReason: _r2, tools: _t2, loop: _l2, side: _s2, memory: _m2, ...restL } = p;
  assert.deepEqual(restH, restL);
});

test("家族覆盖表为空；没有评分时目录里每个型号都是 lean，档案（除家族与分档）等于默认档案", () => {
  assert.deepEqual(FAMILY_OVERRIDES, {});
  setRatingsForTests(null);
  const strip = (p: ModelProfile) => {
    const { family: _f, familySource: _s, tier: _t, postureReason: _r, ...rest } = p;
    return rest;
  };
  const base = strip(defaultProfile());
  for (const spec of CATALOG) {
    for (const m of spec.models) {
      const p = resolveProfile(spec.id, m.id);
      assert.deepEqual(strip(p), base, `${spec.id}/${m.id}`);
      assert.equal(p.postureReason, "no rating");
    }
  }
});

test("每次解析给一份新对象：改一个会话的档案不串到别的会话", () => {
  const a = resolveProfile("openai", "deepseek-flash");
  a.loop.guard.sameArgsFail.stop = 99;
  (a.providerExtras as Record<string, unknown>).x = 1;
  const b = resolveProfile("openai", "deepseek-flash");
  assert.equal(b.loop.guard.sameArgsFail.stop, 5);
  assert.deepEqual(b.providerExtras, {});
  assert.equal(GUARD_DEFAULTS.sameArgsFail.stop, 5);
});

// ── 家族识别 ──────────────────────────────────────────────────────────────────
const FAMILY_TABLE: [provider: string, model: string, family: ModelFamily][] = [
  // DeepSeek（内置厂商 id 叫 openai）
  ["openai", "deepseek-v4-1-flash", "deepseek"],
  ["openai", "deepseek-flash", "deepseek"],
  ["openai", "deepseek-v4-pro", "deepseek"],
  ["custom-0a1b2c3d", "deepseek/deepseek-v4-flash", "deepseek"],
  // Qwen：本机 27B、自定义 fp8、Strata 各变体、官方
  ["local", "qwen3.8-27b", "qwen"],
  ["custom-0a1b2c3d", "qwen3.8-flash-next-fp8", "qwen"],
  ["local", "strata-flash-iq3s", "qwen"],
  ["local", "strata-orca", "qwen"],
  ["local", "strata-orca-iq3xxs", "qwen"],
  ["local", "strata-flash-nvfp4", "qwen"],
  ["qwen", "qwen3.8-max", "qwen"],
  ["qwen", "qwen3.7-plus", "qwen"],
  ["custom-0a1b2c3d", "Qwen/Qwen3.8-27B", "qwen"],
  // Claude（含中转去掉 claude- 前缀的写法）
  ["anthropic", "claude-opus-5-5", "claude"],
  ["custom-0a1b2c3d", "opus-5-5", "claude"],
  ["custom-0a1b2c3d", "anthropic/claude-sonnet-5-5", "claude"],
  ["anthropic", "claude-haiku-4-5", "claude"],
  // 其余各家
  ["zhipu", "glm-5.3", "glm"],
  ["custom-0a1b2c3d", "z-ai/glm-5.3", "glm"],
  ["mimo", "mimo-v2.6-pro", "mimo"],
  ["kimi", "k3", "kimi"],
  ["kimi", "k3-256k", "kimi"],
  ["kimi", "kimi-for-coding", "kimi"],
  ["custom-0a1b2c3d", "moonshotai/kimi-k3", "kimi"],
  ["custom-0a1b2c3d", "step-5", "step"],
  ["custom-0a1b2c3d", "stepfun/step-5", "step"],
  ["custom-0a1b2c3d", "hunyuan-t2", "hunyuan"],
  ["custom-0a1b2c3d", "hy3", "hunyuan"],
  ["custom-0a1b2c3d", "gpt-6-astra", "gpt"],
  ["custom-0a1b2c3d", "openai/gpt-6-astra", "gpt"],
  ["custom-0a1b2c3d", "o3-mini", "gpt"],
  ["gemini", "gemini-4-argon", "gemini"],
  ["custom-0a1b2c3d", "google/gemini-3.5-flash", "gemini"],
  ["custom-0a1b2c3d", "minimax-m3.1", "minimax"],
  ["custom-0a1b2c3d", "MiniMax/MiniMax-M3.1", "minimax"],
  ["custom-0a1b2c3d", "grok-4.7", "grok"],
  ["custom-0a1b2c3d", "x-ai/grok-4.7", "grok"],
  ["custom-0a1b2c3d", "muse-wonder", "muse"],
  ["custom-0a1b2c3d", "meta/muse-spark", "muse"],
  // 前缀写法：「custom:<服务>:型号」「厂商:型号」、[1m]、:tag
  ["custom-0a1b2c3d", "custom:my-svc:qwen3.8-flash-next-fp8", "qwen"],
  ["anthropic", "anthropic:claude-opus-5-5", "claude"],
  ["anthropic", "claude-opus-5-5[1m]", "claude"],
  // Bedrock 写法：区域.厂商.型号-版本:修订
  ["custom-0a1b2c3d", "us.anthropic.claude-opus-5-5-v1:0", "claude"],
  ["custom-0a1b2c3d", "anthropic.claude-haiku-5-v1:0", "claude"],
  ["custom-0a1b2c3d", "global.openai.gpt-6-astra-v1:0", "gpt"],
  ["custom-0a1b2c3d", "deepseek.v4-1-flash-v1:0", "deepseek"],
  ["custom-0a1b2c3d", "qwen3:8b", "qwen"],
  // 认不出的
  ["custom-0a1b2c3d", "llama-4-maverick", "unknown"],
  ["custom-0a1b2c3d", "mistral-large-3", "unknown"],
  ["custom-0a1b2c3d", "my-model", "unknown"],
  ["custom-0a1b2c3d", "orca-mini", "unknown"],
  ["custom-0a1b2c3d", "stepper-2", "unknown"],
  ["custom-0a1b2c3d", "museum-bot", "unknown"],
  // Gemma 不归 Gemini（以后 Gemini 的覆盖不该套到经兼容端点跑的 Gemma 上）
  ["custom-0a1b2c3d", "gemma-4-27b-it", "unknown"],
  ["custom-0a1b2c3d", "google/gemma-4-12b", "unknown"],
  ["custom-0a1b2c3d", "", "unknown"],
  ["local", "some-local-gguf", "unknown"],
];

test("家族识别：13 家真实型号名 + 认不出的", () => {
  const wrong: string[] = [];
  for (const [provider, model, want] of FAMILY_TABLE) {
    const got = resolveFamily(provider, model).family;
    if (got !== want) wrong.push(`${provider}/${model}: ${got} ≠ ${want}`);
  }
  assert.deepEqual(wrong, []);
  // 13 家都覆盖到了
  const covered = new Set(FAMILY_TABLE.map(([, , f]) => f));
  for (const f of MODEL_FAMILIES) assert.ok(covered.has(f), `测试表没覆盖 ${f}`);
});

test("家族识别的依据：型号名 → 显示名 → 内置厂商 id → 认不出", () => {
  assert.deepEqual(resolveFamily("openai", "deepseek-flash"), { family: "deepseek", familySource: "name" });
  // 自定义服务的型号 id 认不出，显示名认得出
  assert.deepEqual(resolveFamily("custom-0a1b2c3d", "my-endpoint", { label: "Qwen3.8 Flash Next FP8" }), { family: "qwen", familySource: "label" });
  // 内置厂商的别名型号：按厂商 id（DeepSeek 的厂商 id 是 openai）
  assert.deepEqual(resolveFamily("openai", "some-alias"), { family: "deepseek", familySource: "provider" });
  assert.deepEqual(resolveFamily("kimi", "preview-x"), { family: "kimi", familySource: "provider" });
  // 本机跑什么都有可能，不按厂商 id 认
  assert.deepEqual(resolveFamily("local", "some-local-gguf"), { family: "unknown", familySource: "none" });
});

test("目录里每个内置型号都认得出家族（新上架的认不出就得补规则）", () => {
  const unknown: string[] = [];
  for (const spec of CATALOG) for (const m of spec.models) if (resolveFamily(spec.id, m.id).family === "unknown") unknown.push(`${spec.id}/${m.id}`);
  assert.deepEqual(unknown, []);
});

test("familyKey：去前缀、去 vendor/、去 [1m] 与 :tag", () => {
  assert.equal(familyKey("custom:svc:Qwen3.8-Flash-Next-FP8"), "qwen3.8-flash-next-fp8");
  assert.equal(familyKey("accounts/fireworks/models/glm-5.3"), "glm-5.3");
  assert.equal(familyKey("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(familyKey("qwen3:8b"), "qwen3");
  assert.equal(familyKey(undefined), "");
  assert.equal(familyKey("us.anthropic.claude-opus-5-5-v1:0"), "claude-opus-5-5-v1");
  assert.equal(familyKey("qwen3.8-27b"), "qwen3.8-27b", "qwen3. 不是 Bedrock 前缀");
});

test("家族覆盖表：数组 / 对象克隆进档案，改档案不会改到覆盖表", () => {
  FAMILY_OVERRIDES.qwen = { prompt: { patches: ["p1"] }, tools: { pathAliases: { a: "b" } } };
  try {
    const p = resolveProfile("custom-0a1b2c3d", "qwen3.8-27b");
    assert.deepEqual(p.prompt.patches, ["p1"]);
    (p.prompt.patches as string[]).push("p2");
    (p.tools.pathAliases as Record<string, string>).c = "d";
    assert.deepEqual(FAMILY_OVERRIDES.qwen.prompt?.patches, ["p1"]);
    assert.deepEqual(FAMILY_OVERRIDES.qwen.tools?.pathAliases, { a: "b" });
    assert.deepEqual(resolveProfile("custom-0a1b2c3d", "qwen3.8-27b").prompt.patches, ["p1"]);
    // 别的家族不受影响
    assert.deepEqual(resolveProfile("anthropic", "claude-opus-5-5").prompt.patches, []);
  } finally {
    delete FAMILY_OVERRIDES.qwen;
  }
});

// ── 智力分档 ──────────────────────────────────────────────────────────────────
// 共享接口约定（src/model-knowledge/ratings.mjs）的测试替身：精确匹配 + 别名表，量化版标 derived
function fakeRatings(): RatingsApi {
  const ALIASES: Record<string, string> = {
    "strata-flash-iq3s": "qwen3-8-flash-next",
    "strata-orca": "qwen3-8-flash-next",
    "qwen3-8-flash-next-fp8": "qwen3-8-flash-next",
    "qwen3-8-27b": "qwen3-8-27b",
    "deepseek-flash": "deepseek-v4-1-flash",
  };
  const DERIVED = new Set(["strata-flash-iq3s", "strata-orca", "qwen3-8-flash-next-fp8"]);
  const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[._\s/]+/g, "-");
  type Row = { slug: string; base: string; effort: string; ii: number; subs?: Record<string, number> };
  return {
    loadRatings(j) {
      const rows = (j as { models: Row[] }).models;
      return rows.length ? { rows } : null;
    },
    lookupRating(index, id, opts = {}) {
      const rows = (index as { rows: Row[] }).rows;
      const k = norm(id);
      const base = ALIASES[k] ?? k;
      const fam = rows.filter((r) => r.base === base);
      if (!fam.length) return null;
      const r = fam.find((x) => x.effort === opts.effort) ?? [...fam].sort((a, b) => b.ii - a.ii)[0];
      return { slug: r.slug, ii: r.ii, subs: r.subs ?? {}, version: "v5.0", ...(DERIVED.has(k) ? { derived: true } : {}) };
    },
    ratingsSummary() {
      return { median: 31, p25: 20, p75: 45, count: 6, version: "v5.0", allEfforts: { median: 29, count: 9 }, bestPerFamily: { median: 31, count: 6 } };
    },
  };
}
const SNAPSHOT = {
  models: [
    { slug: "claude-opus-5-5-max", base: "claude-opus-5-5", effort: "max", ii: 58.4, subs: { tb40: 61.2, ifbench: 70.1 } },
    { slug: "claude-opus-5-5-low", base: "claude-opus-5-5", effort: "low", ii: 44.0 },
    { slug: "qwen3-8-flash-next", base: "qwen3-8-flash-next", effort: "", ii: 40 },
    { slug: "qwen3-8-27b", base: "qwen3-8-27b", effort: "", ii: 18 },
    { slug: "qwen3-8-max", base: "qwen3-8-max", effort: "", ii: 50 },
    { slug: "deepseek-v4-1-flash", base: "deepseek-v4-1-flash", effort: "", ii: 47 },
  ],
};

test("分档：命中快照取 AA 分与分项；按档位取那一档", () => {
  setRatingsForTests(fakeRatings(), SNAPSHOT);
  const t = resolveTier("anthropic", "claude-opus-5-5", "claude", { effort: "max" });
  assert.equal(t.source, "aa");
  assert.equal(t.ii, 58.4);
  assert.deepEqual(t.subs, { tb40: 61.2, ifbench: 70.1 });
  assert.equal(t.conservative, false);
  assert.equal(t.derived, false);
  assert.equal(resolveTier("anthropic", "claude-opus-5-5", "claude", { effort: "low" }).ii, 44.0);
});

test("分档：本机量化版 / fp8 映射到全精度条目，标 derived", () => {
  setRatingsForTests(fakeRatings(), SNAPSHOT);
  const t = resolveProfile("local", "strata-flash-iq3s").tier;
  assert.equal(t.source, "aa");
  assert.equal(t.ii, 40);
  assert.equal(t.derived, true);
  assert.equal(resolveProfile("custom-0a1b2c3d", "qwen3.8-flash-next-fp8").tier.derived, true);
});

test("分档：型号 id 查不到时拿显示名再查一次；只传约定内的 provider / effort", () => {
  const seen: Record<string, unknown>[] = [];
  const base = fakeRatings();
  const spy: RatingsApi = { ...base, lookupRating(index, id, opts) { seen.push({ ...(opts ?? {}) }); return base.lookupRating(index, id, opts); } };
  setRatingsForTests(spy, SNAPSHOT);
  const t = resolveProfile("custom-0a1b2c3d", "my-endpoint", { label: "Qwen3.8 Flash Next FP8" }).tier;
  assert.equal(t.source, "aa");
  assert.equal(t.ii, 40);
  assert.equal(t.derived, true);
  for (const o of seen) for (const k of Object.keys(o)) assert.ok(k === "provider" || k === "effort", `约定外的参数 ${k}`);
});

test("分档：认不出的型号先按同族中位，推不出再取全库中位（取低的口径），都标 conservative", () => {
  setRatingsForTests(fakeRatings(), SNAPSHOT);
  const fam = resolveProfile("custom-0a1b2c3d", "qwen3.8-mystery-9b").tier;
  assert.equal(fam.source, "median-fallback");
  assert.equal(fam.basis, "family");
  assert.equal(fam.conservative, true);
  // 目录里 qwen 家族有评分的：qwen3.8-max 50、qwen3.8-27b 18、strata-orca 40（→ qwen3-8-flash-next）
  assert.equal(fam.ii, 40);
  const glob = resolveProfile("custom-0a1b2c3d", "llama-4-maverick").tier;
  assert.equal(glob.source, "median-fallback");
  assert.equal(glob.basis, "global");
  assert.equal(glob.ii, 29, "allEfforts 29 与 bestPerFamily 31 取低的");
  assert.equal(glob.conservative, true);
});

test("分档：评分模块或快照缺了、实现抛错——source none，不报错", () => {
  setRatingsForTests(null);
  assert.deepEqual(resolveProfile("anthropic", "claude-opus-5-5").tier, { ii: null, subs: {}, derived: false, source: "none", conservative: false });
  const broken: RatingsApi = { ...fakeRatings(), lookupRating() { throw new Error("boom"); } };
  setRatingsForTests(broken, SNAPSHOT);
  assert.equal(resolveProfile("anthropic", "claude-opus-5-5").tier.source, "none");
  // 真去加载（这棵树里 ratings.mjs 可能还没合进来）：怎样都不抛
  setRatingsForTests(undefined);
  assert.ok(["aa", "median-fallback", "none"].includes(resolveProfile("anthropic", "claude-opus-5-5").tier.source));
});

// ── 挂点：档案真的被读 ─────────────────────────────────────────────────────────
function bareState(profile?: ModelProfile): AgentState {
  return new AgentState({
    adapter: new ScriptedAdapter(),
    system: "s",
    tools: [],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(tmp("dimensio-profile-state-")), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1, bashMaxTimeoutMs: 1 }, agentSeesImages: false },
    toolMap: new Map(),
    permissionMode: "auto",
    memoryAuditRequired: false,
    ...(profile ? { profile } : {}),
  });
}

test("AgentState：不给档案 = 现状档案；toTurn 只在 providerExtras 非空时挂 hints", () => {
  const plain = bareState();
  assert.deepEqual(plain.profile, defaultProfile());
  plain.addUserMessage("hi");
  assert.equal("hints" in plain.toTurn(), false, "空 providerExtras 不挂 hints（请求与接入前一样）");
  const extra = bareState({ ...defaultProfile(), providerExtras: { top_k: 20 } });
  extra.addUserMessage("hi");
  assert.deepEqual(extra.toTurn().hints, { providerExtras: { top_k: 20 } });
});

test("loop 读档案：maxParallelTools 改成 2，同时在跑的只读调用最多 2 个", async (t) => {
  let inFlight = 0;
  let peak = 0;
  const probe: Tool = {
    effect: "read",
    concurrencySafe: true,
    def: { name: "Probe", description: "probe", parameters: { type: "object", properties: { n: { type: "number" } } } },
    async run() {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return ok("probed", "probe");
    },
  };
  const adapter = scripted(t).next(calls(...Array.from({ length: 6 }, (_, i) => call(`p${i}`, "Probe", { n: i }))), say("完成"));
  const session = attachSession(adapter, tmp("dimensio-profile-par-"), { tools: [probe] });
  const p = defaultProfile();
  p.loop.maxParallelTools = 2;
  Object.assign(session.state!, { profile: p });
  await send(session, "探一下");
  assert.equal(peak, 2);
});

test("重复熔断读档案的阈值：同参失败 stop 改成 2，第 2 次就熔断", () => {
  const dflt = new LoopGuard();
  dflt.observe("Bash", { command: "x" }, false);
  assert.equal(dflt.observe("Bash", { command: "x" }, false).stop, undefined);
  const tight = new LoopGuard({ ...GUARD_DEFAULTS, sameArgsFail: { note: 2, stop: 2 } });
  tight.observe("Bash", { command: "x" }, false);
  assert.match(tight.observe("Bash", { command: "x" }, false).stop ?? "", /retried 2 times/);
  // 会话里的 loopGuard 按档案建（每条新的用户消息重建时也是）
  const p = defaultProfile();
  p.loop.guard.sameArgsFail = { note: 2, stop: 2 };
  const st = bareState(p);
  st.addUserMessage("go");
  st.loopGuard.observe("Bash", { command: "y" }, false);
  assert.ok(st.loopGuard.observe("Bash", { command: "y" }, false).stop);
});

test("复读检测读档案的阈值：minChars 调大，同一段循环就不算", () => {
  const loop = "the same sentence keeps coming back again and again and again. ".repeat(20);
  assert.equal(isRunawayRepetition(loop), true);
  assert.equal(isRunawayRepetition(loop, false, { ...REPETITION_DEFAULTS, minChars: 100_000 }), false);
});

test("延迟加载读档案的族表：换一套族表，推迟与按族展开都按它", () => {
  const def = (name: string): ToolDef => ({ name, description: `${name} does things. More text.`, parameters: { type: "object", properties: {} } });
  const defs = ["Read", "PullRequest", "Workspace", "Terminal"].map(def);
  const r = deferToolDefs(defs, [["PullRequest", "Workspace"]]);
  assert.deepEqual([...r.deferred.keys()], ["PullRequest", "Workspace"], "Terminal 不在这套族表里，不推迟");
  const res = notLoadedResult("PullRequest", r.deferred);
  assert.deepEqual(res.meta?.loadedTools, ["PullRequest", "Workspace"], "按这套族表整族展开");
  // 默认族表照旧
  assert.deepEqual([...deferToolDefs(defs).deferred.keys()], ["PullRequest", "Workspace", "Terminal"]);
});
