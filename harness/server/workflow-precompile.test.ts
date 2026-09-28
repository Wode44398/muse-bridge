// O5（H3、H4）：Workflow 提交前先编译 + 草稿 / scriptPath；SubmitResult 按 schema 宽容解析。
//
// 修前：① 编不过的脚本照样弹确认卡——用户在手机上批准了，跑起来第一步就报语法错；小改一处也得把整段脚本再发一遍。
// ② 子 agent 交结构化结果时，把数组写成 JSON 字符串、把数字写成 "3" 都要被拒，白白用掉修复机会。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { WORKFLOW_WRAP_PREFIX, wrapWorkflowBody } from "./agent/workflow.ts";
import { coerceToSchema, validateSchema } from "./agent/schema.ts";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import type { JsonObjectSchema } from "./agent/turn.ts";
import { call, calls, scripted } from "./test-harness/scripted-adapter.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext, WorkflowRequest } from "./tools/types.ts";
import { WORKFLOW_DRAFT_DIR, workflowTool } from "./tools/workflow.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-o5-"));
  roots.push(root);
  const cards: string[] = [];
  const runs: string[] = [];
  const ctx = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    requestPermission: async (req: { subject: string }) => {
      cards.push(req.subject);
      return { decision: "once" as const };
    },
    runWorkflow: async (req: WorkflowRequest) => {
      runs.push(req.script);
      return { id: "wf_test", name: "n", description: "d", phases: [], ok: true, agents: [], cached: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, startedAt: 0, logs: [], result: "done" };
    },
  } as unknown as ToolContext;
  return { root, ctx, cards, runs };
}

const text = (r: { content: { t: string; text?: string }[] }) => r.content.map((b) => b.text ?? "").join("");
const BROKEN = [
  "export const meta = { name: \"代码审查\", description: \"逐个维度审一遍\" };",
  "const a = await agent(\"看看\");",
  "const b = ;",
  "return a;",
].join("\n");

test("O5（H3）编不过的脚本：弹卡之前就退回，报的是用户脚本里的行号与那一行；脚本存成草稿（git 看不见）", async () => {
  const { root, ctx, cards, runs } = harness();
  // P11：确认卡由统一权限闸按 prepare() 的结论弹——编不过就是否决（不要求确认）
  const prepared = await workflowTool.prepare!({ script: BROKEN }, ctx);
  assert.match(prepared?.veto?.content ?? "", /does not compile \(line 3: const b = ;\)/);
  assert.equal(prepared?.confirm, undefined, "不弹确认卡");
  const r = await workflowTool.run({ script: BROKEN }, ctx);
  assert.equal(r.ok, false);
  assert.match(text(r), /does not compile \(line 3: const b = ;\)/, text(r));
  assert.equal(cards.length, 0, "没弹确认卡");
  assert.equal(runs.length, 0, "没跑");
  const draft = path.join(root, WORKFLOW_DRAFT_DIR, "代码审查.js");
  assert.equal(fs.readFileSync(draft, "utf8"), BROKEN, "草稿就是提交的原文");
  assert.equal(fs.readFileSync(path.join(root, WORKFLOW_DRAFT_DIR, ".gitignore"), "utf8").trim(), "*");
  assert.ok(text(r).includes(path.join(".dimensio", "workflows", "代码审查.js")) || text(r).includes(".dimensio/workflows/代码审查.js"), "告诉模型草稿在哪、用 scriptPath 重交");
});

