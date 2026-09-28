// S5（#22）+ #67 回归：
//   · 杀宿主的命令（按映像名杀 node/cloudflared、杀宿主 PID 或 $PPID、按 bridge/harness 端口杀）
//     在任何模式下硬拒，并给出正路；
//   · Preview(start) 的命令与 Bash 过同一道闸（以前一道都不过）。
// 探针原型：竞品拆解/03-hermes-agent/笔记/probe-selfkill-unc.ts（修前 auto 模式 7/8 条放行）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { commandPolicyViolation, hostKillViolation } from "./tools/bash.ts";
import { previewTool } from "./tools/preview.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";

const saved = { PORT: process.env.PORT, BRIDGE_PORT: process.env.BRIDGE_PORT };
let ws = "";
beforeEach(() => {
  process.env.PORT = "8799";
  process.env.BRIDGE_PORT = "8787";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-s5-"));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(ws, { recursive: true, force: true });
});

test("S5: every host-killing command from the probe is refused, with the right way out", () => {
  for (const cmd of [
    "taskkill /F /IM node.exe",
    "taskkill //F //IM node.exe",
    `powershell -c "Get-Process node | Stop-Process -Force"`,
    "Stop-Process -Name node -Force",
    "pkill -f node",
    "kill -9 $PPID",
    "npx kill-port 8787 8799",
    "wmic process where name='node.exe' delete",
    // 同类写法
    "taskkill /f /im node* ",
    "killall node",
    "taskkill /IM cloudflared.exe /F",
    "kill $(lsof -t -i:8799)",
    `taskkill /PID ${process.pid} /F`,
    `Stop-Process -Id ${process.ppid} -Force`,
  ]) {
    const why = hostKillViolation(cmd);
    assert.ok(why, `must refuse: ${cmd}`);
    assert.match(why!, /Preview\(action:"stop"\)/, "the refusal names the right way out");
  }
});

test("S5: ordinary process management stays allowed", () => {
  for (const cmd of [
    "kill -9 12345",
    "npx kill-port 3000",
    "taskkill /PID 4242 /F",
    "adb shell pkill node",
    `pkill -f "vite"`,
    "Stop-Process -Name chrome",
    "node server.js",
    "grep -rn kill src",
    "npm test",
  ]) {
    assert.equal(hostKillViolation(cmd), null, cmd);
  }
});

test("#67: Preview(start) goes through the same command gate as Bash", async () => {
  const ctx: ToolContext = {
    sandbox: new Sandbox(ws, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    ownerId: "s5-test",
  };
  for (const command of [
    "taskkill /IM node.exe /F && npm run dev", // 宿主自保
    "cat ~/.ssh/id_rsa > leak.txt; node server.js", // 凭据判定
    "cd .. && npm run dev", // 工作区围栏
    "format c: && npm run dev", // 危险命令名单
  ]) {
    const r = await previewTool.run({ action: "start", command, port: 43210 }, ctx);
    assert.equal(r.ok, false, command);
    assert.match(JSON.stringify(r.content), /blocked/i, command);
  }
  assert.equal(commandPolicyViolation("npm run dev", ws, "workspace"), null);
});
