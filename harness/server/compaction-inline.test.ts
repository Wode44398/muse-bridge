// 压缩之后模型不用重新摸索就能接着干：摘要由主模型接着原对话写（inline，前缀与上一轮主请求相同、末尾一条指令、不执行
// 工具），写不成 / 装不下 / provider 刚报超窗时退回旁路（sidecar）；压完紧跟一条回填的工作现场（待办、最近改过的文件、
// 待批的计划），回填过的文件记成已读；回填按预算裁、反复压缩不叠加；旧形状的摘要恢复出来照样能再压。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compactManually, compactNow, COMPACTION_SYSTEM, ensureContextFits, estimateTokens, handoffSummary, summarize } from "./agent/context.ts";
import { anchorCaps, extractAnchors, mergeAnchors, parseSummary, renderSummary } from "./agent/compaction-shape.ts";
import { INLINE_HEAD, summaryOutputTokens } from "./agent/compaction-summary.ts";
import { RESTORE_HEAD, RESTORE_KIND } from "./agent/compaction-restore.ts";
import type { StreamEvent } from "./agent/events.ts";
import { injectionKind, messageKind, tagLegacyOrigins } from "./agent/injections.ts";
import { defaultProfile } from "./agent/profile.ts";
import type { Msg, Turn } from "./agent/turn.ts";
import { createAdapter } from "./providers/registry.ts";
import { checkSession } from "./session-health.ts";
import { isCompactionRequest, isInlineCompactionRequest, renderWindows } from "./test-harness/context-windows.ts";
import { call, calls, fakeSummary, say, scripted } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { anthropicCacheModel, fakeAnthropicFetch } from "./test-harness/wire-fakes.ts";
import { editTool } from "./tools/edit.ts";
import { readTool } from "./tools/read.ts";
import { ok, type Tool } from "./tools/types.ts";

const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const reply = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
const toolCall = (id: string, name: string, args: Record<string, unknown>): Msg => ({ role: "assistant", content: [{ t: "tool_call", id, name, args }] });
const result = (id: string, okay: boolean, text: string): Msg => ({ role: "user", content: [{ t: "tool_result", id, ok: okay, content: [{ t: "text", text }] }] });
const textOf = (m: Msg | undefined): string => (m ? m.content.map((b) => (b.t === "text" ? b.text : "")).join("") : "");
const restoreOf = (msgs: Msg[]): Msg | undefined => msgs.find((m) => messageKind(m) === RESTORE_KIND);
const summaryOf = (msgs: Msg[]): Msg | undefined => msgs.find((m) => messageKind(m) === "compaction-summary");

// 纯文本历史：n 轮问答，每条回答约 1000 token（微压缩腾不出地方）
const textHistory = (n: number): Msg[] => [user("task"), ...Array.from({ length: n }, (_, i) => [user(`q${i}`), reply("r".repeat(4_000))]).flat()];

let echoRuns = 0;
const echoTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: {} } },
  async run() {
    echoRuns++;
    return ok("echoed", "echo result");
  },
};

