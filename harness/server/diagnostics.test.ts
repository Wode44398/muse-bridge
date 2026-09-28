// Q13（X49 / K50 / F4，按 Codex C8 修订）：诊断内存环 + 崩溃留痕 + 一键诊断包。
//
// 修前：harness 的输出混在 bridge 的 stdout 里、server.log 停在 07-07；进程被 fatal-guard 判坏退出时什么都不留；
// 手机上「卡住了、慢了、报错了」之后，没有任何办法把当时的现场拿出来。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { rollbackPlan, takeCheckpoint } from "./checkpoints.ts";
import { diagnosticsDir, dumpRingSync, installConsoleRing, RING_MAX_BYTES, resetRingForTests, ringPush, ringSlice } from "./diag-ring.ts";
import { DIAG_MAX_BYTES, writeDiagnostics } from "./diagnostics.ts";
import { sessionFilePath } from "./store.ts";
import { inspectSessionFile } from "./session-health.ts";
import { deleteSession, startRun } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { runInTrace, startTrace } from "./trace.ts";
import { ok, type Tool } from "./tools/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
const FAKE_SECRET = "sk-ant-DUMMYDUMMYDUMMYDUMMY0000";

test("Q13 诊断内存环：console 照常打印并进环、带当时的会话 / traceId、先脱敏；有界", () => {
  resetRingForTests();
  const trace = startTrace("sess-ring-a", "run-a");
  runInTrace(trace, () => ringPush("error", ["provider said", { key: FAKE_SECRET }]));
  ringPush("log", ["process-level line"]);
  const mine = ringSlice("sess-ring-a");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].trace, trace.traceId);
  assert.match(mine[0].msg, /provider said/);
  assert.ok(!mine[0].msg.includes(FAKE_SECRET), "进环之前先脱敏");
  assert.deepEqual(ringSlice(undefined).map((e) => e.msg), ["process-level line"], "没有会话标签的是进程级输出");

  // 有界：灌 12 MB 进去，环里只留最新的约 4 MiB
  for (let i = 0; i < 3000; i++) ringPush("log", [`${i} ${"x".repeat(3990)}`]);
  const all = ringSlice(undefined, 100_000);
  const bytes = all.reduce((n, e) => n + e.msg.length, 0);
  assert.ok(bytes <= RING_MAX_BYTES, `环有界：${bytes}`);
  assert.match(all.at(-1)!.msg, /^2999 /, "留下的是最新的");

  // console 接上环：照常打印，同时带会话标签进环
  installConsoleRing();
  runInTrace(startTrace("sess-ring-b"), () => console.log("hello from a run"));
  assert.deepEqual(ringSlice("sess-ring-b").map((e) => e.msg), ["hello from a run"]);
});

test("Q13 崩溃留痕：fatal-guard 判定坏状态退出前把整环连同错误落盘；非零退出兜底；只留最近 10 份", async () => {
  // 真起一个子进程：装上 fatal-guard 与诊断环，打一行，然后连抛 5 个未捕获异常——应当以 1 退出并留下崩溃留痕
  const sessions = temp("dimensio-q13-crash-");
  const script = path.join(sessions, "crash.mjs");
  fs.writeFileSync(
    script,
    [
      `const { installFatalGuard } = await import(${JSON.stringify(pathToFileURL(path.join(here, "fatal-guard.ts")).href)});`,
      `const { installConsoleRing } = await import(${JSON.stringify(pathToFileURL(path.join(here, "diag-ring.ts")).href)});`,
      "installFatalGuard('q13'); installConsoleRing();",
      "console.log('marker before the crash');",
      "for (let i = 0; i < 5; i++) setTimeout(() => { throw new Error('boom ' + i); }, 20 * (i + 1));",
      "setTimeout(() => {}, 10_000);",
    ].join("\n"),
  );
  const child = spawn(process.execPath, [script], { env: { ...process.env, SESSIONS_DIR: sessions }, stdio: "ignore", windowsHide: true });
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  assert.equal(code, 1, "fatal-guard 判定坏状态后主动退出");
  const dir = path.join(sessions, "diagnostics");
  const crashes = fs.readdirSync(dir).filter((f) => f.startsWith("crash-"));
  assert.equal(crashes.length, 1, "留下一份崩溃留痕（fatal-guard 落过，退出钩子不重复）");
  const rec = JSON.parse(fs.readFileSync(path.join(dir, crashes[0]), "utf8")) as { reason: string; error: { message: string }; entries: Array<{ msg: string }> };
  assert.match(rec.reason, /fatal-guard: 5 uncaughtException/);
  assert.equal(rec.error.message, "boom 4");
  assert.ok(rec.entries.some((e) => e.msg === "marker before the crash"), "崩溃前的输出都在");

  // 本进程里直接落：只留最近 10 份
  for (let i = 0; i < 12; i++) {
    resetRingForTests();
    dumpRingSync(`test ${i}`);
  }
  assert.equal(fs.readdirSync(diagnosticsDir()).filter((f) => f.startsWith("crash-")).length, 10);
});

const noisyTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Noisy", description: "logs", parameters: { type: "object", properties: {} } },
  run: async () => {
    console.error("upstream failed with", FAKE_SECRET);
    return ok("noisy", "done");
  },
};
const usage = (inputTokens: number, outputTokens: number): StreamEvent => ({ e: "usage", inputTokens, outputTokens });

test("Q13 一键诊断包：写进会话工作区的 .dimensio/diagnostics/<id>/（git 看不见、检查点排除）；各部分齐全、不含 key、有上限；删会话回收", async (t) => {
  resetRingForTests();
  installConsoleRing();
  const root = temp("dimensio-q13-ws-");
  const g = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  fs.writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n");
  g("init", "-q");
  g("add", "-A");
  g("commit", "-qm", "init");
  const adapter = scripted(t).next([usage(80, 10), ...calls(call("n1", "Noisy"))], [usage(90, 5), ...say("好了")]);
  const session = attachSession(adapter, root, { tools: [noisyTool] });
  await startRun(session, "跑一下").done;

  const rec = { v: 1, id: session.id, createdAt: 1, updatedAt: Date.now(), title: "t",
    config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" },
    system: "s", messages: [], todos: [], totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] }, counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 } } as const;
  const cp = await takeCheckpoint(rec as never, root, "before diagnostics");
  const file = sessionFilePath(session.id)!;
  const made = await writeDiagnostics({
    sessionId: session.id,
    workspace: root,
    session: { id: session.id, messages: session.state!.messages.length, note: `summary with ${FAKE_SECRET}` },
    health: inspectSessionFile(file, session.id),
  });
  assert.match(made.path, new RegExp(`^\\.dimensio/diagnostics/${session.id}/diag-.*\\.json$`));
  const abs = path.join(root, ...made.path.split("/"));
  const raw = fs.readFileSync(abs, "utf8");
  assert.ok(!raw.includes(FAKE_SECRET), "包里没有任何 key（会话摘要、服务输出都过了脱敏）");
  const bundle = JSON.parse(raw) as Record<string, any>;
  for (const k of ["about", "session", "health", "trace", "ring", "processTail", "crashes", "skipped"]) assert.ok(k in bundle, `有 ${k}`);
  assert.ok(bundle.about.protocol.capabilities.includes("diagnostics"));
  assert.equal(bundle.health.load, "ok");
  assert.ok(bundle.trace.some((l: { e: string }) => l.e === "tool_start") && bundle.trace.some((l: { e: string }) => l.e === "run_end"), "带着这一轮的事件记录");
  assert.ok(bundle.ring.some((e: { msg: string }) => /upstream failed with/.test(e.msg)), "带着这一轮里工具打的输出");
  assert.ok(bundle.skipped.some((s: string) => /对话正文不在包里/.test(s)), "写明没放进来的");

  // git 看不见、检查点不收
  assert.equal(g("status", "--porcelain", "--untracked-files=all").stdout.trim(), "", "诊断包不是项目里的未跟踪文件");
  const plan = await rollbackPlan(session.id, cp!.n, root);
  assert.ok(!plan.changes.some((p) => p.replace(/\\/g, "/").startsWith(".dimensio/diagnostics")), "检查点不收诊断包");

  // 有上限：这个会话的输出灌到 6 MB，包仍在上限内，并写明截掉了
  runInTrace({ ...startTrace(session.id), sessionId: session.id }, () => {
    for (let i = 0; i < 1500; i++) ringPush("log", [`${i} ${"y".repeat(3990)}`]);
  });
  const big = await writeDiagnostics({ sessionId: session.id, workspace: root, session: {}, health: null });
  assert.ok(big.size <= DIAG_MAX_BYTES, `整包有上限：${big.size}`);
  const bigBundle = JSON.parse(fs.readFileSync(path.join(root, ...big.path.split("/")), "utf8")) as { skipped: string[] };
  assert.ok(bigBundle.skipped.some((s) => /整包超过/.test(s)));

  await deleteSession(session.id);
  assert.equal(fs.existsSync(path.join(root, ".dimensio", "diagnostics", session.id)), false, "删会话回收它的诊断包");
});
