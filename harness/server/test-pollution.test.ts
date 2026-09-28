// #14 回归（Q8 根治）：测试往生产目录里写东西。
//
// 当初的漏法：几个测试收尾时 `delete process.env.MEMORY_DIR` / `KNOWLEDGE_DIR`，之后同一进程里的写入就按
// process.cwd() 回落——测试正是在 harness/ 下跑的，于是生产的 memory/workspaces、knowledge/workspaces 里攒下
// 650 个测试桶，一条测试记忆还被提交进了库。修后：测试进程里解析到临时目录之外的数据位置直接抛错（paths.ts）。
// 本文件刻意不引用 paths.ts，只走真实的写入入口，修前修后都能跑。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { saveMemory } from "./memory.ts";
import { ensureProjectKnowledge } from "./knowledge.ts";

const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listing(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set();
  }
}

// 模拟旧测试的收尾：删掉变量（而不是还原），再照常写一次。
async function afterDelete(name: string, write: () => unknown): Promise<unknown> {
  const saved = process.env[name];
  delete process.env[name];
  try {
    return await write();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test("#14：MEMORY_DIR 被删掉后写记忆——抛错，生产 memory/workspaces 里不多出测试桶", async () => {
  const prod = path.join(harnessRoot, "memory", "workspaces");
  const before = listing(prod);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-q8-leak-ws-"));
  try {
    await assert.rejects(
      afterDelete("MEMORY_DIR", () =>
        saveMemory(ws, {
          title: "Q8 leak probe",
          description: "若这条出现在生产目录里，说明测试隔离又漏了。",
          type: "project",
          topic: "q8.leak",
          status: "proposed",
          confidence: "inferred",
          content: "probe",
        }),
      ),
      /测试进程解析到了临时目录之外的记忆目录/,
    );
  } finally {
    const leaked = [...listing(prod)].filter((n) => !before.has(n));
    for (const n of leaked) fs.rmSync(path.join(prod, n), { recursive: true, force: true }); // 修前跑红时顺手清掉
    fs.rmSync(ws, { recursive: true, force: true });
    assert.deepEqual(leaked, [], "测试桶写进了生产 memory/workspaces");
  }
});

test("#14：KNOWLEDGE_DIR 被删掉后建项目知识——抛错，生产 knowledge/workspaces 里不多出测试桶", async () => {
  const prod = path.join(harnessRoot, "knowledge", "workspaces");
  const before = listing(prod);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-q8-leak-proj-"));
  fs.writeFileSync(path.join(ws, "package.json"), "{}\n");
  try {
    await assert.rejects(
      afterDelete("KNOWLEDGE_DIR", () => ensureProjectKnowledge(ws)),
      /测试进程解析到了临时目录之外的项目知识目录/,
    );
  } finally {
    const leaked = [...listing(prod)].filter((n) => !before.has(n));
    for (const n of leaked) fs.rmSync(path.join(prod, n), { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    assert.deepEqual(leaked, [], "测试桶写进了生产 knowledge/workspaces");
  }
});
