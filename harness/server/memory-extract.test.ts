// 瘦身 P0-1：记忆沉淀从收工关口挪到 run 之后。钉住：
//   - 值不值得看全靠确定性信号——纯问答不看（不多花一次调用）；用户表达了长期偏好、真干了活、失败后修好、中途压缩过才看；
//     模型这一轮自己 Remember 过就不再替它看；
//   - 旁路请求是那一个（MEMORY_EXTRACT_SYSTEM、不带工具、关思考、数据包进标签、最后一句明说要什么——#83）；
//   - 模型给的每条都走 Remember 同一套治理（项目类 active 缺 why/howToApply 降为 proposed、全局层永远待确认）；快照对话的
//     一次性桶只收全局事实；取不出 JSON 重试一次；
//   - 会话路径：正常收尾才排、不占 running（答复早已交付）、状态接口报 memoryPending、主会话收工不再要 MemoryAudit。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { AgentState } from "./agent/state.ts";
import { LEGACY_AUDIT_CONTRACT, systemPrompt } from "./agent/prompt.ts";
import { traceLines } from "./agent/run-trace.ts";
import type { Msg } from "./agent/turn.ts";
import { GLOBAL_MEMORY, listMemories } from "./memory.ts";
import { fileRunMemory, MEMORY_EXTRACT_SYSTEM, parseNotes, runDigest } from "./memory-extract.ts";
import { Sandbox } from "./sandbox.ts";
import { startRun } from "./session.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";

const saved = process.env.DIMENSIO_MEMORY_EXTRACT;
before(() => {
  process.env.DIMENSIO_MEMORY_EXTRACT = "1";
});
after(() => {
  process.env.DIMENSIO_MEMORY_EXTRACT = saved;
});

