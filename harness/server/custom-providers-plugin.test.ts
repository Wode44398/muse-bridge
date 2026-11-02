// bridge 插件提供的服务（2026-11-01，bridge 的 ctx.models.provide 勾了 dimensio）：bridge 写 custom-providers/plugin-providers.json，
// 这边现读并进「模型服务」——只能用、不能改；Key 跟着文件走（没有 = 不鉴权）；成员实例只认标了 shared 的；文件一改下次读就换。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  customProviderKey,
  customProviderPlugin,
  draftConn,
  isSharedProvider,
  listCustomProviders,
  NO_AUTH_KEY,
  removeCustomProvider,
  setCustomSecretsForTests,
  updateCustomProvider,
} from "./custom-providers.ts";
import { providerSpec } from "./catalog.ts";

const mk = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `dimensio-plugin-${tag}-`));
const ownDir = mk("own");
const adminDir = mk("admin");
const saved = { ...process.env };
process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = ownDir;
setCustomSecretsForTests({ readSecrets: () => ({}), writeSecrets: () => {} });
test.after(() => {
  for (const k of ["DIMENSIO_CUSTOM_PROVIDERS_DIR", "DIMENSIO_SHARED_PROVIDERS_DIR", "DIMENSIO_TENANT"]) process.env[k] = saved[k];
});

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: "Gemini 网页版",
  baseUrl: "http://127.0.0.1:8765",
  protocol: "anthropic",
  authStyle: "none",
  headers: [],
  models: ["gemini-argon"],
  modelSpecs: [
    {
      id: "gemini-argon",
      label: "Gemini 4 Argon",
      enabled: true,
      kind: "chat",
      contextWindow: 200000,
      maxOutput: 32000,
      vision: false,
      thinking: "effort",
      efforts: [
        { id: "medium", name: "标准", value: { gemini_thinking: false } },
        { id: "high", name: "深度思考", value: { gemini_thinking: true } },
      ],
      effortDefault: "medium",
    },
  ],
  defaultModel: "gemini-argon",
  createdAt: 0,
  plugin: { id: "gemini-web", name: "Gemini 网页版" },
  apiKey: "",
  ...extra,
});
const write = (dir: string, providers: unknown[]) => {
  const f = path.join(dir, "plugin-providers.json");
  fs.writeFileSync(f, JSON.stringify({ v: 2, providers }));
  // mtime 精度不够时同一毫秒写两次会被缓存挡住：手动推后
  const t = new Date(Date.now() + Math.floor(Math.random() * 100_000));
  fs.utimesSync(f, t, t);
};

test("管理员实例：插件服务并进列表，托管、带插件名，Key 跟文件走", async () => {
  write(ownDir, [entry("custom-0a0a0a0a"), entry("custom-0b0b0b0b", { name: "带 Key", apiKey: "sk-plugin" })]);
  const ids = listCustomProviders().map((p) => p.id);
  assert.ok(ids.includes("custom-0a0a0a0a") && ids.includes("custom-0b0b0b0b"));
  assert.equal(isSharedProvider("custom-0a0a0a0a"), true);
  assert.deepEqual(customProviderPlugin("custom-0a0a0a0a"), { id: "gemini-web", name: "Gemini 网页版" });
  assert.equal(customProviderKey("custom-0a0a0a0a"), NO_AUTH_KEY);
  assert.equal(customProviderKey("custom-0b0b0b0b"), "sk-plugin");

  const spec = providerSpec("custom-0a0a0a0a" as never) as { baseUrl?: string; custom?: Record<string, unknown>; models: { id: string }[] };
  assert.equal(spec.custom?.plugin, "Gemini 网页版");
  assert.equal(spec.custom?.managed, true);
  assert.equal(spec.baseUrl, undefined);
  assert.deepEqual(spec.models.map((m) => m.id), ["gemini-argon"]);

  await assert.rejects(updateCustomProvider("custom-0a0a0a0a", { name: "x" }), /插件「Gemini 网页版」/);
  await assert.rejects(removeCustomProvider("custom-0a0a0a0a"), /插件「Gemini 网页版」/);
  assert.throws(() => draftConn({ id: "custom-0a0a0a0a", baseUrl: "https://evil.example.com" }), /插件/);

  // 插件停用：bridge 重写成空表，下一次读就没了
  write(ownDir, []);
  assert.equal(listCustomProviders().some((p) => p.id === "custom-0a0a0a0a"), false);
  assert.equal(customProviderKey("custom-0a0a0a0a"), undefined);
});

test("成员实例：只认管理员那份里标了 shared 的插件服务", () => {
  write(adminDir, [entry("custom-0c0c0c0c", { shared: true }), entry("custom-0d0d0d0d")]);
  process.env.DIMENSIO_TENANT = "1";
  process.env.DIMENSIO_SHARED_PROVIDERS_DIR = adminDir;
  try {
    const ids = listCustomProviders().map((p) => p.id);
    assert.ok(ids.includes("custom-0c0c0c0c"));
    assert.ok(!ids.includes("custom-0d0d0d0d"));
    assert.equal(isSharedProvider("custom-0c0c0c0c"), true);
    assert.equal(customProviderKey("custom-0d0d0d0d"), undefined);
  } finally {
    delete process.env.DIMENSIO_TENANT;
    delete process.env.DIMENSIO_SHARED_PROVIDERS_DIR;
  }
});
