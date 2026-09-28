import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { refreshDynamicContext, systemPrompt } from "./agent/prompt.ts";
import { Sandbox } from "./sandbox.ts";
import {
  ensureProjectKnowledge,
  findTestsForPath,
  markProjectKnowledgeDirty,
  projectKnowledgeDir,
  recordProjectVerification,
  renderProjectKnowledgeForPrompt,
} from "./knowledge.ts";
import { projectKnowledgeTool } from "./tools/projectknowledge.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

// test-setup.ts 给的基线（临时目录）。收尾还原它，不要 delete——delete 之后的解析会回落到生产目录（#14），Q8 起直接抛错。
const BASE_KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR;

afterEach(() => {
  if (BASE_KNOWLEDGE_DIR === undefined) delete process.env.KNOWLEDGE_DIR;
  else process.env.KNOWLEDGE_DIR = BASE_KNOWLEDGE_DIR;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): string {
  process.env.KNOWLEDGE_DIR = temp("dimensio-knowledge-");
  const root = temp("dimensio-project-");
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "test"));
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    main: "src/index.ts",
    scripts: { test: "node --test", build: "tsc", dev: "node src/index.ts" },
    dependencies: { express: "^5.0.0" },
    devDependencies: { typescript: "^6.0.0" },
  }));
  fs.writeFileSync(path.join(root, "src", "index.ts"), [
    "import express from 'express';",
    "export { add } from './math.ts';",
    "const app = express();",
    "const port = process.env.PORT;",
    "app.get('/api/health', (_req, res) => res.json({ ok: true }));",
    "void port;",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "src", "math.ts"), "export const add = (a:number,b:number) => a+b;\n");
  fs.writeFileSync(path.join(root, "test", "math.test.ts"), "import { add } from '../src/math.ts';\nvoid add(1, 2);\n");
  fs.writeFileSync(path.join(root, "schema.sql"), "CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY);\n");
  fs.writeFileSync(path.join(root, ".github", "workflows", "test.yml"), "name: test\n");
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM node:22\n");
  fs.writeFileSync(path.join(root, "GUIDE.md"), "# Rules\nMUST run tests before release.\n");
  return root;
}

test("project profile and test map are generated from current files", () => {
  const root = fixture();
  const generated = ensureProjectKnowledge(root);
  assert.equal(generated.rebuilt, true);
  assert.equal(generated.profile.packageManager, "npm");
  assert.equal(generated.profile.languages.TypeScript, 3);
  assert.deepEqual(generated.profile.frameworks, ["Express"]);
  assert.equal(generated.profile.commands.test, "npm run test");
  assert.ok(generated.profile.entrypoints.includes("src/index.ts"));
  assert.deepEqual(findTestsForPath(generated, "src/math.ts"), [{
    source: "src/math.ts",
    references: [{ test: "test/math.test.ts", via: "import" }],
  }]);
  assert.equal(generated.modules.modules.length, 2);
  assert.deepEqual(generated.modules.modules.find((m) => m.path === "src/math.ts")?.importedBy, ["src/index.ts"]);
  assert.equal(generated.contracts.routes[0]?.route, "/api/health");
  assert.equal(generated.contracts.config[0]?.name, "PORT");
  assert.equal(generated.health.uniqueConfigKeys, 1);
  assert.equal(generated.contracts.data[0]?.name, "jobs");
  assert.equal(generated.contracts.ci[0]?.kind, "github-actions");
  assert.equal(generated.contracts.deploy[0]?.kind, "dockerfile");
  assert.equal(generated.contracts.guides[0]?.constraints.length, 1);
  const dir = projectKnowledgeDir(root);
  assert.ok(fs.existsSync(path.join(dir, "project-profile.json")));
  assert.ok(fs.existsSync(path.join(dir, "test-map.json")));
  assert.ok(fs.existsSync(path.join(dir, "module-map.json")));
  assert.ok(fs.existsSync(path.join(dir, "runtime-contracts.json")));
  assert.ok(fs.existsSync(path.join(dir, "health.json")));
});

test("verification evidence is appended to health and survives rebuilds", () => {
  const root = fixture();
  const first = recordProjectVerification(root, {
    tool: "Bash",
    passed: true,
    detail: "node --test passed: 4/4",
    command: "npm test",
    editedPaths: [path.join(root, "src", "math.ts")],
  });
  assert.equal(first.editedPaths[0], "src/math.ts");
  assert.equal(ensureProjectKnowledge(root).health.lastPassingVerification?.detail, "node --test passed: 4/4");

  fs.appendFileSync(path.join(root, "src", "math.ts"), "export const mul = (a:number,b:number) => a*b;\n");
  markProjectKnowledgeDirty(root);
  const rebuilt = ensureProjectKnowledge(root);
  assert.equal(rebuilt.health.verifications.length, 1);
  assert.equal(rebuilt.health.lastPassingVerification?.command, "npm test");
});

test("knowledge cache reuses a matching fingerprint and rebuilds after edits", () => {
  const root = fixture();
  const first = ensureProjectKnowledge(root);
  const cached = ensureProjectKnowledge(root);
  assert.equal(cached.rebuilt, false);
  assert.equal(cached.profile.generatedAt, first.profile.generatedAt);

  fs.appendFileSync(path.join(root, "src", "math.ts"), "export const sub = (a:number,b:number) => a-b;\n");
  markProjectKnowledgeDirty(root);
  const rebuilt = ensureProjectKnowledge(root);
  assert.equal(rebuilt.rebuilt, true);
  assert.notEqual(rebuilt.profile.sourceFingerprint, first.profile.sourceFingerprint);
  assert.equal(fs.existsSync(path.join(projectKnowledgeDir(root), "dirty")), false);
});