function tmpWorkspace(t: { after(fn: () => void): void }, parent = os.tmpdir()): string {
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "dimensio-p01-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const user = (text: string): Msg => ({ role: "user", content: [{ t: "text", text }] });
const answer = (text: string): Msg => ({ role: "assistant", content: [{ t: "text", text }] });
function exchange(id: string, name: string, args: Record<string, unknown>, ok = true, out = "done"): Msg[] {
  return [
    { role: "assistant", content: [{ t: "tool_call", id, name, args }] },
    { role: "user", content: [{ t: "tool_result", id, ok, content: [{ t: "text", text: out }] }] },
  ];
}
const many = (n: number, name = "Read"): Msg[] => Array.from({ length: n }, (_, i) => exchange(`c${i}`, name, { path: `f${i}.ts` })).flat();
const opts = { workspace: "C:/ws", edited: [] as string[] };

test("P0-1 值不值得看：纯问答不看；偏好、干了活、失败后修好、压缩过才看；自己 Remember 过的不看", () => {
  assert.equal(runDigest([user("雅思多少分算母语水平"), answer("一般认为 8.5 以上……")], 0, opts), null, "纯问答：不多花一次调用");
  assert.equal(runDigest([user("看下这个函数"), ...many(5), answer("看完了")], 0, opts), null, "读了几个文件的只读分析也不看");

  const pref = runDigest([user("以后这个项目的提交信息一律用中文写"), answer("好的")], 0, opts);
  assert.equal(pref?.why, "preference");
  assert.equal(pref?.request, "以后这个项目的提交信息一律用中文写");

  const edits = runDigest([user("把 parse 修好"), ...many(6), answer("修好了")], 0, { workspace: "C:/ws", edited: ["src/parse.js"] });
  assert.equal(edits?.why, "edits");
  assert.deepEqual(edits?.edited, ["src/parse.js"]);

  const fixed = runDigest([user("跑一下构建"), ...exchange("b1", "Bash", { command: "npm run build" }, false, "Error: JDK 21 required"), ...many(3, "Bash"), answer("好了")], 0, opts);
  assert.equal(fixed?.why, "fixed-failure");
  assert.match(fixed!.trace[0], /^Bash\(command=npm run build\) → FAILED: Error: JDK 21 required$/);

  assert.equal(runDigest([user("长活"), ...many(15), answer("完成")], 0, opts)?.why, "long-run");
  assert.equal(runDigest([user("接着做"), answer("做完了")], 0, { ...opts, compacted: ["Bash(command=make) → ok"] })?.why, "compacted");

  const remembered = [user("记住：以后都用中文"), ...exchange("r1", "Remember", { title: "语言" }), answer("记下了")];
  assert.equal(runDigest(remembered, 0, opts), null, "模型自己存过：它已经挑过了");

  // 只看这一轮（from 之后）
  const earlier = [user("以后都用中文"), answer("好的")];
  assert.equal(runDigest([...earlier, user("1+1 等于几"), answer("2")], earlier.length, opts), null);
  // 会话层给的原话优先（本轮那条可能被压缩摘掉了）
  assert.equal(runDigest([answer("做完了")], 0, { ...opts, request: "以后默认用 pnpm" })?.request, "以后默认用 pnpm");
});

test("P0-1 工具轨迹：流程与记忆类工具不进；参数取主要那一个", () => {
  const lines = traceLines([
    ...exchange("a", "TodoWrite", { todos: [] }),
    ...exchange("b", "Grep", { pattern: "foo", path: "src" }),
    ...exchange("c", "MemoryAudit", { decision: "none" }),
  ]);
  assert.deepEqual(lines, ["Grep(path=src) → ok"]);
});

test("P0-1 解析：容忍围栏与废话，取不出就返回 null", () => {
  assert.deepEqual(parseNotes('```json\n{"notes":[{"title":"a"}]}\n```'), [{ title: "a" }]);
  assert.deepEqual(parseNotes('好的。{"notes": []}'), []);
  assert.equal(parseNotes("没有需要记的"), null);
  assert.equal(parseNotes('{"notes": "none"}'), null);
});

const NOTE_PREF = {
  title: "提交信息用中文",
  topic: "user.commit-language",
  type: "user",
  layer: "workspace",
  description: "写 git 提交信息时",
  content: "这个项目的 git 提交信息用中文写。",
  status: "active",
  confidence: "user_confirmed",
  evidence: ["user: 以后这个项目的提交信息一律用中文写"],
};
const NOTE_GOTCHA = {
  title: "构建要 JDK 21",
  topic: "build.jdk",
  type: "project",
  description: "构建报 JDK 版本错时",
  content: "这个项目用 JDK 21 构建；JDK 17 会报 class file version 65。",
  status: "active", // 缺 why / howToApply：Remember 会降为 proposed
  confidence: "observed",
  evidence: ["Bash npm run build"],
};

test("P0-1 沉淀：那一次旁路请求的形状；每条走 Remember 的治理落盘", async (t) => {
  const ws = tmpWorkspace(t);
  const adapter = scripted(t).next(say(JSON.stringify({ notes: [NOTE_PREF, NOTE_GOTCHA, { title: "缺正文" }] })));
  const digest = runDigest([user("以后这个项目的提交信息一律用中文写；顺便把构建修好"), ...many(6, "Bash"), answer("好了")], 0, { workspace: ws, edited: ["build.gradle"] })!;
  const r = await fileRunMemory({ adapter, digest, ctx: { sandbox: new Sandbox(ws), humanAttended: () => true } });

  const req = adapter.inputs[0];
  assert.equal(req.system, MEMORY_EXTRACT_SYSTEM);
  assert.deepEqual(req.tools, []);
  assert.equal(req.budget.thinking, "off");
  const prompt = req.messages[0].content[0].t === "text" ? req.messages[0].content[0].text : "";
  assert.match(prompt, /<user_request>\n以后这个项目的提交信息一律用中文写/);
  assert.match(prompt, /<files_changed>\nbuild\.gradle\n<\/files_changed>/);
  assert.match(prompt, /Now output the JSON object described in your instructions/, "#83：最后一句明说要它做什么");

  assert.equal(r.saved.length, 2, "缺正文的那条不落");
  const notes = listMemories(ws);
  const pref = notes.find((m) => m.topic === "user.commit-language")!;
  assert.equal(pref.status, "active", "用户本人说的偏好：active + user_confirmed");
  assert.equal(pref.confidence, "user_confirmed");
  const gotcha = notes.find((m) => m.topic === "build.jdk")!;
  assert.equal(gotcha.declaredStatus, "proposed", "项目类 active 缺 why / howToApply：照 Remember 的规矩降为 proposed");
});

test("P0-1 沉淀：快照对话的一次性桶只收全局事实；全局层永远待确认；取不出 JSON 重试一次", async (t) => {
  const ws = tmpWorkspace(t, path.join(process.env.DIMENSIO_QUICK_ROOT!, "p01"));
  const globalNote = { ...NOTE_PREF, title: "回答用中文", topic: "user.language", layer: "global", content: "用户习惯用中文交流。" };
  const adapter = scripted(t).next(say("我想想……"), say(JSON.stringify({ notes: [NOTE_GOTCHA, globalNote] })));
  const digest = runDigest([user("以后都用中文回答"), answer("好的")], 0, { workspace: ws, edited: [] })!;
  const r = await fileRunMemory({ adapter, digest, ctx: { sandbox: new Sandbox(ws), humanAttended: () => true } });
  assert.equal(adapter.inputs.length, 2, "第一次没给 JSON，重试一次");
  assert.equal(r.saved.length, 1);
  assert.equal(listMemories(ws).length, 0, "快照桶里不落工作区笔记");
  const g = listMemories(GLOBAL_MEMORY).find((m) => m.topic === "user.language")!;
  assert.equal(g.declaredStatus, "proposed", "全局层等用户在记忆面板里确认");
});

test("P0-1 会话：主会话收工不再要 MemoryAudit；纯问答不多调一次；有偏好的那轮收尾后在后台沉淀、不占 running", async (t) => {
  const ws = tmpWorkspace(t);
  // 纯问答：脚本只排了一步，多调一次（沉淀或审计追问）测试就失败
  const qa = scripted(t).next(say("2"));
  const s1 = attachSession(qa, ws, { tools: [] });
  await startRun(s1, "1+1 等于几").done;
  assert.ok(!s1.memoryJob, "纯问答不排沉淀");

  const ws2 = tmpWorkspace(t);
  // 沉淀那次请求卡在 gate 上：这一轮照样结束、会话不算在跑
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const adapter = scripted(t).next(say("好的，之后提交信息都用中文。"), async function* () {
    await gate;
    yield* say(JSON.stringify({ notes: [NOTE_PREF] }));
  });
  const session = attachSession(adapter, ws2, { tools: [] });
  const run = startRun(session, "以后这个项目的提交信息一律用中文写");
  await run.done;
  assert.equal(session.running, false, "答复交付、这一轮就结束了");
  assert.ok(session.memoryJob, "沉淀在后台排着");
  release();
  await session.memoryJob;
  assert.equal(adapter.inputs[1].system, MEMORY_EXTRACT_SYSTEM);
  assert.ok(listMemories(ws2).some((m) => m.topic === "user.commit-language" && m.status === "active"));
  assert.ok(!session.memoryJob, "做完清掉");
});

test("P0-1 旧会话：system 里不再要求交 MemoryAudit；老会话照旧交时回「不用了」而不是报错", (t) => {
  const prompt = systemPrompt({ root: "C:/ws", shell: "bash", platform: "win32", provider: "local", model: "q" });
  assert.ok(!prompt.includes(LEGACY_AUDIT_CONTRACT));
  assert.doesNotMatch(prompt, /MemoryAudit/);
  const state = new AgentState({
    adapter: scripted(t),
    system: "x",
    tools: [],
    budget: { maxOutputTokens: 100, thinking: "off" },
    ctx: { sandbox: new Sandbox(os.tmpdir()), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  const r = state.completeMemoryAudit("none", "nothing durable in this synthetic run");
  assert.equal(r.ok, true);
  assert.match(r.message, /No memory audit is needed any more/);
});
