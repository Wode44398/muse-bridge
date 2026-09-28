// V5（#20）：验证门禁的「改过没有」不只认 Edit/Write。coder 子 agent 与 Bash 写文件的两条由 probe-regressions 里的
// 两个 probe（已转硬断言）钉着；这里钉住另外三件事：Bash 验证命令自己写的输出不把自己刚交的验证作废；影子 git
// 认出调用自己没报的改动（脚本生成之类）；那种改动在这一轮有过通过的验证时，不再追问。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentEvent } from "./agent/events.ts";
import { AgentState } from "./agent/state.ts";
import { createSession, dropSession, startRun, watchSession } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { calls, call, say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { bashTool } from "./tools/bash.ts";
import { ok, type Tool } from "./tools/types.ts";

const nudged = (messages: { content: { t: string; text?: string }[] }[], events: { e: string }[]) =>
  events.some((e) => e.e === "turn_discard") ||
  messages.some((m) => m.content.some((b) => b.t === "text" && (b.text ?? "").startsWith("[Automated check]")));

test("V5: a verification command that writes its own output file does not void itself", async (t) => {
  const adapter = scripted(t)
    .next(
      useTool("b1", "Bash", { command: "echo 'export const x = 2;' > a.ts" }),
      // 验证命令顺手把结果写进一个代码文件：写在前、验证在后，这次验证照样算数
      useTool("b2", "Bash", { command: "node -e \"console.log('export const ok = true;')\" > gen.js", verify: true }),
      say("改好了，也验过了"),
    )
    .always(say("改好了"));
  const { state } = loopState(t, adapter, {
    tools: [bashTool],
    user: "把 x 改成 2",
    ctx: { limits: { bashTimeoutMs: 20_000, bashMaxTimeoutMs: 20_000 } },
  });
  const { events } = await drive(state, adapter);
  assert.ok([...state.editedFiles].some((f) => f.endsWith("gen.js")), "验证命令写的文件也记进了改动");
  assert.equal(nudged(state.messages, events), false, "没被追问");
});

async function sessionRun(t: TestContext, steps: ReturnType<typeof calls>[], tools: Tool[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-v5-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "seed.ts"), "export const seed = 1;\n");
  const adapter = scripted(t).next(...steps).always(say("好了"));
  const session = createSession();
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: tools.map((tool) => tool.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 20_000, bashMaxTimeoutMs: 20_000 }, agentSeesImages: false },
    toolMap: new Map(tools.map((tool) => [tool.def.name, tool])),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
  const events: AgentEvent[] = [];
  const run = startRun(session, "生成一下代码");
  watchSession(session, (ev) => events.push(ev as unknown as AgentEvent));
  await run.done;
  const state = session.state;
  dropSession(session.id);
  return { state, events };
}

// 一个「看不出写了什么」的工具：像 npm run codegen，自己不报改了哪些文件
const codegen: Tool = {
  effect: "exec",
  concurrencySafe: false,
  def: { name: "Codegen", description: "generate code", parameters: { type: "object", properties: {} } },
  async run(_args, ctx) {
    fs.writeFileSync(path.join(ctx.sandbox.root, "generated.ts"), "export const generated = true;\n");
    return ok("generated", "done");
  },
};

test("V5: the shadow git catches edits no tool call reported — the gate asks for a verification", async (t) => {
  const r = await sessionRun(t, [calls(call("g1", "Codegen", {})), say("生成好了")], [codegen]);
  assert.ok([...r.state.editedFiles].some((f) => f.endsWith("generated.ts")), "影子 git 认出了生成的文件");
  assert.equal(nudged(r.state.messages, r.events), true, "修前门禁一次都不问");
});

test("V5: such unattributed edits are taken as covered when a verification passed during the run", async (t) => {
  const r = await sessionRun(
    t,
    [
      calls(call("g1", "Codegen", {})),
      useTool("v1", "Bash", { command: "node -e \"console.log('tests ok')\"", verify: true }),
      say("生成好了，也验过了"),
    ],
    [codegen, bashTool],
  );
  assert.ok([...r.state.editedFiles].some((f) => f.endsWith("generated.ts")));
  assert.equal(nudged(r.state.messages, r.events), false, "这一轮有过通过的验证，不再追问");
});
