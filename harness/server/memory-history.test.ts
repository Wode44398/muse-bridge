// K2（#28）：记忆变更可逆 + 来源机械化。改写自探针 03-hermes-agent/笔记/probe-memory-irreversible.ts（#19a/#19b）。
//
// 修前：模型一句 Remember(delete) 就能永久抹掉用户确认过的 active 条目，盘上什么都不剩；同 id 覆盖不留旧版；
// 一条记忆是谁写的、写时有没有人在场，答不上来。

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listMemories, memoryDir, readMemory, saveMemory } from "./memory.ts";
import { rememberTool } from "./tools/remember.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
// test-setup.ts 给的基线（临时目录）。收尾还原它，不要 delete——delete 之后的解析会回落到生产目录（#14），Q8 起直接抛错。
const BASE_MEMORY_DIR = process.env.MEMORY_DIR;
afterEach(() => {
  if (BASE_MEMORY_DIR === undefined) delete process.env.MEMORY_DIR;
  else process.env.MEMORY_DIR = BASE_MEMORY_DIR;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup(attended = false) {
  process.env.MEMORY_DIR = temp("dimensio-k2-memory-");
  const ws = temp("dimensio-k2-ws-");
  const ctx: ToolContext = {
    sandbox: new Sandbox(ws),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1, bashMaxTimeoutMs: 1 },
    agentSeesImages: false,
    humanAttended: () => attended,
  };
  const history = () => {
    const dir = path.join(memoryDir(ws), ".history");
    return existsSync(dir) ? readdirSync(dir).map((f) => ({ f, text: readFileSync(path.join(dir, f), "utf8") })) : [];
  };
  return { ws, ctx, history };
}

test("#19a 模型删用户确认过的条目：改为软删（stale），旧版进 .history", async () => {
  const { ws, ctx, history } = setup();
  saveMemory(ws, {
    title: "user language", description: "User wants Chinese replies.", type: "user",
    topic: "user.language", status: "active", confidence: "user_confirmed", content: "Always reply in Chinese.",
  });
  const r = await rememberTool.run({ action: "delete", id: "user-language" }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.summary, /retired/);
  const note = readMemory(ws, "user-language");
  assert.ok(note, "条目还在");
  assert.equal(note.status, "stale", "不再注入新会话");
  assert.ok(history().some((h) => h.f.startsWith("user-language.") && /\.retire\.md$/.test(h.f) && /Always reply in Chinese/.test(h.text)));
});

test("模型删一条未确认的条目：真删，但旧版同样进 .history", async () => {
  const { ws, ctx, history } = setup();
  saveMemory(ws, {
    title: "guess", description: "A guess.", type: "reference", topic: "misc.guess",
    status: "proposed", confidence: "observed", evidence: ["saw it once"], content: "maybe X",
  });
  const r = await rememberTool.run({ action: "delete", id: "guess" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(readMemory(ws, "guess"), undefined);
  assert.ok(history().some((h) => /^guess\..*\.delete\.md$/.test(h.f) && /maybe X/.test(h.text)));
});

test("#19b 同 id 覆盖：旧版进 .history", async () => {
  const { ws, ctx, history } = setup();
  const base = {
    title: "build cmd", description: "How to build.", type: "reference", topic: "build.cmd",
    status: "proposed", confidence: "observed", evidence: ["ran npm run build"],
  };
  saveMemory(ws, { ...base, content: "ORIGINAL: npm run build:prod" } as never);
  const r = await rememberTool.run({ ...base, content: "REPLACED: make" }, ctx);
  assert.equal(r.ok, true);
  assert.equal(readMemory(ws, "build-cmd")?.content, "REPLACED: make");
  assert.ok(history().some((h) => /^build-cmd\..*\.overwrite\.md$/.test(h.f) && /ORIGINAL: npm run build:prod/.test(h.text)));
});

test("来源由服务端记：Remember 固定 model + 当时有没有人在场；界面保存固定 user", async () => {
  const unattended = setup(false);
  await rememberTool.run({
    title: "note a", description: "d.", type: "reference", topic: "misc.a", status: "proposed",
    confidence: "observed", evidence: ["x"], content: "a",
  }, unattended.ctx);
  const a = listMemories(unattended.ws).find((m) => m.id === "note-a")!;
  assert.equal(a.origin, "model");
  assert.equal(a.attended, false);

  const attended = setup(true);
  await rememberTool.run({
    title: "note b", description: "d.", type: "reference", topic: "misc.b", status: "proposed",
    confidence: "observed", evidence: ["x"], content: "b",
  }, attended.ctx);
  assert.equal(listMemories(attended.ws).find((m) => m.id === "note-b")!.attended, true);

  saveMemory(attended.ws, {
    title: "note c", description: "d.", type: "reference", topic: "misc.c", status: "proposed",
    confidence: "observed", evidence: ["x"], content: "c", origin: { writer: "user", attended: true },
  });
  assert.equal(listMemories(attended.ws).find((m) => m.id === "note-c")!.origin, "user");
});
