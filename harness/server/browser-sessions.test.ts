// 11-14 浏览器按会话各开一份（对齐 bridge 11-08 的 claude-browser.mjs，见 cdp.ts 的「浏览器池」）：
//
// 修前：全进程一个共享浏览器，claimBrowser 独占——一个会话在用时，第二个会话调 Browser / ReadPage / Eval / Network 直接
// 被拒（「The shared browser is currently being driven by another active session」），而前端允许 3 个会话并发。
// 修后：每个会话一个 CdpSession（自己的标签、前台标签、视口），都开在同一个共享无头宿主进程里；登录态默认共享，
// 会话开了隔离存储就换成宿主里的独立浏览上下文；会话删除时它的标签由资源账本收掉；挂载状态经 onBrowserMount 推出去。
//
// 前四个用例真起本机 Chrome/Edge 打本地靶页（Windows 以外或没装浏览器就跳过）；最后一个用假浏览器测池子的回收上限。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import test, { after } from "node:test";
import {
  browserMount,
  closeAllBrowserSessions,
  closeBrowser,
  existingBrowser,
  getBrowser,
  onBrowserMount,
  setBrowserIsolated,
  type BrowserMountEvent,
} from "./cdp.ts";
import { findBrowser } from "./headless.ts";
import { browserIsolationFile } from "./paths.ts";
import { Sandbox } from "./sandbox.ts";
import { createSession, deleteSession } from "./session.ts";
import { withFakeBrowsers } from "./test-harness/fake-browser.ts";
import { browserTool } from "./tools/browser.ts";
import { evalTool } from "./tools/evaljs.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const skip = process.platform !== "win32" || !findBrowser() ? "需要 Windows + 本机 Chrome/Edge" : false;

const server = http.createServer((req, res) => {
  const url = String(req.url ?? "/");
  if (url === "/login") res.setHeader("set-cookie", "sid=shared; Max-Age=86400; Path=/");
  if (url === "/login-iso") res.setHeader("set-cookie", "sid=iso; Max-Age=86400; Path=/");
  res.setHeader("content-type", "text/html;charset=utf-8");
  res.end(`<title>page${url.replace(/\//g, "-")}</title><p>${url}</p>`);
});
const ready = new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = async () => {
  await ready;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
after(() => {
  closeAllBrowserSessions();
  server.close();
});

const ctxFor = (ownerId: string): ToolContext => ({
  sandbox: new Sandbox(os.tmpdir(), "workspace"),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 5_000 },
  agentSeesImages: false,
  ownerId,
});
const text = (r: ToolRunResult) => r.content.map((b) => ("text" in b ? b.text : "")).join("\n");

