// R17（B7、B8、K17、K18）：loop 与 OpenAI 兼容适配器的四处健壮性。
//
// 修前：① 流「干净地」结束却什么都没带回来（没正文、没工具调用、没用量），会一路走进验证 / 记忆审计门禁，被当成「该审计
// 没审计」追问到用尽，最后报一句不相干的「没交 MemoryAudit」；② 一轮里连续的只读调用整批并行、没有上限；③ OpenAI 兼容
// 那六家的 tool 消息不标失败（Anthropic 有 is_error、Gemini 带 ok），空输出就是空串；④ 服务端不给 id 时兜底用 call_<序号>，
// 每一轮都从 call_0 起，同一段转录里会撞 id。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { EMPTY_RESPONSE_KIND, MAX_PARALLEL_TOOLS } from "./agent/loop.ts";
import type { StreamEvent } from "./agent/events.ts";
import { createOpenAIAdapter } from "./providers/openai.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { fakeProviderFetch } from "./test-harness/wire-fakes.ts";
import { fail, ok, type Tool } from "./tools/types.ts";

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
const transcriptText = (msgs: unknown) => JSON.stringify(msgs);

test("R17（B7）什么都没回来：重发一次，第二次正常就照常收尾", async (t) => {
  const adapter = scripted(t).next([], say("好的"));
  const session = attachSession(adapter, tmp("dimensio-r17-empty1-"));
  await send(session, "在吗");
  assert.equal(adapter.callCount, 2, "空的那次重发了一次");
  const last = session.state!.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.ok(transcriptText(last.content).includes("好的"));
});

test("R17（B7）连续两次什么都没回来：以 empty_model_response 收场，不走进记忆审计门禁", async (t) => {
  // 修前：第二次空回复进了记忆审计门禁，门禁追问一次 → 第三次请求（脚本只有两步，多调即判失败）
  const adapter = scripted(t).next([], []);
  const session = attachSession(adapter, tmp("dimensio-r17-empty2-"), { memoryAudit: true });
  await send(session, "在吗");
  assert.equal(adapter.callCount, 2);
  assert.equal(session.state!.memoryAuditNudges, 0, "没有烧记忆审计的追问");
  assert.ok(transcriptText(session.state!.messages).includes(EMPTY_RESPONSE_KIND), "转录里如实写了为什么收场");
});

test("R17（B8）一批并行的只读调用最多 MAX_PARALLEL_TOOLS 个，结果仍按调用顺序", async (t) => {
  let inFlight = 0;
  let peak = 0;
  const probe: Tool = {
    effect: "read",
    concurrencySafe: true,
    def: { name: "Probe", description: "probe", parameters: { type: "object", properties: { n: { type: "number" } } } },
    async run(args) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return ok("probed", `probe ${String(args.n)}`);
    },
  };
  const many = Array.from({ length: 12 }, (_, i) => call(`p${i}`, "Probe", { n: i }));
  const adapter = scripted(t).next(calls(...many), say("完成"));
  const session = attachSession(adapter, tmp("dimensio-r17-par-"), { tools: [probe] });
  await send(session, "探一下");
  assert.equal(peak, MAX_PARALLEL_TOOLS, `同时在跑的最多 ${MAX_PARALLEL_TOOLS} 个，实际 ${peak}`);
  const results = session.state!.messages.flatMap((m) => m.content).filter((b) => b.t === "tool_result");
  assert.deepEqual(results.map((b) => (b.t === "tool_result" ? b.id : "")), many.map((c) => (c as { id: string }).id), "结果按调用顺序落");
});

test("R17（K17、K18）OpenAI 兼容：失败的结果带 Error: 前缀、空输出有占位；服务端不给 id 时兜底 id 不撞", async (t) => {
  const baseUrl = "http://fake-openai.invalid/v1";
  let n = 0;
  const flaky: Tool = {
    effect: "read",
    concurrencySafe: false,
    def: { name: "Flaky", description: "flaky", parameters: { type: "object", properties: {} } },
    async run() {
      return n++ === 0 ? fail("flaky failed", "") : ok("flaky ok", "");
    },
  };
  // 不带 id 的工具调用（JSON 里没有 id 字段 = 服务端没给）
  const noId = { e: "tool_call", id: undefined, name: "Flaky", args: {} } as unknown as StreamEvent;
  const wire = fakeProviderFetch(t, {
    baseUrl,
    shape: "openai",
    steps: [
      [noId, { e: "turn_done", stopReason: "tool_use" }],
      [noId, { e: "turn_done", stopReason: "tool_use" }],
      [{ e: "text_delta", text: "完成" }, { e: "turn_done", stopReason: "end" }],
    ],
  });
  const adapter = createOpenAIAdapter({ provider: "openai", model: "fake-model", apiKey: "FAKE-KEY", baseUrl });
  const session = attachSession(adapter, tmp("dimensio-r17-wire-"), { tools: [flaky] });
  await send(session, "跑两次");

  const ids = session.state!.messages.flatMap((m) => m.content).flatMap((b) => (b.t === "tool_call" ? [b.id] : []));
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], `两轮的兜底 id 不能撞：${ids.join(" / ")}`);
  for (const id of ids) assert.match(id, /^call_[0-9a-f]{8}_0$/);

  const toolMsgs = wire.bodies[2].messages.filter((m: { role: string }) => m.role === "tool");
  assert.deepEqual(
    toolMsgs.map((m: { content: string }) => m.content),
    ["Error: (no details)", "(no output)"],
    "失败的带前缀、成功但没输出的给占位",
  );
});
