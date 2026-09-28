import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { getSearchMetrics, searchUnifiedKnowledge } from "./knowledge-search.ts";
import { memoryDir, saveMemory } from "./memory.ts";
import { recallIds } from "./agent/injections.ts";
import { visibleMessages } from "./agent/state.ts";
import { dropSession, sessionRecord } from "./session.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";

const roots: string[] = [];
const originalFetch = globalThis.fetch;
// test-setup.ts 给的基线（临时目录）。收尾还原它，不要 delete——delete 之后的解析会回落到生产目录（#14），Q8 起直接抛错。
const BASE = { KNOWLEDGE_DIR: process.env.KNOWLEDGE_DIR, MEMORY_DIR: process.env.MEMORY_DIR };

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fixture(): string {
  process.env.KNOWLEDGE_DIR = temp("dimensio-search-knowledge-");
  process.env.MEMORY_DIR = temp("dimensio-search-memory-");
  const root = temp("dimensio-search-project-");
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(root, "src", "math.ts"), "export const add = (a:number,b:number) => a+b;\n");
  fs.writeFileSync(path.join(root, "src", "api.ts"), "const port = process.env.PORT;\napp.get('/health', handler);\nvoid port;\n");
  fs.writeFileSync(path.join(root, "test", "math.test.ts"), "import { add } from '../src/math.ts';\nvoid add(1, 2);\n");
  return root;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(BASE)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.KNOWLEDGE_EMBEDDING_API_KEY;
  delete process.env.KNOWLEDGE_EMBEDDING_BASE_URL;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

test("hybrid retrieval ranks exact paths and keywords and records privacy-safe metrics", async () => {
  const root = fixture();
  saveMemory(root, {
    id: "architecture-ruling",
    title: "Architecture ruling",
    description: "Use files as the durable source of truth.",
    type: "user",
    topic: "architecture",
    status: "active",
    confidence: "user_confirmed",
    content: "Keep curated decisions in readable files; generated facts stay rebuildable.",
    scope: ["memory", "architecture"],
  });
  saveMemory(root, {
    id: "untrusted-idea",
    title: "Untrusted idea",
    description: "An unverified idea that must remain quarantined.",
    type: "project",
    topic: "untrusted",
    status: "proposed",
    confidence: "inferred",
    content: "This may be useful later.",
  });

  const byPath = await searchUnifiedKnowledge(root, "math tests", { path: "src/math.ts", semantic: false });
  assert.ok(byPath.results.length > 0);
  assert.ok(byPath.results.every((item) => item.document.paths.some((p) => p.includes("src/math.ts"))));
  assert.ok(byPath.results.some((item) => item.document.kind === "test"));
  assert.ok(byPath.results.every((item) => item.reasons.length > 0));

  const quarantined = await searchUnifiedKnowledge(root, "untrusted idea", { semantic: false });
  assert.equal(quarantined.results.some((item) => item.document.id === "memory:untrusted-idea"), false);
  assert.equal(quarantined.skippedQuarantined, 1);
  const diagnostic = await searchUnifiedKnowledge(root, "untrusted idea", { semantic: false, includeQuarantined: true });
  assert.equal(diagnostic.results[0]?.document.id, "memory:untrusted-idea");

  const metrics = getSearchMetrics(root);
  assert.equal(metrics.queries, 3);
  assert.equal(metrics.recent.some((item) => JSON.stringify(item).includes("untrusted idea")), false);
});

