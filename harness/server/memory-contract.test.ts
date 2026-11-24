// K5（N52、N57、MiMo）：记忆写入契约 + Remember 降摩擦。
//
// 修前：真实会话里 Remember 43 次调用失败 15 次（35%），几乎全是只影响「能不能生效」的规则——active 项目缺 Why / How to
// apply、可信度与类型不配、verified 缺 verifiedAt、同 topic 已有生效的。每次整条拒绝，模型多一轮往返，本机模型尤其容易
// 原地打转；报错里也不说该怎么填。提示里也没有「什么不该存、怎么写」：负面断言、环境相关的变通、祈使句都进了真实的库。
// 后来（记忆放宽，m 线）：必填只剩 title 与 content，写坏了的可选项丢掉照存、说一声；why / howToApply 等旧参数照收；
// 本会话刚核对过的 verified 自动补 verifiedAt；连败 3 次明说别再试。界面 / 接口仍然严格（写坏了的字段整条拒绝）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { findToolCall } from "./agent/state.ts";
import { systemPrompt } from "./agent/prompt.ts";
import { hardenedProfile } from "./agent/profile.ts";
import type { Msg } from "./agent/turn.ts";
import { readMemory, saveMemory } from "./memory.ts";
import { MEMORY_EXTRACT_SYSTEM } from "./memory-extract.ts";
import { Sandbox } from "./sandbox.ts";
import { rememberTool } from "./tools/remember.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
// 本会话转录：一次成功的 Bash（b-ok）
const transcript: Msg[] = [
  { role: "user", content: [{ t: "text", text: "看一下 JDK" }] },
  { role: "assistant", content: [{ t: "tool_call", id: "b-ok", name: "Bash", args: { command: "java -version" } }] },
  { role: "user", content: [{ t: "tool_result", id: "b-ok", ok: true, content: [{ t: "text", text: "openjdk 17.0.9" }] }] },
];
function setup() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-k5-"));
  roots.push(ws);
  const ctx: ToolContext = {
    sandbox: new Sandbox(ws, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    lookupToolCall: (id) => findToolCall(transcript, id),
  };
  return { ws, ctx };
}
const text = (r: Awaited<ReturnType<typeof rememberTool.run>>) => r.content.map((b) => (b.t === "text" ? b.text : "")).join("");

// 记忆放宽（m 线）改掉了 K5 的旧契约（「只影响生效的问题存成 proposed、给修法」）：Remember 必填只剩 title 与 content，
// 不再因缺 why / 证据、可信度不够、同 topic 冲突而拒绝或降级；旧参数照收。
test("K5 Remember 宽松写入：两个字段就生效；旧参数照收；同 topic 撞了不拒、去掉 topic 说一声；界面仍严格", async () => {
  const { ws, ctx } = setup();
  const a = await rememberTool.run({ title: "android jdk", content: "本项目构建用 JDK 17。" }, ctx);
  assert.equal(a.ok, true, text(a));
  const plain = readMemory(ws, "android-jdk")!;
  assert.equal(plain.status, "active", "缺 Why / How to apply 也照常生效");
  assert.equal(plain.type, "project");
  assert.equal(plain.description, "本项目构建用 JDK 17。");

  // 旧参数：why / howToApply 拼成正文小节；topic 记下
  const b = await rememberTool.run(
    {
      title: "android jdk", description: "构建用哪个 JDK", type: "project", topic: "android.build.jdk", status: "active", confidence: "user_confirmed",
      content: "本项目构建用 JDK 17。", why: "AGP 9 要求 JDK 17。", howToApply: "跑 gradle 前确认 JAVA_HOME。",
    },
    ctx,
  );
  assert.equal(b.ok, true, text(b));
  const saved = readMemory(ws, "android-jdk")!;
  assert.equal(saved.status, "active");
  assert.equal(saved.topic, "android.build.jdk");
  assert.match(saved.content, /\n\nWhy: AGP 9 要求 JDK 17。\n\nHow to apply: 跑 gradle 前确认 JAVA_HOME。$/);

  // 偏好、可信度只有 observed：照常生效（不再要 user_confirmed）
  const c = await rememberTool.run({ title: "reply language", type: "user", confidence: "observed", content: "用户用中文交流。" }, ctx);
  assert.equal(c.ok, true, text(c));
  assert.equal(readMemory(ws, "reply-language")?.status, "active");

  // 同 topic 已有生效的：不拒、不降级，这条去掉 topic 存下，说清楚撞了哪条、怎么替换
  const e = await rememberTool.run({ title: "android jdk 21", topic: "android.build.jdk", content: "本项目构建用 JDK 21。" }, ctx);
  assert.equal(e.ok, true, text(e));
  assert.equal(readMemory(ws, "android-jdk-21")?.status, "active");
  assert.equal(readMemory(ws, "android-jdk-21")?.topic, "android-jdk-21", "没有 topic：topic 就是 id，不和原来那条冲突");
  assert.equal(readMemory(ws, "android-jdk")?.status, "active", "原来生效的那条不受影响");
  assert.match(text(e), /update that note \(id:"android-jdk"\)/);

  // 本会话刚核对过的 verified：没给 verifiedAt 就记成现在
  const f = await rememberTool.run(
    { title: "jdk version", type: "reference", confidence: "verified", evidence: ["tool:b-ok java -version 输出 17"], content: "本机 JDK 是 17。" },
    ctx,
  );
  assert.equal(f.ok, true, text(f));
  const verified = readMemory(ws, "jdk-version")!;
  assert.equal(verified.confidence, "verified");
  assert.ok(verified.verifiedAt);

  // 写坏了的 topic：规整成合法写法照存
  const g = await rememberTool.run({ title: "Build Env", topic: "Build Env!", content: "构建环境说明。" }, ctx);
  assert.equal(g.ok, true, text(g));
  assert.equal(readMemory(ws, "build-env")?.topic, "build-env");

  // 界面 / 接口仍然严格：写坏了的字段整条拒绝，问题一次报全
  assert.throws(
    () => saveMemory(ws, { title: "x", topic: "Bad Topic!", expiresAt: "soon", content: "x" }),
    (err: Error) => /^2 problems, fix them all in one retry: /.test(err.message) && /topic must be a stable lowercase key/.test(err.message) && /expiresAt must be an ISO date/.test(err.message),
  );
});

