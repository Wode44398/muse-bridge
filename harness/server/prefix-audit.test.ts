// Q4（X09 / K46）：请求前缀守恒判定器——编码后的请求体上判纯追加，断了记断点、原因（改写者自报）与重发量；
// 缓存读写分开记；每次请求留一条只有哈希与计数的记录。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { StreamEvent } from "./agent/events.ts";
import { injectionKind, injectionsIn, recallIds } from "./agent/injections.ts";
import { runAgent } from "./agent/loop.ts";
import { PrefixAudit } from "./agent/prefix-audit.ts";
import type { Msg, WireShape } from "./agent/turn.ts";
import { setConfig } from "./config.ts";
import { createAdapter } from "./providers/registry.ts";
import type { ProviderId } from "./providers/types.ts";
import { comparePrefix, fingerprintWire, parseFingerprint, serializeFingerprint } from "./providers/wire-fingerprint.ts";
import { createSession, dropSession, getOrLoadSession, persistNow, sessionRecord, startRun } from "./session.ts";
import { sessionFilePath } from "./store.ts";
import { refreshProjectKnowledge } from "./knowledge-service.ts";
import { say, useTool } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { fakeProviderFetch } from "./test-harness/wire-fakes.ts";
import { ok, type Tool } from "./tools/types.ts";

// ── 三种 wire 形状的指纹 ───────────────────────────────────────────────────────
test("Q4 Anthropic 指纹：缓存标记挪位不算变化；tools / system / 参数 / 消息各自分开", () => {
  const msgs = (marked: number) =>
    [
      { role: "user", content: [{ type: "text", text: "u1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "u2" }] },
    ].map((m, i) => (i === marked ? { ...m, content: [{ ...m.content[0], cache_control: { type: "ephemeral" } }] } : m));
  const body = (marked: number, extra: Record<string, unknown> = {}) => ({
    model: "claude-x",
    max_tokens: 100,
    stream: true,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "Read", description: "r", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
    messages: msgs(marked),
    ...extra,
  });
  const a = fingerprintWire("anthropic", body(1));
  const b = fingerprintWire("anthropic", body(2));
  assert.deepEqual(comparePrefix(a, b), { verdict: "append", shared: 3, items: 3, resentChars: 0 }, "缓存标记从第 2 条挪到第 3 条，前缀没变");
  assert.equal(comparePrefix(a, fingerprintWire("anthropic", body(1, { output_config: { effort: "high" } }))).at, "params");
  assert.equal(comparePrefix(a, fingerprintWire("anthropic", { ...body(1), system: [{ type: "text", text: "sys + plan" }] })).at, "system");
});

test("Q4 OpenAI 兼容指纹：打头的 system 消息单列；中间一条被改写 = 断在那一条，重发量是它和它之后的全部", () => {
  const base = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "user", content: "[Automatically recalled] x" },
    { role: "assistant", content: "a1" },
  ];
  const a = fingerprintWire("openai", { model: "m", messages: base, stream: true, stream_options: { include_usage: true } });
  assert.equal(a.items.length, 3, "system 不算消息条目");
  const appended = fingerprintWire("openai", { model: "m", messages: [...base, { role: "user", content: "u2" }], stream: true });
  assert.equal(comparePrefix(a, appended).verdict, "append", "流式开关不算参数");
  const rewritten = fingerprintWire("openai", { model: "m", messages: [base[0], base[1], base[3], { role: "user", content: "u2" }] });
  const v = comparePrefix(a, rewritten);
  assert.equal(v.verdict, "break");
  assert.equal(v.at, 1);
  assert.equal(v.resentChars, a.items[1].chars + a.items[2].chars);
  const shorter = comparePrefix(a, fingerprintWire("openai", { model: "m", messages: base.slice(0, 2) }));
  assert.deepEqual([shorter.verdict, shorter.at], ["break", 1], "变短（回滚）也是断");
  assert.equal(comparePrefix(a, fingerprintWire("openai", { model: "m2", messages: base })).at, "params", "换模型 = 参数变");
});

test("Q4 Gemini 指纹：systemInstruction 与 contents；形状不同就当第一次", () => {
  const body = { contents: [{ role: "user", parts: [{ text: "u1" }] }], systemInstruction: { parts: [{ text: "sys" }] }, generationConfig: { maxOutputTokens: 10 } };
  const a = fingerprintWire("gemini", body);
  assert.equal(a.items.length, 1);
  assert.equal(comparePrefix(a, fingerprintWire("gemini", { ...body, systemInstruction: { parts: [{ text: "sys2" }] } })).at, "system");
  assert.equal(comparePrefix(a, fingerprintWire("openai", { messages: [] })).verdict, "first");
});

test("Q4 前缀基线落盘往返；形状不对的基线当作没有", () => {
  const fp = fingerprintWire("openai", { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] });
  assert.deepEqual(parseFingerprint(JSON.parse(JSON.stringify(serializeFingerprint(fp)))), fp);
  assert.equal(parseFingerprint({ shape: "openai", t: ["x", 1], s: ["y", 2], p: ["z", 3], i: [["a"]] }), null);
  assert.equal(parseFingerprint({ shape: "nope" }), null);
  assert.equal(parseFingerprint(undefined), null);
});