test("expired memory is automatically quarantined before retrieval", async () => {
  const root = fixture();
  saveMemory(root, {
    id: "temporary-rule",
    title: "Temporary rule",
    description: "A temporary unique recall rule.",
    type: "user",
    topic: "temporary-rule",
    status: "active",
    confidence: "user_confirmed",
    expiresAt: "2099-01-01T00:00:00.000Z",
    content: "ephemeral-recall-token must be used while this note is current.",
  });
  const file = path.join(memoryDir(root), "temporary-rule.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("2099-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"));

  const current = await searchUnifiedKnowledge(root, "ephemeral-recall-token", { semantic: false });
  assert.equal(current.results.length, 0);
  const diagnostic = await searchUnifiedKnowledge(root, "ephemeral-recall-token", { semantic: false, includeQuarantined: true });
  assert.equal(diagnostic.results[0]?.document.status, "stale");
  assert.ok(diagnostic.results[0]?.document.id === "memory:temporary-rule");
});

test("semantic retrieval supplements lexical matching and persists only document vectors", async () => {
  const root = fixture();
  process.env.KNOWLEDGE_EMBEDDING_API_KEY = "test-key";
  process.env.KNOWLEDGE_EMBEDDING_BASE_URL = "https://embedding.invalid/v1";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({
      data: body.input.map((text, index) => ({
        index,
        embedding: Array.from({ length: 256 }, (_, i) => {
          if (/conceptual arithmetic/i.test(text)) return i === 0 ? 1 : 0;
          if (/math/i.test(text)) return i === 0 ? 0.4 : i === 1 ? Math.sqrt(0.84) : 0;
          return i === 1 ? 1 : 0;
        }),
      })),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const response = await searchUnifiedKnowledge(root, "conceptual arithmetic", { generatedOnly: true, semantic: true });
  assert.equal(response.semantic, "used");
  assert.equal(response.results[0]?.document.id, "module:src/math.ts");
  assert.ok((response.results[0]?.semanticScore ?? 0) > 0.39);

  const cache = fs.readFileSync(path.join(process.env.KNOWLEDGE_DIR!, "workspaces", fs.readdirSync(path.join(process.env.KNOWLEDGE_DIR!, "workspaces"))[0], "semantic-index.json"), "utf8");
  assert.doesNotMatch(cache, /conceptual arithmetic/);
  assert.doesNotMatch(cache, /test-key/);
});

// C1（#35，改掉原来钉住「召回不落盘」的错误契约）：自动召回作为 internal 消息追加在本轮用户消息之后、随会话落盘——
// 聊天记录里看不到；下一轮的请求是上一轮的纯追加（以前召回一消失，前缀就在它的位置断开）；已经注入过的文档不重复追加。
test("automatic recall is persisted as a hidden internal message, keeps the next request an append, and is not repeated", async (t) => {
  const root = fixture();
  const saved = process.env.KNOWLEDGE_AUTO_SEMANTIC;
  process.env.KNOWLEDGE_AUTO_SEMANTIC = "0";
  t.after(() => {
    if (saved === undefined) delete process.env.KNOWLEDGE_AUTO_SEMANTIC;
    else process.env.KNOWLEDGE_AUTO_SEMANTIC = saved;
  });
  const adapter = scripted(t).next(say("one"), say("two"));
  const session = attachSession(adapter, root);
  await send(session, "fix the /health route in src/api.ts");
  const state = session.state!;
  const recalls = () => state.messages.filter((m) => m.content.some((b) => b.t === "text" && b.text.startsWith("[Automatically recalled")));
  assert.equal(recalls().length, 1, "召回进了转录");
  assert.equal(recalls()[0].internal, true);
  assert.ok(recallIds(state.messages).includes("module:src/api.ts"));
  assert.equal(visibleMessages(state.messages).some((m) => m.content.some((b) => b.t === "text" && /Automatically recalled/.test(b.text))), false, "聊天记录里不显示");
  assert.ok(sessionRecord(session)?.messages.some((m) => m.internal && m.content.some((b) => b.t === "text" && /Automatically recalled/.test(b.text))), "随会话落盘");

  await send(session, "fix the /health route in src/api.ts again");
  assert.equal(recalls().length, 1, "同样的文档已经注入过，不再追加");
  const [first, second] = adapter.inputs;
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages, "下一轮请求是上一轮的纯追加");
  dropSession(session.id);
});
