// 子 agent 第二波：后台运行与通知、接着用、fork、自定义类型、research 的只读 Bash、批准卡转交、worktree 隔离、控制面保护、
// 压缩回填里的「还在跑的后台子 agent」、恢复时把卡片上过期的「在跑」改掉。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { makeSubAgentHost, type BackgroundEnd, type SubAgentEnv } from "./agent/subagent.ts";
import { agentTypesSection, findAgentDefinition, loadAgentDefinitions, parseFrontmatter } from "./agent/subagent/definitions.ts";
import { _resetAgentRegistry, registerAgent, MAX_BACKGROUND } from "./agent/subagent/registry.ts";
import { gatherRestore, renderRestore } from "./agent/compaction-restore.ts";
import { AgentState } from "./agent/state.ts";
import { CONTROL_PLANE_RULE, decide } from "./agent/permissions.ts";
import type { Turn } from "./agent/turn.ts";
import type { AdapterConfig } from "./providers/types.ts";
import { Sandbox } from "./sandbox.ts";
import { say, scripted, useTool, type ScriptedAdapter, type StepFn } from "./test-harness/scripted-adapter.ts";
import { agentTool } from "./tools/agent.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { bashTool } from "./tools/bash.ts";
import type { SubAgentResult, ToolContext } from "./tools/types.ts";
import { settleStaleAgentCards } from "./session/subagents.ts";
import { createWorktree, sweepAgentWorktrees } from "./agent/subagent/worktree.ts";
import { worktreesRoot } from "./paths.ts";
import { ownMemoryDirs } from "./memory-files.ts";
import { addWakeup, clearWakeups } from "./wakeup/store.ts";

const roots: string[] = [];
after(() => {
  _resetAgentRegistry();
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* windows 句柄 */
    }
  }
});

function tmpRoot(prefix = "dimensio-subhost-"): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(r);
  return r;
}

let owners = 0;
function env(root: string, extra: Partial<SubAgentEnv> = {}): SubAgentEnv {
  return {
    provider: "openai",
    apiKey: "FAKE-KEY",
    model: "fake",
    thinking: "off",
    sandbox: new Sandbox(root),
    limits: { bashTimeoutMs: 20_000, bashMaxTimeoutMs: 20_000 },
    ownerId: `owner-${++owners}`,
    ...extra,
  };
}

const textOf = (turn: Turn, role: "user" | "assistant" = "user"): string =>
  turn.messages.filter((m) => m.role === role).map((m) => m.content.map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? b.content.map((c) => (c.t === "text" ? c.text : "")).join("") : "")).join("")).join("\n");

const sysOf = (turn: Turn): string => (typeof turn.system === "string" ? turn.system : turn.system.map((b) => (b.t === "text" ? b.text : "")).join(""));

const lastToolResult = (turn: Turn): string => {
  const last = turn.messages.at(-1);
  const tr = last?.content.find((b) => b.t === "tool_result");
  return tr && tr.t === "tool_result" ? tr.content.map((c) => (c.t === "text" ? c.text : "")).join("") : "";
};

