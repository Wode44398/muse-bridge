// #77：进程树收尸不再用 taskkill /T。
//
// taskkill /T 只按 ParentProcessId 找子进程；父进程退出后 PID 会被复用，于是「悬空父 PID」恰好等于我们某个子进程
// PID 的无关进程链（生产上的 bridge：wscript 的父进程早已退出）会被 /T 一起杀掉。修后按创建时间核对：子进程一定比
// 父进程晚创建。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { descendantsOf, killChildTree, parseProcTable, processTable, type ProcRow } from "./proc-tree.ts";

const WIN = process.platform === "win32";

test("#77 descendantsOf：只认创建时间不早于父进程的子孙；悬空父 PID 指过来的旧进程及其子树一概不收", () => {
  const table: ProcRow[] = [
    { pid: 0, ppid: 0, created: 0, name: "System Idle Process" },
    { pid: 500, ppid: 1, created: 90, name: "explorer.exe" },
    { pid: 1000, ppid: 500, created: 100, name: "cmd.exe" }, // 根：我们的子进程（复用了一个旧 PID）
    { pid: 1001, ppid: 1000, created: 150, name: "node.exe" }, // 真孩子
    { pid: 1002, ppid: 1001, created: 160, name: "conhost.exe" }, // 真孙子
    { pid: 1003, ppid: 1000, created: 100, name: "same-tick.exe" }, // 同一毫秒创建：算孩子
    { pid: 2000, ppid: 1000, created: 50, name: "wscript.exe" }, // 旧进程：它真正的父进程早退了，PID 1000 后来被复用
    { pid: 2001, ppid: 2000, created: 55, name: "cmd.exe" }, // 那条无关的链：wscript → cmd → bridge
    { pid: 2002, ppid: 2001, created: 56, name: "node.exe" },
  ];
  assert.deepEqual(descendantsOf(1000, table), [1000, 1001, 1003, 1002]);
  assert.deepEqual(descendantsOf(2000, table), [2000, 2001, 2002], "从无关链自己的根往下照常能收");
  assert.deepEqual(descendantsOf(4242, table), [], "根不在进程表里：什么都不收");
  assert.deepEqual(descendantsOf(0, table), [0], "pid 与 ppid 相同的系统进程不自环");
});

test("#77 parseProcTable：PowerShell 输出逐行解析，残行跳过", () => {
  const rows = parseProcTable("4\t0\t1700000000000\tSystem\r\n1234\t4\t1700000000123\tnode.exe\r\ngarbage\r\n\r\n12\t4\t0\t\n");
  assert.deepEqual(rows, [
    { pid: 4, ppid: 0, created: 1700000000000, name: "System" },
    { pid: 1234, ppid: 4, created: 1700000000123, name: "node.exe" },
    { pid: 12, ppid: 4, created: 0, name: "" },
  ]);
});

async function gone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test("#77 killChildTree：真起一棵 cmd → node 的树，整棵收干净", { skip: WIN ? false : "只在 Windows 上有 /T 的问题", timeout: 60_000 }, async () => {
  // /s：cmd 会剥掉整条命令最外层的一对引号，所以外面再包一层。
  const child = spawn("cmd.exe", ["/d", "/s", "/c", `""${process.execPath}" -e "setInterval(function(){},1000)""`], {
    windowsHide: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
  });
  let grandchild: number | undefined;
  for (let i = 0; i < 50 && grandchild === undefined; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const table = await processTable();
    grandchild = table.find((p) => p.ppid === child.pid && /^node\.exe$/i.test(p.name))?.pid;
  }
  assert.ok(grandchild, "node 孙进程应当已经起来");
  const exited = new Promise((r) => child.once("exit", r));
  killChildTree(child);
  await exited;
  assert.equal(await gone(grandchild!, 15_000), true, "孙进程也要收掉");
});

test("#77 killChildTree：Node 已经收到退出的子进程不再按 PID 去杀（PID 可能已被系统复用）", { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", windowsHide: true });
  await new Promise((r) => child.once("exit", r));
  const realKill = process.kill;
  let called = false;
  process.kill = ((pid: number, sig?: string | number) => {
    called = true;
    return realKill.call(process, pid, sig);
  }) as typeof process.kill;
  try {
    killChildTree(child);
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    process.kill = realKill;
  }
  assert.equal(called, false);
});
