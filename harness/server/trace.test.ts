// Q12（F2 / G3）：trace 贯穿 + 运行事件 JSONL 落盘 + usage 补耗时 / 次数；出站请求记元数据、模型请求带关联头。
//
// 修前：全库没有任何关联 id；事件只活在内存 runLog 里（一轮结束只留尾部 200 条），进程一重启这一轮发生过什么就没了；
// usage 只有输入 / 输出 token，看不出一次调用花了多久、重试了几次；出站请求不留痕、也不带任何关联头。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Agent, request } from "undici";
import type { StreamEvent } from "./agent/events.ts";
import { tracedDispatcher } from "./net-proxy.ts";
import { sessionsDir } from "./paths.ts";
import { deleteSession, startRun } from "./session.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { childSpan, runInTrace, startTrace } from "./trace.ts";
import { flushTraceLog } from "./trace-log.ts";
import { ok, type Tool } from "./tools/types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
const FAKE_SECRET = "sk-ant-DUMMYDUMMYDUMMYDUMMY0000";
const traceLines = (sessionId: string) =>
  fs.readFileSync(path.join(sessionsDir(), "traces", `${sessionId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

const echoTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Echo", description: "echo", parameters: { type: "object", properties: { token: { type: "string" }, blob: { type: "string" } } } },
  run: async () => ok("echoed", "done"),
};
const usage = (inputTokens: number, outputTokens: number): StreamEvent => ({ e: "usage", inputTokens, outputTokens });

test("Q12 一轮一个 traceId：结构性事件按会话落进 JSONL（不记逐字 delta、脱敏、截断），usage 带耗时与次数；删会话一并删", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-q12-"));
  roots.push(root);
  const adapter = scripted(t).next(
    [{ e: "error", kind: "overloaded", retriable: true, retryAfterMs: 0 }], // 第一次发出就被拒，马上重试
    [usage(100, 20), ...calls(call("e1", "Echo", { token: FAKE_SECRET, blob: "x".repeat(5000) }))],
    [usage(150, 10), ...say("完成")],
  );
  const session = attachSession(adapter, root, { tools: [echoTool] });
  const run = startRun(session, "跑一下");
  await run.done;
  await flushTraceLog();

  const lines = traceLines(session.id);
  const traceIds = new Set(lines.map((l) => l.trace));
  assert.equal(traceIds.size, 1, "整轮一个 traceId");
  assert.match(String([...traceIds][0]), /^[0-9a-f]{32}$/);
  assert.ok(lines.every((l) => l.run === session.runId), "每行都标了这一轮的 runId");
  const kinds = lines.map((l) => l.e);
  for (const k of ["run_clock", "turn_start", "tool_start", "usage", "run_end"]) assert.ok(kinds.includes(k), `有 ${k}：${kinds.join(",")}`);
  assert.ok(!kinds.includes("text_delta"), "逐字 delta 不落盘");

  const usages = lines.filter((l) => l.e === "usage");
  assert.equal(usages[0].attempts, 2, "第一次调用重试过一次：一共发了两次");
  assert.equal(usages[1].attempts, 1);
  assert.ok(usages.every((u) => typeof u.durationMs === "number" && (u.durationMs as number) >= 0));

  const raw = fs.readFileSync(path.join(sessionsDir(), "traces", `${session.id}.jsonl`), "utf8");
  assert.ok(!raw.includes(FAKE_SECRET), "工具参数里的密钥没有落盘");
  const toolStart = lines.find((l) => l.e === "tool_start")!;
  assert.match(String(toolStart.args), /…\(\+\d+ chars\)$/, "超长参数截断");
  assert.ok(raw.length < 40_000, `整个文件有界：${raw.length}`);
  const end = lines.find((l) => l.e === "run_end")!;
  assert.equal(end.aborted, false);
  assert.equal(typeof end.durationMs, "number");

  await deleteSession(session.id);
  assert.equal(fs.existsSync(path.join(sessionsDir(), "traces", `${session.id}.jsonl`)), false, "删会话一并删掉它的事件日志");
});

test("Q12 出站拦截：模型 span 里的请求带关联头并记元数据（不带查询串）；工具 span 里的只记不带头；trace 之外原样放行", async () => {
  const seen: Array<{ url: string; trace?: string; span?: string; extra?: string }> = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/sse") {
      // 模型流就是这样：分块、隔一会儿来一块。拦截器包了处理器，逐块照常送达
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const tick = setInterval(() => {
        res.write(`data: ${n}\n\n`);
        if (++n === 3) {
          clearInterval(tick);
          res.end();
        }
      }, 30);
      return;
    }
    seen.push({
      url: req.url ?? "",
      trace: req.headers["x-dimensio-trace-id"] as string | undefined,
      span: req.headers["x-dimensio-span-id"] as string | undefined,
      extra: req.headers["x-extra"] as string | undefined,
    });
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dispatcher = tracedDispatcher(new Agent());
  // Node 自带 fetch 的类型（undici-types）和 undici 包的 Dispatcher 类型是两套声明，运行时是同一个东西
  const viaTraced = { dispatcher } as unknown as RequestInit;
  try {
    const run = startTrace("q12-http-session", "run-q12");
    const model = runInTrace(run, () => childSpan("model", "openai"))!;
    const tool = runInTrace(run, () => childSpan("tool", "WebFetch"))!;
    await runInTrace(model, async () => (await fetch(`${base}/v1/chat?key=QUERYSECRET`, viaTraced)).text());
    await runInTrace(tool, async () => (await fetch(`${base}/page`, viaTraced)).text());
    // 扁平数组形态的请求头也不能被弄坏
    await runInTrace(model, async () => (await request(`${base}/flat`, { dispatcher, headers: ["x-extra", "kept"] })).body.text());
    await (await fetch(`${base}/outside`, viaTraced)).text();
    const chunks = await runInTrace(model, async () => {
      const res = await fetch(`${base}/sse`, viaTraced);
      const reader = res.body!.getReader();
      const got: string[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got.push(Buffer.from(value).toString("utf8"));
      }
      return got.join("");
    });
    assert.equal(chunks, "data: 0\n\ndata: 1\n\ndata: 2\n\n", "流式响应逐块完整送达");

    assert.equal(seen[0].trace, run.traceId, "模型请求带 traceId");
    assert.equal(seen[0].span, model.spanId);
    assert.equal(seen[1].trace, undefined, "工具发的请求（比如 WebFetch 访问的网站）不带关联头");
    assert.equal(seen[2].trace, run.traceId);
    assert.equal(seen[2].extra, "kept", "原有的请求头原样保留");
    assert.equal(seen[3].trace, undefined, "trace 之外原样放行");

    await flushTraceLog();
    const https = traceLines("q12-http-session").filter((l) => l.e === "http");
    assert.equal(https.length, 4, "trace 里的四个请求各记一行，trace 之外的不记");
    assert.deepEqual(https.map((l) => l.from), ["model:openai", "tool:WebFetch", "model:openai", "model:openai"]);
    assert.ok((https[3].durationMs as number) >= 60, "流式请求的耗时算到流结束");
    assert.ok(https.every((l) => l.status === 200 && typeof l.durationMs === "number" && l.trace === run.traceId));
    assert.equal(https[0].url, `${base}/v1/chat`, "查询串不落盘（里面可能有 key）");
  } finally {
    await dispatcher.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
