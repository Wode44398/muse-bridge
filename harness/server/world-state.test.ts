// C4（X12、N09 第 2/3 步；#30 余）：World State 分节注册表。
//
// 修前：运行中切档、切访问范围就地改写 system（plan 段、访问范围段摘了又补），恢复会话时按当前磁盘重写 system 的
// 动态尾段——每一次都让整个请求的前缀缓存从 system 起作废；GUIDE、AGENTS.md、技能、日期在会话中途变了，模型根本不知道，
// 子 agent 拿的也是会话建立那一刻的 GUIDE。
// 修后：system 在会话里定下来就不动（压缩成功是唯一的全量重建点，经报备）；各节的变化在下一次请求前以一条内部片段追加；
// 片段被回滚或压缩剪掉，基线从转录推、自然退回 system 的值，那一节整段重注入。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { describeWorldChange } from "./agent/prompt.ts";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import type { Msg, Turn } from "./agent/turn.ts";
import { worldBaseline, worldDelta, worldToken, worldTokens } from "./agent/world-state.ts";
import { listCheckpoints } from "./checkpoints.ts";
import { setConfig } from "./config.ts";
import { inheritedInstructions } from "./project-docs.ts";
import { Sandbox } from "./sandbox.ts";
import { createSession, dropSession, getOrLoadSession, rollbackSession, setSessionAccess, startRun } from "./session.ts";
import { contextWindows, isCompactionRequest } from "./test-harness/context-windows.ts";
import { call, calls, fakeSummary, say, scripted } from "./test-harness/scripted-adapter.ts";
import { lastText, send, wireWorld } from "./test-harness/session-fixture.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { ok, type Tool } from "./tools/types.ts";

