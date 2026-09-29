// 自定义模型服务：「模型服务」面板里的「＋」卡。地址 + 备注 + API key → 探 /models → 进目录、能切过去、能删。
// key 走假的内存存储（不起 DPAPI），/models 用本地 HTTP 桩。

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import {
  addCustomProvider,
  customProviderKey,
  listCustomProviders,
  normalizeBaseUrl,
  removeCustomProvider,
  setCustomSecretsForTests,
  updateCustomProvider,
} from "./custom-providers.ts";
import { allProviders, clampEffort, modelSupportsImages, providerSpec } from "./catalog.ts";
import { configWritesSettled, forgetProvider, getConfig, hasKey, resolveKey, setConfig } from "./config.ts";
import { customProvidersDir } from "./paths.ts";
import { readVerdict } from "./sandbox.ts";
import { createAdapter } from "./providers/registry.ts";

let store: Record<string, { headers?: Record<string, string> }> = {};
setCustomSecretsForTests({
  readSecrets: () => store,
  writeSecrets: (_root, map) => {
    store = JSON.parse(JSON.stringify(map));
  },
});

const GOOD_KEY = "sk-FAKE-custom-good";
const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  if (req.url === "/v1/models") {
    if (auth !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "text-embedding-3" }, { id: "my-chat-7b" }, { id: "qwen-vl-max" }] }));
    return;
  }
  res.writeHead(404).end("not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
test.after(() => server.close());

test("地址规范化：尾斜杠、/chat/completions、缺协议都收成同一个根", () => {
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1");
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
  assert.deepEqual(provider.models, ["manual-1"]);
  assert.ok(warning);
  await removeCustomProvider(provider.id);
});

test("添加 → 进目录、能切过去、key 只在加密存储里；改地址旧会话也走新地址；删掉退回默认", async () => {
  const { provider } = await addCustomProvider({ name: "我的网关", baseUrl: `${base}/chat/completions`, apiKey: GOOD_KEY });
  assert.match(provider.id, /^custom-[a-f0-9]{8}$/);
  assert.equal(provider.baseUrl, base);
  assert.equal(provider.defaultModel, "my-chat-7b", "默认型号跳过 embedding 这类非聊天模型");
  assert.equal(store[provider.id]?.headers?.apiKey, GOOD_KEY);
  assert.equal(customProviderKey(provider.id), GOOD_KEY);

  const spec = allProviders().find((p) => p.id === provider.id);
  assert.ok(spec, "目录里要有它");
  assert.equal(spec!.name, "我的网关");
  assert.equal(spec!.custom?.host, new URL(base).host);
  assert.equal(providerSpec(provider.id).models.length, 3);
  assert.equal(clampEffort(provider.id, "my-chat-7b", "high"), "off", "不发任何思考参数");
  assert.equal(modelSupportsImages(provider.id, "qwen-vl-max"), true);

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

test("密钥守卫挡住整个自定义服务目录（读、写、Bash 同一个判定）", () => {
  const dir = customProvidersDir();
  for (const f of ["connector-secrets.json", "connector-secrets.key", "providers.json"]) {
    assert.match(readVerdict(path.join(dir, f)) ?? "", /secret guard/);
  }
  assert.match(readVerdict(dir) ?? "", /secret guard/);
});
