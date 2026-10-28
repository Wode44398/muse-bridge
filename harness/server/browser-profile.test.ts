// 2026-10-28 共享无头浏览器的持久配置档（对齐 bridge 10-26 的无头持久登录）：
//
// 修前：每次启动都是 mkdtemp 临时 profile、关浏览器就删——用户在面板里登录过的站点，下一个会话（或空闲回收后）全丢。
// 修后：共享浏览器用 <数据目录>/browser-profile，关浏览器走 Browser.close 体面退出（Cookie 落盘）、不删目录；
// 上次崩溃留下的孤儿进程占着配置档时，下次启动先请它退出、再收尸、删掉陈旧的 DevToolsActivePort。
//
// 真起本机 Chrome/Edge（Windows 以外或没装浏览器就跳过）。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CdpSession, persistBrowserProfile } from "./cdp.ts";
import { findBrowser } from "./headless.ts";

const skip = process.platform !== "win32" || !findBrowser() ? "需要 Windows + 本机 Chrome/Edge" : false;

test("测试进程里默认不用持久配置档；DIMENSIO_BROWSER_PERSIST 显式开关", () => {
  const prev = process.env.DIMENSIO_BROWSER_PERSIST;
  try {
    delete process.env.DIMENSIO_BROWSER_PERSIST;
    assert.equal(persistBrowserProfile(), false);
    process.env.DIMENSIO_BROWSER_PERSIST = "1";
    assert.equal(persistBrowserProfile(), true);
    process.env.DIMENSIO_BROWSER_PERSIST = "off";
    assert.equal(persistBrowserProfile(), false);
  } finally {
    if (prev === undefined) delete process.env.DIMENSIO_BROWSER_PERSIST;
    else process.env.DIMENSIO_BROWSER_PERSIST = prev;
  }
});

test("持久配置档：Cookie 跨重启保留，目录不删；孤儿进程占着时下次启动能接管", { skip, timeout: 120_000 }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/login") res.setHeader("set-cookie", "sid=kept; Max-Age=86400; Path=/");
    res.setHeader("content-type", "text/html");
    res.end("<title>p</title>ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const profileDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-profile-")), "browser-profile");
  const sessions: CdpSession[] = [];
  const launch = async () => {
    const s = new CdpSession();
    sessions.push(s);
    await s.launch("about:blank", { profileDir });
    return s;
  };
  try {
    const a = await launch();
    await a.navigate(base + "/login");
    assert.equal(await a.eval("document.cookie"), "sid=kept");
    await a.close();
    assert.ok(fs.existsSync(profileDir), "关浏览器不该删持久配置档");

    const b = await launch();
    await b.navigate(base + "/");
    assert.equal(await b.eval("document.cookie"), "sid=kept", "重启后登录态应还在");
    // 模拟崩溃：不关 b 就丢下它（进程还占着配置档），新会话直接起
    const c = await launch();
    await c.navigate(base + "/");
    assert.equal(await c.eval("document.cookie"), "sid=kept", "接管孤儿配置档后登录态仍在");
    await c.close();
  } finally {
    for (const s of sessions) await s.close().catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(path.dirname(profileDir), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
