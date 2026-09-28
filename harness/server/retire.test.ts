// M8（K27 / N36）：两段式退役闸 + 优雅排空。
//
// 修前：部署脚本与 bridge 退出都直接 Stop-Process -Force / child.kill() 掉 harness（Windows 上即 TerminateProcess），
// 清理一行都不执行——在跑的轮被腰斩，转录里没有任何说明，最后几秒没落盘，job / dev server 成了孤儿；
// 部署前也没法让 dimensio 先停止接新活、等手上的轮跑完。

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
import {
  cancelRetire,
  currentFence,
  prepareRetire,
  readRetireRequest,
  REQUEST_FILE,
  retiring,
  STATUS_FILE,
  writeRetireStatus,
} from "./retire.ts";
import { createSession, drainSessions, dropSession, runningRuns, startRun, watchSession, type Session } from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { killTree } from "./tools/bash.ts";
import type { ProviderAdapter } from "./providers/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => {
  cancelRetire();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test("退役闸：prepare 冻结、重复 prepare 同一个 token 只延期、cancel 解冻、过期自动解冻", () => {
  assert.equal(retiring(), false);
  const a = prepareRetire(60_000);
  assert.equal(retiring(), true);
  const b = prepareRetire(1_000);
  assert.equal(b.token, a.token);
  assert.ok(b.expiresAt >= a.expiresAt, "期限只延不缩");
  assert.equal(cancelRetire("wrong-token"), false);
  assert.equal(cancelRetire(a.token), true);
  assert.equal(retiring(), false);
  prepareRetire(1_000);
  assert.equal(retiring(Date.now() + 2_000), false, "发起部署的脚本中途死掉，冻结也会自己解开");
  assert.equal(currentFence(), null);
});

test("请求文件：带 BOM 能读、读完就删；比本进程还早的请求与乱写的请求一律丢弃", () => {
  const dir = temp("dimensio-m8-req-");
  const file = path.join(dir, REQUEST_FILE);
  fs.writeFileSync(file, "﻿" + JSON.stringify({ action: "prepare", ttlMs: 5_000, requestedAt: Date.now() }));
  const req = readRetireRequest(dir);
  assert.equal(req?.action, "prepare");
  assert.equal(fs.existsSync(file), false, "读完就删");

  fs.writeFileSync(file, JSON.stringify({ action: "commit", force: true, requestedAt: Date.now() - 60 * 60_000 }));
  assert.equal(readRetireRequest(dir, Date.now()), null, "上一次部署残留的 commit 不许让新进程一起来就退出");
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, JSON.stringify({ action: "rm -rf", requestedAt: Date.now() }));
  assert.equal(readRetireRequest(dir), null);

  writeRetireStatus(dir, { retiring: true, runs: [] });
  const st = JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), "utf8"));
  assert.equal(st.retiring, true);
  assert.equal(st.pid, process.pid);
});

const caps = { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false };

// 修前没有排空：这一轮永远不结束——限时等，挂住直接判失败
async function settled(done: Promise<void>, ms = 8_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((r) => { timer = setTimeout(() => r("hung"), ms); });
  const out = await Promise.race([done.then(() => "done" as const), hung]);
  clearTimeout(timer);
  assert.equal(out, "done", "排空之后这一轮应当收尾");
}

// 一轮挂着的假模型：先（可选地）吐一段字，然后等到被中止
function hangingSession(root: string, firstText: string | null): Session {
  const session = createSession();
  const adapter: ProviderAdapter = {
    id: "openai", model: "fake", capabilities: caps,
    async *stream(_t, signal) {
      if (firstText) yield { e: "text_delta", text: firstText };
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  };
  session.state = new AgentState({
    adapter, system: "t", tools: [], budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(), permissionMode: "auto", memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
  return session;
}

test("冻结期间不起新 run；排空把在跑的轮按「服务重启」中止、写进转录并落盘", async () => {
  const root = temp("dimensio-m8-drain-");
  const session = hangingSession(root, "正在改第一个文件");
  const run = startRun(session, "改两个文件");
  // 全量并发跑时开跑前的准备（召回等）会慢不少：等事件本身，上限给足
  let timer: ReturnType<typeof setTimeout> | undefined;
  const streamed = await new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), 20_000);
    watchSession(session, (ev) => { if (ev.e === "text_delta") resolve(true); });
  });
  clearTimeout(timer);
  assert.ok(streamed, "第一段文字已经流出");
  assert.deepEqual(runningRuns().map((r) => r.sessionId), [session.id]);

  prepareRetire();
  const other = hangingSession(root, null);
  const refused = startRun(other, "新任务");
  assert.equal(refused.started, false);
  assert.equal(refused.retiring, true, "冻结期间不起新 run");
  dropSession(other.id);

  const drained = await drainSessions(5_000);
  await settled(run.done);
  assert.equal(drained, 1);
  const transcript = JSON.stringify(session.state!.messages);
  assert.match(transcript, /正在改第一个文件\\n\\n\[interrupted: the server restarted/, "已流出的文字照留，后面写明原因");
  assert.doesNotMatch(transcript, /interrupted by the user/, "不是用户停的");
  const onDisk = fs.readFileSync(path.join(process.env.SESSIONS_DIR!, `${session.id}.json`), "utf8");
  assert.match(onDisk, /the server restarted/, "排空时立即落盘");
  dropSession(session.id);
});

