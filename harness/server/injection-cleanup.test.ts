// C7（MiMo #59、#60）：注入清理。
//
// 修前：① 项目画像的列表为空时渲染出孤立句点（「Entrypoints . Manifests .」），空工作区也往 system prompt 里注入一段
// 「0 source files / 0 routes / 0 files」样板；② 自动召回把检索打分的理由和标题拼在一行（`- [id] 标题; why=标题命中 1 个词;`），
// 读起来像「这条验证通过的理由是标题命中一个词」，而且陈旧的失败验证也被一并塞进上下文。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { systemPrompt } from "./agent/prompt.ts";
import { ensureProjectKnowledge, recordProjectVerification, renderProjectKnowledgeForPrompt } from "./knowledge.ts";
import { searchUnifiedKnowledge } from "./knowledge-search.ts";
import { renderAutomaticRecall } from "./session.ts";

function workspace(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-c7-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("C7（#59）: an empty workspace injects no knowledge section; empty fields are left out instead of rendered as blanks", async (t) => {
  const empty = workspace(t);
  assert.equal(renderProjectKnowledgeForPrompt(empty), "", "什么事实都没有：整段不注入");
  const prompt = systemPrompt({ root: empty, shell: "bash", platform: "linux", provider: "openai", model: "m", projectKnowledge: renderProjectKnowledgeForPrompt(empty) });
  assert.ok(!prompt.includes("## Generated project knowledge"));
  const search = await searchUnifiedKnowledge(empty, "project profile entrypoints manifests", { semantic: false, recordMetrics: false });
  assert.ok(!search.results.some((r) => /Entrypoints \.|Manifests \./.test(r.document.text)), "不再有孤立句点");

  const node = workspace(t);
  fs.writeFileSync(path.join(node, "package.json"), JSON.stringify({ name: "x", scripts: { build: "tsc" } }));
  const rendered = renderProjectKnowledgeForPrompt(node, ensureProjectKnowledge(node, { force: true }));
  assert.match(rendered, /Commands: build=/);
  assert.ok(!/\b0 (?:routes|source files|files|data models)/.test(rendered), `空的计数整行省略：\n${rendered}`);
  assert.ok(!rendered.includes("none detected") && !rendered.includes("not detected"));
});

test("C7（#60）: matched reasons get their own line, and automatic recall keeps passing checks plus only the latest failure", async (t) => {
  const text = renderAutomaticRecall({
    query: "q",
    results: [{
      document: { id: "verification:1", kind: "verification", title: "PASS Bash", text: "tests ok", paths: ["src/a.ts"], scope: [], source: "health.json" },
      score: 1, lexicalScore: 1, reasons: ["标题命中 1 个词"],
    }],
    totalDocuments: 1, eligibleDocuments: 1, skippedQuarantined: 0, semantic: "disabled", latencyMs: 0,
  }) ?? "";
  assert.match(text, /\n- \[verification:1\] PASS Bash\n  matched: 标题命中 1 个词; paths: src\/a\.ts\n  tests ok/);
  assert.ok(!text.includes("why="));

  const root = workspace(t);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x" }));
  recordProjectVerification(root, { tool: "Bash", passed: false, detail: "old failure", command: "npm test" });
  recordProjectVerification(root, { tool: "Bash", passed: true, detail: "suite green", command: "npm test" });
  recordProjectVerification(root, { tool: "Bash", passed: false, detail: "latest failure", command: "npm test" });
  const kinds = ["verification" as const];
  const all = await searchUnifiedKnowledge(root, "npm test", { semantic: false, kinds, recordMetrics: false });
  assert.equal(all.results.length, 3, "显式检索照旧查得到全部历史");
  const auto = await searchUnifiedKnowledge(root, "npm test", { semantic: false, kinds, recordMetrics: false, latestFailureOnly: true });
  const details = auto.results.map((r) => r.document.text);
  assert.equal(auto.results.length, 2);
  assert.ok(details.some((d) => d.includes("suite green")) && details.some((d) => d.includes("latest failure")));
  assert.ok(!details.some((d) => d.includes("old failure")), "陈旧的失败不进自动召回");
});
