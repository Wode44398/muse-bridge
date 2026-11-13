// 子 agent 选型阶梯（agent/dispatch-ladder.ts）：候选、四档、未评分规则、系统提示一段、auto:<档> 与「服务:型号」的派发。
// 快照一律用测试自己给的假数据（真快照随发版变，不能钉进断言）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLadder,
  candidates,
  dispatchSection,
  routeSubAgentModel,
  setLocalReadyForTests,
  setRatingsForTests,
  type UsableModel,
} from "./agent/dispatch-ladder.ts";
import { clampEffort, modelSpec } from "./catalog.ts";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import { Sandbox } from "./sandbox.ts";
import { setPrefs } from "./prefs.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";

const SNAP = {
  generated: "2026-11-01",
  models: [
    { slug: "claude-opus-5-5", base: "claude-opus-5-5", effort: "max", ii: 58.4, cost: 67.4, rel: "2026-09-22" },
    { slug: "claude-opus-5-5-xhigh", base: "claude-opus-5-5", effort: "xhigh", ii: 57, cost: 40.6, rel: "2026-09-22" },
    { slug: "claude-opus-5-5-high", base: "claude-opus-5-5", effort: "high", ii: 51.7, cost: 23.3, rel: "2026-09-22" },
    { slug: "claude-haiku-5-5", base: "claude-haiku-5-5", effort: "max", ii: 36.2, cost: 2.76, rel: "2026-10-07" },
    { slug: "claude-haiku-5-5-medium", base: "claude-haiku-5-5", effort: "medium", ii: 24.6, cost: 0.616, rel: "2026-10-07" },
    { slug: "glm-5-3-flash", base: "glm-5-3-flash", effort: "", ii: 41.8, cost: 1.9, rel: "2026-10-01" },
    { slug: "mimo-v2-6-flash", base: "mimo-v2-6-flash", effort: "", ii: 26.7, cost: 0.863, rel: "2026-09-01" },
    { slug: "kimi-k3", base: "kimi-k3", effort: "max", ii: 43.6, cost: 13.4, rel: "2026-09-01" },
    { slug: "qwen3-8-flash-next", base: "qwen3-8-flash-next", effort: "", ii: 39.8, cost: 2.5, rel: "2026-10-01" },
    // 档位不在型号菜单里的评分（Haiku 5.5 菜单有 xhigh，但 Sonnet 4.6 没有 xhigh）
    { slug: "claude-sonnet-4-6-xhigh", base: "claude-sonnet-4-6", effort: "xhigh", ii: 31, cost: 18, rel: "2026-05-01" },
    { slug: "claude-sonnet-4-6", base: "claude-sonnet-4-6", effort: "max", ii: 30.1, cost: 16.7, rel: "2026-05-01" },
  ],
};

// 目录里真实的型号（档位表取自 catalog，保证「发出去的档是菜单里有的」这条契约测的是真东西）
function usable(provider: string, model: string, billing: UsableModel["billing"] = "api"): UsableModel {
  const spec = modelSpec(provider as never, model);
  assert.ok(spec, `目录里没有 ${provider}/${model}`);
  return { provider: provider as never, providerName: provider, model, label: spec.label, efforts: spec.efforts, ctx: spec.ctx ?? 0, image: spec.image, billing };
}
const OPUS = usable("anthropic", "claude-opus-5-5");
const HAIKU = usable("anthropic", "claude-haiku-5-5");
const SONNET46 = usable("anthropic", "claude-sonnet-4-6");
const GLMF = usable("zhipu", "glm-5.3-flash");
const MIMOF = usable("mimo", "mimo-v2.6-flash");
const K3 = usable("kimi", "k3", "plan");
const K2 = usable("kimi", "kimi-for-coding", "plan"); // 快照里没有 → 未评分
const STRATA = usable("local", "strata-orca", "local");

test.beforeEach(() => setRatingsForTests(SNAP));
test.after(() => {
  setRatingsForTests(undefined);
  setLocalReadyForTests(null);
});

test("候选：只收型号菜单里真有的档，发出去的档原样过思考档契约；开 / 关式型号取最强一条、档位 = 开", () => {
  const { list, unrated } = candidates([OPUS, HAIKU, SONNET46, GLMF, MIMOF, K3, K2]);
  for (const c of list) {
    assert.ok(c.efforts.includes(c.effort), `${c.model} 的档 ${c.effort} 不在菜单里`);
    assert.equal(clampEffort(c.provider, c.model, c.effort), c.effort, `${c.model} · ${c.effort} 被契约改写了`);
  }
  // Sonnet 4.6 没有 xhigh：那条评分不进候选，max 那条进
  assert.deepEqual(list.filter((c) => c.model === "claude-sonnet-4-6").map((c) => c.effort), ["max"]);
  // MiMo 只有开 / 关：一条、档位是「开」(high)
  assert.deepEqual(list.filter((c) => c.model === "mimo-v2.6-flash").map((c) => c.effort), ["high"]);
  // k3 归一后对不上快照，靠别名 k3 → kimi-k3
  assert.ok(list.some((c) => c.model === "k3"));
  assert.deepEqual(unrated.map((m) => m.model), ["kimi-for-coding"]);
});