async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// 一步：等到这次调用的 signal 被中止才结束（模拟一个跑得很久的子 agent）
const waitForAbort = (adapter: ScriptedAdapter): StepFn =>
  async function* (_turn, n) {
    const sig = adapter.signals[n - 1];
    await new Promise<void>((resolve) => {
      if (!sig || sig.aborted) return resolve();
      sig.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("aborted");
  };

test("后台子 agent：立刻返回 id，跑完经 onBackgroundEnd 交回报告；list 看得到；超过并发上限明说", async (t) => {
  const child = scripted(t).next(say("REPORT-BG-1"));
  const ends: BackgroundEnd[] = [];
  const host = makeSubAgentHost(env(tmpRoot(), { onBackgroundEnd: (e) => ends.push(e) }), () => child);
  const started = host.control.start({ prompt: "find the thing", label: "finder", toolId: "call-1" });
  assert.ok(!("error" in started));
  assert.match(host.control.list(), new RegExp(`${started.id} \\[running`));
  await until(() => ends.length === 1);
  assert.equal(ends[0].id, started.id);
  assert.equal(ends[0].toolId, "call-1");
  assert.equal(ends[0].result.ok, true);
  assert.equal(ends[0].result.text, "REPORT-BG-1");
  assert.equal(ends[0].result.resumable, true);
  assert.match(host.control.list(), /\[completed/);

  // 并发上限：MAX_BACKGROUND 个在跑，再起一个被明说拒绝
  const slow = scripted(t);
  for (let i = 0; i < MAX_BACKGROUND; i++) slow.next(waitForAbort(slow));
  const host2 = makeSubAgentHost(env(tmpRoot()), () => slow);
  const ids: string[] = [];
  for (let i = 0; i < MAX_BACKGROUND; i++) {
    const s = host2.control.start({ prompt: `task ${i}` });
    assert.ok(!("error" in s));
    ids.push(s.id);
  }
  const over = host2.control.start({ prompt: "one too many" });
  assert.ok("error" in over && /already running/.test(over.error));
  await until(() => slow.callCount === MAX_BACKGROUND);
  for (const id of ids) assert.equal(host2.control.stop(id).ok, true);
});

test("停掉后台子 agent：结局是 aborted、写明是父 agent 停的；停一个没在跑的明说", async (t) => {
  const child = scripted(t);
  child.next(waitForAbort(child));
  const ends: BackgroundEnd[] = [];
  const host = makeSubAgentHost(env(tmpRoot(), { onBackgroundEnd: (e) => ends.push(e) }), () => child);
  const s = host.control.start({ prompt: "long task" });
  assert.ok(!("error" in s));
  await until(() => child.callCount === 1);
  const stop = host.control.stop(s.id);
  assert.equal(stop.ok, true);
  await until(() => ends.length === 1);
  assert.equal(ends[0].cause, "model");
  assert.equal(ends[0].result.stopReason, "aborted");
  assert.match(ends[0].result.error ?? "", /stopped by you/);
  assert.equal(host.control.stop(s.id).ok, false);
  assert.match(host.control.list(), /stopped by you/);
});

test("接着用：跑完的子 agent 收到追加消息，在原有上下文里接着答；不认识的 id 如实说", async (t) => {
  let second: Turn | null = null;
  const child = scripted(t).next(say("FIRST-ANSWER"), (turn) => {
    second = turn;
    return say("SECOND-ANSWER");
  });
  const host = makeSubAgentHost(env(tmpRoot()), () => child);
  const r1 = await host.run({ prompt: "first question" });
  assert.equal(r1.text, "FIRST-ANSWER");
  const out = host.control.resume(r1.id, "follow-up question", {});
  assert.ok(out instanceof Promise);
  const r2 = await out;
  assert.equal(r2.ok, true);
  assert.equal(r2.text, "SECOND-ANSWER");
  const seen = textOf(second!);
  assert.match(seen, /first question/);
  assert.match(textOf(second!, "assistant"), /FIRST-ANSWER/);
  assert.match(seen, /follow-up question/);
  // 这一次的统计只算这一次
  assert.equal(r2.turns, 1);
  const missing = host.control.resume("nope1234", "hi", {});
  assert.ok(!(missing instanceof Promise) && "error" in missing && /lost when the server restarts/.test(missing.error));
});

test("给还在跑的子 agent 追加消息：在它下一步之前注入", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let sawMessage = "";
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "a.txt"), "hello");
  const child = scripted(t).next(
    async function* () {
      await gate;
      yield* useTool("r1", "Read", { path: "a.txt" });
    },
    (turn) => {
      sawMessage = textOf(turn);
      return say("done after message");
    },
  );
  const host = makeSubAgentHost(env(root), () => child);
  const s = host.control.start({ prompt: "read a.txt" });
  assert.ok(!("error" in s));
  await until(() => child.callCount === 1);
  const q = host.control.resume(s.id, "also mention the size", {});
  assert.ok(!(q instanceof Promise) && "queued" in q);
  release();
  await until(() => sawMessage !== "");
  assert.match(sawMessage, /\[Message from the main agent\] also mention the size/);
});

