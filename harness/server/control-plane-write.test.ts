// S12（N28、HT8）：控制面文件写保护。
//
// 修前：auto 档下 agent 可以随手改工作区的 GUIDE.md（它写进之后每个会话的 system prompt，而且「the guide wins」）、
// 全局 GUIDE（所有新会话）、运行配置（权限规则就在里面）、会话记录与记忆文件——一张卡都不弹；「本会话都允许」
// 或一条 allow 规则也能把这些写入一并放行。
// 修后：这些写入每次都问、只能「允许这一次」（allow 规则、「本会话都允许」都不算数），没人在场就拒。读照常。
// 记忆目录（m 线改过）：本工作区自己的记忆目录里的笔记文件可以直接 Write / Edit、不弹卡；内部文件、别的工作区的、Bash 写都拒。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentState } from "./agent/state.ts";
import { CONTROL_PLANE_RULE, decide, type PermissionMode, type PermissionRules } from "./agent/permissions.ts";
import { configFile, globalGuideFile, memoryRoot, sessionsDir } from "./paths.ts";
import { GLOBAL_MEMORY, memoryDir } from "./memory.ts";
import { createSession, dropSession, resolvePermission, startRun, watchSession } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";
import { toolMap } from "./tools/registry.ts";
import { writeTool } from "./tools/write.ts";
import { deviceFilesTool } from "./tools/localpc.ts";

const tools = toolMap();
// 设备文件工具只在连着 bridge 时注册：权限判定按它的 permissionView 判，这里手动挂上
if (!tools.has(deviceFilesTool.def.name)) tools.set(deviceFilesTool.def.name, deviceFilesTool);
const NONE: PermissionRules = { allow: [], deny: [], ask: [] };

test("S12: GUIDE / AGENTS / CLAUDE.md, the global GUIDE, runtime config and session records need a yes every time; memory notes are plain files", () => {
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

    // 自己的记忆目录（工作区层、全局层）里的笔记：直接写，不弹卡；文件名叫 AGENTS.md 也只是一条笔记
    assert.equal(d("Write", { path: path.join(memoryDir(root), "build-notes.md"), content: "x" }).effect, "allow");
    assert.equal(d("Edit", { path: path.join(memoryDir(GLOBAL_MEMORY), "user-lang.md"), old_string: "a", new_string: "b" }).effect, "allow");
    assert.equal(d("Write", { path: path.join(memoryDir(root), "agents.md"), content: "x" }).effect, "allow");
    // 内部文件、子目录、生成的索引：拒
    for (const p of ["MEMORY.md", "usage.json", ".provenance.json", ".history/x.md", "sub/x.md"]) {
      const v = d("Write", { path: path.join(memoryDir(root), p), content: "x" });
      assert.equal(v.effect, "deny", p);
      assert.match(v.reason, /not a note file/);
    }
    // 记忆根里不属于这个工作区的（别的工作区的记忆、整理状态）：拒
    const memory = d("Write", { path: path.join(memoryRoot(), "notes.md"), content: "x" });
    assert.equal(memory.effect, "deny");
    assert.match(memory.reason, /another workspace's memory/);
    assert.equal(d("Write", { path: path.join(memoryDir(path.join(root, "..", "other-ws")), "x.md"), content: "x" }).effect, "deny");
    // Bash 写自己的记忆目录也拒（Write / Edit 会留旧版，Bash 留不了）
    const viaBash = bash(`echo x > "${path.join(memoryDir(root), "x.md")}"`);
    assert.equal(viaBash.effect, "deny");
    assert.match(viaBash.reason, /Write or Edit/);
    // 白名单：只有 Write / Edit 能直接写笔记。Terminal（同样报出写目标）、设备拉取落到记忆目录、rm 删笔记都拒
    const note = path.join(memoryDir(root), "x.md");
    for (const [tool, args] of [
      ["Terminal", { action: "run", command: `echo x > "${note}"` }],
      ["Terminal", { action: "run", command: `rm "${note}"` }],
      ["Bash", { command: `rm "${note}"` }],
      ["DeviceFiles", { action: "pull", path: "C:/remote/x.md", to: note }],
    ] as const) {
      const v = d(tool, args as Record<string, unknown>);
      assert.equal(v.effect, "deny", `${tool} ${JSON.stringify(args)}`);
      assert.match(v.reason, /Write or Edit/);
    }

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

// 8.3 短名（C: 盘默认生成）：拿不到就是 null（卷上关了短名生成、不是 Windows）
function shortName(p: string): string | null {
  if (process.platform !== "win32") return null;
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"for %I in ("${p}") do @echo %~sI"`], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  const s = r.stdout?.trim();
  return s && path.basename(s).toLowerCase() !== path.basename(p).toLowerCase() ? path.basename(s) : null;
}

test("收口：AGENTS.override.md 同样是控制面文件；8.3 短名写法、NTFS 数据流写法绕不过控制面", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-s12-short-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const d = (args: Record<string, unknown>, mode: PermissionMode = "auto") => decide(mode, "Write", tools, args, NONE, { root });
  for (const p of ["AGENTS.override.md", "sub/AGENTS.override.md", "sub/agents.OVERRIDE.md"]) assert.equal(d({ path: p, content: "x" }).effect, "ask", p);

  // NTFS 备用数据流：文件工具在沙箱这一层就拒（bypass 也一样）
  if (process.platform === "win32") {
    for (const access of ["workspace", "bypass"] as const) {
      assert.throws(() => new Sandbox(root, access).resolve(".claude/settings.json::$DATA", { forWrite: true }), /NTFS data stream/, access);
      assert.throws(() => new Sandbox(root, access).resolve("notes.md:hidden"), /NTFS data stream/, access);
    }
    const plain = path.join(root, "y.md");
    assert.equal(new Sandbox(root).resolve(plain, { forWrite: true }), plain, "盘符本身的冒号不算");
  }

  fs.mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), "{}");
  const shortDir = shortName(path.join(root, ".claude"));
  if (!shortDir) {
    t.skip("这个卷上没有 8.3 短名");
    return;
  }
  assert.equal(d({ path: `${shortDir}/agents/x.md`, content: "x" }).effect, "ask", "自定义 agent 定义");
  assert.equal(d({ path: `${shortDir}/settings.local.json`, content: "{}" }).effect, "ask", "hooks 配置");
  assert.equal(d({ path: `${shortDir}/hooks/fmt.sh`, content: "x" }).effect, "ask", "hook 脚本");
  // bypass 档也不放过 hooks 配置
  const bypass = d({ path: `${shortDir}/settings.local.json`, content: "{}" }, "bypass");
  assert.equal(bypass.effect, "ask");
  assert.equal(bypass.rule, CONTROL_PLANE_RULE);
  // 短名写法的指令文件
  fs.writeFileSync(path.join(root, "AGENTS.override.md"), "x");
  const shortDoc = shortName(path.join(root, "AGENTS.override.md"));
  if (shortDoc) assert.equal(d({ path: shortDoc, content: "x" }).effect, "ask", shortDoc);
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
