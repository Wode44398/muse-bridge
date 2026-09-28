// 引用会话（09-26：把侧栏的会话块拖进输入框 = 引用那个对话；规划 G9 的「#会话引用」）。
//
// 修前：没有这回事——想让模型参考另一段对话，只能手抄过来。
// 修后：发送时带上被引用会话的 id，服务端把那段对话压成一份摘要（每轮：用户的话 + 插话、这一轮最后的答复、改过的文件；
// 开头那一轮一定留、其余从最近的往前塞，塞不下的写一句省略了几轮），跟在这条消息后面给模型看，并标明是参考材料、不是新指令。
// 界面上是气泡里的芯片（消息上的 refs，随会话落盘）；被引用的对话读过外部内容时，污染标记（K9）随引用带过来。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { Msg } from "./agent/turn.ts";
import { CAPABILITIES } from "./protocol.ts";
import { dropSession, persistNow, startRun, type Session } from "./session.ts";
import { buildRefDigest, referenceDigests, type RefSource } from "./session-refs.ts";
import { loadSession } from "./store.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { itemFp } from "../web/src/lib/timeline-merge.ts";
import { MAX_SESSION_REFS, sessionRefsFrom, withSessionRef } from "../web/src/lib/session-refs.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-refs-"));
  roots.push(root);
  return root;
}
const userMsg = (text: string, extra: Partial<Msg> = {}): Msg => ({ role: "user", content: [{ t: "text", text }], displayText: text, ...extra });
const ownUserMessages = (msgs: Msg[]) => msgs.filter((m) => m.role === "user" && !m.internal && !m.origin && m.content.some((b) => b.t === "text"));
const allText = (m: Msg) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("\n");

test("引用会话 摘要：标明是参考材料不是新指令；开头那一轮一定留，插话并进本轮，改过的文件列出来；思考、工具输出、注入不进；超预算从中间省略", () => {
  const src: RefSource = {
    id: "src-1",
    title: "登录页",
    updatedAt: Date.UTC(2026, 8, 26, 6, 30),
    config: { workspace: "/work/shop-site" },
    messages: [
      userMsg("把登录页做出来"),
      { role: "assistant", content: [{ t: "thinking", text: "SECRET-THOUGHT" }, { t: "tool_call", id: "c1", name: "Write", args: { path: "src/login.tsx", content: "x" } }] },
      { role: "user", content: [{ t: "tool_result", id: "c1", ok: true, content: [{ t: "text", text: "TOOL-OUTPUT" }] }] },
      userMsg("顺便加个记住我", { origin: "steer" }),
      { role: "assistant", content: [{ t: "text", text: "登录页做好了" }] },
      { role: "user", internal: true, content: [{ t: "text", text: "INTERNAL-NUDGE" }] },
      userMsg("RECALLED-DOC", { origin: "harness", kind: "recall" }),
      userMsg("再加个忘记密码"),
      { role: "assistant", content: [{ t: "tool_call", id: "c2", name: "Edit", args: { path: "src/login.tsx", old: "a", new: "b" } }] },
      { role: "user", content: [{ t: "tool_result", id: "c2", ok: true, content: [{ t: "text", text: "ok" }] }] },
      { role: "assistant", content: [{ t: "text", text: "加好了" }] },
    ],
  };
  const d = buildRefDigest(src);
  assert.match(d, /NOT a new instruction/, "标明不是新指令");
  assert.match(d, /Title: 登录页/);
  assert.match(d, /Session: src-1 · workspace shop-site · 2 turn\(s\)/);
  assert.match(d, /Turn 1 — user: 把登录页做出来\n\(interjected\) 顺便加个记住我/, "插话并进这一轮");
  assert.match(d, /Turn 1 — assistant: 登录页做好了/);
  assert.match(d, /Turn 1 — files changed: src\/login\.tsx/);
  assert.match(d, /Turn 2 — user: 再加个忘记密码\nTurn 2 — assistant: 加好了/);
  for (const hidden of ["SECRET-THOUGHT", "TOOL-OUTPUT", "INTERNAL-NUDGE", "RECALLED-DOC"]) assert.equal(d.includes(hidden), false, `${hidden} 不进摘要`);

  // 十轮长对话、预算只够几轮：第 1 轮与最近的几轮留下，中间写省略了几轮
  const long: RefSource = { id: "src-2", title: "长对话", updatedAt: 0, messages: [] };
  for (let i = 1; i <= 10; i++) long.messages.push(userMsg(`问题${i}`), { role: "assistant", content: [{ t: "text", text: `答复${i} ${"很长的解释。".repeat(40)}` }] });
  const cut = buildRefDigest(long, 1500);
  assert.ok(cut.length <= 1500, `不超预算（${cut.length}）`);
  assert.match(cut, /Turn 1 — user: 问题1\n/, "开头那一轮一定留");
  assert.match(cut, /Turn 10 — user: 问题10\n/, "最近的一轮留下");
  assert.match(cut, /\((\d+) turn\(s\) omitted\)/, "中间省略了几轮要说");
  const omitted = Number(/\((\d+) turn\(s\) omitted\)/.exec(cut)![1]);
  const kept = (cut.match(/— user:/g) ?? []).length;
  assert.equal(omitted + kept, 10, "留下的 + 省略的 = 全部轮数");
  assert.match(buildRefDigest({ id: "e", title: "", updatedAt: 0, messages: [] }), /Title: \(untitled\)[\s\S]*\(no messages yet\)/);
});

