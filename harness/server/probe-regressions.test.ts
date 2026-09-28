// Q9（二）：各篇拆解里没被回归测试覆盖的 probe，转成断言【正确行为】的回归测试。它们证明的问题今天都还在，修复排在
// 阶段 2–4，所以先进燃尽清单 KNOWN_BROKEN：仍然坏着 → 通过并打一行诊断；修好了却没从清单里删 → 报「已经修好」，
// 逼着把它变成硬断言。修一个删一个。（bridge 侧的 probe-routine-restart-gap 不在这里，见实施记录。）
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentEvent } from "./agent/events.ts";
import { ensureContextFits } from "./agent/context.ts";
import { runAgent } from "./agent/loop.ts";
import { visibleMessages, type AgentState } from "./agent/state.ts";
import type { Msg } from "./agent/turn.ts";
import { ensureProjectKnowledge } from "./knowledge.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { agentTool } from "./tools/agent.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool } from "./tools/edit.ts";
import { ok, type Tool } from "./tools/types.ts";

const KNOWN_BROKEN: Record<string, string> = {
  "steer-during-delegation": "#34 / U2（M 步）：委派期间的插话要等委派整个结束才注入，子 agent 收不到（阶段 3）",
};

function checkKnown(t: TestContext, name: string, ok: boolean, detail: string): void {
  const known = KNOWN_BROKEN[name];
  if (known) {
    assert.ok(!ok, `「${name}」已经修好了——把它从 KNOWN_BROKEN 删掉，让这条变成硬断言（原记：${known}）\n${detail}`);
    t.diagnostic(`已知未修（${known}）：${detail}`);
    return;
  }
  assert.ok(ok, `「${name}」：${detail}`);
}

const schema = { type: "object" as const, properties: {} };
const nudged = (state: AgentState, events: AgentEvent[]) =>
  events.some((e) => e.e === "turn_discard") ||
  state.messages.some((m) => m.content.some((b) => b.t === "text" && b.text.startsWith("[Automated check] You have edited files")));

async function drain(state: AgentState, signal = new AbortController().signal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of runAgent(state, signal)) events.push(ev);
  return events;
}

test("probe-delegated-edit-gate：派 coder 子 agent 改完文件就收尾，验证门禁应当追问", async (t) => {
  // 修好之后门禁会多追问几轮；always 兜住，不算多调
  const adapter = scripted(t).next(useTool("c1", "Agent", { prompt: "change x to 2 in a.ts", tools: "coder" }), say("做完了，x 已经是 2")).always(say("做完了"));
  let root = "";
  const { state, root: r } = loopState(t, adapter, {
    tools: [agentTool],
    user: "把 x 改成 2",
    ctx: {
      // 假 coder：真的改了磁盘上的 a.ts，自报测试通过（与 subagent.ts 的结果同形）
      runSubAgent: async () => {
        fs.writeFileSync(path.join(root, "a.ts"), "export const x = 2;\n");
        return {
          ok: true, id: "sub1", label: "coder", tier: "coder", model: "fake", provider: "openai",
          text: "Changed a.ts (x=2). Tests pass.", turns: 3, toolCalls: 2, inputTokens: 1, outputTokens: 1,
          editedFiles: [path.join(root, "a.ts")], trail: [], startedAt: Date.now(), durationMs: 1,
        } as never;
      },
    },
  });
  root = r;
  fs.writeFileSync(path.join(root, "a.ts"), "export const x = 1;\n");
  const events = await drain(state);
  checkKnown(t, "delegated-edit-gate", nudged(state, events), `父会话改动集 ${JSON.stringify([...state.editedFiles])}`);
});

test("probe-gate-exhaust 场景 C：用 Bash 写了文件就收尾，验证门禁应当追问", async (t) => {
  // V5 修好后用真 Bash：命令里的重定向目标就是它写的文件
  const adapter = scripted(t).next(useTool("b1", "Bash", { command: "echo 'export const x = 2;' > a.ts" }), say("改好了")).always(say("改好了"));
  const { state } = loopState(t, adapter, {
    tools: [bashTool],
    user: "把 x 改成 2",
    ctx: { limits: { bashTimeoutMs: 20_000, bashMaxTimeoutMs: 20_000 } },
  });
  const events = await drain(state);
  checkKnown(t, "bash-write-gate", nudged(state, events), "Bash 写过文件后直接收尾");
});

