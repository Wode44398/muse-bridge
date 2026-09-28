// U2（#46，S 步）：插话带 id；门禁撤回 / 上游重放时保留插话气泡；镜像端按 id 去重。
// 改写自探针 04-codex/笔记/probe-steer-bubble-trim.ts。
//
// 修前：① 插话气泡被「整轮撤回 / 上游重放」一并剪掉——插话已进服务端历史并被模型采纳，前端时间线里却没了，
// 用户的自然反应是再发一遍；② 镜像端按「全时间线同文本」去重，历史里说过一次「继续」，别的设备这一轮再插
// 「继续」就永远不显示。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import { createSession, dropSession, startRun, steerSession, watchSession } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import {
  discardStreamTurn,
  findSteerItem,
  resetStreamTurn,
  startStreamTurn,
  type StreamTurnState,
} from "../web/src/lib/stream-turn.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

type Item = { kind: string; text?: string; steer?: boolean; steerId?: string; name?: string };
interface Chat extends StreamTurnState<Item> { curText: Item | null }

// 与 state.svelte.ts 同一套归约（turn_start / turn_discard / text_delta / tool_start / steer_queued / steer_returned）
function reduce(chat: Chat, ev: Record<string, any>) {
  switch (ev.e) {
    case "turn_start": chat.curText = null; startStreamTurn(chat, ev.index); break;
    case "turn_discard": chat.curText = null; discardStreamTurn(chat, ev.index); break;
    case "text_delta":
      if (!chat.curText) { chat.timeline.push({ kind: "text", text: "" }); chat.curText = chat.timeline.at(-1)!; }
      chat.curText.text += ev.text; break;
    case "tool_start": chat.curText = null; chat.timeline.push({ kind: "tool", name: ev.name }); break;
    case "steer_queued":
      if (findSteerItem(chat.timeline, ev) < 0) chat.timeline.push({ kind: "user", text: ev.text, steer: true, steerId: ev.id });
      break;
    case "done": chat.curText = null; resetStreamTurn(chat); break;
  }
}
const chatOf = (seed: Item[]): Chat => ({ timeline: [...seed], streamTurnIndex: null, turnStartTimelineLength: seed.length, curText: null });
const steers = (c: Chat) => c.timeline.filter((it) => it.kind === "user" && it.steer).map((it) => it.text);

test("门禁撤回这一轮：插话气泡留着（挪到剪切点之后），模型的那段照撤", () => {
  const chat = chatOf([{ kind: "user", text: "改一下 file.ts" }]);
  for (const ev of [
    { e: "turn_start", index: 0 }, { e: "tool_start", name: "Edit" },
    { e: "turn_start", index: 1 }, { e: "text_delta", text: "已修改 file.ts，完成。" },
    { e: "steer_queued", text: "顺便把 README 也改了", id: "s-phone-0001" }, // 用户看着这段话插了一句
    { e: "turn_discard", index: 1 }, // 没跑验证就收尾 → 门禁撤回
    { e: "turn_start", index: 2 }, { e: "text_delta", text: "测试通过；README 也已同步。" },
    { e: "done" },
  ]) reduce(chat, ev);
  assert.deepEqual(steers(chat), ["顺便把 README 也改了"], "修前插话气泡跟着被撤回的那段一起没了");
  assert.ok(!chat.timeline.some((it) => it.text === "已修改 file.ts，完成。"), "被撤回的模型输出照样撤掉");
  assert.equal(chat.timeline.at(-1)?.text, "测试通过；README 也已同步。");

  // 同一轮上游重放（同 index 的 turn_start）也一样
  const retry = chatOf([{ kind: "user", text: "q" }]);
  for (const ev of [
    { e: "turn_start", index: 0 }, { e: "text_delta", text: "partial" },
    { e: "steer_queued", text: "等等", id: "s-phone-0002" },
    { e: "turn_start", index: 0 }, { e: "text_delta", text: "replayed" },
    { e: "turn_start", index: 0 }, { e: "text_delta", text: "replayed again" },
  ]) reduce(retry, ev);
  assert.deepEqual(steers(retry), ["等等"], "只留一份，重放两次也不重复");
  assert.equal(retry.timeline.filter((it) => it.kind === "text").length, 1);
});

test("镜像端按 id 去重：历史里说过「继续」，别的设备这一轮再说「继续」照样显示；自己的乐观气泡不重复", () => {
  const mirror = chatOf([
    { kind: "user", text: "跑一下迁移" },
    { kind: "user", text: "继续", steer: true, steerId: "s-old-0001" },
    { kind: "text", text: "迁移完成。" },
    { kind: "user", text: "再把索引也建了" },
  ]);
  reduce(mirror, { e: "turn_start", index: 0 });
  reduce(mirror, { e: "steer_queued", text: "继续", id: "s-desk-0002" });
  assert.equal(steers(mirror).length, 2, "修前被吞掉");

  // 本机乐观上屏的那条，回来的 steer_queued 带同一个 id → 不重复
  mirror.timeline.push({ kind: "user", text: "再快点", steer: true, steerId: "s-me-0003" });
  reduce(mirror, { e: "steer_queued", text: "再快点", id: "s-me-0003" });
  assert.equal(steers(mirror).filter((t) => t === "再快点").length, 1);

  // 旧服务端不带 id：只在这一轮里按文本找——历史里的「继续」不算
  const legacy = chatOf([
    { kind: "user", text: "跑一下迁移" },
    { kind: "user", text: "继续", steer: true },
    { kind: "user", text: "再把索引也建了" },
  ]);
  reduce(legacy, { e: "steer_queued", text: "继续" });
  assert.equal(steers(legacy).length, 2);
});

test("服务端：插话的 id 从 steer_queued 一路带到 steer_applied；没送出的随 steer_returned 带回", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-u2-"));
  roots.push(root);
  const caps = { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false };
  let released = false;
  let wake = () => {};
  let n = 0;
  const adapter: ProviderAdapter = {
    id: "openai", model: "fake", capabilities: caps,
    async *stream() {
      n++;
      if (n === 1) {
        if (!released) await new Promise<void>((r) => { wake = r; });
        yield { e: "text_delta", text: "working" };
        yield { e: "turn_done", stopReason: "end" };
        return;
      }
      if (n === 2) {
        // 第二个插话排在这一轮里，但这一轮报错收场 → 退回客户端
        yield { e: "error", kind: "invalid_request_error", retriable: false, raw: "400 synthetic" };
        return;
      }
    },
  };
  const session = createSession();
  session.state = new AgentState({
    adapter, system: "t", tools: [], budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(), permissionMode: "auto", memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
  const events: Record<string, any>[] = [];
  const run = startRun(session, "开始");
  watchSession(session, (ev) => {
    events.push(ev);
    // 第一个插话被注入之后再插第二个：它会排到下一轮，而下一轮报错收场
    if (ev.e === "steer_applied") steerSession(session, "第二句", undefined, "s-client-0002");
  });
  const r1 = steerSession(session, "改成蓝色", undefined, "s-client-0001");
  assert.equal(r1.id, "s-client-0001");
  released = true;
  wake();
  await run.done;
  assert.ok(events.some((e) => e.e === "steer_queued" && e.id === "s-client-0001"));
  assert.ok(events.some((e) => e.e === "steer_applied" && e.id === "s-client-0001"), "注入时带着同一个 id");
  const back = events.find((e) => e.e === "steer_returned");
  assert.deepEqual(back?.ids, ["s-client-0002"], "没送出的按 id 退回");
  assert.equal(steerSession(session, "x", undefined, "bad id!").ok, false, "不在跑时照旧拒");
  dropSession(session.id);
});
