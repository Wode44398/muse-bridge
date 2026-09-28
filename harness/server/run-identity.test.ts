// M2（#44、#51）：运行身份 runId——停止和插话带前置条件，对不上返回 409；发送幂等 + 送达回执。
// 改写自探针 04-codex/笔记/probe-stale-stop-steer.ts（#44）；#51 没有探针，按 gap 笔记的源码取证写。
//
// 修前：停止只发 sessionId、插话只发 text，落到的是「此刻恰好在跑的那一轮」——手机在重连中仍以为 A 在跑，
// 电脑已起了 B，手机点停止 / 插话就把 B 连同它的后台 job 停掉，或者把纠偏注进 B。发送没有身份：POST 有没有
// 落地客户端分不清，没落地的消息在对账后静默消失；同一条重发会再起一轮。

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import { INTERNAL_TOKEN_HEADER } from "./api-auth.ts";
import { createSession, dropSession, lookupClientRun, startRun, steerSession, stopSession, type Session } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { killTree } from "./tools/bash.ts";
import type { ProviderAdapter } from "./providers/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const caps = { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false };

// 一轮一直挂着，直到 release()（先放行再开跑也算数）或被停止
function holdingAdapter(): ProviderAdapter & { release: () => void } {
  let released = false;
  let wake = () => {};
  return {
    id: "openai", model: "fake", capabilities: caps,
    release: () => {
      released = true;
      wake();
    },
    async *stream(_t, signal) {
      yield { e: "text_delta", text: "working" };
      if (!released && !signal?.aborted) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      yield { e: "turn_done", stopReason: "end" };
    },
  };
}

