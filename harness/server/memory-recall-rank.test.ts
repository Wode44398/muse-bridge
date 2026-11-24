// 检索修中文（m 线）：Recall 的记忆检索与历史会话检索按「整词 + 汉字二元组」打分，标题 / 描述命中权重高于正文，部分命中
// 也能排出来；system 里列这个工作区最近的会话；语义服务的 key 与地址成对取，不提供 embeddings 的 key 当作没配。
//
// 修前：正式服 861 次检索 54% 零结果——会话检索按空格切词、每个词都要出现，中文一句话就是一个「词」；记忆检索的二元组
// 和整词同权，标题与正文的命中都只按个数加分；语义服务从 9 月起一直失败（借用通义 key 时地址没跟着那家服务走，失败的批次
// 连同算好的向量一起作废）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { embeddingConfig, searchUnifiedKnowledge } from "./knowledge-search.ts";
import { memoryDir, saveMemory } from "./memory.ts";
import { recentSessionsSection, warmRecentSessions } from "./recent-sessions.ts";
import { persistNow, type Session } from "./session.ts";
import { rankSessions } from "./session-rank.ts";
import { sessionInWorkspace } from "./session-search.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { queryTerms, scoreFields } from "./text-match.ts";
import { Sandbox } from "./sandbox.ts";
import { recallTool } from "./tools/recall.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows 句柄 */
    }
  }
});
const tmp = (prefix: string): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root, memoryDir(root));
  return root;
};
const text = (r: ToolRunResult): string => r.content.map((b) => (b.t === "text" ? b.text : "")).join("");
const ctxFor = (root: string, ownerId?: string): ToolContext => ({
  sandbox: new Sandbox(root),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
  agentSeesImages: false,
  ...(ownerId ? { ownerId } : {}),
});

test("m 分词：汉字段出二元组与 2–4 字整词，英文按词与 . / _ - 再拆；口头语不算", () => {
  const t = queryTerms("上次那个月桥前端的 bridge-client 问题");
  assert.ok(t.grams.includes("月桥") && t.grams.includes("前端"), t.grams.join(","));
  assert.ok(!t.grams.includes("上次") && !t.grams.includes("那个"), "口头语不算");
  assert.ok(t.words.includes("bridge-client") && t.words.includes("bridge") && t.words.includes("client"));
  // 部分命中也有分；标题命中高于正文
  const inTitle = scoreFields([{ name: "title", text: "月桥前端改版", weight: 5 }, { name: "body", text: "", weight: 1 }], t);
  const inBody = scoreFields([{ name: "title", text: "无关", weight: 5 }, { name: "body", text: "月桥前端改版", weight: 1 }], t);
  assert.ok(inTitle.score > inBody.score && inBody.score > 0);
  assert.ok(inTitle.matched < inTitle.total, "只命中一部分也排得出来");
});

test("m 记忆检索：中文口语问法部分命中也找得到，标题 / 描述命中的排在只有正文命中的前面；没配语义照样能用", async () => {
  const ws = tmp("dimensio-m-rank-");
  const base = { type: "project" as const, status: "active" as const, confidence: "user_confirmed" as const, lenient: true };
  saveMemory(ws, { ...base, title: "月桥图标的动效", description: "月桥图标在加载时的呼吸动画", content: "图标用两段贝塞尔曲线。" });
  saveMemory(ws, { ...base, title: "部署流程", description: "发版前先 publish-mirror", content: "顺带一提，月桥图标的文件在 icons 目录。" });
  saveMemory(ws, { ...base, title: "测试服端口", description: "8810/8811", content: "harness 在 8811。" });
  const res = await searchUnifiedKnowledge(ws, "上次说的那个月桥图标动画是怎么做的", { kinds: ["memory"], semantic: false, liveMemory: true, recordMetrics: false });
  const ids = res.results.map((r) => r.document.id);
  assert.ok(ids.length >= 2, `部分命中也排得出来：${ids.join(", ")}`);
  assert.equal(res.results[0].document.title, "月桥图标的动效", "标题 / 描述命中的在前");
  assert.ok(!res.results.some((r) => r.document.title === "测试服端口"), "毫不相干的不出来");
  assert.equal(res.semantic, "disabled");
  // Recall 的结果里给出笔记文件的路径
  const recalled = text(await recallTool.run({ query: "月桥 动画" }, ctxFor(ws)));
  assert.ok(recalled.includes(path.join(memoryDir(ws), "")), "结果里有文件路径");
  assert.match(recalled, /月桥图标的动效/);
});