test("引用会话 请求里的 refs：去重、去掉引用自己与不像 id 的、最多 3 个、已删的跳过；在跑的会话取内存里的", async (t) => {
  const a = attachSession(scripted(t).next(say("A 答了")), workspace());
  await send(a, "A 的问题");
  await persistNow(a);
  const b = attachSession(scripted(t).next(say("B 答了")), workspace());
  await send(b, "B 的问题");
  await persistNow(b);

  const got = await referenceDigests([a.id, a.id, "../etc/passwd", 42, "self-id", "gone-0000", b.id], { selfId: "self-id" });
  assert.deepEqual(got.map((r) => r.id), [a.id, b.id]);
  assert.equal(got[0].title, "A 的问题");
  assert.match(got[0].text, /Turn 1 — user: A 的问题\nTurn 1 — assistant: A 答了/);
  assert.equal(got[0].tainted, false);
  assert.equal((await referenceDigests(["x1", "x2", "x3", "x4", a.id])).length, 0, "最多看前 3 个（不存在的照样占名额）");

  const live = await referenceDigests([a.id], { live: (id) => (id === a.id ? { id, title: "内存里的", updatedAt: 0, messages: [userMsg("还在跑的那句")] } : null) });
  assert.equal(live[0].title, "内存里的");
  assert.match(live[0].text, /还在跑的那句/);
  dropSession(a.id);
  dropSession(b.id);
});

test("引用会话 发送：摘要跟在这条消息后面给模型看，界面文字与标题只用用户打的字；消息挂 refs 并落盘；只引用不打字也能发；被引用的读过外部内容时污染标记带过来", async (t) => {
  const src = attachSession(scripted(t).next(say("登录页做好了")), workspace());
  await send(src, "把登录页做出来");
  src.state!.externalContentSeen = true; // 它读过网页
  await persistNow(src);
  dropSession(src.id); // 从盘上读，不是内存

  const refs = await referenceDigests([src.id]);
  assert.equal(refs[0].tainted, true);
  const adapter = scripted(t).next(say("注册页也做好了"));
  const s: Session = attachSession(adapter, workspace());
  const run = startRun(s, "参考那个对话，把注册页也做了", undefined, [], undefined, { refs });
  assert.ok(run.started);
  await run.done;

  const sent = adapter.inputs[0].messages.filter((m) => m.role === "user").at(-1)!;
  const body = allText(sent);
  assert.ok(body.indexOf("参考那个对话，把注册页也做了") < body.indexOf("[Referenced conversation"), "用户的话在前、摘要跟在后面");
  assert.match(body, /Turn 1 — user: 把登录页做出来\nTurn 1 — assistant: 登录页做好了/);

  const [mine] = ownUserMessages(s.state!.messages);
  assert.equal(mine.displayText, "参考那个对话，把注册页也做了", "界面上的气泡只有用户打的字");
  assert.deepEqual(mine.refs, [{ id: src.id, title: "把登录页做出来" }]);
  assert.equal(s.title, "参考那个对话，把注册页也做了");
  assert.equal(s.state!.externalContentSeen, true, "K9：被引用的对话读过外部内容，这个会话也算读过");
  await persistNow(s);
  const rec = await loadSession(s.id);
  assert.deepEqual(ownUserMessages(rec!.messages)[0].refs, mine.refs, "随会话落盘");
  assert.equal(rec!.gates?.externalContent, true);

  // 只引用、不打字：照样起一轮，标题「引用：…」，气泡文字为空
  const only = attachSession(scripted(t).next(say("看过了")), workspace());
  const r2 = startRun(only, "", undefined, [], undefined, { refs: await referenceDigests([src.id]) });
  assert.ok(r2.started);
  await r2.done;
  assert.equal(only.title, "引用：把登录页做出来");
  assert.equal(ownUserMessages(only.state!.messages)[0].displayText, "");
  assert.ok(CAPABILITIES.includes("session-refs"), "能力位：新前端据此才让会话块拖进输入框");
  for (const x of [s, only]) dropSession(x.id);
});

test("引用会话 前端：历史里的 refs 只收形状对的、最多 3 个；拖进输入框时不引用自己、不重复、不超上限；合并指纹认得出引用", () => {
  assert.deepEqual(sessionRefsFrom(undefined), []);
  assert.deepEqual(sessionRefsFrom([{ id: "a", title: "A" }, { id: "", title: "空" }, { id: "b" }, "x", { id: "c", title: "C", extra: 1 }]), [
    { id: "a", title: "A" },
    { id: "c", title: "C" },
  ]);
  assert.equal(sessionRefsFrom(Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, title: `T${i}` }))).length, MAX_SESSION_REFS);

  const one = withSessionRef([], { id: "a", title: "A" }, "me");
  assert.deepEqual(one, { list: [{ id: "a", title: "A" }] });
  const self = withSessionRef(one.list, { id: "me", title: "自己" }, "me");
  assert.equal(self.list, one.list);
  assert.equal(self.note, "不能引用对话自己");
  const dup = withSessionRef(one.list, { id: "a", title: "A" }, "me");
  assert.equal(dup.list, one.list, "重复的不加");
  assert.equal(dup.note, undefined, "重复的不打扰");
  const full = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }];
  assert.match(withSessionRef(full, { id: "d", title: "D" }, "").note ?? "", /最多引用 3 个/);
  assert.deepEqual(withSessionRef([], { id: "a", title: "A" }, "").list, [{ id: "a", title: "A" }], "新对话（还没有 id）也能引用");

  const plain = { kind: "user", text: "", attachments: [] };
  const withRef = { ...plain, refs: [{ id: "a", title: "A" }] };
  assert.notEqual(itemFp(plain), itemFp(withRef), "只有引用、没打字的一条也要认得出");
  assert.equal(itemFp(withRef), itemFp({ ...plain, refs: sessionRefsFrom([{ id: "a", title: "A" }]) }), "直播里的气泡与历史重建的是同一条");
});