function parentState(root: string, adapter: ScriptedAdapter): AgentState {
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
  };
  const tools = [readTool, agentTool];
  const state = new AgentState({
    adapter,
    system: "PARENT-SYSTEM-PROMPT",
    tools: tools.map((x) => x.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map(tools.map((x) => [x.def.name, x])),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  state.messages = [
    { role: "user", content: [{ t: "text", text: "PARENT-USER-ASK" }] },
    { role: "assistant", content: [{ t: "text", text: "PARENT-REPLY" }] },
    { role: "user", content: [{ t: "text", text: "now fork please" }] },
    { role: "assistant", content: [{ t: "tool_call", id: "fork-call", name: "Agent", args: { prompt: "x", context: "fork" } }, { t: "tool_call", id: "other-call", name: "Read", args: { path: "a" } }] },
  ];
  return state;
}

test("fork：前缀就是父会话的 system + 工具表 + 历史，同样的缓存时长；不能再派子 agent；输出不回写父会话", async (t) => {
  const root = tmpRoot();
  const parentAdapter = scripted(t);
  const parent = parentState(root, parentAdapter);
  const before = structuredClone(parent.messages);
  const child = scripted(t).next(useTool("a1", "Agent", { prompt: "nested" }), (turn) => say(`nested said: ${lastToolResult(turn)}`));
  const cfgs: AdapterConfig[] = [];
  const host = makeSubAgentHost(env(root, { parent: () => parent, cacheTtl: "1h" }), (cfg) => (cfgs.push(cfg), child));
  const r = await host.run({ prompt: "FORK-TASK", context: "fork", toolId: "fork-call" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.type, "fork");
  assert.equal(cfgs[0].cacheTtl, "1h");
  const first = child.inputs[0];
  assert.equal(sysOf(first), "PARENT-SYSTEM-PROMPT");
  assert.deepEqual(first.tools.map((x) => x.name), parent.tools.map((x) => x.name));
  // 前四条与父会话一字不差，接着是两次调用的占位结果，再是任务
  assert.deepEqual(first.messages.slice(0, 4).map((m) => m.content), before.map((m) => m.content));
  const placeholders = first.messages[4].content.filter((b) => b.t === "tool_result");
  assert.equal(placeholders.length, 2);
  assert.match(textOf(first), /\[Fork\][\s\S]*FORK-TASK/);
  assert.match(r.text, /not available inside a forked sub-agent/);
  assert.deepEqual(parent.messages, before, "父会话的转录不动");
});

test("集成：fork 与普通子 agent 一样拿到用户 hooks 的子 agent 视图（工具调用过 PreToolUse / PostToolUse，收尾报 SubagentStop）", async (t) => {
  const root = tmpRoot();
  const parent = parentState(root, scripted(t));
  let views = 0;
  const child = scripted(t).next(say("forked answer"));
  const host = makeSubAgentHost(env(root, { parent: () => parent, hooks: () => (views++, undefined) }), () => child);
  const r = await host.run({ prompt: "FORK-TASK", context: "fork", toolId: "fork-call" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.type, "fork");
  assert.equal(views, 1, "fork 的上下文取了一次 hooks 视图");
});

test("fork 做不到（要结构化结果 / 指定了型号）时退回普通子 agent，并在结果里说明", async (t) => {
  const root = tmpRoot();
  const parent = parentState(root, scripted(t));
  const child = scripted(t).next(say("fresh answer"));
  const host = makeSubAgentHost(env(root, { parent: () => parent }), () => child);
  const r = await host.run({ prompt: "task", context: "fork", model: "fake" });
  assert.equal(r.ok, true);
  assert.notEqual(sysOf(child.inputs[0]), "PARENT-SYSTEM-PROMPT");
  assert.match((r.notes ?? []).join(" "), /Not forked \(a fork runs on this session's model\)/);
});

test("自定义 agent 定义：frontmatter 解析、工具名单、正文进 system、认不出的型号明说并退回默认；清单段有预算", async (t) => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: \"Reviews a diff for bugs. Use after edits.\"\ntools: Read, Grep, NotebookEdit\nmodel: sonnet\n---\nYou are REVIEWER-BODY. Look for bugs.\n",
  );
  fs.mkdirSync(path.join(root, ".dimensio", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".dimensio", "agents", "research.md"), "---\nname: research\ndescription: tries to shadow a built-in\n---\nnope\n");
  fs.writeFileSync(path.join(root, ".dimensio", "agents", "writer.md"), "---\nname: writer\ndescription: Writes docs\ntools:\n  - Read\n  - Write\n---\nWRITER-BODY\n");
  assert.deepEqual(loadAgentDefinitions(root).map((d) => d.name), ["reviewer", "writer"]);
  assert.deepEqual(findAgentDefinition(root, "REVIEWER")?.tools, ["Read", "Grep", "NotebookEdit"]);
  assert.deepEqual(parseFrontmatter("---\ntools: [A, 'B']\n---\nbody")?.fields.tools, ["A", "B"]);
  const section = agentTypesSection(root, 100_000);
  assert.match(section, /- reviewer: Reviews a diff for bugs\./);
  assert.match(section, /- writer: Writes docs/);
  const tiny = agentTypesSection(root, 4_000); // 40 token 的预算放不下两条
  assert.match(tiny, /more; an unknown subagent_type lists every name/);

  const child = scripted(t).next(say("looks fine"));
  const host = makeSubAgentHost(env(root, { parentMode: () => "auto" }), () => child);
  const r = await host.run({ prompt: "review", type: "reviewer" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.type, "reviewer");
  assert.equal(r.tier, "research");
  const sys = sysOf(child.inputs[0]);
  assert.match(sys, /^You are the "reviewer" sub-agent/);
  assert.match(sys, /REVIEWER-BODY/);
  assert.deepEqual(child.inputs[0].tools.map((x) => x.name), ["Read", "Grep"]);
  const notes = (r.notes ?? []).join("\n");
  assert.match(notes, /NotebookEdit/);
  assert.match(notes, /model "sonnet", which this harness does not know/);

  const unknown = await makeSubAgentHost(env(root), () => scripted(t))
    .run({ prompt: "x", type: "nobody" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /Available: research, coder, reviewer, writer/);
});

test("用户级定义只在主机管理员实例读；成员实例只读工作区里的", async (t) => {
  const home = tmpRoot("dimensio-home-");
  fs.mkdirSync(path.join(home, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "agents", "global-helper.md"), "---\nname: global-helper\ndescription: from the user's home\n---\nbody\n");
  const root = tmpRoot();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DIMENSIO_TENANT: process.env.DIMENSIO_TENANT };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.deepEqual(loadAgentDefinitions(root).map((d) => d.name), ["global-helper"]);
  process.env.DIMENSIO_TENANT = "1";
  assert.deepEqual(loadAgentDefinitions(root).map((d) => d.name), []);
});

test("research 档有 Bash，但只能跑只读命令：写文件的命令被权限档拦下", async (t) => {
  const root = tmpRoot();
  const child = scripted(t).next(
    useTool("b1", "Bash", { command: "echo hi > out.txt" }),
    (turn) => say(`write: ${lastToolResult(turn)}`),
  );
  const host = makeSubAgentHost(env(root, { parentMode: () => "auto" }), () => child);
  const r = await host.run({ prompt: "try to write" });
  assert.ok(child.inputs[0].tools.some((x) => x.name === "Bash"));
  assert.match(r.text, /read-only mode blocks/);
  assert.ok(!fs.existsSync(path.join(root, "out.txt")));
});

test("子 agent 要批准的调用：父会话这一轮有人在场时经它弹卡（写明来自哪个子 agent）；离开模式照旧拒", async (t) => {
  const root = tmpRoot();
  const asks: { tool: string; why?: string }[] = [];
  let attended = true;
  const parent = parentState(root, scripted(t));
  parent.ctx.requestPermission = async (req) => {
    asks.push({ tool: req.tool, why: req.why });
    return { decision: "once" };
  };
  parent.ctx.humanAttended = () => attended;
  const child = scripted(t).next(
    useTool("w1", "Write", { path: "AGENTS.md", content: "rule" }),
    say("wrote it"),
    useTool("w2", "Write", { path: "CLAUDE.md", content: "rule" }),
    (turn) => say(`second: ${lastToolResult(turn)}`),
  );
  const host = makeSubAgentHost(env(root, { parent: () => parent, parentMode: () => "auto" }), () => child);
  const r1 = await host.run({ prompt: "write AGENTS.md", tier: "coder", label: "doc-writer" });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].tool, "Write");
  assert.match(asks[0].why ?? "", /来自子 agent「doc-writer」/);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "rule");
  attended = false;
  const r2 = await host.run({ prompt: "write CLAUDE.md", tier: "coder" });
  assert.equal(asks.length, 1, "离开模式不弹卡");
  assert.match(r2.text, /second: Denied/);
  assert.ok(!fs.existsSync(path.join(root, "CLAUDE.md")));
});

const hasGit = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
function gitRepo(): string {
  const repo = tmpRoot("dimensio-wt-repo-");
  const run = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  run("init", "-q");
  run("config", "user.email", "dummy@example.invalid");
  run("config", "user.name", "Dummy");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  run("add", "base.txt");
  run("commit", "-q", "-m", "init");
  return repo;
}

test("worktree 隔离：改了东西就保留（报告给路径与分支、父工作区不动），没改就删掉；不是 git 仓库时明说并退回", { skip: !hasGit }, async (t) => {
  const repo = gitRepo();
  const writer = scripted(t).next(useTool("w1", "Write", { path: "new.txt", content: "from the agent\n" }), say("added new.txt"));
  const host = makeSubAgentHost(env(repo, { parentMode: () => "auto" }), () => writer);
  const r = await host.run({ prompt: "add a file", tier: "coder", isolation: "worktree" });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.worktree?.kept, JSON.stringify(r.worktree));
  assert.ok(fs.existsSync(path.join(r.worktree!.path, "new.txt")));
  assert.ok(!fs.existsSync(path.join(repo, "new.txt")), "父工作区不动");
  assert.match(r.worktree!.branch, /^dimensio\/agent-/);
  assert.match(r.worktree!.summary, /new\.txt/);
  assert.match(sysOf(writer.inputs[0]), /This is your own git worktree \(branch dimensio\/agent-/);
  spawnSync("git", ["worktree", "remove", "--force", r.worktree!.path], { cwd: repo, windowsHide: true });

  const idle = scripted(t).next(say("nothing to change"));
  const r2 = await makeSubAgentHost(env(repo, { parentMode: () => "auto" }), () => idle).run({ prompt: "look only", tier: "coder", isolation: "worktree" });
  assert.equal(r2.worktree?.kept, false);
  assert.ok(!fs.existsSync(r2.worktree!.path), "没改动的 worktree 删掉了");
  const branches = spawnSync("git", ["branch", "--list", "dimensio/*"], { cwd: repo, windowsHide: true, encoding: "utf8" }).stdout;
  assert.ok(!branches.includes(r2.worktree!.branch), "分支一并删掉");

  const plain = tmpRoot();
  const r3 = await makeSubAgentHost(env(plain, { parentMode: () => "auto" }), () => scripted(t).next(say("ok"))).run({ prompt: "x", tier: "coder", isolation: "worktree" });
  assert.equal(r3.worktree, undefined);
  assert.match((r3.notes ?? []).join(" "), /Worktree isolation is not available \(the workspace is not inside a git repository\)/);
});

test("集成：worktree 隔离的子 agent 按父会话的工作区读记忆目录（能读到笔记；写照旧被拒，笔记不动）", { skip: !hasGit }, async (t) => {
  const repo = gitRepo();
  const [ws] = ownMemoryDirs(repo);
  fs.mkdirSync(ws.dir, { recursive: true });
  const note = path.join(ws.dir, "codename.md");
  fs.writeFileSync(note, "---\nname: Codename\ndescription: what Bluebird means\n---\nBluebird is the billing rewrite.\n");
  const agent = scripted(t).next(
    useTool("r1", "Read", { path: note }),
    useTool("w1", "Write", { path: note, content: "overwritten\n" }),
    say("done"),
  );
  const r = await makeSubAgentHost(env(repo, { parentMode: () => "auto" }), () => agent).run({ prompt: "read the codename note", tier: "coder", isolation: "worktree" });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.worktree, "确实在 worktree 里跑");
  assert.match(lastToolResult(agent.inputs[1]), /Bluebird is the billing rewrite/);
  assert.doesNotMatch(lastToolResult(agent.inputs[2]), /^Wrote|^Created/);
  assert.match(fs.readFileSync(note, "utf8"), /Bluebird is the billing rewrite/, "子 agent 不写持久记忆");
  if (r.worktree?.kept) spawnSync("git", ["worktree", "remove", "--force", r.worktree.path], { cwd: repo, windowsHide: true });
});

test("Agent 工具：background 立刻返回 id 与 running 卡片；action list / stop；id + prompt 接着用", async () => {
  const calls: string[] = [];
  const control = {
    start: () => (calls.push("start"), { id: "abc12345", label: "bg job" }),
    resume: (id: string, prompt: string) => (calls.push(`resume:${id}:${prompt}`), Promise.resolve<SubAgentResult>({
      ok: true, id, label: "bg job", tier: "research", model: "fake", provider: "openai", text: "continued", turns: 1, toolCalls: 0,
      inputTokens: 1, outputTokens: 1, editedFiles: [], trail: [], resumable: true,
    })),
    list: () => "- abc12345 [running 3s, background] research: bg job",
    stop: (id: string) => ({ ok: true, message: `Stopping ${id}` }),
  };
  const ctx = {
    sandbox: new Sandbox(tmpRoot()), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1, bashMaxTimeoutMs: 1 },
    agentSeesImages: false, callId: "c1", runSubAgent: async () => { throw new Error("not used"); }, subAgents: control,
  } as unknown as ToolContext;
  const bg = await agentTool.run({ prompt: "long job", background: true, label: "bg job" }, ctx);
  assert.equal(bg.ok, true);
  assert.match(bg.content[0].t === "text" ? bg.content[0].text : "", /Started sub-agent abc12345/);
  assert.equal((bg.meta as any).subagent.status, "running");
  const list = await agentTool.run({ action: "list" }, ctx);
  assert.match(list.content[0].t === "text" ? list.content[0].text : "", /abc12345 \[running/);
  const stop = await agentTool.run({ action: "stop", id: "abc12345" }, ctx);
  assert.equal(stop.ok, true);
  const more = await agentTool.run({ id: "abc12345", prompt: "and then?" }, ctx);
  assert.equal(more.ok, true);
  assert.match(more.content[0].t === "text" ? more.content[0].text : "", /continued[\s\S]*Agent\(id:"abc12345"/);
  assert.deepEqual(calls, ["start", "resume:abc12345:and then?"]);
  const noId = await agentTool.run({ action: "stop" }, ctx);
  assert.equal(noId.ok, false);
});

test("控制面：模型写 .claude/agents 与 .dimensio/agents 下的定义每次都要问", () => {
  const tools = new Map([[writeTool.def.name, writeTool], [bashTool.def.name, bashTool]]);
  const root = tmpRoot();
  for (const p of [".claude/agents/x.md", ".dimensio/agents/y.md"]) {
    const d = decide("auto", "Write", tools, { path: p, content: "x" }, { allow: ["Write"], deny: [], ask: [] }, { root });
    assert.equal(d.effect, "ask", p);
    assert.equal(d.rule, CONTROL_PLANE_RULE);
    assert.equal(d.noSession, true);
  }
  assert.equal(decide("auto", "Write", tools, { path: "src/agents/x.md", content: "x" }, { allow: [], deny: [], ask: [] }, { root }).effect, "allow");
});

test("收口：.claude/agents 是指向工作区外的 junction 时，里面的定义一个都不读；正常的定义照常", () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  fs.writeFileSync(path.join(outside, "leak.md"), "---\nname: leak\ndescription: SECRET-FROM-OUTSIDE first sentence.\n---\nSECRET-PROMPT-BODY\n");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, ".claude", "agents"), "junction");
  fs.mkdirSync(path.join(root, ".dimensio", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".dimensio", "agents", "fine.md"), "---\nname: fine\ndescription: A normal one.\n---\nDo the thing.\n");
  const defs = loadAgentDefinitions(root);
  assert.deepEqual(defs.map((d) => d.name), ["fine"]);
  assert.equal(findAgentDefinition(root, "leak"), undefined);
  assert.doesNotMatch(agentTypesSection(root, 200_000), /SECRET-FROM-OUTSIDE/);
});

