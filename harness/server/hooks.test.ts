// 用户 hooks（Claude Code 同格式）：配置读取与 matcher、协议（退出码 0 / 2 / 其它、JSON 字段）、各挂点、项目级的信任确认、
// 成员实例不加载、超时必杀、环境不带凭据、写 hooks 配置每次都问（bypass 也问）。hook 命令是临时目录里的 node 小脚本。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { messageKind } from "./agent/injections.ts";
import { decide, type PermissionMode } from "./agent/permissions.ts";
import type { Block, Msg } from "./agent/turn.ts";
import { HOOK_RULE, loadHookConfig, matcherHits, MAX_STOP_HOOK_BLOCKS, preCompactHook, projectHooksTrusted, runStartHooks, SessionHooks } from "./hooks/index.ts";
import { commandRefs } from "./hooks/script-refs.ts";
import { hookTrustFile } from "./paths.ts";
import { scripted, say, useTool } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { shell } from "./tools/bash/env.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import type { Tool } from "./tools/types.ts";

let tmp = "";
let ws = "";
let userDir = "";
let logFile = "";
const saved = { dirs: process.env.DIMENSIO_USER_CONFIG_DIRS, tenant: process.env.DIMENSIO_TENANT, fake: process.env.FAKE_HOOK_API_KEY };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-hooks-"));
  ws = path.join(tmp, "ws");
  userDir = path.join(tmp, "home", ".claude");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  logFile = path.join(tmp, "hook-log.jsonl");
  process.env.DIMENSIO_USER_CONFIG_DIRS = userDir;
});

afterEach(() => {
  const restore = (name: string, v: string | undefined) => {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  };
  restore("DIMENSIO_USER_CONFIG_DIRS", saved.dirs);
  restore("DIMENSIO_TENANT", saved.tenant);
  restore("FAKE_HOOK_API_KEY", saved.fake);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

// 一个 hook 脚本：读 stdin 的 JSON 记进日志，再跑 body（拿得到 input）
function hookScript(name: string, body: string): string {
  const file = path.join(tmp, `${name}.mjs`);
  fs.writeFileSync(
    file,
    `import fs from "node:fs";\nconst input = JSON.parse(fs.readFileSync(0, "utf8"));\n` +
      `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ ...input, env: { claude: process.env.CLAUDE_PROJECT_DIR ?? null, fake: process.env.FAKE_HOOK_API_KEY ?? null } }) + "\\n");\n${body}\n`,
  );
  const node = process.execPath.replace(/\\/g, "/");
  const cmd = `"${node}" "${file.replace(/\\/g, "/")}"`;
  return shell.kind === "powershell" ? `& ${cmd}` : cmd;
}

const logged = (): Record<string, any>[] =>
  fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function settings(dir: string, hooks: Record<string, unknown>, name = "settings.json", extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...extra, hooks }));
}

const on = (matcher: string, command: string, timeout?: number) => [{ matcher, hooks: [{ type: "command", command, ...(timeout ? { timeout } : {}) }] }];
const textOf = (blocks: Block[]): string => blocks.map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? textOf(b.content) : "")).join("\n");
const resultOf = (msgs: Msg[], id: string) => {
  for (const m of msgs) for (const b of m.content) if (b.t === "tool_result" && b.id === id) return b;
  return undefined;
};

function session(t: Parameters<typeof scripted>[0], tools: Tool[] = [readTool]) {
  const adapter = scripted(t);
  const s = attachSession(adapter, ws, { tools });
  const hooks = SessionHooks.load(ws, s.id);
  if (hooks) s.state!.ctx.hooks = hooks;
  return { adapter, s, hooks };
}

test("配置：用户级与项目级的 settings.json / settings.local.json 合并；只认 command 型；disableAllHooks 整张作废；没配就是 null", () => {
  assert.equal(loadHookConfig(ws), null, "什么都没配");
  settings(userDir, { PreToolUse: on("Bash", "echo user") });
  settings(path.join(ws, ".claude"), { Stop: [{ hooks: [{ type: "command", command: "echo project" }, { type: "prompt", prompt: "x" }] }] }, "settings.local.json");
  settings(path.join(ws, ".dimensio"), { NotAnEvent: on("", "echo nope") });
  const cfg = loadHookConfig(ws)!;
  assert.deepEqual(cfg.hooks.map((h) => [h.event, h.scope, h.command]), [["Stop", "project", "echo project"], ["PreToolUse", "user", "echo user"]]);
  assert.ok(cfg.projectHash, "有项目级的就有指纹");
  settings(userDir, { PreToolUse: on("Bash", "echo user") }, "settings.json", { disableAllHooks: true });
  assert.equal(loadHookConfig(ws), null);
});

