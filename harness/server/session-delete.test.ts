// M5（#13）：删除会话要回收它名下的一切。修前两个删除入口（DELETE /api/sessions/:id 与 POST
// …/delete）只 dropSession + 删文件：后台 Bash job 照跑 30 分钟到 2 小时，Preview dev server
// 永不停，owner 已经没了，UI 也停不掉。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteSession } from "./session.ts";
import { bashTool, killJobsFor, liveJobCount } from "./tools/bash.ts";
import { browserClaimOwner, claimBrowser, releaseBrowser } from "./cdp.ts";
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

test("删除会话会杀掉它的后台 job、放开它认领的浏览器；别的会话的 job 不受影响", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-m5-"));
  const doomed = "m5-deleted-session";
  const other = "m5-other-session";
  try {
    const started = await bashTool.run({ command: SLEEP, background: true }, ctxFor(doomed, root));
    assert.ok(started.ok, started.summary);
    await bashTool.run({ command: SLEEP, background: true }, ctxFor(other, root));
    assert.equal(claimBrowser(doomed), null);
    assert.equal(liveJobCount(doomed), 1);

    const r = await deleteSession(doomed);
    assert.equal(r.stopped.jobsKilled, 1, "被删会话的后台 job 要杀掉");
    assert.equal(liveJobCount(doomed), 0);
    assert.equal(liveJobCount(other), 1, "别的会话的 job 不许误杀");
    assert.equal(browserClaimOwner(), "", "被删会话认领的浏览器要放开");
  } finally {
    killJobsFor(doomed);
    killJobsFor(other);
    releaseBrowser(doomed);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 刚杀掉的子进程可能还攥着 cwd */
    }
  }
});
