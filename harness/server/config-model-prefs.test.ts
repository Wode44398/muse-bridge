// 切厂商继承这家上次用的型号（维护者 10-11：「一切换 claude 模型就默认是 sonnet4.6」——常用 Opus 5.5 就该默认 Opus 5.5）。
// 没用过这家才回厂商默认；Claude 的厂商默认也换成了当前主力 Opus 5.5。
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { defaultModel } from "./catalog.ts";
import { configWritesSettled, getConfig, setConfig } from "./config.ts";

test("Claude 的厂商默认是 Opus 5.5，不是老的 Sonnet 4.6", () => {
  assert.equal(defaultModel("anthropic"), "claude-opus-5-5");
});

test("切走再切回：继承这家上次用的型号与深度，并落盘", async () => {
  setConfig({ provider: "anthropic", model: "claude-haiku-5-5", thinking: "max" });
  setConfig({ provider: "openai" });
  assert.equal(getConfig().model, "deepseek-flash", "没用过的 DeepSeek 用厂商默认");
  setConfig({ provider: "anthropic" });
  assert.equal(getConfig().model, "claude-haiku-5-5", "回到 Claude 继承上次的型号");
  assert.equal(getConfig().thinking, "max", "深度也一起继承");

  await configWritesSettled();
  const saved = JSON.parse(fs.readFileSync(process.env.DIMENSIO_CONFIG_FILE!, "utf8"));
  assert.deepEqual(saved.models.anthropic, { model: "claude-haiku-5-5", thinking: "max" });
  assert.equal(saved.models.openai.model, "deepseek-flash");
});

test("点名型号时照点名的来；换家后再点别的型号，偏好跟着更新", () => {
  setConfig({ provider: "anthropic", model: "claude-opus-5-5" });
  setConfig({ provider: "openai", model: "deepseek-v4-pro" });
  setConfig({ provider: "anthropic" });
  assert.equal(getConfig().model, "claude-opus-5-5");
  setConfig({ provider: "openai" });
  assert.equal(getConfig().model, "deepseek-v4-pro");
});
