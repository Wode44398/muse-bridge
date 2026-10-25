// 10-10：MiMo 正文停在「……重来一遍，逐」、没发工具调用，provider 却报正常结束——修前这一轮当答完收尾（待办还挂着
// in_progress），用户看到「干一半断了」。修后：断在半句就追一句接着干（每条用户消息最多两次，追问不进聊天记录）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { CUTOFF_NUDGE, looksCutOff, MAX_CUTOFF_NUDGES } from "./agent/loop.ts";
import { visibleMessages } from "./agent/state.ts";
import { injectionKind } from "./agent/injections.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { todoTool } from "./tools/todo.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
const tmp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
// 夹具默认不带 TodoWrite：挂上，并把 setTodos 接到 state（生产由 session.buildState 接）
function todoSession(adapter: Parameters<typeof attachSession>[0], prefix: string) {
  const session = attachSession(adapter, tmp(prefix), { tools: [todoTool] });
  session.state!.ctx.setTodos = (items) => { session.state!.todos = items; };
  return session;
}
const CUT = "弹窗被 Escape 关掉了。我改用浏览器原生 CDP 输入（type/key）重来一遍，逐";
// 待办还挂着没做完（10-10 那次就是 in_progress）
const openTodos = useTool("todo-1", "TodoWrite", { todos: [{ content: "创建路由规则", status: "in_progress" }] });

test("looksCutOff：待办没做完且断在半句才算，正常收尾、短答、列表、代码、英文结论都不算", () => {
  assert.equal(looksCutOff(CUT, true), true);
  assert.equal(looksCutOff(CUT, false), false, "没有未完成的待办就不判");
  assert.equal(looksCutOff("接下来这样做：", false), false, "没有未完成的待办就不判");
  assert.equal(looksCutOff("接下来这样做：", true), true);
  assert.equal(looksCutOff("Then I will,", true), true);
  assert.equal(looksCutOff("已经搞定了。", true), false);
  assert.equal(looksCutOff("改好了，见下：\n- 第一项\n- 第二项", true), false);
  assert.equal(looksCutOff("## 总结", true), false);
  assert.equal(looksCutOff("| 列 | 值 |", true), false);
  assert.equal(looksCutOff("```\nconst a = 1\n```", true), false);
  assert.equal(looksCutOff("All tests pass", true), false);
  assert.equal(looksCutOff("The dialog closed. Now I will reopen it and fill it step by", true), true, "待办没做完时拉丁字母结尾也算");
  assert.equal(looksCutOff("做完了", true), false, "待办没勾完也可能只是一句不带句号的短答");
  assert.equal(looksCutOff("", true), false);
  assert.equal(injectionKind(CUTOFF_NUDGE), "cutoff-continue");
});

test("断在半句：追一句接着干，后续答复交付；追问不进聊天记录", async (t) => {
  const adapter = scripted(t).next(openTodos, say(CUT), say("逐步验证每一步后保存。规则已创建完成。"));
  const session = todoSession(adapter, "dimensio-cutoff-");
  await send(session, "帮我建一条路由规则");
  const msgs = session.state!.messages;
  const nudges = msgs.filter((m) => m.role === "user" && m.origin === "harness" && m.kind === "cutoff-continue");
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].internal, true);
  assert.ok(!visibleMessages(msgs).some((m) => m.kind === "cutoff-continue"), "追问不进聊天记录");
  assert.equal(adapter.callCount, 3);
});

test("一直断：追满次数就照旧收尾，不空转；正常答复不追问", async (t) => {
  const adapter = scripted(t).next(openTodos, ...Array.from({ length: MAX_CUTOFF_NUDGES + 1 }, () => say(CUT)), say("好的。"));
  const session = todoSession(adapter, "dimensio-cutoff-cap-");
  await send(session, "第一问");
  assert.equal(adapter.callCount, MAX_CUTOFF_NUDGES + 2);
  await send(session, "第二问");
  assert.equal(adapter.callCount, MAX_CUTOFF_NUDGES + 3, "完整答复不追问");
});
