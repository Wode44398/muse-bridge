// P9（K22、C3）：回滚前分出「对话之外的改动」。
//
// 修前：回滚无条件 checkout-index -f + clean -fdq——人在电脑前手改的文件（包括手改 agent 刚写的那个）、手建的文件、
// 别的对话的改动，一点回滚就被静默覆盖或删掉，事先不提一句。
// 修后：每一轮跑完补一张结束快照；要被回滚改动的文件里，现在的内容不是这个对话最后一次留下的样子的，单列出来，
// 不带 force 就不回滚。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { listCheckpoints, recordRunEnd, rollbackPlan, takeCheckpoint } from "./checkpoints.ts";
import { dropSession, PRE_ROLLBACK_LABEL, rollbackSession } from "./session.ts";
import type { PersistedSession } from "./store.ts";
import { calls, call, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { ok, type Tool } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
afterEach(() => {
  if (BASE_SESSIONS_DIR !== undefined) process.env.SESSIONS_DIR = BASE_SESSIONS_DIR; // 还原，不 delete（见 test-setup.ts）
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const rec = (id: string, ws: string): PersistedSession => ({
  v: 1, id, createdAt: 1, updatedAt: Date.now(), title: "t",
  config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto", workspace: ws, access: "workspace" },
  system: "s",
  messages: [],
  todos: [],
  totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
  gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
  counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
});

test("P9: 从没被这个对话改过的文件、这个对话改完又被人手改的文件，都算外部改动；它自己留下的不算", async () => {
  process.env.SESSIONS_DIR = temp("dimensio-p9b-state-");
  const ws = temp("dimensio-p9b-ws-");
  const id = "p9b-plan";
  const w = (rel: string, text: string) => fs.writeFileSync(path.join(ws, rel), text);
  w("keep.txt", "base\n");

  const cp1 = await takeCheckpoint(rec(id, ws), ws, "msg1"); // 第一轮开跑
  w("agent.txt", "agent v1\n");
  await recordRunEnd(id, ws, cp1!.n); // 第一轮收尾
  w("human.txt", "手建的\n"); // 两轮之间人手建的
  const cp2 = await takeCheckpoint(rec(id, ws), ws, "msg2"); // 第二轮开跑
  w("agent2.txt", "agent v2\n");
  await recordRunEnd(id, ws, cp2!.n);
  w("agent.txt", "agent v1 + 人手改\n"); // 第二轮之后，人手改了 agent 第一轮写的文件

  const plan = await rollbackPlan(id, cp1!.n, ws);
  assert.deepEqual([...plan.changes].sort(), ["agent.txt", "agent2.txt", "human.txt"]);
  assert.deepEqual([...plan.external].sort(), ["agent.txt", "human.txt"], "agent2.txt 是这个对话留下的原样，不算");

  // 回滚到第二轮之前：human.txt 已在那张快照里，不是这次回滚要动的
  const plan2 = await rollbackPlan(id, cp2!.n, ws);
  assert.deepEqual([...plan2.changes].sort(), ["agent.txt", "agent2.txt"]);
  assert.deepEqual(plan2.external, ["agent.txt"]);
});

test("P9: 没有结束快照的旧记录照旧不拦（不凭空冒出一堆假的外部改动）", async () => {
  process.env.SESSIONS_DIR = temp("dimensio-p9b-state-");
  const ws = temp("dimensio-p9b-ws-");
  const id = "p9b-legacy";
  await takeCheckpoint(rec(id, ws), ws, "msg1");
  fs.writeFileSync(path.join(ws, "a.txt"), "run1\n");
  await takeCheckpoint(rec(id, ws), ws, "msg2");
  fs.writeFileSync(path.join(ws, "b.txt"), "run2\n");
  const plan = await rollbackPlan(id, 1, ws);
  assert.deepEqual([...plan.changes].sort(), ["a.txt", "b.txt"]);
  assert.deepEqual(plan.external, []);
});

// 真走一轮：收尾时补结束快照是 executeRun 自己做的
const scribe: Tool = {
  effect: "exec",
  concurrencySafe: false,
  def: { name: "Scribe", description: "write notes", parameters: { type: "object", properties: {} } },
  async run(_args, ctx) {
    fs.writeFileSync(path.join(ctx.sandbox.root, "notes.txt"), "agent wrote this\n");
    return ok("written", "done");
  },
};

test("P9: 手改过的文件不带 force 不回滚、列给人看；确认后回滚，撤销回滚也不被拦、手改的内容回来", async (t) => {
  process.env.SESSIONS_DIR = temp("dimensio-p9b-state-");
  const ws = temp("dimensio-p9b-ws-");
  const notes = path.join(ws, "notes.txt");
  const mine = path.join(ws, "mine.txt");

  const adapter = scripted(t).next(calls(call("s1", "Scribe", {})), say("写好了")).always(say("好了"));
  const session = attachSession(adapter, ws, { tools: [scribe] });
  const id = session.id;
  await send(session, "记一下");
  dropSession(id);

  // 没人动过：只有 agent 自己的改动。（rollbackPlan 排在收尾补的结束快照后面，先问它、再读索引）
  const clean = await rollbackPlan(id, 1, ws);
  assert.deepEqual(clean.changes, ["notes.txt"]);
  assert.deepEqual(clean.external, [], "只有 agent 自己的改动");
  const [cp] = await listCheckpoints(id);
  assert.ok(cp?.endTree, "这一轮收尾补了结束快照");
  assert.equal(fs.readFileSync(notes, "utf8"), "agent wrote this\n");

  fs.writeFileSync(notes, "agent wrote this\n人又补了一行\n");
  fs.writeFileSync(mine, "我自己的文件\n");

  const refused = await rollbackSession(id, cp.n);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "external");
  assert.deepEqual([...(refused.external ?? [])].sort(), ["mine.txt", "notes.txt"]);
  assert.equal(fs.readFileSync(notes, "utf8"), "agent wrote this\n人又补了一行\n", "没回滚，一个字节没动");
  assert.ok(fs.existsSync(mine));
  assert.equal((await listCheckpoints(id)).length, 1, "拦下时也不拍回滚前现场");

  assert.deepEqual(await rollbackSession(id, cp.n, { force: true }), { ok: true });
  assert.equal(fs.existsSync(notes), false, "确认后照回滚：agent 这一轮写的文件没了");
  assert.equal(fs.existsSync(mine), false);

  const undo = (await listCheckpoints(id)).at(-1)!;
  assert.equal(undo.label, PRE_ROLLBACK_LABEL.slice(0, 60));
  assert.deepEqual(await rollbackSession(id, undo.n), { ok: true }, "撤销回滚：回滚自己的改动记在这个对话名下，不被拦");
  assert.equal(fs.readFileSync(notes, "utf8"), "agent wrote this\n人又补了一行\n", "手改的内容回来了");
  assert.equal(fs.readFileSync(mine, "utf8"), "我自己的文件\n");
});