test("matcher：空与 * 全中；按整段正则；Claude Code 的旧名 Task 对得上 Agent；写坏的正则按字面比", () => {
  assert.ok(matcherHits("", "Read") && matcherHits("*", "mcp__x__y"));
  assert.ok(matcherHits("Edit|Write", "Write"));
  assert.ok(!matcherHits("Edit", "NotebookEdit"), "简单字符串精确匹配");
  assert.ok(matcherHits("mcp__.*", "mcp__gh__issue"));
  assert.ok(matcherHits("Task", "Agent"));
  assert.ok(matcherHits("Bash(", "Bash(") && !matcherHits("Bash(", "Bash"));
});

test("成员（租户）实例：一律不加载、不执行任何 hook", () => {
  settings(userDir, { PreToolUse: on("", "echo user") });
  settings(path.join(ws, ".claude"), { PreToolUse: on("", "echo project") });
  process.env.DIMENSIO_TENANT = "1";
  assert.equal(loadHookConfig(ws), null);
  assert.equal(SessionHooks.load(ws), undefined);
});

test("PreToolUse 退出码 2：不执行工具，stderr 作为工具结果交给模型；stdin 带事件名、会话、工作区、工具名与参数（含 file_path）；环境不带凭据", async (t) => {
  fs.writeFileSync(path.join(ws, "a.txt"), "AAA");
  process.env.FAKE_HOOK_API_KEY = "FAKE-DUMMY-KEY";
  settings(userDir, { PreToolUse: on("Read", hookScript("deny", `process.stderr.write("reading a.txt is not allowed here"); process.exit(2);`)) });
  const { adapter, s } = session(t);
  adapter.next(useTool("r1", "Read", { path: "a.txt" }), say("好"));
  await (await import("./session.ts")).startRun(s, "读一下 a.txt").done;
  const res = resultOf(s.state!.messages, "r1")!;
  assert.equal(res.ok, false);
  assert.match(textOf(res.content), /\[Hook: PreToolUse\][\s\S]*reading a\.txt is not allowed here/);
  assert.ok(!textOf(res.content).includes("AAA"), "工具没执行");
  const [input] = logged();
  assert.equal(input.hook_event_name, "PreToolUse");
  assert.equal(input.session_id, s.id);
  assert.equal(input.cwd, path.resolve(ws));
  assert.equal(input.tool_name, "Read");
  assert.equal(input.tool_use_id, "r1");
  assert.equal(input.tool_input.path, "a.txt");
  assert.equal(input.tool_input.file_path, "a.txt", "Claude Code 的参数名也给一份");
  assert.equal(input.permission_mode, "default");
  assert.equal(input.env.claude, path.resolve(ws), "CLAUDE_PROJECT_DIR");
  assert.equal(input.env.fake, null, "凭据类环境变量不继承");
});

test("PreToolUse 的 JSON：updatedInput 改参数（按 Claude Code 的名字改也认；转录里的原调用不动）；additionalContext 附在结果后；ask 把放行的调用转成问人", async (t) => {
  fs.writeFileSync(path.join(ws, "a.txt"), "AAA");
  fs.writeFileSync(path.join(ws, "b.txt"), "BBB");
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { file_path: "b.txt" }, additionalContext: "b.txt is the canonical copy" } });
  settings(userDir, { PreToolUse: on("Read", hookScript("rewrite", `process.stdout.write(${JSON.stringify(out)});`)) });
  const { adapter, s } = session(t);
  adapter.next(useTool("r1", "Read", { path: "a.txt" }), say("好"));
  await (await import("./session.ts")).startRun(s, "读").done;
  const res = resultOf(s.state!.messages, "r1")!;
  assert.equal(res.ok, true);
  assert.ok(textOf(res.content).includes("BBB") && !textOf(res.content).includes("AAA"), textOf(res.content));
  assert.ok(textOf(res.content).includes("b.txt is the canonical copy"));
  const callBlock = s.state!.messages.flatMap((m) => m.content).find((b) => b.t === "tool_call" && b.id === "r1");
  assert.deepEqual(callBlock && callBlock.t === "tool_call" ? callBlock.args : null, { path: "a.txt" }, "模型看过的历史不改写");

  // ask：auto 档本来放行的写，转成问人；没人在场就拒
  const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "writes need a look" } });
  settings(userDir, { PreToolUse: on("Write", hookScript("ask", `process.stdout.write(${JSON.stringify(ask)});`)) });
  const second = session(t, [writeTool]);
  second.adapter.next(useTool("w1", "Write", { path: "c.txt", content: "x" }), say("好"));
  const asked: { rule?: string; why?: string }[] = [];
  const run = (await import("./session.ts")).startRun(second.s, "写");
  second.s.state!.ctx.requestPermission = async (req) => {
    asked.push(req);
    return { decision: "deny" };
  };
  await run.done;
  const w = resultOf(second.s.state!.messages, "w1")!;
  assert.equal(w.ok, false);
  assert.ok(!fs.existsSync(path.join(ws, "c.txt")));
  assert.equal(asked.length, 1, "转成了问人");
  assert.equal(asked[0].rule, HOOK_RULE);
  assert.match(String(asked[0].why), /writes need a look/);
});

