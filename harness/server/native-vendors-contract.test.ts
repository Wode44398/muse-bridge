// 模型中心那边登记的「dimensio 自带适配的厂商」（src/model-knowledge/dimensio-native.mjs）必须和这里的 CATALOG 对得上：
// 迁移时按那份表给每家建模型中心服务（地址、协议、型号清单），漏一个型号 = 迁移后菜单里少一个。改 CATALOG 时那边跟着改。
import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG } from "./catalog.ts";
import { coreUrl } from "./core-link.ts";

const N = (await import(coreUrl("model-knowledge/dimensio-native.mjs"))) as {
  NATIVE_VENDORS: { id: string; name: string; protocol: string; baseUrl: string; models: { id: string; label: string; contextWindow: number; maxOutput: number; vision: boolean }[] }[];
  nativeVendorOf: (u: string) => string;
  nativeEndpoint: (v: string, s: { kind: string; baseUrl: string }) => string;
};
const protocolOf = (p: string) => (p === "anthropic" ? "anthropic" : p === "gemini" ? "gemini" : "openai");

test("厂商一家不多一家不少（本机除外），地址、协议、型号清单逐项一致", () => {
  assert.deepEqual(N.NATIVE_VENDORS.map((v) => v.id), CATALOG.filter((p) => p.id !== "local").map((p) => p.id));
  for (const v of N.NATIVE_VENDORS) {
    const spec = CATALOG.find((p) => p.id === v.id)!;
    assert.equal(v.name, spec.name, v.id);
    assert.equal(v.protocol, protocolOf(v.id), v.id);
    if (spec.baseUrl) assert.equal(v.baseUrl, spec.baseUrl, v.id);
    assert.deepEqual(
      v.models,
      spec.models.map((m) => ({ id: m.id, label: m.label, contextWindow: m.ctx, maxOutput: m.maxOut, vision: m.image })),
      v.id,
    );
  }
});

test("按地址认厂商：自己的默认地址都认得出；别家的地址不认", () => {
  for (const v of N.NATIVE_VENDORS) assert.equal(N.nativeVendorOf(v.baseUrl), v.id, v.id);
  assert.equal(N.nativeVendorOf("https://api.deepseek.com/anthropic"), "openai"); // 给 Claude 用的入口也是这一家
  assert.equal(N.nativeVendorOf("https://token-plan-cn.xiaomimimo.com/anthropic"), "mimo");
  assert.equal(N.nativeVendorOf("https://api.moonshot.cn/anthropic"), ""); // 开放平台的 Key 和 Kimi for Coding 不通用
  assert.equal(N.nativeVendorOf("https://openrouter.ai/api/v1"), "");
  assert.equal(N.nativeVendorOf("https://evil-api.deepseek.com.example.org/v1"), "");
  assert.equal(N.nativeVendorOf("not a url"), "");
});

test("专门适配打哪个地址：协议对得上照服务填的；填的是 /anthropic 入口时只有随主机名变的两家按主机名推", () => {
  assert.equal(N.nativeEndpoint("zhipu", { kind: "openai", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/" }), "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(N.nativeEndpoint("openai", { kind: "anthropic", baseUrl: "https://api.deepseek.com/anthropic" }), "");
  assert.equal(N.nativeEndpoint("mimo", { kind: "anthropic", baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic" }), "https://token-plan-sgp.xiaomimimo.com/v1");
  assert.equal(N.nativeEndpoint("qwen", { kind: "anthropic", baseUrl: "https://dashscope-intl.aliyuncs.com/apps/anthropic" }), "https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
  assert.equal(N.nativeEndpoint("anthropic", { kind: "anthropic", baseUrl: "https://api.anthropic.com" }), "");
  assert.equal(N.nativeEndpoint("gemini", { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }), "");
});
