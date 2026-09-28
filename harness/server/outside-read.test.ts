// P13（X18；Codex「被沙箱拒了 → 问要不要放行 → 重跑」）：越界按单条调用审批 + 会话里的只读目录可增删。
//
// 修前：仅工作空间模式下读一下工作区外的东西（Read、ls / cat 这类纯读命令）就被拒，出路只有两条——整个项目切「整机」，
// 或者改环境变量 DIMENSIO_READONLY_PATHS（手机上改不了、要重启）。真实使用的 25 个会话里越界被拒 13 次、落在 5 个会话里，
// 另有 8 个会话已经整个切成了整机。
// 修后：只因为「读了工作区外」被拒、且有人在场时弹一张卡：允许这一次（带放行重跑这一次）/ 本会话把这个目录设为只读
// （记进会话、落盘，之后同目录的读不再问）/ 拒绝（原失败照旧，附一句）。写、凭据、非纯读命令永远不问；没人在场照旧失败。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgent } from "./agent/loop.ts";
import type { Block, Msg } from "./agent/turn.ts";
import { resolvePermission, revokeReadRoot, sessionRecord, startRun, watchSession } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { bashTool, outsideReadDirs } from "./tools/bash.ts";
import { readTool } from "./tools/read.ts";

function dirs(t: import("node:test").TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-p13-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  const other = path.join(base, "other");
  for (const d of [ws, outside, other]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(outside, "notes.txt"), "外面的笔记\n");
  fs.writeFileSync(path.join(other, "b.txt"), "另一个目录\n");
  fs.writeFileSync(path.join(outside, ".env"), "TOKEN=DUMMY-p13\n");
  return { ws, outside, other };
}
const textOf = (blocks: Block[]): string => blocks.map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? textOf(b.content) : "")).join("");
function resultOf(msgs: Msg[], id: string): { ok: boolean; text: string } {
  for (const m of msgs) for (const b of m.content) if (b.t === "tool_result" && b.id === id) return { ok: b.ok !== false, text: textOf(b.content) };
  assert.fail(`没有 ${id} 的结果`);
}
const fwd = (p: string) => p.replace(/\\/g, "/");
// 起一轮并按 answer 落定这一轮的权限卡（观察者只活到这一轮结束，每轮都要重新挂）
async function runAnswering(
  session: ReturnType<typeof attachSession>,
  text: string,
  answer: (ev: Record<string, unknown>) => void,
  afterStart?: () => void,
): Promise<void> {
  const run = startRun(session, text);
  afterStart?.();
  watchSession(session, answer);
  await run.done;
}

test("P13 读工作区外：有人在场就弹卡；「允许这一次」带放行重跑、不记下，下次还问", async (t) => {
  const { ws, outside } = dirs(t);
  const file = path.join(outside, "notes.txt");
  const adapter = scripted(t).next(calls(call("r1", "Read", { path: file })), say("读到了"), calls(call("r2", "Read", { path: file })), say("又读了一次"));
  const session = attachSession(adapter, ws, { tools: [readTool] });
  const asks: Record<string, unknown>[] = [];
  const once = (ev: Record<string, unknown>) => {
    if (ev.e !== "permission_ask") return;
    asks.push(ev);
    resolvePermission(session, String(ev.id), "once");
  };
  await runAnswering(session, "看看外面那份笔记", once);
  assert.equal(asks.length, 1);
  assert.match(JSON.stringify(asks[0]), /要读工作区外的目录/);
  assert.ok(JSON.stringify(asks[0]).includes(JSON.stringify(outside).slice(1, -1)), "卡上写着要放行的目录");
  const r1 = resultOf(session.state!.messages, "r1");
  assert.ok(r1.ok, r1.text);
  assert.match(r1.text, /外面的笔记/);
  assert.deepEqual(session.state!.readRoots, [], "允许这一次不记下");
  await runAnswering(session, "再看一次", once);
  assert.equal(asks.length, 2, "下次还问");
  assert.ok(resultOf(session.state!.messages, "r2").ok);
});