test("PostToolUse：退出码 2 的 stderr、decision block 的 reason、additionalContext 附在工具结果后面（随结果落盘）；其它退出码只记警告", async (t) => {
  fs.writeFileSync(path.join(ws, "a.txt"), "AAA");
  settings(userDir, {
    PostToolUse: [
      { matcher: "Read", hooks: [{ type: "command", command: hookScript("post2", `process.stderr.write("lint: 3 problems"); process.exit(2);`) }] },
      { matcher: "Read", hooks: [{ type: "command", command: hookScript("postjson", `process.stdout.write(JSON.stringify({ decision: "block", reason: "fix the header", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "ctx-line" } }));`) }] },
      { matcher: "Read", hooks: [{ type: "command", command: hookScript("post1", `process.exit(1);`) }] },
    ],
  });
  const { adapter, s } = session(t);
  adapter.next(useTool("r1", "Read", { path: "a.txt" }), say("好"));
  await (await import("./session.ts")).startRun(s, "读").done;
  const text = textOf(resultOf(s.state!.messages, "r1")!.content);
  assert.ok(text.includes("AAA"), "工具照常执行了");
  assert.ok(text.includes("lint: 3 problems") && text.includes("fix the header") && text.includes("ctx-line"), text);
  const post = logged().find((l) => l.hook_event_name === "PostToolUse")!;
  assert.equal(post.tool_response.success, true);
  assert.ok(String(post.tool_response.output).includes("AAA"));
});

test("Stop：拦下收尾就把理由作为 harness 消息追加、再跑一轮（stop_hook_active 第二次为 true）；一直拦有次数上限", async (t) => {
  settings(userDir, { Stop: on("", hookScript("stop-once", `if (!input.stop_hook_active) { process.stderr.write("tests are not run yet"); process.exit(2); }`)) });
  const { adapter, s } = session(t);
  adapter.next(say("做完了"), say("测试也跑了，做完了"));
  await (await import("./session.ts")).startRun(s, "改个东西").done;
  const hookMsgs = s.state!.messages.filter((m) => messageKind(m) === "hook");
  assert.equal(hookMsgs.length, 1);
  assert.match(textOf(hookMsgs[0].content), /^\[Hook: Stop\][\s\S]*tests are not run yet/);
  assert.deepEqual(logged().map((l) => l.stop_hook_active), [false, true]);
  assert.ok(textOf(adapter.inputs[1].messages.flatMap((m) => m.content)).includes("tests are not run yet"), "第二次请求看得到理由");

  fs.rmSync(logFile, { force: true });
  settings(userDir, { Stop: on("", hookScript("stop-always", `process.stderr.write("never done"); process.exit(2);`)) });
  const again = session(t);
  again.adapter.next(...Array.from({ length: MAX_STOP_HOOK_BLOCKS + 1 }, (_, i) => say(`第 ${i + 1} 次`)));
  await (await import("./session.ts")).startRun(again.s, "改").done;
  assert.equal(again.s.state!.messages.filter((m) => messageKind(m) === "hook").length, MAX_STOP_HOOK_BLOCKS);
});

