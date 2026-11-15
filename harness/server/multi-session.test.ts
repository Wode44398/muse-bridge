// Item 39/41/42/46/47 of the 07-29 review: process-wide singletons leaked across
// concurrent sessions, and idle sessions never left memory. These assert the
// scoping contracts directly — each one was written to fail before its fix.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashTool, killJobsFor, liveJobCount } from "./tools/bash.ts";
import { closeAllBrowserSessions, closeBrowser, existingBrowser, getBrowser } from "./cdp.ts";
import { withFakeBrowsers } from "./test-harness/fake-browser.ts";
import { isPureSocialTurn } from "./agent/state.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";

// A just-killed child can still hold the cwd on Windows (EPERM on rm); the dir is
// in the OS temp anyway, so teardown is best-effort.
const cleanup = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will reap it */
  }
};

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

// A command that stays alive long enough to be polled from the "other" session.
const SLEEP = process.platform === "win32" ? "ping -n 6 127.0.0.1 > NUL" : "sleep 5";

test("background jobs are invisible to another session", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jobscope-"));
  try {
    const a = ctxFor("session-A", root);
    const b = ctxFor("session-B", root);

    const started = await bashTool.run({ command: SLEEP, background: true }, a);
    assert.equal(started.ok, true, "job should start");
    const jobId = /job\d+/.exec(started.content.map((c: any) => c.text ?? "").join(" "))?.[0];
    assert.ok(jobId, "a job id is reported to its owner");
    assert.equal(liveJobCount("session-A"), 1);

    // B must not be able to read A's output...
    const bPoll = await bashTool.run({ poll: jobId }, b);
    assert.equal(bPoll.ok, false, "another session's poll must fail");
    assert.match(bPoll.content.map((c: any) => c.text).join(""), /No background job/);
    // ...nor kill it.
    const bKill = await bashTool.run({ kill: jobId }, b);
    assert.equal(bKill.ok, false, "another session's kill must fail");
    assert.equal(liveJobCount("session-A"), 1, "A's job survives B's kill attempt");

    // The owner still sees it.
    const aPoll = await bashTool.run({ poll: jobId }, a);
    assert.equal(aPoll.ok, true, "the owner can poll its own job");
  } finally {
    killJobsFor("session-A");
    killJobsFor("session-B");
    cleanup(root);
  }
});

test("stopping a session reaps only its own jobs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jobreap-"));
  try {
    await bashTool.run({ command: SLEEP, background: true }, ctxFor("session-A", root));
    await bashTool.run({ command: SLEEP, background: true }, ctxFor("session-B", root));
    assert.equal(liveJobCount("session-A"), 1);
    assert.equal(liveJobCount("session-B"), 1);

    const killed = killJobsFor("session-A");
    assert.equal(killed, 1, "A's live job was killed");
    assert.equal(liveJobCount("session-A"), 0);
    assert.equal(liveJobCount("session-B"), 1, "B's job is untouched");
  } finally {
    killJobsFor("session-A");
    killJobsFor("session-B");
    cleanup(root);
  }
});

// 11-14：以前全进程一个浏览器、一次只许一个会话用（第二个会话被拒）；现在按会话各开一份，谁也不拒谁。
test("every session gets its own browser: nobody is refused, the owner (and its sub-agents) re-enter the same one", async () => {
  await withFakeBrowsers(async (launched) => {
    try {
      const a = await getBrowser("session-A");
      const b = await getBrowser("session-B");
      assert.notEqual(a, b, "a second session gets its own browser, not a refusal and not A's page");
      assert.equal(await getBrowser("session-A"), a, "the owner may re-enter (sub-agents carry the parent's ownerId)");
      assert.equal(launched.length, 2);
      assert.equal(existingBrowser(""), undefined, "the unowned default browser is a separate one and was never started");

      await closeBrowser("session-A");
      assert.equal(existingBrowser("session-A"), undefined);
      assert.equal(existingBrowser("session-B"), b, "closing A's browser leaves B's alone");
      assert.notEqual(await getBrowser("session-A"), a, "after close, A gets a fresh one");
    } finally {
      closeAllBrowserSessions();
    }
  });
});

test("bare acknowledgements skip the memory-audit gate, real content does not", () => {
  for (const t of ["好的", "好", "收到", "ok", "OK！", "okay", "明白了", "知道了", "嗯嗯", "行", "没问题", "got it", "谢谢"]) {
    assert.equal(isPureSocialTurn(t), true, `"${t}" is a bare acknowledgement`);
  }
  for (const t of [
    "好的，那就改成蓝色",
    "收到，另外以后都用中文",
    "ok now fix the login bug",
    "行吗？先看看这个函数",
    "是",       // bare yes/no deliberately excluded: it can carry a decision
    "不要用 tailwind",
  ]) {
    assert.equal(isPureSocialTurn(t), false, `"${t}" carries content`);
  }
});