// ── inline 的请求形状 ──────────────────────────────────────────────────────────
test("inline：摘要请求 = 上一轮主请求原样 + 末尾一条指令；同 system、同工具表、同思考档，输出上限单独放宽", async (t) => {
  const big = "x".repeat(20_000);
  const round = (i: number): StreamEvent[] => calls({ e: "text_delta", text: `${i}${big}` }, call(`c${i}`, "Echo"));
  const adapter = scripted(t, { capabilities: { contextWindow: 40_000, maxOutputTokens: 32_000 } }).next(
    round(1), round(2), round(3), round(4), round(5), round(6),
    say(fakeSummary("SUMMARY: echoed six times")),
    say("done"),
  );
  const { state } = loopState(t, adapter, { tools: [echoTool], user: "do a long job" });
  state.budget = { maxOutputTokens: 1000, thinking: "high" };
  await drive(state, adapter);
  const at = adapter.inputs.findIndex(isCompactionRequest);
  assert.ok(at > 0, "压缩过一次");
  const inline = adapter.inputs[at];
  const prev = adapter.inputs[at - 1];
  assert.ok(isInlineCompactionRequest(inline), "走的是 inline");
  assert.equal(inline.system, prev.system, "system 与上一轮主请求相同");
  assert.deepEqual(inline.tools, prev.tools, "工具表与上一轮主请求相同");
  assert.deepEqual(inline.messages.slice(0, prev.messages.length), prev.messages, "上一轮主请求的消息原样是这次的前缀");
  const tail = inline.messages.slice(prev.messages.length);
  assert.equal(tail.at(-1)!.kind, "compaction-request");
  assert.ok(textOf(tail.at(-1)).startsWith(INLINE_HEAD));
  assert.equal(injectionKind(textOf(tail.at(-1))), "compaction-request", "指令的开头登记在 injections.ts");
  assert.match(textOf(tail.at(-1)), /Do not call any tools/);
  assert.match(textOf(tail.at(-1)), /Done \(do not redo\)[\s\S]*Remaining/);
  assert.match(textOf(tail.at(-1)), /Next step/);
  assert.equal(inline.budget.thinking, "high", "思考档与主请求一致（Anthropic 上改思考配置会让消息段缓存失效）");
  assert.ok(inline.budget.maxOutputTokens > prev.budget.maxOutputTokens, "输出上限单独放宽");
  assert.equal(adapter.inputs.filter(isCompactionRequest).length, 1);
  // 压完的主请求里：摘要在、指令不在（指令只在那一次请求里）
  const after = adapter.inputs[at + 1];
  assert.ok(summaryOf(after.messages), "压完的主请求带着摘要");
  assert.ok(!after.messages.some((m) => m.kind === "compaction-request"), "摘要指令不进转录");
  assert.ok(!state.messages.some((m) => m.kind === "compaction-request"));
});

test("inline 经真 Anthropic 适配器编码：摘要请求命中上一轮主请求写下的缓存前缀，思考配置不变", async (t) => {
  const baseUrl = "https://anthropic.invalid";
  const wire = fakeAnthropicFetch(t, baseUrl, [say("答复"), say(fakeSummary("INLINE SUMMARY"))]);
  const adapter = createAdapter({ provider: "anthropic", apiKey: "FAKE-DUMMY-KEY", model: "claude-sonnet-4-6", baseUrl });
  const { state } = loopState(t, adapter, { memoryAudit: false });
  state.messages = textHistory(30);
  state.addUserMessage("接着来");
  await drive(state, adapter as never);
  await compactManually(state);
  assert.equal(wire.bodies.length, 2);
  const [main, inline] = wire.bodies;
  assert.equal(JSON.stringify(inline.system), JSON.stringify(main.system));
  assert.deepEqual(inline.thinking, main.thinking);
  assert.deepEqual(inline.output_config, main.output_config);
  assert.ok(inline.max_tokens > main.max_tokens);
  const rows = anthropicCacheModel(wire.bodies);
  const lastWrite = Math.max(...rows[0].breakpoints);
  assert.ok(rows[1].hit >= lastWrite, `摘要请求最远命中到第 ${rows[1].hit} 块，上一轮主请求的写入点在第 ${lastWrite} 块`);
  assert.ok(rows[1].readChars > rows[1].totalChars * 0.8, "绝大部分前缀走缓存");
  assert.match(textOf(summaryOf(state.messages)), /INLINE SUMMARY/);
});

// ── 退回 sidecar 的各条件 ──────────────────────────────────────────────────────
function compactState(t: test.TestContext, steps: StreamEvent[][], opts: { contextWindow?: number; maxOutputTokens?: number; mode?: "inline" | "sidecar" } = {}) {
  const adapter = scripted(t, { capabilities: { contextWindow: opts.contextWindow ?? 40_000, maxOutputTokens: opts.maxOutputTokens ?? 32_000 } }).next(...steps);
  const profile = defaultProfile();
  if (opts.mode) profile.side.summary.mode = opts.mode;
  // 回填替模型读文件，要先按权限判一次 Read：会话里得有 Read（生产会话都有）
  const { state, root } = loopState(t, adapter, { tools: [echoTool, readTool], profile });
  state.messages = textHistory(30);
  return { adapter, state, root };
}

test("退回 sidecar：inline 那次发了工具调用——工具不执行，改由旁路写摘要", async (t) => {
  echoRuns = 0;
  const { adapter, state } = compactState(t, [calls(call("x1", "Echo")), say(fakeSummary("SIDECAR NOTES"))]);
  await compactManually(state);
  assert.equal(adapter.callCount, 2);
  assert.ok(isInlineCompactionRequest(adapter.inputs[0]));
  assert.equal(adapter.inputs[1].system, COMPACTION_SYSTEM, "第二次是旁路摘要");
  assert.deepEqual(adapter.inputs[1].tools, []);
  assert.equal(echoRuns, 0, "inline 里发的工具调用没有执行");
  assert.ok(!JSON.stringify(state.messages).includes("x1"), "那次工具调用不进转录");
  assert.match(textOf(summaryOf(state.messages)), /SIDECAR NOTES/);
});