test("子 agent 视图收尾报 SubagentStop；PreCompact 带 trigger、按 matcher 过滤", async (t) => {
  settings(userDir, { SubagentStop: on("", hookScript("sub", "")), Stop: on("", hookScript("main", "")), PreCompact: on("manual", hookScript("pre", "")) });
  const { adapter, s, hooks } = session(t);
  s.state!.ctx.hooks = hooks!.forSubagent();
  adapter.next(say("子任务做完了"));
  await (await import("./session.ts")).startRun(s, "查").done;
  assert.deepEqual(logged().map((l) => l.hook_event_name), ["SubagentStop"]);
  s.state!.ctx.hooks = hooks;
  await preCompactHook(s.state!, "auto");
  await preCompactHook(s.state!, "manual");
  const pre = logged().filter((l) => l.hook_event_name === "PreCompact");
  assert.deepEqual(pre.map((l) => l.trigger), ["manual"]);
});

test("一轮开跑：SessionStart 只发一次（source startup），UserPromptSubmit 的纯文本输出作为附加上下文进第一次请求", async (t) => {
  settings(userDir, {
    SessionStart: on("startup", hookScript("ss", `process.stdout.write("branch: main");`)),
    UserPromptSubmit: on("", hookScript("ups", `process.stdout.write("today is release day");`)),
  });
  const { adapter, s } = session(t);
  adapter.next(say("一"), say("二"));
  const { startRun } = await import("./session.ts");
  await startRun(s, "第一条").done;
  await startRun(s, "第二条").done;
  const events = logged().map((l) => l.hook_event_name);
  assert.deepEqual(events, ["SessionStart", "UserPromptSubmit", "UserPromptSubmit"]);
  assert.equal(logged()[0].source, "startup");
  assert.equal(logged()[1].prompt, "第一条");
  const first = textOf(adapter.inputs[0].messages.flatMap((m) => m.content));
  assert.ok(first.includes("[Hook: SessionStart]") && first.includes("branch: main") && first.includes("today is release day"), first);
});

test("UserPromptSubmit 拦下：这条消息不进对话、不调模型，原因作为错误给用户", async (t) => {
  settings(userDir, { UserPromptSubmit: on("", hookScript("ups-block", `process.stdout.write(JSON.stringify({ decision: "block", reason: "no secrets in prompts" }));`)) });
  const { s } = session(t);
  const { startRun } = await import("./session.ts");
  await startRun(s, "我的密码是 hunter2").done;
  assert.equal(s.state!.messages.length, 0, "消息拿掉了");
  const err = s.runLog.find((ev) => ev.e === "error") as { message?: string; summary?: string } | undefined;
  assert.match(String(err?.message), /no secrets in prompts/);
});

test("项目级 hooks：没确认过不执行；无人在场只记日志；确认一次后记下（工作区 + 配置指纹），配置一改要重新确认；拒绝则本会话不再问", async (t) => {
  settings(path.join(ws, ".claude"), { UserPromptSubmit: on("", hookScript("proj", "")), SessionStart: on("", hookScript("proj-ss", "")) });
  // 无人在场（没有挂确认卡的口）
  const a = session(t);
  assert.equal(a.hooks?.trust, "pending");
  await runStartHooks(a.s.state!, null);
  assert.equal(a.hooks?.trust, "pending");
  assert.equal(logged().length, 0, "没确认过的项目级 hook 不执行");

  // 有人在场：确认卡（只能允许这一次）——允许
  const b = session(t);
  const asked: { tool: string; noSession?: boolean; preview?: unknown }[] = [];
  const { startRun } = await import("./session.ts");
  b.adapter.next(say("二"));
  const run = startRun(b.s, "你好");
  // executeRun 开头会挂 requestPermission；这里换成自动允许的假卡
  b.s.state!.ctx.requestPermission = async (req) => {
    asked.push(req);
    return { decision: "once" };
  };
  await run.done;
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool, "Hooks");
  assert.equal(asked[0].noSession, true);
  assert.deepEqual(logged().map((l) => l.hook_event_name), ["SessionStart", "UserPromptSubmit"], "确认后同一轮就执行");
  const cfg = loadHookConfig(ws)!;
  assert.ok(projectHooksTrusted(ws, cfg.projectHash!));
  assert.equal(SessionHooks.load(ws)?.trust, "trusted");

  settings(path.join(ws, ".claude"), { UserPromptSubmit: on("", hookScript("proj2", "")) });
  assert.equal(SessionHooks.load(ws)?.trust, "pending", "配置变了要重新确认");

  // 拒绝：本会话不再问，项目级的不执行
  fs.rmSync(logFile, { force: true });
  const c = session(t);
  let asks = 0;
  c.adapter.next(say("三"), say("四"));
  const { startRun: start } = await import("./session.ts");
  for (const msg of ["一", "二"]) {
    const r = start(c.s, msg);
    c.s.state!.ctx.requestPermission = async () => {
      asks++;
      return { decision: "deny" };
    };
    await r.done;
  }
  assert.equal(asks, 1);
  assert.equal(c.hooks?.trust, "declined");
  assert.equal(logged().length, 0);
});

