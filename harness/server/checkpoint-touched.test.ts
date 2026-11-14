// 大工作区的检查点只备份编辑工具改过的文件（scope touched）。来历：2026-11-13 在 D:\Notes（所有项目的集合目录）
// 里，开跑前的整目录快照（read-tree --empty + add -A）跑了 5 分钟还没完，模型请求一直没发出去。现在工作区太大
// （文件数 / 体积超阈值，或拍快照超时）的会话改走 Claude Code 的做法：Write / Edit 改文件之前先备份那一个文件。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import {
  changedPathsSinceCheckpoint,
  noteBeforeWrite,
  recordRunEnd,
  rollbackPlan,
  rollbackTo,
  sessionChangeList,
  takeCheckpoint,
} from "./checkpoints.ts";
import type { PersistedSession } from "./store.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
const ENV_KEYS = ["CHECKPOINT_MODE", "CHECKPOINT_FULL_MAX_FILES", "CHECKPOINT_STAGE_BUDGET_MS"] as const;
const BASE_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  if (BASE_SESSIONS_DIR !== undefined) process.env.SESSIONS_DIR = BASE_SESSIONS_DIR; // 还原，不 delete（见 test-setup.ts）
  for (const k of ENV_KEYS) {
    if (BASE_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = BASE_ENV[k];
  }
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function record(id: string, workspace: string, messages = 0): PersistedSession {
  return {
    v: 1,
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: id,
    config: { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace, access: "workspace" },
    system: "test",
    messages: Array.from({ length: messages }, (_, i) => ({ role: "user" as const, content: [{ t: "text" as const, text: `m${i}` }] })),
    todos: [],
    totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  } as PersistedSession;
}

const put = (work: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  fs.writeFileSync(path.join(work, rel), text, "utf8");
};
const read = (work: string, rel: string) => (fs.existsSync(path.join(work, rel)) ? fs.readFileSync(path.join(work, rel), "utf8") : null);
// 编辑工具的做法：先备份，再写
async function toolWrite(id: string, work: string, rel: string, text: string): Promise<void> {
  await noteBeforeWrite(id, work, path.join(work, rel));
  put(work, rel, text);
}

test("文件数超过阈值：自动改走只备份改过的文件；回滚只动编辑工具改过的文件，之后才接管的也补齐到原样", async () => {
  const work = temp("dimensio-cptouch-work-");
  process.env.SESSIONS_DIR = temp("dimensio-cptouch-state-");
  process.env.CHECKPOINT_FULL_MAX_FILES = "3";
  for (const f of ["a.txt", "b.txt", "d.txt", "lib/e.txt", "lib/f.txt"]) put(work, f, "v0");

  // 第一轮
  const cp1 = await takeCheckpoint(record("t1", work), work, "第一轮");
  assert.ok(cp1);
  assert.equal(cp1.scope, "touched");
  assert.equal(cp1.scopeStarted, true);
  await toolWrite("t1", work, "a.txt", "v1"); // 编辑工具改
  await toolWrite("t1", work, "new/c.txt", "v1"); // 编辑工具新建
  put(work, "b.txt", "bash"); // Bash 改的：不接管
  assert.deepEqual((await changedPathsSinceCheckpoint("t1", cp1.n, work)).sort(), ["a.txt", "new/c.txt"]);
  await recordRunEnd("t1", work, cp1.n);

  // 第二轮：又接管了一个第一轮没碰过的文件
  const cp2 = await takeCheckpoint(record("t1", work, 2), work, "第二轮");
  assert.ok(cp2);
  assert.equal(cp2.scope, "touched");
  assert.equal(cp2.scopeStarted, undefined);
  await toolWrite("t1", work, "d.txt", "v2");
  await toolWrite("t1", work, "a.txt", "v2");
  await recordRunEnd("t1", work, cp2.n);

  const review = await sessionChangeList("t1", work);
  assert.ok(review);
  assert.deepEqual(
    review.files.map((f) => `${f.st} ${f.path}`).sort(),
    ["A new/c.txt", "M a.txt", "M d.txt"],
  );

  const plan = await rollbackPlan("t1", cp1.n, work);
  assert.deepEqual(plan.changes.sort(), ["a.txt", "d.txt", "new/c.txt"]);
  assert.deepEqual(plan.external, []);

  // 回到第一轮之前：a、d 回到 v0（d 是第二轮才接管的——按它被接管时的样子补齐），c 删掉连空目录，b（Bash 改的）不动
  await rollbackTo("t1", cp1.n, work);
  assert.equal(read(work, "a.txt"), "v0");
  assert.equal(read(work, "d.txt"), "v0");
  assert.equal(read(work, "new/c.txt"), null);
  assert.equal(fs.existsSync(path.join(work, "new")), false);
  assert.equal(read(work, "b.txt"), "bash");
  assert.equal(read(work, "lib/e.txt"), "v0");
});

test("小工作区照旧整目录快照：Bash 改的也回滚得了", async () => {
  const work = temp("dimensio-cptouch-small-");
  process.env.SESSIONS_DIR = temp("dimensio-cptouch-state-");
  put(work, "a.txt", "v0");
  const cp = await takeCheckpoint(record("t2", work), work, "turn");
  assert.ok(cp);
  assert.equal(cp.scope, "full");
  put(work, "a.txt", "bash");
  put(work, "x.txt", "new");
  assert.deepEqual((await changedPathsSinceCheckpoint("t2", cp.n, work)).sort(), ["a.txt", "x.txt"]);
  await rollbackTo("t2", cp.n, work);
  assert.equal(read(work, "a.txt"), "v0");
  assert.equal(read(work, "x.txt"), null);
});

test("整目录快照超时：掐掉 git、清掉锁，这一轮直接改走只备份改过的文件，不卡住", async () => {
  const work = temp("dimensio-cptouch-slow-");
  process.env.SESSIONS_DIR = temp("dimensio-cptouch-state-");
  process.env.CHECKPOINT_MODE = "full"; // 不做事先判断，只靠超时兜底
  process.env.CHECKPOINT_STAGE_BUDGET_MS = "1";
  for (let i = 0; i < 50; i++) put(work, `f${i}.txt`, `v${i}`);
  const t0 = Date.now();
  const cp = await takeCheckpoint(record("t3", work), work, "turn");
  assert.ok(Date.now() - t0 < 30_000);
  assert.ok(cp);
  assert.equal(cp.scope, "touched");
  assert.equal(cp.scopeStarted, true);
  const lock = fs.readdirSync(path.join(process.env.SESSIONS_DIR, "shadow.git", "indexes")).filter((n) => n.endsWith(".lock"));
  assert.deepEqual(lock, []);
  await toolWrite("t3", work, "f1.txt", "changed");
  await rollbackTo("t3", cp.n, work);
  assert.equal(read(work, "f1.txt"), "v1");
});

test("会话中途切档：回滚到切档前的整目录快照，也只动接管的文件，不 clean 掉别的", async () => {
  const work = temp("dimensio-cptouch-mixed-");
  process.env.SESSIONS_DIR = temp("dimensio-cptouch-state-");
  put(work, "a.txt", "v0");
  put(work, "keep.txt", "v0");
  const cp1 = await takeCheckpoint(record("t4", work), work, "第一轮");
  assert.ok(cp1);
  assert.equal(cp1.scope, "full");
  await recordRunEnd("t4", work, cp1.n);

  process.env.CHECKPOINT_MODE = "touched"; // 工作区「长大了」
  const cp2 = await takeCheckpoint(record("t4", work, 2), work, "第二轮");
  assert.ok(cp2);
  assert.equal(cp2.scopeStarted, true);
  await toolWrite("t4", work, "a.txt", "v2");
  put(work, "bash-made.txt", "x"); // Bash 新建的：整目录回滚会 clean 掉，这一档不该动
  put(work, "keep.txt", "bash");

  await rollbackTo("t4", cp1.n, work);
  assert.equal(read(work, "a.txt"), "v0");
  assert.equal(read(work, "bash-made.txt"), "x");
  assert.equal(read(work, "keep.txt"), "bash");
});

test("不接管工作区外的路径、凭据与可再生目录", async () => {
  const work = temp("dimensio-cptouch-skip-");
  process.env.SESSIONS_DIR = temp("dimensio-cptouch-state-");
  process.env.CHECKPOINT_MODE = "touched";
  const cp = await takeCheckpoint(record("t5", work), work, "turn");
  assert.ok(cp);
  await toolWrite("t5", work, ".env", "SECRET=1");
  await toolWrite("t5", work, "node_modules/x/index.js", "x");
  await noteBeforeWrite("t5", work, path.join(os.tmpdir(), "outside.txt"));
  await toolWrite("t5", work, "src/ok.ts", "ok");
  assert.deepEqual(await changedPathsSinceCheckpoint("t5", cp.n, work), ["src/ok.ts"]);
});
