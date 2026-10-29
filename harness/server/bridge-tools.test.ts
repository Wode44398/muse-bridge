// bridge 本身（tools/bridgeapi.ts 的 BridgeManual / BridgeCall）：经 bridge 给 agent 的 HTTP 接口查手册、调操作。
// 起一个假的 bridge（127.0.0.1 随机端口），钉住：与设备工具同一把凭据、同一套可见性（独立跑没有、租户只认按人令牌）；
// 手册的目录 / 章 / 检索；不带 op 列出可用操作（设备 / 媒体组与不可用的不列）；执行带凭据、参数原样转、慢操作的前导空白；
// 审批：read 免审、write 跟权限档、danger 弹卡、设备 / 媒体 / 没有的 / 不可用的不弹卡直接回话；凭据被拒、连不上时的说法；
// 系统提示的 bridge 段只在工具可用时有。
import assert from "node:assert/strict";
import http from "node:http";
import test, { after } from "node:test";
import type { TestContext } from "node:test";
import { bridgeCallTool, bridgeManualTool, bridgeToolAvailable, resetBridgeCatalog } from "./tools/bridgeapi.ts";
import { toolDefs, toolMap } from "./tools/registry.ts";
import { callSubject, decide, EMPTY_RULES } from "./agent/permissions.ts";
import { systemPrompt } from "./agent/prompt.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const SECRET = "FAKE-bridge-secret-for-dimensio-tests";
const ctx = {} as ToolContext;
const textOf = (r: ToolRunResult) => r.content.map((b) => (b.t === "text" ? b.text : "")).join("\n");

const KEYS = ["BRIDGE_DEVICE_API", "BRIDGE_DEVICE_SECRET", "DIMENSIO_TENANT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function restore(): void {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetBridgeCatalog();
}
function useChannel(api: string | undefined, secret: string | undefined = SECRET): void {
  if (api === undefined) delete process.env.BRIDGE_DEVICE_API;
  else process.env.BRIDGE_DEVICE_API = api;
  if (secret === undefined) delete process.env.BRIDGE_DEVICE_SECRET;
  else process.env.BRIDGE_DEVICE_SECRET = secret;
  resetBridgeCatalog();
}
after(restore);

const OPS = [
  { name: "whoami", group: "core", title: "我是谁、能用什么", access: "read", slow: false, available: true },
  { name: "routines.create", group: "routines", title: "新建定时任务", access: "write", slow: false, available: true },
  { name: "routines.delete", group: "routines", title: "删除定时任务", access: "danger", slow: false, available: true },
  { name: "chat.wait", group: "chat", title: "等一个会话的结果", access: "read", slow: true, available: true },
  { name: "feedback.report", group: "feedback", title: "上报一个 bug", access: "danger", slow: false, available: true },
  { name: "plugins.toggle", group: "plugins", title: "打开 / 关闭一个插件", access: "write", slow: false, available: false, unavailableReason: "只有服务器主机能用" },
  { name: "devices.list", group: "devices", title: "列出我的设备", access: "read", slow: false, available: false, unavailableReason: "同机 agent 实例不从这里调" },
  { name: "media.image", group: "media", title: "生成图片", access: "write", slow: true, available: false, unavailableReason: "管理员没让 dimensio 生成媒体（设置 › Agent › Gemini）" },
  // 管理员在 设置 › Agent › Gemini 打开了 dimensio 时：媒体组照目录走（视频是 danger，每次弹卡）
  { name: "media.video", group: "media", title: "生成视频", access: "danger", slow: true, available: true },
];