test("hook 超时：按 timeout 结束整棵进程树，只记警告、不阻止", async (t) => {
  settings(userDir, { UserPromptSubmit: on("", hookScript("slow", `await new Promise((r) => setTimeout(r, 30_000));`), 1) });
  const { adapter, s } = session(t);
  adapter.next(say("好"));
  const started = Date.now();
  await (await import("./session.ts")).startRun(s, "你好").done;
  assert.ok(Date.now() - started < 15_000, `超时没被结束：${Date.now() - started}ms`);
  assert.equal(adapter.inputs.length, 1, "照常开跑");
});

test("控制面：模型写 .claude / .dimensio 下的 settings（hooks）每次都问、bypass 也问；技能与命令目录照控制面文件处理", () => {
  const tools = new Map<string, Tool>([["Write", writeTool]]);
  const ask = (mode: PermissionMode, p: string) => decide(mode, "Write", tools, { path: p, content: "{}" }, { allow: ["Write"], deny: [], ask: [] }, { root: ws });
  // hook 脚本目录（改脚本 = 改已信任的 hook 要跑的命令）与项目级 hooks 的信任记录（伪造一条 = 替用户确认）同级
  const hookFiles = [".claude/hooks/fmt.sh", ".dimensio/hooks/a/b.py", path.join(userDir, "hooks", "x.sh"), hookTrustFile()];
  for (const p of [".claude/settings.json", ".dimensio/settings.local.json", path.join(userDir, "settings.json"), ...hookFiles]) {
    const d = ask("auto", p);
    assert.equal(d.effect, "ask", p);
    assert.equal(d.noSession, true);
    assert.equal(ask("bypass", p).effect, "ask", `bypass 也问：${p}`);
  }
  for (const p of [".claude/skills/x/SKILL.md", ".dimensio/commands/review.md", ".claude/commands/a/b.md"]) {
    assert.equal(ask("auto", p).effect, "ask", p);
    assert.equal(ask("bypass", p).effect, "allow", `技能与命令目录在 bypass 下照常放行：${p}`);
  }
  assert.equal(ask("auto", "src/settings.json").effect, "allow", "别处的 settings.json 不算");
  assert.equal(ask("bypass", ".git/hooks/pre-commit").effect, "allow", "git 的 hooks 目录不归这一类（它由沙箱的 .git 写保护管）");
});

