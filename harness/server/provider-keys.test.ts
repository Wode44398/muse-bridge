// 设置页逐家填内置厂商的 key（POST /api/provider-keys → setProviderKey）：只存 key，不动当前厂商 / 型号；
// 本机、自定义服务、不认识的厂商、空 key 一律拒。
import assert from "node:assert/strict";
import test from "node:test";
import { getConfig, hasKey, setConfig, setProviderKey } from "./config.ts";

test("给别的厂商存 key：那家变成有 key，当前厂商与型号不变", () => {
  setConfig({ provider: "anthropic", model: "claude-opus-5-5" });
  const before = getConfig();
  setProviderKey("kimi", "  sk-kimi-FAKE-DUMMY-KEY  ");
  assert.equal(hasKey("kimi"), true);
  const after = getConfig();
  assert.equal(after.provider, before.provider);
  assert.equal(after.model, before.model);
  assert.equal(after.thinking, before.thinking);
});

test("本机、自定义服务、不认识的厂商、空 key 拒绝", () => {
  assert.throws(() => setProviderKey("local", "FAKE"), /unknown provider/);
  assert.throws(() => setProviderKey("custom-abc", "FAKE"), /unknown provider/);
  assert.throws(() => setProviderKey("nope", "FAKE"), /unknown provider/);
  assert.throws(() => setProviderKey("zhipu", "   "), /apiKey is required/);
  assert.throws(() => setProviderKey("zhipu", 42), /apiKey is required/);
});