test("压缩回填带上还在后台跑的子 agent（只给主会话，子 agent 自己压缩时不列）；恢复时卡片上过期的「在跑」改成已停止", async (t) => {
  const root = tmpRoot();
  const state = parentState(root, scripted(t));
  state.ctx.ownerId = "owner-restore";
  registerAgent({
    id: "bg000001", owner: "owner-restore", label: "survey modules", type: "research", tier: "research", background: true,
    status: "running", startedAt: Date.now(), runs: 1, ctrl: new AbortController(), done: null, inbox: [],
  });
  // 父会话约过一个定时唤醒（收口：子 agent 压缩时不该看到它——不是它约的，它也没有 ScheduleWakeup）
  assert.ok(addWakeup("owner-restore", { delaySeconds: 3600, reason: "PARENT-ONLY-REASON", prompt: "check CI" }).ok);
  t.after(() => clearWakeups("owner-restore"));
  // 子 agent 的 state：ownerId 同样是父会话的，但没有子 agent 控制口——不列兄弟后台子 agent，也不列父会话的唤醒
  const asChild = renderRestore(await gatherRestore(state, state.messages, state.messages.length, 100_000));
  const childText = asChild?.content.map((b) => (b.t === "text" ? b.text : "")).join("") ?? "";
  assert.doesNotMatch(childText, /Background sub-agents/);
  assert.doesNotMatch(childText, /Scheduled wakeups|ScheduleWakeup|PARENT-ONLY-REASON/);
  state.ctx.subAgents = { start: () => ({ error: "x" }), resume: () => ({ error: "x" }), list: () => "", stop: () => ({ ok: false, message: "" }) };
  const restore = await gatherRestore(state, state.messages, state.messages.length, 100_000);
  const msg = renderRestore(restore);
  const text = msg?.content.map((b) => (b.t === "text" ? b.text : "")).join("") ?? "";
  assert.match(text, /## Background sub-agents still running\n- bg000001 \[running/);
  assert.match(text, /Scheduled wakeups you set \(ScheduleWakeup\) still pending: .*PARENT-ONLY-REASON/, "主会话照列");

  const messages = [
    { role: "user" as const, content: [{ t: "tool_result" as const, id: "t1", ok: true, content: [], meta: { subagent: { id: "gone0001", status: "running", ok: true } } }] },
    { role: "user" as const, content: [{ t: "tool_result" as const, id: "t2", ok: true, content: [], meta: { subagent: { id: "bg000001", status: "running", ok: true } } }] },
  ];
  settleStaleAgentCards("owner-restore", messages);
  const m1 = messages[0].content[0].meta.subagent as Record<string, unknown>;
  assert.equal(m1.status, undefined);
  assert.equal(m1.ok, false);
  assert.equal(m1.stopReason, "aborted");
  assert.equal((messages[1].content[0].meta.subagent as Record<string, unknown>).status, "running", "台账里还在跑的不动");
});

test("自定义类型的工具名单有 Bash、没有 Write/Edit：会话 auto 时能跑非只读命令；会话只读时降成只读并说明", async (t) => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "agents", "runner.md"), "---\nname: runner\ndescription: Runs the test suite\ntools: Read, Bash\n---\nRun what you are asked to run.\n");
  const child = scripted(t).next(useTool("b1", "Bash", { command: "echo hi > out.txt" }), (turn) => say(`ran: ${lastToolResult(turn)}`));
  const r = await makeSubAgentHost(env(root, { parentMode: () => "auto" }), () => child).run({ prompt: "make out.txt", type: "runner" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tier, "coder");
  assert.deepEqual(child.inputs[0].tools.map((x) => x.name), ["Read", "Bash"]);
  assert.ok(fs.existsSync(path.join(root, "out.txt")), r.text);

  const ro = scripted(t).next(useTool("b1", "Bash", { command: "echo hi > out2.txt" }), (turn) => say(`ran: ${lastToolResult(turn)}`));
  const r2 = await makeSubAgentHost(env(root, { parentMode: () => "read-only" }), () => ro).run({ prompt: "make out2.txt", type: "runner" });
  assert.equal(r2.tier, "research");
  assert.match((r2.notes ?? []).join(" "), /"runner" ran read-only because this session is in read-only mode/);
  assert.ok(!fs.existsSync(path.join(root, "out2.txt")));
});

