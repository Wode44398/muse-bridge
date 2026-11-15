// 项目对话（project-mode.ts + tools/project.ts + tools/sessions.ts 的协调者三件 + project-routes.ts 的概览）：
// 协调者的工具表裁剪与系统提示、新会话带 shape 建成协调者（走生产的 buildState）、项目说明改了以 World State 片段送达、
// 讨论串派生（继承权限档、按 effort 定档、带讨论串标记）、汇报唤醒的轮能接着派、停下 / 标已解决、上限、项目记忆读写。
// 会话走 session-fixture 的 attachSession + 脚本化 provider；新会话那条按 M11 的做法用真 buildState、开跑后换上脚本化 provider。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, beforeEach, type TestContext } from "node:test";
import { attachSession } from "./test-harness/session-fixture.ts";
import { say, scripted, useTool, type ScriptedAdapter } from "./test-harness/scripted-adapter.ts";
import { createSession, deleteSession, dropSession, getSession, startRun, type Session } from "./session.ts";
import { toolMap } from "./tools/registry.ts";
import { readTool } from "./tools/read.ts";
import { COORDINATOR_SESSION_TOOLS, listSessionsTool, readSessionTool, sendMessageTool, SESSION_TOOLS } from "./tools/sessions.ts";
import { coordinatorBashTool, coordinatorMemoryTools, coordinatorToolTable, threadMemoryTools } from "./tools/project.ts";
import { describeWorldChange, systemPrompt } from "./agent/prompt.ts";
import { reloadPrefs } from "./prefs.ts";
import { setConfig } from "./config.ts";
import type { RuntimeConfig } from "./config.ts";
import type { Turn } from "./agent/turn.ts";
import type { ToolContext } from "./tools/types.ts";
import { _resetFamily, addLink, familyHooks, familyLink, familyPromptSection, familyView, flushFamily, spawnLimit } from "./session-family.ts";
import {
  _resetProjectMode,
  flushProjectMode,
  isProjectSession,
  memoryList,
  memoryRead,
  memoryWrite,
  PROJECT_MAX_THREADS,
  projectContextText,
  projectIdFor,
  projectState,
  registerProjectSession,
  updateProject,
} from "./project-mode.ts";
import { projectView } from "./project-routes.ts";

// 台账、项目记忆、运行配置、内置厂商 key 都落在这个测试文件自己的临时目录（别的测试进程共用同一套数据根）
const ownRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-project-"));
const prevEnv = { cfg: process.env.DIMENSIO_CONFIG_FILE, prov: process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR };
process.env.DIMENSIO_CONFIG_FILE = path.join(ownRoot, "runtime-config.json");
process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = path.join(ownRoot, "custom-providers");
reloadPrefs();
after(() => {
  process.env.DIMENSIO_CONFIG_FILE = prevEnv.cfg;
  process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = prevEnv.prov;
  try { fs.rmSync(ownRoot, { recursive: true, force: true }); } catch { /* 留给 test-global 的清扫 */ }
});

const BG = "Background for the thread: the overall goal is to verify the project-mode plumbing end to end in tests, nothing else.";
const created: Session[] = [];
const roots: string[] = [];
beforeEach(() => {
  _resetFamily();
  _resetProjectMode();
  familyHooks.createChild = undefined;
});
afterEach(async () => {
  for (const s of created.splice(0)) {
    s.abort?.abort();
    await s.runPromise?.catch(() => {});
  }
  familyHooks.createChild = undefined;
  await flushFamily();
  await flushProjectMode();
  while (roots.length) try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* 见上 */ }
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(ownRoot, "ws-"));
  roots.push(dir);
  return dir;
}
const COORD_TOOLS = [readTool, sendMessageTool, listSessionsTool, readSessionTool, ...COORDINATOR_SESSION_TOOLS, ...coordinatorMemoryTools()];
// 协调者：夹具会话 + 协调者那几件工具，登记成项目对话；provider / 型号换成目录里有档位表的，讨论串按 effort 定档才看得出来
function coordinator(adapter: ScriptedAdapter, root: string): Session {
  const s = attachSession(adapter, root, { tools: COORD_TOOLS });
  s.state!.ctx.ownerId = s.id;
  s.cfg = { ...s.cfg!, provider: "openai", model: "deepseek-flash", thinking: "high", shape: "project" };
  registerProjectSession(s.id);
  created.push(s);
  return s;
}
function plain(adapter: ScriptedAdapter, root: string, tools = [readTool, ...threadMemoryTools()]): Session {
  const s = attachSession(adapter, root, { tools });
  s.state!.ctx.ownerId = s.id;
  created.push(s);
  return s;
}
// 讨论串由夹具建（脚本化 provider），按顺序取；顺带记下 session-family 给它合成的配置
function threads(adapters: ScriptedAdapter[], root: string, cfgs: RuntimeConfig[] = []) {
  familyHooks.createChild = (cfg) => {
    cfgs.push(cfg);
    return plain(adapters.shift()!, root);
  };
  return cfgs;
}
async function waitFor(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const idle = (s: Session | undefined) => Boolean(s) && !s!.running;
const allText = (t: Turn) => t.messages.map((m) => m.content.map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? JSON.stringify(b.content) : "")).join("")).join("\n");
const ctxOf = (s: Session): ToolContext => s.state!.ctx;
const textOf = (r: { content: { t: string; text?: string }[] }) => r.content.map((b) => (b.t === "text" ? b.text : "")).join("");

