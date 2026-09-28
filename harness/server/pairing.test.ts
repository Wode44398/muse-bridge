// Q3：R5 的出口修复（repairToolPairing）与请求检查（pairingProblems）共用一套配对判定。这里钉住两条等价：
//   ① 检查说没问题 ⟺ 修复一处都不改；② 修过之后检查一定通过（修复不会产出自己都不认的形状）。
// 固定夹具覆盖已知的坏形状；再用带种子的随机转录扫一大片形状空间（失败时打印种子与转录，可复现）。
import test from "node:test";
import assert from "node:assert/strict";
import { pairingProblems, repairToolPairing } from "./agent/pairing.ts";
import type { Block, Msg } from "./agent/turn.ts";

const text = (s: string): Block => ({ t: "text", text: s });
const callB = (id: string): Block => ({ t: "tool_call", id, name: "Read", args: {} });
const result = (id: string): Block => ({ t: "tool_result", id, ok: true, content: [text(`out ${id}`)] });
const user = (...content: Block[]): Msg => ({ role: "user", content });
const assistant = (...content: Block[]): Msg => ({ role: "assistant", content });

const FIXTURES: { name: string; messages: Msg[]; ok: boolean; mention?: RegExp }[] = [
  { name: "空转录", messages: [], ok: true },
  { name: "纯对话", messages: [user(text("hi")), assistant(text("hello"))], ok: true },
  { name: "一问一答带工具", messages: [user(text("go")), assistant(callB("a")), user(result("a")), assistant(text("done"))], ok: true },
  { name: "并发两个调用、结果顺序与调用不同", messages: [user(text("go")), assistant(callB("a"), callB("b")), user(result("b"), result("a"))], ok: true },
  { name: "结果之后跟着文字（结果在前）", messages: [user(text("go")), assistant(callB("a")), user(result("a"), text("[note]"))], ok: true },
  { name: "缺结果", messages: [user(text("go")), assistant(callB("a"), callB("b")), user(result("a"))], ok: false, mention: /tool_call b has no result/ },
  { name: "末尾的调用没有结果", messages: [user(text("go")), assistant(callB("a"))], ok: false, mention: /tool_call a has no result/ },
  { name: "孤儿结果（前面的 assistant 没有调用）", messages: [user(text("go")), assistant(text("x")), user(result("zz"))], ok: false, mention: /tool_result zz answers no tool_call/ },
  { name: "开头就是结果", messages: [user(result("zz"), text("go"))], ok: false, mention: /tool_result zz/ },
  { name: "结果回应的不是紧挨着的那条 assistant", messages: [user(text("go")), assistant(callB("a")), user(result("a")), assistant(callB("b")), user(result("a"), result("b"))], ok: false, mention: /tool_result a answers no tool_call/ },
  { name: "重复结果", messages: [user(text("go")), assistant(callB("a")), user(result("a"), result("a"))], ok: false, mention: /duplicate tool_result a/ },
  { name: "结果没排在消息最前面", messages: [user(text("go")), assistant(callB("a")), user(text("[note]"), result("a"))], ok: false, mention: /not all at the start/ },
  { name: "结果散到了后面一条消息", messages: [user(text("go")), assistant(callB("a"), callB("b")), user(result("a")), user(result("b"))], ok: false, mention: /spread past/ },
  { name: "调用内重复 id", messages: [user(text("go")), assistant(callB("a"), callB("a")), user(result("a"), result("a"))], ok: false },
];

for (const f of FIXTURES) {
  test(`pairing 夹具：${f.name}`, () => {
    const problems = pairingProblems(f.messages);
    const repaired = repairToolPairing(f.messages);
    assert.equal(problems.length === 0, f.ok, `检查结果不对：${problems.join(" | ") || "（无问题）"}`);
    assert.equal(repaired.repairs === 0, f.ok, `修复次数不对：${repaired.repairs}`);
    if (f.mention) assert.match(problems.join("\n"), f.mention);
    if (f.ok) assert.equal(repaired.messages, f.messages, "形状正确时必须原样返回（不打乱缓存前缀）");
  });
}

// ── 随机转录 ────────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// uniqueIds=true 时每个 tool_call id 全局唯一（id 唯一是 checkTurn 另外一条不变量）；结果的 id 从已出现的调用里挑，
// 或者干脆是个不存在的 id。
function randomTranscript(rand: () => number, uniqueIds: boolean): Msg[] {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const ids: string[] = [];
  let next = 0;
  const messages: Msg[] = [];
  const n = Math.floor(rand() * 9);
  for (let i = 0; i < n; i++) {
    const role = rand() < 0.5 ? "assistant" : "user";
    const content: Block[] = [];
    const k = Math.floor(rand() * 4);
    for (let j = 0; j < k; j++) {
      const r = rand();
      if (role === "assistant" && r < 0.5) {
        const id = uniqueIds || !ids.length || rand() < 0.7 ? `c${next++}` : pick(ids);
        ids.push(id);
        content.push(callB(id));
      } else if (role === "user" && r < 0.6) {
        content.push(result(ids.length && rand() < 0.85 ? pick(ids) : `stray${Math.floor(rand() * 3)}`));
      } else {
        content.push(text(`t${i}.${j}`));
      }
    }
    messages.push({ role, content, ...(rand() < 0.1 ? { internal: true } : {}) });
  }
  return messages;
}

test("pairing 随机转录：检查说没问题 ⟺ 修复不动；修过之后检查必过", () => {
  let broken = 0;
  for (let seed = 1; seed <= 3000; seed++) {
    const uniqueIds = seed % 4 !== 0;
    const messages = randomTranscript(mulberry32(seed), uniqueIds);
    const problems = pairingProblems(messages);
    const repaired = repairToolPairing(messages);
    const dump = () => `seed=${seed}\n${JSON.stringify(messages)}\nproblems=${JSON.stringify(problems)}\nrepairs=${repaired.repairs}`;
    assert.equal(problems.length === 0, repaired.repairs === 0, dump());
    if (problems.length) broken++;
    if (uniqueIds) {
      assert.deepEqual(pairingProblems(repaired.messages), [], `修复后的转录仍被判坏：\n${dump()}\n${JSON.stringify(repaired.messages)}`);
      assert.equal(repairToolPairing(repaired.messages).repairs, 0, `修复不是一次到位：\n${dump()}`);
    }
  }
  // 扫描要真的覆盖到坏形状（不然上面的等价是空转）
  assert.ok(broken > 500, `随机转录里坏形状太少：${broken}`);
});