// 假 bridge：凭据不对 401（同真接口）；手册回 markdown；操作回 { ok, op, data }
async function fakeBridge(t: TestContext): Promise<{ api: string; calls: { op: string; args: unknown; auth: string }[] }> {
  const calls: { op: string; args: unknown; auth: string }[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const md = (code: number, text: string) => {
      res.writeHead(code, { "Content-Type": "text/markdown" });
      res.end(text);
    };
    if (url.pathname.startsWith("/agent/manual")) {
      const topic = decodeURIComponent(url.pathname.slice("/agent/manual/".length));
      if (topic === "nope") return md(404, "# 没有这一章：nope");
      if (topic) return md(200, `# ${topic} 章\n正文`);
      const q = url.searchParams.get("q");
      return md(200, q ? `# 检索：${q}\n## 定时任务\n…` : "# bridge 手册\n- claude\n- routines");
    }
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(401, { ok: false, error: { code: "unauthorized", message: "要带 agent 密钥" } });
    if (url.pathname === "/agent/v1") return send(200, { ok: true, ops: OPS });
    const op = decodeURIComponent(url.pathname.slice("/agent/v1/".length));
    const args = raw ? JSON.parse(raw) : {};
    calls.push({ op, args, auth: String(req.headers.authorization) });
    if (op === "whoami") return send(200, { ok: true, op, data: { you: { kind: "member", account: "frank" } } });
    if (op === "chat.wait") {
      // 慢操作：先回 200 写空白保活，再给 JSON
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(" ");
      setTimeout(() => { res.write("\n"); res.end(JSON.stringify({ ok: true, op, data: { status: "done", text: "好了" } })); }, 30);
      return;
    }
    if (op === "routines.create") return send(400, { ok: false, error: { code: "bad_args", message: "缺少必填参数「prompt」", hint: "要做什么" } });
    return send(404, { ok: false, error: { code: "not_found", message: `没有操作「${op}」` } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { api: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls };
}

test("可见性：与设备工具同一把凭据——独立跑没有，回环 + 够长的凭据才有；租户只认按人令牌", () => {
  try {
    const names = () => toolDefs().map((d) => d.name);
    useChannel(undefined, undefined);
    assert.equal(bridgeToolAvailable(), false);
    assert.ok(!names().includes("BridgeManual") && !names().includes("BridgeCall"));
    useChannel("http://127.0.0.1:8787");
    assert.ok(names().includes("BridgeManual") && names().includes("BridgeCall"));
    useChannel("http://192.168.1.2:8787");
    assert.equal(bridgeToolAvailable(), false, "只认回环地址");
    useChannel("http://127.0.0.1:8787");
    process.env.DIMENSIO_TENANT = "1";
    assert.equal(bridgeToolAvailable(), false, "租户拿到主机密钥也不用");
    useChannel("http://127.0.0.1:8787", "dvt1.dimensio.dTp1c2Vy.FAKE-signature-for-tests");
    assert.equal(bridgeToolAvailable(), true);
  } finally {
    restore();
  }
});

test("BridgeManual：目录 / 整章 / 检索，没有的章给出路", async (t) => {
  const bridge = await fakeBridge(t);
  try {
    useChannel(bridge.api);
    const toc = await bridgeManualTool.run({}, ctx);
    assert.equal(toc.ok, true);
    assert.match(textOf(toc), /bridge 手册/);
    assert.match(textOf(await bridgeManualTool.run({ topic: "routines" }, ctx)), /# routines 章/);
    assert.match(textOf(await bridgeManualTool.run({ q: "定时 任务" }, ctx)), /检索：定时 任务/);
    const miss = await bridgeManualTool.run({ topic: "nope" }, ctx);
    assert.equal(miss.ok, false);
    assert.match(textOf(miss), /没有这一章[\s\S]*no arguments/);
  } finally {
    restore();
  }
});

test("BridgeCall：不带 op 列可用操作；执行带凭据、参数原样转；慢操作的保活空白；出错带 code 与 hint", async (t) => {
  const bridge = await fakeBridge(t);
  try {
    useChannel(bridge.api);
    const list = await bridgeCallTool.run({}, ctx);
    assert.equal(list.ok, true);
    const body = textOf(list);
    assert.match(body, /- whoami — 我是谁/);
    assert.match(body, /routines\.delete — 删除定时任务 \[danger, needs approval\]/);
    assert.match(body, /routines\.create — 新建定时任务 \[changes things\]/);
    for (const n of ["devices.list", "media.image", "plugins.toggle"]) assert.ok(!body.includes(n), n);
    assert.match(body, /media\.video — 生成视频 \[danger, needs approval\]/);

    const me = await bridgeCallTool.run({ op: "whoami" }, ctx);
    assert.equal(me.ok, true);
    assert.match(textOf(me), /"account": "frank"/);
    assert.equal(me.externalContent, true);
    assert.deepEqual(bridge.calls.at(-1), { op: "whoami", args: {}, auth: `Bearer ${SECRET}` });

    const slow = await bridgeCallTool.run({ op: "chat.wait", args: { sessionId: "s1", timeout: 30 } }, ctx);
    assert.equal(slow.ok, true, textOf(slow));
    assert.match(textOf(slow), /好了/);
    assert.deepEqual(bridge.calls.at(-1)?.args, { sessionId: "s1", timeout: 30 });

    const bad = await bridgeCallTool.run({ op: "routines.create", args: { name: "x" } }, ctx);
    assert.equal(bad.ok, false);
    assert.match(textOf(bad), /bad_args: 缺少必填参数「prompt」 \(要做什么\)/);

    const dev = await bridgeCallTool.run({ op: "devices.list" }, ctx);
    assert.equal(dev.ok, false);
    assert.match(textOf(dev), /Device\* tools/);
    assert.ok(!bridge.calls.some((c) => c.op === "devices.list"), "设备组根本不发给 bridge");
  } finally {
    restore();
  }
});

test("审批：read 免审、write 跟权限档、danger 弹卡；设备 / 没有的 / 不可用的不弹卡直接回话；规则按操作名记", async (t) => {
  const bridge = await fakeBridge(t);
  try {
    useChannel(bridge.api);
    const tools = toolMap();
    const plan = async (op: string, mode: "auto" | "read-only" = "auto", args: Record<string, unknown> = {}) => {
      const call = { op, args };
      const prepared = await bridgeCallTool.prepare!(call, ctx);
      const decision = decide(mode, "BridgeCall", tools, call, EMPTY_RULES, prepared?.confirm ? { confirm: prepared.confirm } : {});
      return { prepared, decision };
    };
    // read：只读档也能跑；不带 op（列目录）同样只读
    assert.equal((await plan("whoami", "read-only")).decision.effect, "allow");
    assert.equal(decide("read-only", "BridgeCall", tools, {}, EMPTY_RULES).effect, "allow");
    // write：auto 直接跑，只读档拦下
    assert.equal((await plan("routines.create")).decision.effect, "allow");
    assert.equal((await plan("routines.create", "read-only")).decision.effect, "deny");
    // danger：auto 也弹卡，卡上摆操作与参数
    const del = await plan("routines.delete", "auto", { id: "r1" });
    assert.equal(del.decision.effect, "ask");
    assert.match(del.decision.why ?? "", /删除定时任务/);
    assert.equal(del.prepared?.preview?.kind, "text");
    assert.match((del.prepared?.preview as { text: string }).text, /routines\.delete[\s\S]*"id": "r1"/);
    assert.equal((await plan("feedback.report")).decision.effect, "ask", "上报 bug 也要人批");
    // 「本会话都允许」按操作名记，不会一次放开全部
    assert.equal(callSubject("BridgeCall", { op: "routines.delete" }), "routines.delete");
    const allowDel = { allow: ["BridgeCall(routines.delete)"], deny: [], ask: [] };
    assert.equal(decide("auto", "BridgeCall", tools, { op: "routines.delete" }, allowDel, { confirm: del.prepared!.confirm! }).effect, "allow");
    const rep = await bridgeCallTool.prepare!({ op: "feedback.report" }, ctx);
    assert.equal(decide("auto", "BridgeCall", tools, { op: "feedback.report" }, allowDel, { confirm: rep!.confirm! }).effect, "ask");
    // 媒体组不再写死排除：开着的照常（视频要人批），关着的照目录说原因
    assert.equal((await plan("media.video")).decision.effect, "ask", "生成视频要人批");
    // 不弹卡直接回话
    assert.match((await plan("devices.list")).prepared?.veto?.content ?? "", /not available here/);
    assert.match((await plan("media.image")).prepared?.veto?.content ?? "", /设置 › Agent › Gemini/);
    assert.match((await plan("plugins.toggle")).prepared?.veto?.content ?? "", /只有服务器主机能用/);
    assert.match((await plan("no.such")).prepared?.veto?.content ?? "", /no operation "no\.such"/);
  } finally {
    restore();
  }
});

test("凭据被拒、连不上：错误说人话", async (t) => {
  const bridge = await fakeBridge(t);
  try {
    useChannel(bridge.api, "FAKE-wrong-secret-but-long-enough");
    const rejected = await bridgeCallTool.run({ op: "whoami" }, ctx);
    assert.equal(rejected.ok, false);
    assert.match(textOf(rejected), /rejected this instance's credential/);
    assert.equal(await bridgeCallTool.prepare!({ op: "whoami" }, ctx), null, "目录取不到时不拦，run 照实回错");
    assert.equal(bridgeCallTool.permissionView!({ op: "whoami" })?.effect, undefined, "目录没取到：按会改东西算");

    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as { port: number }).port;
    await new Promise<void>((r) => dead.close(() => r()));
    useChannel(`http://127.0.0.1:${port}`);
    const down = await bridgeManualTool.run({}, ctx);
    assert.equal(down.ok, false);
    assert.match(textOf(down), /Cannot reach bridge at http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    restore();
  }
});

test("系统提示：工具可用才有 bridge 段（手册、操作、bug 先诊断再确认再上报）", () => {
  const env = { root: "C:/ws", shell: "bash", platform: "win32", provider: "local", model: "q" };
  const off = systemPrompt(env);
  assert.ok(!off.includes("## Bridge"));
  const on = systemPrompt({ ...env, bridge: true });
  assert.match(on, /## Bridge \(the app hosting you\)/);
  assert.match(on, /BridgeManual first[\s\S]*feedback\.diagnose[\s\S]*AskUserQuestion[\s\S]*feedback\.report/);
  assert.ok(on.length - off.length < 1_600, `bridge 段要短（现在 ${on.length - off.length} 字）`);
});
