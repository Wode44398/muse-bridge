// V3（#33）：编辑没落地，最终答复下由服务端点名列出。改写自探针 03-hermes-agent/笔记/probe-failed-edit-gate.ts。
//
// 修前：失败的 Edit 不进 editedFiles，完成门禁零介入，模型宣称「修改完成」原样交付，界面上也没有任何
// 「这些编辑其实失败了」的提示——「说改好了其实没改」是最伤信任的错误。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { AgentState } from "./agent/state.ts";
import { runAgent } from "./agent/loop.ts";
import { Sandbox } from "./sandbox.ts";
import { fail, ok } from "./tools/types.ts";
import type { StreamEvent } from "./agent/events.ts";
import type { PermissionMode } from "./agent/permissions.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { Tool } from "./tools/types.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-v3-"));
after(() => fs.rmSync(ws, { recursive: true, force: true }));

// 第 1 次调用失败（old_string 找不到），之后成功——对应「改错了、重试成功」。
function flakyEdit(failures: number): Tool {
  let calls = 0;
  return {
    effect: "write",
    concurrencySafe: false,
    def: { name: "Edit", description: "fake edit", parameters: { type: "object", properties: {} } },
    async run() {
      return ++calls <= failures ? fail("edit failed: no match", "old_string not found") : ok("edited", "edited");
    },
  };
}

async function finalText(script: (turn: number) => StreamEvent[], edit: Tool, mode: PermissionMode = "auto"): Promise<string> {
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
    permissionMode: mode,
    memoryAuditRequired: false,
    finalFootnotes: true,
  });
  state.addUserMessage("把 a 改成 b");
  for await (const _ of runAgent(state, new AbortController().signal)) { /* drain */ }
  return (state.messages.at(-1)?.content ?? []).map((b) => (b.t === "text" ? b.text : "")).join("");
}

const editCall = (file: string, id: string): StreamEvent[] => [
  { e: "tool_call", id, name: "Edit", args: { path: file, old_string: "a", new_string: "b" } },
  { e: "turn_done", stopReason: "tool_use" },
];
const answer = (text: string): StreamEvent[] => [{ e: "text_delta", text }, { e: "turn_done", stopReason: "end" }];

test("编辑全部失败、模型却说改好了：最终答复下点名列出没落地的编辑", async () => {
  const text = await finalText((turn) => (turn === 1 ? editCall("file.ts", "e1") : answer("已把 a 改成 b，修改完成。")), flakyEdit(99));
  assert.match(text, /^已把 a 改成 b，修改完成。/);
  assert.match(text, /⚠️ 这些编辑没有落地：`file\.ts`（edit failed: no match）/);
});

test("失败后同一路径重试成功：销账，不再列出", async () => {
  const text = await finalText(
    (turn) => (turn === 1 ? editCall("notes.md", "e1") : turn === 2 ? editCall("notes.md", "e2") : answer("笔记已更新。")),
    flakyEdit(1),
  );
  assert.equal(text, "笔记已更新。", "文档编辑、没有失败残留：一个尾注都不该有");
});

test("被权限拒绝的编辑同样列出", async () => {
  const text = await finalText((turn) => (turn === 1 ? editCall("file.ts", "e1") : answer("改好了。")), flakyEdit(0), "read-only");
  assert.match(text, /⚠️ 这些编辑没有落地：`file\.ts`（被拒：read-only mode blocks writes and commands）/);
});
