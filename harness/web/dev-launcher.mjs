// 起 harness 新前端 dev server（vite 5178）。
// API 代理目标用 HARNESS_API 覆盖（默认 8801 旁路实例，避免打扰 live 8799）。
// 旁路后端起法：PORT=8801 WORKSPACE_DIR=<临时目录> SESSIONS_DIR=<临时目录> node server/index.ts
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.HARNESS_API = process.env.HARNESS_API || "http://127.0.0.1:8801";

const child = spawn("npm", ["run", "dev"], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  stdio: "inherit",
  shell: true,
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
