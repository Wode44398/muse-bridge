// 自定义模型服务：「模型服务」面板里的「＋」卡。地址 + 备注 + API key → 识别型号与能力 → 进目录、能切过去、能删。
// key 走假的内存存储（不起 DPAPI），上游用本地 HTTP 桩（OpenAI / Anthropic 两种协议、公开的 /models、语音模型、坏地址）。
// 2026-10-21 v2：型号带能力（共用 src/model-knowledge 识别）、协议分派、档位按型号的档位表发、v1 老配置在内存里补全。

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  addCustomProvider,
  customProviderKey,
  detectConnection,
  draftConn,
  fetchModels,
  getCustomProvider,
  listCustomProviders,
  normalizeBaseUrl,
  probeCustomModel,
  removeCustomProvider,
  setCustomProviderKey,
  setCustomSecretsForTests,
  testCustomProvider,
  updateCustomProvider,
} from "./custom-providers.ts";
import { slotView } from "./custom-tiers.ts";
import { allProviders, clampEffort, defaultEffort, modelLimits, modelSupportsImages, providerMediaBudget, providerSpec } from "./catalog.ts";
import { configWritesSettled, forgetProvider, getConfig, hasKey, resolveKey, setConfig } from "./config.ts";
import { customProvidersDir } from "./paths.ts";
import { readVerdict } from "./sandbox.ts";
import { createAdapter } from "./providers/registry.ts";
import { reasoningText } from "./providers/openai.ts";
import { classifyHttpError } from "./providers/classify.ts";
import type { Turn } from "./agent/turn.ts";

// 这个文件独占一个自定义服务目录（别的测试文件并发跑时也在加服务）；收尾还原成进入时的值
const prevDir = process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR;
process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-custom-providers-"));
test.after(() => {
  process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = prevDir;
});

let store: Record<string, { headers?: Record<string, string> }> = {};
setCustomSecretsForTests({
  readSecrets: () => store,
  writeSecrets: (_root, map) => {
    store = JSON.parse(JSON.stringify(map));
  },
});

