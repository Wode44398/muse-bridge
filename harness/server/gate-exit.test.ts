// V2（#21）：验证门禁的出口。改写自探针 03-hermes-agent/笔记/probe-gate-exhaust-hides-answer.ts。
//
// 修前：连续追问用尽后，4 版答复全部被 turn_discard 撤回、标成 internal，结尾只剩一行英文 error——
// 时间线和会话历史里一版答复都看不到；撤回时不说原因；每次新编辑都把追问计数清零（边改边交答复的模型
// 永远走不到出口）；只改 .md 也要被追问。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { AgentState, visibleMessages } from "./agent/state.ts";
import { runAgent } from "./agent/loop.ts";
import { Sandbox } from "./sandbox.ts";
import { ok } from "./tools/types.ts";
import type { AgentEvent, StreamEvent } from "./agent/events.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { Tool } from "./tools/types.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-v2-"));
after(() => fs.rmSync(ws, { recursive: true, force: true }));

const edit: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: { name: "Edit", description: "fake edit", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("edited", "edited");
  },
};

async function run(script: (turn: number) => StreamEvent[]) {
  let turn = 0;
  const adapter: ProviderAdapter = {
    id: "openai",
    model: "fake",
    capabilities: { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false },
    async *stream() {
      turn++;
      for (const ev of script(turn)) yield ev;
    },
  };
  const state = new AgentState({
    adapter,
    system: "t",
    tools: [edit.def],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(ws), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1, bashMaxTimeoutMs: 1 }, agentSeesImages: false },
    toolMap: new Map([["Edit", edit]]),
    permissionMode: "auto",
    memoryAuditRequired: false,
    finalFootnotes: true,
  });
  state.addUserMessage("改一下");
  const events: AgentEvent[] = [];
  for await (const ev of runAgent(state, new AbortController().signal)) events.push(ev);
  const visibleTexts = visibleMessages(state.messages)
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.filter((b) => b.t === "text").map((b) => (b as { text: string }).text));
  return { state, events, turns: () => turn, visibleTexts };
}

const editCall = (file: string, id: string): StreamEvent[] => [
  { e: "tool_call", id, name: "Edit", args: { path: file } },
  { e: "turn_done", stopReason: "tool_use" },
];
const answer = (text: string): StreamEvent[] => [
  { e: "text_delta", text },
  { e: "turn_done", stopReason: "end" },
];

test("追问用尽：交付最后一版答复并附「未验证」尾注，不再报错吞答复；撤回时说明原因", async () => {
  let n = 0;
  const r = await run((turn) => (turn === 1 ? editCall("file.ts", "e1") : answer(`总结 v${++n}：已修改 file.ts`)));
  assert.equal(r.events.at(-1)?.e, "done", "以 done 收场，不是 error");
  assert.ok(!r.events.some((e) => e.e === "error"));
  const discards = r.events.filter((e) => e.e === "turn_discard") as { reason?: string }[];
  assert.equal(discards.length, 3, "追问三次");
  assert.ok(discards.every((d) => /还没有通过的验证/.test(d.reason ?? "")), "每次撤回都说明原因");
  assert.equal(r.visibleTexts.length, 1, "最后一版答复看得见");
  assert.match(r.visibleTexts[0], /^总结 v4/);
  assert.match(r.visibleTexts[0], /⚠️ 未验证：这一轮改了 1 个文件，但没有通过的验证证据（门禁追问 3 次后放行）/);
});

test("追问计数只在成功时清零：边改边交答复的模型也会走到出口", async () => {
  let n = 0;
  // 1 改、2 答、3 改、4 答、5 改、6 答、7 改、8 答……每两轮之间都有新编辑
  const r = await run((turn) => (turn % 2 === 1 && turn <= 7 ? editCall("file.ts", `e${turn}`) : answer(`答复 v${++n}`)));
  assert.equal(r.events.at(-1)?.e, "done");
  assert.equal(r.turns(), 8, "第 4 版答复（第 8 轮）交付，不再无限追问");
  assert.match(r.visibleTexts.at(-1) ?? "", /^答复 v4/);
});

test("只改文档类文件不进验证门禁", async () => {
  const r = await run((turn) => (turn === 1 ? editCall("README.md", "e1") : answer("文档已更新。")));
  assert.equal(r.events.filter((e) => e.e === "turn_discard").length, 0);
  assert.equal(r.turns(), 2);
  assert.deepEqual(r.visibleTexts, ["文档已更新。"]);
});
