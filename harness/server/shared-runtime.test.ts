// 嵌在 bridge 里时终端 / 浏览器用 bridge 核心运行时的那一个（bridge-runtime.ts、tools/terminal/shared.ts、tools/browser/shared.ts）：
// 钉住：开关（凭据齐、没被 DIMENSIO_SHARED_RUNTIME 关掉、有命令行）、工作空间取沙箱根而不是模型给的、参数翻译、
// 结果翻译回 ToolRunResult、本地闸门（偏好档、控制面与 file:// 拦截）仍先过、连不上 bridge 照实报错不退回本地、能力位。
// 假 bridge 起在 127.0.0.1 随机端口。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";
import { terminalTool } from "./tools/terminal.ts";
import { setPrefs } from "./prefs.ts";
import { sharedBrowser, sharedTerminal } from "./bridge-runtime.ts";
import { protocolInfo } from "./protocol.ts";
import { getTermIfAny } from "./terminal.ts";
import { browserTool } from "./tools/browser.ts";
import { readPageTool } from "./tools/readpage.ts";
import { evalTool } from "./tools/evaljs.ts";
import { networkTool } from "./tools/network.ts";
import { existingBrowser } from "./cdp.ts";
import { disposeOwner } from "./resources.ts";

const SECRET = "FAKE-plugin-secret-for-shared-runtime";
const KEYS = ["BRIDGE_PLUGIN_API", "BRIDGE_PLUGIN_SECRET", "DIMENSIO_SHARED_RUNTIME", "DIMENSIO_TENANT", "DIMENSIO_TENANT_SHELL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];
after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* windows 句柄 */
    }
  }
  bridge.close();
});
const tmp = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-shared-"));
  roots.push(r);
  return r;
};

// —— 假 bridge ——
type Seen = { url: string; auth: string; agent: string; body: Record<string, any> };
const seen: Seen[] = [];
let reply: (url: string, body: Record<string, any>) => [number, unknown] = () => [200, { ok: true, content: [{ type: "text", text: "fine" }], isError: false }];
const bridge = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    const body = JSON.parse(buf || "{}");
    seen.push({ url: String(req.url), auth: String(req.headers.authorization), agent: String(req.headers["x-bridge-agent"]), body });
    const [status, out] = reply(String(req.url), body);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
});
await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", () => r()));
const API = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;

function embed(on = true): void {
  process.env.BRIDGE_PLUGIN_API = API;
  process.env.BRIDGE_PLUGIN_SECRET = SECRET;
  if (on) delete process.env.DIMENSIO_SHARED_RUNTIME;
  else process.env.DIMENSIO_SHARED_RUNTIME = "0";
  delete process.env.DIMENSIO_TENANT;
  delete process.env.DIMENSIO_TENANT_SHELL;
}
beforeEach(() => {
  seen.length = 0;
  reply = () => [200, { ok: true, content: [{ type: "text", text: "fine" }], isError: false }];
});

const text = (r: { content: Array<{ t: string; text?: string }> }) => r.content.map((b) => b.text ?? "").join("");
function makeCtx(root: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1_000, bashMaxTimeoutMs: 1_000 },
    agentSeesImages: false,
    ownerId: "chat-1",
    ...extra,
  };
}

test("开关：凭据齐才共享；DIMENSIO_SHARED_RUNTIME=0 / off 关掉；没有命令行的成员不共享；能力位跟着走", () => {
  embed();
  assert.equal(sharedTerminal(), true);
  assert.ok(protocolInfo().capabilities.includes("shared-terminal"));
  process.env.DIMENSIO_SHARED_RUNTIME = "off";
  assert.equal(sharedTerminal(), false);
  assert.ok(!protocolInfo().capabilities.includes("shared-terminal"));
  embed();
  process.env.BRIDGE_PLUGIN_API = "http://example.com:80";
  assert.equal(sharedTerminal(), false, "凭据只发给本机回环");
  embed();
  process.env.DIMENSIO_TENANT = "1";
  process.env.DIMENSIO_TENANT_SHELL = "0";
  assert.equal(sharedTerminal(), false);
  delete process.env.BRIDGE_PLUGIN_API;
  delete process.env.DIMENSIO_TENANT;
  delete process.env.DIMENSIO_TENANT_SHELL;
  assert.equal(sharedTerminal(), false, "独立跑（没有那组环境变量）走本地");
});

