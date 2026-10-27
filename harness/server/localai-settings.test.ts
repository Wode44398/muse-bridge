// 本机模型启动参数（「本机」面板）：清洗规则，以及保存后目录里本机型号的上下文 / 识图跟着变。
// 设置文件经 test-setup.ts 的 LOCAL_AI_SETTINGS / STRATA_AI_SETTINGS 改道到临时根，不碰 E:\LLM、E:\Strata 下的真文件。
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { modelSpec } from "./catalog.ts";
import {
  cleanLocalAiSettings,
  cleanStrataSettings,
  engineOfModel,
  LOCAL_AI_DEFAULTS,
  localAiSettings,
  localModelBaseUrl,
  saveLocalAiSettings,
  STRATA_DEFAULTS,
  STRATA_MODEL,
  strataSettings,
} from "./localai.ts";

test("本机启动参数：非法值回落，不认识的上下文档不收", () => {
  assert.deepEqual(cleanLocalAiSettings(null), LOCAL_AI_DEFAULTS);
  assert.deepEqual(cleanLocalAiSettings({ ctx: 100_000, kv: "f16", vision: "yes", mtp: 0 }), LOCAL_AI_DEFAULTS);
  assert.deepEqual(cleanLocalAiSettings({ ctx: 262_144, kv: "q4_0", vision: false, mtp: false }), {
    ctx: 262_144,
    kv: "q4_0",
    vision: false,
    mtp: false,
  });
  // 只给一部分：其余沿用传入的底
  assert.deepEqual(cleanLocalAiSettings({ kv: "q8q4" }, { ctx: 65_536, kv: "q4_0", vision: false, mtp: true }), {
    ctx: 65_536,
    kv: "q8q4",
    vision: false,
    mtp: true,
  });
});

test("本机启动参数：保存后目录的上下文与识图跟着设置走", () => {
  const file = process.env.LOCAL_AI_SETTINGS!;
  try {
    assert.equal(modelSpec("local", "qwen3.8-27b")?.ctx, LOCAL_AI_DEFAULTS.ctx);
    assert.equal(modelSpec("local", "qwen3.8-27b")?.image, true);
    saveLocalAiSettings({ ctx: 262_144, kv: "q4_0", vision: false });
    assert.deepEqual(localAiSettings(), { ctx: 262_144, kv: "q4_0", vision: false, mtp: true });
    const m = modelSpec("local", "qwen3.8-27b");
    assert.equal(m?.ctx, 262_144);
    assert.equal(m?.image, false);
  } finally {
    rmSync(file, { force: true });
  }
  assert.deepEqual(localAiSettings(), LOCAL_AI_DEFAULTS);
});

test("Strata 启动参数：非法值回落；没有 MTP 开关（服务模式必带），换成 KV 流式", () => {
  assert.deepEqual(cleanStrataSettings(null), STRATA_DEFAULTS);
  // Qwen 那套的档位不认：192k 上下文、q8_0 缓存、mtp 字段
  assert.deepEqual(cleanStrataSettings({ ctx: 196_608, kv: "q8_0", vision: 1, mtp: false }), STRATA_DEFAULTS);
  // 32k 不给选（dimensio 第一轮的提示词 + max_tokens 就超，Strata 直接拒）：存着旧值的按默认上下文算
  assert.equal(cleanStrataSettings({ ctx: 32_768 }).ctx, STRATA_DEFAULTS.ctx);
  assert.deepEqual(cleanStrataSettings({ ctx: 262_144, kv: "k8v4", vision: true, stream: false }), {
    ctx: 262_144,
    kv: "k8v4",
    vision: true,
    stream: false,
  });
});

test("Strata 启动参数：两台引擎各存各的，目录里各自的型号各跟各的", () => {
  const file = process.env.STRATA_AI_SETTINGS!;
  try {
    assert.equal(modelSpec("local", STRATA_MODEL)?.ctx, STRATA_DEFAULTS.ctx);
    assert.equal(modelSpec("local", STRATA_MODEL)?.image, false);
    saveLocalAiSettings({ ctx: 65_536, vision: true }, "strata");
    assert.deepEqual(strataSettings(), { ...STRATA_DEFAULTS, ctx: 65_536, vision: true });
    assert.equal(modelSpec("local", STRATA_MODEL)?.ctx, 65_536);
    assert.equal(modelSpec("local", STRATA_MODEL)?.image, true);
    // Qwen 那台不受影响
    assert.deepEqual(localAiSettings(), LOCAL_AI_DEFAULTS);
    assert.equal(modelSpec("local", "qwen3.8-27b")?.ctx, LOCAL_AI_DEFAULTS.ctx);
  } finally {
    rmSync(file, { force: true });
  }
  assert.deepEqual(strataSettings(), STRATA_DEFAULTS);
});

test("本机型号按型号走端点：Strata 去 8081，Qwen 沿用会话地址", () => {
  assert.equal(engineOfModel(STRATA_MODEL), "strata");
  assert.equal(engineOfModel("qwen3.8-27b"), "qwen");
  assert.equal(localModelBaseUrl(STRATA_MODEL), "http://127.0.0.1:8081/v1");
  assert.equal(localModelBaseUrl("qwen3.8-27b"), undefined);
});