test("knowledge cache rebuilds structurally incomplete snapshots within the same schema", () => {
  const root = fixture();
  ensureProjectKnowledge(root);
  const healthFile = path.join(projectKnowledgeDir(root), "health.json");
  const health = JSON.parse(fs.readFileSync(healthFile, "utf8")) as Record<string, unknown>;
  delete health.uniqueConfigKeys;
  fs.writeFileSync(healthFile, JSON.stringify(health));

  const rebuilt = ensureProjectKnowledge(root);
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(rebuilt.health.uniqueConfigKeys, 1);
});

test("generated knowledge enters fresh prompts and replaces stale resumed data", () => {
  const root = fixture();
  const current = renderProjectKnowledgeForPrompt(root);
  const fresh = systemPrompt({
    root, shell: "powershell", platform: "win32", provider: "test", model: "fake",
    projectKnowledge: current, memory: "- [decision] current choice",
  });
  assert.match(fresh, /## Generated project knowledge/);
  assert.match(fresh, /Tests: 1 files/);
  assert.match(fresh, /## Memory index/);

  const resumed = refreshDynamicContext(
    "core\n\n## Project guide (GUIDE.md)\nkeep\n\n## Generated project knowledge\nstale facts\n\n## Memory index\nstale memory",
    { projectKnowledge: current, memory: "- [safe] current memory" },
  );
  assert.match(resumed, /keep/);
  assert.doesNotMatch(resumed, /stale facts|stale memory/);
  assert.match(resumed, /\[safe\] current memory/);
});

// C2（N09 第 1 步，#30）：system 里的项目知识只放稳定的汇总——改一个函数体、记一次验证，渲染结果一字不差；
// 否则恢复会话时 system 尾段被整段重写，整个请求的前缀缓存作废。指纹与验证记录改由工具现查。
test("the prompt rendering stays byte-identical across a body edit and a new verification; the tool still reports both", async () => {
  const root = fixture();
  const first = ensureProjectKnowledge(root, { force: true });
  const before = renderProjectKnowledgeForPrompt(root, first);
  fs.writeFileSync(path.join(root, "src", "math.ts"), "export const add = (a:number,b:number) => b+a;\n");
  markProjectKnowledgeDirty(root);
  recordProjectVerification(root, { tool: "Bash", passed: true, detail: "node --test passed: 1/1", command: "npm test", editedPaths: [] });
  const knowledge = ensureProjectKnowledge(root);
  assert.notEqual(knowledge.profile.sourceFingerprint, first.profile.sourceFingerprint, "前提：源文件指纹真的变了");
  assert.equal(knowledge.health.verifications.length, 1, "前提：验证记录真的多了一条");
  assert.equal(renderProjectKnowledgeForPrompt(root, knowledge), before);
  assert.doesNotMatch(before, /fingerprint [0-9a-f]{6}|Health:/);

  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
  };
  const summary = await projectKnowledgeTool.run({ action: "summary" }, ctx);
  const text = String(summary.content[0] && "text" in summary.content[0] ? summary.content[0].text : "");
  assert.match(text, new RegExp(`Source fingerprint ${knowledge.profile.sourceFingerprint.slice(0, 12)}`));
  assert.match(text, /Health: 1 verification records; last pass /);
});

test("ProjectKnowledge tool answers source-to-test queries", async () => {
  const root = fixture();
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
  };
  const result = await projectKnowledgeTool.run({ action: "tests", path: "math.ts" }, ctx);
  assert.equal(result.ok, true);
  assert.match(String(result.content[0] && "text" in result.content[0] ? result.content[0].text : ""), /src\/math\.ts -> test\/math\.test\.ts \(import\)/);
});

test("a multi-project workspace names its sub-projects instead of describing only the root", () => {
  const root = fixture();
  // A second, unrelated project in the same bucket — exactly the shape that made
  // a Gradle/Java Android app get profiled as "npm, HTML, JavaScript".
  fs.mkdirSync(path.join(root, "podstream", "app", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "podstream", "build.gradle"), "apply plugin: 'com.android.application'\n");
  fs.writeFileSync(path.join(root, "podstream", "app", "src", "Raop.java"), "class Raop {}\n");

  const knowledge = ensureProjectKnowledge(root, { force: true });
  assert.deepEqual(
    knowledge.profile.subProjects.map((item) => `${item.dir}/${item.manifest}`),
    ["podstream/build.gradle"],
  );

  const rendered = renderProjectKnowledgeForPrompt(root, knowledge);
  assert.match(rendered, /Sub-projects with their own manifest/);
  assert.match(rendered, /podstream \(build\.gradle\)/);
  // The root line is still there, now explicitly scoped to the root.
  assert.match(rendered, /describe the workspace ROOT only/);
});

test("a single-project workspace says nothing about sub-projects", () => {
  const root = fixture();
  const rendered = renderProjectKnowledgeForPrompt(root, ensureProjectKnowledge(root, { force: true }));
  assert.doesNotMatch(rendered, /Sub-projects/);
});

test("every generated artifact carries the same schema, so the cache can be reused", () => {
  const root = fixture();
  ensureProjectKnowledge(root);
  const dir = projectKnowledgeDir(root);
  // The cache check compares ALL five files against one constant. When that
  // number lived in two files, bumping one side turned every read into a full
  // rebuild — silent, and only visible as "why is this suddenly slow".
  const schemas = ["project-profile.json", "test-map.json", "module-map.json", "runtime-contracts.json", "health.json"]
    .map((name) => (JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { schema: number }).schema);
  assert.equal(new Set(schemas).size, 1, `artifact schemas drifted: ${schemas.join(", ")}`);
  assert.equal(ensureProjectKnowledge(root).rebuilt, false);
});
