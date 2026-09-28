// R10（一）：压缩摘要的新形状——用户原话原样保留、笔记注明「不是证据」、机械锚点索引，反复压缩时一路带下去；交给摘要器的
// 转录按条均匀采样；摘要写不出来 / 超时走确定性笔记；点了停止不压；压完没变短不提交。
import assert from "node:assert/strict";
import test from "node:test";
import { ensureContextFits, estimateTokens } from "./agent/context.ts";
import { archiveChunks, extractAnchors, mergeAnchors, parseSummary, prepareSummary, renderSummary, sampleTranscript } from "./agent/compaction-shape.ts";
import type { CompactionArchive } from "./agent/state.ts";
import type { StreamEvent } from "./agent/events.ts";
import type { Msg } from "./agent/turn.ts";
import { fakeSummary, say, scripted } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";

const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
// C3：上一次的压缩摘要是 harness 塞的（带来源），不是用户说的
const summaryMsg = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }], origin: "harness", kind: "compaction-summary" });
const reply = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
const call = (id: string, name: string, args: Record<string, unknown>): Msg => ({ role: "assistant", content: [{ t: "tool_call", id, name, args }] });
const result = (id: string, ok: boolean, text: string): Msg => ({ role: "user", content: [{ t: "tool_result", id, ok, content: [{ t: "text", text }] }] });
const summaryText = (msgs: Msg[]): string =>
  msgs.map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("")).find((s) => s.startsWith("[Earlier context summary]")) ?? "";

test("R10 锚点索引：改过的文件、命令与成败、报错首行、哈希 / URL / UUID（机械抽取，原样照抄）", () => {
  const a = extractAnchors([
    call("w", "Write", { path: "C:\\work\\src\\a.ts", content: "x" }),
    result("w", true, "ok"),
    call("r", "Read", { path: "C:\\work\\src\\b.ts" }),
    result("r", true, "export const b = 1;"),
    call("b1", "Bash", { command: "npm test" }),
    result("b1", false, "\nerror TS2345: Argument of type 'string' is not assignable\n at x"),
    call("b2", "Bash", { command: "git log -1" }),
    result("b2", true, "commit 4c1fdeb see https://example.com/pr/7."),
  ]);
  assert.deepEqual(a.files, ["C:\\work\\src\\a.ts"], "只读不算改过");
  assert.deepEqual(a.commands, ["FAILED npm test", "ok git log -1"]);
  assert.deepEqual(a.errors, ["Bash: error TS2345: Argument of type 'string' is not assignable"]);
  assert.deepEqual(a.ids, ["4c1fdeb", "https://example.com/pr/7"]);
  const deep = extractAnchors([call("b3", "Bash", { command: "node x.js" }), result("b3", false, "Command failed with exit code 1\n    at run (x.js:3)\nTypeError: x is not a function")]);
  assert.deepEqual(deep.errors, ["Bash: TypeError: x is not a function"], "错误码 / 错误类名不在第一行时挑有信息量的那一行");
  const merged = mergeAnchors({ files: ["x", "y"], commands: [], errors: [], ids: [] }, { files: ["x", "z"], commands: [], errors: [], ids: [] });
  assert.deepEqual(merged.files, ["y", "x", "z"], "去重时留最后一次出现的位置");
  const many = mergeAnchors({ files: Array.from({ length: 50 }, (_, i) => `f${i}`), commands: [], errors: [], ids: [] }, { files: [], commands: [], errors: [], ids: [] });
  assert.equal(many.files.length, 40);
  assert.equal(many.files[0], "f10", "超上限只留最近的");
});

test("R10 摘要消息能原样解析回来：多行的用户原话、省略计数、锚点索引", () => {
  const text = renderSummary({
    notes: "Did the refactor.\n## A heading the model wrote",
    userWords: ["第一句", "两行的\n第二句"],
    omitted: 3,
    omittedAt: 1,
    anchors: { files: ["src/a.ts"], commands: ["ok npm test"], errors: [], ids: ["c0ffee1"] },
    archives: [],
  });
  assert.match(text, /^\[Earlier context summary\]\nThese are your own working notes/);
  assert.match(text, /> 第一句\n\n…\(3 earlier user messages omitted\)…\n\n> 两行的\n> 第二句/);
  const back = parseSummary(text);
  assert.deepEqual(back.userWords, ["第一句", "两行的\n第二句"]);
  assert.equal(back.omitted, 3);
  assert.deepEqual(back.anchors, { files: ["src/a.ts"], commands: ["ok npm test"], errors: [], ids: ["c0ffee1"] });
});

