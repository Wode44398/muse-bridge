// R10（二）Context Recovery 的落盘与沙箱：归档写在会话存储下各会话自己的目录里，编号接着往下排；沙箱只对本会话那一个
// 目录开只读豁免（Read、Grep 都能用，写照旧拒绝，别的会话的归档不放）；删会话时一并删掉。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveDir, deleteSessionArchive, planArchive, writeArchive } from "./compaction-archive.ts";
import { sessionsDir } from "./paths.ts";
import { Sandbox } from "./sandbox.ts";
import { deleteSession } from "./session.ts";
import { grepTool } from "./tools/grep.ts";
import { readTool } from "./tools/read.ts";
import type { ToolContext } from "./tools/types.ts";

const ctxFor = (sandbox: Sandbox): ToolContext => ({
  sandbox,
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 10_000 },
  agentSeesImages: false,
});
const textOf = (r: { content?: { t: string; text?: string }[] }) => (r.content ?? []).map((b) => b.text ?? "").join("");

test("R10（二）归档写在会话存储下这个会话自己的目录；编号接着已有的最大号往下排，分片各带序号", async (t) => {
  const id = "r10b-plan";
  t.after(() => deleteSessionArchive(id));
  assert.equal(path.dirname(path.dirname(archiveDir(id))), sessionsDir());
  assert.throws(() => archiveDir("../evil"), /invalid session id/);
  const [first] = planArchive(id, 1);
  assert.equal(path.basename(first), "compacted-1.txt");
  await writeArchive([{ path: first, text: "a" }]);
  const parts = planArchive(id, 2);
  assert.deepEqual(parts.map((f) => path.basename(f)), ["compacted-2-1.txt", "compacted-2-2.txt"]);
  await writeArchive(parts.map((p) => ({ path: p, text: "b" })));
  assert.equal(path.basename(planArchive(id, 1)[0]), "compacted-3.txt");
  assert.equal(fs.readFileSync(first, "utf8"), "a");
});

test("R10（二）沙箱：本会话的归档目录只读放行（Read、Grep 都能用），写照旧拒绝；别的会话的归档不放；没开豁免的沙箱也不放", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r10b-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mine = "r10b-mine";
  const other = "r10b-other";
  t.after(() => deleteSessionArchive(mine));
  t.after(() => deleteSessionArchive(other));
  const [a] = planArchive(mine, 1);
  await writeArchive([{ path: a, text: "# Compaction archive\n### [msg 1] tool_result Bash (id b1) FAILED\nerror TS2345: bad thing\n" }]);
  const [b] = planArchive(other, 1);
  await writeArchive([{ path: b, text: "other session TS2345\n" }]);

  const sandbox = new Sandbox(root, "workspace");
  sandbox.setExtraReadDirs([archiveDir(mine)]);
  assert.equal(sandbox.resolve(a), a);
  assert.throws(() => sandbox.resolve(a, { forWrite: true }), /escapes the sandbox/);
  assert.throws(() => sandbox.resolve(b), /escapes the sandbox/);
  assert.throws(() => sandbox.resolve(path.join(archiveDir(mine), "..", other, "compacted-1.txt")), /escapes the sandbox/);

  const ctx = ctxFor(sandbox);
  const g = await grepTool.run({ pattern: "TS2345", path: archiveDir(mine) }, ctx);
  assert.ok(g.ok, g.summary);
  assert.match(textOf(g), /compacted-1\.txt:3: ?error TS2345: bad thing/);
  assert.doesNotMatch(textOf(g), /other session/);
  const r = await readTool.run({ path: a, offset: 2, limit: 2 }, ctx);
  assert.ok(r.ok, r.summary);
  assert.match(textOf(r), /error TS2345: bad thing/);

  const plain = new Sandbox(root, "workspace");
  assert.throws(() => plain.resolve(a), /escapes the sandbox/);
  await assert.rejects(readTool.run({ path: a }, ctxFor(plain)), /escapes the sandbox/);
});

test("R10（二）删会话时归档一并删掉", async () => {
  const id = "r10b-deleted";
  const [f] = planArchive(id, 1);
  await writeArchive([{ path: f, text: "x" }]);
  assert.ok(fs.existsSync(f));
  await deleteSession(id);
  assert.equal(fs.existsSync(archiveDir(id)), false);
});