const GOOD_KEY = "sk-FAKE-custom-good";
const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
const sse = (res: http.ServerResponse, chunks: unknown[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
};
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ url: req.url ?? "", headers: req.headers, body });
    const auth = req.headers.authorization ?? "";
    const xkey = req.headers["x-api-key"] ?? "";
    const json = (status: number, o: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
    // ── OpenAI 兼容（/v1）──
    if (req.url === "/v1/models") {
      if (auth !== `Bearer ${GOOD_KEY}`) return json(401, { error: "bad key" });
      return json(200, { object: "list", data: [{ id: "text-embedding-3" }, { id: "my-chat-7b" }, { id: "qwen-vl-max" }] });
    }
    // 小米 Token Plan 的形状：/v1/models 只有 id，第一个是语音识别
    if (req.url === "/mimo/v1/models") {
      if (auth !== `Bearer ${GOOD_KEY}` && xkey !== GOOD_KEY) return json(401, { error: "bad key" });
      return json(200, { data: ["mimo-v2.5-asr", "mimo-v2.5-tts", "mimo-v2.6-flash", "mimo-v2.6-pro"].map((id) => ({ id, object: "model", owned_by: "xiaomi" })) });
    }
    if (req.url === "/v1/chat/completions" || req.url === "/mimo/v1/chat/completions" || req.url === "/pub/v1/chat/completions") {
      if (auth !== `Bearer ${GOOD_KEY}`) return json(401, { error: { message: "Incorrect API key provided" } });
      if (/asr/.test(body?.model)) return json(400, { error: { message: "ASR request requires a user message with input_audio content" } });
      if (body?.reasoning_effort === "zzz-dimensio-probe") return json(400, { error: { message: "reasoning_effort must be one of 'none', 'low', 'medium' or 'high'" } });
      const want = body?.max_tokens ?? body?.max_completion_tokens;
      if (want > 131_072) return json(400, { error: { message: `max_tokens is too large: ${want}. The range of max_tokens should be [1, 131072]` } });
      if (body?.stream) return sse(res, [{ choices: [{ delta: { reasoning: "想一下" } }] }, { choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }]);
      const hasImage = JSON.stringify(body?.messages ?? []).includes("image_url");
      const thinks = body?.reasoning_effort !== "none";
      return json(200, { choices: [{ message: { content: hasImage ? "红色" : "2", ...(thinks ? { reasoning_content: "1+1=2" } : {}) } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    }
    // 本机 vLLM / Ollama 一类：不要 key；带了任何鉴权头就 400（会话链路的占位值绝不能外发）
    if (req.url === "/local/v1/chat/completions") {
      if (auth || xkey) return json(400, { error: { message: "unexpected auth header" } });
      if (body?.stream) return sse(res, [{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }]);
      return json(200, { choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    }
    // 公开的 /models（OpenRouter 一类）：不带 key 也列，468 个
    if (req.url === "/pub/v1/models") {
      return json(200, { data: Array.from({ length: 468 }, (_, i) => ({ id: i === 400 ? "openai/gpt-5.5" : `vendor${i % 7}/model-${i}`, context_length: 8192 + i, architecture: { input_modalities: i % 2 ? ["text", "image"] : ["text"] }, supported_parameters: i % 3 ? ["reasoning"] : [] })) });
    }
    // ── Anthropic 兼容（/anthropic）：没有 /models ──
    if (req.url === "/anthropic/v1/messages") {
      if (xkey !== GOOD_KEY && auth !== `Bearer ${GOOD_KEY}`) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      if (body?.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`);
        return res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      }
      const off = body?.thinking?.type === "disabled";
      return json(200, { type: "message", content: [...(off ? [] : [{ type: "thinking", thinking: "…", signature: "" }]), { type: "text", text: "OK" }], usage: { input_tokens: 4, output_tokens: 2 } });
    }
    res.writeHead(404, { "content-type": "text/html" }).end("<html><body>404 Not Found</body></html>");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const base = `${origin}/v1`;
test.after(() => server.close());

async function drain(adapter: ReturnType<typeof createAdapter>, thinking: Turn["budget"]["thinking"], messages: Turn["messages"] = [{ role: "user", content: [{ t: "text", text: "hi" }] }]) {
  const events: any[] = [];
  const turn: Turn = { system: "s", messages, tools: [], budget: { maxOutputTokens: 1000, thinking } };
  for await (const ev of adapter.stream(turn)) events.push(ev);
  return events;
}

test("地址规范化：尾斜杠、/chat/completions、/messages、缺协议都收成同一个根", () => {
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/anthropic/v1/messages"), "https://api.example.com/anthropic/v1");
  assert.equal(normalizeBaseUrl("api.example.com/v1"), "https://api.example.com/v1");
  assert.throws(() => normalizeBaseUrl(""), /接口地址/);
  assert.throws(() => normalizeBaseUrl("ftp://x.com"), /http/);
  assert.throws(() => normalizeBaseUrl("https://u:p@x.com/v1"), /账号密码/);
});

test("key 被拒：不保存，也不提示手填模型", async () => {
  await assert.rejects(
    () => addCustomProvider({ name: "坏的", baseUrl: base, apiKey: "sk-FAKE-wrong" }),
    (e: Error & { needsModel?: boolean }) => /API key 被拒绝/.test(e.message) && !e.needsModel,
  );
  assert.equal(listCustomProviders().length, 0);
});

test("接口不认 /models：提示手填模型 ID；填了就能保存", async () => {
  await assert.rejects(
    () => addCustomProvider({ baseUrl: `${base}/nope`, apiKey: GOOD_KEY }),
    (e: Error & { needsModel?: boolean }) => e.needsModel === true,
  );
  const { provider, warning } = await addCustomProvider({ name: "手填", baseUrl: `${base}/nope`, apiKey: GOOD_KEY, model: "manual-1" });
  assert.deepEqual(provider.models.map((m) => m.id), ["manual-1"]);
  assert.ok(warning);
  await removeCustomProvider(provider.id);
});

test("添加 → 进目录、能切过去、key 只在加密存储里；非对话模型不进菜单；改地址旧会话也走新地址；删掉退回默认", async () => {
  const { provider } = await addCustomProvider({ name: "我的网关", baseUrl: `${base}/chat/completions`, apiKey: GOOD_KEY });
  assert.match(provider.id, /^custom-[a-f0-9]{8}$/);
  assert.equal(provider.baseUrl, base);
  assert.equal(provider.protocol, "openai");
  assert.equal(provider.defaultModel, "my-chat-7b", "默认型号跳过 embedding 这类非聊天模型");
  assert.equal(provider.models.find((m) => m.id === "text-embedding-3")?.enabled, false, "非对话模型存着、默认不启用");
  assert.equal(store[provider.id]?.headers?.apiKey, GOOD_KEY);
  assert.equal(customProviderKey(provider.id), GOOD_KEY);

  const spec = allProviders().find((p) => p.id === provider.id);
  assert.ok(spec, "目录里要有它");
  assert.equal(spec!.name, "我的网关");
  assert.equal(spec!.custom?.host, new URL(base).host);
  assert.deepEqual(providerSpec(provider.id).models.map((m) => m.id), ["my-chat-7b", "qwen-vl-max"], "菜单只列启用的对话型号");
  assert.equal(clampEffort(provider.id, "my-chat-7b", "high"), "off", "不认识的型号：不发任何思考参数");
  assert.equal(modelSupportsImages(provider.id, "qwen-vl-max"), true);
  assert.deepEqual(modelLimits(provider.id, "my-chat-7b"), { ctx: 128_000, maxOut: 16_384, compactAt: undefined }, "不认识的型号按 OpenAI 适配器的兜底值");

  const cfg = setConfig({ provider: provider.id });
  assert.equal(cfg.provider, provider.id);
  assert.equal(cfg.model, "my-chat-7b");
  assert.equal(cfg.baseUrl, base);
  assert.equal(hasKey(provider.id), true);
  assert.equal(resolveKey(provider.id), GOOD_KEY);

  // 设置页换 key 落进加密存储
  setConfig({ apiKey: "sk-FAKE-rotated" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store[provider.id]?.headers?.apiKey, "sk-FAKE-rotated");
  setConfig({ apiKey: GOOD_KEY });
  await new Promise((r) => setTimeout(r, 20));

  // 改备注不重探；适配器拿的是注册表里的活地址，不是会话快照里的旧地址
  await updateCustomProvider(provider.id, { name: "改名了" });
  assert.equal(providerSpec(provider.id).name, "改名了");
  const adapter = createAdapter({ provider: provider.id, apiKey: GOOD_KEY, model: "my-chat-7b", baseUrl: "https://stale.example/v1" });
  assert.equal(adapter.id, provider.id);

  await removeCustomProvider(provider.id);
  forgetProvider(provider.id);
  assert.notEqual(getConfig().provider, provider.id);
  assert.equal(allProviders().some((p) => p.id === provider.id), false);
  assert.equal(store[provider.id], undefined);
  await configWritesSettled();
});

test("v1 老配置（正式服的中转与小米）：读进来在内存里补全能力、默认型号跳过 asr，不回写；一保存就写成 v2，型号一个不丢", async () => {
  const file = path.join(customProvidersDir(), "providers.json");
  fs.mkdirSync(customProvidersDir(), { recursive: true });
  const relay = ["opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001"];
  const v1 = {
    v: 1,
    providers: [
      { id: "custom-b24d1bc7", name: "测试", baseUrl: "https://relay.example.com/v1", models: relay, defaultModel: "opus-5-5", createdAt: 1 },
      { id: "custom-0000aaaa", name: "小米", baseUrl: `${origin}/mimo/v1`, models: ["mimo-v2.5-asr", "mimo-v2.5-tts", "mimo-v2.6-flash", "mimo-v2.6-pro"], defaultModel: "mimo-v2.5-asr", createdAt: 2 },
    ],
  };
  const text = JSON.stringify(v1, null, 2) + "\n";
  fs.writeFileSync(file, text);
  store["custom-0000aaaa"] = { headers: { apiKey: GOOD_KEY } };
  try {
    const list = listCustomProviders();
    assert.equal(list.length, 2);
    const [r, x] = list;
    assert.equal(r.protocol, "openai");
    assert.deepEqual(r.models.map((m) => m.id), relay, "型号一个不丢、顺序不变");
    const opus = r.models.find((m) => m.id === "claude-opus-5-5")!;
    assert.deepEqual([opus.contextWindow, opus.maxOutput, opus.vision, opus.source.contextWindow], [1_000_000, 128_000, true, "table"]);
    assert.equal(r.models.find((m) => m.id === "opus-5-5")!.contextWindow, 1_000_000, "中转省掉 claude- 前缀也认得");
    assert.equal(r.defaultModel, "opus-5-5");
    // 走 OpenAI 端点的 Claude：通用 reasoning_effort 三档 + 「默认」（什么都不发）——老会话存的 off 照旧什么都不发
    const s = providerSpec(r.id).models.find((m) => m.id === "claude-opus-5-5")!;
    assert.deepEqual(s.efforts, ["off", "low", "medium", "high"]);
    assert.equal(s.effortLabels?.off, "默认");
    assert.equal(clampEffort(r.id, "claude-opus-5-5", "off"), "off");
    assert.equal(defaultEffort(r.id, "claude-opus-5-5"), "off");
    assert.equal(s.ctx, 1_000_000);
    assert.equal(s.image, true);

    assert.equal(x.defaultModel, "mimo-v2.6-flash", "默认型号不再落在语音识别上");
    assert.deepEqual(x.models.filter((m) => m.enabled).map((m) => m.id), ["mimo-v2.6-flash", "mimo-v2.6-pro"]);
    const pro = providerSpec(x.id).models.find((m) => m.id === "mimo-v2.6-pro")!;
    assert.deepEqual([pro.ctx, pro.maxOut, pro.image, pro.video, pro.audio], [1_000_000, 131_072, true, true, true]);
    assert.deepEqual(pro.efforts, ["off", "high"]);
    assert.deepEqual(pro.effortLabels, { off: "关闭", high: "开启" });
    assert.equal(pro.alwaysThinks, true);
    assert.deepEqual(providerMediaBudget(x.id, "mimo-v2.6-pro"), { maxImages: 2, maxBytes: 24_000_000, keepRecent: 2 }, "经第三方接的小米同样只留最近 2 张工具图");
    assert.equal(clampEffort(x.id, "mimo-v2.6-pro", "low"), "high", "非关闭的请求不会被夹成关闭");
    assert.equal(fs.readFileSync(file, "utf8"), text, "只读不写");

    // 一保存就写成 v2
    await updateCustomProvider(x.id, { name: "小米 Token Plan", apiKey: GOOD_KEY });
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.v, 2);
    // 向前兼容：models 仍是字符串（老版 harness 认得），完整能力在 modelSpecs
    assert.deepEqual(saved.providers[0].models, relay);
    assert.deepEqual(saved.providers[0].modelSpecs.map((m: any) => m.id), relay);
    assert.equal(typeof saved.providers[1].models[0], "string");
    assert.equal(typeof saved.providers[1].modelSpecs[0], "object");
    assert.equal(getCustomProvider(x.id)?.defaultModel, "mimo-v2.6-flash");
    // 回滚到老版：老版的 clean() 只认字符串型号——服务和型号都还在（以前写成对象数组，整个服务会被它丢掉）
    const oldClean = (p: any) => {
      const ids = Array.isArray(p.models) ? [...new Set(p.models.filter((m: unknown) => typeof m === "string" && m.trim()))] : [];
      const dm = typeof p.defaultModel === "string" && ids.includes(p.defaultModel) ? p.defaultModel : ids[0];
      return dm ? { id: p.id, name: p.name, baseUrl: p.baseUrl, models: ids, defaultModel: dm, createdAt: p.createdAt } : null;
    };
    const old = saved.providers.map(oldClean);
    assert.deepEqual(old.map((p: any) => p?.models.length), [relay.length, 4]);
    // 老版再写一次文件（只剩 v1 字段）：新版照旧当 v1 读，按知识层补全，一个不丢
    fs.writeFileSync(file, JSON.stringify({ v: 1, providers: old }, null, 2) + "\n");
    const back = listCustomProviders();
    assert.deepEqual(back.map((p) => p.models.length), [relay.length, 4]);
    assert.equal(back[1].defaultModel, "mimo-v2.6-flash");
  } finally {
    fs.rmSync(file, { force: true });
    delete store["custom-0000aaaa"];
  }
});

test("档位按型号的档位表发：小米 OpenAI 端点 reasoning_effort none / high；工具续轮回传思维链；delta.reasoning 也认", async () => {
  const { provider } = await addCustomProvider({ name: "小米", baseUrl: `${origin}/mimo/v1`, apiKey: GOOD_KEY });
  try {
    assert.equal(provider.defaultModel, "mimo-v2.6-flash");
    const adapter = createAdapter({ provider: provider.id, apiKey: GOOD_KEY, model: "mimo-v2.6-pro" });
    assert.equal(adapter.capabilities.contextWindow, 1_000_000);
    assert.equal(adapter.capabilities.maxOutputTokens, 131_072);
    assert.equal(adapter.capabilities.image, true);
    seen.length = 0;
    await drain(adapter, "off");
    assert.equal(seen.at(-1)!.body.reasoning_effort, "none", "关：OpenAI 端点只认 reasoning_effort=none");
    await drain(adapter, "high");
    assert.equal(seen.at(-1)!.body.reasoning_effort, "high");
    const events = await drain(adapter, "high", [
      { role: "user", content: [{ t: "text", text: "hi" }] },
      { role: "assistant", content: [{ t: "thinking", text: "先想想" }, { t: "tool_call", id: "c1", name: "Read", args: {} }] },
      { role: "user", content: [{ t: "tool_result", id: "c1", ok: true, content: [{ t: "text", text: "x" }] }] },
    ]);
    assert.equal(seen.at(-1)!.body.messages[2].reasoning_content, "先想想", "不发参数也会思考的型号：工具续轮回传 reasoning_content");
    assert.ok(events.some((e) => e.e === "thinking_delta" && e.text === "想一下"), "delta.reasoning 也读");
    assert.equal(reasoningText({ reasoning_details: [{ type: "reasoning.text", text: "a" }, { type: "reasoning.text", text: "b" }] }), "ab");
    assert.equal(reasoningText({ reasoning_content: "x", reasoning: "x" }), "x", "同一块只取一种，不重复");
  } finally {
    await removeCustomProvider(provider.id);
  }
});

test("协议分派：Anthropic 端点走 anthropic 适配器——地址不拼成 /v1/v1、鉴权按服务、思考按档位表（小米 off 显式发 disabled）", async () => {
  const { provider } = await addCustomProvider({
    name: "小米 Anthropic",
    baseUrl: `${origin}/anthropic/v1/messages`,
    protocol: "anthropic",
    apiKey: GOOD_KEY,
    models: [{ id: "mimo-v2.6-pro" }],
  });
  try {
    assert.equal(provider.baseUrl, `${origin}/anthropic/v1`);
    const m = provider.models[0];
    assert.deepEqual(m.efforts.map((t) => t.id), ["off", "on"]);
    const adapter = createAdapter({ provider: provider.id, apiKey: GOOD_KEY, model: "mimo-v2.6-pro" });
    assert.equal(adapter.capabilities.cache, false, "第三方 Anthropic 端点默认不发 cache_control");
    seen.length = 0;
    const events = await drain(adapter, "off");
    const req = seen.at(-1)!;
    assert.equal(req.url, "/anthropic/v1/messages");
    assert.equal(req.headers["x-api-key"], GOOD_KEY);
    assert.deepEqual(req.body.thinking, { type: "disabled" });
    assert.equal(req.body.output_config, undefined, "不按型号名猜 adaptive");
    assert.ok(events.some((e) => e.e === "text_delta" && e.text === "OK"));
    await drain(adapter, "high");
    assert.deepEqual(seen.at(-1)!.body.thinking, { type: "enabled" });
  } finally {
    await removeCustomProvider(provider.id);
  }
});

test("识别：拉型号附能力猜测、不再截到 200；检测连接推荐能通的组合；探测读出上限 / 视觉 / 档位；测试回人话", async () => {
  // 公开的 /models：468 个全给，元数据读进来
  const { conn, key } = draftConn({ baseUrl: `${origin}/pub/v1`, protocol: "openai", apiKey: GOOD_KEY });
  const { models, total } = await fetchModels(conn, key);
  assert.equal(total, 468);
  assert.equal(models.length, 468);
  assert.ok(models.some((m) => m.id === "openai/gpt-5.5"), "第 400 个也在");
  assert.equal(models[1].vision, true);
  assert.equal(models[1].source.vision, "api");
  assert.equal(models[1].contextWindow, 8193);

  // 小米：Anthropic 地址没有 /models，退到同站 /v1/models
  const mimo = draftConn({ baseUrl: `${origin}/mimo/anthropic`, protocol: "anthropic", apiKey: GOOD_KEY });
  const listed = await fetchModels(mimo.conn, mimo.key).catch((e) => e);
  assert.ok(Array.isArray(listed.models) ? listed.models.length === 4 : /模型列表/.test(String(listed.message)));

  // 检测连接：配成 anthropic + …/v1 的（以前每条消息都 404）→ 推荐能通的组合；同等时尊重原来选的协议（同协议换地址优先）
  const wrong = draftConn({ baseUrl: `${origin}/mimo/v1`, protocol: "anthropic", authStyle: "x-api-key", apiKey: GOOD_KEY });
  const d = await detectConnection(wrong.conn, wrong.key);
  assert.equal(d.ok, false);
  assert.equal(d.current?.result, "missing");
  assert.deepEqual([d.suggest?.protocol, d.suggest?.baseUrl], ["anthropic", `${origin}/anthropic`]);
  assert.equal(d.results.find((x) => x.protocol === "openai" && x.baseUrl === `${origin}/mimo/v1`)?.result, "ok");

  // 探测：输出上限从报错里读、看图、默认会思考、档位都认、reasoning_effort 的可选档
  const good = draftConn({ baseUrl: `${origin}/mimo/v1`, protocol: "openai", apiKey: GOOD_KEY });
  const p = await probeCustomModel(good.conn, { id: "mimo-v2.6-pro" }, good.key);
  assert.equal(p.kind, "chat");
  assert.equal(p.maxOutput, 131_072);
  assert.equal(p.vision, true);
  assert.equal(p.thinksByDefault, true);
  assert.deepEqual(p.tiers.map((t: any) => [t.id, t.ok]), [["off", true], ["on", true]]);
  assert.deepEqual(p.effortIds, ["none", "low", "medium", "high"]);
  const asr = await probeCustomModel(good.conn, { id: "mimo-v2.5-asr" }, good.key);
  assert.equal(asr.kind, "other", "普通对话被拒的语音模型判成非对话");

  // 测试：草稿也能测；坏地址说人话
  const ok = await testCustomProvider(good.conn, [good.models[0] ?? (await fetchModels(good.conn, good.key)).models[2]], good.key);
  assert.equal(ok.ok, true);
  const bad = draftConn({ baseUrl: `${origin}/nothing/v1`, protocol: "openai", apiKey: GOOD_KEY, models: [{ id: "x-chat" }] });
  const r = await testCustomProvider(bad.conn, bad.models, bad.key);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /接口地址不对.*404.*OpenAI Chat Completions/);
});

test("公开 /models 的端点（OpenRouter 一类）：key 填错不能「保存成功」；超过 300 个型号不静默截断", async () => {
  await assert.rejects(() => addCustomProvider({ baseUrl: `${origin}/pub/v1`, apiKey: "sk-FAKE-wrong" }), /API key 被拒绝（HTTP 401）/);
  const { provider, warning } = await addCustomProvider({ baseUrl: `${origin}/pub/v1`, apiKey: GOOD_KEY });
  try {
    assert.equal(provider.models.length, 300);
    assert.match(String(warning), /468.*300/);
  } finally {
    await removeCustomProvider(provider.id);
  }
});

test("编辑器的完整型号清单：非对话不能当默认、至少一个对话模型、档位校验；改型号不重探", async () => {
  await assert.rejects(() => addCustomProvider({ baseUrl: base, apiKey: GOOD_KEY, models: [{ id: "text-embedding-3", kind: "other" }] }), /至少启用一个对话模型/);
  await assert.rejects(
    () => addCustomProvider({ baseUrl: base, apiKey: GOOD_KEY, models: [{ id: "a", thinking: "effort", efforts: [{ id: "Bad Id" }] }] }),
    /档位 ID/,
  );
  const { provider } = await addCustomProvider({
    baseUrl: base,
    apiKey: GOOD_KEY,
    defaultModel: "text-embedding-3",
    models: [
      { id: "text-embedding-3", kind: "other" },
      { id: "my-chat-7b", contextWindow: 32768, maxOutput: 4096, vision: false, thinking: "effort", efforts: [{ id: "low", name: "浅", value: "low" }, { id: "deep", name: "深", value: "high" }], source: { contextWindow: "user" } },
    ],
  });
  try {
    assert.equal(provider.defaultModel, "my-chat-7b");
    const s = providerSpec(provider.id).models[0];
    assert.equal(s.ctx, 32768);
    assert.deepEqual(s.efforts, ["off", "low", "high"], "自由档位 id 按顺序占槽；没有关闭档、没默认档 → 补「默认」");
    assert.deepEqual(s.effortLabels, { off: "默认", low: "浅", high: "深" });
    const adapter = createAdapter({ provider: provider.id, apiKey: GOOD_KEY, model: "my-chat-7b" });
    seen.length = 0;
    await drain(adapter, "high");
    assert.equal(seen.at(-1)!.body.reasoning_effort, "high");
    await drain(adapter, "off");
    assert.equal(seen.at(-1)!.body.reasoning_effort, undefined, "「默认」什么都不发");
    const before = seen.length;
    await updateCustomProvider(provider.id, { models: [...provider.models.map((m) => ({ ...m })), { id: "added" }] });
    assert.equal(seen.length, before, "只改型号不联网");
    assert.ok(getCustomProvider(provider.id)?.models.some((m) => m.id === "added"));
  } finally {
    await removeCustomProvider(provider.id);
  }
});

test("鉴权方式「不需要」（本机 vLLM / Ollama）：不填 Key 也能起会话、切过去、给子 agent 用；占位值不外发", async () => {
  const { provider } = await addCustomProvider({ name: "本机", baseUrl: `${origin}/local/v1`, authStyle: "none", models: [{ id: "qwen3-32b" }], defaultModel: "qwen3-32b" });
  try {
    assert.equal(store[provider.id], undefined, "没有 key 就不往加密存储里写");
    // 会话链路（buildState / 中途换型号 / 子 agent / hasKey）都只认「有没有 key」
    assert.ok(customProviderKey(provider.id));
    assert.ok(resolveKey(provider.id));
    assert.equal(hasKey(provider.id), true);
    const adapter = createAdapter({ provider: provider.id, apiKey: resolveKey(provider.id)!, model: "qwen3-32b" });
    seen.length = 0;
    const events = await drain(adapter, "off");
    assert.equal(seen.at(-1)!.url, "/local/v1/chat/completions");
    assert.equal(seen.at(-1)!.headers.authorization, undefined, "占位值不能当 Bearer 发出去");
    assert.ok(events.some((e) => e.e === "text_delta" && e.text === "OK"));
    assert.ok(!events.some((e) => e.e === "error"));
  } finally {
    await removeCustomProvider(provider.id);
  }
  // 要 key 的服务没 key 照旧算没有
  assert.equal(customProviderKey("custom-00000000"), undefined);
});

test("旧版表单只换 Key：编辑器里挑好的型号表不被 /models 整表冲掉；只补一个手填型号也不冲", async () => {
  const { provider } = await addCustomProvider({
    name: "挑过的",
    baseUrl: base,
    apiKey: GOOD_KEY,
    models: [{ id: "my-chat-7b", contextWindow: 65536 }, { id: "my-alias" }],
    defaultModel: "my-alias",
  });
  try {
    setCustomProviderKey(provider.id, "sk-FAKE-old");
    const r = await updateCustomProvider(provider.id, { name: "挑过的", baseUrl: base, apiKey: GOOD_KEY });
    assert.deepEqual(r.provider.models.map((m) => m.id), ["my-chat-7b", "my-alias"], "端点不列的 my-alias 还在，没被换成 /models 那三个");
    assert.equal(r.provider.models[0].contextWindow, 65536);
    assert.equal(r.provider.defaultModel, "my-alias");
    assert.equal(customProviderKey(provider.id), GOOD_KEY);
    // 新 Key 被拒照旧不保存
    await assert.rejects(() => updateCustomProvider(provider.id, { name: "挑过的", baseUrl: base, apiKey: "sk-FAKE-wrong" }), /API key 被拒绝（HTTP 401）/);
    assert.equal(customProviderKey(provider.id), GOOD_KEY);
    // 老表单手填一个型号：加在最前，原来的留着
    const m = await updateCustomProvider(provider.id, { name: "挑过的", baseUrl: base, model: "hand-typed" });
    assert.deepEqual(m.provider.models.map((x) => x.id), ["hand-typed", "my-chat-7b", "my-alias"]);
    assert.equal(m.provider.defaultModel, "hand-typed");
  } finally {
    await removeCustomProvider(provider.id);
  }
});

test("不再静默截断 / 丢档：超过 300 个型号照实拒；放不进七级思考档的档位照实拒", async () => {
  const many = Array.from({ length: 301 }, (_, i) => ({ id: `m-${i}` }));
  await assert.rejects(() => addCustomProvider({ baseUrl: base, apiKey: GOOD_KEY, models: many }), /型号最多 300 个（这次提交了 301 个）/);
  const eight = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((id) => ({ id, value: id }));
  await assert.rejects(
    () => addCustomProvider({ baseUrl: base, apiKey: GOOD_KEY, models: [{ id: "my-chat-7b", thinking: "effort", effortField: "reasoning_effort", efforts: eight }] }),
    /「my-chat-7b」的思考档位放不下.*ultra/,
  );
  // 七个自由命名的档：关闭档以外只有 6 个槽
  const seven = Array.from({ length: 7 }, (_, i) => ({ id: `t${i + 1}`, value: `v${i + 1}` }));
  await assert.rejects(
    () => addCustomProvider({ baseUrl: base, apiKey: GOOD_KEY, models: [{ id: "my-chat-7b", thinking: "effort", effortField: "reasoning_effort", efforts: seven }] }),
    /放不下.*t7/,
  );
  assert.deepEqual(slotView({ thinking: "effort", efforts: seven.slice(0, 6) }).dropped, []);
});

test("胶囊「模型自带思考」按这一档真发不发东西判断，不比对档名文字", async () => {
  const { provider } = await addCustomProvider({
    baseUrl: base,
    apiKey: GOOD_KEY,
    models: [
      // 真能关：关闭档发 reasoning_effort=none——档名写成「Off」「不思考」都一样
      { id: "my-chat-7b", alwaysThinks: true, thinking: "effort", effortField: "reasoning_effort", efforts: [{ id: "off", name: "不思考", value: "none" }, { id: "on", name: "开启", value: "high" }] },
      // 关不掉：关闭档什么都不发
      { id: "qwen-vl-max", alwaysThinks: true, thinking: "effort", effortField: "reasoning_effort", efforts: [{ id: "off", name: "Off", value: null }, { id: "high", value: "high" }] },
      // 没有档位的恒思考：只有一档「模型自带思考」
      { id: "think-only", thinking: "none", alwaysThinks: true },
    ],
  });
  try {
    const spec = (id: string) => providerSpec(provider.id).models.find((m) => m.id === id)!;
    assert.deepEqual(spec("my-chat-7b").autoThinkAt, []);
    assert.deepEqual(spec("qwen-vl-max").autoThinkAt, ["off"]);
    assert.deepEqual(spec("think-only").efforts, ["high"]);
    assert.deepEqual(spec("think-only").autoThinkAt, ["high"]);
    assert.equal(spec("think-only").effortLabels?.high, "模型自带思考");
  } finally {
    await removeCustomProvider(provider.id);
  }
});

test("新建草稿没动提示缓存开关：服务端按地址定（只有官方端点默认开）", () => {
  assert.equal(draftConn({ baseUrl: "https://api.anthropic.com", protocol: "anthropic", apiKey: "x" }).conn.promptCaching, true);
  assert.equal(draftConn({ baseUrl: "https://relay.example.com/v1", protocol: "anthropic", apiKey: "x" }).conn.promptCaching, false);
  assert.equal(draftConn({ baseUrl: "https://api.anthropic.com", protocol: "anthropic", apiKey: "x", promptCaching: false }).conn.promptCaching, false);
});

test("报错说人话：自定义服务的 404（地址 / 协议不对）、语音模型 400、401 各说各的", () => {
  const ctx = { url: "https://x.example.com/anthropic/chat/completions", name: "小米", protocol: "openai" as const, model: "mimo-v2.5-asr" };
  const a = classifyHttpError(404, "<html>openresty</html>", undefined, ctx);
  assert.equal(a.class, "endpoint");
  assert.equal(a.retriable, false);
  assert.match(a.summary, /接口地址或协议不对.*OpenAI Chat Completions.*模型服务 › 小米/);
  const b = classifyHttpError(400, JSON.stringify({ error: { message: "ASR request requires a user message with input_audio content" } }), undefined, ctx);
  assert.equal(b.class, "not_chat");
  const c = classifyHttpError(401, JSON.stringify({ error: { message: "invalid key" } }), undefined, ctx);
  assert.equal(c.class, "auth");
  assert.match(c.summary, /小米/);
  // 中转不收音频 ≠ 不是对话模型：不能引导用户把正常的对话型号关掉
  const pro = { ...ctx, model: "mimo-v2.6-pro" };
  const d = classifyHttpError(400, JSON.stringify({ error: { message: "input_audio is not supported" } }), undefined, pro);
  assert.equal(d.class, "bad_request");
  assert.match(d.summary, /不收音频/);
  // 国内中转对下架型号回 JSON 404「模型 xxx 不存在」：是型号不对，不是地址不对
  const e = classifyHttpError(404, JSON.stringify({ error: { message: "模型 mimo-v2.6-pro 不存在" } }), undefined, pro);
  assert.equal(e.class, "bad_request");
  assert.match(e.summary, /找不到型号/);
  const f = classifyHttpError(404, JSON.stringify({ error: { message: "mimo-v2.6-pro does not exist" } }), undefined, pro);
  assert.match(f.summary, /找不到型号/, "原文里提到型号 ID 也算在说型号");
  // 内置厂商不受影响
  assert.equal(classifyHttpError(404, "<html>x</html>").class, "bad_request");
});

test("设置页给内置厂商填的 key 也落加密存储（以前只在内存，harness 一重启就丢）；删自定义服务不连带它", async () => {
  setConfig({ provider: "zhipu", apiKey: "sk-FAKE-zhipu-ui" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.zhipu?.headers?.apiKey, "sk-FAKE-zhipu-ui");
  assert.equal(resolveKey("zhipu"), "sk-FAKE-zhipu-ui");

  const { provider } = await addCustomProvider({ baseUrl: base, apiKey: GOOD_KEY });
  await removeCustomProvider(provider.id);
  assert.equal(store.zhipu?.headers?.apiKey, "sk-FAKE-zhipu-ui");
  await configWritesSettled();
});

test("密钥守卫挡住整个自定义服务目录（读、写、Bash 同一个判定）", () => {
  const dir = customProvidersDir();
  for (const f of ["connector-secrets.json", "connector-secrets.key", "providers.json"]) {
    assert.match(readVerdict(path.join(dir, f)) ?? "", /secret guard/);
  }
  assert.match(readVerdict(dir) ?? "", /secret guard/);
});
