// dimensio 的子 agent 调用策略（agent/dispatch-policy.ts 取用 + agent/dispatch-ladder.ts 按策略选型）：
// 策略关 / 开与生效范围、判定线在 dimensio 候选上的选择、档位自定义的映射与失败回退、取不到策略时回到改造前的偏好、
// StartSession 的 auto:<档>、设置页预览的形状。快照一律用测试自己给的假数据；bridge 那一头用假的 fetch 顶替。
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLadder,
  dispatchSection,
  ladderPreview,
  loadRatings,
  routeSubAgentModel,
  setLocalReadyForTests,
  setRatingsForTests,
  type UsableModel,
} from "./agent/dispatch-ladder.ts";
import {
  cleanDispatchPolicy,
  currentDispatchPolicy,
  refreshDispatchPolicy,
  setDispatchFetchForTests,
  setDispatchPolicyForTests,
  type DimPolicy,
  type PolicyStrategy,
} from "./agent/dispatch-policy.ts";
import { modelSpec } from "./catalog.ts";
import { familyHooks, spawnChild, _resetFamily } from "./session-family.ts";
import type { RuntimeConfig } from "./config.ts";

const SNAP = {
  generated: "2026-11-01",
  models: [
    { slug: "claude-opus-5-5", base: "claude-opus-5-5", effort: "max", ii: 58.4, cost: 67.4, creator: "Anthropic" },
    { slug: "claude-opus-5-5-xhigh", base: "claude-opus-5-5", effort: "xhigh", ii: 57, cost: 40.6, creator: "Anthropic" },
    { slug: "claude-opus-5-5-high", base: "claude-opus-5-5", effort: "high", ii: 51.7, cost: 23.3, creator: "Anthropic" },
    { slug: "claude-haiku-5-5", base: "claude-haiku-5-5", effort: "max", ii: 36.2, cost: 2.76, creator: "Anthropic" },
    { slug: "claude-haiku-5-5-medium", base: "claude-haiku-5-5", effort: "medium", ii: 24.6, cost: 0.616, creator: "Anthropic" },
    { slug: "glm-5-3-flash", base: "glm-5-3-flash", effort: "", ii: 41.8, cost: 1.9, creator: "Zhipu" },
    { slug: "mimo-v2-6-flash", base: "mimo-v2-6-flash", effort: "", ii: 26.7, cost: 0.863, creator: "Xiaomi" },
    { slug: "kimi-k3", base: "kimi-k3", effort: "max", ii: 43.6, cost: 13.4, creator: "Moonshot" },
    { slug: "qwen3-8-flash-next", base: "qwen3-8-flash-next", effort: "", ii: 39.8, cost: 2.5, creator: "Alibaba" },
  ],
};

function usable(provider: string, model: string, billing: UsableModel["billing"] = "api"): UsableModel {
  const spec = modelSpec(provider as never, model);
  assert.ok(spec, `目录里没有 ${provider}/${model}`);
  return { provider: provider as never, providerName: provider, model, label: spec.label, efforts: spec.efforts, ctx: spec.ctx ?? 0, image: spec.image, billing };
}
const OPUS = usable("anthropic", "claude-opus-5-5");
const HAIKU = usable("anthropic", "claude-haiku-5-5");
const GLMF = usable("zhipu", "glm-5.3-flash");
const MIMOF = usable("mimo", "mimo-v2.6-flash");
const K3 = usable("kimi", "k3", "plan");
const MODELS = [OPUS, HAIKU, GLMF, MIMOF, K3];

const blank = (): PolicyStrategy => ({ floors: {}, overrides: {}, note: "" });
function policy(patch: Partial<DimPolicy> = {}, strategy: Partial<PolicyStrategy> = {}): DimPolicy {
  return {
    enabled: true, follow: true, scope: { workflow: true, subagent: true, session: false }, allowThirdParty: true,
    ...patch, strategy: { ...blank(), ...strategy },
  };
}
const at = (L: ReturnType<typeof buildLadder>, k: string) => L!.tiers.find((t) => t.key === k)!;
const PARENT = { provider: "openai" as const, model: "deepseek-flash" };

test.beforeEach(() => {
  setRatingsForTests(SNAP);
  setDispatchPolicyForTests(undefined);
  setDispatchFetchForTests(null);
});
test.after(() => {
  setRatingsForTests(undefined);
  setDispatchPolicyForTests(undefined);
  setDispatchFetchForTests(null);
  setLocalReadyForTests(null);
});

