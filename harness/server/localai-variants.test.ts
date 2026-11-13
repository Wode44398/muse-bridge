// Strata 拆型号（2026-11-07）：每个本机变体是目录里独立的型号；旧 id strata-orca 是官方 IQ3_S 的等价别名；
// 在跑的变体认得出（进程命令行里的配置文件 / 服务报的 model_name）；会话选的变体和在跑的对不上时适配器不发请求。
// 不起进程、不碰本机端口：命令行解析与「在跑哪个」都用桩。
import assert from "node:assert/strict";
import test from "node:test";
import type { Turn } from "./agent/turn.ts";
import { canonicalModelId, clampEffort, defaultEffort, modelLimits, modelSpec, providerSpec } from "./catalog.ts";
import {
  canonicalLocalModel,
  cleanVariant,
  engineOfModel,
  LEGACY_STRATA_MODEL,
  localModelBaseUrl,
  parseStrataServers,
  setStrataServedForTests,
  STRATA_VARIANTS,
  strataVariantMismatch,
  strataVariantOf,
} from "./localai.ts";
import { createOpenAIAdapter } from "./providers/openai.ts";

test("目录：三个变体各是一个本机型号，旧 id 不单列", () => {
  const ids = providerSpec("local").models.map((m) => m.id);
  assert.deepEqual(ids, ["qwen3.8-27b", "strata-flash-iq3s", "strata-orca-iq3xxs", "strata-flash-nvfp4"]);
  assert.deepEqual(STRATA_VARIANTS.map((v) => v.model), ids.slice(1));
  // 显示名要分得清
  const labels = providerSpec("local").models.slice(1).map((m) => m.label);
  assert.equal(new Set(labels).size, 3);
  for (const l of labels) assert.match(l, /^Strata · /);
  for (const v of STRATA_VARIANTS) {
    assert.equal(engineOfModel(v.model), "strata");
    assert.equal(localModelBaseUrl(v.model), "http://127.0.0.1:8081/v1");
    assert.equal(strataVariantOf(v.model)?.id, v.id);
    assert.equal(cleanVariant(v.id), v.id);
  }
  assert.equal(cleanVariant("gptq"), undefined, "没登记的变体不认");
});

test("旧 id strata-orca = 官方 IQ3_S 的等价别名：目录查得到、档位 / 上下文 / 端点全按官方版", () => {
  assert.equal(LEGACY_STRATA_MODEL, "strata-orca");
  assert.equal(canonicalLocalModel("strata-orca"), "strata-flash-iq3s");
  assert.equal(canonicalModelId("local", "strata-orca"), "strata-flash-iq3s");
  assert.equal(canonicalModelId("openai", "strata-orca"), "strata-orca", "别名只在本机这家生效");
  const spec = modelSpec("local", "strata-orca");
  assert.equal(spec?.id, "strata-flash-iq3s");
  assert.deepEqual(spec?.aliases, ["strata-orca"], "前端靠 aliases 把旧会话的型号对上菜单");
  assert.deepEqual(modelLimits("local", "strata-orca"), modelLimits("local", "strata-flash-iq3s"));
  assert.equal(defaultEffort("local", "strata-orca"), "medium");
  assert.equal(clampEffort("local", "strata-orca", "high"), "xhigh", "本机模板把 high 当 xhigh，旧选择照旧");
  assert.equal(engineOfModel("strata-orca"), "strata");
  assert.equal(strataVariantOf("strata-orca")?.id, "flash-iq3s");
  assert.equal(localModelBaseUrl("strata-orca"), "http://127.0.0.1:8081/v1");
  assert.equal(modelSpec("local", "strata-gptq"), undefined);
});

test("在跑哪个变体：按 python 层命令行里的 --config 认（start-strata.bat 与 setup.py 的 run-*.bat 两种写法）", () => {
  const out = [
    '101\t".venv\\Scripts\\python.exe" -m serve.server --engine strata --config strata-flash.json --port 8081',
    '102\t"E:\\Strata\\.venv\\Scripts\\python.exe" "E:\\Strata\\serve\\server.py" "--engine" "strata" "--config" "E:\\Strata\\strata-nvfp4-nvfp4-qad.json" "--port" "8081"',
    "103\tpython -m serve.server --engine strata --config strata-orca.json",
    "104\tpython -m serve.server --engine strata --config E:\\Strata\\strata-iq3_s.json",
    "105\tpython -m serve.server --engine strata --config my-own.json",
    "106\tpython -m serve.server --engine strata",
    "",
    "garbage",
  ].join("\r\n");
  assert.deepEqual(parseStrataServers(out), [
    { pid: 101, variant: "flash-iq3s" },
    { pid: 102, variant: "flash-nvfp4" },
    { pid: 103, variant: "orca-iq3xxs" },
    { pid: 104, variant: "flash-iq3s" },
    { pid: 105, variant: null },
    { pid: 106, variant: null },
  ]);
});

// 适配器对 Strata 型号发请求前问一句在跑哪个；fetch 桩住，看它发没发
async function attempt(model: string): Promise<{ sent: boolean; events: any[] }> {
  const original = globalThis.fetch;
  let sent = false;
  globalThis.fetch = (async () => {
    sent = true;
    return new Response("stub", { status: 599 });
  }) as typeof fetch;
  const events: any[] = [];
  try {
    const adapter = createOpenAIAdapter({ provider: "local", apiKey: "FAKE-LOCAL-KEY", model, baseUrl: "http://127.0.0.1:1/v1" });
    const turn: Turn = { system: "s", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], tools: [], budget: { maxOutputTokens: 100, thinking: "medium" } };
    for await (const ev of adapter.stream(turn)) events.push(ev);
  } finally {
    globalThis.fetch = original;
  }
  return { sent, events };
}

test("会话选的变体和在跑的对不上：不发请求，报一句能看懂的错（不可重试）；对得上 / 认不出 / 连不上照常发", async () => {
  try {
    setStrataServedForTests(() => "flash-iq3s");
    const bad = await attempt("strata-orca-iq3xxs");
    assert.equal(bad.sent, false, "没发出去");
    assert.equal(bad.events.length, 1);
    assert.equal(bad.events[0].e, "error");
    assert.equal(bad.events[0].kind, "local_variant_mismatch");
    assert.equal(bad.events[0].retriable, false);
    assert.match(bad.events[0].summary, /正在跑「官方 IQ3_S」.*选的是「Orca 无审查 IQ3_XXS」/);
    assert.match((await strataVariantMismatch("strata-flash-nvfp4"))!, /切换到「NVIDIA NVFP4（QAD）」/);

    assert.equal((await attempt("strata-flash-iq3s")).sent, true, "对得上照发");
    assert.equal((await attempt("strata-orca")).sent, true, "旧 id 就是官方版，对得上");
    assert.equal((await attempt("qwen3.8-27b")).sent, true, "Qwen 27B 不问 Strata");

    setStrataServedForTests(() => undefined); // 没起 / 在加载 / 认不出：交给原来的连接错误与加载等待
    assert.equal((await attempt("strata-orca-iq3xxs")).sent, true);
    assert.equal(await strataVariantMismatch("strata-orca-iq3xxs"), undefined);
  } finally {
    setStrataServedForTests(null);
  }
  // 测试进程没装桩：一律不问本机端口
  assert.equal(await strataVariantMismatch("strata-orca-iq3xxs"), undefined);
});
