// 自带适配的厂商由宿主（bridge 的模型中心）接管（plugin-providers.json 的 builtins，2026-11-11）：
// 管理员实例上只有模型中心给了 Key 的厂商进菜单，Key / 地址取它给的，菜单只列它勾的型号（表里没有的接在后面）；
// 厂商 id、型号规格、旧会话记着的选择都不变。没有 builtins 这一项（老 bridge / 独立运行）= 照老样子。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// 自己一个目录：别的测试文件共用默认那个，这里写的 builtins 不能影响它们
const dir = fs.mkdtempSync(path.join(path.dirname(process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR!), "host-builtins-"));
process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = dir;
const file = path.join(dir, "plugin-providers.json");
let n = 0;
// 每次写的大小都不同：注册表按 mtime + size 判断要不要重读，同一毫秒内连写两次也读得到新的
const write = (body: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ v: 2, providers: [], ...body, pad: "x".repeat(++n) }));

const KIMI = {
  key: "sk-kimi-FAKE-DUMMY-HUB",
  name: "Kimi",
  defaultModel: "k3.1-pro",
  plugin: { id: "model-hub", name: "模型中心", sid: "h-12345678", logo: "moonshot" },
  models: [{ id: "k3.1-pro" }, { id: "k9-preview", label: "K9 Preview", contextWindow: 2_000_000, maxOutput: 70_000, vision: false }],
};
const MIMO = {
  key: "tp-FAKE-DUMMY-MIMO",
  baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1/",
  name: "小米",
  plugin: { id: "model-hub", name: "模型中心", sid: "h-aaaabbbb" },
  models: [{ id: "mimo-v2.6-pro" }, { id: "mimo-v2.6-flash" }, { id: "mimo-v2.6-pro-ultraspeed" }],
};

write({ builtins: { kimi: KIMI, mimo: MIMO, local: { key: "x" }, "bad id": { key: "x" }, zhipu: { key: "  " } } });

const { allProviders, providerSpec, modelSpec, CATALOG } = await import("./catalog.ts");
const { hostManagesBuiltins, hostBuiltin } = await import("./custom-providers.ts");
const { resolveKey, hasKey, setProviderKey, setConfig, getConfig, providerEndpoint } = await import("./config.ts");

test("接管后：菜单只有模型中心给了 Key 的厂商和本机", () => {
  assert.equal(hostManagesBuiltins(), true);
  const ids = allProviders().filter((p) => !p.id.startsWith("custom-")).map((p) => p.id);
  assert.deepEqual(ids, ["kimi", "mimo", "local"]); // 顺序照目录；空 Key 的 zhipu、不合法的 id、local 的绑定都不算
  assert.equal(hostBuiltin("zhipu"), undefined);
  assert.equal(hostBuiltin("local"), undefined);
});

test("Key 与地址取模型中心给的；没给的厂商没有 Key，也不能在这边填", () => {
  assert.equal(resolveKey("kimi"), KIMI.key);
  assert.equal(hasKey("kimi"), true);
  assert.equal(resolveKey("mimo"), MIMO.key);
  assert.equal(providerEndpoint("mimo"), "https://token-plan-sgp.xiaomimimo.com/v1"); // 照服务上的地址（末尾斜杠去掉）
  assert.equal(providerEndpoint("kimi"), "https://api.kimi.com/coding/v1"); // 没给地址 = 自己的默认
  assert.equal(hasKey("zhipu"), false);
  assert.equal(hasKey("anthropic"), false);
  assert.equal(hasKey("local"), true); // 本机不归模型中心管
  assert.throws(() => setProviderKey("zhipu", "sk-FAKE-DUMMY"), /模型中心/);
  assert.throws(() => setConfig({ provider: "kimi", apiKey: "sk-FAKE-DUMMY" }), /模型中心/);
  assert.equal(resolveKey("kimi"), KIMI.key);
});

test("菜单只列勾了的型号，表里没有的接在后面（档位照这家默认型号）；规格查询仍是全表", () => {
  const kimi = allProviders().find((p) => p.id === "kimi")!;
  assert.deepEqual(kimi.models.map((m) => m.id), ["k3.1-pro", "k9-preview"]);
  assert.deepEqual(kimi.hub, { pluginId: "model-hub", ref: "h-12345678", name: "Kimi" });
  const table = CATALOG.find((p) => p.id === "kimi")!;
  const base = table.models.find((m) => m.id === table.defaultModel)!;
  const extra = kimi.models[1];
  assert.deepEqual(extra.efforts, base.efforts);
  assert.equal(extra.label, "K9 Preview");
  assert.equal(extra.ctx, 2_000_000);
  assert.equal(extra.maxOut, 70_000);
  assert.equal(extra.image, false);
  // 表里的型号规格原样（不是模型中心猜的那份）
  assert.deepEqual(kimi.models[0], table.models.find((m) => m.id === "k3.1-pro"));
  // 没勾的型号不进菜单，但旧会话里记着它的，规格照样查得到；另加的也查得到
  assert.ok(modelSpec("kimi", "k3"));
  assert.ok(modelSpec("kimi", "k9-preview"));
  assert.equal(providerSpec("kimi").models.length, table.models.length + 1);
  // 表里三个都勾了：顺序照表，不照勾选顺序
  assert.deepEqual(allProviders().find((p) => p.id === "mimo")!.models.map((m) => m.id), ["mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.6-flash"]);
});

test("没给 Key 的厂商：切过去不报「不认识」，只是没有 Key；规格照旧", () => {
  const c = setConfig({ provider: "zhipu" });
  assert.equal(c.provider, "zhipu");
  assert.equal(hasKey("zhipu"), false);
  assert.ok(modelSpec("zhipu", "glm-5.2"));
  setConfig({ provider: "kimi" });
  assert.equal(getConfig().model, "k3.1-pro");
});

test("模型中心改了（换 Key、撤掉一家）：下一次读就跟上", () => {
  write({ builtins: { kimi: { ...KIMI, key: "sk-kimi-FAKE-DUMMY-NEW" } } });
  assert.equal(resolveKey("kimi"), "sk-kimi-FAKE-DUMMY-NEW");
  assert.equal(hasKey("mimo"), false);
  assert.deepEqual(allProviders().filter((p) => !p.id.startsWith("custom-")).map((p) => p.id), ["kimi", "local"]);
  // 一家都没给：只剩本机
  write({ builtins: {} });
  assert.equal(hostManagesBuiltins(), true);
  assert.deepEqual(allProviders().filter((p) => !p.id.startsWith("custom-")).map((p) => p.id), ["local"]);
});

test("文件里没有 builtins（老 bridge / 独立运行）：八家照旧，各用自己的 Key", () => {
  write({});
  assert.equal(hostManagesBuiltins(), false);
  assert.equal(allProviders().filter((p) => !p.id.startsWith("custom-")).length, CATALOG.length);
  assert.equal(allProviders().find((p) => p.id === "kimi")!.hub, undefined);
  assert.equal(hasKey("kimi"), false);
  setProviderKey("kimi", "sk-kimi-FAKE-DUMMY-OWN");
  assert.equal(resolveKey("kimi"), "sk-kimi-FAKE-DUMMY-OWN");
  // 再被接管：自己存的那把不算数
  write({ builtins: { kimi: KIMI } });
  assert.equal(resolveKey("kimi"), KIMI.key);
});