test("判定线在 dimensio 候选上：够线的里最便宜、同价取更贴近线的；够不着取最强并标 short；没调过 = 默认线", () => {
  const L = buildLadder(MODELS, undefined, { strategy: { ...blank(), floors: { top: 70, hard: 40, normal: null } } })!;
  // hard 40：Opus 三档、GLM-5.3 Flash 41.8（¥1.9）、K3 43.6（¥13.4）够线 → 最便宜的 GLM
  assert.deepEqual([at(L, "hard").pick.model, at(L, "hard").floor, at(L, "hard").source], ["glm-5.3-flash", 40, "chart"]);
  // top 70：谁都够不着 → 最强的 Opus 5.5 max，short
  assert.deepEqual([at(L, "top").pick.model, at(L, "top").pick.effort, at(L, "top").short], ["claude-opus-5-5", "max", true]);
  // normal 没调过：默认线 = 58.4 × 0.6 往上取一位 = 35.1，floorDefault 同值
  assert.deepEqual([at(L, "normal").floor, at(L, "normal").floorDefault], [35.1, 35.1]);
  // 不给策略 = 改造前的默认阶梯（hard 默认线 51.4 → Opus high）
  assert.deepEqual([at(buildLadder(MODELS), "hard").pick.model, at(buildLadder(MODELS), "hard").pick.effort], ["claude-opus-5-5", "high"]);
});

test("档位自定义：厂商 + 型号对上就用；Claude 别名映射来的不带厂商也认；档位没有对应格子借最近的档；映射不上 → 忽略、走判定线", () => {
  const L = buildLadder(MODELS, undefined, {
    strategy: {
      ...blank(),
      overrides: {
        light: { model: "claude-opus-5-5", effort: "high", ref: "opus" }, // Claude 那套的 opus → 型号 id，不指定厂商
        normal: { model: "glm-5.3-flash", provider: "zhipu", effort: "" }, // dimensio 自己那套：'' = 型号默认档
        hard: { model: "claude-haiku-5-5", effort: "high" }, // 快照里 Haiku 只有 max / medium：借 medium 的分数与成本，档位照指定的发
        top: { model: "gpt-9-ultra", effort: "max", ref: "custom:p-1234567890:gpt-9-ultra" }, // dimensio 里没有 → 忽略
      },
    },
  })!;
  assert.deepEqual([at(L, "light").pick.model, at(L, "light").pick.effort, at(L, "light").source], ["claude-opus-5-5", "high", "override"]);
  assert.deepEqual([at(L, "normal").pick.provider, at(L, "normal").pick.model, at(L, "normal").source], ["zhipu", "glm-5.3-flash", "override"]);
  const hard = at(L, "hard");
  assert.deepEqual([hard.pick.model, hard.pick.effort, hard.pick.ii, hard.pick.est], ["claude-haiku-5-5", "high", 24.6, true]);
  const top = at(L, "top");
  assert.deepEqual([top.source, top.overrideSkipped, top.pick.model, top.pick.effort], ["chart", true, "claude-opus-5-5", "xhigh"]);
  // 指定的那家没有这个型号、别家有：落到别家（同一个型号）
  const L2 = buildLadder(MODELS, undefined, { strategy: { ...blank(), overrides: { light: { model: "claude-haiku-5-5", provider: "custom-1a2b3c4d", effort: "medium" } } } })!;
  assert.deepEqual([at(L2, "light").pick.provider, at(L2, "light").source], ["anthropic", "override"]);
});

test("不调用非 Claude 模型：候选只剩 Claude；点名第三方的档位自定义被忽略、回落判定线", () => {
  const L = buildLadder(MODELS, undefined, { allowThirdParty: false, strategy: { ...blank(), overrides: { normal: { model: "glm-5.3-flash", provider: "zhipu", effort: "" } } } })!;
  for (const c of L.candidates) assert.match(c.model, /^claude-/);
  assert.deepEqual([at(L, "normal").overrideSkipped, at(L, "normal").source], [true, "chart"]);
  // normal 默认线 35.1：Haiku max 36.2（¥2.76）最便宜
  assert.deepEqual([at(L, "normal").pick.model, at(L, "normal").pick.effort], ["claude-haiku-5-5", "max"]);
});