test("协调者的工具表：只留看 / 查 / 问 / 计划 / 会话 / 项目记忆，Bash 与 StartSession 换成协调者版；系统提示整段换成协调者版", () => {
  const full = toolMap();
  const coord = coordinatorToolTable(full, COORDINATOR_SESSION_TOOLS);
  const names = [...coord.keys()];
  for (const n of ["Read", "Glob", "Grep", "WebFetch", "AskUserQuestion", "TodoWrite", "SendMessage", "ListSessions", "ReadSession", "StartSession", "StopSession", "MarkResolved", "ProjectMemoryRead", "ProjectMemoryWrite", "ProjectMemoryDelete", "Bash"]) {
    assert.ok(names.includes(n), `协调者应有 ${n}`);
  }
  for (const n of ["Write", "Edit", "Agent", "Workflow", "Preview", "Browser", "Remember", "Recall", "Skill", "BridgeCall", "DeviceShell", "Terminal", "ExitPlanMode"]) {
    assert.ok(!names.includes(n), `协调者不该有 ${n}`);
  }
  assert.equal(coord.get("Bash"), coordinatorBashTool);
  // 协调者版 StartSession：不问卡、能给 effort，不开到别的项目 / 不开 Claude 会话 / 不分叉
  const props = Object.keys(coord.get("StartSession")!.def.parameters.properties);
  assert.ok(props.includes("effort"));
  for (const p of ["initiation", "context", "project", "agent", "tldr"]) assert.ok(!props.includes(p), `协调者的 StartSession 不该有 ${p}`);
  // 协调者自己的动手工具不碰工作区：按 read 判（项目对话的档位是讨论串的权限）
  for (const n of ["StartSession", "StopSession", "MarkResolved", "ProjectMemoryWrite", "ProjectMemoryDelete", "Bash"]) assert.equal(coord.get(n)!.effect, "read", n);
  // 讨论串那份项目记忆写 / 删按 write 判（同 Remember）
  assert.deepEqual(threadMemoryTools().map((t) => `${t.def.name}:${t.effect}`), ["ProjectMemoryRead:read", "ProjectMemoryWrite:write", "ProjectMemoryDelete:write"]);
  // 原表里没有的（租户禁用了 Bash）不会被补回来
  const noBash = new Map(full);
  noBash.delete("Bash");
  assert.ok(!coordinatorToolTable(noBash, COORDINATOR_SESSION_TOOLS).has("Bash"));

  const sys = systemPrompt({ root: "/w", shell: "bash", platform: "linux", provider: "openai", model: "m", coordinator: "## You are the coordinator of this project\nROLE-BODY", project: "## Project\nPROJECT-BODY", permissionMode: "plan" });
  assert.match(sys, /You are the coordinator of a project conversation/);
  assert.match(sys, /ROLE-BODY[\s\S]*PROJECT-BODY/);
  assert.doesNotMatch(sys, /autonomous software engineering agent/, "普通会话那套动手契约整段不要");
  assert.doesNotMatch(sys, /PLAN MODE IS ACTIVE/, "协调者的档位是讨论串的权限，不写 plan 段");
  assert.match(describeWorldChange("mode", "plan", "auto", false, true), /threads you start[\s\S]*PLAN/);
  assert.match(describeWorldChange("project", "## Project\nX", undefined), /replaces the Project section[\s\S]*X/);
});