test("m 语义服务的配置：自己的 key 配 DashScope 兼容地址；编码套餐的 key 当作没配（unavailable，不是 failed）", () => {
  const saved = { key: process.env.KNOWLEDGE_EMBEDDING_API_KEY, url: process.env.KNOWLEDGE_EMBEDDING_BASE_URL };
  try {
    delete process.env.KNOWLEDGE_EMBEDDING_BASE_URL;
    process.env.KNOWLEDGE_EMBEDDING_API_KEY = "FAKE-embedding-key";
    const own = embeddingConfig();
    assert.ok(own && !("unavailable" in own));
    assert.equal(own.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
    process.env.KNOWLEDGE_EMBEDDING_API_KEY = "sk-sp-FAKE-coding-plan";
    const plan = embeddingConfig();
    assert.ok(plan && "unavailable" in plan && /Coding Plan/.test(plan.unavailable));
    process.env.KNOWLEDGE_EMBEDDING_BASE_URL = "https://example.invalid/v1";
    const explicit = embeddingConfig();
    assert.ok(explicit && !("unavailable" in explicit) && explicit.baseUrl === "https://example.invalid/v1", "显式给了地址就照它");
  } finally {
    if (saved.key === undefined) delete process.env.KNOWLEDGE_EMBEDDING_API_KEY;
    else process.env.KNOWLEDGE_EMBEDDING_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.KNOWLEDGE_EMBEDDING_BASE_URL;
    else process.env.KNOWLEDGE_EMBEDDING_BASE_URL = saved.url;
  }
});

async function sessionIn(t: import("node:test").TestContext, root: string, title: string, user: string, answer: string): Promise<Session> {
  const session = attachSession(scripted(t).next(say(answer)), root, { tools: [] });
  await send(session, user);
  session.title = title;
  await persistNow(session);
  return session;
}

test("m 历史会话：中文部分命中可排序、标题命中在前、给命中处的上下文；只看这个工作区、不含当前会话；system 里列最近的会话", async (t) => {
  const ws = tmp("dimensio-m-sess-");
  const elsewhere = tmp("dimensio-m-sess-other-");
  const titled = await sessionIn(t, ws, "月桥图标改版", "把图标换一下", "换好了");
  const body = await sessionIn(t, ws, "杂项", "顺便看看月桥的加载动画卡不卡", "加载动画在低端机上掉帧，改成了 transform 动画");
  const other = await sessionIn(t, elsewhere, "月桥图标改版（别的工作区）", "月桥图标", "好");
  const current = await sessionIn(t, ws, "月桥图标当前会话", "月桥图标", "好");

  const found = await rankSessions("上次那个月桥图标的动画", { filter: (m) => m.id !== current.id && sessionInWorkspace(m, ws) });
  const ids = found.map((h) => h.id);
  assert.deepEqual(ids.slice(0, 2), [titled.id, body.id], `标题命中在前，正文部分命中也排得出来：${ids.join(", ")}`);
  assert.ok(!ids.includes(other.id) && !ids.includes(current.id));
  assert.ok(found[1].snippets.some((s) => s.includes("加载动画")), "给命中处的原文");

  const viaRecall = text(await recallTool.run({ layer: "sessions", query: "月桥 动画" }, ctxFor(ws, current.id)));
  assert.match(viaRecall, new RegExp(`\\[session:${body.id}\\] 杂项`));
  assert.ok(!viaRecall.includes(current.id) && !viaRecall.includes(other.id));

  await warmRecentSessions(ws);
  const recent = recentSessionsSection(ws, current.id)!;
  assert.match(recent, /^## Recent sessions in this workspace\n/);
  assert.match(recent, new RegExp(`^- \\d{4}-\\d{2}-\\d{2} 月桥图标改版 · session:${titled.id}$`, "m"));
  assert.ok(!recent.includes(current.id), "不含当前会话");
  assert.ok(!recent.includes(other.id), "只列这个工作区的");
  assert.equal(recentSessionsSection(tmp("dimensio-m-sess-empty-")), undefined, "没有会话就不出这一段");
});

test("m 每轮自动召回是档案开关：lean 不召回（索引常驻 system），hardened 照旧召回", async (t) => {
  const { hardenedProfile } = await import("./agent/profile.ts");
  const { messageKind } = await import("./agent/injections.ts");
  const saved = process.env.KNOWLEDGE_AUTO_SEMANTIC;
  process.env.KNOWLEDGE_AUTO_SEMANTIC = "0";
  t.after(() => {
    if (saved === undefined) delete process.env.KNOWLEDGE_AUTO_SEMANTIC;
    else process.env.KNOWLEDGE_AUTO_SEMANTIC = saved;
  });
  const ws = tmp("dimensio-m-autorecall-");
  saveMemory(ws, { title: "月桥图标的动效", description: "月桥图标在加载时的呼吸动画", content: "图标用两段贝塞尔曲线。", lenient: true });
  const recalls = (s: Session) => s.state!.messages.filter((m) => messageKind(m) === "recall").length;
  const lean = attachSession(scripted(t).next(say("好")), ws, { tools: [] });
  await send(lean, "月桥图标的动效是怎么做的");
  assert.equal(recalls(lean), 0);
  const hard = attachSession(scripted(t).next(say("好")), ws, { tools: [], profile: hardenedProfile() });
  await send(hard, "月桥图标的动效是怎么做的");
  assert.equal(recalls(hard), 1);
});