test("策略关 / 范围：总开关关 = 整段不出、auto 按改造前的默认；只勾普通子 agent = 只讲 Agent 工具、Workflow 明说照默认；备注压在最后", async () => {
  const off = policy({ enabled: false });
  assert.equal(dispatchSection({ policy: off, models: MODELS, tools: { agent: true, workflow: true, session: true } }), "");
  setDispatchPolicyForTests(off);
  // 改造前的默认：偏好 subagentLadder 默认开 → 默认阶梯（hard = Opus high）；StartSession 不解析 auto
  assert.deepEqual(await routeSubAgentModel("auto:hard", PARENT, MODELS), { provider: "anthropic", model: "claude-opus-5-5", thinking: "high", auto: "hard" });
  assert.deepEqual(await routeSubAgentModel("auto:hard", PARENT, MODELS, { via: "session" }), {});

  const only = policy({ scope: { workflow: false, subagent: true, session: false } }, { floors: { hard: 40 }, note: "审查一律用 Opus" });
  const s = dispatchSection({ policy: only, models: MODELS, tools: { agent: true, workflow: true, session: true } });
  assert.match(s, /^## Sub-agent models\nFor each sub-agent \(Agent tool\) pick/);
  assert.match(s, /Workflow agent\(\) sub-agents are outside the policy/);
  assert.doesNotMatch(s, /StartSession/);
  assert.match(s, /auto:hard = GLM-5\.3 Flash/);
  assert.match(s, /User's dispatch preference[^\n]*\n审查一律用 Opus$/);
  assert.ok(s.length < 2400, `这一段 ${s.length} 字符，超出前缀预算`);
  // 范围都没勾（或这个会话没有那几样工具）→ 不出
  assert.equal(dispatchSection({ policy: only, models: MODELS, tools: { agent: false, workflow: true, session: false } }), "");

  setDispatchPolicyForTests(only);
  // 勾了的路按策略（hard 40 → GLM），没勾的路按改造前的默认（Opus high）
  assert.deepEqual(await routeSubAgentModel("auto:hard", PARENT, MODELS, { via: "agent" }), { provider: "zhipu", model: "glm-5.3-flash", thinking: "high", auto: "hard" });
  assert.deepEqual(await routeSubAgentModel("auto:hard", PARENT, MODELS, { via: "workflow" }), { provider: "anthropic", model: "claude-opus-5-5", thinking: "high", auto: "hard" });
});

test("StartSession：session 范围开着才解析 auto:<档>（提示里多一句）；落到别家时子会话的厂商 / 型号 / 档位跟着换", async () => {
  const p = policy({ scope: { workflow: false, subagent: false, session: true } });
  const s = dispatchSection({ policy: p, models: MODELS, tools: { agent: true, workflow: false, session: true } });
  assert.match(s, /StartSession's model may be "auto:<tier>"/);
  assert.match(s, /Agent tool sub-agents are outside the policy/);
  setDispatchPolicyForTests(p);
  assert.deepEqual(await routeSubAgentModel("auto:light", PARENT, MODELS, { via: "session" }), { provider: "anthropic", model: "claude-haiku-5-5", thinking: "medium", auto: "light" });

  // 走一遍真的 spawnChild（建子会话那一步截下配置就停）：测试进程里只有本机模型能用，当它就绪
  setLocalReadyForTests(() => true);
  _resetFamily();
  const seen: RuntimeConfig[] = [];
  familyHooks.createChild = (cfg) => {
    seen.push(cfg);
    throw new Error("测试到这里为止");
  };
  try {
    const r = await spawnChild("parent-not-loaded", { title: "t", prompt: "p", model: "auto:light" });
    assert.equal(r.ok, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].provider, "local");
    // session 范围关掉：auto 不解析，沿用本会话（全局默认）的型号
    setDispatchPolicyForTests(policy({ scope: { workflow: true, subagent: true, session: false } }));
    await spawnChild("parent-not-loaded", { title: "t", prompt: "p", model: "auto:light" });
    assert.notEqual(seen[1].provider, "local");
  } finally {
    familyHooks.createChild = undefined;
    setLocalReadyForTests(null);
  }
});

test("取不到策略：不是 bridge 拉起的 / bridge 太旧（404）→ 照改造前的偏好；取到过之后一时连不上，沿用上一次的", async () => {
  // 没有通道：null，系统提示走老写法
  setDispatchFetchForTests(async () => new Response("{}", { status: 200 }));
  await refreshDispatchPolicy({ maxAgeMs: 0 });
  assert.equal(currentDispatchPolicy(), null);

  const prev = { api: process.env.BRIDGE_PLUGIN_API, secret: process.env.BRIDGE_PLUGIN_SECRET };
  process.env.BRIDGE_PLUGIN_API = "http://127.0.0.1:9";
  process.env.BRIDGE_PLUGIN_SECRET = "s".repeat(24);
  try {
    setDispatchFetchForTests(async () => new Response("not found", { status: 404 }));
    await refreshDispatchPolicy({ maxAgeMs: 0 });
    assert.equal(currentDispatchPolicy(), null);
    assert.match(dispatchSection({ ladder: true, text: "", models: MODELS }), /Ladder from the user's price\/performance data/);

    const bodies: Record<string, unknown>[] = [];
    const good = { enabled: true, follow: false, scope: { workflow: true, subagent: true, session: false }, allowThirdParty: true, strategy: { floors: { hard: 40 }, overrides: {}, note: "x" } };
    const SNAP2 = { ...SNAP, generated: "2026-11-12" };
    setDispatchFetchForTests(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, policy: good, chart: { key: "imported:1:2026-11-12", ratings: SNAP2 } });
    });
    await refreshDispatchPolicy({ maxAgeMs: 0 });
    assert.deepEqual(currentDispatchPolicy(), cleanDispatchPolicy(good));
    // 带去旧偏好（迁移用）与手里图谱的版本键
    assert.deepEqual(bodies[0], { chart: "", legacy: { ladder: true, note: "" } });
    // 导入的性价比图跟着来：不指定测试快照时就用它
    setRatingsForTests(undefined);
    assert.equal(loadRatings()?.generated, "2026-11-12");
    setRatingsForTests(SNAP);
    assert.deepEqual(await routeSubAgentModel("auto:hard", PARENT, MODELS), { provider: "zhipu", model: "glm-5.3-flash", thinking: "high", auto: "hard" });

    // 第二次带去的是手里那份图谱的版本键（对得上 bridge 就不再带全量）
    await refreshDispatchPolicy({ maxAgeMs: 0 });
    assert.equal(bodies[1].chart, "imported:1:2026-11-12");

    // bridge 正在重启：连不上、回 5xx → 沿用上一次取到的（不换规则、不冲系统提示前缀）
    setDispatchFetchForTests(async () => { throw new TypeError("fetch failed"); }, { keep: true });
    await refreshDispatchPolicy({ maxAgeMs: 0 });
    assert.deepEqual(currentDispatchPolicy(), cleanDispatchPolicy(good));
    setDispatchFetchForTests(async () => new Response("boom", { status: 502 }), { keep: true });
    await refreshDispatchPolicy({ maxAgeMs: 0 });
    assert.deepEqual(currentDispatchPolicy(), cleanDispatchPolicy(good));
    // 不认凭据了（账号停用 / 收回授权）：不是一时的，当没有
    setDispatchFetchForTests(async () => new Response("{}", { status: 403 }), { keep: true });
    await refreshDispatchPolicy({ maxAgeMs: 0 });
    assert.equal(currentDispatchPolicy(), null);
  } finally {
    if (prev.api === undefined) delete process.env.BRIDGE_PLUGIN_API;
    else process.env.BRIDGE_PLUGIN_API = prev.api;
    if (prev.secret === undefined) delete process.env.BRIDGE_PLUGIN_SECRET;
    else process.env.BRIDGE_PLUGIN_SECRET = prev.secret;
  }
});

test("设置页预览：型号写成「厂商:型号」、带判定线与来源；本机模型 0 元、basis local", async () => {
  setLocalReadyForTests(() => true);
  try {
    const STRATA = usable("local", "strata-orca", "local");
    const pv = await ladderPreview({ strategy: { ...blank(), floors: { hard: 40 }, overrides: { light: { model: "glm-5.3-flash", provider: "zhipu", effort: "" } } } }, [...MODELS, STRATA]);
    const hard = pv.tiers.find((t) => t.key === "hard")!;
    assert.deepEqual([hard.pick.model, hard.floor, hard.source], ["zhipu:glm-5.3-flash", 40, "chart"]);
    assert.equal(pv.tiers.find((t) => t.key === "light")!.source, "override");
    const local = pv.candidates.find((c) => c.model.startsWith("local:"))!;
    assert.deepEqual([local.cost, local.basis], [0, "local"]);
    assert.ok(pv.candidates.every((c) => /^[a-z][a-z0-9-]*:/.test(c.model)));
    assert.equal(pv.generated, "2026-11-01");
  } finally {
    setLocalReadyForTests(null);
  }
});