test("新会话带 shape:project 建成协调者（生产 buildState）；项目说明改了下一轮以 World State 片段送达、system 不改写", async (t: TestContext) => {
  t.mock.method(console, "log", () => {});
  const root = workspace();
  setConfig({ provider: "openai", model: "deepseek-flash", apiKey: "DUMMY-project-mode-key", workspace: root, permissionMode: "auto", access: "workspace" });
  const s = createSession(undefined, { shape: "project" });
  created.push(s);
  t.after(() => dropSession(s.id));
  const adapter = scripted(t).next(say("先看看仓库再派活。"));
  const run = startRun(s, "把登录页的报错修掉，再补一条测试");
  s.state!.adapter = adapter;
  await run.done;
  assert.equal(s.cfg?.shape, "project");
  assert.ok(isProjectSession(s.id), "登记进了项目台账");
  const names = [...s.state!.toolMap.keys()];
  assert.ok(names.includes("StopSession") && names.includes("ProjectMemoryWrite") && names.includes("Bash"));
  assert.ok(!names.includes("Write") && !names.includes("Edit") && !names.includes("Agent"), names.join(","));
  assert.equal(s.state!.toolMap.get("Bash"), coordinatorBashTool);
  assert.deepEqual(s.state!.tools.map((d) => d.name).filter((n) => n !== "ToolSearch").sort(), names.filter((n) => n !== "ToolSearch").sort(), "下发给模型的定义与执行表是同一套");
  const system = s.state!.system;
  assert.match(system, /You are the coordinator of this project/);
  assert.match(system, /## Project\nProject instructions: none yet/);
  assert.doesNotMatch(system, /## Memory index/);

  // 用户在概览里写了项目说明：下一轮开跑前追加一条 world-state 片段，system 原样
  updateProject(s.id, { instructions: "只改 web/ 下的文件；提交信息写中文。" });
  const second = scripted(t).next((turn: Turn) => {
    assert.match(allText(turn), /The project's instructions or shared memory changed[\s\S]*只改 web\/ 下的文件/);
    return say("收到，按项目说明来。");
  });
  s.state!.adapter = second;
  await startRun(s, "继续").done;
  assert.equal(s.state!.system, system, "system 不改写（world-state 机制）");
  assert.ok(s.state!.messages.some((m) => m.kind === "world-state" && m.world?.project), "片段带 project 节的令牌");

  // 普通新会话照旧：不是项目对话、工具表完整
  const normal = createSession();
  created.push(normal);
  t.after(() => dropSession(normal.id));
  const n1 = startRun(normal, "你好");
  normal.state!.adapter = scripted(t).next(say("你好！"));
  await n1.done;
  assert.equal(normal.cfg?.shape, undefined);
  assert.ok(!isProjectSession(normal.id));
  assert.ok(normal.state!.toolMap.has("Write"));
});

test("讨论串：协调者直接开（不问卡）、继承权限档、按 effort 定档、带讨论串标记；停下它这一轮、标已解决；ListSessions 与概览如实", async (t: TestContext) => {
  const root = workspace();
  const coordA = scripted(t);
  const threadA = scripted(t);
  const coord = coordinator(coordA, root);
  const cfgs = threads([threadA], root);
  // 讨论串这一轮一直跑着，直到被停下（脚本化 provider 等这次调用的中止信号）
  threadA.next(async function* (_turn: Turn, n: number) {
    const sig = threadA.signals[n - 1];
    await new Promise<void>((res) => (!sig || sig.aborted ? res() : sig.addEventListener("abort", () => res(), { once: true })));
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  let threadId = "";
  coordA.next(
    useTool("c1", "StartSession", { title: "Fix login", prompt: "Fix the login error in `web/login.ts` and add a test.", background: BG, effort: "low" }),
    async function* (turn: Turn) {
      assert.match(allText(turn), /Started the session \\"Fix login\\"/);
      threadId = Object.keys(familyView().links).find((id) => familyLink(id)?.parent === coord.id) ?? "";
      await waitFor(() => Boolean(getSession(threadId)?.running) && threadA.callCount === 1, "讨论串开跑、正等着模型");
      yield* useTool("c2", "ListSessions", {});
    },
    (turn: Turn) => {
      assert.match(allText(turn), /\[child\] Fix login — id: [^,]+, name: fix-login, working/);
      return useTool("c3", "StopSession", { to: "fix-login" });
    },
    async function* (turn: Turn) {
      assert.match(allText(turn), /Stopped the current turn of the thread \\"Fix login\\"/);
      await waitFor(() => idle(getSession(threadId)), "讨论串这一轮收尾");
      yield* useTool("c4", "MarkResolved", { to: "fix-login" });
    },
    (turn: Turn) => {
      assert.match(allText(turn), /Marked \\"Fix login\\" resolved/);
      return useTool("c5", "ListSessions", {});
    },
    (turn: Turn) => {
      assert.match(allText(turn), /name: fix-login, idle, marked resolved/);
      return say("讨论串已停下并标为已解决。");
    },
  );
  const run = startRun(coord, "把登录页的报错修掉");
  assert.ok(run.started);
  await run.done;
  assert.ok(threadId, "开出了讨论串");
  const link = familyLink(threadId)!;
  assert.equal(link.thread, true, "项目对话开的子会话带讨论串标记");
  assert.equal(projectIdFor(threadId), coord.id, "讨论串属于这个项目");
  assert.equal(cfgs[0].permissionMode, coord.cfg!.permissionMode, "继承项目对话的权限档");
  assert.equal(cfgs[0].thinking, "low", "协调者给的 effort 生效");
  assert.equal(projectState(coord.id).resolved[threadId], true);
  await waitFor(() => idle(getSession(threadId)), "讨论串停下");
  // 讨论串的系统提示段：「你是项目里的讨论串」
  assert.match(familyPromptSection(threadId), /You are a thread of a project[\s\S]*ProjectMemoryWrite/);
  // 概览：讨论串的状态是真的
  const view = await projectView(coord.id);
  assert.deepEqual(view.threads.map((r) => [r.id, r.state, r.resolved, r.waiting]), [[threadId, "idle", true, false]]);
  // 被用户停下的那轮只记着、不唤醒协调者（协调者自己停的，它知道）
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(coordA.callCount, 6);
});

test("讨论串汇报唤醒的那一轮，协调者能接着派下一条（普通会话被唤醒的轮不开新会话）", async (t: TestContext) => {
  const root = workspace();
  const coordA = scripted(t);
  const t1 = scripted(t);
  const t2 = scripted(t);
  const coord = coordinator(coordA, root);
  threads([t1, t2], root);
  t1.next(say("RESEARCH-DONE: the bug is in web/login.ts line 40."));
  t2.next(say("FIXED."));
  coordA.next(
    useTool("c1", "StartSession", { title: "Research", prompt: "Find where the login error comes from.", background: BG }),
    say("交给讨论串去查了。"),
    // 汇报唤醒的一轮：被结果解锁的下一步直接派
    (turn: Turn) => {
      assert.match(allText(turn), /<side-sessions-event>[\s\S]*RESEARCH-DONE/);
      return useTool("c2", "StartSession", { title: "Fix it", prompt: "Fix web/login.ts line 40 as the research found.", background: BG });
    },
    (turn: Turn) => {
      assert.match(allText(turn), /Started the session \\"Fix it\\"/);
      return say("查到了，已经派人去修。");
    },
    (turn: Turn) => {
      assert.match(allText(turn), /FIXED\./);
      return say("修好了。");
    },
  );
  await startRun(coord, "登录页报错，查一下再修").done;
  await waitFor(() => coordA.callCount === 5 && idle(coord), "第二条讨论串汇报回来");
  assert.equal(Object.values(familyView().links).filter((l) => l.parent === coord.id && l.thread).length, 2);

  // 对照：普通会话被子会话汇报唤醒的那一轮，照旧不替用户开新会话；它开的子会话也不带讨论串标记
  const normA = scripted(t);
  const kid = scripted(t);
  const norm = plain(normA, root, [readTool, ...SESSION_TOOLS]);
  threads([kid], root);
  kid.next(say("KID-DONE"));
  normA.next(
    useTool("n1", "StartSession", { initiation: "user_asked", title: "Kid", prompt: "Do the kid thing.", background: BG }),
    say("交出去了。"),
    (turn: Turn) => {
      assert.match(allText(turn), /KID-DONE/);
      return useTool("n2", "StartSession", { initiation: "user_asked", title: "Next", prompt: "Do the next thing.", background: BG });
    },
    (turn: Turn) => {
      assert.match(allText(turn), /Not started: this turn was not started by the user here/);
      return say("等你决定。");
    },
  );
  await startRun(norm, "开个会话去做 kid 那件事").done;
  await waitFor(() => normA.callCount === 4 && idle(norm), "普通会话被汇报唤醒那一轮收尾");
  const kids = Object.values(familyView().links).filter((l) => l.parent === norm.id);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].thread, undefined);
});

test("上限：一条项目对话累计 30 条讨论串；普通会话仍是 8 个子会话", () => {
  const P = "proj0000-0000-4000-8000-000000000001";
  const N = "norm0000-0000-4000-8000-000000000001";
  registerProjectSession(P);
  for (let i = 0; i < PROJECT_MAX_THREADS - 1; i++) addLink(`thrd${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`, { parent: P, parentTitle: "p", title: `t${i}`, kind: "fresh", thread: true });
  assert.equal(spawnLimit(P), null, "29 条还能开");
  addLink("thrdlast-0000-4000-8000-000000000000", { parent: P, parentTitle: "p", title: "last", kind: "fresh", thread: true });
  assert.equal(spawnLimit(P)?.code, "children");
  for (let i = 0; i < 8; i++) addLink(`kid0${i}000-0000-4000-8000-000000000000`, { parent: N, parentTitle: "n", title: `k${i}`, kind: "fresh" });
  assert.equal(spawnLimit(N)?.code, "children");
});

test("项目记忆：协调者与讨论串读写同一份；文件名校验、索引进提示词；删项目对话连记忆一起删", async (t: TestContext) => {
  const root = workspace();
  const coord = coordinator(scripted(t), root);
  const thread = plain(scripted(t), root);
  addLink(thread.id, { parent: coord.id, parentTitle: "proj", title: "Thread", kind: "fresh", thread: true });
  const other = plain(scripted(t), root);
  const [cRead, cWrite, cDelete] = coordinatorMemoryTools();
  const [tRead, tWrite] = threadMemoryTools();
  // 协调者写决定 + 索引；讨论串读到同一份
  assert.equal((await cWrite.run({ name: "decisions.md", content: "- 只改 web/" }, ctxOf(coord))).ok, true);
  assert.equal((await cWrite.run({ name: "MEMORY.md", content: "- decisions.md — 不许碰的目录" }, ctxOf(coord))).ok, true);
  assert.match(textOf(await tRead.run({}, ctxOf(thread))), /2 note\(s\): MEMORY\.md, decisions\.md[\s\S]*decisions\.md — 不许碰的目录/);
  assert.equal(textOf(await tRead.run({ name: "decisions.md" }, ctxOf(thread))), "- 只改 web/");
  // 讨论串写的坑，协调者也看得到
  assert.equal((await tWrite.run({ name: "pitfalls.md", content: "测试要先 build" }, ctxOf(thread))).ok, true);
  assert.equal(memoryRead(coord.id, "pitfalls.md"), "测试要先 build");
  assert.deepEqual(memoryList(coord.id).map((f) => f.name), ["MEMORY.md", "decisions.md", "pitfalls.md"]);
  // 文件名只认 *.md、不许越出目录
  for (const bad of ["../x.md", "a/b.md", "notes.txt", ".hidden.md"]) assert.equal((await cWrite.run({ name: bad, content: "x" }, ctxOf(coord))).ok, false, bad);
  assert.equal((await memoryWrite(coord.id, "big.md", "x".repeat(64 * 1024 + 1))).ok, false, "一篇最多 64KB");
  // 不属于任何项目的会话没有项目记忆
  assert.equal((await tRead.run({}, ctxOf(other))).ok, false);
  // 删
  assert.equal((await cDelete.run({ name: "pitfalls.md" }, ctxOf(coord))).ok, true);
  assert.equal(memoryRead(coord.id, "pitfalls.md"), null);
  assert.equal((await cDelete.run({ name: "pitfalls.md" }, ctxOf(coord))).ok, false);
  // 索引与项目说明进提示词（协调者与讨论串共用这一节）
  updateProject(coord.id, { instructions: "提交信息写中文。" });
  const ctxText = projectContextText(coord.id);
  assert.match(ctxText, /Project instructions[\s\S]*提交信息写中文。[\s\S]*It has 2 note\(s\); the index:\n- decisions\.md — 不许碰的目录/);
  // 概览里的记忆清单
  assert.deepEqual((await projectView(coord.id)).memory.map((f) => f.name), ["MEMORY.md", "decisions.md"]);
  // 删项目对话：台账与记忆一起删
  await deleteSession(coord.id);
  assert.equal(isProjectSession(coord.id), false);
  assert.deepEqual(memoryList(coord.id), []);
});