test("退回 sidecar：inline 的摘要短得离谱", async (t) => {
  const { adapter, state } = compactState(t, [say("."), say(fakeSummary("SIDECAR NOTES"))]);
  await compactManually(state);
  assert.equal(adapter.callCount, 2);
  assert.equal(adapter.inputs[1].system, COMPACTION_SYSTEM);
  assert.match(textOf(summaryOf(state.messages)), /SIDECAR NOTES/);
});

test("退回 sidecar：provider 刚报超窗（compactNow）、窗口很小、剩下的地方装不下输出、档案指定 sidecar——都不发 inline", async (t) => {
  const reactive = compactState(t, [say(fakeSummary("notes"))]);
  assert.equal(await compactNow(reactive.state), true);
  assert.equal(reactive.adapter.inputs[0].system, COMPACTION_SYSTEM, "超窗：整段历史本身就发不出去");

  const small = compactState(t, [say(fakeSummary("notes"))], { contextWindow: 30_000 });
  small.state.messages = textHistory(20);
  await compactManually(small.state);
  assert.equal(small.adapter.inputs[0].system, COMPACTION_SYSTEM, "窗口小于 3.2 万 token");

  // 窗口 4 万、历史约 3.9 万 token：剩下的地方连 2K 的输出都放不下
  const full = compactState(t, [say(fakeSummary("notes"))]);
  full.state.messages = textHistory(38);
  assert.ok(40_000 - estimateTokens(full.state.system, full.state.messages) < 3_000);
  await compactManually(full.state);
  assert.equal(full.adapter.inputs[0].system, COMPACTION_SYSTEM, "装不下 inline");

  const pinned = compactState(t, [say(fakeSummary("notes"))], { mode: "sidecar" });
  await compactManually(pinned.state);
  assert.equal(pinned.adapter.inputs[0].system, COMPACTION_SYSTEM, "档案 side.summary.mode = sidecar");
});

test("sidecar 的预算随窗口缩放：大窗口给更长的转录与更大的输出上限，小窗口收紧", async (t) => {
  const middle = Array.from({ length: 200 }, (_, i) => (i % 2 ? reply(`step ${i} ${"y".repeat(2_000)}`) : user(`q${i}`)));
  const big = scripted(t, { capabilities: { contextWindow: 400_000, maxOutputTokens: 64_000 } }).next(say(fakeSummary("big")));
  await summarize(big, middle);
  const small = scripted(t, { capabilities: { contextWindow: 20_000, maxOutputTokens: 64_000 } }).next(say(fakeSummary("small")));
  await summarize(small, middle);
  const chars = (turn: Turn) => textOf(turn.messages[0]).length;
  assert.ok(chars(big.inputs[0]) > 200_000, `大窗口：转录 ${chars(big.inputs[0])} 字符（以前封顶 6 万）`);
  assert.ok(big.inputs[0].budget.maxOutputTokens >= 8_000, "大窗口：输出上限不再是 1500");
  assert.equal(big.inputs[0].budget.thinking, "off", "sidecar 默认关思考");
  assert.ok(chars(small.inputs[0]) < 60_000, "小窗口：转录收紧到装得下");
  assert.ok(small.inputs[0].budget.maxOutputTokens <= 2_000);
  assert.equal(summaryOutputTokens(8_000, 256_000 + 13_000), 10_760);
  assert.equal(summaryOutputTokens(8_000, 2_000_000), 16_000, "封顶");
});

// ── 回填工作现场 ──────────────────────────────────────────────────────────────
function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

// 中段里改了 7 个文件（f0 最早、f6 最近），之后是一长段纯文本问答
function editHistory(): Msg[] {
  const msgs: Msg[] = [user("把 f0…f6 都改一遍")];
  for (let i = 0; i < 7; i++) {
    msgs.push(toolCall(`w${i}`, "Write", { path: `src/f${i}.ts`, content: `export const f${i} = ${i};\n` }), result(`w${i}`, true, `wrote src/f${i}.ts`));
  }
  msgs.push(toolCall("bad", "Edit", { path: "src/never.ts", old_string: "a", new_string: "b" }), result("bad", false, "not found"));
  for (let i = 0; i < 24; i++) msgs.push(user(`q${i}`), reply("r".repeat(4_000)));
  return msgs;
}