function attach(session: Session, adapter: ProviderAdapter) {
  const root = temp("dimensio-m2-");
  session.state = new AgentState({
    adapter,
    system: "t",
    tools: [],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
}

test("#44：手机以为 A 还在跑，电脑已起了 B——带 A 的停止 / 插话不动 B", async () => {
  const session = createSession();
  const a = holdingAdapter();
  attach(session, a);
  const runA = startRun(session, "A 轮", undefined, [], "phone-run-A-0001");
  assert.equal(session.runId, "phone-run-A-0001", "客户端给的发送身份就是这一轮的 runId");
  a.release();
  await runA.done;

  const b = holdingAdapter();
  session.state!.adapter = b;
  const runB = startRun(session, "B 轮", undefined, [], "desk-run-B-0002");
  const abortB = session.abort!;

  const steer = steerSession(session, "别改 config，改回方案A", "phone-run-A-0001");
  assert.equal(steer.ok, false);
  assert.equal(steer.error, "run_mismatch");
  assert.equal(steer.currentRunId, "desk-run-B-0002");
  assert.equal(session.state!.hasSteer(), false, "纠偏没有注进 B");

  const stop = stopSession(session.id, "phone-run-A-0001");
  assert.equal(stop.error, "run_mismatch");
  assert.equal(stop.turnAborted, false);
  assert.equal(abortB.signal.aborted, false, "B 没被停掉");

  // 带对了 runId 照常生效；不带 runId 的旧客户端照旧
  assert.equal(steerSession(session, "顺便看看日志", "desk-run-B-0002").ok, true);
  assert.equal(steerSession(session, "旧客户端的插话").ok, true);
  const stopB = stopSession(session.id, "desk-run-B-0002");
  assert.equal(stopB.turnAborted, true);
  await runB.done;
  dropSession(session.id);
});

test("#51：发送身份记在服务端——能问「落地了没有」，查不到就是没落地", async () => {
  const session = createSession();
  const a = holdingAdapter();
  attach(session, a);
  const run = startRun(session, "hi", undefined, [], "c-send-0003-abcdef");
  assert.deepEqual(lookupClientRun("c-send-0003-abcdef"), { sessionId: session.id, runId: "c-send-0003-abcdef", running: true });
  assert.equal(lookupClientRun("c-never-sent-0004"), null);
  assert.equal(lookupClientRun("bad id!"), null, "不合格的 id 一律当没有");
  a.release();
  await run.done;
  assert.equal(lookupClientRun("c-send-0003-abcdef")?.running, false, "跑完了仍认得（重发时不会再起一轮）");
  dropSession(session.id);
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("真 harness：同一条重发不起第二轮（409 duplicate_run）；带旧 runId 的停止 / 插话回 409", { timeout: 90_000 }, async () => {
  // 假模型服务（OpenAI 兼容）：先吐一个字，然后一直挂着，直到被停止（这一轮在整个用例期间都在跑）
  const provider = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "working" } }] })}\n\n`);
    const beat = setInterval(() => res.write(": ping\n\n"), 200);
    res.on("close", () => clearInterval(beat));
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const providerBase = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}/v1`;

  const ws = temp("dimensio-m2-live-");
  const port = await freePort();
  const TOKEN = "m2-DUMMY-process-token";
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd: path.join(here, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DIMENSIO_HOST: "127.0.0.1",
      DIMENSIO_INTERNAL_TOKEN: "",
      DIMENSIO_DEV_TOKEN: TOKEN,
      HARNESS_ENV_FILE: path.join(ws, "no-such.env"),
      DIMENSIO_OUTBOUND_PROXY: "off",
      WORKSPACE_DIR: ws,
      BRIDGE_PORT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const headers = { [INTERNAL_TOKEN_HEADER]: TOKEN, "content-type": "application/json" };
  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers, body: JSON.stringify(body) });
  const getJson = async (p: string) => (await fetch(base + p, { headers })).json() as Promise<any>;
  const ctl = new AbortController();
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const r = await fetch(`${base}/api/info`, { headers });
        await r.arrayBuffer();
        if (r.status === 200) break;
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`harness did not come up:\n${out}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const cfg = await post("/api/config", { provider: "openai", model: "deepseek-flash", baseUrl: providerBase, apiKey: "FAKE-m2-openai-key" });
    assert.equal(cfg.status, 200, await cfg.text());

    // 第一次发送：读到 session 回执为止（之后断开，这一轮在服务端照跑）
    const cid = "c-live-0005-abcdef";
    const first = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "hello", clientRunId: cid }), signal: ctl.signal });
    assert.equal(first.status, 200);
    const reader = first.body!.getReader();
    let buf = "";
    let receipt: any = null;
    while (!receipt) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const m = /data: (\{"e":"session"[^\n]*)\n/.exec(buf);
      if (m) receipt = JSON.parse(m[1]);
    }
    ctl.abort();
    assert.ok(receipt?.sessionId, `送达回执：${buf.slice(0, 300)}`);
    assert.equal(receipt.runId, cid);

    const hit = await getJson(`/api/runs/${cid}`);
    assert.deepEqual(hit, { known: true, sessionId: receipt.sessionId, runId: cid, running: true });
    assert.deepEqual(await getJson("/api/runs/c-never-sent-0006"), { known: false });

    // 回包丢了、客户端拿同一个身份重发：不许再起一轮
    const again = await post("/api/run", { message: "hello", clientRunId: cid });
    assert.equal(again.status, 409);
    const dup = (await again.json()) as any;
    assert.equal(dup.error, "duplicate_run");
    assert.equal(dup.sessionId, receipt.sessionId);

    // 带旧 runId 的插话 / 停止：409，这一轮照跑
    const steer = await post(`/api/sessions/${receipt.sessionId}/steer`, { text: "改回方案A", runId: "stale-run-0007" });
    assert.equal(steer.status, 409);
    assert.equal(((await steer.json()) as any).error, "run_mismatch");
    const staleStop = await post("/api/stop", { sessionId: receipt.sessionId, runId: "stale-run-0007" });
    assert.equal(staleStop.status, 409);
    assert.equal((await getJson(`/api/sessions/${receipt.sessionId}/status`)).running, true, "没被旧的停止误伤");
    assert.equal((await getJson(`/api/sessions/${receipt.sessionId}/status`)).runId, cid);

    const stop = await post("/api/stop", { sessionId: receipt.sessionId, runId: cid });
    assert.equal(stop.status, 200);
    assert.equal(((await stop.json()) as any).turnAborted, true);
  } finally {
    ctl.abort();
    killTree(child);
    provider.closeAllConnections();
    provider.close();
  }
});
