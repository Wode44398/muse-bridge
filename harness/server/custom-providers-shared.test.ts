// 多用户（2026-10-28，维护者：成员能用管理员公开的自定义服务，也能自己加）。
//   · 管理员实例：add / update 收 shared（共享给成员），写进自己的 providers.json。
//   · 成员实例（DIMENSIO_TENANT=1）：经 DIMENSIO_SHARED_PROVIDERS_DIR 只读管理员那份，只认标了 shared 的；Key 现从管理员的加密存储取、
//     只取共享的那几条；目录里不下发地址；改 / 删 / 当草稿底子 / 换 Key 都拒；管理员取消共享立刻没了。
//   · 成员自己加的服务只能连公网（endpoint-guard.ts）：本机 / 内网地址在保存、草稿请求、真对话前都拒，不跟随重定向；
//     管理员共享的服务不过这道（地址是管理员定的）。
// Key 走假的存储（按目录分开，不碰 DPAPI），上游是本地 HTTP 桩。

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
  draftConn,
  fetchModels,
  isSharedProvider,
  listCustomProviders,
  removeCustomProvider,
  setCustomProviderKey,
  setCustomSecretsForTests,
  updateCustomProvider,
} from "./custom-providers.ts";
import { isPrivateAddress } from "./endpoint-guard.ts";
import { providerSpec } from "./catalog.ts";
import { getConfig, setConfig } from "./config.ts";
import { createAdapter } from "./providers/registry.ts";
import type { Turn } from "./agent/turn.ts";

const mk = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `dimensio-shared-${tag}-`));
const ownDir = mk("own");
const adminDir = mk("admin");
const saved = { ...process.env };
process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = ownDir;
test.after(() => {
  for (const k of ["DIMENSIO_CUSTOM_PROVIDERS_DIR", "DIMENSIO_SHARED_PROVIDERS_DIR", "DIMENSIO_TENANT", "DIMENSIO_TENANT_PRIVATE_ENDPOINTS"]) process.env[k] = saved[k];
  server.close();
});

// 假的加密存储：按目录各一份（管理员那份里还有内置厂商的 key 和没共享的服务的 key——成员一个都不该拿到）
const stores = new Map<string, Record<string, { headers?: Record<string, string> }>>();
const fold = (p: string) => path.resolve(p).toLowerCase();
setCustomSecretsForTests({
  readSecrets: (root) => stores.get(fold(root)) ?? {},
  writeSecrets: (root, map) => void stores.set(fold(root), JSON.parse(JSON.stringify(map))),
});

