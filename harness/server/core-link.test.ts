// harness 引 bridge 核心（加密存储、共用型号知识）都经 core-link：顺着 ../../src 找到仓库里的核心模块，
// 同步与 ESM 两条路拿到的是同一个模块实例。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { coreModule, coreUrl } from "./core-link.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_SRC = path.resolve(HERE, "..", "..", "src");

test("仓库直跑：回落到 ../../src，拿到的是同一个模块实例", async () => {
  const url = coreUrl("model-knowledge/index.mjs");
  assert.equal(fileURLToPath(url).toLowerCase(), path.join(REPO_SRC, "model-knowledge", "index.mjs").toLowerCase());
  const sync = coreModule<{ guessModel: unknown }>("model-knowledge/index.mjs");
  const esm = await import(url);
  assert.equal(sync.guessModel, esm.guessModel);
  assert.ok(fs.existsSync(fileURLToPath(coreUrl("extension-secrets.mjs"))));
});
