// Edge 扩展链路（edge-link.ts + ws-lite.ts）的协议契约：用 Node 自带的 WebSocket 客户端扮演扩展。
// 真 Edge + 真扩展的全路径要手动冒烟（本仓库不附带扩展），这里守住服务端这一半：
//   · 只认固定扩展 ID 的 Origin（WebSocket 没有 CORS，任何网页都能往回环地址发起升级）
//   · 频道 = WebSocket 形状的对象，收发标准 CDP JSON；扩展关频道 / 链路断开都要让 cdp.ts 看到 close
//   · 氛围灯：操作性流量点亮，直播帧确认不算；占用标记整轮常亮
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { EDGE_EXTENSION_ID, EdgeLink } from "./edge-link.ts";

const ORIGIN = `chrome-extension://${EDGE_EXTENSION_ID}`;

async function rig() {
  const link = new EdgeLink();
  const server = http.createServer((_q, s) => s.end());
  server.on("upgrade", (req, socket) => {
    if (!link.handleUpgrade(req, socket)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/edge-link`;
  return { link, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// 扮演扩展：收到的消息排队，next(pred) 取第一条匹配的
function fakeExtension(url: string, origin = ORIGIN) {
  const ws = new WebSocket(url, { headers: { Origin: origin } } as unknown as string[]);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    const w = waiters.findIndex((x) => x.pred(m));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
    else inbox.push(m);
  });
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true));
    ws.addEventListener("error", () => resolve(false));
  });
  return {
    ws,
    opened,
    send: (obj: unknown) => ws.send(JSON.stringify(obj)),
    next: (pred: (m: any) => boolean, ms = 3000) =>
      new Promise<any>((resolve, reject) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
        const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      }),
  };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("只认固定扩展 ID 的 Origin：网页和别的扩展连不上", async () => {
  const r = await rig();
  let ok: ReturnType<typeof fakeExtension> | null = null;
  try {
    for (const origin of ["https://evil.example", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ""]) {
      const ext = fakeExtension(r.url, origin);
      assert.equal(await ext.opened, false, `origin ${origin || "(none)"} must be refused`);
    }
    ok = fakeExtension(r.url);
    assert.equal(await ok.opened, true);
    const hello = await ok.next((m) => m.t === "hello");
    assert.equal(hello.protocol, 1);
    // 本仓库不附带扩展，不钉版本：握手里照旧带这个字段，空串 = 不限
    assert.equal(hello.expectVersion, "", "no bundled extension, so no version is pinned");
  } finally {
    ok?.ws.close(); // 连接不关，server.close() 会一直等下去
    await r.close();
  }
});

test("握手之后才算连上；频道收发标准 CDP JSON，扩展关频道 / 链路断开都会让频道 close", async () => {
  const r = await rig();
  try {
    const ext = fakeExtension(r.url);
    await ext.opened;
    await ext.next((m) => m.t === "hello");
    assert.equal(r.link.connected, false, "not connected until the extension says hello");
    let linkEvents: boolean[] = [];
    r.link.onLink((up) => linkEvents.push(up));
    ext.send({ t: "hello", version: "0.1.0", browser: "Edge 154" });
    await until(() => r.link.connected);
    assert.deepEqual(linkEvents, [true]);
    assert.equal(r.link.snapshot().browser, "Edge 154");

    // 页面频道：open → opened → cdp 往返 → 事件 → 扩展关掉
    const ch = r.link.channel("42");
    const opened = new Promise((res) => ch.addEventListener("open", res));
    const open = await ext.next((m) => m.t === "open");
    assert.equal(open.ch, "42");
    ext.send({ t: "opened", ch: "42" });
    await opened;
    assert.equal(ch.readyState, 1);
    const got: any[] = [];
    ch.addEventListener("message", (ev: { data: string }) => got.push(JSON.parse(ev.data)));
    ch.send(JSON.stringify({ id: 7, method: "Runtime.evaluate", params: { expression: "1+1" } }));
    const cdp = await ext.next((m) => m.t === "cdp");
    assert.deepEqual([cdp.ch, cdp.id, cdp.method, cdp.params.expression], ["42", 7, "Runtime.evaluate", "1+1"]);
    ext.send({ t: "res", ch: "42", id: 7, result: { result: { value: 2 } } });
    ext.send({ t: "res", ch: "42", id: 8, error: "boom" });
    ext.send({ t: "evt", ch: "42", method: "Page.loadEventFired", params: { timestamp: 1 } });
    await until(() => got.length === 3);
    assert.deepEqual(got[0], { id: 7, result: { result: { value: 2 } } });
    assert.deepEqual(got[1], { id: 8, error: { message: "boom" } });
    assert.deepEqual(got[2], { method: "Page.loadEventFired", params: { timestamp: 1 } });
    const closed = new Promise((res) => ch.addEventListener("close", res));
    ext.send({ t: "closed", ch: "42", reason: "canceled_by_user" });
    await closed;
    assert.equal(ch.readyState, 3);

    // 打不开的频道：error + close（cdp.ts 的 connect 靠 error 拒绝）
    const bad = r.link.channel("99");
    const failed = new Promise((res) => bad.addEventListener("error", res));
    await ext.next((m) => m.t === "open" && m.ch === "99");
    ext.send({ t: "closed", ch: "99", reason: "not in the dimensio group" });
    await failed;

    // rpc 往返
    const listing = r.link.listTabs();
    const rpc = await ext.next((m) => m.t === "rpc");
    assert.equal(rpc.op, "list");
    ext.send({ t: "rpcres", rid: rpc.rid, result: { tabs: [{ id: 5, url: "https://a.example/", title: "A", active: true }] } });
    assert.deepEqual(await listing, [{ id: "5", url: "https://a.example/", title: "A", active: true }]);

    // 链路断开：挂着的频道全部 close，connected 归零
    const b = r.link.channel("browser");
    await ext.next((m) => m.t === "open" && m.ch === "browser");
    ext.send({ t: "opened", ch: "browser" });
    await until(() => b.readyState === 1);
    const bClosed = new Promise((res) => b.addEventListener("close", res));
    ext.ws.close();
    await bClosed;
    await until(() => !r.link.connected);
    assert.deepEqual(linkEvents, [true, false]);
    assert.throws(() => r.link.sendRaw({ t: "x" }), /not connected/);
  } finally {
    await r.close();
  }
});

test("没连上时开频道立刻失败，不会挂 30 秒", async () => {
  const link = new EdgeLink();
  const ch = link.channel("1");
  const err = await new Promise<any>((res) => ch.addEventListener("error", res));
  assert.match(String(err.message), /not connected/);
  await assert.rejects(link.listTabs(), /not connected/);
});

test("氛围灯：操作性流量点亮、直播帧确认不算；占用标记常亮；用户叫停转给 onStop", async () => {
  const r = await rig();
  try {
    const ext = fakeExtension(r.url);
    await ext.opened;
    ext.send({ t: "hello", version: "0.1.0", browser: "Edge" });
    await until(() => r.link.connected);
    await ext.next((m) => m.t === "activity" && m.on === false); // 握手后先报一次当前状态

    const ch = r.link.channel("3");
    await ext.next((m) => m.t === "open");
    ext.send({ t: "opened", ch: "3" });
    await until(() => ch.readyState === 1);
    ch.send(JSON.stringify({ id: 1, method: "Page.screencastFrameAck", params: { sessionId: 1 } }));
    await ext.next((m) => m.t === "cdp" && m.method === "Page.screencastFrameAck");
    assert.equal(r.link.snapshot().acting, false, "watching the live view is not acting");
    ch.send(JSON.stringify({ id: 2, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 1, y: 1 } }));
    await ext.next((m) => m.t === "activity" && m.on === true);
    assert.equal(r.link.snapshot().acting, true);

    r.link.setClaimActive(true);
    r.link.setClaimActive(false);

    let why = "";
    r.link.onStop = (w) => (why = w);
    ext.send({ t: "stop", reason: "page-button" });
    await until(() => why === "page-button");
    ext.ws.close();
  } finally {
    await r.close();
  }
});

test("同一台机器上第二个扩展连进来：顶掉先连的那个", async () => {
  const r = await rig();
  try {
    const a = fakeExtension(r.url);
    await a.opened;
    a.send({ t: "hello", version: "0.1.0", browser: "Edge A" });
    await until(() => r.link.snapshot().browser === "Edge A");
    const aClosed = new Promise((res) => a.ws.addEventListener("close", res));
    const b = fakeExtension(r.url);
    await b.opened;
    await a.next((m) => m.t === "replaced");
    await aClosed;
    b.send({ t: "hello", version: "0.1.0", browser: "Edge B" });
    await until(() => r.link.snapshot().browser === "Edge B" && r.link.connected);
    b.ws.close();
  } finally {
    await r.close();
  }
});
