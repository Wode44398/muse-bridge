// #113（规划外，K10 全量测试时照出来）：无头浏览器启动的两处健壮性。
//
// 修前：① Chrome 正在写 DevToolsActivePort 的那一瞬间去读，Windows 上撞 EBUSY（共享冲突）就直接抛出、整次启动失败
// （09-25 eval-promise 就这样红了一次）；读到半截（只写出「639」）会被当成端口 639。② 启动中途失败时已经拉起的浏览器
// 没人收：harness 里多一个没人管的无头浏览器，测试进程攥着它的句柄退不掉——那次全量因此卡了二十分钟。
// 修后：读不了、读到半截都当「还没写好」接着等；getSharedBrowser 启动失败时先把这个会话 close 掉（收掉拉起的浏览器）再抛。
import assert from "node:assert/strict";
import test from "node:test";
import { CdpSession, getSharedBrowser, readDevToolsPortFile } from "./cdp.ts";

const locked = (code: string) => (): string => {
  const e = new Error(`${code}: resource busy or locked, open 'DevToolsActivePort'`) as NodeJS.ErrnoException;
  e.code = code;
  throw e;
};

test("#113 读 DevToolsActivePort：共享冲突（EBUSY / EPERM）当作还没写好、不抛；端口那一行写完才算", () => {
  assert.equal(readDevToolsPortFile("f", locked("EBUSY")), null);
  assert.equal(readDevToolsPortFile("f", locked("EPERM")), null);
  assert.equal(readDevToolsPortFile("f", () => ""), null, "空文件");
  assert.equal(readDevToolsPortFile("f", () => "639"), null, "端口那一行还没写完");
  assert.equal(readDevToolsPortFile("f", () => "63907\n"), 63907);
  assert.equal(readDevToolsPortFile("f", () => "63907\n/devtools/browser/0b1c"), 63907);
  assert.equal(readDevToolsPortFile("f", () => "63907\r\n/devtools/browser/0b1c"), 63907, "CRLF");
  assert.equal(readDevToolsPortFile("f", () => "abc\n"), null);
  assert.equal(readDevToolsPortFile("f", () => "70000\n"), null, "不是合法端口");
});

test("#113 共享浏览器启动中途失败：先把这个会话 close 掉（收掉已经拉起的浏览器）再把错抛出去；下次调用重新启动", async () => {
  const proto = CdpSession.prototype as unknown as { launch: (url: string) => Promise<void>; close: () => Promise<void> };
  const launch = proto.launch;
  const close = proto.close;
  let launches = 0;
  let closed = 0;
  proto.launch = async function () {
    launches++;
    throw new Error("timed out waiting for the browser debug port (simulated)");
  };
  proto.close = async function () {
    closed++;
  };
  try {
    await assert.rejects(getSharedBrowser(), /simulated/);
    assert.equal(closed, 1, "失败的那个会话被 close 了");
    await assert.rejects(getSharedBrowser(), /simulated/);
    assert.equal(launches, 2, "没有卡在上一次失败的启动上");
    assert.equal(closed, 2);
  } finally {
    proto.launch = launch;
    proto.close = close;
  }
});