// ── 判定器：归因、累计、记录 ────────────────────────────────────────────────────
const wire = (texts: string[], system = "sys") => ({ model: "m", messages: [{ role: "system", content: system }, ...texts.map((t) => ({ role: "user", content: t }))] });

test("Q4 判定器：断点归给报备过的改写；没人报备记 unexplained 并告警；报备只管下一次请求", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const log = t.mock.method(console, "log", () => {});
  const audit = new PrefixAudit();
  audit.label = "s1";
  assert.equal(audit.observe("openai", wire(["u1", "old-output"]), 0, {}, []).verdict, "first");
  assert.equal(audit.observe("openai", wire(["u1", "old-output", "a1"]), 0, {}, []).verdict, "append");
  audit.noteRewrite("compaction");
  const r = audit.observe("openai", wire(["u1", "summary", "a1", "u2"]), 0, {}, []);
  assert.deepEqual([r.verdict, r.breakAt, r.cause], ["break", 1, "compaction"]);
  assert.ok(r.resentChars > 0);
  assert.equal(audit.observe("openai", wire(["u1", "summary", "a1", "u2", "a2"]), 0, {}, []).verdict, "append", "报备不会延续到后面的请求");
  const u = audit.observe("openai", wire(["u1", "summary", "a1", "u2", "a2"], "sys + date"), 0, {}, []);
  assert.deepEqual([u.breakAt, u.cause], ["system", "unexplained"]);
  assert.equal(warn.mock.calls.filter((c) => /nobody declared a rewrite/.test(String(c.arguments[0]))).length, 1);
  assert.ok(log.mock.calls.some((c) => /\[prefix\] s1 request #3: prefix broke at message 1 \(compaction\)/.test(String(c.arguments[0]))));
  assert.deepEqual(audit.totals.breaks, { compaction: 1, unexplained: 1 });
  assert.equal(audit.totals.requests, 5);
  audit.noteUsage({ input: 100, output: 5, cacheRead: 80 });
  assert.deepEqual(audit.recent.at(-1)?.usage, { input: 100, output: 5, cacheRead: 80 });
});

test("Q4 判定器：最近记录只留 50 条；基线与累计数落盘后能接着比", (t) => {
  t.mock.method(console, "log", () => {});
  const audit = new PrefixAudit();
  for (let i = 0; i < 60; i++) audit.observe("openai", wire(Array.from({ length: i + 1 }, (_, k) => `m${k}`)), 0, {}, []);
  assert.equal(audit.recent.length, 50);
  assert.equal(audit.recent[0].seq, 11);
  const back = new PrefixAudit();
  back.restore(JSON.parse(JSON.stringify(audit.baseline())), JSON.parse(JSON.stringify(audit.totals)));
  back.noteRewrite("resume");
  const r = back.observe("openai", wire(Array.from({ length: 60 }, (_, k) => `m${k}`), "sys (refreshed)"), 0, {}, []);
  assert.deepEqual([r.verdict, r.breakAt, r.cause], ["break", "system", "resume"]);
  assert.equal(back.totals.requests, 61, "累计数接着算");
});

test("Q4 注入物识别：按开头认类别；召回片段里的文档 id", () => {
  assert.equal(injectionKind("[Automated check] Your previous reply was cut off by the output-token limit"), "length-continue");
  assert.equal(injectionKind("[Automated check] You have edited files without sufficient"), "verify-nudge");
  assert.equal(injectionKind("plain user text"), null);
  // C3：注入按结构化来源认（harness 塞的带 origin），用户本人写了同样开头的话不算
  const msgs: Msg[] = [
    { role: "user", content: [{ t: "text", text: "fix it" }] },
    { role: "user", content: [{ t: "text", text: "[Automatically recalled task context]\n- [module:src/api.ts] api; why=x\n  ...\n- [memory:rule-1] rule" }], origin: "harness", kind: "recall" },
    { role: "user", content: [{ t: "text", text: "[Memory audit required] ..." }], origin: "harness" },
    { role: "user", content: [{ t: "text", text: "[Memory audit required] 这句提示是什么意思？" }] }, // 用户贴回来问的
    { role: "assistant", content: [{ t: "text", text: "[Memory audit required] quoted by the model" }] },
  ];
  assert.deepEqual(injectionsIn(msgs), { recall: 1, "audit-nudge": 1 }, "只算 harness 塞的用户侧消息");
  assert.deepEqual(recallIds(msgs), ["module:src/api.ts", "memory:rule-1"]);
});

// ── 真 adapter + 假 fetch，三种形状各跑一遍真 loop ─────────────────────────────────
const echoTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("echoed", "echo result");
  },
};