test("Terminal 共享：转给 bridge，ws 取沙箱根（模型给的不认），只带终端认的参数；结果装回；terminal 事件照发", async () => {
  embed();
  const root = tmp();
  const events: unknown[] = [];
  const ctx = makeCtx(root, { emit: (ev) => events.push(ev) });
  reply = () => [200, { ok: true, content: [{ type: "text", text: "hello from bridge" }], isError: false }];
  const r = await terminalTool.run({ action: "run", command: "echo hi", waitSec: 5, ws: "C:\\elsewhere", junk: 1 }, ctx);
  assert.equal(r.ok, true);
  assert.match(text(r), /hello from bridge/);
  assert.equal(r.outcome, "在共享终端里跑了命令");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/internal/agent-term");
  assert.equal(seen[0].auth, `Bearer ${SECRET}`);
  assert.equal(seen[0].agent, "dimensio");
  assert.equal(seen[0].body.ws, ctx.sandbox.root);
  assert.deepEqual(seen[0].body.args, { action: "run", command: "echo hi", waitSec: 5 });
  assert.deepEqual(events.map((e) => (e as { e: string; action: string }).action), ["run"]);
  assert.equal(getTermIfAny(root), null, "本地没起壳");

  // 只读动作不发 terminal 事件；wait / read(screen) 这些 bridge 才有的参数照带
  events.length = 0;
  await terminalTool.run({ action: "wait", until: "/done/", quietSec: 1, waitSec: 3 }, ctx);
  assert.deepEqual(seen[1].body.args, { action: "wait", until: "/done/", quietSec: 1, waitSec: 3 });
  await terminalTool.run({ action: "read", screen: true }, ctx);
  assert.deepEqual(seen[2].body.args, { action: "read", screen: true });
  assert.deepEqual(events, []);

  // bridge 回 isError：如实失败
  reply = () => [200, { ok: true, content: [{ type: "text", text: "run 需要 command" }], isError: true }];
  const bad = await terminalTool.run({ action: "run", command: " " }, ctx);
  assert.equal(bad.ok, false);
  assert.match(text(bad), /run 需要 command/);

  // 门禁拒（例如命令行权限没了）：照实报，不退回本地
  reply = () => [403, { error: "该功能仅对完整权限用户开放", code: "no_shell" }];
  const denied = await terminalTool.run({ action: "status" }, ctx);
  assert.equal(denied.ok, false);
  assert.match(text(denied), /完整权限/);
});

test("Terminal 共享：偏好档仍在本地先拦；bridge 连不上照实报错", async () => {
  embed();
  const root = tmp();
  const ctx = makeCtx(root);
  try {
    await setPrefs({ "workspace.terminal": "read" });
    const typed = await terminalTool.run({ action: "run", command: "echo hi" }, ctx);
    assert.equal(typed.ok, false);
    assert.equal(seen.length, 0, "只读档：没去 bridge");
    await terminalTool.run({ action: "wait" }, ctx);
    assert.equal(seen.length, 1, "wait 只看屏幕，只读档也放行");
    await setPrefs({ "workspace.terminal": "off" });
    assert.equal((await terminalTool.run({ action: "read" }, ctx)).ok, false);
    assert.equal(seen.length, 1);
  } finally {
    await setPrefs({ "workspace.terminal": null });
  }
  process.env.BRIDGE_PLUGIN_API = "http://127.0.0.1:9";
  const down = await terminalTool.run({ action: "status" }, ctx);
  assert.equal(down.ok, false);
  assert.match(text(down), /Cannot reach bridge|did not answer/);
  assert.equal(getTermIfAny(root), null, "没悄悄退回本地终端");
});

test("Terminal 本地（共享关掉）：wait / resize 回不支持，read 照旧走本地", async () => {
  embed(false);
  const root = tmp();
  const ctx = makeCtx(root);
  const w = await terminalTool.run({ action: "wait" }, ctx);
  assert.equal(w.ok, false);
  assert.match(text(w), /only available in bridge/);
  assert.match(text(await terminalTool.run({ action: "read" }, ctx)), /not running/);
  assert.equal(seen.length, 0);
});

