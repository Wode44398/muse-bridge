// P6（X17、N16；#49）：拒绝与路径规则绑定到资源，不绑定到工具名。改写自探针 04-codex/笔记/probe-deny-bypass.ts。
// 修前：用户拒了 Edit，下一步 `printf … > src/a.ts` 照写，全程只出一张卡；无人值守时一张卡都没有、文件照样被改；
// 拒绝文案从不说「别换条路」，无人值守那句的注释甚至是「so the model can route around it」。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentState } from "./agent/state.ts";
import { DeniedTargets, REPEAT_DENIAL_RULE, decide, type PermissionRules } from "./agent/permissions.ts";
import { Sandbox } from "./sandbox.ts";
import { createSession, dropSession, resolvePermission, startRun, watchSession } from "./session.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool } from "./tools/edit.ts";
import { writeTool } from "./tools/write.ts";
import { toolMap } from "./tools/registry.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";
import { drive, loopState, markRead } from "./test-harness/trajectory.ts";

const TOOLS = [editTool, writeTool, bashTool];
const tools = toolMap();
const rules = (r: Partial<PermissionRules>): PermissionRules => ({ allow: r.allow ?? [], deny: r.deny ?? [], ask: r.ask ?? [] });
const results = (state: { messages: { role: string; content: { t: string; content?: { t: string; text?: string }[] }[] }[] }) =>
  state.messages
    .flatMap((m) => m.content)
    .filter((b) => b.t === "tool_result")
    .map((b) => (b.content ?? []).map((c) => c.text ?? "").join(""))
    .join("\n");

function scenario(t: import("node:test").TestContext, steps: ReturnType<typeof calls>[], ruleSet: PermissionRules, answer?: (n: number) => "deny" | "once") {
  const adapter = scripted(t).next(...steps, say("改好了"));
  let cards = 0;
  const cardRules: (string | undefined)[] = [];
  const { state, root } = loopState(t, adapter, {
    tools: TOOLS,
    user: "把 v 改成 2",
    permissionRules: ruleSet,
    ctx: {
      limits: { bashTimeoutMs: 20_000, bashMaxTimeoutMs: 20_000 },
      ...(answer
        ? {
            requestPermission: async (req: { rule?: string }) => {
              cards++;
              cardRules.push(req.rule);
              return { decision: answer(cards) };
            },
          }
        : {}),
    },
  });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 1;\n");
  state.ctx.readFileState.set(path.join(root, "src", "a.ts"), { mtimeMs: fs.statSync(path.join(root, "src", "a.ts")).mtimeMs } as never);
  return { adapter, state, root, cards: () => cards, cardRules, file: () => fs.readFileSync(path.join(root, "src", "a.ts"), "utf8").trim() };
}

const editCall = calls(call("e1", "Edit", { path: "src/a.ts", old_string: "v = 1", new_string: "v = 2" }));
const bashWrite = calls(call("b1", "Bash", { command: "printf 'export const v = 2;\\n' > src/a.ts" }));

test("#49: after the user declines an Edit, writing the same file through Bash asks again — and the text says not to route around", async (t) => {
  // 路径规则（Edit(src/**)、Write(src/**)）本身就管 Bash 的写目标
  const s = scenario(t, [editCall, bashWrite], rules({ ask: ["Edit(src/**)", "Write(src/**)"] }), () => "deny");
  await drive(s.state, s.adapter);
  assert.equal(s.cards(), 2, "修前只出 1 张卡，Bash 那次直接写了");
  assert.equal(s.file(), "export const v = 1;", "文件没被改");
  assert.match(results(s.state), /user declined this call\. Do not try to achieve the same effect with another tool or command/);
});

test("#49: a declined target stays declined for the run even without a path rule — Bash that names it asks again (the ledger)", async (t) => {
  // 只有裸的 ask: Edit（没有路径模式），Bash 写 src/a.ts 靠的是本 run 的拒绝台账；解释器里提到路径也算碰
  const python = calls(call("b2", "Bash", { command: "python -c \"open('src/a.ts','w').write('x')\"" }));
  const s = scenario(t, [editCall, bashWrite, python], rules({ ask: ["Edit"] }), () => "deny");
  await drive(s.state, s.adapter);
  assert.equal(s.cards(), 3);
  assert.deepEqual(s.cardRules, ["Edit", REPEAT_DENIAL_RULE, REPEAT_DENIAL_RULE]);
  assert.equal(s.file(), "export const v = 1;");
  // 读同一个文件不算碰（拒的是写）
  const ledger = new DeniedTargets();
  ledger.record("Edit", { path: "src/a.ts" }, null, s.root);
  const view = (command: string) => bashTool.permissionView!({ command });
  assert.equal(ledger.touched("Bash", { command: "cat src/a.ts" }, view("cat src/a.ts"), s.root), undefined);
  assert.equal(ledger.touched("Read", { path: "./src/a.ts" }, null, s.root), undefined);
  assert.equal(ledger.touched("Write", { path: "./src/a.ts" }, null, s.root), "src/a.ts", "写法不同也是同一个文件");
  // 用户后来又允许了：放掉
  ledger.release("Write", { path: "src/a.ts" }, null, s.root);
  assert.equal(ledger.touched("Write", { path: "src/a.ts" }, null, s.root), undefined);
});