const KEY = "sk-FAKE-shared-good";
const hits: string[] = [];
const server = http.createServer((req, res) => {
  hits.push(req.url ?? "");
  const json = (status: number, o: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
  if (req.url === "/v1/models") return json(200, { data: [{ id: "chat-1" }] });
  if (req.url === "/v1/chat/completions") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\n`);
    return void res.end("data: [DONE]\n\n");
  }
  if (req.url === "/hop/v1/chat/completions") return void res.writeHead(302, { location: "http://169.254.169.254/latest" }).end();
  json(404, { error: "nope" });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

const model = { id: "chat-1", enabled: true, kind: "chat" };
const writeAdmin = (providers: unknown[]) => {
  const file = path.join(adminDir, "providers.json");
  fs.writeFileSync(file, JSON.stringify({ v: 2, providers }, null, 2));
  // mtime 粒度：同一毫秒里连写两次缓存认不出——挪一下时间戳
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
  fs.utimesSync(file, t, t);
};
const SHARED = "custom-aaaaaaaa";
const PRIVATE = "custom-bbbbbbbb";
const adminProvider = (id: string, shared: boolean, extra: Record<string, unknown> = {}) => ({
  id,
  name: shared ? "团队网关" : "管理员私用",
  baseUrl: base,
  protocol: "openai",
  headers: [{ name: "X-Team-Secret", value: "s3cret" }],
  models: ["chat-1"],
  modelSpecs: [model],
  defaultModel: "chat-1",
  createdAt: 1,
  ...(shared ? { shared: true } : {}),
  ...extra,
});

async function drain(adapter: ReturnType<typeof createAdapter>) {
  const turn: Turn = { system: "s", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], tools: [], budget: { maxOutputTokens: 100, thinking: "off" } };
  const out: any[] = [];
  for await (const ev of adapter.stream(turn)) out.push(ev);
  return out;
}

test("地址分类：本机 / 内网 / 链路本地 / 内嵌 IPv4 都算内网；公网与 fake-ip 段不算", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.100.1.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "[::1]", "224.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "198.18.0.5", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("管理员实例：shared 存进 providers.json，改的时候能开能关；不带 shared 的修改保持原样", async () => {
  delete process.env.DIMENSIO_TENANT;
  const { provider } = await addCustomProvider({ name: "管理员加的", baseUrl: base, apiKey: KEY, models: [model], shared: true });
  assert.equal(provider.shared, true);
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(ownDir, "providers.json"), "utf8")).providers.find((p: any) => p.id === provider.id);
  assert.equal(onDisk().shared, true);
  assert.equal(providerSpec(provider.id).custom?.shared, true);
  await updateCustomProvider(provider.id, { name: "改个名" });
  assert.equal(onDisk().shared, true, "没提 shared 的修改不动它");
  await updateCustomProvider(provider.id, { shared: false });
  assert.equal(onDisk().shared, undefined);
  await removeCustomProvider(provider.id);
});

test("成员实例：只看得到管理员标了共享的那条；Key 现取、只取共享的；地址与请求头不下发", () => {
  process.env.DIMENSIO_TENANT = "1";
  process.env.DIMENSIO_SHARED_PROVIDERS_DIR = adminDir;
  writeAdmin([adminProvider(SHARED, true), adminProvider(PRIVATE, false)]);
  stores.set(fold(adminDir), { [SHARED]: { headers: { apiKey: KEY } }, [PRIVATE]: { headers: { apiKey: "sk-FAKE-admin-private" } }, anthropic: { headers: { apiKey: "sk-FAKE-admin-anthropic" } } });

  const ids = listCustomProviders().map((p) => p.id);
  assert.deepEqual(ids, [SHARED]);
  assert.equal(isSharedProvider(SHARED), true);
  assert.equal(customProviderKey(SHARED), KEY);
  assert.equal(customProviderKey(PRIVATE), undefined, "没共享的服务拿不到 Key");

  const spec = providerSpec(SHARED);
  assert.equal(spec.baseUrl, undefined, "地址不下发");
  assert.equal(spec.custom?.host, "");
  assert.equal(spec.custom?.managed, true);
  assert.equal(JSON.stringify(spec).includes("s3cret"), false, "请求头不下发");
  assert.equal(JSON.stringify(spec).includes("127.0.0.1"), false);

  // 管理员换 Key：下一次取就是新的
  stores.set(fold(adminDir), { [SHARED]: { headers: { apiKey: "sk-FAKE-rotated" } } });
  assert.equal(customProviderKey(SHARED), "sk-FAKE-rotated");
  stores.set(fold(adminDir), { [SHARED]: { headers: { apiKey: KEY } } });
});

test("成员实例：管理员共享的只能用——改 / 删 / 当草稿底子 / 换 Key 都拒", async () => {
  await assert.rejects(() => updateCustomProvider(SHARED, { baseUrl: "https://evil.example/v1" }), (e: any) => e.status === 403 && /管理员/.test(e.message));
  await assert.rejects(() => removeCustomProvider(SHARED), (e: any) => e.status === 403);
  assert.throws(() => draftConn({ id: SHARED, baseUrl: "https://evil.example/v1" }), (e: any) => e.status === 403);
  setCustomProviderKey(SHARED, "sk-FAKE-mine");
  assert.equal(customProviderKey(SHARED), KEY, "成员存不进自己的 Key");
  assert.equal(stores.get(fold(ownDir))?.[SHARED], undefined);
});

test("成员实例：管理员共享的服务连内网地址照常能用（不过地址把关）", async () => {
  const events = await drain(createAdapter({ provider: SHARED as any, apiKey: customProviderKey(SHARED)!, model: "chat-1" }));
  assert.ok(events.some((e) => e.e === "text_delta" && e.text === "hi"), JSON.stringify(events).slice(0, 300));
});

test("成员实例：管理员取消共享，立刻用不了；选着它的成员退回默认厂商", () => {
  setConfig({ provider: SHARED as any });
  assert.equal(getConfig().provider, SHARED);
  assert.equal(getConfig().baseUrl, undefined, "配置里也不带管理员的地址");
  writeAdmin([adminProvider(SHARED, false), adminProvider(PRIVATE, false)]);
  assert.notEqual(getConfig().provider, SHARED);
  assert.deepEqual(listCustomProviders().map((p) => p.id), []);
  assert.equal(customProviderKey(SHARED), undefined);
  assert.equal(isSharedProvider(SHARED), false);
  writeAdmin([adminProvider(SHARED, true)]);
});

test("成员实例：自己加的服务连本机 / 内网地址——保存、草稿请求都拒，一个请求都不发", async () => {
  hits.length = 0;
  await assert.rejects(() => addCustomProvider({ name: "偷看", baseUrl: base, apiKey: KEY, models: [model] }), /公网/);
  await assert.rejects(() => addCustomProvider({ name: "偷看", baseUrl: "http://localhost:8787/v1", authStyle: "none", models: [model] }), /公网/);
  await assert.rejects(() => addCustomProvider({ name: "元数据", baseUrl: "http://169.254.169.254/v1", authStyle: "none", models: [model] }), /公网/);
  await assert.rejects(() => fetchModels(draftConn({ baseUrl: base, apiKey: KEY }).conn, KEY), /公网/);
  assert.deepEqual(hits, [], "桩上不该收到任何请求");
  assert.equal(listCustomProviders().length, 1, "只剩管理员共享的那条");
});

test("成员实例：自己的服务、shared 不认；放开内网后能加，再收紧时真对话前拦下；不跟随重定向", async () => {
  process.env.DIMENSIO_TENANT_PRIVATE_ENDPOINTS = "1";
  const { provider } = await addCustomProvider({ name: "我的", baseUrl: base, apiKey: KEY, models: [model], shared: true });
  assert.equal(provider.shared, undefined, "成员没有「共享给成员」");
  assert.equal(isSharedProvider(provider.id), false);
  assert.equal(customProviderKey(provider.id), KEY);
  assert.equal(providerSpec(provider.id).custom?.managed, undefined);
  assert.deepEqual(listCustomProviders().map((p) => p.id), [SHARED, provider.id], "共享的在前、自己的在后");

  delete process.env.DIMENSIO_TENANT_PRIVATE_ENDPOINTS;
  hits.length = 0;
  await assert.rejects(() => drain(createAdapter({ provider: provider.id as any, apiKey: KEY, model: "chat-1" })), /公网/);
  assert.deepEqual(hits, []);

  // 公网地址 302 到内网：适配器不跟。桩本身在本机，所以适配器在收紧时建（带上不跟随重定向），发请求时再临时放开地址把关，
  // 只看重定向这一层
  process.env.DIMENSIO_TENANT_PRIVATE_ENDPOINTS = "1";
  const hop = await addCustomProvider({ name: "跳板", baseUrl: base.replace("/v1", "/hop/v1"), authStyle: "none", models: [model] });
  delete process.env.DIMENSIO_TENANT_PRIVATE_ENDPOINTS;
  const guarded = createAdapter({ provider: hop.provider.id as any, apiKey: "none", model: "chat-1" });
  process.env.DIMENSIO_TENANT_PRIVATE_ENDPOINTS = "1";
  hits.length = 0;
  await assert.rejects(() => drain(guarded), (e: any) => /redirect/i.test(String(e?.cause?.message ?? e?.message)));
  assert.deepEqual(hits, ["/hop/v1/chat/completions"], "只打到跳板一次，没跟着跳");
  delete process.env.DIMENSIO_TENANT_PRIVATE_ENDPOINTS;
});
