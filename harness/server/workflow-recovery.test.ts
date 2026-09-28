// O1（#9）：Workflow 中断后可找回、可续跑。
//
// 修前：journal 要等第一个 agent 跑完才第一次落盘，里面也不记发起它的工具调用 id；进程死在中途后，
// 恢复路径给跑了一半的 Workflow 回填「Not executed … Re-issue the call」——模型从头重跑，已花的 token 白花。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findWorkflowRunByToolId, makeWorkflowRunner } from "./agent/workflow.ts";
import { healDanglingToolCalls } from "./agent/state.ts";
import type { Msg } from "./agent/turn.ts";
import type { SubAgentRequest, SubAgentResult } from "./tools/types.ts";

const META = `export const meta = {
  name: 'two-steps',
  description: 'Two sequential agents',
  phases: [{ title: 'Work' }],
}`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitFor<T>(read: () => T | undefined, ok: (v: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = read();
    if (v !== undefined && ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("journal 一开跑就带着工具调用 id 落盘，进度随 agent 开跑与完成更新", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-o1-"));
  try {
    const gates = [deferred(), deferred()];
    const requests: SubAgentRequest[] = [];
    const runSubAgent = async (req: SubAgentRequest): Promise<SubAgentResult> => {
      const n = requests.push(req) - 1;
      await gates[n].promise;
      return {
        ok: true, id: req.id ?? "x", label: req.label ?? "", tier: "research", model: "fake", provider: "openai",
        text: `done ${n}`, turns: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, editedFiles: [], trail: [],
      };
    };
    const script = `${META}\nconst a = await agent("first task", { label: "one" });\nconst b = await agent("second task", { label: "two" });\nreturn [a, b];`;
    const running = makeWorkflowRunner({ runSubAgent, journalDir: dir })({ script, toolId: "wf-call-1" });
    const lookup = () => findWorkflowRunByToolId(dir, "wf-call-1");

    // 第一个 agent 还没跑完：journal 已经在了
    await waitFor(() => requests.length || undefined, (n) => n === 1, "first agent request");
    const early = await waitFor(lookup, (r) => r.started === 1, "journal header");
    assert.deepEqual({ ...early, id: "" }, { id: "", completed: 0, started: 1, finished: false });

    gates[0].resolve();
    await waitFor(() => requests.length || undefined, (n) => n === 2, "second agent request");
    const mid = await waitFor(lookup, (r) => r.completed === 1 && r.started === 2, "progress 1/2");
    assert.equal(mid.finished, false, "这一刻进程死掉，盘上就是「完成 1/2、没跑完」");

    gates[1].resolve();
    const result = await running;
    assert.equal(result.ok, true);
    assert.equal(lookup()?.finished, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("恢复时给跑了一半的 Workflow 如实回填「完成 N/M，用 resumeFromRunId 续跑」", () => {
  const msgs = (): Msg[] => [
    { role: "user", content: [{ t: "text", text: "run the review workflow" }] },
    { role: "assistant", content: [{ t: "tool_call", id: "wf-call-1", name: "Workflow", args: { script: "…" } }] },
  ];
  const healed = msgs();
  healDanglingToolCalls(healed, {
    effectOf: () => "exec",
    workflowRun: (tid) => (tid === "wf-call-1" ? { id: "wf_abc123def456", completed: 3, started: 5 } : undefined),
  });
  const text = JSON.stringify(healed.at(-1));
  assert.match(text, /3 of 5 agent calls had finished/);
  assert.match(text, /resumeFromRunId:\\"wf_abc123def456\\"/);
  assert.doesNotMatch(text, /Not executed/);

  // 找不到 journal（很老的运行）：退回通用的「结果未知、先查状态」
  const unknown = msgs();
  healDanglingToolCalls(unknown, { effectOf: () => "exec", workflowRun: () => undefined });
  assert.match(JSON.stringify(unknown.at(-1)), /result unknown/);
});