async function until<T>(probe: () => Promise<T | null>, ms = 8_000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v != null || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

test("两个会话各开一份：同时 navigate 谁也不拒谁；当前标签、视口、标签列表互不影响；两边页面都在前台", { skip, timeout: 120_000 }, async () => {
  const root = await base();
  try {
    // 工具层：两个会话同时开浏览器（修前第二个直接被拒）
    const [na, nb] = await Promise.all([
      browserTool.run({ action: "navigate", url: root + "/a" }, ctxFor("sess-A")),
      browserTool.run({ action: "navigate", url: root + "/b" }, ctxFor("sess-B")),
    ]);
    assert.ok(na.ok, text(na));
    assert.ok(nb.ok, text(nb));
    const [ta, tb] = await Promise.all([
      evalTool.run({ js: "document.title" }, ctxFor("sess-A")),
      evalTool.run({ js: "document.title" }, ctxFor("sess-B")),
    ]);
    assert.match(text(ta), /page-a/);
    assert.match(text(tb), /page-b/, "B 的 Eval 读的是 B 自己的页面");

    const a = existingBrowser("sess-A")!;
    const b = existingBrowser("sess-B")!;
    assert.ok(a && b && a !== b);
    assert.equal(a.tabs.length, 1);
    assert.equal(b.tabs.length, 1);
    assert.notEqual(a.tabs[0].id, b.tabs[0].id);
    assert.equal(existingBrowser(""), undefined, "默认那份没被拉起");

    // 视口：A 换成手机档，B 纹丝不动
    const bWidth = await b.eval("innerWidth");
    await a.setViewport(375, 812, true);
    assert.equal(await a.eval("innerWidth"), 375);
    assert.equal(await b.eval("innerWidth"), bWidth, "A 改视口不影响 B");
    assert.deepEqual(b.viewport, { width: 1280, height: 900 });

    // 标签：A 新开一个，B 的列表与当前标签都不变
    await a.newTab(root + "/a2");
    assert.equal(a.tabs.length, 2);
    assert.equal(b.tabs.length, 1, "A 开的标签不进 B 的列表");
    assert.equal(b.tabs[0].active, true);
    assert.match(b.url, /\/b$/, "B 的当前标签没被挤走");
    // 每个标签开在自己的窗口里：别的会话开标签不会把你挤到后台（同一窗口里只有前台标签可见）
    assert.equal(await b.eval("document.visibilityState"), "visible");
    assert.equal(await a.eval("document.visibilityState"), "visible");
  } finally {
    closeAllBrowserSessions();
  }
});

test("登录态默认共享；开了隔离存储的会话看不到、也不外泄 cookie；隔离开关落盘，切换会关掉它现有的标签", { skip, timeout: 120_000 }, async () => {
  const root = await base();
  try {
    const a = await getBrowser("sess-A");
    await a.navigate(root + "/login");
    assert.equal(await a.eval("document.cookie"), "sid=shared");
    const b = await getBrowser("sess-B");
    await b.navigate(root + "/b");
    assert.equal(await b.eval("document.cookie"), "sid=shared", "默认上下文：别的会话登录过的站点照样是登录态");

    assert.deepEqual(await setBrowserIsolated("sess-C", true), { isolated: true, restarted: false });
    assert.ok((JSON.parse(readFileSync(browserIsolationFile(), "utf8")) as string[]).includes("sess-C"), "隔离开关落盘");
    const c = await getBrowser("sess-C");
    assert.ok(c.browserContextId, "隔离会话开在独立浏览上下文里");
    await c.navigate(root + "/b");
    assert.equal(await c.eval("document.cookie"), "", "隔离会话看不到共享 cookie");
    await c.navigate(root + "/login-iso");
    assert.equal(await c.eval("document.cookie"), "sid=iso");
    await a.navigate(root + "/a");
    assert.equal(await a.eval("document.cookie"), "sid=shared", "隔离会话的 cookie 不外泄到默认上下文");
    assert.deepEqual(browserMount("sess-C"), { mounted: true, tabs: 1, isolated: true });

    // 关掉隔离：现有标签关掉（隔离上下文随之清空），再开就回到共享登录态
    assert.deepEqual(await setBrowserIsolated("sess-C", false), { isolated: false, restarted: true });
    assert.equal(existingBrowser("sess-C"), undefined, "切换隔离模式会关掉这个会话现有的浏览器");
    const c2 = await getBrowser("sess-C");
    assert.equal(c2.browserContextId, "");
    await c2.navigate(root + "/b");
    assert.equal(await c2.eval("document.cookie"), "sid=shared");
    assert.equal(a.alive && b.alive, true, "别的会话的浏览器不受切换影响");
  } finally {
    closeAllBrowserSessions();
  }
});

test("会话删除收掉它的标签（宿主里一个都不剩），别的会话的浏览器照常", { skip, timeout: 120_000 }, async () => {
  const root = await base();
  const doomed = createSession();
  try {
    const keep = await getBrowser("sess-keep");
    await keep.navigate(root + "/b");
    const d = await getBrowser(doomed.id);
    await d.navigate(root + "/a");
    await d.newTab(root + "/a2");
    const ids = d.tabs.map((t) => t.id);
    assert.equal(ids.length, 2);
    const { port } = d.endpoint;

    await deleteSession(doomed.id);
    assert.equal(existingBrowser(doomed.id), undefined);
    const gone = await until(async () => {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { id: string }[];
      return ids.every((id) => !list.some((t) => t.id === id)) ? list : null;
    });
    assert.ok(gone, "被删会话的标签都关掉了");
    assert.ok(gone!.some((t) => t.id === keep.tabs[0].id), "别的会话的标签还在");
    assert.equal(keep.alive, true);
    assert.match(keep.url, /\/b$/);
  } finally {
    closeAllBrowserSessions();
  }
});

test("挂载状态：会话的浏览器有了标签就推 mounted、关掉推 mounted:false；默认那份不推", { skip, timeout: 120_000 }, async () => {
  const events: BrowserMountEvent[] = [];
  const off = onBrowserMount((ev) => events.push(ev));
  try {
    assert.deepEqual(browserMount("sess-M"), { mounted: false, tabs: 0, isolated: false });
    await getBrowser("sess-M");
    assert.deepEqual(events.map((e) => [e.sessionId, e.mounted]), [["sess-M", true]]);
    assert.deepEqual(browserMount("sess-M"), { mounted: true, tabs: 1, isolated: false });
    await getBrowser("");
    assert.equal(events.length, 1, "默认那份不属于任何会话，不推");
    await closeBrowser("sess-M");
    assert.deepEqual(events.map((e) => [e.sessionId, e.mounted]), [["sess-M", true], ["sess-M", false]]);
    assert.equal(browserMount("sess-M").mounted, false);
  } finally {
    off();
    closeAllBrowserSessions();
  }
});

test("活着的份数到顶时，先收掉闲置最久、也没人在看的那份（假浏览器）", async () => {
  await withFakeBrowsers(async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      for (let i = 0; i < 8; i++) {
        now += 1000;
        await getBrowser(`idle-${i}`);
      }
      now += 11 * 60_000;
      await getBrowser("fresh");
      assert.equal(existingBrowser("idle-0"), undefined, "最久没用的那份收掉了");
      for (let i = 1; i < 8; i++) assert.ok(existingBrowser(`idle-${i}`), `idle-${i} 还在（只收到降回上限为止）`);
      assert.ok(existingBrowser("fresh"));
    } finally {
      Date.now = realNow;
      closeAllBrowserSessions();
    }
  });
});
