// 2026-09-10：一个会话在 UI 上「运行中」冻了 3 小时 15 分，最后一条 tool_call 后面
// 永远没有 tool_result。真因在 tools/bash.ts —— 命令是
//   `sleep 5; cd … && ./SUMMER.exe >/dev/null 2>&1 & sleep 90; echo "--- poll ---"`
// bash 里 `&` 的优先级低于 `;`，前半段整个被丢进后台子 shell。主 shell 两分钟后正常
// 退出了，后台子 shell 攥着继承来的 stdout/stderr 写端不放（它要等游戏退出），管道
// 于是永不 EOF，child 的 'close' 永不触发，同步路径那个 Promise 永不 resolve。
// 超时兜底也救不了：定时器烧到时 killTree 打的是那个早已自己退出的 shell pid。
//
// 这两个用例故意留下一个持管道的孤儿孙进程，看工具调用还收不收得了尾。
// 修复前必然【挂满 timeout】而不是断言失败。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashTool } from "./tools/bash.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";

const ctxIn = (root: string): ToolContext => ({
  sandbox: new Sandbox(root, "workspace"),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 120_000, bashMaxTimeoutMs: 600_000 },
  agentSeesImages: false,
  ownerId: "session-orphan",
});

// 孤儿会继承管道写端，但 30 秒后自己了断，免得测试在机器上留下常驻进程。
const ORPHAN = `node -e "setTimeout(()=>process.exit(0),30000)"`;

test("shell 退出即收尾，不等孤儿孙进程放开管道", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bashorphan-"));
  try {
    const started = Date.now();
    // 复刻那条命令的形状：后台起一个长命进程，主 shell 立刻退出。
    const result = await bashTool.run({ command: `${ORPHAN} & echo launched` }, ctxIn(root));
    const elapsed = Date.now() - started;

    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
    assert.match(text, /launched/, "主 shell 的输出该照常拿到");
    assert.equal(result.ok, true, "shell 自己 exit 0，就该报成功");
    assert.ok(
      elapsed < 15_000,
      `shell 早就退了，却等了 ${elapsed}ms —— 说明还在死等管道 EOF（回归）`,
    );
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 孤儿可能还占着 cwd，交给系统回收 temp */
    }
  }
});

test("同样的孤儿不会让后台 job 永远卡在 running", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bashorphanjob-"));
  try {
    const start = await bashTool.run(
      { command: `${ORPHAN} & echo launched`, background: true },
      ctxIn(root),
    );
    const startText = start.content.map((c) => ("text" in c ? c.text : "")).join("");
    const id = /job\d+/.exec(startText)?.[0];
    assert.ok(id, `没拿到 job id：${startText}`);

    // 早退窗口 1.2s + 安静窗口 0.3s，给到 6s 足够宽裕。
    let text = "";
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const polled = await bashTool.run({ poll: id }, ctxIn(root));
      text = polled.content.map((c) => ("text" in c ? c.text : "")).join("");
      if (!text.includes("still running")) break;
    }
    assert.doesNotMatch(
      text,
      /still running/,
      "shell 已退出，job 却还挂着 running —— poll 永远交代不掉这个 job（回归）",
    );
    assert.match(text, /exit 0/, `job 该以 exit 0 收尾，实际：${text}`);
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 同上 */
    }
  }
});
