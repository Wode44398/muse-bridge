// R16（N14）：文本退化重复检测——宽松档用在截断续写之前（命中就不续写，截到循环开始处）；严格档用在被打断留下的半截
// （命中就把循环的部分换成标记）。严格档不误伤每行都不一样的批量输出。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { runAgent } from "./agent/loop.ts";
import { cutAtLoop, isRunawayRepetition, LOOP_CUT_NOTICE, scanRepetition } from "./agent/repetition.ts";
import { AgentState } from "./agent/state.ts";
import type { Msg, Turn } from "./agent/turn.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { Sandbox } from "./sandbox.ts";

const INTRO =
  "Here is the plan. First I will read the configuration, then compare it with the documented defaults, and finally " +
  "propose the smallest change that fixes the timeout without touching the retry logic.\n";
const LOOP_LINE = "Let me check the configuration file again to make sure the value is right.\n";
const looping = INTRO + LOOP_LINE.repeat(30);
const oneLineLoop = "and then I check it again ".repeat(40);
const inserts = Array.from(
  { length: 40 },
  (_, i) => `INSERT INTO users (id, name, email, created_at, updated_at) VALUES (${i}, 'user ${i}', 'user${i}@example.com', now(), now());`,
).join("\n");
const prose = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: the ${["parser", "cache", "router", "scheduler"][i % 4]} handles case ${i * 7} differently because of rule ${i + 3}.`).join(" ");

test("R16 判据：循环的正文宽松 / 严格都命中；批量 INSERT 宽松命中、严格不命中；正常长文与短文都不命中", () => {
  assert.equal(isRunawayRepetition(looping), true);
  assert.equal(isRunawayRepetition(looping, true), true);
  assert.equal(isRunawayRepetition(oneLineLoop, true), true, "只有一行的循环按覆盖率判");
  assert.equal(isRunawayRepetition(inserts), true, "宽松档：共同前缀很长，照样算重复（误判的代价只是少续写一次）");
  assert.equal(isRunawayRepetition(inserts, true), false, "严格档：每行都不一样，不算循环");
  assert.equal(isRunawayRepetition(prose), false);
  assert.equal(isRunawayRepetition(LOOP_LINE.repeat(3)), false, "不到 400 字不判");
  assert.ok(scanRepetition(looping).coverage > 0.8);
});

test("R16 截断处：循环之前的正常内容留着，循环只留一遍以内", () => {
  const kept = cutAtLoop(looping);
  assert.ok(kept.startsWith(INTRO.trim().slice(0, 40)));
  assert.ok(kept.length < INTRO.length + 2 * LOOP_LINE.length, `留了 ${kept.length} 字`);
  assert.equal(cutAtLoop(prose), "", "没有循环就没有截断处");
});

const capabilities = { contextWindow: 200_000, maxOutputTokens: 8_192, thinking: false, image: false, video: false, cache: false, parallelToolCalls: true };
function adapterOf(stream: (turn: Turn, index: number, signal?: AbortSignal) => AsyncGenerator<StreamEvent>): ProviderAdapter & { calls: number } {
  const a = { id: "openai" as const, model: "fake", capabilities, calls: 0, stream: (turn: Turn, signal?: AbortSignal) => stream(turn, a.calls++, signal) };
  return a;
}
function stateFor(t: test.TestContext, adapter: ProviderAdapter): AgentState {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r16-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const st = new AgentState({
    adapter,
    system: "test",
    tools: [],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  st.addUserMessage("explain");
  return st;
}
async function drain(gen: AsyncGenerator<unknown>, onEvent?: (ev: { e: string; text?: string }) => void): Promise<{ e: string; text?: string }[]> {
  const out: { e: string; text?: string }[] = [];
  for await (const ev of gen as AsyncGenerator<{ e: string; text?: string }>) {
    out.push(ev);
    onEvent?.(ev);
  }
  return out;
}
const assistantText = (msgs: Msg[]) => msgs.filter((m) => m.role === "assistant").map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("")).join("\n");

test("R16 被输出上限截断、正文已经是循环：不续写，转录里截到循环开始处并补标记；正常的截断照旧续写", async (t) => {
  const loopy = adapterOf(async function* () {
    yield { e: "text_delta", text: looping };
    yield { e: "turn_done", stopReason: "length" };
  });
  const st = stateFor(t, loopy);
  const events = await drain(runAgent(st, new AbortController().signal));
  assert.equal(loopy.calls, 1, "没有续写");
  const text = assistantText(st.messages);
  assert.ok(text.includes(LOOP_CUT_NOTICE));
  assert.ok(text.length < INTRO.length + 3 * LOOP_LINE.length + LOOP_CUT_NOTICE.length, "循环没进转录");
  assert.ok(events.some((ev) => ev.e === "text_delta" && ev.text?.includes(LOOP_CUT_NOTICE)), "在线的界面当场看到标记");
  assert.equal(events.at(-1)?.e, "done");

  const normal = adapterOf(async function* (_turn, i) {
    yield { e: "text_delta", text: i === 0 ? prose : " and that is the whole answer." };
    yield { e: "turn_done", stopReason: i === 0 ? "length" : "end" };
  });
  const st2 = stateFor(t, normal);
  await drain(runAgent(st2, new AbortController().signal));
  assert.equal(normal.calls, 2, "正常的截断照旧续写一次");
});

test("R16 被用户打断时留下的半截是循环：循环的部分换成标记，不让下一轮重放", async (t) => {
  const ctrl = new AbortController();
  const adapter = adapterOf(async function* (_turn, _i, signal) {
    yield { e: "text_delta", text: looping };
    if (signal?.aborted) throw new Error("aborted");
    await new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      setTimeout(() => reject(new Error("test adapter: abort never arrived")), 5_000).unref();
    });
  });
  const st = stateFor(t, adapter);
  await drain(runAgent(st, ctrl.signal), (ev) => {
    if (ev.e === "text_delta") ctrl.abort();
  });
  const text = assistantText(st.messages);
  assert.ok(text.includes(LOOP_CUT_NOTICE), text.slice(0, 200));
  assert.match(text, /\[interrupted by the user\]/);
  assert.ok(text.split(LOOP_LINE.trim()).length - 1 <= 2, "循环行最多留一两遍");
});