test("#49: with nobody attending, the Bash detour is refused too, and the text no longer invites routing around", async (t) => {
  const s = scenario(t, [editCall, bashWrite], rules({ ask: ["Edit(src/**)", "Write(src/**)"] }));
  await drive(s.state, s.adapter);
  assert.equal(s.file(), "export const v = 1;", "修前无人值守时 Bash 照写");
  const text = results(s.state);
  assert.match(text, /no user is attached to approve it, so it was not approved\. Do not try to achieve the same effect/);
  assert.doesNotMatch(text, /route around|find another way/);
});

test("P6: Edit/Write path rules also govern what a Bash command writes, in any spelling of the path", () => {
  const root = path.resolve("/p6-ws");
  const bash = (command: string, r: PermissionRules) => decide("auto", "Bash", tools, { command }, r, { root }).effect;
  const noSrc = rules({ deny: ["Edit(src/**)"] });
  for (const command of [
    "echo x > src/a.ts",
    "echo x > ./src/a.ts",
    `echo x > ${path.join(root, "src", "a.ts").replace(/\\/g, "/")}`,
    "cp a.txt src/",
    "mv src/a.ts b.ts",
    "sed -i 's/a/b/' src/a.ts",
    "tee -a src/log.txt",
    "git checkout -- src/a.ts",
    "rm -rf src/old",
  ]) {
    assert.equal(bash(command, noSrc), "deny", command);
  }
  for (const command of ["cat src/a.ts", "grep -rn x src", "cp src/a.ts b.ts", "npm test", "echo src/a.ts"]) {
    assert.equal(bash(command, noSrc), "allow", command);
  }
  assert.equal(bash("echo x > yarn.lock", rules({ ask: ["Write(*.lock)"] })), "ask");
  // 拆不全的命令说不准写了哪里：有路径规则时转问，没有就照旧
  assert.equal(bash("echo 'unterminated > src/a.ts", rules({ ask: ["Edit(src/**)"] })), "ask");
  assert.equal(bash("echo 'unterminated > src/a.ts", rules({})), "allow");
});

test("P6: three actions in a row not approved — the run stops trying and wraps up", async (t) => {
  const edits = [1, 2, 3].map((n) => calls(call(`e${n}`, "Edit", { path: `src/f${n}.ts`, old_string: "a", new_string: "b" })));
  // always：修前没有收尾，模型会被再调一次——给它一个答复让测试快速失败，而不是等重试耗尽
  const adapter = scripted(t).next(...edits, calls(call("b9", "Bash", { command: "echo sneaky" }))).always(say("收尾"));
  const { state } = loopState(t, adapter, {
    tools: TOOLS,
    user: "改三个文件",
    permissionRules: rules({ ask: ["Edit"] }),
    ctx: { requestPermission: async () => ({ decision: "deny" as const }) },
  });
  markRead(state.ctx, ["src/f1.ts", "src/f2.ts", "src/f3.ts"]); // P11：没 Read 过的 Edit 在弹卡之前就被否决
  await drive(state, adapter);
  assert.equal(state.denialsStopped, true);
  const last = adapter.inputs[adapter.inputs.length - 1];
  assert.match(JSON.stringify(last.messages.at(-1)), /\[Permissions\] 3 actions in a row were not approved/);
  assert.match(results(state), /Not executed: 3 actions in a row were not approved/, "收尾轮里再调工具不执行");
});

test("P6: 拒绝并停止 declines the call and stops the run at once — the model gets no further turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-p6-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.ts"), "a\n");
  // 只有一步；修前没停下，模型会被再调——always 给它个答复让断言快速失败（inputs 只该有 1 次）
  const adapter = scripted(t).next(calls(call("e1", "Edit", { path: "a.ts", old_string: "a", new_string: "b" }))).always(say("继续"));
  const session = createSession();
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: [editTool.def],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map([["Edit", editTool]]),
    permissionMode: "auto",
    permissionRules: { allow: [], deny: [], ask: ["Edit"] },
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
  markRead(session.state.ctx, ["a.ts"], "a\n"); // P11：没 Read 过的 Edit 在弹卡之前就被否决
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "改一下");
  watchSession(session, (ev) => {
    events.push(ev);
    if (ev.e === "permission_ask") resolvePermission(session, String(ev.id), "deny_stop");
  });
  await run.done;
  assert.deepEqual(events.filter((e) => e.e === "permission_resolved").map((e) => e.decision), ["deny_stop"]);
  assert.equal(adapter.inputs.length, 1, "停下之后模型没再被调");
  assert.match(results(session.state), /user declined this call and stopped the run/);
  assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "a\n");
  dropSession(session.id);
});
