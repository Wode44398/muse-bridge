// 2026-09-10：点「停止」后按钮变灰、进程照跑。真因在 tools/bash.ts 的**同步**路径——
// 中止与超时都只 child.kill("SIGKILL")，而 child 是 shell（Windows 上是 git-bash.exe），
// 真正干活的命令是它的孙进程，TerminateProcess 打不到，当场变孤儿继续跑。后台 job
// 那条路一直用 killTree（taskkill /T /F），唯独同步路径漏了。
//
// 这个用例故意起一棵「shell → node 常驻进程」的树，abort 之后看孙进程有没有继续写文件。
// 修复前必然失败（文件继续增长），修复后立刻停。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashTool } from "./tools/bash.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 带 timeout：回归时这个用例不是「断言失败」而是【永远挂住】——孤儿孙进程继承着
// shell 的 stdout/stderr 管道句柄，管道不 EOF，child 的 'close' 就永远不来，
// `await running` 于是无限等待。回归实测就是这样卡满 120s 的。
test("中止同步 Bash 会杀掉整棵进程树，而不只是 shell", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bashabort-"));
  const beacon = path.join(root, "heartbeat.txt");
  const abort = new AbortController();
  const ctx: ToolContext = {
    sandbox: new Sandbox(root, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 30_000, bashMaxTimeoutMs: 60_000 },
    agentSeesImages: false,
    ownerId: "session-abort",
    signal: abort.signal,
  };

  const lines = () => (existsSync(beacon) ? readFileSync(beacon, "utf8").split("\n").length : 0);

  // shell 起一个常驻 node（= 孙进程），每 200ms 往 beacon 追一行心跳。文件名写相对的：
  // 绝对 Windows 路径要穿过 bash 双引号 + JS 字符串两层转义，反斜杠一路会被啃掉，
  // 结果是静悄悄写去别处而不报错——子进程的 cwd 就是 sandbox root，用相对名最稳。
  const script =
    "const fs=require('fs');setInterval(()=>fs.appendFileSync('heartbeat.txt','tick\\n'),200)";
  const command = `node -e ${JSON.stringify(script)}`;

  try {
    const running = bashTool.run({ command }, ctx);
    // 等孙进程真起来：全量并发跑时 node 冷启动可能超过 1.5 秒（09-25 就因此前提断言先失败）
    for (let i = 0; i < 50 && lines() <= 1; i++) await sleep(200);
    assert.ok(lines() > 1, "孙进程应该已经在写心跳了（前提没成立的话后面的断言没有意义）");

    abort.abort();
    const result = await running;
    assert.equal(result.ok, false, "被中止的命令不算成功");

    // 给 taskkill 一点落地时间，然后取基线，再看它还长不长。
    await sleep(1_500);
    const settled = lines();
    await sleep(1_500);
    assert.equal(
      lines(),
      settled,
      "abort 之后孙进程还在写心跳 —— 说明只杀了 shell，没杀进程树",
    );
  } finally {
    // 前提断言先失败时命令还没被中止——不在这里中止，心跳进程树就一直占着管道，整个测试进程退不出去（09-25 全量卡了 11 分钟）
    abort.abort();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 刚被杀的子进程可能还占着 cwd（Windows 上 EPERM），交给系统回收 temp。
    }
  }
});
