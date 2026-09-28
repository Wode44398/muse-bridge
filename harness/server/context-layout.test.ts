// Q2（X10）：上下文分窗不变量。每个场景只断言「开了几个窗、为什么开」，不钉措辞——每开一个窗，provider 的前缀缓存
// 就断一次（没有报错，只有账单和延迟）。
// 燃尽清单 KNOWN_BROKEN：今天已知会多开窗的场景。修好一个删一个；修好了却没删，这里会报「已经修好」，逼着把尺子
// 收紧——C1（召回持久化追加）、N09（恢复会话不改写 system）就拿对应场景验收。
// 规划里的场景⑥「运行中换模型」不适用：dimensio 的会话在创建时定死 provider / model，没有中途换模型的入口（§4 #80）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import type { Msg, Turn } from "./agent/turn.ts";
import { setConfig } from "./config.ts";
import { createAdapter } from "./providers/registry.ts";
import { createSession, dropSession, getOrLoadSession, persistNow, setSessionAccess, setSessionMode, startRun } from "./session.ts";
import { contextWindows, isCompactionRequest, renderWindows, type WindowReason } from "./test-harness/context-windows.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { call, calls, fakeSummary, say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { anthropicCacheModel, fakeAnthropicFetch } from "./test-harness/wire-fakes.ts";
import { memoryAuditTool } from "./tools/memoryaudit.ts";
import { ok, type Tool } from "./tools/types.ts";

const KNOWN_BROKEN: Record<string, string> = {};

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

// ── 断言 ──────────────────────────────────────────────────────────────────────
function checkKnown(t: TestContext, name: string, ok: boolean, detail: string): void {
  const known = KNOWN_BROKEN[name];
  if (known) {
    assert.ok(!ok, `「${name}」已经修好了——把它从 KNOWN_BROKEN 删掉，让这条变成硬断言（原记：${known}）\n${detail}`);
    t.diagnostic(`已知未修（${known}）：${detail.split("\n")[0]}`);
    return;
  }
  assert.ok(ok, `「${name}」开窗不符合预期：\n${detail}`);
}

function expectLayout(t: TestContext, name: string, turns: Turn[], want: { windows: number; allowed?: WindowReason[] }): void {
  const windows = contextWindows(turns);
  const ok = windows.length === want.windows && windows.slice(1).every((w) => w.reasons.every((r) => want.allowed?.includes(r) ?? false));
  const lost = windows.reduce((n, w) => n + w.lostChars, 0);
  checkKnown(
    t,
    name,
    ok,
    `期望 ${want.windows} 个窗${want.allowed ? `（只允许 ${want.allowed.join(" / ")}）` : ""}，实际 ${windows.length} 个、要重算 ${lost} 字符\n${renderWindows(turns)}`,
  );
}

const RECALL_RE = /^\[Automatically recalled/;
const hasRecall = (messages: Msg[]): boolean => messages.some((m) => m.content.some((b) => b.t === "text" && RECALL_RE.test(b.text)));

// ── 夹具 ──────────────────────────────────────────────────────────────────────
function workspace(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(root, "src", "api.ts"), "const port = process.env.PORT;\napp.get('/health', handler);\nvoid port;\n");
  fs.writeFileSync(path.join(root, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  return root;
}

const echoTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("echoed", "echo result");
  },
};

const AUDIT_NONE = { decision: "none", reason: "Synthetic test turn produces no durable project knowledge." };

// ── 分窗器自身 ────────────────────────────────────────────────────────────────
const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const reply = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
const turnOf = (messages: Msg[], system = "sys"): Turn => ({ system, messages, tools: [], budget: { maxOutputTokens: 10 } });