test("四档：门槛以上最便宜的当首选；备选优先别的模型族；未评分的永远不进档", () => {
  const L = buildLadder([OPUS, HAIKU, GLMF, MIMOF, K3, K2]);
  assert.ok(L);
  const at = (k: string) => L.tiers.find((t) => t.key === k)!;
  // top：最高分（58.4）−1.5 以内最便宜 = Opus 5.5 xhigh
  assert.deepEqual([at("top").pick.model, at("top").pick.effort], ["claude-opus-5-5", "xhigh"]);
  // hard：58.4×0.88 = 51.4 以上最便宜 = Opus 5.5 high
  assert.deepEqual([at("hard").pick.model, at("hard").pick.effort], ["claude-opus-5-5", "high"]);
  // normal：35 以上最便宜 = GLM-5.3 Flash
  assert.equal(at("normal").pick.model, "glm-5.3-flash");
  // light：23.4 以上最便宜 = Haiku 5.5 medium（¥0.616 < MiMo ¥0.863）
  assert.deepEqual([at("light").pick.model, at("light").pick.effort], ["claude-haiku-5-5", "medium"]);
  for (const t of L.tiers) {
    if (t.alt) assert.notEqual(t.alt.model, t.pick.model);
    assert.notEqual(t.pick.model, "kimi-for-coding");
    assert.notEqual(t.alt?.model, "kimi-for-coding");
  }
  assert.deepEqual(L.unrated.map((m) => m.model), ["kimi-for-coding"]);
});

test("本机模型记 0 元，但只在这一档没有云端模型够得着时才当首选", () => {
  const L = buildLadder([GLMF, MIMOF, STRATA])!;
  for (const t of L.tiers) assert.notEqual(t.pick.model, "strata-orca", `${t.key} 档首选成了本机`);
  assert.ok(L.tiers.some((t) => t.alt?.model === "strata-orca"), "本机模型应作为免费备选出现");
  const only = buildLadder([STRATA])!;
  assert.equal(only.tiers[0].pick.model, "strata-orca");
  assert.equal(only.tiers[0].pick.cost, 0);
});