test("回填：紧跟摘要一条内部消息——待办、最近改过的 5 个文件的当前内容（带行号）、还没批准的计划；回填过的记成已读", async (t) => {
  const { adapter, state, root } = compactState(t, [say(fakeSummary("notes"))]);
  writeFiles(root, Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`src/f${i}.ts`, `export const f${i} = ${i};\nexport const tail${i} = "end";\n`])));
  state.messages = editHistory();
  state.todos = [{ content: "改 f0…f6", status: "completed" }, { content: "跑测试", status: "in_progress" }, { content: "提交", status: "pending" }];
  state.ctx.readFileState.set(path.join(root, "src", "stale.ts"), { mtimeMs: 0, content: "", readRanges: [], complete: true });
  await compactManually(state);
  assert.equal(adapter.callCount, 1);
  const at = state.messages.findIndex((m) => messageKind(m) === "compaction-summary");
  const restore = state.messages[at + 1];
  assert.equal(messageKind(restore), RESTORE_KIND, "回填紧跟在摘要后面");
  assert.equal(restore.internal, true, "内部消息：不出现在聊天记录里");
  const text = textOf(restore);
  assert.ok(text.startsWith(RESTORE_HEAD));
  assert.equal(injectionKind(text), RESTORE_KIND, "开头登记在 injections.ts");
  assert.match(text, /\[x\] 改 f0…f6\n\[~\] 跑测试\n\[ \] 提交/);
  for (const i of [6, 5, 4, 3, 2]) assert.match(text, new RegExp(`### src/f${i}\\.ts \\(lines 1-3 of 3\\)\\n\\s+1\\texport const f${i} = ${i};`));
  assert.doesNotMatch(text, /src\/f1\.ts|src\/f0\.ts/, "最多 5 个，最早改的不回填");
  assert.doesNotMatch(text, /never\.ts/, "失败的改动不算改过");
  const order = [6, 5, 4, 3, 2].map((i) => text.indexOf(`### src/f${i}.ts`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "最近改的在前");
  // 已读状态：回填过的按回填的范围记上；没回填的（和压缩前读过的）清掉，改之前要重读
  const rfs = state.ctx.readFileState;
  assert.deepEqual(rfs.get(path.join(root, "src", "f6.ts"))?.readRanges, [[1, 3]]);
  assert.equal(rfs.get(path.join(root, "src", "f6.ts"))?.complete, true);
  assert.equal(rfs.has(path.join(root, "src", "f0.ts")), false);
  assert.equal(rfs.has(path.join(root, "src", "stale.ts")), false);
  // 回填了待办：压完的下一次请求不必再挂一份待办提醒
  assert.equal(state.turnsSinceTodoSeen, 0);
  // 会话体检与分窗渲染都认得它：内部消息不算泄漏；露到聊天记录里就报
  const health = (messages: Msg[]) => checkSession({ system: state.system, messages, config: { permissionMode: "auto" } } as never).filter((i) => i.severity === "error");
  assert.deepEqual(health(state.messages), []);
  assert.ok(health(state.messages.map((m) => (m === restore ? { ...m, internal: false } : m))).some((i) => i.code === "injection-visible"));
  assert.match(renderWindows([{ system: state.system, messages: state.messages, tools: [], budget: { maxOutputTokens: 1 } }]), /\[compaction-restore\]/);
  // 回填过的文件不用重读就能 Edit；没回填的照旧要求先 Read
  const edit = (rel: string) => editTool.run({ path: rel, old_string: '"end"', new_string: '"done"' }, state.ctx);
  assert.equal((await edit("src/f6.ts")).ok, true, "回填过的直接改");
  assert.match(fs.readFileSync(path.join(root, "src", "f6.ts"), "utf8"), /"done"/);
  const vetoed = await edit("src/f0.ts");
  assert.equal(vetoed.ok, false);
  assert.match(JSON.stringify(vetoed.content), /You must Read src\/f0\.ts before editing it/);
});

