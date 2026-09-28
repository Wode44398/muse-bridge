import assert from "node:assert/strict";
import test from "node:test";
import { recordFp } from "./session.ts";

// 指纹只是「客户端手里那份还算不算数」的判据，所以两条铁律：
// 内容没变绝不变（否则白拉，短路失效），内容变了必须变（否则漏内容，比慢更糟）。
const rec = (messages: any[], outputTokens = 0): any => ({
  v: 1,
  id: "s1",
  createdAt: 0,
  updatedAt: Date.now(),
  title: "t",
  config: {},
  messages,
  todos: [],
  totals: { inputTokens: 0, outputTokens, lastContextTokens: 0 },
});

const user = (text: string) => ({ role: "user", content: [{ t: "text", text }] });
const assistant = (blocks: any[]) => ({ role: "assistant", content: blocks });

test("same content fingerprints the same across calls (updatedAt must not leak in)", () => {
  const messages = [user("hi"), assistant([{ t: "text", text: "hello" }])];
  const a = recordFp(rec(messages));
  const b = recordFp(rec(messages, 0));
  assert.equal(a, b);
});

test("an appended message changes the fingerprint", () => {
  const base = [user("hi"), assistant([{ t: "text", text: "hello" }])];
  assert.notEqual(recordFp(rec(base)), recordFp(rec([...base, user("再来一个")])));
});

// 尾部消息里追加 block（工具调用接上结果这类）不改变消息条数——只靠条数会漏。
test("a block appended to the tail message changes the fingerprint", () => {
  const before = [user("hi"), assistant([{ t: "text", text: "在查" }])];
  const after = [
    user("hi"),
    assistant([{ t: "text", text: "在查" }, { t: "tool_call", id: "c1", name: "Read", args: {} }]),
  ];
  assert.notEqual(recordFp(rec(before)), recordFp(rec(after)));
});

test("agent output moves the fingerprint even at equal shape", () => {
  const messages = [user("hi"), assistant([{ t: "text", text: "hello" }])];
  assert.notEqual(recordFp(rec(messages, 100)), recordFp(rec(messages, 240)));
});

// internal 消息不进 visibleMessages，客户端也看不到 —— 它们不该让指纹失配，
// 否则每次对账都判「变了」，短路等于没做。
test("internal messages do not disturb the fingerprint", () => {
  const visible = [user("hi"), assistant([{ t: "text", text: "hello" }])];
  const withInternal = [
    user("hi"),
    { role: "user", internal: true, content: [{ t: "text", text: "[Automated check] ..." }] },
    assistant([{ t: "text", text: "hello" }]),
  ];
  assert.equal(recordFp(rec(visible)), recordFp(rec(withInternal)));
});

test("empty and truncated records fingerprint distinctly", () => {
  const full = [user("hi"), assistant([{ t: "text", text: "hello" }])];
  assert.notEqual(recordFp(rec(full)), recordFp(rec([user("hi")])));
  assert.notEqual(recordFp(rec([user("hi")])), recordFp(rec([])));
});