test("K5 连续失败 3 次就明说别再试；成功一次清零", async () => {
  const { ctx } = setup();
  const bad = { title: "", description: "", type: "project", topic: "t", status: "proposed", confidence: "observed", content: "" };
  const r1 = await rememberTool.run(bad, ctx);
  const r2 = await rememberTool.run(bad, ctx);
  const r3 = await rememberTool.run(bad, ctx);
  assert.deepEqual([r1.ok, r2.ok, r3.ok], [false, false, false]);
  assert.doesNotMatch(text(r2), /do not retry/);
  assert.match(text(r3), /failed Remember #3 in a row: do not retry it again in this turn/);

  const good = await rememberTool.run(
    { title: "ok note", description: "d", type: "reference", topic: "ok.note", status: "proposed", confidence: "observed", evidence: ["e"], content: "一条事实。" },
    ctx,
  );
  assert.equal(good.ok, true, text(good));
  const r4 = await rememberTool.run(bad, ctx);
  assert.doesNotMatch(text(r4), /do not retry/, "成功过一次就清零");
});

// 契约的文字：Remember 的说明（模型调用它时就在眼前）与 run 之后的沉淀请求写要点；系统提示里说记忆是目录里的文件、
// 不认识的名字先查。Remember 的 schema 加说明压在约 1.2k 字符以内。
test("K5 写入契约：Remember 的说明短而全（陈述句、改原条目、不存凭据、文件就在目录里）；系统提示留要点", () => {
  const { ws } = setup();
  const prompt = systemPrompt({ root: ws, shell: "bash", platform: "linux", provider: "openai", model: "m", profile: hardenedProfile() });
  for (const rule of [/statements of fact/i, /update the existing note \(same id\)/, /Recall\(layer:"sessions"\)/]) {
    assert.match(prompt, rule);
  }
  // lean 正文（默认）：记忆是目录里的 Markdown 文件、索引在哪、不认识的名字先查、会过期、改原条目
  const lean = systemPrompt({ root: ws, shell: "bash", platform: "linux", provider: "openai", model: "m" });
  for (const rule of [/folder of Markdown notes/, /## Memory index/, /layer:"sessions"/, /mentions a name or rule you don't recognize/, /may be stale/, /as note files \(Write\/Edit, or Remember\)/, /update the existing note rather than adding a near-duplicate/]) {
    assert.match(lean, rule);
  }
  const desc = rememberTool.def.description;
  for (const rule of [/Markdown file in this workspace's memory directory/, /as a statement/, /update the existing note/, /Never store credentials/]) {
    assert.match(desc, rule);
  }
  assert.deepEqual(rememberTool.def.parameters.required, ["title", "content"]);
  assert.ok(JSON.stringify(rememberTool.def).length <= 1250, `Remember 的 schema 加说明 ${JSON.stringify(rememberTool.def).length} 字符`);
  for (const rule of [/Do NOT save: anything visible in the files/, /environment-dependent failures/, /statements of fact/, /reuse its id to update it/]) {
    assert.match(MEMORY_EXTRACT_SYSTEM, rule);
  }
});