// —— 浏览器 ——
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000208060000007b1a43ad", "hex").toString("base64");
const actOf = (s: Seen) => (s.body.args ?? {}) as Record<string, any>;
const browserCalls = () => seen.filter((s) => s.url === "/api/internal/agent-browser");

test("Browser 共享：开关与能力位；navigate 转给 bridge（会话键 = 会话 id，ws = 沙箱根，带上本地控制面端口），页面动了发 browser 事件", async () => {
  embed();
  assert.equal(sharedBrowser(), true);
  assert.ok(protocolInfo().capabilities.includes("shared-browser"));
  const root = tmp();
  const ctx = makeCtx(root, { ownerId: "sess-nav" });
  reply = () => [200, { ok: true, content: [{ type: "text", text: "已打开 https://example.com/" }], isError: false, url: "https://example.com/", tabs: [], activity: true, data: null }];
  const r = await browserTool.run({ action: "navigate", url: "https://example.com/" }, ctx);
  assert.equal(r.ok, true, text(r));
  const b = browserCalls()[0]!;
  assert.equal(b.auth, `Bearer ${SECRET}`);
  assert.deepEqual([b.body.ws, b.body.session, b.body.op], [ctx.sandbox.root, "sess-nav", "act"]);
  assert.deepEqual(actOf(b), { action: "navigate", url: "https://example.com/" });
  assert.ok(Array.isArray(b.body.denyPorts) && b.body.denyPorts.includes(5178), "本地认得的控制面端口一起报给 bridge");
  assert.deepEqual(r.events, [{ e: "browser", url: "https://example.com/" }]);
  assert.equal(existingBrowser("sess-nav"), undefined, "本地 cdp 池没为这个会话启动");
  process.env.DIMENSIO_SHARED_RUNTIME = "0";
  assert.ok(!protocolInfo().capabilities.includes("shared-browser"));
});

test("Browser 共享：本地闸门先过——控制面、过不了闸的 file://、没有 Preview 的 /path、attach 都不去 bridge", async () => {
  embed();
  const root = tmp();
  const ctx = makeCtx(root, { ownerId: "sess-gate" });
  const outside = path.join(tmp(), "x.html");
  fs.writeFileSync(outside, "<p>x</p>");
  for (const url of ["http://127.0.0.1:8799/api/info", "file:///" + outside.replace(/\\/g, "/"), "/index.html"]) {
    const r = await browserTool.run({ action: "navigate", url }, ctx);
    assert.equal(r.ok, false, url);
  }
  const at = await browserTool.run({ action: "attach", port: 9222 }, ctx);
  assert.equal(at.ok, false);
  assert.match(text(at), /not available here/);
  assert.equal(browserCalls().length, 0);
});

