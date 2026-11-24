// K7（N54）：全局层记忆。
//
// 修前：记忆按工作区隔离，「用户是谁」「这台机器怎么用」这类天然跨项目的事实，在哪个工作区学到就只在那个工作区生效
// （09-25 取数：6 条 user 类记忆分在 5 个工作区）。
// 修后：Remember(layer:"global") 写进全局层（不挂文件）；它的索引行进每一个工作区的提示词。
// 记忆放宽（m 线）改了三条旧契约：模型写的全局条目默认生效（以前一律待确认）、不再只收 user / reference、全局索引超预算时
// 折叠（以前确认时就拒）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import {
  GLOBAL_MEMORY,
  listMemories,
  memoryDir,
  promoteMemory,
  saveMemory,
} from "./memory.ts";
import { memoryBudgets, renderAllMemoryForPrompt, renderGlobalMemoryForPrompt } from "./memory-index.ts";
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

test("K7 模型写的全局条目：落在全局层、默认生效、结果里给出文件位置；锚点丢掉并说一声", async () => {
  const ws = tmp("dimensio-k7-ws-");
  const ctx = ctxFor(ws);
  const saved = await rememberTool.run({ ...userNote, layer: "global" }, ctx);
  assert.equal(saved.ok, true, text(saved));
  assert.match(text(saved), /Saved memory "Replies in Chinese" \(id: replies-in-chinese, global\)/);
  assert.ok(text(saved).includes(memoryDir(GLOBAL_MEMORY)), "结果里说文件落在全局目录");
  const [note] = listMemories(GLOBAL_MEMORY);
  assert.equal(note.declaredStatus, "active");
  assert.ok(fs.existsSync(path.join(memoryDir(GLOBAL_MEMORY), `${note.id}.md`)));
  assert.equal(fs.existsSync(memoryDir(ws)), false, "没写进这个工作区");

  const anchored = await rememberTool.run({ ...userNote, title: "Env note", type: "reference", topic: "env.shell", anchors: ["README.md"], layer: "global" }, ctx);
  assert.equal(anchored.ok, true, text(anchored));
  assert.match(text(anchored), /cannot anchor workspace files — ignored/);
  assert.deepEqual(listMemories(GLOBAL_MEMORY).find((m) => m.title === "Env note")!.anchors, []);
});

test("K7 全局条目进每个工作区的索引；两层各带目录路径，空的层也写出路径", async () => {
  const wsA = tmp("dimensio-k7-a-");
  const wsB = tmp("dimensio-k7-b-");
  saveMemory(wsA, { ...userNote, title: "A only", topic: "a.only", type: "reference", content: "only in A", origin: { writer: "user", attended: true } } as never);
  const emptyB = renderAllMemoryForPrompt(wsB);
  assert.ok(emptyB.includes(`no notes yet; they go in ${memoryDir(wsB)}`), "空的工作区层也给路径");
  assert.ok(emptyB.includes(`no notes yet; they go in ${memoryDir(GLOBAL_MEMORY)}`));

  await rememberTool.run({ ...userNote, status: "proposed", layer: "global" }, ctxFor(wsA));
  const id = listMemories(GLOBAL_MEMORY)[0].id;
  assert.match(renderAllMemoryForPrompt(wsB), /^- Replies in Chinese — .*\(unconfirmed\)$/m, "待确认的也列，带标记");

  promoteMemory(GLOBAL_MEMORY, id);
  const inA = renderAllMemoryForPrompt(wsA);
  const inB = renderAllMemoryForPrompt(wsB);
  for (const rendered of [inA, inB]) {
    assert.ok(rendered.includes(`Global — about the user and this machine, shared by every workspace; files in ${memoryDir(GLOBAL_MEMORY)}:`));
    assert.match(rendered, /^- Replies in Chinese — The user wants every reply in Chinese\. · replies-in-chinese\.md$/m);
  }
  assert.ok(inA.includes(`This workspace — notes are Markdown files in ${memoryDir(wsA)}:\n- A only`), "工作区自己的照旧在");
  assert.doesNotMatch(inB, /A only/);
});

test("K7 全局层有预算：放不下先去掉描述、再把最不相关的折叠成一句；晋升不再受它限制", () => {
  for (let i = 0; i < 60; i++) {
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
    if (i % 2 === 0) promoteMemory(GLOBAL_MEMORY, id);
  }
  const budget = memoryBudgets().global;
  const rendered = renderGlobalMemoryForPrompt(GLOBAL_MEMORY, budget)!;
  assert.ok(rendered.length <= budget, `渲染出来的全局段在预算内（${rendered.length} / ${budget}）`);
  assert.doesNotMatch(rendered, /deliberately long description/, "先去掉描述");
  assert.match(rendered, /^- \(\d+ more notes in this directory are not listed here for space/m, "再放不下才折叠");
  assert.match(rendered, /^- Preference number 0 with a fairly long title · /m, "生效的优先留下");
  // 窗口大的模型预算更宽：同样的条目放得下更多
  assert.ok(memoryBudgets(1_000_000).global > budget);
});

test("K7 Recall 读得到全局条目：global: 前缀、不带前缀回落、列表带全局段", async () => {
  const ws = tmp("dimensio-k7-recall-");
  const ctx = ctxFor(ws);
  await rememberTool.run({ ...userNote, layer: "global" }, ctx);
  const id = listMemories(GLOBAL_MEMORY)[0].id;

  const byPrefix = await recallTool.run({ id: `global:${id}` }, ctx);
  assert.match(text(byPrefix), /global: applies in every workspace/);
  assert.match(text(byPrefix), /reply in Chinese/);
  const fallback = await recallTool.run({ id }, ctx);
  assert.match(text(fallback), /global: applies in every workspace/, "工作区里没有这个 id，回落到全局层");
  const listing = await recallTool.run({}, ctx);
  assert.match(text(listing), /Global notes/);
  assert.match(text(listing), new RegExp(`\\[global:${id}\\]`));
  const onlyGlobal = await recallTool.run({ layer: "global" }, ctx);
  assert.match(text(onlyGlobal), /^1 global notes in /);
});
