// S9（#24）：/api/info 带 codeSha / dirty / startedAt——部署后 harness 还在跑旧代码时能一眼看出来。

import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { BUILD_INFO } from "./build-info.ts";

const harnessDir = path.resolve(import.meta.dirname, "..");

test("BUILD_INFO 是进程启动时的 HEAD、工作树状态与启动时间", () => {
  const head = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: harnessDir, encoding: "utf8" }).stdout.trim();
  assert.match(head, /^[0-9a-f]{12}$/);
  assert.equal(BUILD_INFO.codeSha, head);
  assert.equal(typeof BUILD_INFO.dirty, "boolean");
  assert.ok(BUILD_INFO.startedAt <= Date.now() && BUILD_INFO.startedAt > Date.now() - 10 * 60_000);
  assert.ok(Object.isFrozen(BUILD_INFO), "启动时定格，之后不再变");
});