// 语义召回要调嵌入接口；测试一律走词法召回，不出网。
const SAVED_SEMANTIC = process.env.KNOWLEDGE_AUTO_SEMANTIC;
process.env.KNOWLEDGE_AUTO_SEMANTIC = "0";
const roots: string[] = [];
after(() => {
  if (SAVED_SEMANTIC === undefined) delete process.env.KNOWLEDGE_AUTO_SEMANTIC;
  else process.env.KNOWLEDGE_AUTO_SEMANTIC = SAVED_SEMANTIC;
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

function workspace(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  return root;
}

// 生产的 buildState 建 state（World State 由会话挂上）；假 key 只为让它建得起来，模型换成脚本。第一轮寒暄：不召回、不要求记忆审计。
async function productionSession(t: import("node:test").TestContext, root: string, adapter: ReturnType<typeof scripted>) {
  t.mock.method(console, "log", () => {});
  setConfig({ provider: "openai", model: "fake-model", apiKey: "DUMMY-c4-key", workspace: root, permissionMode: "auto", access: "workspace" });
  const session = createSession();
  const first = startRun(session, "你好");
  session.state!.adapter = adapter;
  await first.done;
  return session;
}

const fragmentsIn = (turn: Turn): Msg[] => turn.messages.filter((m) => JSON.stringify(m.content).includes("[World state update]"));

test("C4 注册表：短节记原值、长节记哈希；基线 = system 的令牌被转录里的片段逐节覆盖；没变不出片段", () => {
  assert.equal(worldToken("mode", "plan"), "plan");
  assert.match(worldToken("guide", "keep it short"), /^sha1:[0-9a-f]{16}$/);
  assert.equal(worldToken("guide", ""), "");
  assert.match(worldToken("jobs", "x".repeat(100)), /^sha1:/, "结束的 job 攒多了也不让令牌无限长");

  const system = worldTokens({ mode: "auto", access: "workspace", guide: "g1" });
  const fragment = (world: Record<string, string>): Msg => ({ role: "user", content: [{ t: "text", text: "u" }], internal: true, origin: "harness", kind: "world-state", world });
  const messages: Msg[] = [fragment({ mode: "plan" }), fragment({ mode: "auto" }), fragment({ access: "full" })];
  assert.deepEqual(worldBaseline(system, messages), { ...system, mode: "auto", access: "full" }, "每节以最后一个片段为准");

  const describe = (s: string, v: string, was?: string) => `${s}=${v}${was ? ` (was ${was})` : ""}`;
  assert.equal(worldDelta({ mode: "auto", access: "full", guide: "g1" }, worldBaseline(system, messages), describe), null, "都没变：不出片段");
  const d = worldDelta({ mode: "read-only", guide: "g2" }, system, describe);
  assert.deepEqual(d?.tokens, { mode: "read-only", guide: worldToken("guide", "g2") });
  assert.match(d!.text, /^\[World state update\]/);
  assert.match(d!.text, /mode=read-only \(was auto\)/);
  assert.match(d!.text, /guide=g2$/, "长节的「原来」是哈希，不往片段里写");
  // system 建成时没有的节、现在也是空的：不说；只报新消息的节（后台 job）被清空：不说；有 job 结束：说
  assert.equal(worldDelta({ jobs: "" }, system, describe), null);
  assert.equal(worldDelta({ jobs: "" }, { ...system, jobs: "j1 (exit 0)" }, describe), null);
  assert.ok(worldDelta({ jobs: "j1 (exit 0)" }, system, describe), "job 结束了要说");
  // GUIDE 被删：要说
  assert.match(worldDelta({ guide: "" }, system, (s, v, was) => describeWorldChange(s, v, was))!.text, /GUIDE\.md was removed/);
});

test("C4 日期、项目知识、记忆只在一轮开跑时对；GUIDE 每次请求前都对；片段是 harness 的内部消息", (t) => {
  let guide = "g1";
  let date = "2026-09-24";
  const { state } = loopState(t, scripted(t));
  wireWorld(state, (runStart) => ({ guide, ...(runStart ? { date } : {}) }));
  state.systemWorld = { ...state.systemWorld, ...worldTokens({ guide: "g1", date: "2026-09-24" }) };
  assert.equal(state.injectWorldDelta(true), false, "刚建好：什么都没变");
  date = "2026-09-25";
  assert.equal(state.injectWorldDelta(false), false, "运行中不看日期");
  assert.equal(state.injectWorldDelta(true), true);
  assert.match(lastText(state), /Today's date is now 2026-09-25/);
  guide = "g2";
  assert.equal(state.injectWorldDelta(false), true, "GUIDE 运行中改了，下一次请求前就说");
  assert.match(lastText(state), /GUIDE\.md changed[\s\S]*g2/);
  const last = state.messages.at(-1)!;
  assert.deepEqual([last.role, last.internal, last.origin, last.kind], ["user", true, "harness", "world-state"], "不进聊天记录，按来源认类别");
  assert.equal(state.injectWorldDelta(false), false, "已经说过就不再说");
});

test("C4 生产会话：两轮之间改了 GUIDE.md——system 一字不动、前缀一次没断，新 GUIDE 以片段追加；删掉也会说", async (t) => {
  const root = workspace("dimensio-c4-guide-");
  fs.writeFileSync(path.join(root, "GUIDE.md"), "Always answer in haiku.\n");
  const adapter = scripted(t).next(say("你好！"));
  const session = await productionSession(t, root, adapter);
  fs.writeFileSync(path.join(root, "GUIDE.md"), "Always answer in limericks.\n");
  adapter.next(say("不客气"));
  await send(session, "谢谢");
  fs.rmSync(path.join(root, "GUIDE.md"));
  adapter.next(say("不客气"));
  await send(session, "谢谢");

  const [a, b, c] = adapter.inputs;
  assert.match(String(a.system), /haiku/);
  assert.equal(b.system, a.system, "改了 GUIDE 不改写 system");
  assert.equal(c.system, a.system);
  assert.equal(contextWindows(adapter.inputs).length, 1, "前缀缓存一次都没断");
  assert.match(JSON.stringify(b.messages.at(-1)), /GUIDE\.md changed[\s\S]*limericks/);
  assert.match(JSON.stringify(c.messages.at(-1)), /GUIDE\.md was removed/);
  assert.equal(fragmentsIn(c).length, 2, "每次变化一条片段，不重复");
  dropSession(session.id);
});

test("C4 回滚剪掉了片段：基线从转录推、退回 system 的值，下一轮整段重注入", async (t) => {
  const root = workspace("dimensio-c4-rollback-");
  const adapter = scripted(t).next(say("你好！"));
  const session = await productionSession(t, root, adapter);
  assert.deepEqual(setSessionAccess(session, "full"), { ok: true });
  adapter.next(say("不客气"));
  await send(session, "谢谢");
  assert.match(JSON.stringify(fragmentsIn(adapter.inputs[1])), /FULL MACHINE/);

  // 回滚到第二轮开跑前：片段随转录一起被剪掉；访问范围仍是整机（切范围时快照配置就落了）
  const target = (await listCheckpoints(session.id)).filter((c) => !c.kind).at(-1)!;
  assert.deepEqual(await rollbackSession(session.id, target.n), { ok: true });
  const back = await getOrLoadSession(session.id);
  assert.ok(back?.state);
  assert.equal(back.state.ctx.sandbox.access, "full");
  assert.equal(back.state.messages.some((m) => m.kind === "world-state"), false, "片段跟着转录被剪掉了");
  back.state.adapter = adapter;
  adapter.next(say("不客气"));
  await send(back, "谢谢");
  const fragments = fragmentsIn(adapter.inputs.at(-1)!);
  assert.equal(fragments.length, 1);
  assert.match(JSON.stringify(fragments[0]), /FULL MACHINE/, "模型又被告知一次：边界是整机");
  dropSession(session.id);
});

const echoTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("echoed", "echo result");
  },
};

test("C4 压缩成功后重建一次 system（经报备，请求不变量不记违规）；之后按新 system 的值比，不重复补片段", async (t) => {
  // 每轮 2 万字的答复 + 很小的工具结果（微压缩省不出空间）→ 第 5 次调用前超过门槛，走全量压缩（同 Q2 ⑤）
  const big = "x".repeat(20_000);
  const round = (i: number): StreamEvent[] => calls({ e: "text_delta", text: `${i}${big}` }, call(`c${i}`, "Echo"));
  const adapter = scripted(t, { capabilities: { contextWindow: 30_000 } }).next(
    round(1), round(2), round(3), round(4),
    say(fakeSummary("SUMMARY: echoed four times")),
    say("done"),
  );
  const { state } = loopState(t, adapter, { tools: [echoTool], user: "do a long job" });
  wireWorld(state);
  let rebuilt = 0;
  state.rebuildSystem = () => {
    rebuilt++;
    return { system: `test (rebuilt, access ${state.ctx.sandbox.access})`, world: {} };
  };
  state.ctx.sandbox.access = "full"; // 开跑前切了范围：第一次请求带一条片段
  await drive(state, adapter);

  const main = adapter.inputs.filter((turn) => !isCompactionRequest(turn));
  assert.equal(fragmentsIn(main[0]).length, 1);
  assert.equal(rebuilt, 1, "压缩成功后重建一次");
  assert.equal(String(main.at(-1)!.system), "test (rebuilt, access full)", "压缩之后的请求带新 system");
  assert.equal(state.systemRewrites, 1, "重建经报备（loopState 收尾核对请求不变量：没报备的改写在那里失败）");
  // 开头那条片段被压掉了；新 system 就是现在的样子，不该再补
  assert.equal(state.messages.filter((m) => m.kind === "world-state").length, 0);
});

test("C4 子 agent 的项目指令每次起的时候现读：会话中途改了 GUIDE，之后起的子 agent 拿到新的", async (t) => {
  const root = workspace("dimensio-c4-sub-");
  let guide = "GUIDE-V1";
  const adapter = scripted(t).next(say("done"), say("done"));
  const run = makeSubAgentRunner(
    {
      provider: "openai", apiKey: "FAKE-KEY", model: "fake", thinking: "off", sandbox: new Sandbox(root),
      limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
      projectInstructions: () => inheritedInstructions(undefined, guide),
    },
    () => adapter,
  );
  assert.equal((await run({ prompt: "look around" })).ok, true);
  guide = "GUIDE-V2";
  assert.equal((await run({ prompt: "look around" })).ok, true);
  assert.match(JSON.stringify(adapter.inputs[0].system), /GUIDE-V1/);
  assert.match(JSON.stringify(adapter.inputs[1].system), /GUIDE-V2/);
});
