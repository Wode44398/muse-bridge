// 自带厂商经宿主模型中心接管时的思考参数与回传（plugin-providers.json 的 builtins）：
// 百炼这个服务里托管的别家型号（Kimi、GLM、DeepSeek）按自己的档位表发，不吃 Qwen 专属参数（thinking_budget、enable_search 在它们身上是 400）；
// 回传按型号 × 线路；模型中心的调用参数与兼容项对自带厂商同样生效；Kimi / MiMo / DeepSeek 直连的行为不变。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// 自己一个目录：别的测试文件共用默认那个，这里写的 builtins 不能影响它们
const dir = fs.mkdtempSync(path.join(path.dirname(process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR!), "hosted-thinking-"));
process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = dir;
const file = path.join(dir, "plugin-providers.json");
let n = 0;
const write = (body: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ v: 2, providers: [], ...body, pad: "x".repeat(++n) }));

const DS = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const KIMI_TIERS = [
  { id: "off", name: "关闭", value: { enable_thinking: false } },
  { id: "low", name: "Low", value: { reasoning_effort: "low" } },
  { id: "high", name: "High", value: { reasoning_effort: "high" } },
  { id: "max", name: "Max", value: { reasoning_effort: "max" } },
];
const GLM_TIERS = ["low", "high", "max"].map((id) => ({ id, name: id, value: id }));
const QWEN = {
  key: "sk-FAKE-DUMMY-DS",
  baseUrl: DS,
  name: "阿里云百炼",
  upstream: "dashscope.aliyuncs.com",
  plugin: { id: "model-hub", name: "模型中心", sid: "h-3e78e1db" },
  models: [
    { id: "qwen4-max", params: { temperature: 0.2 } },
    { id: "kimi-k3.1-pro", thinking: "effort", efforts: KIMI_TIERS, effortField: "" },
    { id: "glm-5.3", thinking: "effort", efforts: GLM_TIERS, effortField: "reasoning_effort", alwaysThinks: true },
    { id: "deepseek-v4.1-flash-1017" },   // 老 bridge 没给档位表：按共用型号表 × 线路现算
    { id: "MiniMax/MiniMax-M3.1-Flash" },
  ],
};
write({ builtins: { qwen: QWEN, kimi: { key: "sk-FAKE-DUMMY-KIMI", name: "Kimi", plugin: { id: "model-hub", name: "模型中心" }, models: [{ id: "k3.1-pro" }] } } });

const { createAdapter } = await import("./providers/registry.ts");
const { allProviders } = await import("./catalog.ts");

const tool = { name: "Bash", description: "run", schema: { type: "object", properties: { command: { type: "string" } } } };
async function bodyOf(provider: string, model: string, level: string, opts: { tools?: boolean; baseUrl?: string } = {}): Promise<Record<string, any>> {
  const original = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return new Response("stub", { status: 599 });
  }) as typeof fetch;
  try {
    const a = createAdapter({ provider: provider as never, model, apiKey: "FAKE-DUMMY-KEY", baseUrl: opts.baseUrl ?? DS });
    const turn = {
      system: "s",
      tools: opts.tools === false ? [] : [tool],
      budget: { maxOutputTokens: 4096, thinking: level },
      messages: [
        { role: "user", content: [{ t: "text", text: "hi" }] },
        { role: "assistant", content: [{ t: "thinking", text: "先列目录" }, { t: "tool_call", id: "c1", name: "Bash", args: { command: "ls" } }] },
        { role: "user", content: [{ t: "tool_result", id: "c1", ok: true, content: [{ t: "text", text: "a.txt" }] }] },
      ],
    };
    for await (const _ of a.stream(turn as never)) { /* drain */ }
  } finally {
    globalThis.fetch = original;
  }
  return JSON.parse(body);
}
const asst = (b: Record<string, any>) => b.messages.find((m: any) => m.role === "assistant");

test("百炼上的 Kimi：按档位表发，不带 thinking_budget / enable_search / enable_thinking:true；关闭档真关；思考回传", async () => {
  const high = await bodyOf("qwen", "kimi-k3.1-pro", "high");
  assert.equal(high.reasoning_effort, "high");
  for (const k of ["thinking_budget", "enable_search", "enable_thinking", "preserve_thinking"]) assert.equal(k in high, false, k);
  assert.equal(asst(high).reasoning_content, "先列目录");
  const off = await bodyOf("qwen", "kimi-k3.1-pro", "off");
  assert.equal(off.enable_thinking, false);
  assert.equal("reasoning_effort" in off, false);
});

