// D2：harness 引 bridge 核心（加密存储、共用型号知识）在两种形态下都要找得到——
//   · 仓库直跑：顺着 ../../src 回落；
//   · dimensio 离线包（装在数据目录，包里没有 src/）：靠 bridge 拉起 harness 时带的 @bridge/core 钩子。
// 以前 custom-providers.ts / mcp.ts 写死 ../../src/extension-secrets.mjs，离线安装版加不了自定义服务、也读不到 MCP 凭据。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { coreModule, coreUrl } from "./core-link.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_SRC = path.resolve(HERE, "..", "..", "src");
const REGISTER = pathToFileURL(path.join(REPO_SRC, "modules", "register.mjs")).href;

test("仓库直跑：回落到 ../../src，拿到的是同一个模块实例", async () => {
  const url = coreUrl("model-knowledge/index.mjs");
  assert.equal(fileURLToPath(url).toLowerCase(), path.join(REPO_SRC, "model-knowledge", "index.mjs").toLowerCase());
  const sync = coreModule<{ guessModel: unknown }>("model-knowledge/index.mjs");
  const esm = await import(url);
  assert.equal(sync.guessModel, esm.guessModel);
  assert.ok(fs.existsSync(fileURLToPath(coreUrl("extension-secrets.mjs"))));
});

test("离线包布局（harness 在数据目录、包里没有 src/）：带核心钩子时解析到程序目录的 src；不带就找不到", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-offline-layout-"));
  try {
    const server = path.join(root, "modules", "dimensio", "harness", "server");
    fs.mkdirSync(server, { recursive: true });
    fs.copyFileSync(path.join(HERE, "core-link.ts"), path.join(server, "core-link.ts"));
    fs.writeFileSync(
      path.join(server, "probe.ts"),
      [
        'import { existsSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'import { coreModule, coreUrl } from "./core-link.ts";',
        'const secrets = fileURLToPath(coreUrl("extension-secrets.mjs"));',
        "let models = 0;",
        'try { models = (coreModule("model-knowledge/index.mjs") as any).guessModel("mimo-v2.6-pro", { protocol: "openai" }).contextWindow; } catch {}',
        "console.log(JSON.stringify({ secrets, exists: existsSync(secrets), models }));",
      ].join("\n"),
    );
    const run = (withHook: boolean) => {
      const r = spawnSync(process.execPath, [...(withHook ? ["--import", REGISTER] : []), "probe.ts"], { cwd: server, encoding: "utf8", timeout: 30_000 });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split("\n").pop()!);
    };
    const hooked = run(true);
    assert.equal(hooked.exists, true);
    assert.equal(hooked.secrets.toLowerCase(), path.join(REPO_SRC, "extension-secrets.mjs").toLowerCase());
    assert.equal(hooked.models, 1_000_000, "共用型号知识也经同一个钩子拿到");
    const bare = run(false);
    assert.equal(bare.exists, false, "没有钩子时只能回落到包里不存在的 ../../src——这就是 bridge 拉起 harness 一律带 --import 钩子的原因");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
