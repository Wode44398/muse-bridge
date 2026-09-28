// #66 回归：08-20 视频入模把裸 `.ts` 放进了视频扩展名，Read 任何 TypeScript 源码都报
// 「unsupported video」（Edit 要求先 Read，.ts 于是基本改不了），拖进对话的 .ts 附件也被拒。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { looksLikeVideoPath } from "./video.ts";
import { Sandbox } from "./sandbox.ts";
import { readTool } from "./tools/read.ts";

test("#66: .ts is TypeScript, not a video container", () => {
  assert.equal(looksLikeVideoPath("src/index.ts"), false);
  assert.equal(looksLikeVideoPath("clip.mp4"), true);
  assert.equal(looksLikeVideoPath("clip.m2ts"), true);
});

test("#66: Read returns a TypeScript file as numbered text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-read-ts-"));
  try {
    fs.writeFileSync(path.join(root, "index.ts"), "export const answer: number = 42;\n");
    const r = await readTool.run(
      { path: "index.ts" },
      {
        sandbox: new Sandbox(root),
        readFileState: new Map(),
        setTodos: () => {},
        limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
        agentSeesImages: false,
      },
    );
    assert.equal(r.ok, true, JSON.stringify(r.content));
    assert.match(JSON.stringify(r.content), /export const answer/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
