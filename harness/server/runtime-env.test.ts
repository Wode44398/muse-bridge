// Q15 / F5（ZCode F5、kimi K47 的 env 那一块）：环境变量集中登记的守卫。
//
// 修前：harness 服务端读 90 多个环境变量，散在 26 个文件里，大半没有任何说明；加一个开关不会有人知道，删一个开关文档也不会跟着删。
// 修后：全部登记在 server/runtime-env.ts（归属、用途、默认值、是不是凭据）；这里扫服务端代码（不含测试与测试夹具），读到的
// 变量——`process.env.X`、`fromEnv("X")`、`envMs("X", …)`——必须都登记过，登记了的必须有代码读；标成凭据的必须在子进程环境的
// 剔除名单里（凭据不被 Bash 这类子进程继承）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isSensitiveEnvName } from "./helper-proc.ts";
import { ENV_NAMES, ENV_REGISTRY } from "./runtime-env.ts";

const SERVER = path.dirname(fileURLToPath(import.meta.url));
// 测试与测试基础设施自己会设 / 删环境变量，不算「服务端读的开关」；登记表本身的注释里也写着读法示例
const SKIP_FILES = new Set(["test-setup.ts", "test-global.ts", "runtime-env.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "test-harness" || e.name === "node_modules") continue;
      out.push(...sourceFiles(p));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !SKIP_FILES.has(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const READ_PATTERNS = [/process\.env\.([A-Z][A-Z0-9_]*)/g, /\b(?:fromEnv|envMs)\(\s*"([A-Z][A-Z0-9_]*)"/g];

export function envReads(root = SERVER): Map<string, string> {
  const seen = new Map<string, string>(); // 变量名 → 第一次出现的文件
  for (const file of sourceFiles(root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const re of READ_PATTERNS) {
      for (const m of text.matchAll(re)) if (!seen.has(m[1])) seen.set(m[1], path.relative(root, file));
    }
  }
  return seen;
}

test("Q15 环境变量：服务端代码读到的都登记了，登记的都有代码读", () => {
  const seen = envReads();
  assert.ok(seen.size > 50, `只扫到 ${seen.size} 个变量——扫描的写法大概漏了`);
  const unregistered = [...seen].filter(([name]) => !ENV_NAMES.has(name)).map(([name, file]) => `${name}（${file}）`);
  assert.deepEqual(unregistered, [], `这些环境变量没在 server/runtime-env.ts 登记（写清归属、用途、默认值，凭据标 secret）：\n  ${unregistered.join("\n  ")}`);
  const unused = ENV_REGISTRY.filter((v) => !seen.has(v.name)).map((v) => v.name);
  assert.deepEqual(unused, [], `登记了却没有代码读（删了开关就把登记也删掉）：${unused.join("、")}`);
});

test("Q15 环境变量：名字不重复、说明不空；标成凭据的都在子进程环境的剔除名单里", () => {
  const names = ENV_REGISTRY.map((v) => v.name);
  assert.equal(new Set(names).size, names.length, "登记里有重名");
  for (const v of ENV_REGISTRY) {
    assert.match(v.name, /^[A-Z][A-Z0-9_]*$/, v.name);
    assert.ok(v.description.trim().length >= 4, `${v.name} 没写用途`);
    if (v.secret) assert.ok(isSensitiveEnvName(v.name), `${v.name} 标成了凭据，却不在子进程环境的剔除名单里（helper-proc.ts）——会被 Bash 这类子进程继承`);
  }
});
