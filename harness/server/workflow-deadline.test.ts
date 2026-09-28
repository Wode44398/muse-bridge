// R18（hermes HM08）：Workflow 的时限改成「软停」。
//
// 修前：到了时限（默认 60 分钟，模型改不了）直接 abort——已经在跑、做了一半的 agent 全部被掐掉，结果全扔；和默认规模
// （60 个 agent、coder 各 30 分钟、并发 3）自相矛盾。
// 修后：到点不再派新 agent（还没开始的 agent() 返回 null，和失败的 agent 同一约定，脚本照常拿着已有结果收尾），在跑的
// 再给一段宽限（不超过 10 分钟、也不超过时限本身）跑完，超了才整个中止；到点时没有在跑的（脚本多半卡住了）立刻停；在跑的
// 都完了脚本还不收尾，再给 30 秒。模型可以用 deadlineMinutes 按规模给时限。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeWorkflowRunner } from "./agent/workflow.ts";
import { Sandbox } from "./sandbox.ts";
import { workflowTool } from "./tools/workflow.ts";
import type { SubAgentRequest, SubAgentResult, ToolContext, WorkflowRequest, WorkflowResult } from "./tools/types.ts";

const META = `export const meta = { name: 'deadline-probe', description: 'Probe the soft deadline', phases: [{ title: 'Work' }] }`;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r18-"));
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(true), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve(false);
    }, { once: true });
  });

// 假子 agent：prompt 写着要跑多久（"slow:600"），跑完回 prompt；中途被中止就报失败
function runner(requests: SubAgentRequest[] = []) {
  return async (req: SubAgentRequest): Promise<SubAgentResult> => {
    requests.push(req);
    const ms = Number(/^slow:(\d+)/.exec(req.prompt)?.[1] ?? 0);
    const finished = ms ? await sleep(ms, req.signal) : true;
    return {
      ok: finished && !req.signal?.aborted, id: req.id ?? "x", label: req.label ?? "", tier: req.tier ?? "research", model: "fake", provider: "openai",
      text: finished ? `done ${req.prompt}` : "", ...(finished ? {} : { error: "aborted" }),
      turns: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, editedFiles: [], trail: [],
    };
  };
}

test("R18 到时限：在跑的 agent 不被掐、跑完照常交结果；还没开始的返回 null 并计数；日志里说清楚", async () => {
  const requests: SubAgentRequest[] = [];
  // 时限 1 秒、宽限 = min(10 分钟, 时限) = 1 秒：跑 1.6 秒的那个在宽限内跑完。时间都按秒给：脚本跑在单独的沙箱进程里，
  // 全量并发跑时进程起得慢、计时器会漂，几百毫秒的余量不稳
  const run = makeWorkflowRunner({ runSubAgent: runner(requests), journalDir: tmpDir(), defaults: { deadlineMs: 1_000, maxConcurrency: 1 } });
  const r = await run({ script: `${META}\nreturn await Promise.all([agent('slow:1600'), agent('slow:10 second'), agent('slow:10 third')])` });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, ["done slow:1600", null, null], "做了一半的那个跑完了，排队的两个没开始");
  assert.equal(r.skipped, 2);
  assert.equal(requests.length, 1, "到点之后一个新 agent 都没派");
  assert.equal(requests[0].signal?.aborted, false, "在跑的没有收到中止");
  assert.ok(r.logs.some((l) => /deadline reached/.test(l)), r.logs.join(" | "));
});

test("R18 宽限用完才硬停；到点时没有在跑的立刻停；在跑的都完了脚本还不收尾也停", async () => {
  // 宽限 = min(10 分钟, 时限) = 1 秒：跑 8 秒的 agent 在 ~2 秒时被中止
  const t0 = Date.now();
  const long = await makeWorkflowRunner({ runSubAgent: runner(), journalDir: tmpDir(), defaults: { deadlineMs: 1_000 } })({
    script: `${META}\nreturn await agent('slow:8000')`,
  });
  assert.equal(long.ok, false);
  assert.match(long.error ?? "", /did not finish within the 1 s grace period/);
  assert.ok(Date.now() - t0 < 6_000, `${Date.now() - t0}ms`);

  // 到点时一个在跑的都没有：立刻停（脚本死循环也管得住）
  const idle = await makeWorkflowRunner({ runSubAgent: runner(), journalDir: tmpDir(), defaults: { deadlineMs: 200 } })({
    script: `${META}\nawait agent('quick')\nwhile (true) {}`,
  });
  assert.equal(idle.ok, false);
  assert.equal(idle.error, "workflow deadline exceeded");

  // 在跑的完了，脚本还在一个劲地 agent()（到点后都回 null）：再给 min(30 秒, 时限) 就停。时限 1 秒、宽限到 2 秒，
  // 那个 agent 1.5 秒跑完
  const loop = await makeWorkflowRunner({ runSubAgent: runner(), journalDir: tmpDir(), defaults: { deadlineMs: 1_000 } })({
    script: `${META}\nawait agent('slow:1500')\nwhile (true) { await agent('again') }`,
  });
  assert.equal(loop.ok, false);
  assert.match(loop.error ?? "", /did not finish after its last running agent/);
  assert.ok((loop.skipped ?? 0) > 0);
});

test("R18 Workflow 工具：deadlineMinutes 传到时限，统计行写明没开始的个数", async () => {
  const seen: WorkflowRequest[] = [];
  const ctx = {
    runWorkflow: async (req: WorkflowRequest): Promise<WorkflowResult> => {
      seen.push(req);
      return {
        ok: true, id: "wf_r18abcdef", name: "deadline-probe", description: "", phases: [], result: [1, null], agents: [],
        cached: 0, inputTokens: 0, outputTokens: 0, durationMs: 1000, logs: ["deadline reached (5 min): …"], journalPath: "", skipped: 2,
      };
    },
    sandbox: new Sandbox(tmpDir()),
  } as unknown as ToolContext;
  const res = await workflowTool.run({ script: `${META}\nreturn 1`, deadlineMinutes: 5 }, ctx);
  assert.equal(seen[0].limits?.deadlineMs, 5 * 60_000);
  assert.match(res.summary, /2 not started \(deadline reached\)/);
  const props = (workflowTool.def.parameters.properties as Record<string, { maximum?: number }>).deadlineMinutes;
  assert.equal(props?.maximum, 360);
});