test("百炼上的 GLM-5.3：关不掉（off 什么都不发），不带 enable_search；带工具的主循环不再 400", async () => {
  const off = await bodyOf("qwen", "glm-5.3", "off");
  for (const k of ["enable_thinking", "enable_search", "thinking_budget", "reasoning_effort"]) assert.equal(k in off, false, k);
  const max = await bodyOf("qwen", "glm-5.3", "max");
  assert.equal(max.reasoning_effort, "max");
  assert.equal(asst(max).reasoning_content, "先列目录");
});

test("没给档位表的别家型号：按共用型号表 × 线路现算（DeepSeek 回传、工具轮带空串规则照旧）；认不出思考写法的什么都不发", async () => {
  const ds = await bodyOf("qwen", "deepseek-v4.1-flash-1017", "high");
  assert.deepEqual(ds.thinking, { type: "enabled" });
  assert.equal(ds.reasoning_effort, "high");
  assert.equal("enable_search" in ds, false);
  assert.equal(asst(ds).reasoning_content, "先列目录");
  const mm = await bodyOf("qwen", "MiniMax/MiniMax-M3.1-Flash", "high");
  for (const k of ["enable_thinking", "enable_search", "thinking_budget", "reasoning_effort"]) assert.equal(k in mm, false, k);
  assert.equal("reasoning_content" in asst(mm), false);
});

test("百炼上的 Qwen4：照旧走 Qwen 分支（enable_search 等），回传思考并带 preserve_thinking；模型中心的调用参数生效", async () => {
  const b = await bodyOf("qwen", "qwen4-max", "medium");
  assert.equal(b.enable_thinking, true);
  assert.equal(b.reasoning_effort, "medium");
  assert.equal(b.enable_search, true);
  assert.equal(b.preserve_thinking, true);
  assert.equal(b.temperature, 0.2);
  assert.equal(asst(b).reasoning_content, "先列目录");
});

test("兼容项：模型中心里打开「回传推理」、改输出上限字段，对自带厂商同样生效", async () => {
  write({ builtins: { qwen: { ...QWEN, replayReasoning: true, maxTokensField: "max_completion_tokens", models: [...QWEN.models, { id: "qwen-legacy-x" }] } } });
  const b = await bodyOf("qwen", "qwen-legacy-x", "off");
  assert.equal(asst(b).reasoning_content, "先列目录");
  assert.equal(b.max_completion_tokens, 4096);
  assert.equal("max_tokens" in b, false);
  write({ builtins: { qwen: QWEN, kimi: { key: "sk-FAKE-DUMMY-KIMI", name: "Kimi", plugin: { id: "model-hub", name: "模型中心" }, models: [{ id: "k3.1-pro" }] } } });
});

test("Kimi 直连、DeepSeek（内置 openai）：回传与参数不变", async () => {
  const k = await bodyOf("kimi", "k3.1-pro", "high", { baseUrl: "https://api.kimi.com/coding/v1" });
  assert.equal(k.reasoning_effort, "high");
  assert.equal(asst(k).reasoning_content, "先列目录");
  assert.equal("enable_thinking" in k, false);
  // 型号表不认识的 Kimi 新型号：厂商 id 兜底照样回传
  const kx = await bodyOf("kimi", "kimi-next-preview", "high", { baseUrl: "https://api.kimi.com/coding/v1" });
  assert.equal(asst(kx).reasoning_content, "先列目录");
  const d = await bodyOf("openai", "deepseek-flash", "high", { baseUrl: "https://api.deepseek.com" });
  assert.deepEqual(d.thinking, { type: "enabled" });
  assert.equal(asst(d).reasoning_content, "先列目录");
});

test("菜单：百炼里的别家型号档位照它自己的档位表（Kimi 有关闭档、GLM 恒思考），Qwen 型号照目录", () => {
  const q = allProviders().find((p) => p.id === "qwen")!;
  const kimi = q.models.find((m) => m.id === "kimi-k3.1-pro")!;
  assert.deepEqual(kimi.efforts, ["off", "low", "high", "max"]);
  const glm = q.models.find((m) => m.id === "glm-5.3")!;
  assert.deepEqual(glm.efforts, ["low", "high", "max"]);
  assert.equal(glm.alwaysThinks, true);
  const ds = q.models.find((m) => m.id === "deepseek-v4.1-flash-1017")!;
  assert.deepEqual(ds.efforts, ["off", "low", "high", "max"]);
  const q4 = q.models.find((m) => m.id === "qwen4-max")!;
  assert.deepEqual(q4.efforts, ["off", "low", "medium", "high", "xhigh", "max"]);
});
