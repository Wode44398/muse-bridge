// M12（N37、#22）：项目知识扫描移出主事件循环 + 事件循环延迟看门狗。
//
// 修前：ensureProjectKnowledge 全程同步跑在 harness 唯一的事件循环上（最多 1 万个文件 readdir + stat，指纹变了就同步
// 重建五张表）——每轮开跑、每次带验证证据的工具结果都要走一遍，用户的笔记库一次冻住所有会话 5–8 秒；任何文件变了都
// 整份重建（往日志里追加一行也算）；主线程卡住了哪里都看不出来。
// 修后：读写知识缓存的活都在常驻 worker 线程里按到达顺序做；一轮开跑给 worker 一个新鲜度预算，超时先用旧快照；指纹只算
// 会读进知识的文件；主进程开事件循环延迟看门狗。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { ensureProjectKnowledge, projectKnowledgeDir } from "./knowledge.ts";
import {
  knowledgeIdle, knowledgeSnapshot, knowledgeWithin, noteKnowledgeEdit, noteKnowledgeVerification, refreshProjectKnowledge,
} from "./knowledge-service.ts";
import { startLoopDelayMonitor } from "./loop-delay.ts";

const roots: string[] = [];
after(async () => {
  await knowledgeIdle();
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

function workspace(files = 5): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-m12-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "src"));
  for (let i = 0; i < files; i++) {
    const dir = path.join(root, "src", `m${Math.floor(i / 50)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.ts`), `import { y${i > 0 ? i - 1 : 0} } from "./f${i > 0 ? i - 1 : 0}.ts";\nexport const y${i} = ${i};\nexport function route${i}() { return process.env.KEY_${i % 7}; }\n`);
  }
  return root;
}

test("M12 知识重建在 worker 里做：重建期间主线程照常响应（同一份工作区在主线程上同步重建会卡住）", { timeout: 120_000 }, async () => {
  const root = workspace(2500);
  // 对照：主线程上同步重建一次要卡多久
  const t0 = performance.now();
  ensureProjectKnowledge(root, { force: true });
  const blocking = performance.now() - t0;

  let last = performance.now();
  let maxGap = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  try {
    last = performance.now();
    const knowledge = await refreshProjectKnowledge(root, { force: true });
    assert.equal(knowledge.rebuilt, true);
    assert.equal(knowledge.modules.sourceFiles, 2500);
    // 再等两跳才结算：主线程若刚被同步卡住，卡完之后的那一跳才量得到这段空档
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    clearInterval(ticker);
  }
  assert.ok(blocking > 150, `对照组要足够重才有说服力（主线程同步重建 ${Math.round(blocking)}ms）`);
  assert.ok(maxGap < Math.max(100, blocking / 3), `重建期间主线程最长停了 ${Math.round(maxGap)}ms（同步重建要卡 ${Math.round(blocking)}ms）`);
});

test("M12 一轮开跑的新鲜度预算：预算内对完用新的；超时先用旧快照、后台接着对完；一份都没有才等到底", async () => {
  const root = workspace(5);
  // 这个工作区还一份都没有：等到底
  const first = await knowledgeWithin(root, 0);
  assert.equal(first.modules.sourceFiles, 5);
  assert.equal(knowledgeSnapshot(root)?.profile.sourceFingerprint, first.profile.sourceFingerprint);

  fs.writeFileSync(path.join(root, "src", "m0", "added.ts"), "export const added = 1;\n");
  const stale = await knowledgeWithin(root, 0); // 预算为 0：先用旧快照
  assert.equal(stale.profile.sourceFingerprint, first.profile.sourceFingerprint, "预算到了先用旧的，不等");
  await knowledgeIdle();
  assert.equal(knowledgeSnapshot(root)?.modules.sourceFiles, 6, "后台接着对完，快照跟上");

  fs.writeFileSync(path.join(root, "src", "m0", "added2.ts"), "export const added2 = 2;\n");
  const fresh = await knowledgeWithin(root, 30_000);
  assert.equal(fresh.modules.sourceFiles, 7, "预算内对完就用新的");
});

test("M12 验证记录与 dirty 标记发进 worker、与重建串行：记完就在快照与盘上", async () => {
  const root = workspace(3);
  await refreshProjectKnowledge(root);
  noteKnowledgeVerification(root, { tool: "Bash", passed: true, detail: "suite green", command: "npm test" });
  await knowledgeIdle();
  const inMemory = knowledgeSnapshot(root)!;
  assert.equal(inMemory.health.lastPassingVerification?.detail, "suite green", "主线程的快照跟上了");
  const onDisk = JSON.parse(fs.readFileSync(path.join(projectKnowledgeDir(root), "health.json"), "utf8"));
  assert.equal(onDisk.verifications.at(-1).detail, "suite green");
  // 改过文件（dirty）：下一次对知识整份重建，验证记录跟着留下（重建与追加在同一条线程上排队，不会互相盖掉 health.json）
  noteKnowledgeEdit(root);
  const next = await refreshProjectKnowledge(root);
  assert.equal(next.rebuilt, true);
  assert.equal(next.health.lastPassingVerification?.detail, "suite green");
});

test("M12 指纹只算会读进知识的文件：日志、笔记变了不重建；源码、部署文件、AGENTS.md 变了照样重建", () => {
  const root = workspace(3);
  ensureProjectKnowledge(root, { force: true });
  const touch = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.appendFileSync(path.join(root, rel), text);
  };
  touch("notes.log", "one line\n");
  touch("docs/diary.md", "# 今天\n");
  touch("data/rows.csv", "a,b\n");
  assert.equal(ensureProjectKnowledge(root).rebuilt, false, "日志、笔记、数据文件不影响生成的知识");
  touch("package-lock.json", "{}");
  assert.equal(ensureProjectKnowledge(root).rebuilt, true, "锁文件出现 = 包管理器可能变了");
  touch("package-lock.json", " ");
  assert.equal(ensureProjectKnowledge(root).rebuilt, false, "锁文件内容变了（装了个依赖）不算");
  for (const rel of ["src/m0/f0.ts", "Dockerfile", "AGENTS.md", ".github/workflows/ci.yml", "db/schema.sql"]) {
    touch(rel, "\n// changed\n");
    assert.equal(ensureProjectKnowledge(root).rebuilt, true, `${rel} 变了要重建`);
  }
});

test("M12 事件循环延迟看门狗：主线程上的同步重活留一行证据；安静的窗口不吭声", async () => {
  const lines: string[] = [];
  const monitor = startLoopDelayMonitor({ windowMs: 60_000, warnMs: 300, tickMs: 20, log: (line) => lines.push(line) });
  try {
    await new Promise((r) => setTimeout(r, 60));
    monitor.check(); // 清掉起步那一截
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(monitor.check().maxMs < 300);
    assert.equal(lines.length, 0, "安静的窗口不吭声");
    const until = performance.now() + 600;
    while (performance.now() < until) { /* 真的同步忙循环，不是 setTimeout */ }
    await new Promise((r) => setTimeout(r, 60)); // 让看门狗的心跳（20ms 一跳）晚到的那一下被量到
    const busy = monitor.check();
    assert.ok(busy.maxMs >= 500, `抓到的最长卡顿 ${busy.maxMs}ms`);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[loop-delay\].*同步重活/);
  } finally {
    monitor.stop();
  }
});
