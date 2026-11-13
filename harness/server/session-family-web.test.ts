// 会话协作的前端纯逻辑（web/src/lib/session-family.ts）：信封解析与服务端拼法对得上、侧栏缩进、工具行目标。
import assert from "node:assert/strict";
import test from "node:test";
import { composeInbox } from "./session-family.ts";
import { briefSections, nestSessions, parseSessionText, toolSessionTarget, type FamilyState } from "../web/src/lib/session-family.ts";

test("信封：服务端 composeInbox 拼的消息 + 汇报，前端拆得回来；session-hint 不显示", () => {
  const { text } = composeInbox([
    { kind: "message", from: "aaaaaaaa-1", fromAgent: "claude", name: "rev", title: 'Review "x"', relation: "child", text: "Done, see **notes**.", at: 1 },
    { kind: "note", from: "bbbbbbbb-2", name: "c2", title: "Child two", status: "failed", text: "Broke at step 3", at: 2 },
  ]);
  const { parts, rest } = parseSessionText(text);
  assert.equal(rest, "", "提示只给模型");
  assert.deepEqual(parts[0], { kind: "message", from: "aaaaaaaa-1", agent: "claude", name: "rev", title: "Review 'x'", relation: "child", brief: false, body: "Done, see **notes**." });
  assert.equal(parts[1].kind, "event");
  assert.deepEqual(parts[1].kind === "event" ? parts[1].notes : [], [{ from: "bbbbbbbb-2", agent: "dimensio", name: "c2", title: "Child two", status: "failed", text: "Broke at step 3" }]);
  assert.deepEqual(briefSections("【背景】\nwhy\n\n【任务】\nwhat"), [{ label: "背景", text: "why" }, { label: "任务", text: "what" }]);
});

test("侧栏：子会话紧跟父会话、缩进；父会话不在这一组的照常顶层；Claude 子会话补一行", () => {
  const fam: FamilyState = {
    links: {
      c1: { parent: "p", title: "c1", name: "c1", at: 2 },
      c0: { parent: "p", title: "c0", name: "c0", at: 1 },
      g1: { parent: "c1", title: "g1", name: "g1", at: 3 },
      away: { parent: "elsewhere", title: "away", name: "away", at: 4 },
      cl: { parent: "p", title: "Claude kid", name: "cl", at: 5, agent: "claude" },
    },
    inbox: {},
    working: ["cl"],
  };
  const rows = ["g1", "c1", "away", "p", "c0", "x"].map((id) => ({ id }));
  const out = nestSessions(rows, fam).map((r) => `${"·".repeat(r.depth)}${r.s ? r.s.id : `claude:${r.foreign.id}${r.foreign.working ? "*" : ""}`}`);
  assert.deepEqual(out, ["away", "p", "·c0", "·c1", "··g1", "·claude:cl*", "x"]);
});

test("工具行：StartSession 链开出来的会话；SendMessage 按 to（name / parent / id）认", () => {
  const fam: FamilyState = { links: { kid: { parent: "me", title: "Kid", name: "kid-name" }, me: { parent: "boss", title: "Me", name: "me", parentAgent: "claude" } }, inbox: {}, working: [] };
  assert.deepEqual(toolSessionTarget({ name: "StartSession", family: { child: "kid", title: "Kid", agent: "dimensio" } }, "me", fam), { id: "kid", agent: "dimensio", title: "Kid" });
  assert.deepEqual(toolSessionTarget({ name: "SendMessage", args: { to: "kid-name" } }, "me", fam), { id: "kid", agent: "dimensio", title: "Kid" });
  assert.equal(toolSessionTarget({ name: "SendMessage", args: { to: "parent" } }, "me", fam)?.agent, "claude");
  assert.equal(toolSessionTarget({ name: "Read", args: { path: "x" } }, "me", fam), null);
  assert.equal(toolSessionTarget({ name: "SendMessage", args: { to: "nobody" } }, "me", fam), null);
});
