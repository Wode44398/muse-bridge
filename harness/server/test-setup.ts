// 测试全局兜底（经 package.json 的 node --import 挂载；npm test 的父进程和每个测试文件子进程都会先跑到这里）。
//
// Q8（K04 / N38，根治 #14）：数据位置【无条件】改道到一个临时根——不看 shell 里继承来的值（有人 export 了生产
// 路径再跑测试也不认）。第一个跑到这里的进程（npm test 的父进程）建这一套并打上 DIMENSIO_TEST_ISOLATION 标记，
// 各测试文件子进程、测试里 spawn 的真 harness 都继承同一套；父进程退出时整根删掉。paths.ts 在解析点再兜一道：
// 测试进程解析到临时目录之外的数据位置直接抛错。以前这里只改道 sessions / config / quick 三样且「有值就沿用」，
// memory / knowledge 漏了——生产目录里攒下 650 个测试桶，一条测试记忆还被提交进了库（#14）。
//
// 测试内自设这些变量后，收尾要还原成进入时的值，不要 delete（delete 之后一解析就抛错）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSensitiveEnvName } from "./helper-proc.ts";

// 继承来的凭据（各家 key、harness 令牌、桌面壳 broker 地址……）一律删掉：测试只用带 FAKE / DUMMY 字样的假值。
for (const name of Object.keys(process.env)) {
  if (isSensitiveEnvName(name)) delete process.env[name];
}

if (process.env.DIMENSIO_TEST_ISOLATION !== "1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-test-data-"));
  const at = (name: string) => path.join(root, name);
  fs.mkdirSync(at("workspace"));
  Object.assign(process.env, {
    DIMENSIO_TEST_ISOLATION: "1",
    SESSIONS_DIR: at("sessions"),
    MEMORY_DIR: at("memory"),
    KNOWLEDGE_DIR: at("knowledge"),
    DIMENSIO_CONFIG_FILE: at("runtime-config.json"),
    DIMENSIO_QUICK_FILE: at("quick.json"),
    DIMENSIO_QUICK_ROOT: at("quick"),
    DIMENSIO_CUSTOM_PROVIDERS_DIR: at("custom-providers"),
    PROJECTS_FILE: at("projects.json"),
    PROJECTS_ROOT: at("projects"),
    WORKSPACE_DIR: at("workspace"),
    DIMENSIO_GLOBAL_GUIDE: at("GUIDE.md"), // 不存在：测试不注入本机真实的全局 GUIDE
    HARNESS_ENV_FILE: at("no.env"), // 不存在：测试里拉起的 harness 不加载任何 .env
    LOCAL_AI_SETTINGS: at("local-ai.json"), // 不存在：本机型号的上下文 / 识图按目录默认值，不跟着面板里的真实设置变
  });
  process.on("exit", () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄占用就留给 test-global 的清扫 */ }
  });
}