test("系统提示一段：阶梯、auto 写法、未评分一行、调度偏好压在最后；开关关着又没写偏好 = 整段不出", () => {
  const s = dispatchSection({ ladder: true, text: "简单检索一律用 MiMo", models: [OPUS, HAIKU, GLMF, MIMOF, K2] });
  assert.match(s, /^## Sub-agent models\n/);
  for (const k of ["top", "hard", "normal", "light"]) assert.match(s, new RegExp(`auto:${k} = `));
  assert.match(s, /Unrated \(no data; only when named\): K2\.8 Preview \(kimi-for-coding\)/);
  assert.match(s, /User's dispatch preference[^\n]*\n简单检索一律用 MiMo$/);
  // 显示名给人看、id 只进调用：首选只写显示名
  assert.match(s, /auto:top = Opus 5\.5 · xhigh/);
  assert.ok(s.length < 2200, `这一段 ${s.length} 字符，超出前缀预算`);
  assert.equal(dispatchSection({ ladder: false, text: "", models: [OPUS] }), "");
  assert.equal(dispatchSection({ ladder: false, text: "审查用 Opus", models: [OPUS] }), "## Sub-agent models\nUser's dispatch preference (wins where it conflicts with the above):\n审查用 Opus");
});

test("没有快照 / 一个评上分的都没有：只给按难度定档的一句；auto 落到主会话自己的模型、档位按档换算并过契约", async () => {
  setRatingsForTests(null);
  const s = dispatchSection({ ladder: true, text: "", models: [OPUS, GLMF] });
  assert.match(s, /light \(search, reading, mechanical edits\) low/);
  assert.match(s, /Usable models \(no price\/performance data; only when named\): Opus 5\.5 \(claude-opus-5-5\), glm-5\.3-flash$/);
  // 显示名与 id 只差大小写 / 标点的只写 id
  // deepseek-flash 没有 medium：normal 档的 medium 向下取到 low
  const r = await routeSubAgentModel("auto:normal", { provider: "openai", model: "deepseek-flash" }, [OPUS]);
  assert.deepEqual(r, { provider: "openai", model: "deepseek-flash", thinking: "low", auto: "normal" });
  setRatingsForTests(SNAP);
  const r2 = await routeSubAgentModel("auto:hard", { provider: "openai", model: "deepseek-flash" }, [K2]);
  assert.deepEqual(r2, { provider: "openai", model: "deepseek-flash", thinking: "high", auto: "hard" });
});

test("派发：auto:<档> 换成首选的 provider / 型号 / 档位；「服务:型号」拆开；带冒号的裸型号原样", async () => {
  const parent = { provider: "openai" as const, model: "deepseek-flash" };
  const models = [OPUS, HAIKU, GLMF, MIMOF];
  assert.deepEqual(await routeSubAgentModel("auto:light", parent, models), { provider: "anthropic", model: "claude-haiku-5-5", thinking: "medium", auto: "light" });
  assert.deepEqual(await routeSubAgentModel("AUTO:Top", parent, models), { provider: "anthropic", model: "claude-opus-5-5", thinking: "xhigh", auto: "top" });
  assert.deepEqual(await routeSubAgentModel("zhipu:glm-5.3-flash", parent, models), { provider: "zhipu", model: "glm-5.3-flash" });
  // 旧 id 按目录别名认，派发时落到现行 id
  assert.deepEqual(await routeSubAgentModel("local:strata-orca", parent, models), { provider: "local", model: "strata-flash-iq3s" });
  assert.match(String((await routeSubAgentModel("zhipu:nope", parent, models) as { error?: string }).error), /no model "nope"/);
  assert.deepEqual(await routeSubAgentModel("llama3:8b", parent, models), {});
  assert.deepEqual(await routeSubAgentModel("glm-5.3-flash", parent, models), {});
  assert.deepEqual(await routeSubAgentModel(undefined, parent, models), {});
});

test("开关关掉：auto 不看阶梯，落到主会话模型 + 按档换算的档位", async () => {
  await setPrefs({ subagentLadder: false });
  try {
    const r = await routeSubAgentModel("auto:top", { provider: "anthropic", model: "claude-opus-5-5" }, [HAIKU]);
    assert.deepEqual(r, { provider: "anthropic", model: "claude-opus-5-5", thinking: "xhigh", auto: "top" });
  } finally {
    await setPrefs({ subagentLadder: null });
  }
});

test("子 agent 运行器：auto:<档> 在派发时落到具体型号与档位，压过调用方写的 effort", async (t) => {
  // 本机引擎当它就绪：真实的 usableModels() 里只有本机两个型号有 Key（测试进程删光了云端 Key）
  setLocalReadyForTests(() => true);
  try {
    const made: { provider: string; model: string }[] = [];
    const adapter = scripted(t, { id: "local", model: "strata-flash-iq3s" }).next(say("done"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-ladder-"));
    const run = makeSubAgentRunner(
      { provider: "openai", apiKey: "FAKE-KEY", model: "deepseek-flash", thinking: "off", sandbox: new Sandbox(root), limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 } },
      (cfg) => {
        made.push({ provider: cfg.provider, model: cfg.model });
        return adapter;
      },
    );
    const r = await run({ prompt: "x", model: "auto:hard", thinking: "max" });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual([r.provider, r.model], ["local", "strata-flash-iq3s"]);
    assert.deepEqual(made, [{ provider: "local", model: "strata-flash-iq3s" }]);
    // 快照里这一族只有一种配置（effort ""）→ 菜单默认档
    assert.equal(adapter.lastInput().budget.thinking, modelSpec("local", "strata-orca")!.defaultEffort);
  } finally {
    setLocalReadyForTests(null);
  }
});

test("旧版指数的评分（old）不进候选：Strata / K3 只有旧分时按未评分处理；qwen3.8-max 落到 v5 那条而不是 0803 旧条目", () => {
  setRatingsForTests({
    generated: "2026-11-07",
    index: "v5.0",
    models: [
      ...SNAP.models.filter((m) => m.base !== "qwen3-8-flash-next" && m.base !== "kimi-k3"),
      { slug: "qwen3-8-flash-next", base: "qwen3-8-flash-next", effort: "", ii: 39.8, cost: 2.5, old: true, ver: "v4.3.2" },
      { slug: "kimi-k3", base: "kimi-k3", effort: "max", ii: 43.6, cost: 13.4, old: true, ver: "v4.3.2", dep: true },
      { slug: "qwen3-8-max", base: "qwen3-8-max", effort: "", ii: 33.6, cost: 9.2, rel: "2026-09-02" },
      { slug: "qwen3-8-max-0803", base: "qwen3-8-max-0803", effort: "", ii: 40.2, cost: 9, old: true, ver: "v4.3.2", dep: true },
    ],
  });
  const QMAX = usable("qwen", "qwen3.8-max");
  // 本机新型号 id（目录还没加时也得认）：手搭一个 UsableModel
  const IQ3S: UsableModel = { ...STRATA, model: "strata-flash-iq3s", label: "Qwen3.8 Flash Next 125B IQ3_S" };
  const { list, unrated } = candidates([GLMF, QMAX, K3, STRATA, IQ3S]);
  assert.deepEqual(list.filter((c) => c.model === "qwen3.8-max").map((c) => c.ii), [33.6]);
  assert.deepEqual(unrated.map((m) => m.model).sort(), ["k3", "strata-flash-iq3s", "strata-orca"]);
  const L = buildLadder([GLMF, QMAX, STRATA])!;
  for (const t of L.tiers) assert.ok(t.pick.model !== "strata-orca" && t.alt?.model !== "strata-orca", `${t.key} 档用了旧分的 Strata`);
});
