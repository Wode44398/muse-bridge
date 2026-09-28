// P5（A6、X24、X25；#4）：「本会话都允许」写下的规则——字面规则不再被原文里的 * ? 放大、按稳定前缀记的选项、
// 高危命令只给字面规则、卡片照原样显示要记下的规则、自测不过的选项不给、写进全局的规则先自查。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentState } from "./agent/state.ts";
import {
  decide,
  ruleProblems,
  sessionAllowRule,
  sessionRuleChoices,
  upgradeSessionAllow,
  type PermissionRules,
} from "./agent/permissions.ts";
import { createSession, dropSession, resolvePermission, startRun, watchSession } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { bashTool } from "./tools/bash.ts";
import { ALL_TOOLS, toolMap } from "./tools/registry.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";

const tools = toolMap();
const askAll = (allow: string[], tool = "Bash"): PermissionRules => ({ allow, deny: [], ask: [tool] });
const bash = (command: string, rules: PermissionRules) => decide("auto", "Bash", tools, { command }, rules).effect;

test("P5: 本会话都允许 records a literal rule — * and ? in the approved call no longer widen it", () => {
  // 批准一次 `rm -rf build/*`，以前记成 glob：之后 `rm -rf build/../../x` 也静默放行
  const rm = askAll([sessionAllowRule("Bash", "rm -rf build/*")]);
  assert.equal(bash("rm -rf build/*", rm), "allow");
  assert.equal(bash("rm -rf build/../../x", rm), "ask");
  assert.equal(bash("rm -rf build/x", rm), "ask");
  // URL 里的 ? 不再是单字通配
  const fetchRule = askAll([sessionAllowRule("WebFetch", "https://x.dev/a?b=1")], "WebFetch");
  assert.equal(decide("auto", "WebFetch", tools, { url: "https://x.dev/a?b=1" }, fetchRule).effect, "allow");
  assert.equal(decide("auto", "WebFetch", tools, { url: "https://x.dev/aXb=1" }, fetchRule).effect, "ask");
  // 换行是命令分隔符：批准的是一条 echo，不能放行「echo 然后另起一行 rm」
  const echo = askAll([sessionAllowRule("Bash", "echo a rm -rf x")]);
  assert.equal(bash("echo a rm -rf x", echo), "allow");
  assert.equal(bash("echo a\nrm -rf x", echo), "ask");
  // 旧记录（没有 v）载入时改成字面规则；新记录与不带模式的原样
  const binding = { mode: "auto" as const, access: "workspace", rulesHash: "h" };
  assert.equal(upgradeSessionAllow({ rule: "Bash(rm -rf build/*)", ...binding }).rule, "Bash(=rm -rf build/*)");
  assert.equal(upgradeSessionAllow({ rule: "Bash(npm run lint:*)", ...binding, v: 2 }).rule, "Bash(npm run lint:*)");
  assert.equal(upgradeSessionAllow({ rule: "Workflow", ...binding }).rule, "Workflow");
});

test("P5: 按前缀 is offered only for stable, narrow prefixes — never for high-risk commands or interpreter entry points", () => {
  const choices = (command: string) => sessionRuleChoices("Bash", { command }, tools);
  assert.deepEqual(choices("npm run lint -- --fix && git status"), {
    exact: ["Bash(=npm run lint -- --fix && git status)"],
    prefix: ["Bash(npm run lint:*)", "Bash(git status:*)"],
  });
  assert.deepEqual(choices("python -m pytest -q").prefix, ["Bash(python -m pytest:*)"]);
  assert.deepEqual(choices("docker compose up -d").prefix, ["Bash(docker compose up:*)"]);
  assert.deepEqual(choices("ls -la src").prefix, ["Bash(ls:*)"]);
  for (const command of [
    "rm -rf build/*", // 高危根命令
    "sudo npm i -g x",
    "bash -c 'npm test'",
    "python -c 'print(1)'", // 解释器入口
    "node -e 'x'",
    "deno run x.ts",
    "npm run", // 过宽
    "make",
    "curl -s https://x.dev", // 选项在前、没有子命令
    "FOO=1 npm test", // 赋值会改变命令行为
    "echo $(git rev-parse HEAD)", // 运行时的值
    "git log > out.txt", // 写文件
    "find . -name x", // 纯读动词里带写旗标风险的
    "a && b && c && d && e && f", // 超过 5 条
  ]) {
    const c = choices(command);
    assert.equal(c.prefix, undefined, command);
    assert.deepEqual(c.exact, [`Bash(=${command})`], command);
  }
  // 自测：前缀规则放行这次的命令，不放行把最后一段换掉的兄弟命令、也不放行串上别的命令
  const lint = askAll(choices("npm run lint").prefix!);
  assert.equal(bash("npm run lint -- --fix", lint), "allow");
  assert.equal(bash("npm run build", lint), "ask");
  assert.equal(bash("npm run lint && rm -rf ./x", lint), "ask");
});

