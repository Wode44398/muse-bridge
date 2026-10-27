// 设备工具（tools/localpc.ts 的 DeviceInspect / DeviceAct / DeviceBrowser / DeviceShell / DeviceFiles / DevicePorts）：
// 经 bridge 的内部设备接口操作用户登记的电脑。起一个假的 bridge 内部接口（127.0.0.1 随机端口），钉住：两个环境变量都在才可见、
// 租户只认按人令牌（dvt1.…）；请求带凭据、by / frameKey = dimensio、device 原样转给 bridge；status 列设备、带本会话连接的那台；
// 截图按新坐标帧排版并进会话事件；batch 中途停下照排；会话连接（use）之后省略 device 就是它；浏览器 / 命令 / 文件互拷 / 端口转发；
// 档位不够、连不上、密钥不对时的说法。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { TestContext } from "node:test";
import {
  deviceActTool, deviceBrowserTool, deviceFilesTool, deviceInspectTool, devicePortsTool, deviceShellTool, deviceToolAvailable,
} from "./tools/localpc.ts";
import { toolDefs } from "./tools/registry.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const SECRET = "FAKE-device-secret-for-dimensio-tests";
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const ctx = {} as ToolContext; // 没有 ownerId：截图事件退回 dataUri，不落会话资产

const KEYS = ["BRIDGE_DEVICE_API", "BRIDGE_DEVICE_SECRET", "DIMENSIO_TENANT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function restore(): void {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
function useChannel(api: string | undefined, secret: string | undefined = SECRET): void {
  if (api === undefined) delete process.env.BRIDGE_DEVICE_API;
  else process.env.BRIDGE_DEVICE_API = api;
  if (secret === undefined) delete process.env.BRIDGE_DEVICE_SECRET;
  else process.env.BRIDGE_DEVICE_SECRET = secret;
}
after(restore);

const textOf = (r: ToolRunResult) => r.content.map((b) => (b.t === "text" ? b.text : "")).join("\n");

type Dev = { id: string; name: string; online: boolean; sameMachine?: boolean; kind: string; lastOfflineAt?: string; client: { tier: string; version: string; os: string; caps?: string[] } | null };
const DEVICES: Dev[] = [
  { id: "dev-pc", name: "台式机", online: true, sameMachine: true, kind: "desktop", client: { tier: "control", version: "7.0.0", os: "Windows 11", caps: ["fs.chunk", "http"] } },
  { id: "dev-lap", name: "Laptop", online: true, sameMachine: false, kind: "desktop", client: { tier: "observe", version: "7.0.0", os: "Windows 10" } },
  { id: "dev-old", name: "旧电脑", online: false, kind: "desktop", lastOfflineAt: "2026-10-20T13:05:00.000Z", client: null },
];
const DEVICE_FILE = "C:\\Users\\me\\report.bin";

// 假 bridge：凭据不对一律 404（同真接口）；device-op 按设备档位与动作回结果；会话连接按 session 记
async function fakeBridge(t: TestContext): Promise<{ api: string; ops: Record<string, any>[]; files: Map<string, Buffer>; links: Map<string, string> }> {
  const ops: Record<string, any>[] = [];
  const files = new Map<string, Buffer>([[DEVICE_FILE, Buffer.from("device-bytes")]]);
  const links = new Map<string, string>();
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${SECRET}`) return send(404, { error: "not found" });
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/api/internal/devices") {
      const sid = url.searchParams.get("session") ?? "";
      return send(200, { enabled: true, devices: DEVICES, link: (sid && links.get(sid)) || "" });
    }
    if (req.method !== "POST") return send(404, { error: "not found" });
    const body = JSON.parse(raw) as Record<string, any>;
    if (url.pathname === "/api/internal/device-link") {
      const want = String(body.link ?? "");
      const hit = DEVICES.find((d) => d.id === want || d.name.toLowerCase() === want.toLowerCase());
      if (want && want !== "none" && !hit) return send(200, { ok: false, error: `找不到设备「${want}」` });
      if (want) links.set(body.session, hit ? hit.id : "none");
      else links.delete(body.session);
      return send(200, { ok: true, link: links.get(body.session) ?? "" });
    }
    if (url.pathname === "/api/internal/device-forward") {
      ops.push({ forward: body });
      if (body.action === "list") return send(200, { ok: true, forwards: [] });
      return send(200, {
        ok: true,
        existed: false,
        forward: { token: "dabc", deviceId: "dev-pc", deviceName: "台式机", port: body.port, label: body.label, urls: { local: "http://127.0.0.1:8787/fwd/dabc/", path: "/fwd/dabc/", preview: "" } },
      });
    }
    if (url.pathname !== "/api/internal/device-op") return send(404, { error: "not found" });
    ops.push(body);
    // 同真接口的解析：id > 名字（不分大小写）> 本会话连接的那台
    const want = String(body.device ?? "") || (body.session && links.get(body.session)) || "";
    const dev = DEVICES.find((d) => d.id === want || d.name.toLowerCase() === want.toLowerCase());
    if (!dev || !dev.client) return send(200, { ok: false, error: `找不到设备「${body.device}」` });
    const who = { id: dev.id, name: dev.name, tier: dev.client.tier, caps: dev.client.caps ?? [] };
    if (body.op === "shell") return send(200, { ok: true, device: who, result: { exitCode: 0, stdout: "hello", stderr: "", cwd: "C:\\Users\\me" } });
    if (body.op === "browser") {
      return send(200, { ok: true, device: who, result: { mcp: { content: [{ type: "text", text: "Page: 后台" }, { type: "image", data: PNG_1PX, mimeType: "image/png" }] } } });
    }
    if (body.op === "fs.read") {
      const buf = files.get(body.args.path);
      if (!buf) return send(200, { ok: false, error: "no such file" });
      const off = Number(body.args.offset ?? 0);
      const part = buf.subarray(off, off + Number(body.args.length ?? buf.length));
      return send(200, { ok: true, device: who, result: { path: body.args.path, content: part.toString("base64"), encoding: "base64", bytes: part.length, size: buf.length, eof: off + part.length >= buf.length } });
    }
    if (body.op === "fs.write") {
      const prev = body.args.append ? (files.get(body.args.path) ?? Buffer.alloc(0)) : Buffer.alloc(0);
      const next = Buffer.concat([prev, Buffer.from(String(body.args.content), body.args.encoding === "base64" ? "base64" : "utf8")]);
      files.set(body.args.path, next);
      return send(200, { ok: true, device: who, result: { path: body.args.path, bytes: next.length } });
    }
    if (body.op === "fs.list") return send(200, { ok: true, device: who, result: { path: body.args.path, entries: [{ name: "a.txt", type: "file", size: 3 }, { name: "sub", type: "dir" }] } });
    const a = String(body.args.action);
    if (dev.client.tier === "observe" && a !== "screenshot") return send(200, { ok: false, error: "当前是只观察模式，不能执行 " + a });
    if (a === "screenshot") return send(200, { ok: true, device: who, result: { image: PNG_1PX, mimeType: "image/png", fw: 1280, fh: 720, w: 2560, h: 1440 } });
    if (a === "windows") return send(200, { ok: true, device: who, result: { windows: [{ hwnd: 1, title: "记事本" }, { hwnd: 2, title: "Excel" }] } });
    if (a === "uia_action") {
      return send(200, {
        ok: true, device: who,
        result: { ok: true, action: "uia_action", ref: body.args.ref, uiaAction: body.args.uiaAction, verify: { changed: true, stable: true, settledMs: 120, opened: [{ title: "Save As", process: "notepad.exe" }] } },
      });
    }
    if (a === "batch") {
      return send(200, {
        ok: true, device: who,
        result: { ok: false, completed: 1, total: 2, images: [], steps: [{ step: 1, action: "key", keys: "Ctrl+S", ok: true }, { step: 2, action: "click", error: "out of frame" }] },
      });
    }
    return send(200, { ok: false, error: "未知桌面动作：" + a });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return { api: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ops, files, links };
}

const ALL = ["DeviceInspect", "DeviceAct", "DeviceBrowser", "DeviceShell", "DeviceFiles", "DevicePorts"];

test("设备工具可见性：两个变量都在、地址是回环、密钥够长才出现；租户只认按人令牌", () => {
  try {
    const names = () => toolDefs().map((d) => d.name);
    useChannel(undefined, undefined);
    assert.equal(deviceToolAvailable(), false);
    for (const n of ALL) assert.ok(!names().includes(n), n);

    useChannel("http://127.0.0.1:8787");
    assert.equal(deviceToolAvailable(), true);
    for (const n of ALL) assert.ok(names().includes(n), n);
    useChannel("http://[::1]:8787/");
    assert.equal(deviceToolAvailable(), true, "IPv6 回环、末尾斜杠都认");

    for (const api of ["http://localhost:8787", "http://192.168.1.2:8787", "https://127.0.0.1:8787", "http://127.0.0.1:8787/api"]) {
      useChannel(api);
      assert.equal(deviceToolAvailable(), false, api);
    }
    useChannel("http://127.0.0.1:8787", "short");
    assert.equal(deviceToolAvailable(), false, "密钥太短");

    // 租户：只认 bridge 按人铸的令牌（只能操作他自己的电脑）；主机密钥万一漏进来也不用
    useChannel("http://127.0.0.1:8787");
    process.env.DIMENSIO_TENANT = "1";
    assert.equal(deviceToolAvailable(), false);
    assert.ok(!names().includes("DeviceInspect") && !names().includes("DeviceAct"));
    useChannel("http://127.0.0.1:8787", "dvt1.dimensio.dTp1c2Vy.FAKE-signature-for-tests");
    assert.equal(deviceToolAvailable(), true);
    for (const n of ALL) assert.ok(names().includes(n), n);
  } finally {
    restore();
  }
});

test("status 与桌面动作走内部接口：凭据、by / frameKey = dimensio、device 原样转给 bridge", async (t) => {
  const bridge = await fakeBridge(t);
  useChannel(bridge.api);
  try {
    const status = await deviceInspectTool.run({ action: "status" }, ctx);
    assert.equal(status.ok, true);
    const s = textOf(status);
    assert.match(s, /● online {2}台式机 {2}\[dev-pc\].*control \(may observe and operate\).*same machine as this server/);
    assert.match(s, /● online {2}Laptop {2}\[dev-lap\].*observe only/);
    assert.match(s, /○ offline {2}旧电脑 {2}\[dev-old\].*last online 2026-10-20 13:05 UTC/);
    assert.match(s, /Several devices are online/);

    // 截图：给模型的图走 feedback、给界面的走事件（说明行是 desktop://<设备名>），文字是新坐标帧
    const shot = await deviceInspectTool.run({ action: "screenshot", device: "台式机" }, ctx);
    assert.equal(shot.ok, true);
    assert.match(textOf(shot), /Screenshot 1280×720 \(screen is 2560×1440 physical px\)/);
    assert.deepEqual(shot.feedback, [{ t: "image", mime: "image/png", data: PNG_1PX }]);
    const ev = shot.events?.[0] as { e: string; url: string; dataUri?: string };
    assert.equal(ev.e, "screenshot");
    assert.equal(ev.url, "desktop://台式机");
    assert.ok(ev.dataUri?.startsWith("data:image/png;base64,"));
    assert.deepEqual(bridge.ops[0], { op: "desktop", args: { action: "screenshot", frameKey: "dimensio" }, timeoutMs: 45_000, by: "dimensio", device: "台式机" });

    // windows 的 query 在本地过滤
    const wins = await deviceInspectTool.run({ action: "windows", device: "dev-pc", query: "记事" }, ctx);
    assert.match(textOf(wins), /记事本/);
    assert.doesNotMatch(textOf(wins), /Excel/);

    // uia_action：子动作放 uiaAction
    const uia = await deviceActTool.run({ action: "uia_action", uiaAction: "invoke", ref: 3, device: "台式机" }, ctx);
    assert.equal(uia.ok, true);
    assert.match(textOf(uia), /Ran invoke on ref3/);
    assert.match(textOf(uia), /opened window "Save As" \(notepad\.exe\)/);
    assert.deepEqual(bridge.ops[2].args, { action: "uia_action", uiaAction: "invoke", ref: 3, frameKey: "dimensio" });

    // batch 中途停下：每一步照排、整体算失败（不能吞成一句 had no effect）
    const batch = await deviceActTool.run({ action: "batch", device: "台式机", actions: [{ action: "key", keys: "Ctrl+S" }, { action: "click", x: 9999, y: 1 }] }, ctx);
    assert.equal(batch.ok, false);
    assert.match(textOf(batch), /Batch 1\/2 steps done \(stopped at the first error\)/);
    assert.match(textOf(batch), /step 2 click failed: out of frame/);
    assert.equal(bridge.ops[3].timeoutMs, 120_000);

    // 只观察档的设备上动手：设备原话 + 怎么改；找不到的设备原话照给
    const denied = await deviceActTool.run({ action: "click", x: 10, y: 10, device: "laptop" }, ctx);
    assert.equal(denied.ok, false);
    assert.match(textOf(denied), /当前是只观察模式，不能执行 click/);
    assert.match(textOf(denied), /Device "Laptop" is in OBSERVE mode/);
    const unknown = await deviceActTool.run({ action: "click", x: 1, y: 1, device: "nope" }, ctx);
    assert.equal(textOf(unknown), "找不到设备「nope」");

    // 老客户端不认新动作
    const zoom = await deviceInspectTool.run({ action: "zoom", device: "台式机", region: [0, 0, 10, 10] }, ctx);
    assert.equal(zoom.ok, false);
    assert.match(textOf(zoom), /too old for "zoom"/);
  } finally {
    restore();
  }
});

test("会话连接：use 之后省略 device 就是那台；浏览器 / 命令 / 文件互拷 / 端口转发", async (t) => {
  const bridge = await fakeBridge(t);
  useChannel(bridge.api);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-device-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sid = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const sctx = { ownerId: sid, sandbox: new Sandbox(root, "workspace"), readFileState: new Map() } as unknown as ToolContext;
  try {
    const linked = await deviceInspectTool.run({ action: "status", use: "台式机" }, sctx);
    assert.equal(linked.ok, true);
    assert.match(textOf(linked), /台式机 {2}\[dev-pc\].*← linked to this session/);
    assert.doesNotMatch(textOf(linked), /Several devices are online/, "连上了就不再要求指定");
    assert.equal(bridge.links.get(sid), "dev-pc");

    // 省略 device：带上 session（bridge 据此找连接的那台），frameKey 按会话分开
    const shot = await deviceInspectTool.run({ action: "screenshot" }, sctx);
    assert.equal(shot.ok, true);
    const op = bridge.ops.at(-1)!;
    assert.equal(op.session, sid);
    assert.equal(op.device, undefined);
    assert.equal(op.args.frameKey, `dimensio:${sid}`);

    const sh = await deviceShellTool.run({ command: "whoami" }, sctx);
    assert.equal(sh.ok, true);
    assert.match(textOf(sh), /exit code 0 on 台式机[\s\S]*\[stdout\]\nhello/);

    const br = await deviceBrowserTool.run({ action: "screenshot" }, sctx);
    assert.equal(br.ok, true);
    assert.match(textOf(br), /Page: 后台/);
    assert.deepEqual(br.feedback, [{ t: "image", mime: "image/png", data: PNG_1PX }]);
    assert.equal((br.events?.[0] as { url: string }).url, "browser://台式机");

    const ls = await deviceFilesTool.run({ action: "list", path: "C:\\Users\\me" }, sctx);
    assert.match(textOf(ls), /a\.txt {2}3\n\[dir\] sub/);

    // 设备 → 服务器：落在工作区里；客户端有 fs.chunk 就分块读，后续块钉死同一台
    const pull = await deviceFilesTool.run({ action: "pull", path: DEVICE_FILE }, sctx);
    assert.equal(pull.ok, true, textOf(pull));
    assert.equal(fs.readFileSync(path.join(root, "report.bin"), "utf8"), "device-bytes");
    const read = bridge.ops.filter((o) => o.op === "fs.read").at(-1)!;
    assert.equal(read.device, "dev-pc");
    assert.equal(read.args.offset, 0);
    // 工作区外不许落
    const outside = await deviceFilesTool.run({ action: "pull", path: DEVICE_FILE, to: path.join(os.tmpdir(), "dimensio-escape.bin") }, sctx);
    assert.equal(outside.ok, false);

    // 服务器 → 设备
    fs.writeFileSync(path.join(root, "out.txt"), "from-server");
    const push = await deviceFilesTool.run({ action: "push", from: "out.txt", path: "C:\\Users\\me\\out.txt" }, sctx);
    assert.equal(push.ok, true, textOf(push));
    assert.equal(bridge.files.get("C:\\Users\\me\\out.txt")?.toString(), "from-server");

    const fwd = await devicePortsTool.run({ action: "open", port: 5173, label: "vite" }, sctx);
    assert.equal(fwd.ok, true);
    assert.match(textOf(fwd), /台式机 port 5173 \(vite\)[\s\S]*http:\/\/127\.0\.0\.1:8787\/fwd\/dabc\//);
    assert.equal(bridge.ops.at(-1)!.forward.session, sid);

    // 读类动作按读权限判；pull 往服务器写
    assert.deepEqual(deviceFilesTool.permissionView?.({ action: "read" }), { effect: "read" });
    assert.equal(deviceFilesTool.permissionView?.({ action: "pull", path: "C:\\x\\y.zip" })?.writes?.[0], "y.zip");
    assert.deepEqual(deviceBrowserTool.permissionView?.({ action: "read_page" }), { effect: "read" });
    assert.equal(deviceBrowserTool.permissionView?.({ action: "click" }), null);

    // 断开：不连电脑
    const none = await deviceInspectTool.run({ action: "status", use: "none" }, sctx);
    assert.match(textOf(none), /set to "no computer"/);
  } finally {
    restore();
  }
});

test("连不上 bridge、凭据不对：错误说人话", async (t) => {
  const bridge = await fakeBridge(t);
  try {
    useChannel(bridge.api, "FAKE-wrong-secret-but-long-enough");
    const rejected = await deviceInspectTool.run({ action: "status" }, ctx);
    assert.equal(rejected.ok, false);
    assert.match(textOf(rejected), /host secret does not match/);

    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as { port: number }).port;
    await new Promise<void>((r) => dead.close(() => r()));
    useChannel(`http://127.0.0.1:${port}`);
    const down = await deviceActTool.run({ action: "click", x: 1, y: 1 }, ctx);
    assert.equal(down.ok, false);
    assert.match(textOf(down), /Cannot reach the bridge at http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    restore();
  }
});
