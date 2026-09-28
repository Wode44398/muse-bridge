// R3（#39）：连接失败分账——零字节的连接失败不消耗重试次数，等网络回来。
//
// 修前：连接都没建立（fetch failed / ECONNREFUSED）与流到一半断共用每步 4 次尝试、0.5→1→2s 退避，出口断开
// 3.5 秒以上整轮就以 stream failed 结束；net-proxy 的自愈周期却是 60 秒。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import { RETRY_ATTEMPTS, runAgent } from "./agent/loop.ts";
import { isConnectFailure } from "./agent/netwait.ts";
import type { AgentEvent, StreamEvent } from "./agent/events.ts";
import type { ProviderAdapter, ProviderId } from "./providers/types.ts";
import { Sandbox } from "./sandbox.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r3-"));
after(() => fs.rmSync(ws, { recursive: true, force: true }));

beforeEach(() => {
  // 等待的节奏调快几十倍，逻辑不变
  process.env.DIMENSIO_NET_WAIT_BASE_MS = "20";
  process.env.DIMENSIO_RETRY_SCALE = "0.001"; // R8 的按次重试退避同样调快
  delete process.env.DIMENSIO_NET_WAIT_MS;
});

const caps = { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false };
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7897"), { code: "ECONNREFUSED" }) });

// script(n)：第 n 次调用（从 0 起）该怎么表现
function adapterOf(id: ProviderId, script: (n: number) => "refuse" | "503" | "cut" | "ok"): ProviderAdapter & { calls: number } {
  const a = {
    id,
    model: "fake",
    capabilities: caps,
    calls: 0,
    async *stream(): AsyncIterable<StreamEvent> {
      const how = script(a.calls++);
      if (how === "refuse") throw refused();
      if (how === "503") {
        yield { e: "error", kind: "http_503", retriable: true, raw: '{"error":{"code":503,"message":"Loading model"}}' };
        return;
      }
      if (how === "cut") {
        yield { e: "text_delta", text: "half" };
        throw new TypeError("terminated");
      }
      yield { e: "text_delta", text: "ok" };
      yield { e: "turn_done", stopReason: "end" };
    },
  };
  return a;
}

async function run(adapter: ProviderAdapter, signal = new AbortController().signal): Promise<AgentEvent[]> {
  const st = new AgentState({
    adapter,
    system: "s",
    tools: [],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(ws), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(),
    permissionMode: "auto",
    memoryAuditRequired: false,
  });
  st.addUserMessage("跑一个长任务前的第一步");
  const events: AgentEvent[] = [];
  for await (const ev of runAgent(st, signal)) events.push(ev);
  return events;
}
const lastOf = (events: AgentEvent[]) => events.filter((e) => e.e === "done" || e.e === "error").at(-1);

test("出口断开：连续 6 次连接失败不算重试次数，等到网络回来照常完成", async () => {
  const adapter = adapterOf("kimi", (n) => (n < 6 ? "refuse" : "ok"));
  const events = await run(adapter);
  const end = lastOf(events);
  assert.equal(end?.e, "done", `修前在第 4 次就以 stream failed 结束：${JSON.stringify(end)}`);
  assert.equal(adapter.calls, 7);
  const waits = events.filter((e) => e.e === "context" && e.waiting === "network");
  assert.equal(waits.length, 6, "每次等待都告诉前端「在等网络」");
  const waited = waits.map((e) => (e.e === "context" ? e.waitedMs ?? -1 : -1));
  assert.ok(waited.every((ms, i) => i === 0 || ms >= waited[i - 1]), `已等时长递增：${waited}`);
});

test("等网络有上限：到点如实说「网络 N 分钟未恢复」", async () => {
  process.env.DIMENSIO_NET_WAIT_MS = "300";
  const adapter = adapterOf("kimi", () => "refuse");
  const end = lastOf(await run(adapter));
  assert.equal(end?.e, "error");
  assert.match(end.e === "error" ? end.message : "", /网络 \d+ 分钟未恢复.*ECONNREFUSED/);
});

test("等网络时点停止：立刻结束，不把等待走完", async () => {
  process.env.DIMENSIO_NET_WAIT_BASE_MS = "30000";
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 200);
  const t0 = Date.now();
  const end = lastOf(await run(adapterOf("kimi", () => "refuse"), ctl.signal));
  assert.ok(Date.now() - t0 < 5000, "停止键在等待期间照常有效");
  assert.equal(end?.e, "error");
  assert.match(end.e === "error" ? end.message : "", /aborted/);
});

test("流到一半断（已经有字节）仍按次数重试，不进入无限等待", async () => {
  const adapter = adapterOf("kimi", () => "cut");
  const end = lastOf(await run(adapter));
  assert.equal(end?.e, "error");
  assert.equal(adapter.calls, RETRY_ATTEMPTS);
});

test("连接失败的判别：只认 fetch 本身被拒的系统错误码", () => {
  assert.equal(isConnectFailure(refused()), true);
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.equal(isConnectFailure(Object.assign(new TypeError("fetch failed"), { cause: { code } })), true, code);
  }
  const proxyRefused = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_ABORTED", message: "Proxy response (502) !== 200 when HTTP Tunneling" } });
  assert.equal(isConnectFailure(proxyRefused), true, "代理 CONNECT 被拒");
  const dualStack = Object.assign(new TypeError("fetch failed"), { cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }] } });
  assert.equal(isConnectFailure(dualStack), true, "双栈并发连接全失败");
  assert.equal(isConnectFailure(new TypeError("terminated")), false, "读响应体时断 = 已有字节");
  assert.equal(isConnectFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } })), false, "证书问题等不回来");
  assert.equal(isConnectFailure(new Error("fetch failed")), false);
});
