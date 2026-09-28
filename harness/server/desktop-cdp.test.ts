// S10（#38、#89 方案 2）harness 侧：桌面壳的 CDP 改走 broker 转发之后，客户端怎么认壳、附着别的 app 时不认控制面页面。
//
// 修前：① 只认「调试端口 + broker」都在的宿主，新壳（没有调试端口）会被当成不存在；② Browser(attach, port) 只按端口号拦
// 控制面，端口没登记时 pages[0] 可能就是已登录的 bridge 主窗口；③ 桌面壳模式下 resize 只记录不下发（见 cdp.ts setViewport）。
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { CdpSession, withoutControlPlane } from "./cdp.ts";
import { desktopHostInfo, desktopHostPorts, resolveCdpBase } from "./desktop-host.ts";

const SECRET = "FAKE-DUMMY-secret";

// 假 broker：/json/version 按 mode 回（proxy = 新壳；404 = 旧壳）；其余一律 404
async function fakeBroker(t: test.TestContext, mode: "proxy" | "old"): Promise<string> {
  const server = http.createServer((req, res) => {
    if (mode === "proxy" && req.url === `/${SECRET}/json/version`) {
      const port = (server.address() as { port: number }).port;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ Browser: "Electron/42", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${SECRET}/devtools/browser` }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/${SECRET}`;
}

function withEnv(t: test.TestContext, vars: Record<string, string | undefined>): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("S10 认壳：新壳（broker 应答 /json/version）走转发；旧壳（404 + 调试端口）走端口；两样都没有 / 壳不在就回落", async (t) => {
  const proxy = await fakeBroker(t, "proxy");
  const old = await fakeBroker(t, "old");
  assert.deepEqual(await resolveCdpBase({ cdpPort: 0, brokerUrl: proxy }), { cdpBase: proxy, proxy: true });
  assert.deepEqual(await resolveCdpBase({ cdpPort: 9333, brokerUrl: old }), { cdpBase: "http://127.0.0.1:9333", proxy: false });
  assert.equal(await resolveCdpBase({ cdpPort: 0, brokerUrl: old }), null, "旧 broker 又没有端口：不是能用的宿主");
  assert.equal(await resolveCdpBase({ cdpPort: 0, brokerUrl: "http://127.0.0.1:1/nothing-listens" }, 500), null, "壳不在");

  // env 只给 broker（新壳 spawn 时就是这样）：认得出、端口为 0；控制面端口名单只剩 broker 端口
  withEnv(t, { BRIDGE_DESKTOP_BROKER: proxy, BRIDGE_DESKTOP_CDP_PORT: undefined, BRIDGE_DESKTOP_HOST_FILE: undefined });
  assert.deepEqual(desktopHostInfo(), { cdpPort: 0, brokerUrl: proxy });
  assert.deepEqual(desktopHostPorts(), [Number(new URL(proxy).port)]);
  process.env.BRIDGE_DESKTOP_BROKER = "http://evil.example/steal";
  assert.equal(desktopHostInfo(), null, "env 里的 broker 也要是本机回环");
});

test("S10 止血：Browser(attach) 不认控制面页面——全是控制面就拒绝附着，混着的只留普通页面", async (t) => {
  withEnv(t, { BRIDGE_PORT: "8787", PORT: "8799" });
  const pages = [
    { id: "a", type: "page", url: "http://127.0.0.1:8787/", webSocketDebuggerUrl: "ws://x/a" },
    { id: "b", type: "page", url: "http://localhost:8799/api/info", webSocketDebuggerUrl: "ws://x/b" },
    { id: "c", type: "page", url: "http://127.0.0.1:5173/", webSocketDebuggerUrl: "ws://x/c" },
  ];
  assert.deepEqual(withoutControlPlane(pages).map((p) => p.id), ["c"], "bridge 主窗口与 harness 页面都剔掉，普通 dev server 留着");

  // 一个假的调试端口：只挂着 bridge 主窗口——attach 必须拒绝（修前 pages[0] 就是它）
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/json/list" ? pages.slice(0, 1) : {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const session = new CdpSession();
  await assert.rejects(
    session.attach((server.address() as { port: number }).port),
    /own control plane — attaching to them is not allowed/,
  );
});
