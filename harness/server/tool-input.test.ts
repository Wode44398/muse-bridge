// P14（ZCode C5、C6）：工具入参宽松归一化 + 权限判定审计。
//
// 修前：模型把布尔写成 "yes"、数字写成 "120000"、数组写成 JSON 字符串、整组参数包进一个多余的键里，都原样交给工具——工具各报
// 一句含糊的错（或者干脆按错的值跑：background:"no" 是真值，命令被扔去了后台），模型再试一轮；权限判定只在内存里走一遍，事后
// 查不到「这条命令当时是哪条规则放的 / 谁批的」。
// 修后：按工具声明的 schema 只做强制转换、不做拒绝（转录里的原话不动）；每次不是默认放行的判定记一行 permission_decision 进
// 会话的 trace JSONL，带结构化来源、规则、第一判与最终结果、谁定的、批准范围。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { runAgent } from "./agent/loop.ts";
import { normalizeToolArgs } from "./agent/tool-input.ts";
import type { JsonObjectSchema } from "./agent/turn.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { flushTraceLog, traceFile } from "./trace-log.ts";
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

const SCHEMA: JsonObjectSchema = {
  type: "object",
  properties: {
    command: { type: "string" },
    background: { type: "boolean" },
    timeout: { type: "integer" },
    action: { type: "string", enum: ["save", "delete"] },
    tags: { type: "array", items: { type: "string" } },
    opts: { type: "object", properties: { deep: { type: "boolean" } } },
  },
  required: ["command"],
};

test("P14 归一化：布尔 / 数字 / 枚举大小写 / 数字当字符串 / JSON 字符串 / 单个字符串当数组 / 嵌套对象", () => {
  const r = normalizeToolArgs(SCHEMA, {
    command: 42,
    background: "No",
    timeout: "120000",
    action: "Save",
    tags: "frontend",
    opts: '{"deep": "yes"}',
  });
  assert.deepEqual(r.args, { command: "42", background: false, timeout: 120000, action: "save", tags: ["frontend"], opts: { deep: true } });
  assert.deepEqual(r.changed.sort(), ["$.action", "$.background", "$.command", "$.opts", "$.opts.deep", "$.tags", "$.timeout"]);
  assert.deepEqual(normalizeToolArgs(SCHEMA, { background: 1, tags: '["a","b"]' }).args, { background: true, tags: ["a", "b"] });
});

test("P14 整组参数被包进一个多余的键里：认出来解开；认不出的一律原样（不拒绝）", () => {
  const wrapped = normalizeToolArgs(SCHEMA, { input: '{"command":"ls","background":"true"}' });
  assert.deepEqual(wrapped.args, { command: "ls", background: true });
  assert.ok(wrapped.changed.includes('$ ← "input"'));
  assert.deepEqual(normalizeToolArgs(SCHEMA, { arguments: { command: "pwd" } }).args, { command: "pwd" });
  // 认不出的：原对象原样返回（同一个引用），不补必填、不删多余的键
  const odd = { command: "x", background: "maybe", timeout: "soon", extra: 1 };
  const r = normalizeToolArgs(SCHEMA, odd);
  assert.equal(r.args, odd);
  assert.deepEqual(r.changed, []);
  const missing = { background: true };
  assert.equal(normalizeToolArgs(SCHEMA, missing).args, missing, "缺必填不拦，交给工具自己报");
  assert.equal(normalizeToolArgs(undefined, missing).args, missing);
});

// 记下自己收到什么参数的探针工具（审计那条要借 Bash 的名字：规则按 Bash 的 command 比对）
function probeTool(seen: Record<string, unknown>[], name = "Probe"): Tool {
  return {
    effect: "exec",
    concurrencySafe: false,
    def: { name, description: "probe", parameters: SCHEMA },
    async run(args) {
      seen.push(args);
      return ok("probed", "ok");
    },
  };
}

test("P14 loop 里：工具收到归一化后的参数，转录里还是模型的原话", async (t) => {
  const seen: Record<string, unknown>[] = [];
  const adapter = scripted(t).next(calls(call("p1", "Probe", { command: "ls", background: "no", timeout: "5000" })), say("好了"));
  const session = attachSession(adapter, tmp("dimensio-p14-"), { tools: [probeTool(seen)] });
  await send(session, "跑一下");
  assert.deepEqual(seen, [{ command: "ls", background: false, timeout: 5000 }]);
  const raw = session.state!.messages.flatMap((m) => m.content).find((b) => b.t === "tool_call" && b.id === "p1");
  assert.deepEqual(raw && raw.t === "tool_call" ? raw.args : null, { command: "ls", background: "no", timeout: "5000" });
});

test("P14 权限判定审计：规则拒绝、用户批准都记进 trace JSONL（结构化来源、规则、谁定的、范围）；默认放行不记", async (t) => {
  const seen: Record<string, unknown>[] = [];
  const adapter = scripted(t).next(
    calls(call("d1", "Bash", { command: "rm -rf build" }), call("a1", "Bash", { command: "deploy prod" }), call("n1", "Bash", { command: "echo hi" })),
    say("好了"),
  );
  const session = attachSession(adapter, tmp("dimensio-p14-audit-"), { tools: [probeTool(seen, "Bash")] });
  const state = session.state!;
  state.ctx.ownerId = session.id;
  state.permissionRules = { allow: [], deny: ["Bash(rm -rf:*)"], ask: ["Bash(deploy:*)"] };
  // 直接跑 loop（会话的 startRun 会把 requestPermission 换成真卡片、等人点）
  state.ctx.requestPermission = async () => ({ decision: "once" as const });
  state.addUserMessage("干活");
  for await (const _ev of runAgent(state, new AbortController().signal)) {
    /* 跑完为止 */
  }
  await flushTraceLog();
  const lines = fs.readFileSync(traceFile(session.id)!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const audits = lines.filter((l) => l.e === "permission_decision");
  assert.equal(audits.length, 2, "默认放行的 echo 不记");
  const denied = audits.find((a) => a.initial === "deny");
  assert.equal(denied.source, "deny-rule");
  assert.equal(denied.rule, "Bash(rm -rf:*)");
  assert.equal(denied.effect, "deny");
  assert.equal(denied.by, "rule");
  const asked = audits.find((a) => a.initial === "ask");
  assert.equal(asked.source, "ask-rule");
  assert.equal(asked.effect, "allow");
  assert.equal(asked.by, "user");
  assert.equal(asked.scope, "once");
  assert.equal(asked.subject, "deploy prod");
  assert.deepEqual(seen.map((a) => a.command), ["deploy prod", "echo hi"], "被拒的那条没跑");
});