test("项目级 hook 点名的脚本：内容进信任指纹；会话里被改过就不再执行，新会话要重新确认", async (t) => {
  const script = path.join(ws, ".claude", "hooks", "check.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ ran: "v1" }) + "\\n");\n`);
  const node = process.execPath.replace(/\\/g, "/");
  const cmd = `"${node}" "${script.replace(/\\/g, "/")}"`;
  settings(path.join(ws, ".claude"), { UserPromptSubmit: on("", shell.kind === "powershell" ? `& ${cmd}` : cmd) });
  const cfg = loadHookConfig(ws)!;
  assert.deepEqual(cfg.hooks[0].refs, [path.resolve(script)], "命令点名的工作区内脚本认出来了");
  const { startRun } = await import("./session.ts");

  const a = session(t);
  a.adapter.next(say("一"), say("二"));
  const r1 = startRun(a.s, "一");
  a.s.state!.ctx.requestPermission = async () => ({ decision: "once" });
  await r1.done;
  assert.deepEqual(logged().map((l) => l.ran), ["v1"], "确认后执行");

  // 会话里脚本被改了（比如模型改的）：同一会话不再执行
  fs.writeFileSync(script, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ ran: "v2" }) + "\\n");\n`);
  await startRun(a.s, "二").done;
  assert.deepEqual(logged().map((l) => l.ran), ["v1"], "改过的脚本不跑");
  assert.equal(SessionHooks.load(ws)?.trust, "pending", "指纹变了：新会话要重新确认");
});

test("点名脚本的识别：$CLAUDE_PROJECT_DIR 前缀、引号、相对路径都认；重定向目标、工作区外、不存在的不算", () => {
  fs.mkdirSync(path.join(ws, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude", "hooks", "fmt.sh"), "echo");
  fs.writeFileSync(path.join(ws, "lint.py"), "print()");
  fs.writeFileSync(path.join(ws, "out.log"), "");
  fs.writeFileSync(path.join(tmp, "elsewhere.sh"), "echo");
  const refs = commandRefs(
    `bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/fmt.sh && python lint.py >> out.log; sh ${path.join(tmp, "elsewhere.sh")} missing.sh`,
    ws,
  );
  assert.deepEqual(refs, [path.join(ws, ".claude", "hooks", "fmt.sh"), path.join(ws, "lint.py")]);
  assert.deepEqual(commandRefs("bash ${CLAUDE_PROJECT_DIR}/.claude/hooks/fmt.sh 2>out.log", ws), [path.join(ws, ".claude", "hooks", "fmt.sh")]);
});

test("UserPromptSubmit 拦下会话的第一条消息：SessionStart 的上下文留着，下一条照样看得到（SessionStart 不重发）", async (t) => {
  settings(userDir, {
    SessionStart: on("", hookScript("ss", `process.stdout.write("branch: main");`)),
    UserPromptSubmit: on("", hookScript("ups", `if (input.prompt.includes("hunter2")) { process.stderr.write("no secrets"); process.exit(2); }`)),
  });
  const { adapter, s } = session(t);
  adapter.next(say("好"));
  const { startRun } = await import("./session.ts");
  await startRun(s, "密码是 hunter2").done;
  assert.equal(adapter.inputs.length, 0, "拦下的那条不调模型");
  assert.ok(!textOf(s.state!.messages.flatMap((m) => m.content)).includes("hunter2"), "拦下的消息不留在转录里");
  await startRun(s, "你好").done;
  const first = textOf(adapter.inputs[0].messages.flatMap((m) => m.content));
  assert.ok(first.includes("[Hook: SessionStart]") && first.includes("branch: main"), first);
  assert.equal(logged().filter((l) => l.hook_event_name === "SessionStart").length, 1);
});

test("运行中插话也过 UserPromptSubmit：拦下的不进对话、退回输入框（带原因）；放行的附加上下文紧跟插话", async (t) => {
  settings(userDir, {
    UserPromptSubmit: on(
      "",
      hookScript("ups-steer", `if (input.prompt.includes("hunter2")) { process.stderr.write("no secrets in steers"); process.exit(2); } else if (input.prompt.includes("顺便")) process.stdout.write("steer-context-line");`),
    ),
  });
  const { adapter, s } = session(t);
  const { startRun, steerSession } = await import("./session.ts");
  fs.writeFileSync(path.join(ws, "a.txt"), "AAA");
  adapter.next(
    function* () {
      steerSession(s, "我的密码是 hunter2");
      steerSession(s, "顺便看看 b");
      yield* useTool("r1", "Read", { path: "a.txt" });
    },
    say("好"),
  );
  await startRun(s, "读 a").done;
  const all = textOf(s.state!.messages.flatMap((m) => m.content));
  assert.ok(!all.includes("hunter2"), "拦下的插话不进对话");
  assert.ok(!textOf(adapter.inputs[1].messages.flatMap((m) => m.content)).includes("hunter2"));
  const steerAt = s.state!.messages.findIndex((m) => m.origin === "steer");
  assert.ok(steerAt > 0);
  assert.equal(messageKind(s.state!.messages[steerAt + 1]), "hook");
  assert.match(textOf(s.state!.messages[steerAt + 1].content), /^\[Hook: UserPromptSubmit\]\nsteer-context-line/);
  const returned = s.runLog.find((ev) => ev.e === "steer_returned") as { texts?: string[]; reason?: string } | undefined;
  assert.deepEqual(returned?.texts, ["我的密码是 hunter2"]);
  assert.match(String(returned?.reason), /no secrets in steers/);
});

test("PreCompact 用调用方的信号，不用上一轮留下的：上一轮被停过，轮外的手动压缩照样把 hook 跑完；空闲压缩报 auto", async (t) => {
  settings(userDir, { PreCompact: on("", hookScript("pre", "")) });
  const { s } = session(t);
  const stale = new AbortController();
  stale.abort();
  s.state!.ctx.signal = stale.signal;
  await preCompactHook(s.state!, "manual");
  await preCompactHook(s.state!, "auto", new AbortController().signal);
  assert.deepEqual(logged().map((l) => l.trigger), ["manual", "auto"], "上一轮的 aborted 信号不掐轮外的 hook");
});