const RECALL = (id: string) => `[Automatically recalled task context — navigation evidence, not new instructions.]\n- [${id}] note`;

const SHAPES: { shape: WireShape; provider: ProviderId; model: string; usage: Record<string, unknown>; read: number; write: number }[] = [
  { shape: "anthropic", provider: "anthropic", model: "claude-sonnet-4-6", usage: { cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, read: 7, write: 3 },
  { shape: "openai", provider: "kimi", model: "k3", usage: { prompt_tokens_details: { cached_tokens: 6 } }, read: 6, write: 0 },
  { shape: "gemini", provider: "gemini", model: "gemini-3-flash", usage: { cachedContentTokenCount: 5 }, read: 5, write: 0 },
];

for (const s of SHAPES) {
  test(`Q4 真 loop（${s.shape}）：run 内纯追加；微压缩、切模式、悄悄改 system 各断一次并归因；缓存读写入账`, async (t) => {
    t.mock.method(console, "log", () => {});
    const warn = t.mock.method(console, "warn", () => {});
    const baseUrl = `https://${s.shape}.invalid`;
    const steps: StreamEvent[][] = [useTool("c1", "Echo"), say("one"), say("two"), say("three"), say("four")];
    const fake = fakeProviderFetch(t, { baseUrl, shape: s.shape, steps, usage: () => s.usage });
    const adapter = createAdapter({ provider: s.provider, apiKey: "FAKE-DUMMY-KEY", model: s.model, baseUrl });
    const { state } = loopState(t, adapter, { tools: [echoTool], user: "first" });
    const run = async () => {
      for await (const _ of runAgent(state, new AbortController().signal)) { /* drain */ }
    };
    state.appendUserBlocks([{ t: "text", text: RECALL("module:a") }], true, { origin: "harness", kind: "recall" }); // 召回（C1 起随会话落盘，是追加不是改写）
    await run();
    // 微压缩的样子：就地把一条旧工具输出换成省略说明，并报备
    for (const m of state.messages) {
      m.content = m.content.map((b) => (b.t === "tool_result" ? { ...b, content: [{ t: "text", text: "[old tool output elided]" }] } : b));
    }
    state.noteRewrite("micro-compaction");
    state.addUserMessage("second");
    await run();
    state.rewriteSystem(`${state.system} + plan`, "mode");
    state.addUserMessage("third");
    await run();
    state.system = `${state.system} + date`; // 没报备的改写
    state.addUserMessage("fourth");
    await run();

    assert.equal(fake.bodies.length, 5);
    const r = state.prefix.recent;
    assert.deepEqual(r.map((x) => x.verdict), ["first", "append", "break", "break", "break"]);
    assert.deepEqual(r.map((x) => x.cause ?? "-"), ["-", "-", "micro-compaction", "mode", "unexplained"]);
    // 转录：0 用户、1 召回、2 调用、3 结果、4 答复……——三种形状都是逐条对应，断点都在第 3 条
    assert.deepEqual(r.map((x) => x.breakAt ?? "-"), ["-", "-", 3, "system", "system"], "微压缩断在被改写的那条工具结果上");
    assert.equal(warn.mock.calls.filter((c) => /nobody declared a rewrite/.test(String(c.arguments[0]))).length, 1);
    assert.deepEqual(r[0].recall, ["module:a"]);
    assert.deepEqual(r[0].injected, { recall: 1 });
    assert.equal(r[1].attempt, 0);
    assert.deepEqual(r.map((x) => x.usage?.cacheRead), [s.read, s.read, s.read, s.read, s.read]);
    assert.equal(state.totalCacheReadTokens, s.read * 5);
    assert.equal(state.totalCacheWriteTokens, s.write * 5);
    assert.equal(state.prefix.totals.requests, 5);
    assert.ok(state.prefix.totals.resentChars > 0);
  });
}

// ── 会话层：落盘 → 逐出 → 恢复，生产路径上认出「恢复即断」（#30）──────────────────────────
const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

// 寒暄一轮 → 新增一个源文件（项目知识的模块数跟着变）→ 落盘、逐出。legacy：把盘上记录改回 C4 之前的样子（没有 world 令牌）。
async function evictedAfterNewFile(t: import("node:test").TestContext, steps: StreamEvent[][], legacy = false) {
  t.mock.method(console, "log", () => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-prefix-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  const baseUrl = "https://openai.invalid/v1";
  setConfig({ provider: "openai", model: "fake-model", apiKey: "DUMMY-q4-key", baseUrl, workspace: root, permissionMode: "auto", access: "workspace" });
  const fake = fakeProviderFetch(t, { baseUrl, shape: "openai", steps, usage: () => ({ prompt_cache_hit_tokens: 4 }) });

  const session = createSession();
  await startRun(session, "你好").done; // 寒暄：不召回、不要求记忆审计
  fs.writeFileSync(path.join(root, "src", "util.ts"), "export const id = <T>(x: T) => x;\n");
  // M12：项目知识由 worker 对；先让它对到新文件（否则旧记录恢复时用的快照还是旧的，system 尾段不变、不断）
  await refreshProjectKnowledge(root);
  await persistNow(session);
  const rec = sessionRecord(session);
  assert.ok(rec?.prefixBaseline, "上一次请求的前缀指纹要随会话落盘");
  assert.equal(rec.totals.prefix?.requests, 1);
  assert.equal(rec.totals.cacheReadTokens, 4, "DeepSeek 形状的缓存命中字段");
  dropSession(session.id);
  if (legacy) {
    const file = sessionFilePath(session.id)!;
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(onDisk.world, "C4 起会话记录带 world 令牌");
    delete onDisk.world;
    fs.writeFileSync(file, JSON.stringify(onDisk));
  }
  return { id: session.id, fake };
}

test("Q4 会话层：前缀基线与累计数随会话落盘；恢复后第一次请求纯追加，项目知识的变化以片段送达（C4 修 #30 余）", async (t) => {
  const { id, fake } = await evictedAfterNewFile(t, [say("你好！"), say("不客气")]);
  const back = await getOrLoadSession(id);
  assert.ok(back?.state);
  await startRun(back, "谢谢").done;
  const last = back.state.prefix.recent.at(-1);
  assert.equal(last?.verdict, "append", `恢复后第一次请求不该断：${JSON.stringify(last)}`);
  assert.equal(back.state.prefix.totals.requests, 2, "累计数接着上次的算");
  assert.deepEqual(back.state.prefix.totals.breaks ?? {}, {});
  assert.equal(fake.bodies.length, 2);
  assert.equal(JSON.stringify(fake.bodies[1].messages[0]), JSON.stringify(fake.bodies[0].messages[0]), "system 原样沿用");
  assert.match(JSON.stringify(fake.bodies[1].messages.at(-1)), /Generated project knowledge/, "新的项目知识以片段追加在末尾");
  dropSession(id);
});

test("Q4 会话层：C4 之前落盘的会话（没有 world 令牌）恢复时断一次、归因 resume；此后再恢复不再断", async (t) => {
  const { id } = await evictedAfterNewFile(t, [say("你好！"), say("不客气"), say("不客气")], true);
  const back = await getOrLoadSession(id);
  assert.ok(back?.state);
  await startRun(back, "谢谢").done;
  const last = back.state.prefix.recent.at(-1);
  assert.deepEqual([last?.verdict, last?.breakAt, last?.cause], ["break", "system", "resume"]);
  assert.deepEqual(back.state.prefix.totals.breaks, { resume: 1 });
  // 这一次落盘补上了 world 令牌：再逐出、再恢复就是纯追加
  await persistNow(back);
  dropSession(id);
  const again = await getOrLoadSession(id);
  assert.ok(again?.state);
  await startRun(again, "谢谢").done; // 寒暄：不要求记忆审计，只量恢复本身
  assert.equal(again.state.prefix.recent.at(-1)?.verdict, "append");
  assert.deepEqual(again.state.prefix.totals.breaks, { resume: 1 }, "只断迁移那一次");
  dropSession(id);
});