test("追加的话没来得及读它就停了：结果里如实说有几条没读到", async (t) => {
  const child = scripted(t);
  child.next(waitForAbort(child));
  const ends: BackgroundEnd[] = [];
  const host = makeSubAgentHost(env(tmpRoot(), { onBackgroundEnd: (e) => ends.push(e) }), () => child);
  const s = host.control.start({ prompt: "long task" });
  assert.ok(!("error" in s));
  await until(() => child.callCount === 1);
  const q = host.control.resume(s.id, "one more thing", {});
  assert.ok(!(q instanceof Promise) && "queued" in q);
  host.control.stop(s.id);
  await until(() => ends.length === 1);
  assert.match((ends[0].result.notes ?? []).join(" "), /1 message you sent it arrived after it stopped reading and was not read/);
});

test("父会话重建了状态（新的沙箱）、用户随后收窄访问范围：在跑的后台子 agent 下一次调用就按新边界判", async (t) => {
  const root = tmpRoot();
  const outside = tmpRoot("dimensio-outside-");
  fs.writeFileSync(path.join(outside, "note.txt"), "OUTSIDE-CONTENT");
  const target = path.join(outside, "note.txt");
  const first = parentState(root, scripted(t));
  first.ctx.sandbox = new Sandbox(root, "full");
  let current = first;
  // 对照：整机访问时读得到
  const ok = scripted(t).next(useTool("r0", "Read", { path: target }), (turn) => say(`read: ${lastToolResult(turn)}`));
  const r0 = await makeSubAgentHost(env(root, { sandbox: new Sandbox(root, "full"), parent: () => current }), () => ok).run({ prompt: "read it" });
  assert.match(r0.text, /OUTSIDE-CONTENT/);

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const child = scripted(t).next(
    async function* () {
      await gate;
      yield* useTool("r1", "Read", { path: target });
    },
    (turn) => say(`read: ${lastToolResult(turn)}`),
  );
  const ends: BackgroundEnd[] = [];
  const host = makeSubAgentHost(env(root, { sandbox: new Sandbox(root, "full"), parent: () => current, onBackgroundEnd: (e) => ends.push(e) }), () => child);
  const s = host.control.start({ prompt: "read it" });
  assert.ok(!("error" in s));
  await until(() => child.callCount === 1);
  const rebuilt = parentState(root, scripted(t));
  rebuilt.ctx.sandbox = new Sandbox(root, "workspace");
  current = rebuilt;
  release();
  await until(() => ends.length === 1);
  assert.doesNotMatch(ends[0].result.text, /OUTSIDE-CONTENT/);
});