test("P13「本会话都允许」：目录记进会话并落盘，之后同目录的读（Read、纯读命令）不再问；写与凭据照旧拦、不弹卡；能撤回", async (t) => {
  const { ws, outside } = dirs(t);
  const adapter = scripted(t).next(
    calls(call("r1", "Read", { path: path.join(outside, "notes.txt") })),
    say("记下了"),
    calls(
      call("b1", "Bash", { command: `cat "${fwd(path.join(outside, "notes.txt"))}"` }),
      call("b2", "Bash", { command: `echo x > "${fwd(path.join(outside, "y.txt"))}"` }),
      call("r2", "Read", { path: path.join(outside, ".env") }),
    ),
    say("好"),
  );
  const session = attachSession(adapter, ws, { tools: [readTool, bashTool] });
  const asks: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const allowSession = (ev: Record<string, unknown>) => {
    events.push(ev);
    if (ev.e !== "permission_ask") return;
    asks.push(ev);
    resolvePermission(session, String(ev.id), "session");
  };
  await runAnswering(session, "读外面的笔记", allowSession);
  assert.deepEqual(session.state!.readRoots, [outside]);
  assert.deepEqual(sessionRecord(session)!.config.readRoots, [outside], "随会话落盘");
  assert.ok(events.some((ev) => ev.e === "read_roots"), "广播给附着的设备");

  await runAnswering(session, "接着来", allowSession);
  assert.equal(asks.length, 1, "同目录的读不再问；写和凭据也不弹卡");
  const msgs = session.state!.messages;
  const b1 = resultOf(msgs, "b1");
  assert.ok(b1.ok, b1.text);
  assert.match(b1.text, /外面的笔记/);
  assert.equal(resultOf(msgs, "b2").ok, false, "往那个目录写照旧拦");
  const secret = resultOf(msgs, "r2");
  assert.equal(secret.ok, false);
  assert.match(secret.text, /secret guard|credential/i, "凭据永远不放行");

  assert.deepEqual(revokeReadRoot(session, outside), [], "档位菜单里点 × 收回");
  assert.deepEqual(sessionRecord(session)!.config.readRoots, []);
});

test("P13 拒绝 / 离开模式：原失败照旧、附一句；没人在场（子 agent、无头）直接失败、不弹卡", async (t) => {
  const { ws, outside } = dirs(t);
  const file = path.join(outside, "notes.txt");
  const adapter = scripted(t).next(calls(call("r1", "Read", { path: file })), say("好吧"), calls(call("r2", "Read", { path: file })), say("好吧"));
  const session = attachSession(adapter, ws, { tools: [readTool] });
  const deny = (ev: Record<string, unknown>) => {
    if (ev.e === "permission_ask") resolvePermission(session, String(ev.id), "deny", "别看那个");
  };
  await runAnswering(session, "看一下", deny);
  const denied = resultOf(session.state!.messages, "r1");
  assert.equal(denied.ok, false);
  assert.match(denied.text, /Asked the user to allow reading .* not allowed — the user declined: 别看那个/s);

  // 离开模式（发新消息会自动关——这里在开跑之后再打开，模拟目标续跑这类没人发消息的轮）：卡不挂住，按没批准处理
  const asked: unknown[] = [];
  await runAnswering(session, "再看一下", (ev) => ev.e === "permission_ask" && asked.push(ev), () => {
    session.cfg = { ...session.cfg!, away: true };
  });
  assert.match(resultOf(session.state!.messages, "r2").text, /not allowed — the user is away/);

  const headless = scripted(t).next(calls(call("h1", "Read", { path: file })), say("读不到"));
  const { state } = loopState(t, headless, { user: "看一下", tools: [readTool] });
  for await (const _ of runAgent(state, new AbortController().signal)) { /* 跑完 */ }
  const h = resultOf(state.messages, "h1");
  assert.equal(h.ok, false);
  assert.match(h.text, /Path escapes the sandbox/);
  assert.ok(!/Asked the user/.test(h.text), "没人在场不问");
});

test("P13 Bash 什么时候值得问：纯读命令读外面 → 给出要放行的目录（多个也列全）；非纯读、写、凭据、整机模式 → 不问", (t) => {
  const { ws, outside, other } = dirs(t);
  const a = fwd(path.join(outside, "notes.txt"));
  const b = fwd(path.join(other, "b.txt"));
  assert.deepEqual(outsideReadDirs(`cat "${a}"`, ws, "workspace"), [outside]);
  assert.deepEqual(outsideReadDirs(`cat "${a}" "${b}"`, ws, "workspace"), [outside, other]);
  assert.deepEqual(outsideReadDirs(`cat "${a}"`, ws, "workspace", [outside]), null, "已放行的不再问（命令本来就能过）");
  assert.equal(outsideReadDirs(`python "${a}"`, ws, "workspace"), null, "非纯读命令：放行了也照样被拒，不问");
  assert.equal(outsideReadDirs(`cp "${a}" "${fwd(path.join(outside, "c.txt"))}"`, ws, "workspace"), null);
  assert.equal(outsideReadDirs(`cat "${fwd(path.join(outside, ".env"))}"`, ws, "workspace"), null, "凭据不问");
  assert.equal(outsideReadDirs(`cat "${a}"`, ws, "full"), null);
});