test("回填：plan 模式下最后交的计划落在被压掉的那段里——原文回填并写明还没批准；尾部还看得到的不重复回填", async (t) => {
  const { state } = compactState(t, [say(fakeSummary("notes")), say(fakeSummary("notes 2"))]);
  state.permissionMode = "plan";
  state.messages = [
    user("先做计划"),
    toolCall("p1", "ExitPlanMode", { plan: "## Plan\n1. change src/a.ts\n2. run npm test" }),
    result("p1", false, "The user sent the plan back: also cover src/b.ts"),
    ...textHistory(28).slice(1),
  ];
  await compactManually(state);
  const text = textOf(restoreOf(state.messages));
  assert.match(text, /## Plan awaiting approval\nYou are still in plan mode\. The last plan you submitted with ExitPlanMode is not approved \(the response was: The user sent the plan back: also cover src\/b\.ts\)/);
  assert.match(text, /1\. change src\/a\.ts\n2\. run npm test/);

  state.permissionMode = "auto";
  state.messages = textHistory(30);
  await compactManually(state);
  assert.equal(restoreOf(state.messages), undefined, "没有待办、没改过文件、不在 plan 模式：不回填");
});

test("回填按预算裁：放不下时先丢最早改的文件、再丢计划，待办始终保留；压完没变短照旧不提交", async (t) => {
  const { state, root } = compactState(t, [say(fakeSummary("notes"))]);
  // 每个文件都很长：单个文件的回填预算只够开头，写明从哪接着读
  writeFiles(root, Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`src/f${i}.ts`, Array.from({ length: 2_000 }, (_, k) => `export const v${k} = "${"z".repeat(40)}";`).join("\n")])));
  state.messages = editHistory();
  state.todos = [{ content: "跑测试", status: "in_progress" }];
  const limit = Math.min(40_000, estimateTokens(state.system, state.messages));
  await compactManually(state);
  const after = estimateTokens(state.system, state.messages);
  assert.ok(after <= Math.floor(limit * 0.6), `压完 ${after} token：回填被裁到压缩窗口的 60% 以内`);
  const text = textOf(restoreOf(state.messages));
  assert.match(text, /\[~\] 跑测试/, "待办始终保留");
  const shown = [6, 5, 4, 3, 2, 1, 0].filter((i) => text.includes(`### src/f${i}.ts`));
  assert.ok(shown.length < 5, "裁掉了几个");
  assert.deepEqual(shown, [6, 5, 4, 3, 2].slice(0, shown.length), "留下的是最近改的");
  if (shown.length) {
    assert.match(text, /### src\/f6\.ts \(lines 1-\d+ of 2000; \d+ more lines not shown, Read with offset=\d+ for the rest\)/);
    const read = state.ctx.readFileState.get(path.join(root, "src", "f6.ts"))!;
    assert.equal(read.complete, false, "只回填了开头：不算读全（整份覆盖前要读完）");
    assert.equal(read.readRanges[0][0], 1);
  }
});

test("反复压缩：回填不叠加（上一次的回填若还在尾部就拿掉），用户原话与锚点照旧带下去", async (t) => {
  const { adapter, state, root } = compactState(t, [say(fakeSummary("notes 1")), say(fakeSummary("notes 2")), say(fakeSummary("notes 3"))]);
  writeFiles(root, { "src/f6.ts": "export const f6 = 6;\n" });
  state.messages = editHistory();
  state.todos = [{ content: "跑测试", status: "in_progress" }];
  await compactManually(state);
  // 只加一点再压（上一次的回填在这里落进中段；落在尾部里的情形见 compaction-restore.test.ts）
  state.messages.push(user("第二轮的话"), reply("r".repeat(4_000)), user("再来"), reply("r".repeat(4_000)));
  await compactManually(state);
  for (let i = 0; i < 20; i++) state.messages.push(user(`more ${i}`), reply("r".repeat(4_000)));
  await compactManually(state);
  assert.equal(adapter.callCount, 3);
  assert.equal(state.messages.filter((m) => messageKind(m) === RESTORE_KIND).length, 1, "只有一条回填");
  assert.equal(state.messages.filter((m) => messageKind(m) === "compaction-summary").length, 1);
  const summary = textOf(summaryOf(state.messages));
  assert.match(summary, /> 把 f0…f6 都改一遍|> 第二轮的话/);
  assert.match(summary, /Files modified:\n(- .*\n)*- src\/f6\.ts/);
  assert.doesNotMatch(summary, /export const f6 = 6/, "回填的文件正文不进锚点");
});

