// M5 账本（K03、#13）：会话资源账本。
//
// 修前：bash 后台 job、Preview dev server、共享浏览器的占用各有一张登记表、各有回收函数，停止 / 删除 / 轮结束 / 关停
// 各自记得调哪几个（删除会话漏收过 job 和 dev server）；owner 会话已经不在的 dev server 没有任何出口会再收，一直跑到
// 进程退出。修后：资源一起来就登记进会话的账本，出口只说「这个会话的（哪几类）都收掉」，账本按登记的逆序拆、按类报数；
// 5 分钟巡检收掉 owner 已不在的资源。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { browserClaimOwner, claimBrowser, releaseBrowser } from "./cdp.ts";
import { disposeOwner, registerResource, resourcesOf } from "./resources.ts";
import { Sandbox } from "./sandbox.ts";
import { liveServiceCount, startService } from "./services.ts";
import { createSession, dropSession, stopSession, sweepOrphanResources } from "./session.ts";
import { bashTool, killJobsFor, liveJobCount } from "./tools/bash.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 刚杀掉的子进程可能还攥着 cwd */ }
  }
});
function temp(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-m5-ledger-"));
  roots.push(root);
  return root;
}
function ctxFor(ownerId: string, root: string): ToolContext {
  return {
    sandbox: new Sandbox(root, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 10_000 },
    agentSeesImages: false,
    ownerId,
  };
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
const SLEEP = process.platform === "win32" ? "ping -n 30 127.0.0.1 > NUL" : "sleep 30";
const serverCmd = (port: number) => `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')"`;

test("M5 账本：按登记的逆序拆、只拆点名的那几类、按类报数；单独结束的先注销；一条拆失败不挡后面的", () => {
  const order: string[] = [];
  const logged = [] as string[];
  const saved = console.error;
  console.error = (line: string) => void logged.push(line);
  try {
    registerResource("m5-unit", "job", "j1", () => (order.push("j1"), true));
    const releaseS1 = registerResource("m5-unit", "service", "s1", () => (order.push("s1"), true));
    registerResource("m5-unit", "service", "s2", () => { throw new Error("boom"); });
    registerResource("m5-unit", "browser", "b1", () => (order.push("b1"), true));
    registerResource("m5-unit", "job", "j2", () => (order.push("j2"), false)); // 早就自己结束了：拆了但不算数
    releaseS1(); // s1 被单独停掉了

    assert.deepEqual(disposeOwner("m5-unit", "run-end", ["browser"]), { job: 0, service: 0, browser: 1 });
    assert.deepEqual(order, ["b1"], "轮结束只放浏览器占用");
    assert.deepEqual(disposeOwner("m5-unit", "stop"), { job: 1, service: 0, browser: 0 });
    assert.deepEqual(order, ["b1", "j2", "j1"], "逆序拆；单独停掉的 s1 不再拆；s2 拆失败只记一行");
    assert.equal(logged.length, 1);
    assert.match(logged[0], /service s2 没收掉：boom/);
    assert.deepEqual(resourcesOf("m5-unit"), [], "拆完账上什么都不剩");
  } finally {
    console.error = saved;
  }
});

test("M5 停止会话：账本收掉它的后台 job、dev server 与浏览器占用，回执按账本报数；别的会话一概不动", { timeout: 60_000 }, async () => {
  const root = temp();
  const session = createSession();
  const other = "m5-ledger-other";
  try {
    assert.ok((await bashTool.run({ command: SLEEP, background: true }, ctxFor(session.id, root))).ok);
    assert.ok((await bashTool.run({ command: SLEEP, background: true }, ctxFor(other, root))).ok);
    const port = await freePort();
    await startService({ command: serverCmd(port), port, cwd: root, owner: session.id });
    assert.equal(claimBrowser(session.id), null);
    assert.deepEqual(resourcesOf(session.id).map((r) => r.kind), ["job", "service", "browser"], "三类资源都登记进了账本");

    const report = stopSession(session.id);
    assert.equal(report.jobsKilled, 1);
    assert.equal(report.servicesStopped, 1);
    assert.equal(liveJobCount(session.id), 0);
    assert.equal(liveServiceCount(session.id), 0);
    assert.equal(browserClaimOwner(), "");
    assert.deepEqual(resourcesOf(session.id), []);
    assert.equal(liveJobCount(other), 1, "别的会话的 job 不许误杀");
  } finally {
    killJobsFor(other);
    stopSession(session.id);
    releaseBrowser(session.id);
    dropSession(session.id);
  }
});

test("M5 巡检：owner 会话已经不在（内存和盘上都没有）的后台 job 与 dev server 收掉；还在的会话一概不动", { timeout: 60_000 }, async () => {
  const root = temp();
  const gone = "m5-ledger-gone-session";
  const alive = createSession();
  try {
    assert.ok((await bashTool.run({ command: SLEEP, background: true }, ctxFor(gone, root))).ok);
    const port = await freePort();
    await startService({ command: serverCmd(port), port, cwd: root, owner: gone });
    assert.ok((await bashTool.run({ command: SLEEP, background: true }, ctxFor(alive.id, root))).ok);

    const reaped = sweepOrphanResources();
    assert.deepEqual([reaped.job, reaped.service], [1, 1]);
    assert.equal(liveJobCount(gone), 0);
    assert.equal(liveServiceCount(gone), 0);
    assert.equal(liveJobCount(alive.id), 1, "还在的会话（在内存里）不许收");
  } finally {
    killJobsFor(gone);
    stopSession(alive.id);
    dropSession(alive.id);
  }
});

test("M5 轮结束只放浏览器占用：后台 job 本来就活过这一轮", { timeout: 30_000 }, async () => {
  const root = temp();
  const owner = "m5-ledger-run-end";
  try {
    assert.ok((await bashTool.run({ command: SLEEP, background: true }, ctxFor(owner, root))).ok);
    assert.equal(claimBrowser(owner), null);
    disposeOwner(owner, "run-end", ["browser"]);
    assert.equal(browserClaimOwner(), "");
    assert.equal(liveJobCount(owner), 1);
    assert.deepEqual(resourcesOf(owner).map((r) => r.kind), ["job"]);
  } finally {
    killJobsFor(owner);
    releaseBrowser(owner);
  }
});
