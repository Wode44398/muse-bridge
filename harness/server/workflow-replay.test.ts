// O4（H5）：Workflow 续跑时回放的副作用安全——coder 条目记下它改过的文件的哈希，磁盘对得上才回放；这次续跑里一旦有 coder 真跑
// 并写了文件，之后的 coder 条目不再回放（research 条目照常）；旧日志里没记改动的 coder 条目核对不了，也重跑。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeWorkflowRunner } from "./agent/workflow.ts";
import type { SubAgentRequest, SubAgentResult } from "./tools/types.ts";

const META = `export const meta = { name: 'o4', description: 'replay safety' }`;

function setup(t: test.TestContext) {
  const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-o4-j-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-o4-ws-"));
  t.after(() => {
    fs.rmSync(journalDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });
  const runs = new Map<string, number>();
  // coder 的桩：把「第几次跑」写进 <prompt>.txt，交回改过的文件；research 只交回文本
  const run = async (req: SubAgentRequest): Promise<SubAgentResult> => {
    const n = (runs.get(req.prompt) ?? 0) + 1;
    runs.set(req.prompt, n);
    const file = path.join(ws, `${req.prompt}.txt`);
    const coder = req.tier === "coder";
    if (coder) fs.writeFileSync(file, `${req.prompt} run ${n}`);
    return {
      ok: true, id: req.id ?? "x", label: req.label ?? "", tier: coder ? "coder" : "research", model: "fake", provider: "openai",
      text: `${req.prompt} done`, turns: 1, toolCalls: 1, inputTokens: 1, outputTokens: 1, editedFiles: coder ? [file] : [], trail: [],
    };
  };
  return { wf: makeWorkflowRunner({ runSubAgent: run, journalDir }), runs, ws };
}

test("O4 coder 条目只有它改过的文件没变才回放；文件变了（检查点回滚、手改）就重跑并说明原因", async (t) => {
  const { wf, runs, ws } = setup(t);
  const script = `${META}\nreturn await agent("fix", { tools: "coder" });`;
  const first = await wf({ script });
  assert.equal(first.ok, true, first.error);
  const again = await wf({ script, resumeFromRunId: first.id });
  assert.equal(runs.get("fix"), 1, "文件没变：从日志回放");
  assert.equal(again.cached, 1);

  fs.writeFileSync(path.join(ws, "fix.txt"), "rolled back to before the fix");
  const third = await wf({ script, resumeFromRunId: again.id });
  assert.equal(runs.get("fix"), 2, "文件变了：重跑");
  assert.equal(third.cached, 0);
  assert.match(third.logs.join("\n"), /agent ".+": not replayed from the journal — files it edited have changed since/);
});

test("O4 这次续跑里一旦有 coder 真跑写了文件，之后的 coder 条目不再回放；research 条目照常回放", async (t) => {
  const { wf, runs, ws } = setup(t);
  const script = `${META}
const a = await agent("A", { tools: "coder" });
const r = await agent("R");
const b = await agent("B", { tools: "coder" });
return [a, r, b];`;
  const first = await wf({ script });
  assert.equal(first.ok, true, first.error);
  fs.writeFileSync(path.join(ws, "A.txt"), "someone changed A");
  const resumed = await wf({ script, resumeFromRunId: first.id });
  assert.deepEqual([runs.get("A"), runs.get("R"), runs.get("B")], [2, 1, 2], "A 变了重跑；R 照常回放；B 的文件没变，但 A 已经真写过，不再回放");
  assert.match(resumed.logs.join("\n"), /agent ".+": not replayed from the journal — a coder agent already wrote files live in this run/);
});

test("O4 旧日志里没记改动的 coder 条目核对不了，重跑；research 条目不受影响", async (t) => {
  const { wf, runs } = setup(t);
  const script = `${META}\nconst r = await agent("R");\nconst c = await agent("C", { tools: "coder" });\nreturn [r, c];`;
  const first = await wf({ script });
  const j = JSON.parse(fs.readFileSync(first.journalPath!, "utf8"));
  for (const e of j.entries) delete e.edited; // 模拟 O4 之前写的日志
  fs.writeFileSync(first.journalPath!, JSON.stringify(j));
  const resumed = await wf({ script, resumeFromRunId: first.id });
  assert.deepEqual([runs.get("R"), runs.get("C")], [1, 2]);
  assert.match(resumed.logs.join("\n"), /no record of the files it edited/);
});