test("O5（H3）改草稿后用 scriptPath 重交：照常弹卡、跑的是改过的脚本；scriptPath 过密钥守卫；包装与沙箱逐字一致", async () => {
  const { root, ctx, cards, runs } = harness();
  await workflowTool.run({ script: BROKEN }, ctx);
  const rel = path.join(".dimensio", "workflows", "代码审查.js");
  const fixed = BROKEN.replace("const b = ;", "const b = 1;");
  fs.writeFileSync(path.join(root, rel), fixed); // 模型用 Edit 改了一行
  // P11：这次要求确认（卡由统一权限闸弹），卡上摆的是改过的草稿
  const prepared = await workflowTool.prepare!({ scriptPath: rel }, ctx);
  assert.ok(prepared?.confirm, "这次要弹确认卡");
  assert.equal(prepared?.preview?.kind === "script" ? prepared.preview.script : "", fixed, "卡上是改过的草稿");
  const r = await workflowTool.run({ scriptPath: rel }, ctx);
  assert.equal(r.ok, true, text(r));
  assert.equal(cards.length, 0, "run() 自己不再弹卡");
  assert.equal(runs[0], fixed, "跑的是改过的草稿");

  fs.writeFileSync(path.join(root, ".env"), "API_KEY=sk-DUMMY-not-a-real-key\n");
  const leak = await workflowTool.run({ scriptPath: ".env" }, ctx);
  assert.equal(leak.ok, false);
  assert.ok(!text(leak).includes("sk-DUMMY"), "不会把凭据文件的内容当脚本报出来");

  const sandboxSrc = fs.readFileSync(path.join(import.meta.dirname, "agent", "workflow-sandbox.ts"), "utf8");
  assert.equal(WORKFLOW_WRAP_PREFIX, "(async () => {\n");
  assert.ok(sandboxSrc.includes("new vm.Script(`(async () => {\\n${data.body}\\n})()`"), "沙箱的包装与 wrapWorkflowBody 逐字一致（行号换算靠它）");
  assert.equal(wrapWorkflowBody("x"), "(async () => {\nx\n})()");
});

test("O5（H4）SubmitResult 宽容解析：JSON 字符串包着的数组 / 对象、数字与布尔字符串按 schema 修正；修正后仍不对，报修正后的问题", () => {
  const schema: JsonObjectSchema = {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "string" } },
      count: { type: "integer" },
      ok: { type: "boolean" },
      meta: { type: "object", properties: { score: { type: "number" } } },
    },
    required: ["items", "count"],
  };
  const fixed = coerceToSchema(schema, { items: "[\"a\",\"b\"]", count: "2", ok: "true", meta: "{\"score\":\"0.5\"}" });
  assert.equal(fixed.changed, true);
  assert.deepEqual(fixed.value, { items: ["a", "b"], count: 2, ok: true, meta: { score: 0.5 } });
  assert.deepEqual(validateSchema(schema, fixed.value), []);

  const still = coerceToSchema(schema, { items: "[1,2]", count: "2.5" });
  assert.deepEqual(still.value, { items: [1, 2], count: "2.5" }, "2.5 不是整数，不硬转");
  assert.deepEqual(
    validateSchema(schema, still.value).map((e) => e.path),
    ["$.items[0]", "$.items[1]", "$.count"],
    "报的是修正后对象上的问题",
  );
  assert.equal(coerceToSchema(schema, { items: ["x"], count: 1 }).changed, false, "本来就对的原样不动");
});

test("O5（H4）真子 agent：第一次提交就把数组写成 JSON 字符串、数字写成字符串——直接收下，不耗修复机会", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-o5-sub-"));
  roots.push(root);
  // 只有一步脚本：第一次提交就收下（多调一次 = 脚本用完，scripted 判失败）
  const adapter = scripted(t).next(calls(call("s1", "SubmitResult", { findings: "[\"a.ts\",\"b.ts\"]", total: "2" })));
  const run = makeSubAgentRunner(
    { provider: "openai", apiKey: "FAKE-KEY", model: "fake", thinking: "off", sandbox: new Sandbox(root), limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 } },
    () => adapter,
  );
  const r = await run({
    prompt: "list files",
    schema: { type: "object", properties: { findings: { type: "array", items: { type: "string" } }, total: { type: "integer" } }, required: ["findings", "total"] },
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { findings: ["a.ts", "b.ts"], total: 2 });
  assert.equal(adapter.callCount, 1, "第一次就收下，没有「请修正再交」的来回");
});
