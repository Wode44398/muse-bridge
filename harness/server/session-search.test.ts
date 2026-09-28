// K10（D5）：侧栏搜索的正文命中。
//
// 修前：侧栏只按项目名与会话标题过滤——标题是首句截的，「上次让它改登录页校验的那个对话」这种按内容找的，只能一个个点开翻。
// 修后：GET /api/sessions/search 扫用户看得见的正文（用户的话、插话原话、助手正文），不含思考、工具调用与结果、给模型的
// 注入；多个词要都出现、不分大小写；按最近更新排，给出第一处命中的前后文（分三段，前端自己加高亮）；按文件修改时间缓存，
// 会话又说了话下一次就搜得到；范围与列表一致（调用方给过滤器，快照桶的旧会话照列表规矩不出现）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { persistNow, type Session } from "./session.ts";
import { searchSessions, searchTerms } from "./session-search.ts";
import { deleteSessionFile } from "./store.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { CAPABILITIES } from "./protocol.ts";
import { ok, type Tool } from "./tools/types.ts";

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
const probe: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Probe", description: "probe", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("ran", "tool output TOOLONLY");
  },
};
const thinkThenSay = (thinking: string, text: string): StreamEvent[] => [
  { e: "thinking_delta", text: thinking },
  { e: "text_delta", text },
  { e: "turn_done", stopReason: "end" },
];
async function sessionWith(t: import("node:test").TestContext, user: string, ...steps: StreamEvent[][]): Promise<Session> {
  const session = attachSession(scripted(t).next(...steps), tmp("dimensio-k10-"), { tools: [probe] });
  await send(session, user);
  await persistNow(session);
  return session;
}
const ids = async (q: string) => (await searchSessions(q)).items.map((h) => h.id);

test("K10 正文命中：用户的话与助手正文搜得到；思考、工具结果、注入不算；插话按原话；多个词都要出现；不分大小写；带前后文", async (t) => {
  const login = await sessionWith(
    t,
    "帮我看看登录页的表单校验",
    calls(call("p1", "Probe")),
    thinkThenSay("内部推理 SECRETWORD", "登录页的 validate() 缺了空用户名检查，已经补上"),
  );
  const hello = await sessionWith(t, "hello World", say("ok"));
  // 注入与插话：直接放进转录再落盘
  login.state!.messages.push(
    { role: "user", origin: "harness", kind: "todo", content: [{ t: "text", text: "INJECTEDWORD reminder" }] },
    { role: "user", origin: "steer", displayText: "STEERWORD 先别推", content: [{ t: "text", text: "PREFIXONLY: STEERWORD 先别推" }] },
  );
  await persistNow(login);

  assert.deepEqual(await ids("validate"), [login.id], "助手正文");
  assert.deepEqual(await ids("表单校验"), [login.id], "用户的话");
  assert.deepEqual(await ids("SECRETWORD"), [], "思考不算");
  assert.deepEqual(await ids("TOOLONLY"), [], "工具结果不算");
  assert.deepEqual(await ids("INJECTEDWORD"), [], "给模型的注入不算");
  assert.deepEqual(await ids("STEERWORD"), [login.id], "插话按原话");
  assert.deepEqual(await ids("PREFIXONLY"), [], "插话给模型加的前缀不算");
  assert.deepEqual(await ids("登录页 validate"), [login.id], "多个词都出现");
  assert.deepEqual(await ids("登录页 hello"), [], "有一个词不在就不算");
  assert.deepEqual(await ids("WORLD"), [hello.id], "不分大小写");

  const [hit] = (await searchSessions("validate")).items;
  assert.equal(hit.snippet.match, "validate");
  assert.match(hit.snippet.before, /登录页的 $/);
  assert.match(hit.snippet.after, /^\(\) 缺了空用户名检查/);
  assert.equal(hit.hits, 1);
  assert.equal((await searchSessions("World")).items[0].snippet.match, "World", "摘录保留原文的大小写");
  assert.deepEqual(await ids("   "), [], "空查询");
  assert.deepEqual(searchTerms("a b c d e f g"), ["a", "b", "c", "d", "e"], "最多 5 个词");
});

test("K10 缓存按文件修改时间：会话又说了话，下一次就搜得到；删掉的会话不再出现；过滤器与列表同一套、按最近更新排", async (t) => {
  const first = await sessionWith(t, "第一个会话 ALPHA", say("好"));
  const second = await sessionWith(t, "第二个会话 ALPHA", say("好"));
  assert.deepEqual(await ids("ALPHA"), [second.id, first.id], "最近更新的在前");
  assert.deepEqual(await ids("BETA"), []);

  first.state!.messages.push({ role: "assistant", content: [{ t: "text", text: "后来又说了 BETA" }] });
  await persistNow(first);
  assert.deepEqual(await ids("BETA"), [first.id], "改过的会话重新读");

  const onlyFirst = await searchSessions("ALPHA", { filter: (m) => m.id === first.id });
  assert.deepEqual(onlyFirst.items.map((h) => h.id), [first.id], "过滤器（快照桶的规矩）照样生效");

  await deleteSessionFile(second.id);
  assert.deepEqual(await ids("第二个"), [], "删掉的不再出现");
  assert.ok(CAPABILITIES.includes("session-search"), "能力位：新前端据此才显示正文命中");
});
