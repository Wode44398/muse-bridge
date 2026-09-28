// K7（N54）：全局层记忆。
//
// 修前：记忆按工作区隔离，「用户是谁」「这台机器怎么用」这类天然跨项目的事实，在哪个工作区学到就只在那个工作区生效
// （09-25 取数：6 条 user 类记忆分在 5 个工作区）。
// 修后：Remember(layer:"global") 写进全局层——只收 user / reference、不挂文件、要短，模型写的一律待确认；用户在记忆面板
// 确认后，它的索引行进每一个工作区的提示词，合计有硬字符预算（确认时超了就拒）；Recall 读得到（global: 前缀或回落）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import {
  GLOBAL_MEMORY,
  GLOBAL_PROMPT_BUDGET,
  MemoryBudgetError,
  listMemories,
  memoryDir,
  promoteMemory,
  renderAllMemoryForPrompt,
  renderMemoryForPrompt,
  saveMemory,
} from "./memory.ts";
import { Sandbox } from "./sandbox.ts";
import { recallTool } from "./tools/recall.ts";
import { rememberTool } from "./tools/remember.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
beforeEach(() => fs.rmSync(memoryDir(GLOBAL_MEMORY), { recursive: true, force: true }));
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
const userNote = {
  title: "Replies in Chinese",
  description: "The user wants every reply in Chinese.",
  type: "user",
  topic: "user.response-language",
  status: "active",
  confidence: "user_confirmed",
  content: "The user reads and writes Chinese; reply in Chinese unless asked otherwise.",
  evidence: ["the user said so"],
};

test("K7 模型写的全局条目：落在全局层、一律待确认；只收 user / reference、不挂文件", async () => {
  const ws = tmp("dimensio-k7-ws-");
  const ctx = ctxFor(ws);
  const saved = await rememberTool.run({ ...userNote, layer: "global" }, ctx);
  assert.equal(saved.ok, true, text(saved));
  assert.match(text(saved), /Saved new proposed memory/);
  assert.match(text(saved), /global notes apply in every workspace/);
  const [note] = listMemories(GLOBAL_MEMORY);
  assert.equal(note.declaredStatus, "proposed", "要生效得用户确认");
  assert.ok(fs.existsSync(path.join(memoryDir(GLOBAL_MEMORY), `${note.id}.md`)));
  assert.equal(fs.existsSync(memoryDir(ws)), false, "没写进这个工作区");

  const project = await rememberTool.run({ ...userNote, title: "Build with JDK 17", type: "project", topic: "build.jdk", layer: "global" }, ctx);
  assert.equal(project.ok, false);
  assert.match(text(project), /only takes user and reference notes/);
  const anchored = await rememberTool.run({ ...userNote, title: "Env note", type: "reference", topic: "env.shell", anchors: ["README.md"], layer: "global" }, ctx);
  assert.equal(anchored.ok, false);
  assert.match(text(anchored), /cannot anchor workspace files/);
});

test("K7 确认后进每个工作区的提示词；没有生效的全局条目时渲染与以前一字不差", async () => {
  const wsA = tmp("dimensio-k7-a-");
  const wsB = tmp("dimensio-k7-b-");
  saveMemory(wsA, { ...userNote, title: "A only", topic: "a.only", type: "reference", content: "only in A", origin: { writer: "user", attended: true } } as never);
  assert.equal(renderAllMemoryForPrompt(wsA), renderMemoryForPrompt(wsA), "没有全局条目：一字不差");
  assert.equal(renderAllMemoryForPrompt(wsB), undefined);

  await rememberTool.run({ ...userNote, layer: "global" }, ctxFor(wsA));
  const id = listMemories(GLOBAL_MEMORY)[0].id;
  assert.equal(renderAllMemoryForPrompt(wsB), undefined, "待确认的不进提示词");

  promoteMemory(GLOBAL_MEMORY, id);
  const inA = renderAllMemoryForPrompt(wsA)!;
  const inB = renderAllMemoryForPrompt(wsB)!;
  for (const rendered of [inA, inB]) {
    assert.match(rendered, /^Global notes/);
    assert.match(rendered, /Replies in Chinese/);
  }
  assert.match(inA, /This workspace:\n.*A only/, "工作区自己的照旧在");
  assert.doesNotMatch(inB, /A only/);
});

test("K7 全局层有预算：生效的索引行合计超了，确认就拒", () => {
  const ws = tmp("dimensio-k7-budget-");
  void ws;
  let promoted = 0;
  let refused: unknown = null;
  for (let i = 0; i < 40 && !refused; i++) {
    const { id } = saveMemory(GLOBAL_MEMORY, {
      title: `Preference number ${i} with a fairly long title`,
      description: "A deliberately long description so that each index line takes up a good share of the global budget.",
      type: "user",
      topic: `user.pref-${i}`,
      status: "proposed",
      confidence: "observed",
      content: "x",
      evidence: ["test"],
      origin: { writer: "model", attended: true },
    });
    try {
      promoteMemory(GLOBAL_MEMORY, id);
      promoted++;
    } catch (e) {
      refused = e;
    }
  }
  assert.ok(refused instanceof MemoryBudgetError, `第 ${promoted + 1} 条应该被预算拒掉`);
  assert.ok(promoted > 0 && promoted < 40);
  const rendered = renderAllMemoryForPrompt(tmp("dimensio-k7-any-"))!;
  assert.ok(rendered.length <= GLOBAL_PROMPT_BUDGET + 200, `渲染出来的全局段在预算内（${rendered.length}）`);
});

test("K7 Recall 读得到全局条目：global: 前缀、不带前缀回落、列表带全局段", async () => {
  const ws = tmp("dimensio-k7-recall-");
  const ctx = ctxFor(ws);
  await rememberTool.run({ ...userNote, layer: "global" }, ctx);
  const id = listMemories(GLOBAL_MEMORY)[0].id;

  const byPrefix = await recallTool.run({ id: `global:${id}` }, ctx);
  assert.match(text(byPrefix), /layer: global/);
  assert.match(text(byPrefix), /reply in Chinese/);
  const fallback = await recallTool.run({ id }, ctx);
  assert.match(text(fallback), /layer: global/, "工作区里没有这个 id，回落到全局层");
  const listing = await recallTool.run({}, ctx);
  assert.match(text(listing), /Global notes/);
  assert.match(text(listing), new RegExp(`\\[global:${id}\\]`));
  const onlyGlobal = await recallTool.run({ layer: "global" }, ctx);
  assert.match(text(onlyGlobal), /1 remembered global notes/);
});
