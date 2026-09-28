// S11（codex C8 的「kill 前复核身份」）：按 PID 记下、手里没有句柄的子进程（如 MCP SDK 起的 stdio 连接器），收之前先核对。
//
// 修前：按记下的 PID 直接收整棵树（killProcessTree 不带句柄）——那个子进程要是早退出了、PID 被别的进程复用，收掉的就是
// 别人（09-24 bridge 被 taskkill /T 顺着悬空父 PID 带走就是同一类事）。
// 修后：killOwnChildTree 先在进程表里核对这个 PID 的父进程还是本进程，不是就什么都不动；是才按创建时间收整棵树。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { killOwnChildTree } from "./proc-tree.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("S11 本进程的直接子进程：连同它的子孙一起收掉", { timeout: 60_000 }, async () => {
  // 子进程再起一个孙进程，把孙进程的 PID 打出来
  const child = spawn(process.execPath, ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const grandchild = await new Promise<number>((resolve) => child.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
  try {
    assert.ok(alive(child.pid!) && alive(grandchild));
    const killed = await killOwnChildTree(child.pid!);
    assert.ok(killed.includes(child.pid!) && killed.includes(grandchild), `killed ${killed.join(",")}`);
    await sleep(500);
    assert.equal(alive(grandchild), false, "孙进程一起收了");
  } finally {
    for (const p of [child.pid!, grandchild]) if (alive(p)) process.kill(p);
  }
});

test("S11 不是本进程直接子进程的 PID（孙进程、别人、自己、不存在的）：一个都不动", { timeout: 60_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const grandchild = await new Promise<number>((resolve) => child.stdout!.once("data", (d) => resolve(Number(String(d).trim()))));
  try {
    assert.deepEqual(await killOwnChildTree(grandchild), [], "孙进程的父进程不是本进程——当成「PID 已被别人复用」，不动");
    assert.equal(alive(grandchild), true);
    assert.deepEqual(await killOwnChildTree(process.pid), [], "自己");
    assert.deepEqual(await killOwnChildTree(process.ppid), [], "父进程");
    assert.deepEqual(await killOwnChildTree(4_000_000), [], "不存在的 PID");
    assert.equal(alive(child.pid!), true);
  } finally {
    for (const p of [child.pid!, grandchild]) if (alive(p)) process.kill(p);
  }
});