test("R10 反复压缩：上一条摘要里的用户原话与锚点接着带下去；超预算留最早一点和最近的大部分，中间计省略", () => {
  const prev = renderSummary({ notes: "old", userWords: ["最早的需求"], omitted: 0, omittedAt: -1, anchors: { files: ["src/old.ts"], commands: [], errors: [], ids: [] }, archives: [] });
  const middle: Msg[] = [summaryMsg(prev), reply("ok"), call("w", "Write", { path: "src/new.ts", content: "x" }), result("w", true, "ok"), user("新的要求")];
  const p = prepareSummary(middle, 10_000);
  assert.deepEqual(p.userWords, ["最早的需求", "新的要求"]);
  assert.deepEqual(p.anchors.files, ["src/old.ts", "src/new.ts"]);

  const words = Array.from({ length: 30 }, (_, i) => user(`第 ${i} 条：${"字".repeat(40)}`));
  const tight = prepareSummary(words, 400);
  assert.ok(tight.omitted > 0 && tight.userWords.length < 30);
  assert.match(tight.userWords.at(-1)!, /^第 29 条/, "最近的留着");
  const rendered = renderSummary({ ...tight, notes: "n" });
  assert.match(rendered, /earlier user messages omitted/);
});

test("R10 单条特别长的用户原话（贴进来的日志）只留首尾摘录", () => {
  const p = prepareSummary([user(`开头${"日".repeat(3_000)}结尾`)], 10_000);
  assert.equal(p.userWords.length, 1);
  assert.ok(p.userWords[0].startsWith("开头") && p.userWords[0].endsWith("结尾") && p.userWords[0].includes("\n…\n"));
  assert.ok(p.userWords[0].length < 700);
});

test("R10 交给摘要器的转录超预算时按条均匀采样（首尾都在、中间标出没显示几条），不再只截开头", () => {
  const records = Array.from({ length: 100 }, (_, i) => `REC${i} ${"x".repeat(100)}`);
  const out = sampleTranscript(records, 3_000);
  assert.ok(out.length <= 3_300);
  assert.match(out, /^REC0 /);
  assert.match(out, /REC99 x+$/);
  assert.match(out, /\[… \d+ records not shown …\]/);
  const shown = [...out.matchAll(/REC(\d+) /g)].map((m) => Number(m[1]));
  assert.ok(shown.some((n) => n > 40 && n < 60), "中间也有");
  assert.equal(sampleTranscript(["a", "b"], 3_000), "a\n\nb", "放得下就全给");
});

// 窗口 2 万、缓冲 1.3 万：约 7000 token 就触发；纯文本历史（微压缩腾不出地方）
function longState(t: test.TestContext, steps: (readonly StreamEvent[] | ((turn: unknown, n: number) => AsyncIterable<StreamEvent>))[]) {
  const adapter = scripted(t, { capabilities: { contextWindow: 20_000 } }).next(...(steps as never[]));
  const { state } = loopState(t, adapter, { memoryAudit: false });
  state.messages = [user("task"), ...Array.from({ length: 80 }, (_, i) => (i % 2 ? reply("r".repeat(1_000)) : user(`q${i}`)))];
  return { adapter, state };
}

test("R10 摘要请求超时：换成确定性笔记照样压（不卡死这一轮）", async (t) => {
  const saved = process.env.DIMENSIO_SUMMARY_TIMEOUT_MS;
  process.env.DIMENSIO_SUMMARY_TIMEOUT_MS = "50";
  t.after(() => (saved === undefined ? delete process.env.DIMENSIO_SUMMARY_TIMEOUT_MS : (process.env.DIMENSIO_SUMMARY_TIMEOUT_MS = saved)));
  // 一直不回的摘要器：等到收到中止信号才结束
  const hang = async function* (): AsyncIterable<StreamEvent> {
    await new Promise((r) => setTimeout(r, 400));
  };
  const { adapter, state } = longState(t, [hang]);
  const started = Date.now();
  const fit = await ensureContextFits(state);
  assert.ok(Date.now() - started < 3_000);
  assert.equal(adapter.callCount, 1);
  assert.equal(fit.compacted, true);
  assert.match(summaryText(state.messages), /No written summary: the summarizer failed — summary timed out/);
});

test("R10 用户已经点了停止：不发摘要请求、不压", async (t) => {
  const { adapter, state } = longState(t, []);
  const before = JSON.stringify(state.messages);
  const stop = new AbortController();
  stop.abort();
  const fit = await ensureContextFits(state, stop.signal);
  assert.equal(adapter.callCount, 0);
  assert.equal(fit.compacted, false);
  assert.equal(JSON.stringify(state.messages), before);
  assert.equal(state.compactionFailures, 0, "点停止不算压缩失败（连停三次不该把压缩熔断掉）");
});

