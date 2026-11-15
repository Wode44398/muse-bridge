// M5（#13）：删除会话要回收它名下的一切。修前两个删除入口（DELETE /api/sessions/:id 与 POST
// …/delete）只 dropSession + 删文件：后台 Bash job 照跑 30 分钟到 2 小时，Preview dev server
// 永不停，owner 已经没了，UI 也停不掉。11-14 起浏览器按会话各开一份：删除会话时它那份浏览器（标签、隔离存储开关）一并收掉。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteSession } from "./session.ts";
import { bashTool, killJobsFor, liveJobCount } from "./tools/bash.ts";
import { browserIsolated, closeAllBrowserSessions, existingBrowser, getBrowser, setBrowserIsolated } from "./cdp.ts";
import { resourcesOf } from "./resources.ts";
import { withFakeBrowsers } from "./test-harness/fake-browser.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";

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

const SLEEP = process.platform === "win32" ? "ping -n 20 127.0.0.1 > NUL" : "sleep 20";

test("删除会话会杀掉它的后台 job、关掉它的浏览器；别的会话的 job 与浏览器不受影响", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-m5-"));
  const doomed = "m5-deleted-session";
  const other = "m5-other-session";
  await withFakeBrowsers(async () => {
    try {
      const started = await bashTool.run({ command: SLEEP, background: true }, ctxFor(doomed, root));
      assert.ok(started.ok, started.summary);
      await bashTool.run({ command: SLEEP, background: true }, ctxFor(other, root));
      await getBrowser(doomed);
      const kept = await getBrowser(other);
      assert.equal(liveJobCount(doomed), 1);

      const r = await deleteSession(doomed);
      assert.equal(r.stopped.jobsKilled, 1, "被删会话的后台 job 要杀掉");
      assert.equal(liveJobCount(doomed), 0);
      assert.equal(liveJobCount(other), 1, "别的会话的 job 不许误杀");
      assert.equal(existingBrowser(doomed), undefined, "被删会话的浏览器要关掉");
      assert.deepEqual(resourcesOf(doomed), [], "账上不剩它的任何东西");
      assert.equal(existingBrowser(other), kept, "别的会话的浏览器不许动");
    } finally {
      killJobsFor(doomed);
      killJobsFor(other);
      closeAllBrowserSessions();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* 刚杀掉的子进程可能还攥着 cwd */
      }
    }
  });
});

test("删除会话会忘掉它的浏览器隔离存储开关（只开了开关、还没开过浏览器也一样）", async () => {
  const doomed = "m5-deleted-isolated";
  try {
    await setBrowserIsolated(doomed, true);
    assert.equal(browserIsolated(doomed), true);
    await deleteSession(doomed);
    assert.equal(browserIsolated(doomed), false, "删掉的会话不该还占着一条隔离开关");
  } finally {
    closeAllBrowserSessions();
  }
});
