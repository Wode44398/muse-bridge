// 「dimensio 记不住上次用的模型」的回归。
//
// 真因不在加载侧（loadSavedChoice 一直是对的），而在【谁把它写坏了】：choiceFile()
// 默认按 process.cwd() 解析 runtime-config.json，而测试就是在 harness/ 根下跑的，
// 于是 session.test.ts 里一句 setConfig({provider:"openai"}) 把【生产】的选择覆盖成
// openai/deepseek-v4-pro。用户完全没动过设置，只要有谁在 harness 目录跑过一次测试
// （agent 改 harness 时家常便饭），下次重启就回默认了。
//
// 实测复现：手动把 runtime-config.json 写成 kimi/k3 → 跑一个测试文件 → 变回
// openai/deepseek-v4-pro。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configWritesSettled, setConfig } from "./config.ts";

const harnessRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const prodChoiceFile = path.join(harnessRoot, "runtime-config.json");

test("测试进程被指向临时配置文件，绝不写生产的 runtime-config.json", () => {
  const routed = process.env.DIMENSIO_CONFIG_FILE?.trim();
  assert.ok(routed, "test-setup.ts 必须给测试指一个 DIMENSIO_CONFIG_FILE");
  assert.notEqual(path.resolve(routed!), prodChoiceFile, "绝不能指回生产那份");
  assert.ok(path.resolve(routed!).startsWith(path.resolve(os.tmpdir())), "应当落在临时目录里");
});

test("setConfig 之后生产文件一个字节都没动", async () => {
  const before = fs.existsSync(prodChoiceFile) ? fs.readFileSync(prodChoiceFile, "utf8") : null;

  // 正是 session.test.ts / websearch.test.ts 里那种调用。
  setConfig({ provider: "openai", apiKey: "sk-not-a-real-key" });
  setConfig({ provider: "gemini", apiKey: "not-a-real-key" });
  // 落盘是排队异步的：等队列落地（以前固定睡 200ms，全量并发下写盘带 fsync 会更慢，误报过）。
  await configWritesSettled();

  const after = fs.existsSync(prodChoiceFile) ? fs.readFileSync(prodChoiceFile, "utf8") : null;
  assert.equal(after, before, "生产的厂商/模型选择被测试覆盖了");
});

test("显式指定 DIMENSIO_CONFIG_FILE 时，持久化本身照常工作（没被兜底一刀切关掉）", async () => {
  const routed = process.env.DIMENSIO_CONFIG_FILE!;
  setConfig({ provider: "gemini" });
  await configWritesSettled();
  assert.equal(fs.existsSync(routed), true, "改道后的文件应当真的被写出来");
  const saved = JSON.parse(fs.readFileSync(routed, "utf8"));
  assert.equal(saved.provider, "gemini");
});
