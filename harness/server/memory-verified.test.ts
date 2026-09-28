// K1（#61）：「verified」记忆必须引用本会话真实、成功的工具调用；关于 harness 自身的结论一律 proposed。
//
// 修前：evidence 是模型自己写的自由文本，与真实工具结果没有任何绑定。MiMo 的 B 会话把自己猜错的原因
// 存成了 `harness 工具限制：Grep 不支持中文文件名 / Eval 异步返回 {}`，status: active、confidence:
// verified，全程没经过用户——之后这个工作区的每个会话都会被它误导（真正的原因是 #57）。

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findToolCall } from "./agent/state.ts";
import { listMemories } from "./memory.ts";
import { rememberTool } from "./tools/remember.ts";
import { Sandbox } from "./sandbox.ts";
import type { Msg } from "./agent/turn.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
// test-setup.ts 给的基线（临时目录）。收尾还原它，不要 delete——delete 之后的解析会回落到生产目录（#14），Q8 起直接抛错。
const BASE_MEMORY_DIR = process.env.MEMORY_DIR;
afterEach(() => {
  if (BASE_MEMORY_DIR === undefined) delete process.env.MEMORY_DIR;
  else process.env.MEMORY_DIR = BASE_MEMORY_DIR;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

// 本会话转录：一次成功的 Bash（b-ok）、一次失败的 Bash（b-fail）、一次 Recall（r1，不算证据）。
const transcript: Msg[] = [
  { role: "user", content: [{ t: "text", text: "查一下构建环境" }] },
  {
    role: "assistant",
    content: [
      { t: "tool_call", id: "b-ok", name: "Bash", args: { command: "./gradlew assembleDebug" } },
      { t: "tool_call", id: "b-fail", name: "Bash", args: { command: "./gradlew test" } },
      { t: "tool_call", id: "r1", name: "Recall", args: { query: "jdk" } },
    ],
  },
  {
    role: "user",
    content: [
      { t: "tool_result", id: "b-ok", ok: true, content: [{ t: "text", text: "BUILD SUCCESSFUL" }] },
      { t: "tool_result", id: "b-fail", ok: false, content: [{ t: "text", text: "BUILD FAILED" }] },
      { t: "tool_result", id: "r1", ok: true, content: [{ t: "text", text: "(memory)" }] },
    ],
  },
];

function setup() {
  process.env.MEMORY_DIR = temp("dimensio-k1-memory-");
  const workspace = temp("dimensio-k1-ws-");
  const ctx: ToolContext = {
    sandbox: new Sandbox(workspace),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    lookupToolCall: (id) => findToolCall(transcript, id),
  };
  const note = (over: Record<string, unknown>) => ({
    title: "podstream 构建环境",
    description: "构建 podstream 时须用工作区 JDK21。",
    content: "Gradle 必须用工作区 JDK21。\n\nWhy: 系统 Java 26 编译失败。\nHow to apply: local.properties 指向 JDK21。",
    type: "project",
    topic: "android-build.environment",
    status: "active",
    confidence: "verified",
    verifiedAt: new Date().toISOString(),
    ...over,
  });
  const stored = (title: string) => listMemories(workspace).find((m) => m.title === title);
  return { ctx, note, stored };
}

const text = (r: Awaited<ReturnType<typeof rememberTool.run>>) => r.content.map((b) => (b.t === "text" ? b.text : "")).join("");

test("verified 的证据只是自由文本：降为 observed + proposed，并说明原因", async () => {
  const { ctx, note, stored } = setup();
  const r = await rememberTool.run(note({ evidence: ["./gradlew assembleDebug 在 JDK21 下 BUILD SUCCESSFUL"] }), ctx);
  assert.equal(r.ok, true, text(r));
  assert.match(text(r), /saved as observed \+ proposed/);
  const m = stored("podstream 构建环境")!;
  assert.equal(m.declaredStatus ?? m.status, "proposed");
  assert.equal(m.confidence, "observed");
});

test("verified 引用了本会话一次成功的工具调用：保留 active + verified", async () => {
  const { ctx, note, stored } = setup();
  const r = await rememberTool.run(note({ evidence: ["tool:b-ok — ./gradlew assembleDebug BUILD SUCCESSFUL"] }), ctx);
  assert.equal(r.ok, true, text(r));
  const m = stored("podstream 构建环境")!;
  assert.equal(m.confidence, "verified");
  assert.equal(m.status, "active");
});

test("引用失败的调用、不存在的调用、记忆类工具：都不算证据", async () => {
  for (const ref of ["tool:b-fail", "tool:nope", "tool:r1"]) {
    const { ctx, note, stored } = setup();
    const r = await rememberTool.run(note({ evidence: [`${ref} proves it`] }), ctx);
    assert.equal(r.ok, true, text(r));
    assert.equal(stored("podstream 构建环境")!.confidence, "observed", ref);
  }
});

test("关于 harness 自身工具的结论（MiMo 那条）：就算引用了成功调用也只存成 proposed；用户确认过的除外", async () => {
  const { ctx, note, stored } = setup();
  const mimo = note({
    title: "harness 工具限制：Grep 不支持中文文件名",
    description: "在 harness 里搜中文文件名时相关。",
    topic: "harness.tools",
    evidence: ["tool:b-ok grep returned nothing"],
  });
  const r = await rememberTool.run(mimo, ctx);
  assert.equal(r.ok, true, text(r));
  assert.match(text(r), /conclusions about the harness's own tools/);
  assert.equal(stored("harness 工具限制：Grep 不支持中文文件名")!.status, "proposed");

  const confirmed = note({
    title: "dimensio 默认用中文回答",
    description: "回答语言。",
    topic: "harness.language",
    type: "user",
    confidence: "user_confirmed",
    content: "用户要求 dimensio 一律用中文回答。",
  });
  const r2 = await rememberTool.run(confirmed, ctx);
  assert.equal(r2.ok, true, text(r2));
  assert.equal(stored("dimensio 默认用中文回答")!.status, "active", "用户确认过的不受这条限制");
});