test("worktree：只写了被 gitignore 的产出也保留（报告里列出来）；父工作区是仓库里没跟踪的子目录时不建、明说并退回", { skip: !hasGit }, async (t) => {
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, ".gitignore"), "out/\n");
  for (const args of [["add", ".gitignore"], ["commit", "-q", "-m", "ignore out"]]) {
    assert.equal(spawnSync("git", args, { cwd: repo, windowsHide: true }).status, 0);
  }
  const writer = scripted(t).next(useTool("w1", "Write", { path: "out/report.md", content: "REPORT\n" }), say("wrote the report"));
  const r = await makeSubAgentHost(env(repo, { parentMode: () => "auto" }), () => writer).run({ prompt: "write a report", tier: "coder", isolation: "worktree" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.worktree?.kept, true, JSON.stringify(r.worktree));
  assert.ok(fs.existsSync(path.join(r.worktree!.path, "out", "report.md")), "产出还在");
  assert.match(r.worktree!.summary, /git-ignored paths[\s\S]*out\//);
  spawnSync("git", ["worktree", "remove", "--force", r.worktree!.path], { cwd: repo, windowsHide: true });

  const sub = path.join(repo, "newproj");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "a.txt"), "untracked project\n");
  const r2 = await makeSubAgentHost(env(sub, { parentMode: () => "auto" }), () => scripted(t).next(say("ok"))).run({ prompt: "x", tier: "coder", isolation: "worktree" });
  assert.equal(r2.worktree, undefined);
  assert.match((r2.notes ?? []).join(" "), /not tracked in its git repository/);
  assert.ok(!fs.existsSync(path.join(worktreesRoot(), r2.id)), "刚建的 worktree 撤掉了");
  const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, windowsHide: true, encoding: "utf8" }).stdout;
  assert.ok(!list.includes(r2.id), list);
});