test("Browser 共享：参数翻译（colorScheme→scheme、截图的 ref / clip / waitMs、多选 value、upload 走沙箱解析）；batch 本地逐步转", async () => {
  embed();
  const root = tmp();
  fs.writeFileSync(path.join(root, "a.txt"), "hi");
  const ctx = makeCtx(root, { ownerId: "sess-args", agentSeesImages: true });
  reply = (_u, body) => {
    const a = body.args?.action;
    if (a === "screenshot") return [200, { ok: true, content: [{ type: "image", data: PNG, mimeType: "image/png" }, { type: "text", text: "url: https://x/ · viewport 1280×900" }], isError: false, url: "https://x/", activity: true, data: { settle: { waitedMs: 300, stillRunning: 0 } } }];
    return [200, { ok: true, content: [{ type: "text", text: `did ${a}` }], isError: false, url: "https://x/", activity: false, data: null }];
  };
  await browserTool.run({ action: "resize", preset: "mobile", colorScheme: "dark" }, ctx);
  assert.deepEqual(actOf(browserCalls()[0]!), { action: "resize", preset: "mobile", scheme: "dark" });
  const shot = await browserTool.run({ action: "screenshot", ref: 4 }, ctx);
  assert.deepEqual(actOf(browserCalls()[1]!), { action: "screenshot", element_ref: 4, settle: true });
  assert.equal(shot.ok, true);
  assert.equal(shot.feedback?.[0]?.t, "image", "多模态模型拿到图片本身");
  assert.ok(shot.events?.some((e) => e.e === "screenshot"), "界面那边出截图");
  assert.match(text(shot), /Waited 300 ms/);
  await browserTool.run({ action: "screenshot", clip: { x: 1, y: 2, width: 30, height: 40 }, waitMs: 0 }, ctx);
  assert.deepEqual(actOf(browserCalls()[2]!), { action: "screenshot", region: [1, 2, 30, 40], wait_ms: 0, settle: false });
  await browserTool.run({ action: "set_value", ref: 2, value: "a\nb" }, ctx);
  assert.deepEqual(actOf(browserCalls()[3]!).value, ["a", "b"]);
  await browserTool.run({ action: "upload", files: ["a.txt"], ref: 1 }, ctx);
  assert.deepEqual(actOf(browserCalls()[4]!).files, [path.join(ctx.sandbox.root, "a.txt")]);
  const up = await browserTool.run({ action: "upload", files: ["../../etc/passwd"] }, ctx);
  assert.equal(up.ok, false, "越界的路径本地就拒");
  assert.equal(browserCalls().length, 5);
  const batch = await browserTool.run({ action: "batch", actions: [{ action: "click", ref: 1 }, { action: "key", key: "enter" }] }, ctx);
  assert.equal(batch.ok, true, text(batch));
  assert.deepEqual(browserCalls().slice(5).map((s) => actOf(s).action), ["click", "key"]);
});

test("Browser 共享：dprprobe 的结论在本地出成完成证据；bridge 报错照实回、不退回本地浏览器", async () => {
  embed();
  const ctx = makeCtx(tmp(), { ownerId: "sess-dpr" });
  reply = () => [200, { ok: true, content: [{ type: "text", text: "没通过" }], isError: true, url: "https://x/", data: { dprprobe: { dpr: 2, passed: false, canvasCount: 1, problems: ["canvas a: grew"] } } }];
  const bad = await browserTool.run({ action: "dprprobe" }, ctx);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.verification, { passed: false, detail: "canvas DPR probe @2 FAILED: canvas a: grew" });
  assert.equal(actOf(browserCalls()[0]!).dpr, 2);
  reply = () => [200, { ok: true, content: [{ type: "text", text: "ok" }], isError: false, url: "https://x/", data: { dprprobe: { dpr: 2, passed: true, canvasCount: 3, problems: [] } } }];
  assert.equal((await browserTool.run({ action: "dprprobe" }, ctx)).verification?.passed, true);
  reply = () => [403, { error: "「内置浏览器」插件没开", code: "plugin_off" }];
  const off = await browserTool.run({ action: "tabs" }, ctx);
  assert.equal(off.ok, false);
  assert.match(text(off), /插件没开/);
  assert.equal(existingBrowser("sess-dpr"), undefined);
});

