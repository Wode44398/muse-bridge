// Q5（K49 / F3 / N50）：会话体检库——守恒问题清单与复盘统计；只读；脚本的退出码。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Block, Msg } from "./agent/turn.ts";
import { tagLegacyOrigins } from "./agent/injections.ts";
import { checkSession, errorCount, inspectRecord, inspectSessionFile, sessionStats } from "./session-health.ts";
import { dropSession, persistNow, sessionRecord } from "./session.ts";
import { loadSessionResult, SESSION_RECORD_VERSION, type PersistedSession } from "./store.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const text = (s: string): Block => ({ t: "text", text: s });
const user = (...content: Block[]): Msg => ({ role: "user", content });
const assistant = (...content: Block[]): Msg => ({ role: "assistant", content });
const toolCall = (id: string, name = "Read", args: Record<string, unknown> = { path: "a.ts" }): Block => ({ t: "tool_call", id, name, args });
const result = (id: string, body = "ok", ok = true): Block => ({ t: "tool_result", id, ok, content: [text(body)] });

// C3：这些夹具照旧式记录的写法（注入靠开头认）——生产上记录读入时先按开头补标来源（store.ts），这里照样补
function record(messages: Msg[], extra: Partial<PersistedSession> = {}): PersistedSession {
  tagLegacyOrigins(messages);
  return {
    v: SESSION_RECORD_VERSION,
    id: "s-health",
    createdAt: 1,
    updatedAt: 2,
    title: "t",
    config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto" },
    system: "sys",
    messages,
    todos: [],
    totals: { inputTokens: 100, outputTokens: 10, lastContextTokens: 100 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
    ...extra,
  };
}

const codes = (rec: PersistedSession, opts = {}) => checkSession(rec, opts).map((i) => `${i.severity}:${i.code}`);

test("Q5 健康的转录：没有问题", () => {
  const rec = record([user(text("go")), assistant(toolCall("a")), user(result("a")), assistant(text("done"))]);
  assert.deepEqual(codes(rec, { assetExists: () => true }), []);
});

test("Q5 查得出：配对坏、压缩切断、末尾悬空（可愈合，只是 info）、请求不变量", () => {
  assert.deepEqual(codes(record([user(text("go")), assistant(toolCall("a"), toolCall("b")), user(result("a")), assistant(text("x"))])), ["error:pairing"]);
  assert.deepEqual(
    codes(record([user(text("task")), user(text("[Earlier context summary]\nread a.ts")), user(result("gone")), assistant(text("x"))])),
    ["error:compaction-cut"],
    "摘要后面紧跟找不到调用的结果",
  );
  assert.deepEqual(codes(record([user(text("go")), assistant(toolCall("a"))])), ["info:dangling-tail"], "被中断的那一轮，恢复时会愈合");
  assert.deepEqual(
    codes(record([user(text("go")), assistant(toolCall("a")), user(result("a")), assistant(toolCall("a")), user(result("a"))])),
    ["error:request-invariant"],
    "调用 id 重复",
  );
});

test("Q5 查得出：注入片段漏进聊天记录、媒体资产丢了 / 媒体块是空的", () => {
  assert.deepEqual(codes(record([user(text("go")), user(text("[Automatically recalled task context]\n- [x] y")), assistant(text("ok"))])), ["error:injection-visible"]);
  assert.deepEqual(codes(record([user(text("go")), { role: "user", internal: true, content: [text("[Automatically recalled task context]")] }, assistant(text("ok"))])), [], "internal 的召回是对的");
  const img = (b: Partial<Extract<Block, { t: "image" }>>): Block => ({ t: "image", mime: "image/png", ...b });
  const rec = record([user(text("look"), img({ asset: `${"a".repeat(64)}.png` })), assistant(toolCall("s", "Screenshot")), user({ t: "tool_result", id: "s", ok: true, content: [img({})] }), assistant(text("ok"))]);
  assert.deepEqual(codes(rec, { assetExists: () => false }).sort(), ["error:media-empty", "error:media-missing"]);
});

test("Q5 查得出：续写链没闭合、停在 plan 档、前缀有没报备的断点、验证追问连击", () => {
  assert.deepEqual(codes(record([user(text("go")), assistant(text("half")), user(text("[Automated check] Your previous reply was cut off by the output-token limit mid-response."))])), ["warn:length-chain-open"]);
  assert.deepEqual(codes(record([user(text("go")), assistant(text("x"))], { config: { provider: "openai", model: "m", thinking: "off", permissionMode: "plan" } })), ["info:plan-mode"]);
  assert.deepEqual(
    codes(record([user(text("go")), assistant(text("x"))], { totals: { inputTokens: 1, outputTokens: 1, lastContextTokens: 1, prefix: { requests: 5, breaks: { unexplained: 2 }, resentChars: 10 } } })),
    ["warn:prefix-unexplained"],
  );
  const nudge = (): Msg => ({ role: "user", internal: true, content: [text("[Automated check] You have edited files without sufficient passing verification evidence.")] });
  assert.deepEqual(codes(record([user(text("fix")), assistant(text("done")), nudge(), assistant(text("done")), nudge(), assistant(text("done")), nudge(), assistant(text("done"))])), ["warn:verify-gate-exhausted"]);
});

test("Q5 复盘统计：轮数、工具调用与失败、被拒、没轮到、连续相同调用、写到已出现的路径、注入片段、token", () => {
  const rec = record(
    [
      user(text("first")),
      assistant(toolCall("r1", "Read", { path: "a.ts" })),
      user(result("r1")),
      assistant(toolCall("w1", "Write", { path: "a.ts" }), toolCall("w2", "Write", { path: "a.ts" })),
      user(result("w1", "Denied by permission policy: read-only", false), result("w2", "Not executed: the user stopped the run before this call started.", false)),
      { role: "user", internal: true, content: [text("[Memory audit required] ...")] },
      assistant(text("done")),
      user(text("[用户在运行中插话] 以下是用户刚刚发来的消息。换个做法")),
      assistant(text("[this turn ended on an error: http_500. No tools ran in this run.]")),
    ],
    { totals: { inputTokens: 1000, outputTokens: 50, lastContextTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 100 } },
  );
  const s = sessionStats(rec);
  assert.equal(s.observed.runs, 2, "插话算用户说的话；注入片段、工具结果不算");
  assert.equal(s.observed.assistantTurns, 4);
  assert.deepEqual(s.observed.toolCalls, { Read: { calls: 1, failed: 0 }, Write: { calls: 2, failed: 2 } });
  assert.equal(s.observed.denied, 1);
  assert.equal(s.observed.notExecuted, 1);
  assert.equal(s.observed.maxIdenticalStreak, 2, "两次一模一样的 Write");
  assert.deepEqual(s.observed.identicalStreaks, { 2: 1 });
  assert.deepEqual(s.observed.injections, { "audit-nudge": 1, steer: 1 });
  assert.equal(s.observed.errorEndedTurns, 1);
  assert.deepEqual(s.observed.tokens, { input: 1000, output: 50, cacheRead: 800, cacheWrite: 100 });
  assert.equal(s.modeled.writesToKnownPaths, 2, "Write 的路径先前被 Read 过");
  assert.ok(s.modeled.estimatedTokens > 0);
});

test("Q5 只读：坏文件体检只报「读不出」，文件原样不动（对照：正常加载会把它隔离改名）", async () => {
  const dir = temp("dimensio-health-ro-");
  const file = path.join(dir, "s-bad.json");
  fs.writeFileSync(file, "\u0000".repeat(64));
  const report = inspectSessionFile(file, "s-bad");
  assert.equal(report.load, "corrupt");
  assert.equal(errorCount(report), 1);
  assert.equal(fs.readFileSync(file, "utf8"), "\u0000".repeat(64), "体检不许动文件");

  const saved = process.env.SESSIONS_DIR;
  process.env.SESSIONS_DIR = dir;
  try {
    assert.equal((await loadSessionResult("s-bad")).kind, "corrupt");
    assert.equal(fs.existsSync(file), false, "对照：生产加载路径会隔离改名——所以体检不能走它");
  } finally {
    if (saved === undefined) delete process.env.SESSIONS_DIR;
    else process.env.SESSIONS_DIR = saved;
  }
});

test("Q5 真会话：生产路径跑出来的转录（工具往返、召回、落盘）体检零守恒问题", async (t) => {
  const root = temp("dimensio-health-live-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "api.ts"), "app.get('/health', handler);\n");
  const saved = process.env.KNOWLEDGE_AUTO_SEMANTIC;
  process.env.KNOWLEDGE_AUTO_SEMANTIC = "0";
  t.after(() => {
    if (saved === undefined) delete process.env.KNOWLEDGE_AUTO_SEMANTIC;
    else process.env.KNOWLEDGE_AUTO_SEMANTIC = saved;
  });
  const adapter = scripted(t).next(useTool("r1", "Read", { path: "src/api.ts" }), say("看完了"), say("好"));
  const session = attachSession(adapter, root);
  await send(session, "看一下 src/api.ts 的 /health 路由");
  await send(session, "再确认一下");
  await persistNow(session);
  const rec = sessionRecord(session)!;
  const report = inspectRecord(rec, { assetExists: () => true });
  assert.deepEqual(report.issues.filter((i) => i.severity !== "info"), []);
  assert.equal(report.stats?.observed.runs, 2);
  assert.deepEqual(report.stats?.observed.toolCalls, { Read: { calls: 1, failed: 0 } });
  assert.ok((report.stats?.observed.injections.recall ?? 0) >= 1, "召回（C1 起落盘、internal）");
  dropSession(session.id);
});

test("Q5 脚本：有守恒问题退出码 1 并点名；全都健康退出码 0；--stats 出统计", () => {
  const dir = temp("dimensio-health-cli-");
  const good = record([user(text("go")), assistant(text("done"))]);
  fs.writeFileSync(path.join(dir, "s-good.json"), JSON.stringify({ ...good, id: "s-good" }));
  const run = () =>
    spawnSync(process.execPath, ["scripts/session-health.mjs", "--dir", dir, "--stats"], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /合计：0 个会话有守恒问题/);
  assert.match(ok.stdout, /■ openai\/m：1 个会话/);

  const bad = record([user(text("go")), assistant(toolCall("a"), toolCall("b")), user(result("a")), assistant(text("x"))]);
  fs.writeFileSync(path.join(dir, "s-bad.json"), JSON.stringify({ ...bad, id: "s-bad" }));
  const failed = run();
  assert.equal(failed.status, 1, "守恒问题要进退出码");
  assert.match(failed.stdout, /✖ s-bad {2}openai\/m {2}error:pairing/);
});