test("R10 尾部预算扣掉 system：system 大、窗口小时压完要回到触发线以下（不然几轮一压）", async (t) => {
  // 窗口 4 万、触发线 2.7 万；system 约 1.2 万 token；纯文本历史约 1.8 万 token（微压缩腾不出地方）
  const adapter = scripted(t, { capabilities: { contextWindow: 40_000 } }).next(say(fakeSummary("notes")));
  const { state } = loopState(t, adapter, { memoryAudit: false, system: "s".repeat(48_000) });
  state.messages = [user("task"), ...Array.from({ length: 120 }, (_, i) => (i % 2 ? reply("r".repeat(1_200)) : user(`q${i}`)))];
  const fit = await ensureContextFits(state);
  assert.equal(fit.compacted, true);
  // 尾部按整个窗口的 40%（1.6 万）留的话：1.2 万 + 1.6 万 + 摘要 > 2.7 万，压完还在触发线上
  assert.ok(fit.used < fit.limit - 13_000, `压完 ${fit.used} 仍在触发线 ${fit.limit - 13_000} 以上`);
});

test("R10 压完没变短就不提交（摘要器写了一大篇）", async (t) => {
  const { adapter, state } = longState(t, [say(fakeSummary("x".repeat(120_000)))]);
  const before = estimateTokens(state.system, state.messages);
  const snapshot = JSON.stringify(state.messages);
  const fit = await ensureContextFits(state);
  assert.equal(adapter.callCount, 1);
  assert.equal(fit.compacted, false);
  assert.equal(state.compactionFailures, 1);
  assert.equal(JSON.stringify(state.messages), snapshot, "转录没被动过");
  assert.ok(estimateTokens(state.system, state.messages) === before);
});

// ── R10（二）Context Recovery ─────────────────────────────────────────────────
const noAnchors = { files: [], commands: [], errors: [], ids: [] };

