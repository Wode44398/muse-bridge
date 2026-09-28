// S12（N28、HT8）：控制面文件写保护。
//
// 修前：auto 档下 agent 可以随手改工作区的 GUIDE.md（它写进之后每个会话的 system prompt，而且「the guide wins」）、
// 全局 GUIDE（所有新会话）、运行配置（权限规则就在里面）、会话记录与记忆文件——一张卡都不弹；「本会话都允许」
// 或一条 allow 规则也能把这些写入一并放行。
// 修后：这些写入每次都问、只能「允许这一次」（allow 规则、「本会话都允许」都不算数），没人在场就拒；记忆目录直接拒，
// 指向 Remember。读照常。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentState } from "./agent/state.ts";
import { CONTROL_PLANE_RULE, decide, type PermissionMode, type PermissionRules } from "./agent/permissions.ts";
import { configFile, globalGuideFile, memoryRoot, sessionsDir } from "./paths.ts";
import { createSession, dropSession, resolvePermission, startRun, watchSession } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";
import { toolMap } from "./tools/registry.ts";
import { writeTool } from "./tools/write.ts";

const tools = toolMap();
const NONE: PermissionRules = { allow: [], deny: [], ask: [] };

test("S12: GUIDE / AGENTS / CLAUDE.md, the global GUIDE, runtime config and session records need a yes every time; memory is Remember-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-s12-"));
  try {
    const d = (tool: string, args: Record<string, unknown>, rules = NONE, mode: PermissionMode = "auto") =>
      decide(mode, tool, tools, args, rules, { root });
    const bash = (command: string) => d("Bash", { command });

    const guide = d("Write", { path: "GUIDE.md", content: "x" });
    assert.equal(guide.effect, "ask");
    assert.equal(guide.rule, CONTROL_PLANE_RULE);
    assert.equal(guide.noSession, true, "只能允许这一次");
    // 用户的 allow 规则、之前记下的「本会话都允许」都不算数
    assert.equal(d("Write", { path: "GUIDE.md", content: "x" }, { allow: ["Write", "Write(=GUIDE.md)"], deny: [], ask: [] }).effect, "ask");
    assert.equal(d("Edit", { path: "docs/AGENTS.md", old_string: "a", new_string: "b" }).effect, "ask", "按文件名，哪一层都算");
    assert.equal(d("Write", { path: "sub/Claude.MD", content: "x" }).effect, "ask", "不分大小写");
    assert.equal(d("Write", { path: configFile(), content: "{}" }).noSession, true, "运行配置（权限规则在里面）");
    assert.equal(d("Write", { path: globalGuideFile(), content: "x" }).effect, "ask", "全局 GUIDE");
    assert.equal(d("Write", { path: path.join(sessionsDir(), "x.json"), content: "{}" }).effect, "ask", "会话记录");

    const memory = d("Write", { path: path.join(memoryRoot(), "notes.md"), content: "x" });
    assert.equal(memory.effect, "deny");
    assert.match(memory.reason, /Remember/);

    // Bash 的写目标同样算（防御纵深）；读照常
    assert.equal(bash("echo more >> GUIDE.md").effect, "ask");
    assert.equal(bash("sed -i 's/a/b/' AGENTS.md").effect, "ask");
    assert.equal(bash(`cp notes.md "${path.join(memoryRoot(), "x.md")}"`).effect, "deny");
    assert.equal(bash("cat GUIDE.md").effect, "allow");
    assert.equal(d("Read", { path: "GUIDE.md" }).effect, "allow");

    // 普通文件不受影响
    assert.equal(d("Write", { path: "src/guide.ts", content: "x" }).effect, "allow");
    assert.equal(d("Write", { path: "README.md", content: "x" }).effect, "allow");
    // 用户的 deny 规则与只读档照样优先
    assert.equal(d("Write", { path: "GUIDE.md", content: "x" }, { allow: [], deny: ["Write"], ask: [] }).effect, "deny");
    assert.equal(d("Write", { path: "GUIDE.md", content: "x" }, NONE, "plan").effect, "deny");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("S12: the card offers only 允许一次 — a 本会话都允许 answer counts as once, records nothing, and the next write asks again", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-s12-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = scripted(t)
    .next(
      calls(call("w1", "Write", { path: "GUIDE.md", content: "# guide v1\n" })),
      calls(call("w2", "Write", { path: "GUIDE.md", content: "# guide v2\n" })),
      say("done"),
    )
    .always(say("done"));
  const session = createSession();
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: [writeTool.def],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 20_000, bashMaxTimeoutMs: 20_000 }, agentSeesImages: false },
    toolMap: new Map([["Write", writeTool]]),
    permissionMode: "auto",
    permissionRules: NONE,
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "改两遍 GUIDE");
  watchSession(session, (ev) => {
    events.push(ev);
    // 哪怕客户端（旧版、或被改过）回传「本会话都允许」
    if (ev.e === "permission_ask") resolvePermission(session, String(ev.id), "session");
  });
  await run.done;

  const asks = events.filter((e) => e.e === "permission_ask");
  assert.equal(asks.length, 2, "第二次写同一个文件照样要问");
  for (const a of asks) {
    assert.equal(a.noSession, true);
    assert.deepEqual(a.sessionRules, []);
    assert.equal(a.prefixRules, undefined);
    assert.equal(a.rule, CONTROL_PLANE_RULE);
  }
  assert.deepEqual(events.filter((e) => e.e === "permission_resolved").map((e) => e.decision), ["once", "once"]);
  assert.deepEqual(session.cfg?.sessionAllow ?? [], [], "什么规则都没记");
  assert.equal(fs.readFileSync(path.join(root, "GUIDE.md"), "utf8"), "# guide v2\n", "批了的那两次照常写进去");
  dropSession(session.id);
});