test("Q2 分窗器：纯追加不开窗；system 变 = settings；中间被改写 = diverged（带位置与重算量）；变短 = truncated；旁路请求不比", () => {
  const a = [user("u1")];
  const b = [...a, reply("a1"), user("u2")];
  assert.equal(contextWindows([turnOf(a), turnOf(b)]).length, 1);

  const settings = contextWindows([turnOf(b), turnOf([...b, reply("a2")], "sys + plan")]);
  assert.deepEqual(settings.map((w) => w.reasons), [[], ["settings"]]);

  const rewritten = [user("u1"), user("[Automatically recalled] other"), reply("a1")];
  const diverged = contextWindows([turnOf([user("u1"), user("[Automatically recalled] x"), reply("a1")]), turnOf(rewritten)]);
  assert.deepEqual(diverged[1].reasons, ["diverged"]);
  assert.equal(diverged[1].at, 1);
  assert.ok(diverged[1].lostChars > 0);

  assert.deepEqual(contextWindows([turnOf(b), turnOf(a)])[1].reasons, ["truncated"]);

  const side: Turn = { system: "summarizer", messages: [user("transcript")], tools: [], budget: { maxOutputTokens: 10 } };
  assert.equal(contextWindows([turnOf(a), side, turnOf(b)], { side: (t) => t.system === "summarizer" }).length, 1);

  const picture = renderWindows([turnOf([user("u1"), user("[Automatically recalled] x")]), turnOf(rewritten)]);
  assert.match(picture, /Window 2 \(request 1: diverged at message 1, \d+ chars to recompute\)/);
  assert.match(picture, /#1 user: \[recall\]/, "已知注入片段折叠成标签");
});

// ── 场景 ──────────────────────────────────────────────────────────────────────
test("Q2 ① 单 run 多个工具轮：1 个窗（召回插在本轮用户消息之后，run 内位置不动）", async (t) => {
  const root = workspace("dimensio-layout-1-");
  const adapter = scripted(t).next(
    useTool("r1", "Read", { path: "src/api.ts" }),
    useTool("r2", "Read", { path: "src/math.ts" }),
    useTool("r3", "Read", { path: "package.json" }),
    say("看完了"),
  );
  const session = attachSession(adapter, root);
  await send(session, "看一下 src/api.ts 里的 /health 路由");
  assert.ok(hasRecall(adapter.inputs[0].messages), "前提：这一轮要真的召回到东西");
  expectLayout(t, "one-run", adapter.inputs, { windows: 1 });
  dropSession(session.id);
});

test("Q2 ② 连续三条用户消息（各带召回）：应当 1 个窗", async (t) => {
  const root = workspace("dimensio-layout-2-");
  const adapter = scripted(t);
  const session = attachSession(adapter, root);
  const asks = ["看一下 src/api.ts 里的 /health 路由", "src/api.ts 的 port 从哪来", "src/math.ts 的 add 怎么用"];
  for (const [i, ask] of asks.entries()) {
    const first = adapter.callCount;
    adapter.next(useTool(`r${i}`, "Read", { path: "src/api.ts" }), say(`答 ${i}`));
    await send(session, ask);
    assert.ok(hasRecall(adapter.inputs[first].messages), `前提：第 ${i + 1} 条消息要真的召回到东西`);
  }
  expectLayout(t, "recall", adapter.inputs, { windows: 1 });
  dropSession(session.id);
});

// 空闲逐出后恢复会话再发一条；两轮之间工作区按 change 改一下（真实会话里恢复前几乎总有改动）。
async function resumeScenario(t: TestContext, name: string, change: (root: string) => void): Promise<void> {
  const root = workspace(`dimensio-layout-${name}-`);
  // 这一场景的 state 由生产的 buildState 建（system 与线上同一条路）；假 key 只为让它建得起来，模型换成脚本。
  setConfig({ provider: "openai", model: "fake-model", apiKey: "DUMMY-q2-key", workspace: root, permissionMode: "auto", access: "workspace" });
  const adapter = scripted(t).next(say("你好！"), say("不客气"));
  const session = createSession();
  // 寒暄：不召回、不要求记忆审计——只量「恢复」本身
  const first = startRun(session, "你好");
  session.state!.adapter = adapter;
  await first.done;
  change(root);
  await persistNow(session);
  dropSession(session.id); // 逐出内存、盘上记录还在：空闲 30 分钟被淘汰、服务重启都是这样
  const back = await getOrLoadSession(session.id);
  assert.ok(back?.state, "会话没能从盘上恢复");
  back.state.adapter = adapter;
  await send(back, "谢谢");
  expectLayout(t, name, adapter.inputs, { windows: 1 });
  dropSession(session.id);
}

test("Q2 ③ 空闲逐出后恢复会话再发一条（期间改过一个文件的函数体）：应当 1 个窗（C2 修）", async (t) => {
  // 导出、行数都不变，只改函数体：只动得了源文件指纹——C2 起指纹不在 system 里
  await resumeScenario(t, "resume", (root) => fs.writeFileSync(path.join(root, "src", "math.ts"), "export const add = (a: number, b: number) => b + a;\n"));
});

test("Q2 ③b 空闲逐出后恢复会话再发一条（期间新增了一个源文件）：应当 1 个窗（C4 修）", async (t) => {
  // 模块数这类汇总跟着变：C4 起恢复时沿用盘上的 system，项目知识的变化留到下一次运行开头以内部片段追加
  await resumeScenario(t, "resume-new-file", (root) => fs.writeFileSync(path.join(root, "src", "util.ts"), "export const id = <T>(x: T) => x;\n"));
});

test("Q2 ④ 切 plan / 切访问范围：应当 1 个窗（C4：变化以内部片段追加，不改写 system）", async (t) => {
  const root = workspace("dimensio-layout-4-");
  // 走生产的 buildState（World State 由会话挂上）；假 key 只为让它建得起来，模型换成脚本
  setConfig({ provider: "openai", model: "fake-model", apiKey: "DUMMY-q2-key", workspace: root, permissionMode: "auto", access: "workspace" });
  const adapter = scripted(t).next(say("你好！"));
  const session = createSession();
  const first = startRun(session, "你好");
  session.state!.adapter = adapter;
  await first.done;
  assert.deepEqual(setSessionMode(session, "plan"), { ok: true });
  adapter.next(say("好。"), say("只是寒暄，没有要改的。")); // plan 档没交计划就想收尾 → 提醒一次
  await send(session, "好的");
  assert.deepEqual(setSessionMode(session, "auto"), { ok: true });
  assert.deepEqual(setSessionAccess(session, "full"), { ok: true });
  adapter.next(say("不客气"));
  await send(session, "谢谢");
  expectLayout(t, "mode-access", adapter.inputs, { windows: 1 });
  // 不开窗不等于没告诉模型：两次变化都以片段的形式到了模型眼前
  const seen = (i: number): string => JSON.stringify(adapter.inputs[i].messages);
  assert.match(seen(1), /PLAN MODE/, "切进 plan 后的第一次请求里应当有 plan 契约片段");
  assert.match(seen(adapter.inputs.length - 1), /no longer apply/, "切出 plan 后应当告诉模型 plan 契约作废");
  assert.match(seen(adapter.inputs.length - 1), /Access scope/i, "切访问范围后应当有访问范围片段");
  dropSession(session.id);
});

test("Q2 ⑤ 全量压缩：恰好一次 diverged，就在压缩摘要请求之后", async (t) => {
  // 每轮 2 万字的答复 + 很小的工具结果（微压缩省不出空间）→ 第 5 次调用前超过门槛，走全量压缩
  const big = "x".repeat(20_000);
  const round = (i: number): StreamEvent[] => calls({ e: "text_delta", text: `${i}${big}` }, call(`c${i}`, "Echo"));
  const adapter = scripted(t, { capabilities: { contextWindow: 30_000 } }).next(
    round(1), round(2), round(3), round(4),
    say(fakeSummary("SUMMARY: echoed four times")), // 压缩摘要（旁路请求）
    say("done"),
  );
  const { state } = loopState(t, adapter, { tools: [echoTool], user: "do a long job" });
  await drive(state, adapter);
  const compactions = adapter.inputs.flatMap((turn, i) => (isCompactionRequest(turn) ? [i] : []));
  assert.deepEqual(compactions, [4], "压缩摘要请求应当恰好一次，在第 5 次调用");
  expectLayout(t, "compaction", adapter.inputs, { windows: 2, allowed: ["diverged"] });
  assert.equal(contextWindows(adapter.inputs)[1].request, compactions[0] + 1, "分叉就发生在压缩之后的第一个主线请求");
});

test("Q2 ⑦ 审计收尾（先答复、再单独交审计）之后的下一条消息：应当 1 个窗", async (t) => {
  const adapter = scripted(t).next(
    say("答复一"), // 先答复、没交审计 → 追问审计（隐藏）
    useTool("m1", "MemoryAudit", AUDIT_NONE), // 交审计 → 以「答复一」收工：它留在原位（#79）
    calls({ e: "text_delta", text: "答复二" }, call("m2", "MemoryAudit", AUDIT_NONE)), // 答复与审计同一轮
  );
  const { state } = loopState(t, adapter, { user: "问题一", tools: [memoryAuditTool], memoryAudit: true });
  await drive(state, adapter);
  const answerAt = state.messages.findIndex((m) => m.role === "assistant" && m.content.some((b) => b.t === "text" && b.text === "答复一"));
  assert.equal(answerAt, 1, "答复一紧跟在问题一后面，没被挪走");
  assert.ok(state.messages.slice(answerAt + 1).every((m) => m.internal), "它后面只有 internal 的审计往返——聊天记录里它仍是最后一条");
  state.addUserMessage("问题二");
  await drive(state, adapter);
  expectLayout(t, "audit-closure", adapter.inputs, { windows: 1 });
});

test("Q2 Anthropic：跨 run 的首个请求应当命中上一 run 的最后写入点（编码后的请求体，按缓存断点规则建模）", async (t) => {
  const root = workspace("dimensio-layout-a-");
  const baseUrl = "https://anthropic.invalid";
  const wire = fakeAnthropicFetch(t, baseUrl, [
    useTool("r1", "Read", { path: "src/api.ts" }), say("答一"),
    useTool("r2", "Read", { path: "src/api.ts" }), say("答二"),
  ]);
  const adapter = createAdapter({ provider: "anthropic", apiKey: "FAKE-DUMMY-KEY", model: "claude-sonnet-4-6", baseUrl });
  const session = attachSession(adapter, root);
  await send(session, "看一下 src/api.ts 里的 /health 路由");
  const run2 = wire.bodies.length;
  await send(session, "src/api.ts 的 port 从哪来");
  assert.equal(wire.bodies.length, 4);
  const recalled = (body: any) => body.messages.some((m: any) => m.content.some((c: any) => c.type === "text" && RECALL_RE.test(c.text)));
  assert.ok(recalled(wire.bodies[0]) && recalled(wire.bodies[run2]), "前提：两条消息都要真的召回到东西");
  const rows = anthropicCacheModel(wire.bodies);
  const lastWrite = Math.max(...rows[run2 - 1].breakpoints);
  const first = rows[run2];
  checkKnown(
    t,
    "anthropic-run-boundary",
    first.hit >= lastWrite,
    `run 2 首请求最远命中到第 ${first.hit} 块，上一 run 最后写入点在第 ${lastWrite} 块；缓存读 ${first.readChars}/${first.totalChars} 字符`,
  );
  dropSession(session.id);
});