test("P5: the card shows the rules it will record, and 本会话都允许 records exactly the server's chosen set", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-p5-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = scripted(t).next(
    calls(call("b1", "Bash", { command: "echo p5-one" })),
    calls(call("b2", "Bash", { command: "echo p5-two" })), // 已按前缀允许：不再弹卡
    calls(call("b3", "Bash", { command: "rm -rf ./p5-missing" })), // 高危：只有字面规则
    say("done"),
  );
  const session = createSession();
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: [bashTool.def],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 20_000, bashMaxTimeoutMs: 20_000 }, agentSeesImages: false },
    toolMap: new Map([["Bash", bashTool]]),
    permissionMode: "auto",
    permissionRules: { allow: [], deny: [], ask: ["Bash"] },
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "跑三条命令");
  watchSession(session, (ev) => {
    events.push(ev);
    // 用户每张卡都点「本会话都允许」并选「按前缀」；客户端只能传 scope，传不进规则原文
    if (ev.e === "permission_ask") resolvePermission(session, String(ev.id), "session", undefined, "prefix");
  });
  await run.done;

  const asks = events.filter((e) => e.e === "permission_ask");
  assert.equal(asks.length, 2, "第二条 echo 已被前缀规则放行");
  assert.deepEqual(asks[0].sessionRules, ["Bash(=echo p5-one)"]);
  assert.deepEqual(asks[0].prefixRules, ["Bash(echo:*)"]);
  assert.deepEqual(asks[1].sessionRules, ["Bash(=rm -rf ./p5-missing)"]);
  assert.equal(asks[1].prefixRules, undefined, "高危命令不给前缀选项");
  const resolved = events.filter((e) => e.e === "permission_resolved");
  assert.deepEqual(resolved.map((e) => e.scope ?? "exact"), ["prefix", "exact"], "没有前缀候选时选了前缀也只记字面规则");
  const rules = (session.cfg?.sessionAllow ?? []).map((a) => a.rule);
  assert.deepEqual(rules.sort(), ["Bash(=rm -rf ./p5-missing)", "Bash(echo:*)"]);
  assert.ok((session.cfg?.sessionAllow ?? []).every((a) => a.v === 2));
  dropSession(session.id);
});

test("P5 (X24): rules written into the global config are checked first — a rule that could never fire is refused", () => {
  const known = new Set(ALL_TOOLS.map((tool) => tool.def.name.toLowerCase()));
  assert.deepEqual(ruleProblems({ deny: ["Bash(rm -rf:*)"], ask: ["bash(git push:*)", "Read(secrets/*)"] }, known), []);
  const problems = ruleProblems({ deny: ["Bassh(rm:*)", "Bash(git push"], ask: ["Bash()", "Bash(:*)"] }, known);
  assert.equal(problems.length, 4, problems.join("\n"));
  assert.match(problems[0], /Bassh 不存在/);
  assert.match(problems[1], /写法/);
  // 已经在配置里的规则不拦（设置页不编辑 allow，旧规则挡住保存就改不动了）
  const keep: PermissionRules = { allow: ["Bassh(x)"], deny: [], ask: [] };
  assert.deepEqual(ruleProblems({ allow: ["Bassh(x)"], deny: ["Bash(rm -rf:*)"] }, known, keep), []);
});
