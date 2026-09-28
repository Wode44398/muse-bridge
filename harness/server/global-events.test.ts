// P8（K30、K35、X34）：全局事件通道 +「等你」旗标 + 通知策略。修前：没有全局通道，侧栏只能轮询整张列表；
// 页面只在「不是前台会话」时弹应用内提示——锁屏、切到别的 App 时什么都不发，前台会话撞上提问也不发。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentState } from "./agent/state.ts";
import { createSession, dropSession, pendingSummary, resolvePermission, startRun, watchGlobal } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";
import { markRead } from "./test-harness/trajectory.ts";
import { editTool } from "./tools/edit.ts";
import { applySnapshot, noticeFor, type NotifyState, type StatusEvent } from "../web/src/lib/notify-policy.ts";

test("P8: each status change goes out once on the global channel — start, a card appearing, the card settling, the end — with no command or path in it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-p8-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "secret-plan.ts"), "a\n");
  // 卡片由下面的 watcher 当场落定；万一通道没发（修前），P7 的倒计时 1.2 秒后兜底，测试快速失败而不是挂 10 分钟
  const prevScale = process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE;
  process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE = "0.002";
  t.after(() => {
    if (prevScale === undefined) delete process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE;
    else process.env.DIMENSIO_INTERACTION_TIMEOUT_SCALE = prevScale;
  });
  const adapter = scripted(t).next(calls(call("e1", "Edit", { path: "secret-plan.ts", old_string: "a", new_string: "b" })), say("done"));
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
  markRead(session.state.ctx, ["secret-plan.ts"]); // P11：没 Read 过的 Edit 在弹卡之前就被否决
  const mine: Record<string, unknown>[] = [];
  let summaryWhileWaiting: ReturnType<typeof pendingSummary> | null = null;
  const off = watchGlobal((ev) => {
    if (ev.id !== session.id) return;
    mine.push(ev);
    const waiting = ev.waiting as { id: string } | null;
    if (waiting) {
      summaryWhileWaiting = pendingSummary();
      resolvePermission(session, waiting.id, "deny");
    }
  });
  t.after(off);
  await startRun(session, "把计划里的 a 改成 b").done;

  assert.deepEqual(
    mine.map((e) => `${e.running ? "running" : "idle"}:${(e.waiting as { kind: string } | null)?.kind ?? "-"}`),
    ["running:-", "running:permission", "running:-", "idle:-"],
    "每次变化恰好一条，没有重复",
  );
  const row = summaryWhileWaiting!.sessions.find((s) => s.id === session.id);
  assert.equal(row?.waiting?.kind, "permission");
  assert.equal(row?.waiting?.tool, "Edit");
  assert.ok(!JSON.stringify(mine).includes("secret-plan"), "全局通道不带路径 / 命令");
  assert.ok(!JSON.stringify(summaryWhileWaiting).includes("secret-plan"));
  assert.equal(pendingSummary().sessions.some((s) => s.id === session.id), false, "收尾后不在摘要里");
  dropSession(session.id);
});

test("P8: notify only for waits that are new, only when nobody is looking — the connect snapshot is a baseline; a finished run notifies when hidden", () => {
  const state: NotifyState = { notified: new Set(), wasRunning: new Map() };
  const status = (id: string, running: boolean, waiting: StatusEvent["waiting"] = null): StatusEvent => ({ id, title: "修登录页", running, waiting });
  const view = (over: Partial<{ hidden: boolean; foregroundId: string | null; residentIds: Set<string> }> = {}) => ({
    hidden: false,
    foregroundId: null,
    residentIds: new Set<string>(),
    ...over,
  });
  // 连上时已经在等的：只作基线，不补发
  applySnapshot(state, [status("s0", true, { kind: "ask", id: "old" })]);
  assert.equal(noticeFor(state, status("s0", true, { kind: "ask", id: "old" }), view({ hidden: true })), null);

  // 锁屏时新出现的等待 → 系统通知；正文是终态事实（带工具名，不带命令）
  const locked = noticeFor(state, status("s1", true, { kind: "permission", id: "c1", tool: "Bash" }), view({ hidden: true }));
  assert.deepEqual(locked, { system: { title: "dimensio · 在等你批准", text: "「修登录页」在等你批准（Bash）" } });
  // 同一张卡不发第二次
  assert.equal(noticeFor(state, status("s1", true, { kind: "permission", id: "c1", tool: "Bash" }), view({ hidden: true })), null);
  // 正看着这个会话：不发（修前前台会话撞上提问什么都不发，现在是有意不发——卡片就在眼前）
  assert.equal(noticeFor(state, status("s2", true, { kind: "ask", id: "c2" }), view({ foregroundId: "s2" })), null);
  // 页面可见、看的是别的会话、这个会话没挂直播 → 应用内提示
  assert.deepEqual(noticeFor(state, status("s3", true, { kind: "plan", id: "c3" }), view({ foregroundId: "s2" })), {
    toast: "「修登录页」提交了计划，等你审",
  });
  // 挂着直播的后台会话：归约器自己会提示，这里不重复
  assert.equal(noticeFor(state, status("s4", true, { kind: "ask", id: "c4" }), view({ residentIds: new Set(["s4"]) })), null);
  // 跑完：锁屏时系统通知
  noticeFor(state, status("s5", true), view());
  assert.deepEqual(noticeFor(state, status("s5", false), view({ hidden: true })), {
    system: { title: "dimensio · 完成", text: "「修登录页」这一轮跑完了" },
  });
});
