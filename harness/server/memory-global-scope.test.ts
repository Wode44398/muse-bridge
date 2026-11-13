// 评测隔离：全局层记忆按工作区各一份（DIMENSIO_GLOBAL_MEMORY_SCOPE=workspace）。
//
// 修前：全局层只有 <记忆目录>/global 一份。评测的一臂是一个 harness 进程，同一臂并发 / 重复跑的题共用它——A 题写的全局记忆
// （模型写的是 proposed）B 题经 Recall(layer:"global")、知识检索都看得到，同一道「记住偏好」的题第 2 次重复也看得到第 1 次的。
// 修后：开关开着时全局层落在 <记忆目录>/global-scoped/<工作区键>，按会话的工作区取，互相看不见；开关不开（正式服）路径与行为
// 和以前一字不差。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { searchUnifiedKnowledge } from "./knowledge-search.ts";
import {
  GLOBAL_MEMORY,
  globalMemoryFor,
  globalMemoryScoped,
  isGlobalMemory,
  listMemories,
  memoryDir,
  memoryDirKey,
  memoryRoot,
  promoteMemory,
  renderAllMemoryForPrompt,
  renderGlobalMemoryForPrompt,
} from "./memory.ts";
import { buildMemoryOverview, GLOBAL_WS } from "./memory-overview.ts";
import { memoryUsage, noteRecalledDocs } from "./memory-usage.ts";
import { Sandbox } from "./sandbox.ts";
import { recallTool } from "./tools/recall.ts";
import { rememberTool } from "./tools/remember.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const SWITCH = "DIMENSIO_GLOBAL_MEMORY_SCOPE";
const prevSwitch = process.env[SWITCH];
const restoreSwitch = () => {
  if (prevSwitch === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = prevSwitch;
};

const roots: string[] = [];
after(() => {
  restoreSwitch();
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
beforeEach(() => {
  restoreSwitch();
  fs.rmSync(path.join(memoryRoot(), "global"), { recursive: true, force: true });
  fs.rmSync(path.join(memoryRoot(), "global-scoped"), { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
const text = (r: ToolRunResult) => r.content.map((b) => (b.t === "text" ? b.text : "")).join("");
const ctxFor = (root: string): ToolContext => ({
  sandbox: new Sandbox(root),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
  agentSeesImages: false,
  humanAttended: () => true,
});
const note = (title: string, topic: string, content: string) => ({
  title,
  description: `${title}.`,
  type: "user",
  topic,
  status: "active",
  confidence: "user_confirmed",
  content,
  evidence: ["the user said so"],
});

test("开关不开（正式服）：全局层仍是唯一那份 <记忆目录>/global，与工作区无关", async () => {
  for (const value of [undefined, "", "shared", "global", "1"]) {
    if (value === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = value;
    assert.equal(globalMemoryScoped(), false, `值 ${JSON.stringify(value)} 不算开`);
    assert.equal(globalMemoryFor(tmp("dimensio-gscope-off-")), GLOBAL_MEMORY);
    assert.equal(globalMemoryFor(undefined), GLOBAL_MEMORY);
  }
  delete process.env[SWITCH];
  assert.equal(memoryDir(GLOBAL_MEMORY), path.join(memoryRoot(), "global"));

  // 两个工作区写的全局条目落在同一份里、彼此可见（原有行为）
  const wsA = tmp("dimensio-gscope-off-a-");
  const wsB = tmp("dimensio-gscope-off-b-");
  assert.equal((await rememberTool.run({ ...note("Replies in Chinese", "user.lang", "Reply in Chinese."), layer: "global" }, ctxFor(wsA))).ok, true);
  assert.deepEqual(listMemories(GLOBAL_MEMORY).map((m) => m.id), ["replies-in-chinese"]);
  assert.match(text(await recallTool.run({ layer: "global" }, ctxFor(wsB))), /\[global:replies-in-chinese\]/);
  assert.equal(fs.existsSync(path.join(memoryRoot(), "global-scoped")), false, "不开就不建分工作区的目录");
});

test("开关开着：两个工作区的全局层各一份，Remember / Recall / 检索 / 提示词 / 用量互不可见", async () => {
  process.env[SWITCH] = "workspace";
  const wsA = tmp("dimensio-gscope-a-");
  const wsB = tmp("dimensio-gscope-b-");
  const gA = globalMemoryFor(wsA);
  const gB = globalMemoryFor(wsB);
  assert.notEqual(gA, GLOBAL_MEMORY);
  assert.notEqual(gA, gB);
  assert.ok(isGlobalMemory(gA) && isGlobalMemory(gB));
  assert.equal(globalMemoryFor(gA), gA, "已经是全局层的原样返回");
  assert.equal(memoryDir(gA), path.join(memoryRoot(), "global-scoped", memoryDirKey(wsA)));

  const ctxA = ctxFor(wsA);
  const ctxB = ctxFor(wsB);
  const saved = await rememberTool.run({ ...note("Commit messages in Chinese", "user.commit-language", "Write git commit messages in Chinese."), layer: "global" }, ctxA);
  assert.equal(saved.ok, true, text(saved));
  assert.match(text(saved), /global notes apply in every workspace/, "全局层的治理规则照旧（待确认）");
  assert.ok(fs.existsSync(path.join(memoryDir(gA), "commit-messages-in-chinese.md")));
  assert.equal(fs.existsSync(memoryDir(GLOBAL_MEMORY)), false, "不碰共用的那份");
  assert.equal(fs.existsSync(memoryDir(gB)), false);
  assert.equal(fs.existsSync(memoryDir(wsA)), false, "没写进工作区层");

  // Recall：A 看得到，B 列表 / 按 id / layer:global 都看不到
  assert.match(text(await recallTool.run({ id: "global:commit-messages-in-chinese" }, ctxA)), /layer: global/);
  assert.match(text(await recallTool.run({}, ctxA)), /\[global:commit-messages-in-chinese\]/);
  assert.match(text(await recallTool.run({}, ctxB)), /memory is empty/);
  assert.match(text(await recallTool.run({ id: "commit-messages-in-chinese" }, ctxB)), /No memory "commit-messages-in-chinese"/);
  assert.match(text(await recallTool.run({ layer: "global" }, ctxB)), /memory is empty/);

  // 知识检索（含待确认的条目）
  const fromA = await searchUnifiedKnowledge(wsA, "commit messages Chinese", { semantic: false, includeQuarantined: true });
  const fromB = await searchUnifiedKnowledge(wsB, "commit messages Chinese", { semantic: false, includeQuarantined: true });
  assert.ok(fromA.results.some((r) => r.document.id === "memory:global:commit-messages-in-chinese"), JSON.stringify(fromA.results.map((r) => r.document.id)));
  assert.ok(!fromB.results.some((r) => r.document.id.startsWith("memory:global:")), JSON.stringify(fromB.results.map((r) => r.document.id)));

  // 确认后只进 A 的提示词
  promoteMemory(gA, "commit-messages-in-chinese");
  assert.match(renderAllMemoryForPrompt(wsA)!, /^Global notes[\s\S]*Commit messages in Chinese/);
  assert.equal(renderAllMemoryForPrompt(wsB), undefined);
  assert.equal(renderGlobalMemoryForPrompt(gB), undefined);

  // 自动召回记用量：记在 A 自己那份
  const before = memoryUsage(gA)["commit-messages-in-chinese"]?.n ?? 0;
  assert.equal(before, 1, "上面 A 按 id Recall 过一次，记在 A 自己那份");
  noteRecalledDocs(wsA, ["memory:global:commit-messages-in-chinese"]);
  assert.equal(memoryUsage(gA)["commit-messages-in-chinese"]?.n, 2);
  assert.equal(fs.existsSync(path.join(memoryDir(gB), "usage.json")), false);

  // B 写同名条目，各是各的
  assert.equal((await rememberTool.run({ ...note("Commit messages in Chinese", "user.commit-language", "B version."), layer: "global" }, ctxB)).ok, true);
  assert.equal(listMemories(gB).length, 1);
  assert.equal(listMemories(gA)[0].declaredStatus, "active", "B 写的没盖掉 A 的");
});

test("开关开着：记忆总览的「全局」桶降级成当前工作空间那份", async () => {
  process.env[SWITCH] = "workspace";
  const wsA = tmp("dimensio-gscope-ov-a-");
  const wsB = tmp("dimensio-gscope-ov-b-");
  await rememberTool.run({ ...note("Only in A", "user.only-a", "A."), layer: "global" }, ctxFor(wsA));
  const inA = buildMemoryOverview({ projects: [], currentWs: wsA }).buckets.find((b) => b.kind === "global");
  assert.equal(inA?.ws, GLOBAL_WS);
  assert.deepEqual(inA?.items.map((m) => m.id), ["only-in-a"]);
  assert.equal(buildMemoryOverview({ projects: [], currentWs: wsB }).buckets.some((b) => b.kind === "global"), false);
});
