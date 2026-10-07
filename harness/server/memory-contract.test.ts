// K5（N52、N57、MiMo）：记忆写入契约 + Remember 降摩擦。
//
// 修前：真实会话里 Remember 43 次调用失败 15 次（35%），几乎全是只影响「能不能生效」的规则——active 项目缺 Why / How to
// apply、可信度与类型不配、verified 缺 verifiedAt、同 topic 已有生效的。每次整条拒绝，模型多一轮往返，弱模型尤其容易
// 原地打转；报错里也不说该怎么填。提示里也没有「什么不该存、怎么写」：负面断言、环境相关的变通、祈使句都进了真实的库。
// 修后：软问题降级存成 proposed（证据不够降可信度），结果里逐条给可照抄的修复参数；硬错误照旧拒绝、同样附修复参数；
// why / howToApply 成了独立参数；本会话刚核对过的 verified 自动补 verifiedAt；连败 3 次明说别再试。界面 / 接口仍然严格。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { findToolCall } from "./agent/state.ts";
import { systemPrompt } from "./agent/prompt.ts";
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

test("K5 Remember 降摩擦：只影响生效的问题存成 proposed 并给可照抄的修法；why / howToApply 独立参数；硬错误照旧拒绝也附修法", async () => {
  const { ws, ctx } = setup();
  // 现网失败头号形态：active 项目缺 Why / How to apply（修前整条拒绝）
  const a = await rememberTool.run(
    { title: "android jdk", description: "构建用哪个 JDK", type: "project", topic: "android.build.jdk", status: "active", confidence: "user_confirmed", content: "本项目构建用 JDK 17。" },
    ctx,
  );
  assert.equal(a.ok, true, text(a));
  assert.equal(readMemory(ws, "android-jdk")?.status, "proposed", "存下了，只是没生效");
  assert.match(text(a), /Saved as proposed \(user_confirmed\) instead of active \(user_confirmed\)/);
  assert.match(text(a), /why:"/);
  assert.match(text(a), /howToApply:"/);

  // 照着补：why / howToApply 当独立参数给，拼成正文小节后生效
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
  assert.match(saved.content, /\n\nWhy: AGP 9 要求 JDK 17。\n\nHow to apply: 跑 gradle 前确认 JAVA_HOME。$/);

  // 偏好类可信度不够生效 → proposed，修法点名 user_confirmed
  const c = await rememberTool.run(
    { title: "reply language", description: "回答用什么语言", type: "user", topic: "user.language", status: "active", confidence: "observed", evidence: ["用户用中文提问"], content: "用户用中文交流。" },
    ctx,
  );
  assert.equal(c.ok, true, text(c));
  assert.equal(readMemory(ws, "reply-language")?.status, "proposed");
  assert.match(text(c), /confidence:"user_confirmed"/);

  // 说观察到却没给证据 → 降成 inferred 存下，修法点名 evidence
  const d = await rememberTool.run(
    { title: "ci flaky", description: "CI 偶发失败", type: "reference", topic: "ci.flaky", status: "proposed", confidence: "observed", content: "CI 的 e2e 偶发超时。", expiresAt: "2099-01-01" },
    ctx,
  );
  assert.equal(d.ok, true, text(d));
  assert.equal(readMemory(ws, "ci-flaky")?.confidence, "inferred");
  assert.match(text(d), /evidence:\["/);

  // 同 topic 已有生效的、没写 supersedes → 存成 proposed，修法给出要替换的 id
  const e = await rememberTool.run(
    {
      title: "android jdk 21", description: "构建用哪个 JDK", type: "project", topic: "android.build.jdk", status: "active", confidence: "user_confirmed",
      content: "本项目构建用 JDK 21。", why: "升级了 AGP。", howToApply: "JAVA_HOME 指向 JDK 21。",
    },
    ctx,
  );
  assert.equal(e.ok, true, text(e));
  assert.equal(readMemory(ws, "android-jdk-21")?.status, "proposed");
  assert.equal(readMemory(ws, "android-jdk")?.status, "active", "原来生效的那条不受影响");
  assert.match(text(e), /supersedes:"android-jdk"/);

  // 本会话刚核对过的 verified：没给 verifiedAt 就记成现在，直接生效
  const f = await rememberTool.run(
    { title: "jdk version", description: "本机 JDK 版本", type: "reference", topic: "env.jdk", status: "active", confidence: "verified", evidence: ["tool:b-ok java -version 输出 17"], content: "本机 JDK 是 17。", expiresAt: "2099-01-01" },
    ctx,
  );
  assert.equal(f.ok, true, text(f));
  const verified = readMemory(ws, "jdk-version")!;
  assert.equal(verified.status, "active");
  assert.equal(verified.confidence, "verified");
  assert.ok(verified.verifiedAt);

  // 硬错误照旧整条拒绝：缺说明、topic 不合法——每条附可照抄的修法
  const g = await rememberTool.run(
    { title: "Build Env", description: "", type: "project", topic: "Build Env!", status: "proposed", confidence: "observed", evidence: ["x"], content: "构建环境说明。" },
    ctx,
  );
  assert.equal(g.ok, false);
  assert.match(text(g), /description:"/);
  assert.match(text(g), /topic:"build-env"/);

  // 界面 / 接口仍然严格：同样的缺 Why 整条拒绝，报错原文不变、不带修法
  assert.throws(
    () => saveMemory(ws, { title: "x", description: "x", type: "project", topic: "x", status: "active", confidence: "user_confirmed", content: "x" }),
    (err: Error) =>
      err.message === "2 problems, fix them all in one retry: (1) active project memory must include a Why: section; (2) active project memory must include a How to apply: section",
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

// 瘦身 P0-1：完整契约写在 Remember 的说明里（模型调用它时就在眼前）与 run 之后的沉淀请求里；系统提示只留要点并指过去，
// 不再把同一份清单在每次请求里念两遍。
test("K5 写入契约：Remember 的说明与沉淀请求写全（不存什么、写成陈述句、环境观察带到期、同一教训改原条目）；系统提示留要点", () => {
  const { ws } = setup();
  const prompt = systemPrompt({ root: ws, shell: "bash", platform: "linux", provider: "openai", model: "m" });
  for (const rule of [/statements of fact/i, /update the existing note \(same id\)/, /The Remember tool spells out what not to save/]) {
    assert.match(prompt, rule);
  }
  const desc = rememberTool.def.description;
  for (const rule of [/Do NOT store: environment-dependent failures/, /statement of fact/, /need expiresAt/, /pass why and howToApply/]) {
    assert.match(desc, rule);
  }
  for (const rule of [/Do NOT save: anything visible in the files/, /environment-dependent failures/, /statements of fact/, /reuse its id and topic to update it/, /needs why and howToApply/]) {
    assert.match(MEMORY_EXTRACT_SYSTEM, rule);
  }
});