test("旧形状的摘要（C3 之前没有来源、只有一段文字）恢复出来照样能再压：inline 照常、新摘要接在它后面", async (t) => {
  const { adapter, state } = compactState(t, [say(fakeSummary("NEW NOTES"))]);
  state.messages = [user("task"), user("[Earlier context summary]\nOld notes: refactored the parser, commit c0ffee12."), ...textHistory(30).slice(1)];
  tagLegacyOrigins(state.messages); // store.ts 读入时做的一次性补标
  assert.equal(messageKind(state.messages[1]), "compaction-summary");
  await compactManually(state);
  assert.ok(isInlineCompactionRequest(adapter.inputs[0]));
  assert.match(JSON.stringify(adapter.inputs[0].messages[1]), /Old notes: refactored the parser/, "inline 看得到旧摘要原文");
  const summaries = state.messages.filter((m) => messageKind(m) === "compaction-summary");
  assert.equal(summaries.length, 1);
  assert.match(textOf(summaries[0]), /NEW NOTES/);
  assert.match(textOf(summaries[0]), /c0ffee12/, "旧摘要里的 ID 进了锚点索引");
});

test("带摘要开新会话与压缩走同一套：inline 写、指令说明只剩摘要", async (t) => {
  const { adapter, state } = compactState(t, [say(fakeSummary("HANDOFF NOTES"))]);
  const msg = await handoffSummary(state, "旧会话");
  assert.ok(isInlineCompactionRequest(adapter.inputs[0]));
  assert.match(textOf(adapter.inputs[0].messages.at(-1)), /new session will start from your summary alone/);
  assert.match(textOf(msg), /^\[Handoff\][\s\S]*HANDOFF NOTES/);
});

test("ensureContextFits 主动压缩默认走 inline", async (t) => {
  const { adapter, state } = compactState(t, [say(fakeSummary("notes"))]);
  state.messages = textHistory(36);
  const fit = await ensureContextFits(state);
  assert.equal(fit.compacted, true);
  assert.ok(isInlineCompactionRequest(adapter.inputs[0]));
});

// ── 锚点索引 ──────────────────────────────────────────────────────────────────
test("锚点：用户给的 ID 单列、先于工具输出里的保留；上限随窗口放宽；旧的四类索引照样解析", () => {
  const a = extractAnchors([
    user("看一下 https://example.com/issues/42 和 commit 4c1fdeb"),
    toolCall("b", "Bash", { command: "git log" }),
    result("b", true, `commit 4c1fdeb\n${Array.from({ length: 60 }, (_, i) => `commit ${(0xabc000 + i).toString(16)}9`).join("\n")}`),
  ]);
  assert.deepEqual(a.userIds, ["4c1fdeb", "https://example.com/issues/42"]);
  const merged = mergeAnchors({ files: [], commands: [], errors: [], ids: [] }, a);
  assert.deepEqual(merged.userIds, ["4c1fdeb", "https://example.com/issues/42"], "用户给的 ID 不会被工具输出里的挤掉");
  assert.ok(!merged.ids.includes("4c1fdeb"), "不在一般 ID 里重复列");
  assert.equal(merged.ids.length, 40, "基准上限 40");
  assert.equal(mergeAnchors({ files: [], commands: [], errors: [], ids: [] }, a, anchorCaps(300_000)).ids.length, 60, "大窗口放宽");
  assert.deepEqual(anchorCaps(300_000), { files: 120, commands: 60, errors: 45, userIds: 60, ids: 120 });
  const text = renderSummary({ notes: "n", userWords: [], omitted: 0, omittedAt: -1, anchors: merged, archives: [] });
  assert.match(text, /Hashes \/ URLs \/ IDs the user gave:\n- 4c1fdeb\n- https:\/\/example\.com\/issues\/42/);
  assert.deepEqual(parseSummary(text).anchors.userIds, merged.userIds, "解析得回来");
  const legacy = parseSummary(renderSummary({ notes: "n", userWords: [], omitted: 0, omittedAt: -1, anchors: { files: ["a.ts"], commands: [], errors: [], ids: ["c0ffee1"] }, archives: [] }));
  assert.deepEqual(legacy.anchors, { files: ["a.ts"], commands: [], errors: [], ids: ["c0ffee1"] });
});
