// V1（#19）：验证证据可归属。改写自探针 03-hermes-agent/笔记/probe-masked-verify.ts。
//
// 修前：verify:true 只看整条命令行的退出码，git-bash 又不开 pipefail——一个 exit 1 的假测试，
// `| tail -5`、`|| true`、`; exit 0` 三种写法全部记成 passed；「跑了 0 个测试」的 exit 0 也算通过；
// revdeps 把 `npm test -- -t foo` 当全量、把 `grep x foo.test.ts` 当跑过；最终答复里没有任何
// 服务端给出的证据回执。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { bashTool, shell, killJobsFor } from "./tools/bash.ts";
import { uncoveredReferencingTests, isTestRunnerCommand } from "./agent/revdeps.ts";
import { AgentState } from "./agent/state.ts";
import { runAgent } from "./agent/loop.ts";
import { Sandbox } from "./sandbox.ts";
import type { AgentEvent, StreamEvent } from "./agent/events.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { ToolContext } from "./tools/types.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-v1-"));
after(() => {
  killJobsFor("v1-owner");
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 句柄占用就留给系统清 */
  }
});
fs.writeFileSync(path.join(tmp, "fail.test.js"), "console.log('1 failing'); process.exit(1);\n");
fs.writeFileSync(path.join(tmp, "pass.test.js"), "console.log('ℹ tests 3'); console.log('ℹ pass 3');\n");
fs.writeFileSync(path.join(tmp, "empty.test.js"), "console.log('ℹ tests 0'); console.log('ℹ pass 0');\n");

const ctx: ToolContext = {
  sandbox: new Sandbox(tmp),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 30_000, bashMaxTimeoutMs: 60_000 },
  agentSeesImages: false,
  ownerId: "v1-owner",
};
const bashSkip = shell.kind !== "bash" ? "这几条是 git-bash / bash 下的写法" : false;

test("管道与多语句盖不住失败（verify 自动 set -eo pipefail）", { skip: bashSkip }, async () => {
  for (const command of ["node fail.test.js 2>&1 | tail -5", "node fail.test.js; exit 0", "cd . && node fail.test.js | cat"]) {
    const r = await bashTool.run({ command, verify: true }, ctx);
    assert.equal(r.verification?.passed, false, command);
  }
  const ok = await bashTool.run({ command: "node pass.test.js 2>&1 | tail -5", verify: true }, ctx);
  assert.equal(ok.verification?.passed, true, "真通过的管道写法照常算通过");
});

test("`||` 兜底、`&` 放后台、开头 `!`：不执行、不记证据，并说明怎么改", async () => {
  for (const command of ["node fail.test.js || true", "node fail.test.js & echo started", "! node fail.test.js"]) {
    const r = await bashTool.run({ command, verify: true }, ctx);
    assert.equal(r.ok, false, command);
    assert.equal(r.verification, undefined, `${command}：不记证据`);
    assert.match(r.content.map((c) => ("text" in c ? c.text : "")).join(""), /NOT run and is NOT recorded/);
  }
  // 重定向里的 & 不是后台
  const redirect = await bashTool.run({ command: "node pass.test.js 2>&1", verify: true }, ctx);
  assert.equal(redirect.verification?.passed, true);
});

test("退出码是 0 但一个测试都没跑：不算通过", async () => {
  const r = await bashTool.run({ command: "node empty.test.js", verify: true }, ctx);
  assert.equal(r.verification?.passed, false);
  assert.match(r.verification?.detail ?? "", /zero tests/);
});

test("后台 job：以 verify:true 启动才带 pipefail；没带的管道写法 poll 时不记证据", { skip: bashSkip }, async () => {
  const poll = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await bashTool.run({ poll: id, verify: true }, ctx);
      if (!/running for/.test(r.summary)) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error("job never finished");
  };
  const idOf = (text: string) => /job\d+/.exec(text)?.[0] ?? "";
  // 启动时就 exit 了会走「立即结束」分支；给它一点时间差，逼它进后台
  const plain = await bashTool.run({ command: "sleep 2; node fail.test.js | tail -5", background: true }, ctx);
  const plainPolled = await poll(idOf(plain.summary + plain.content.map((c) => ("text" in c ? c.text : "")).join("")));
  assert.equal(plainPolled.verification, undefined, "没以 verify 启动的管道写法不记证据");
  assert.match(plainPolled.content.map((c) => ("text" in c ? c.text : "")).join(""), /not recorded as verification evidence/);

  const strict = await bashTool.run({ command: "sleep 2; node fail.test.js | tail -5", background: true, verify: true }, ctx);
  const strictPolled = await poll(idOf(strict.summary + strict.content.map((c) => ("text" in c ? c.text : "")).join("")));
  assert.equal(strictPolled.verification?.passed, false, "以 verify 启动：管道里的失败照实算失败");
});