test("这一轮还没开口就被重启打断：也留一条只给模型看的边界", async () => {
  const root = temp("dimensio-m8-early-");
  const session = hangingSession(root, null);
  const run = startRun(session, "帮我查一下");
  for (let i = 0; i < 200 && !runningRuns().length; i++) await new Promise((r) => setTimeout(r, 10));
  await drainSessions(5_000);
  await settled(run.done);
  const last = session.state!.messages.at(-1)!;
  assert.equal(last.role, "assistant");
  assert.equal(last.internal, true, "只给模型看");
  assert.match(JSON.stringify(last.content), /the server restarted/);
  dropSession(session.id);
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("真 harness：部署脚本经请求文件冻结 → 新 run 回 503 → 强制排空后进程自己退出，转录写明被重启打断", { timeout: 90_000 }, async () => {
  // 假模型服务（OpenAI 兼容）：先吐一段字，然后一直挂着（这一轮在整个用例期间都在跑）
  const provider = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "working" } }] })}\n\n`);
    const beat = setInterval(() => res.write(": ping\n\n"), 200);
    res.on("close", () => clearInterval(beat));
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  const ws = temp("dimensio-m8-live-");
  const sessions = path.join(ws, "sessions");
  const cfgFile = path.join(ws, "runtime-config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ v: 1, provider: "openai", model: "deepseek-flash", thinking: "low" }));
  const port = await freePort();
  const TOKEN = "m8-DUMMY-process-token";
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
      SESSIONS_DIR: sessions,
      DIMENSIO_CONFIG_FILE: cfgFile,
      OPENAI_API_KEY: "FAKE-m8-openai-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}/v1`,
      BRIDGE_PORT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const base = `http://127.0.0.1:${port}`;
  const headers = { [INTERNAL_TOKEN_HEADER]: TOKEN, "content-type": "application/json" };
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
    assert.deepEqual(await getJson("/api/busy"), { running: false, runs: [], retiring: false });

    // 起一轮，读到 session 回执为止（之后断开，这一轮在服务端照跑）
    const first = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "长任务" }), signal: ctl.signal });
    const reader = first.body!.getReader();
    let buf = "";
    let sessionId = "";
    while (!sessionId) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const m = /"e":"session","sessionId":"([^"]+)"/.exec(buf);
      if (m) sessionId = m[1];
    }
    ctl.abort();
    assert.ok(sessionId, buf.slice(0, 300));
    const busy = await getJson("/api/busy");
    assert.equal(busy.running, true);
    assert.deepEqual(busy.runs.map((r: any) => r.sessionId), [sessionId]);

    // 部署脚本：请求文件 prepare → 状态文件出现、冻结生效
    fs.writeFileSync(path.join(sessions, REQUEST_FILE), JSON.stringify({ action: "prepare", ttlMs: 60_000, requestedAt: Date.now() }));
    let status: any = null;
    for (let i = 0; i < 50 && !status?.retiring; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { status = JSON.parse(fs.readFileSync(path.join(sessions, STATUS_FILE), "utf8")); } catch { /* 还没写 */ }
    }
    assert.equal(status?.retiring, true, "冻结生效并写回状态");
    assert.equal(status.runs.length, 1, "状态里能看到还在跑的那一轮");
    const refused = await fetch(`${base}/api/run`, { method: "POST", headers, body: JSON.stringify({ message: "新任务" }) });
    assert.equal(refused.status, 503);
    assert.equal(((await refused.json()) as any).code, "retiring");

    // 等不到空闲（这一轮挂着）→ 强制排空：进程自己退出
    fs.writeFileSync(path.join(sessions, REQUEST_FILE), JSON.stringify({ action: "commit", force: true, requestedAt: Date.now() }));
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([exited, new Promise<"timeout">((r) => { exitTimer = setTimeout(() => r("timeout"), 30_000); })]);
    clearTimeout(exitTimer);
    assert.equal(code, 0, `进程自己退出（不是被杀）：\n${out.slice(-800)}`);
    const rec = fs.readFileSync(path.join(sessions, `${sessionId}.json`), "utf8");
    assert.match(rec, /interrupted: the server restarted/, "转录写明被重启打断，并已落盘");
  } finally {
    ctl.abort();
    if (child.exitCode === null) killTree(child);
    provider.closeAllConnections();
    provider.close();
  }
});