test("probe-deny-bypass：用户拒了 Edit 之后，模型换 Bash 写同一个文件不应当得逞", async (t) => {
  const adapter = scripted(t).next(
    useTool("e1", "Edit", { path: "src/a.ts", old_string: "v = 1", new_string: "v = 2" }),
    useTool("b1", "Bash", { command: "printf 'export const v = 2;\\n' > src/a.ts" }),
    say("改好了"),
  ).always(say("好"));
  let cards = 0;
  const { state, root } = loopState(t, adapter, {
    tools: [editTool, bashTool],
    user: "把 v 改成 2",
    // 用户的意图：src 下的改动都要我点头；这一次点了「拒绝」
    permissionRules: { allow: [], deny: [], ask: ["Edit(src/**)", "Write(src/**)"] },
    ctx: {
      requestPermission: async () => {
        cards++;
        return { decision: "deny" as const };
      },
      limits: { bashTimeoutMs: 20_000, bashMaxTimeoutMs: 20_000 },
    },
  });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 1;\n");
  await drain(state);
  const after = fs.readFileSync(path.join(root, "src", "a.ts"), "utf8").trim();
  checkKnown(t, "deny-bypass", after === "export const v = 1;", `拒绝卡 ${cards} 张，文件最后是「${after}」`);
});

test("probe-compact-signal：用户已经点了停止，压缩的摘要请求不该再发、或者至少带着已中止的信号", async (t) => {
  const adapter = scripted(t, { capabilities: { contextWindow: 30_000 } }).always(say("summary"));
  const { state } = loopState(t, adapter, {});
  const msgs: Msg[] = [
    { role: "user", content: [{ t: "text", text: "task" }] },
    { role: "assistant", content: [{ t: "text", text: "ok" }] },
  ];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: "user", content: [{ t: "text", text: "u".repeat(4000) }] });
    msgs.push({ role: "assistant", content: [{ t: "text", text: "a".repeat(4000) }] });
  }
  state.messages = msgs;
  const stop = new AbortController();
  state.ctx.signal = stop.signal; // run 的停止信号就在工具上下文里……
  stop.abort(); // ……而用户已经点了停止
  // 今天 loop 就是这样调它的（没有 signal 参数）；修的时候多传一个也兼容
  await (ensureContextFits as (s: AgentState, signal?: AbortSignal) => Promise<unknown>)(state, stop.signal);
  const good = adapter.callCount === 0 || adapter.signals.every((s) => s?.aborted === true);
  checkKnown(t, "compact-signal", good, `摘要请求 ${adapter.callCount} 次，带信号：${JSON.stringify(adapter.signals.map((s) => (s ? s.aborted : null)))}`);
});

test("probe-loop-block-touch：只往工作区的日志文件里追加一行，项目知识不该整份重建", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-touch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "src"));
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, "src", `f${i}.ts`), `export const y${i} = ${i};\n`);
  ensureProjectKnowledge(root, { force: true });
  assert.equal(ensureProjectKnowledge(root).rebuilt, false, "前提：什么都没动时走缓存");
  fs.appendFileSync(path.join(root, "notes.log"), "one line\n");
  const again = ensureProjectKnowledge(root);
  checkKnown(t, "knowledge-touch-rebuild", again.rebuilt === false, `追加一行日志之后 rebuilt=${again.rebuilt}`);
});

test("probe-steer-during-delegation：委派进行中插的话，应当在委派结束前送达（或者回执写明会延后）", async (t) => {
  let state!: AgentState;
  const fakeAgent: Tool = {
    effect: "read",
    concurrencySafe: false,
    def: { name: "Agent", description: "fake delegation", parameters: schema },
    async run() {
      await new Promise((r) => setTimeout(r, 30));
      state.queueSteer("别改 API，只改前端", "s1"); // 用户在委派进行中插话
      await new Promise((r) => setTimeout(r, 60)); // 委派还在跑（真实场景是 30~60 分钟）
      return ok("child finished", "done");
    },
  };
  const adapter = scripted(t).next(useTool("a1", "Agent", { prompt: "refactor" }), say("ok")).always(say("ok"));
  ({ state } = loopState(t, adapter, { tools: [fakeAgent], user: "重构一下" }));
  const events = await drain(state);
  const toolEnd = events.findIndex((e) => e.e === "tool_end");
  const applied = events.findIndex((e) => e.e === "steer_applied");
  const deferredReceipt = events.some((e) => (e as { e: string }).e === "steer_deferred" || (e as { deferred?: boolean }).deferred === true);
  checkKnown(t, "steer-during-delegation", (applied >= 0 && applied < toolEnd) || deferredReceipt, `steer_applied 在第 ${applied} 个事件，委派的 tool_end 在第 ${toolEnd} 个`);
});

test("probe-marker-spoof：用户把界面上的提示语贴回来问是什么意思，这条原话应当留在聊天记录里", (t) => {
  const u = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
  const a = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
  const pasted = "[Automated check] You have edited files without sufficient passing verification evidence. ← 刚才日志里有这句，是什么意思？";
  const visible = visibleMessages([u("把登录页改成手机号登录"), a("已完成，测试全绿。"), u(pasted), a("这是验证门禁的提示……")]);
  const kept = visible.some((m) => m.role === "user" && m.content.some((b) => b.t === "text" && b.text === pasted));
  checkKnown(t, "marker-spoof", kept, `可见 ${visible.length} 条：${visible.map((m) => m.role).join(",")}`);
});