test("revdeps：只有测试运行器算跑过；带参数的 npm test 是定向运行、不算全量", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-v1-rev-"));
  try {
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "widget.ts"), "export const widget = 1;\n");
    fs.writeFileSync(path.join(repo, "src", "widget.test.ts"), "import { widget } from './widget';\n");
    const edited = [path.join(repo, "src", "widget.ts")];
    const uncovered = (cmds: string[]) => uncoveredReferencingTests(repo, edited, cmds);
    assert.deepEqual(await uncovered(["grep widget src/widget.test.ts"]), ["src/widget.test.ts"], "grep 不是跑测试");
    assert.deepEqual(await uncovered(["npm test -- -t other"]), ["src/widget.test.ts"], "定向运行不算全量");
    assert.deepEqual(await uncovered(["npm test 2>&1 | tail -40"]), [], "全量运行（重定向与管道不算参数）");
    assert.deepEqual(await uncovered(["node --test src/widget.test.ts"]), [], "点名运行了这个测试文件");
    assert.equal(isTestRunnerCommand("cat src/widget.test.ts"), false);
    assert.equal(isTestRunnerCommand("npx vitest run src/widget.test.ts"), true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("验收全绿不附尾注；最后一次检查没过才附（连同通过的对照）；子 agent（没开尾注）不附", async () => {
  const run = (command: string) => ({ e: "tool_call" as const, id: command, name: "Bash", args: { command, verify: true } });
  const make = (finalFootnotes: boolean, commands: string[] = ["node pass.test.js"]) => {
    const script = (i: number): StreamEvent[] =>
      i < commands.length
        ? [run(commands[i]), { e: "turn_done", stopReason: "tool_use" }]
        : [{ e: "text_delta", text: "All tests pass." }, { e: "turn_done", stopReason: "end" }];
    let n = 0;
    const adapter: ProviderAdapter = {
      id: "openai",
      model: "fake",
      capabilities: { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false },
      async *stream() {
        for (const ev of script(n++)) yield ev;
      },
    };
    return new AgentState({
      adapter,
      system: "t",
      tools: [bashTool.def],
      budget: { maxOutputTokens: 1000, thinking: "off" },
      ctx: { ...ctx, ownerId: undefined },
      toolMap: new Map([["Bash", bashTool]]),
      permissionMode: "auto",
      memoryAuditRequired: false,
      finalFootnotes,
    });
  };
  const main = make(true);
  main.addUserMessage("run the tests");
  const events: AgentEvent[] = [];
  for await (const ev of runAgent(main, new AbortController().signal)) events.push(ev);
  const textOf = (s: AgentState) => s.messages.at(-1)!.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.equal(textOf(main), "All tests pass.", "全部通过：不打扰");
  assert.doesNotMatch(events.filter((e) => e.e === "text_delta").map((e) => (e as { text: string }).text).join(""), /✅/);

  const broken = make(true, ["node pass.test.js", "node fail.test.js"]);
  broken.addUserMessage("run the tests");
  const brokenEvents: AgentEvent[] = [];
  for await (const ev of runAgent(broken, new AbortController().signal)) brokenEvents.push(ev);
  const text = textOf(broken);
  assert.match(text, /^All tests pass\./);
  assert.match(text, /最后一次检查没通过：❌ `node fail\.test\.js/);
  assert.match(text, /通过的检查：✅ `node pass\.test\.js \(exit 0\)`/);
  const streamed = brokenEvents.filter((e) => e.e === "text_delta").map((e) => (e as { text: string }).text).join("");
  assert.match(streamed, /最后一次检查没通过/, "在线的客户端当场看到");

  const child = make(false, ["node pass.test.js", "node fail.test.js"]);
  child.addUserMessage("run the tests");
  for await (const _ of runAgent(child, new AbortController().signal)) { /* drain */ }
  assert.doesNotMatch(JSON.stringify(child.messages.at(-1)), /最后一次检查没通过/);
});
