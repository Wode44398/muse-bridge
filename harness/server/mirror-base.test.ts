// M4（#43）：镜像底座按「本轮用户消息」对象定位，运行中全量压缩后不再错位。
// 改写自探针 04-codex/笔记/probe-midrun-compact-mirror.ts。
//
// 修前：runStartMsgCount 只在开跑时按压缩前的可见条数算一次；运行中一旦全量压缩（转录换成 任务 + 摘要 +
// 尾部），手机重连 / 另一台设备附着时按旧条数切出的底座把本轮已完成的步骤收了进去，runLog 再重放一遍 →
// 同一步渲染两次。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState, visibleMessages } from "./agent/state.ts";
import { createSession, dropSession, mirrorBaseCount, startRun, type Session } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { Msg, Turn } from "./agent/turn.ts";
import type { Tool } from "./tools/types.ts";
import { fakeSummary } from "./test-harness/scripted-adapter.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-m4-"));
  roots.push(dir);
  return dir;
}

// 30k 窗口：估算过 17k（窗口 − 13k 缓冲）就压缩，尾部留约 12k。
const caps = { contextWindow: 30_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false };
const isSummarizer = (t: Turn) => typeof t.system === "string" && t.system.startsWith("You compress");
const textOf = (m: Msg) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("");
const isRunStep = (m: Msg) =>
  textOf(m).startsWith("RUN-step") || m.content.some((b) => b.t === "tool_result" && b.id.startsWith("c"));

function peekTool(resultChars: number): Tool {
  return {
    effect: "read",
    concurrencySafe: true,
    def: { name: "Peek", description: "peek", parameters: { type: "object", properties: {} } },
    async run() {
      return { ok: true, summary: "peeked", content: [{ t: "text", text: "y".repeat(resultChars) }] };
    },
  };
}

function attach(session: Session, adapter: ProviderAdapter, root: string, tool: Tool, history: Msg[]) {
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: [tool.def],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map([[tool.def.name, tool]]),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  session.state.messages.push(...history);
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
}

function history(pairs: number, chars: number): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push({ role: "user", content: [{ t: "text", text: `pre-u${i} ` + "x".repeat(chars) }] });
    out.push({ role: "assistant", content: [{ t: "text", text: `pre-a${i} ` + "x".repeat(chars) }] });
  }
  return out;
}

interface Snapshot {
  visible: Msg[];
  base: Msg[];
  stale: Msg[];
  runLogText: string;
  compacted: boolean;
}
function snapshot(session: Session): Snapshot {
  const visible = visibleMessages(session.state!.messages);
  return {
    visible,
    base: visible.slice(0, mirrorBaseCount(session)),
    stale: visible.slice(0, session.runStartMsgCount),
    runLogText: session.runLog.filter((e) => e.e === "text_delta").map((e) => String(e.text)).join(""),
    compacted: visible.some((m) => textOf(m).startsWith("[Earlier context summary]")),
  };
}

test("运行中全量压缩、本轮用户消息还在尾部：底座止于这条消息，本轮步骤只由 runLog 重放一次", async () => {
  const root = workspace();
  const session = createSession();
  let call = 0;
  let early: Snapshot | null = null;
  let late: Snapshot | null = null;
  attach(session, {
    id: "openai", model: "fake", capabilities: caps,
    async *stream(t) {
      if (isSummarizer(t)) {
        yield { e: "text_delta", text: fakeSummary("SUMMARY of earlier turns") };
        yield { e: "turn_done", stopReason: "end" };
        return;
      }
      call++;
      if (call === 2) early = snapshot(session);
      if (call <= 3) {
        yield { e: "text_delta", text: `RUN-step${call - 1} ` };
        yield { e: "tool_call", id: `c${call - 1}`, name: "Peek", args: {} };
        yield { e: "turn_done", stopReason: "tool_use" };
        return;
      }
      late = snapshot(session);
      yield { e: "text_delta", text: "done" };
      yield { e: "turn_done", stopReason: "end" };
    },
  }, root, peekTool(3000), history(20, 1500));

  await startRun(session, "RUN-user 本轮任务").done;

  // 没压缩时和以前一致
  const e = early as Snapshot | null;
  assert.ok(e && !e.compacted);
  assert.equal(e.base.length, session.runStartMsgCount);

  assert.ok(late, "跑到了压缩之后的那一轮");
  const s = late as Snapshot;
  assert.ok(s.compacted, "真的走了全量压缩");
  assert.ok(s.stale.some(isRunStep), "场景有效：按开跑时的条数切，底座会收进本轮步骤（修前的行为）");
  assert.ok(!s.base.some(isRunStep), "底座不含本轮已完成的步骤");
  assert.match(textOf(s.base.at(-1)!), /RUN-user/, "底座最后一条就是本轮用户消息");
  for (const k of [0, 1, 2]) assert.match(s.runLogText, new RegExp(`RUN-step${k}`), `本轮第 ${k} 步由 runLog 重放`);
  assert.ok(s.base.length < s.visible.length);
  dropSession(session.id);
});

test("本轮用户消息自己也被压进摘要：底座以最后一条摘要为界，整轮交给 runLog 重放", async () => {
  const root = workspace();
  const session = createSession();
  let call = 0;
  let late: Snapshot | null = null;
  let userMsgSurvived = true;
  attach(session, {
    id: "openai", model: "fake", capabilities: caps,
    async *stream(t) {
      if (isSummarizer(t)) {
        yield { e: "text_delta", text: fakeSummary("SUMMARY of earlier turns") };
        yield { e: "turn_done", stopReason: "end" };
        return;
      }
      call++;
      const snap = snapshot(session);
      if (snap.compacted && !late) {
        late = snap;
        // 作为一条独立消息还在不在（R10 起用户原话会原样留在摘要里，那不算）
        userMsgSurvived = snap.visible.some((m) => /RUN-user/.test(textOf(m)) && !textOf(m).startsWith("[Earlier context summary]"));
        yield { e: "text_delta", text: "done" };
        yield { e: "turn_done", stopReason: "end" };
        return;
      }
      if (call > 40) {
        yield { e: "text_delta", text: "gave up" };
        yield { e: "turn_done", stopReason: "end" };
        return;
      }
      // 每一步的正文很长（微压缩只省工具输出，省不到正文），十几步就逼出全量压缩并把本轮开头挤进摘要
      yield { e: "text_delta", text: `RUN-step${call - 1} ` + "z".repeat(6000) };
      yield { e: "tool_call", id: `c${call - 1}`, name: "Peek", args: {} };
      yield { e: "turn_done", stopReason: "tool_use" };
    },
  }, root, peekTool(10), history(3, 200));

  await startRun(session, "RUN-user 本轮任务").done;

  assert.ok(late, "跑到了压缩之后的那一轮");
  const s = late as Snapshot;
  assert.equal(userMsgSurvived, false, "场景有效：本轮用户消息被压进了摘要");
  assert.ok(s.stale.some(isRunStep), "场景有效：按开跑时的条数切，底座会收进本轮步骤（修前的行为）");
  assert.ok(!s.base.some(isRunStep), "底座不含本轮步骤");
  assert.match(textOf(s.base.at(-1)!), /^\[Earlier context summary\]/, "底座止于摘要");
  assert.match(s.runLogText, /RUN-step0 /, "整轮从第一步起由 runLog 重放");
  dropSession(session.id);
});