test("Eval / Network 共享：verify 证据按 bridge 带回的值在本地判", async () => {
  embed();
  const ctx = makeCtx(tmp(), { ownerId: "sess-eval" });
  const evalReply = (isError: boolean, data: unknown, t = "true") => () => [200, { ok: true, content: [{ type: "text", text: t }], isError, url: "https://x/", data }] as [number, unknown];
  reply = evalReply(false, { eval: { threw: false, type: "boolean", value: true } });
  const pass = await evalTool.run({ js: "1===1", verify: true }, ctx);
  assert.deepEqual([pass.ok, pass.verification?.passed], [true, true]);
  reply = evalReply(false, { eval: { threw: false, type: "boolean", value: false } }, "false");
  const no = await evalTool.run({ js: "1===2", verify: true }, ctx);
  assert.deepEqual([no.ok, no.verification?.passed], [false, false]);
  reply = evalReply(false, { eval: { threw: false, type: "number" } }, "3");
  const malformed = await evalTool.run({ js: "3", verify: true }, ctx);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.verification, undefined, "不是布尔：写法问题，不记证据");
  reply = evalReply(true, { eval: { threw: true, exception: "Error" } }, "浏览器操作失败：Error: count was 3");
  assert.equal((await evalTool.run({ js: "x", verify: true }, ctx)).verification?.passed, false, "脚本自己 throw 的算一次失败的检查");
  reply = evalReply(true, { eval: { threw: true, exception: "SyntaxError" } }, "SyntaxError");
  assert.equal((await evalTool.run({ js: "(", verify: true }, ctx)).verification, undefined);
  reply = evalReply(false, { eval: { threw: false, type: "string" } }, '"sk-ant-api03-' + "A".repeat(40) + '"');
  assert.doesNotMatch(text(await evalTool.run({ js: "localStorage.key" }, ctx)), /sk-ant-api03-A{40}/, "出口照样脱敏");

  const rows = [{ id: "1", url: "https://x/api/a", method: "GET", status: 500, state: "done", error: "" }, { id: "2", url: "https://x/api/a", method: "GET", status: 200, state: "done", error: "" }];
  reply = () => [200, { ok: true, content: [{ type: "text", text: "list" }], isError: false, url: "https://x/", data: { network: rows } }];
  const net = await networkTool.run({ filter: "/api/a", verify: true, expectedStatus: 200 }, ctx);
  assert.deepEqual([net.ok, net.verification?.passed], [true, true]);
  const last = browserCalls().at(-1)!;
  assert.deepEqual(actOf(last), { action: "network", lines: 60, query: "/api/a" });
  const miss = await networkTool.run({ filter: "/api/a", verify: true, expectedStatus: 201 }, ctx);
  assert.deepEqual([miss.ok, miss.verification?.passed], [false, false]);
  const invalid = await networkTool.run({ verify: true }, ctx);
  assert.equal(invalid.verification?.passed, false);
});

test("ReadPage 共享：脱敏 + 外部内容提示；落在过不了闸的本地文件上就扣下内容、退回空白页", async () => {
  embed();
  const root = tmp();
  const ctx = makeCtx(root, { ownerId: "sess-read" });
  reply = () => [200, { ok: true, content: [{ type: "text", text: 'url: https://x/\n- button "Go" [ref1]' }], isError: false, url: "https://x/", data: null }];
  const r = await readPageTool.run({ filter: "interactive" }, ctx);
  assert.equal(r.ok, true);
  assert.match(text(r), /\[ref1\]/);
  assert.deepEqual(actOf(browserCalls()[0]!), { action: "read_page", filter: "interactive" });
  const secret = path.join(tmp(), "outside.html");
  fs.writeFileSync(secret, "secret");
  reply = (_u, body) => (body.args?.action === "navigate"
    ? [200, { ok: true, content: [{ type: "text", text: "blank" }], isError: false, url: "about:blank", data: null }]
    : [200, { ok: true, content: [{ type: "text", text: "TOP SECRET" }], isError: false, url: "file:///" + secret.replace(/\\/g, "/"), data: null }]);
  const leak = await readPageTool.run({}, ctx);
  assert.equal(leak.ok, false);
  assert.doesNotMatch(text(leak), /TOP SECRET/);
  assert.deepEqual(actOf(browserCalls().at(-1)!), { action: "navigate", url: "about:blank" });
});

test("Browser 共享的生命周期：会话删除时让 bridge 关掉这一份并忘掉隔离开关；共享关掉时走本地、不碰 bridge", async () => {
  embed();
  const ctx = makeCtx(tmp(), { ownerId: "sess-life" });
  reply = () => [200, { ok: true, content: [{ type: "text", text: "ok" }], isError: false, url: "about:blank", data: null }];
  await browserTool.run({ action: "tabs" }, ctx);
  seen.length = 0;
  disposeOwner("sess-life", "delete", ["browser"]);
  await new Promise((r) => setTimeout(r, 200));
  const close = browserCalls()[0]!;
  assert.deepEqual([close.body.session, close.body.op, close.body.forget, close.body.ws], ["sess-life", "close", true, ctx.sandbox.root]);

  embed(false);
  seen.length = 0;
  const local = await browserTool.run({ action: "close" }, makeCtx(tmp(), { ownerId: "sess-local" }));
  assert.match(text(local), /no browser open/);
  assert.equal(seen.length, 0);
});
