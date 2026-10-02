// R2（#2）：provider 流空闲超时（首字节 / 字节间分开计），超时归为可重试。
//
// 修前：fetch 只挂了 run 的 abort，provider 连上之后不再发字节（代理半死、隧道卡住）这一轮就无限挂住，
// 只能人工点停止。这里用本机一个故意卡住的假 provider 复现，窗口调成几百毫秒。

// 窗口在每次 createAdapter 时读取（本文件单独一个进程，不影响别的测试）。
process.env.DIMENSIO_STREAM_FIRST_BYTE_MS = "600";
process.env.DIMENSIO_STREAM_IDLE_MS = "600";

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { AddressInfo } from "node:net";
import { AgentState } from "./agent/state.ts";
import type { StreamEvent } from "./agent/events.ts";
import type { Turn } from "./agent/turn.ts";
import { createAdapter } from "./providers/registry.ts";
import { createSession, dropSession, startRun, stopSession } from "./session.ts";
import { Sandbox } from "./sandbox.ts";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let handler: Handler = () => {};
const server = http.createServer((req, res) => handler(req, res));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r2-"));
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const sse = (obj: unknown) => `data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`;
const chunk = (content: string) => sse({ choices: [{ delta: { content } }] });
const finish = sse({ choices: [{ delta: {}, finish_reason: "stop" }] }) + sse("[DONE]");
const turn: Turn = { system: "s", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], tools: [], budget: { maxOutputTokens: 100, thinking: "off" } };
const adapter = () => createAdapter({ provider: "openai", apiKey: "FAKE-DUMMY-KEY", model: "fake-model", baseUrl });

// 最多等 limitMs：修前会永远挂住，这里把「挂住」变成可断言的失败。
async function collect(signal?: AbortSignal, limitMs = 5000): Promise<StreamEvent[] | "hung"> {
  const events: StreamEvent[] = [];
  const drained = (async () => {
    for await (const ev of adapter().stream(turn, signal)) events.push(ev);
    return events;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), limitMs);
  });
  try {
    return await Promise.race([drained, hung]);
  } finally {
    clearTimeout(timer);
  }
}

test("连上后一个字节都不回：首字节超时，报可重试的 stream_idle", async () => {
  handler = () => {}; // 收下请求，永远不回
  const out = await collect();
  assert.notEqual(out, "hung", "流卡住时必须自己放弃，不能无限挂住");
  const err = (out as StreamEvent[]).find((e) => e.e === "error");
  assert.ok(err && err.e === "error");
  assert.equal(err.kind, "stream_idle");
  assert.equal(err.retriable, true);
  assert.match(String(err.raw), /no response from the provider/);
});

test("吐了一半就不动了：字节间超时，已经流出的部分照常交出", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk("half an ans"));
  };
  const out = await collect();
  assert.notEqual(out, "hung");
  const events = out as StreamEvent[];
  assert.ok(events.some((e) => e.e === "text_delta" && e.text === "half an ans"));
  const err = events.find((e) => e.e === "error");
  assert.ok(err && err.e === "error" && err.kind === "stream_idle" && err.retriable);
  assert.match(String(err.raw), /went silent/);
});

test("长思考期间只有心跳：按字节算有动静，不误杀", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let n = 0;
    const beat = setInterval(() => {
      if (++n <= 15) res.write(": ping\n\n"); // 15 × 100ms = 1.5s，远超 600ms 窗口
      else {
        clearInterval(beat);
        res.end(chunk("done thinking") + finish);
      }
    }, 100);
    res.on("close", () => clearInterval(beat));
  };
  const out = await collect();
  assert.notEqual(out, "hung");
  const events = out as StreamEvent[];
  assert.ok(!events.some((e) => e.e === "error"), JSON.stringify(events.filter((e) => e.e === "error")));
  assert.ok(events.some((e) => e.e === "text_delta" && e.text === "done thinking"));
});

test("用户停止照旧是中止，不被说成流卡住", async () => {
  handler = () => {};
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(
    (async () => {
      for await (const ev of adapter().stream(turn, ctl.signal)) assert.notEqual(ev.e, "error");
    })(),
    (e: Error) => e.name === "AbortError",
  );
});

test("整轮：第一次请求卡死，自动重试第二次成功", async () => {
  let hits = 0;
  handler = (_req, res) => {
    hits++;
    if (hits === 1) return; // 第一次卡死
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(chunk("hello after retry") + finish);
  };
  const session = createSession();
  session.state = new AgentState({
    adapter: adapter(),
    system: "t",
    tools: [],
    budget: { maxOutputTokens: 100, thinking: "off" },
    ctx: { sandbox: new Sandbox(ws), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake-model", thinking: "off", permissionMode: "auto", workspace: ws, access: "workspace" };
  const run = startRun(session, "打个招呼");
  // 这个上限只是把「永远挂住」变成可断言的失败，不是在量速度，所以放得很宽：卡死窗口 600ms + 退避至多 500ms 之外，还有开跑前的
  // 检查点与收尾落盘——单跑约 1.5s，8 并发全量时整轮要 4s 多，机器再忙还会更长。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), 60_000);
  });
  const outcome = await Promise.race([run.done.then(() => "done" as const), hung]);
  clearTimeout(timer);
  if (outcome === "hung") {
    stopSession(session.id);
    await run.done;
  }
  assert.equal(outcome, "done", "卡住的那次请求要自己放弃并重试，不能把整轮挂死");
  assert.equal(hits, 2);
  const last = session.state!.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.match(JSON.stringify(last.content), /hello after retry/);
  dropSession(session.id);
});