test("R10（二）归档是纯文本：每条一个头、参数与结果原样换行、失败标 FAILED、思考不归档、超长的行折开", () => {
  const chunks = archiveChunks([
    user("把 a.ts 的报错修了"),
    { role: "assistant", content: [{ t: "thinking", text: "PRIVATE-THOUGHT" }, { t: "text", text: "先跑测试" }] },
    call("b1", "Bash", { command: "npm test" }),
    result("b1", false, "line1\nerror TS2345: bad"),
    call("w", "Write", { path: "src/a.ts", content: "const a = 1;\nexport { a };" }),
    result("w", true, "ok"),
    reply("x".repeat(5_000)),
  ]);
  assert.equal(chunks.length, 1);
  const text = chunks[0];
  assert.match(text, /^# Compaction archive: /);
  assert.match(text, /### \[msg 1\] user\n把 a\.ts 的报错修了\n/);
  assert.match(text, /### \[msg 2\] assistant\n先跑测试\n/);
  assert.match(text, /### \[msg 3\] tool_call Bash \(id b1\)\ncommand: npm test\n/);
  assert.match(text, /### \[msg 4\] tool_result Bash \(id b1\) FAILED\nline1\nerror TS2345: bad\n/);
  assert.match(text, /### \[msg 5\] tool_call Write \(id w\)\npath: src\/a\.ts\ncontent:\nconst a = 1;\nexport \{ a \};\n/);
  assert.ok(!text.includes("PRIVATE-THOUGHT"), "思考块不归档");
  assert.ok(text.includes("x".repeat(1_900)) && text.split("\n").every((l) => l.length <= 2_000), "Read 单行截到 2000 字：超长的行折开，一个字不丢");
  assert.equal(text.split("\n").filter((l) => /^x+$/.test(l)).join("").length, 5_000);
});

test("R10（二）归档超过分片上限就分片：每片都在上限以内，单条过大的记录切开、续段标 continued，什么都不丢", () => {
  const big = Array.from({ length: 400 }, (_, i) => `row ${i} ${"y".repeat(60)}`).join("\n");
  const chunks = archiveChunks([user("start"), call("r", "Read", { path: "log.txt" }), result("r", true, big), reply("done")], 8_000);
  assert.ok(chunks.length >= 4, `只分了 ${chunks.length} 片`);
  for (const c of chunks) assert.ok(Buffer.byteLength(c, "utf8") <= 8_000);
  assert.ok(chunks[0].startsWith(`# Compaction archive (part 1 of ${chunks.length})`));
  assert.ok(chunks.some((c) => c.includes("### [msg 3] tool_result Read (id r) ok (continued)")));
  const all = chunks.join("\n");
  for (let i = 0; i < 400; i++) assert.ok(all.includes(`row ${i} y`), `row ${i} 丢了`);
  assert.match(chunks.at(-1)!, /### \[msg 4\] assistant\ndone\n$/);
});

test("R10（二）摘要末尾列出归档文件与读法，解析得回来；笔记里照抄了同名一节也不认错；反复压缩时列表接着带下去", () => {
  const files = ["/data/sessions/archive/s1/compacted-1.txt", "/data/sessions/archive/s1/compacted-2-1.txt"];
  const text = renderSummary({ notes: "n", userWords: [], omitted: 0, omittedAt: -1, anchors: noAnchors, archives: files });
  assert.match(text, /\n## Context recovery\n[^\n]*Grep[^\n]*Read[^\n]*\nFolder: \/data\/sessions\/archive\/s1\n- \/data\/sessions\/archive\/s1\/compacted-1\.txt\n- \/data\/sessions\/archive\/s1\/compacted-2-1\.txt$/);
  assert.deepEqual(parseSummary(text).archives, files);
  const copied = renderSummary({ notes: "## Context recovery\n- /fake/copied.txt", userWords: [], omitted: 0, omittedAt: -1, anchors: noAnchors, archives: ["/real/compacted-1.txt"] });
  assert.deepEqual(parseSummary(copied).archives, ["/real/compacted-1.txt"]);
  const p = prepareSummary([summaryMsg(text), reply("ok"), user("下一步")], 10_000);
  assert.deepEqual(p.archives, files);
  assert.deepEqual(p.userWords, ["下一步"]);
});

// 内存里的归档：plan 按次编号，write 记下内容
function memArchive(): { files: Map<string, string>; archive: CompactionArchive } {
  const files = new Map<string, string>();
  let n = 0;
  return {
    files,
    archive: {
      plan: (count) => {
        n++;
        return count <= 1 ? [`/arch/compacted-${n}.txt`] : Array.from({ length: count }, (_, k) => `/arch/compacted-${n}-${k + 1}.txt`);
      },
      write: async (list) => {
        for (const f of list) files.set(f.path, f.text);
      },
    },
  };
}

const history = (from: number, count: number): Msg[] =>
  Array.from({ length: count }, (_, i) => ((from + i) % 2 ? reply(`answer ${from + i} ${"r".repeat(1_000)}`) : user(`q${from + i}`)));

test("R10（二）整段压缩把被压掉的原文写进归档、摘要里列出文件；再压一次，两份都列着，第二份里上一条摘要只留一行指向", async (t) => {
  const mem = memArchive();
  const adapter = scripted(t, { capabilities: { contextWindow: 20_000 } }).next(say(fakeSummary("first")), say(fakeSummary("second")));
  const { state } = loopState(t, adapter, { memoryAudit: false, compactionArchive: mem.archive });
  state.messages = [user("task"), ...history(0, 80)];
  assert.equal((await ensureContextFits(state)).compacted, true);
  assert.deepEqual([...mem.files.keys()], ["/arch/compacted-1.txt"]);
  const first = mem.files.get("/arch/compacted-1.txt")!;
  assert.match(first, /### \[msg 1\] user\nq0\n/);
  assert.match(first, /### \[msg 2\] assistant\nanswer 1 r+\n/);
  assert.match(summaryText(state.messages), /\n## Context recovery\n[\s\S]*\n- \/arch\/compacted-1\.txt$/);

  state.messages.push(...history(80, 40));
  assert.equal((await ensureContextFits(state)).compacted, true);
  assert.deepEqual([...mem.files.keys()], ["/arch/compacted-1.txt", "/arch/compacted-2.txt"]);
  assert.match(mem.files.get("/arch/compacted-2.txt")!, /### \[msg 1\] earlier compaction summary\n\(Its original messages are in the earlier archive files\.\)/);
  assert.match(summaryText(state.messages), /\n- \/arch\/compacted-1\.txt\n- \/arch\/compacted-2\.txt$/);
});

test("R10（二）归档写不成：照样压，只是摘要里不列这次的", async (t) => {
  const adapter = scripted(t, { capabilities: { contextWindow: 20_000 } }).next(say(fakeSummary("notes")));
  const archive: CompactionArchive = {
    plan: () => ["/arch/compacted-1.txt"],
    write: async () => {
      throw new Error("disk full");
    },
  };
  const { state } = loopState(t, adapter, { memoryAudit: false, compactionArchive: archive });
  state.messages = [user("task"), ...history(0, 80)];
  const errors: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => void errors.push(a.join(" ")));
  assert.equal((await ensureContextFits(state)).compacted, true);
  assert.doesNotMatch(summaryText(state.messages), /Context recovery/);
  assert.match(errors.join("\n"), /context-recovery archive not written: disk full/);
});

test("R10（二）没接归档（子 agent / 测试）：不归档、摘要里没有回查页脚", async (t) => {
  const adapter = scripted(t, { capabilities: { contextWindow: 20_000 } }).next(say(fakeSummary("notes")));
  const { state } = loopState(t, adapter, { memoryAudit: false });
  state.messages = [user("task"), ...history(0, 80)];
  assert.equal((await ensureContextFits(state)).compacted, true);
  assert.doesNotMatch(summaryText(state.messages), /Context recovery/);
});