test("启动收尾：上一个进程没收尾的 worktree——没改动的删掉（连分支），有改动的保留并交回所属会话", { skip: !hasGit }, async () => {
  const repo = gitRepo();
  const clean = await createWorktree(repo, "sweep0001", "owner-sweep");
  const dirty = await createWorktree(repo, "sweep0002", "owner-sweep");
  assert.ok(!("error" in clean) && !("error" in dirty));
  fs.writeFileSync(path.join(dirty.root, "left.txt"), "unfinished\n");
  assert.ok(fs.existsSync(path.join(worktreesRoot(), "sweep0001.json")), "在用的 worktree 有登记");
  const left = await sweepAgentWorktrees();
  const mine = left.filter((k) => k.worktree.path === dirty.path);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].owner, "owner-sweep");
  assert.match(mine[0].outcome.summary, /left\.txt/);
  assert.ok(!fs.existsSync(clean.path), "没改动的删掉了");
  assert.ok(fs.existsSync(dirty.path), "有改动的留着");
  const branches = spawnSync("git", ["branch", "--list", "dimensio/*"], { cwd: repo, windowsHide: true, encoding: "utf8" }).stdout;
  assert.ok(!branches.includes(clean.branch) && branches.includes(dirty.branch), branches);
  assert.ok(!fs.existsSync(path.join(worktreesRoot(), "sweep0001.json")) && !fs.existsSync(path.join(worktreesRoot(), "sweep0002.json")), "登记撤掉了");
  assert.equal((await sweepAgentWorktrees()).filter((k) => k.worktree.path === dirty.path).length, 0, "只报一次");
  spawnSync("git", ["worktree", "remove", "--force", dirty.path], { cwd: repo, windowsHide: true });
});

test("跟着父会话走的沙箱不挡「允许这一次」：工作区外的只读目录经父会话批准后，这一次调用照常读到", async (t) => {
  const root = tmpRoot();
  const outside = tmpRoot("dimensio-outside-");
  fs.writeFileSync(path.join(outside, "note.txt"), "OUTSIDE-ONCE");
  const parent = parentState(root, scripted(t));
  const asks: string[] = [];
  parent.ctx.requestPermission = async (req) => {
    asks.push(req.tool);
    return { decision: "once" };
  };
  const child = scripted(t).next(useTool("r1", "Read", { path: path.join(outside, "note.txt") }), (turn) => say(`read: ${lastToolResult(turn)}`));
  const r = await makeSubAgentHost(env(root, { parent: () => parent }), () => child).run({ prompt: "read it" });
  assert.equal(asks.length, 1, r.text);
  assert.match(r.text, /OUTSIDE-ONCE/);
});
