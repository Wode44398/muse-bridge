// S1（#12、#38①）+ #65 回归：
//   · 控制面一律要令牌：「回环 + 无 Origin」「回环 + 白名单 Origin」都不再免令牌；
//   · agent 的 Browser / WebFetch 碰不到 harness / bridge / 开发页 / 桌面壳的回环端口；
//   · agent 写的活动类型文件经 harness 文件接口只能以纯文本 + 禁执行交给浏览器。
// 探针原型：竞品拆解/04-codex/笔记/probe-control-plane-origin.ts
//（修前：Bash curl、agent 浏览器同源 fetch 两种写法、5178 端口页面，四种来源 authorizedWithoutToken:true）。
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import express from "express";
import { apiRequestAuthorized, INTERNAL_TOKEN_HEADER, QUERY_TOKEN_PARAM } from "./api-auth.ts";
import { controlPlanePortBlock, controlPlaneUrlBlock, isLoopbackHost } from "./control-plane.ts";
import { inertFileHeaders } from "./inert-file.ts";
import { protocolInfo } from "./protocol.ts";
import { browserTool } from "./tools/browser.ts";
import { webfetchTool } from "./tools/webfetch.ts";
import { existingSharedBrowser, releaseBrowser } from "./cdp.ts";
import { killTree } from "./tools/bash.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "s1-process-only-token";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
const ENV_KEYS = ["PORT", "BRIDGE_PORT", "DIMENSIO_CONTROL_PORTS", "BRIDGE_DESKTOP_CDP_PORT", "BRIDGE_DESKTOP_BROKER"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

function request(opts: { origin?: string; header?: string; method?: string; query?: Record<string, unknown> }) {
  return {
    method: opts.method ?? "GET",
    query: opts.query ?? {},
    get(name: string) {
      const k = name.toLowerCase();
      if (k === "origin") return opts.origin;
      if (k === INTERNAL_TOKEN_HEADER) return opts.header;
      return undefined;
    },
  } as any;
}

const text = (r: ToolRunResult) => r.content.map((b: any) => b.text ?? "").join("\n");

test("S1: no loopback / browser-origin shortcut — every API request needs the token", () => {
  for (const origin of [
    undefined, // Bash curl / WebFetch —— #12 的原始场景
    "http://127.0.0.1:8799", // agent 浏览器打开 8799 后的同源 fetch —— #38①
    "http://localhost:8799",
    "http://localhost:5178", // Preview 起在 dev UI 白名单端口上的任意页面
    "https://evil.example", // 外站对照组
  ]) {
    assert.equal(apiRequestAuthorized(request({ origin }), TOKEN), false, `no token from ${origin ?? "(no Origin)"}`);
    assert.equal(apiRequestAuthorized(request({ origin, header: TOKEN }), TOKEN), true, `token from ${origin ?? "(no Origin)"}`);
  }
  assert.equal(apiRequestAuthorized(request({ header: "wrong" }), TOKEN), false);
  assert.equal(apiRequestAuthorized(request({ header: TOKEN }), undefined), false, "no configured token opens nothing");
});

test("S1: the query token opens GET/HEAD resources only, and only under its own name", () => {
  assert.equal(apiRequestAuthorized(request({ query: { [QUERY_TOKEN_PARAM]: TOKEN } }), TOKEN), true);
  assert.equal(apiRequestAuthorized(request({ method: "HEAD", query: { [QUERY_TOKEN_PARAM]: TOKEN } }), TOKEN), true);
  assert.equal(apiRequestAuthorized(request({ method: "POST", query: { [QUERY_TOKEN_PARAM]: TOKEN } }), TOKEN), false);
  // bridge 的 ?token= 是 bridge 管理员令牌，永远不当 harness 令牌用。
  assert.equal(apiRequestAuthorized(request({ query: { token: TOKEN } }), TOKEN), false);
  assert.equal(apiRequestAuthorized(request({ query: { [QUERY_TOKEN_PARAM]: [TOKEN] } }), TOKEN), false);
});

test("S1: the control-plane block list covers harness, bridge, dev UI, desktop shell and every loopback spelling", () => {
  process.env.PORT = "8811";
  process.env.BRIDGE_PORT = "8810";
  process.env.DIMENSIO_CONTROL_PORTS = "9999";
  process.env.BRIDGE_DESKTOP_CDP_PORT = "57152";
  process.env.BRIDGE_DESKTOP_BROKER = "http://127.0.0.1:57160/secret";
  for (const url of [
    "http://127.0.0.1:8811/api/config",
    "http://localhost:8811/",
    "http://[::1]:8811/",
    "http://127.1:8811/",
    "http://2130706433:8811/",
    "http://[::ffff:127.0.0.1]:8811/",
    "http://0.0.0.0:8811/",
    "http://app.localhost:8811/",
    "http://127.0.0.1:8810/api/chat",
    "http://localhost:5178/",
    "http://127.0.0.1:9999/",
    "ws://127.0.0.1:57152/devtools/browser/x",
    "http://127.0.0.1:57160/target",
  ]) {
    assert.ok(controlPlaneUrlBlock(url), `${url} must be blocked`);
  }
  for (const url of [
    "http://127.0.0.1:3000/",
    "http://localhost:5173/",
    "https://example.com:8811/",
    "http://192.168.1.20:8811/",
    "file:///C:/x.txt",
    "not a url",
  ]) {
    assert.equal(controlPlaneUrlBlock(url), null, `${url} must pass`);
  }
  assert.ok(controlPlanePortBlock(57152), "desktop shell DevTools port");
  assert.ok(controlPlanePortBlock(8811));
  assert.equal(controlPlanePortBlock(9222), null, "an app's own DevTools port stays attachable");
  assert.equal(isLoopbackHost("[::ffff:7f00:1]"), true);
  assert.equal(isLoopbackHost("example.com"), false);
});

function toolCtx(root: string): ToolContext {
  return {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    ownerId: "s1-test",
  };
}

test("S1: Browser refuses control-plane navigate / tab_new / attach without launching a browser", async () => {
  process.env.PORT = "8811";
  process.env.BRIDGE_PORT = "8810";
  const ctx = toolCtx(temp("dimensio-s1-browser-"));
  try {
    for (const args of [
      { action: "navigate", url: "http://127.0.0.1:8811/" },
      { action: "navigate", url: "http://localhost:8810/api/chat" },
      { action: "tab_new", url: "http://localhost:5178/" },
      { action: "attach", port: 8811 },
    ]) {
      const r = await browserTool.run(args, ctx);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.match(text(r), /control plane/, JSON.stringify(args));
    }
    assert.ok(!existingSharedBrowser(), "a refused navigation must not have launched the shared browser");
  } finally {
    releaseBrowser("s1-test");
  }
});

test("S1: WebFetch refuses the control plane before any network I/O", async () => {
  process.env.PORT = "8811";
  const r = await webfetchTool.run({ url: "http://127.0.0.1:8811/api/config" }, toolCtx(temp("dimensio-s1-fetch-")));
  assert.equal(r.ok, false);
  assert.equal(r.summary, "control plane");
});

async function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

test("#65: active file types leave harness as inert text; images keep their type", async () => {
  const dir = temp("dimensio-s1-inert-");
  const files: Record<string, string> = {
    "page.html": "<script>fetch('/api/config')</script>",
    "app.js": "alert(1)",
    "feed.xml": "<?xml version='1.0'?><x/>",
    "pic.svg": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    "note.txt": "plain",
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  fs.writeFileSync(path.join(dir, "dot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const app = express();
  app.get("/f/:name", (req, res) => {
    const abs = path.join(dir, req.params.name);
    inertFileHeaders(res, abs);
    res.sendFile(abs);
  });
  const srv = await listen(app);
  try {
    const head = async (name: string) => {
      const r = await fetch(`http://127.0.0.1:${srv.port}/f/${name}`);
      await r.arrayBuffer();
      return r.headers;
    };
    for (const name of ["page.html", "app.js", "feed.xml"]) {
      const h = await head(name);
      assert.match(h.get("content-type") ?? "", /^text\/plain/, `${name} must be served as text`);
      assert.equal(h.get("content-security-policy"), "sandbox", name);
      assert.equal(h.get("x-content-type-options"), "nosniff", name);
    }
    const svg = await head("pic.svg");
    assert.match(svg.get("content-type") ?? "", /^image\/svg\+xml/, "SVG stays an image so <img> previews keep working");
    assert.match(svg.get("content-security-policy") ?? "", /sandbox/);
    const png = await head("dot.png");
    assert.match(png.get("content-type") ?? "", /^image\/png/);
    assert.equal(png.get("content-security-policy"), null);
    assert.equal(png.get("x-content-type-options"), "nosniff");
    assert.match((await head("note.txt")).get("content-type") ?? "", /^text\/plain/);
  } finally {
    await srv.close();
  }
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("S1 live: a real harness opens only to its token; standalone prints the dev UI address; #65 on /api/dock/file", { timeout: 90_000 }, async () => {
  const ws = temp("dimensio-s1-live-");
  fs.writeFileSync(path.join(ws, "page.html"), "<script>fetch('/api/config')</script>");
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd: path.join(here, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DIMENSIO_HOST: "127.0.0.1",
      DIMENSIO_INTERNAL_TOKEN: "", // 独立运行：走 dev 令牌
      DIMENSIO_DEV_TOKEN: TOKEN,
      HARNESS_ENV_FILE: path.join(ws, "no-such.env"), // 不加载真实 key
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
  const withToken = { [INTERNAL_TOKEN_HEADER]: TOKEN };
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const r = await fetch(`${base}/api/info`, { headers: withToken });
        await r.arrayBuffer();
        if (r.status === 200) break;
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`harness did not come up:\n${out}`);
      await new Promise((r) => setTimeout(r, 200));
    }

    const status = async (p: string, init: RequestInit = {}) => {
      const r = await fetch(base + p, init);
      await r.arrayBuffer();
      return r;
    };
    // 修前全部 200：Bash curl（无 Origin）、agent 浏览器同源页、5178 页面。
    assert.equal((await status("/api/info")).status, 401, "no token, no Origin (curl)");
    assert.equal((await status("/api/info", { headers: { origin: base } })).status, 401, "same-origin page without token");
    assert.equal((await status("/api/info", { headers: { origin: "http://localhost:5178" } })).status, 401, "5178 page without token");
    assert.equal(
      (await status("/api/config", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" })).status,
      401,
      "a same-origin page cannot flip the config",
    );
    const ok = await status("/api/info", { headers: withToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-dimensio-api-guard"), "1");
    assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
    const info = (await (await fetch(`${base}/api/info`, { headers: withToken })).json()) as { build?: { codeSha?: string }; protocol?: unknown };
    assert.match(String(info.build?.codeSha ?? ""), /^[0-9a-f]{12}$/, "S9: /api/info says which code this process runs");
    assert.deepEqual(info.protocol, protocolInfo(), "M10: /api/info carries the protocol version, minClient and capabilities");
    assert.equal((await status(`/api/info?${QUERY_TOKEN_PARAM}=${TOKEN}`)).status, 200, "GET resource query token");
    assert.equal((await status(`/api/info?token=${TOKEN}`)).status, 401, "bridge's ?token= name is not ours");
    assert.equal(
      (await status(`/api/config?${QUERY_TOKEN_PARAM}=${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
      401,
      "query token never authorizes a write",
    );
    const pre = await status("/api/config", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5178", "access-control-request-method": "POST", "access-control-request-headers": INTERNAL_TOKEN_HEADER },
    });
    assert.equal(pre.status, 204, "CORS preflight carries no token and must still answer");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", new RegExp(INTERNAL_TOKEN_HEADER));

    const q = new URLSearchParams({ ws, path: "page.html" });
    const file = await status(`/api/dock/file?${q}`, { headers: withToken });
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") ?? "", /^text\/plain/, "#65: agent-written HTML is served as text");
    assert.equal(file.headers.get("content-security-policy"), "sandbox");

    assert.match(out, new RegExp(`#dimensio-token=${TOKEN}`), "standalone run prints the dev UI address with its token");
  } finally {
    killTree(child);
  }
});
