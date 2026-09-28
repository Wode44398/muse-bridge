// M11（K29、N33）：会话生命周期按 id 串行 + 回滚期间全局静默；新会话显式携带界面显示的配置快照。
//
// 修前：回滚一路 await git 操作好几秒，只在入口查一次「有没有会话在跑」——窗口期里别的会话照样能开跑（agent 在一个
// 正被 checkout 的工作区里干活）；同一会话能被删，删完又被回滚写回来；这个会话迟到的落盘能把旧状态盖在回滚结果上。
// 新会话一律读全局配置，而全局值是「最后一个切前台的设备」写的：手机刚切的项目、整机访问、auto 档会串进电脑上新建的对话。
// 修后：回滚 / 删除按会话 id 排队；回滚期间 startRun 不起（409「正在回滚」）、这个会话不落盘；新会话用发起端带来的
// 配置快照（按设置页同一套规则校验，全局只作默认）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import { listCheckpoints } from "./checkpoints.ts";
import { getConfig, sessionConfigSnapshot, setConfig } from "./config.ts";
import {
  createSession, deleteSession, dropSession, persistNow, rollbackInProgress, rollbackSession, startRun, type Session,
} from "./session.ts";
import { sessionFilePath } from "./store.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function workspace(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  fs.writeFileSync(path.join(root, "notes.txt"), "v1\n");
  return root;
}
const tick = () => new Promise<void>((r) => setImmediate(r));

// 生产路径建一条跑过一轮寒暄的会话（开跑时拍了检查点）；假 key 只为让它建得起来，模型换成脚本
async function sessionWithCheckpoint(t: TestContext, root: string, adapter: ReturnType<typeof scripted>): Promise<{ session: Session; n: number }> {
  t.mock.method(console, "log", () => {});
  setConfig({ provider: "openai", model: "fake-model", apiKey: "DUMMY-m11-key", workspace: root, permissionMode: "auto", access: "workspace" });
  const session = createSession();
  const first = startRun(session, "你好");
  session.state!.adapter = adapter;
  await first.done;
  const cp = (await listCheckpoints(session.id)).filter((c) => !c.kind).at(-1);
  assert.ok(cp, "开跑时要拍检查点");
  return { session, n: cp.n };
}

test("M11 回滚期间全局静默：别的会话起不了新一轮；回滚中的会话落不了盘；回滚完一切照常", async (t) => {
  const root = workspace("dimensio-m11-quiesce-");
  const adapter = scripted(t).next(say("你好！"), say("好的"));
  const { session, n } = await sessionWithCheckpoint(t, root, adapter);
  const other = createSession();

  const rolling = rollbackSession(session.id, n);
  await tick(); // 回滚已占上静默标记，正在 git 操作里
  assert.equal(rollbackInProgress(), session.id);
  const refused = startRun(other, "趁回滚开跑");
  assert.equal(refused.started, false, "回滚在 checkout 工作区，这时开跑的 agent 会在半截的文件上干活");
  assert.equal(refused.rollingBack, true);
  // 这个会话的迟到落盘（防抖计时器、切档……）不许写：回滚写回的记录才是真相
  session.state!.messages.push({ role: "user", content: [{ t: "text", text: "LATE-PERSIST-MARKER" }] });
  await persistNow(session);
  assert.equal(fs.readFileSync(sessionFilePath(session.id)!, "utf8").includes("LATE-PERSIST-MARKER"), false, "回滚期间这个会话不落盘");
  assert.deepEqual(await rolling, { ok: true });
  assert.equal(rollbackInProgress(), null);
  assert.equal(fs.readFileSync(sessionFilePath(session.id)!, "utf8").includes("LATE-PERSIST-MARKER"), false);

  const again = startRun(other, "谢谢"); // 寒暄：不召回、不要求记忆审计
  assert.equal(again.started, true, "回滚结束，静默解除");
  other.state!.adapter = adapter;
  await again.done;
  dropSession(other.id);
});

test("M11 同一会话的回滚与删除按 id 排队：删除等回滚做完再删，回滚不会把刚删掉的会话写回来", async (t) => {
  const root = workspace("dimensio-m11-serial-");
  const adapter = scripted(t).next(say("你好！"));
  const { session, n } = await sessionWithCheckpoint(t, root, adapter);
  const file = sessionFilePath(session.id)!;
  const rolling = rollbackSession(session.id, n);
  const deleting = deleteSession(session.id); // 回滚还在 git 操作里就点了删除
  assert.deepEqual(await rolling, { ok: true });
  assert.equal((await deleting).deleted, true);
  assert.equal(fs.existsSync(file), false, "删掉的会话不许被回滚写回来");
});

test("M11 新会话按发起端带来的配置快照建（全局只作默认，也不被改）；快照按设置页同一套规则校验", async (t) => {
  t.mock.method(console, "log", () => {});
  const home = workspace("dimensio-m11-global-");
  const mine = workspace("dimensio-m11-mine-");
  // 全局值是另一台设备刚写的：它的项目、整机访问、auto 档
  setConfig({ provider: "openai", model: "fake-model", apiKey: "DUMMY-m11-key", workspace: home, permissionMode: "auto", access: "full" });
  const snapshot = sessionConfigSnapshot({ provider: "openai", model: "fake-model", workspace: mine, access: "workspace", permissionMode: "plan" });
  const session = createSession(snapshot);
  const adapter = scripted(t).next(say("我先看看。"), say("只是寒暄，没有要改的。")); // plan 档没交计划就想收尾 → 提醒一次
  const run = startRun(session, "你好");
  session.state!.adapter = adapter;
  await run.done;
  assert.equal(session.cfg?.workspace, path.resolve(mine), "用的是这台设备界面上显示的项目");
  assert.equal(session.cfg?.access, "workspace");
  assert.equal(session.cfg?.permissionMode, "plan");
  assert.equal(session.state!.ctx.sandbox.root, path.resolve(mine));
  const g = getConfig();
  assert.deepEqual([g.workspace, g.access, g.permissionMode], [path.resolve(home), "full", "auto"], "快照不改全局");

  // 不带快照（旧客户端）：照旧读全局
  const legacy = createSession();
  const run2 = startRun(legacy, "你好");
  legacy.state!.adapter = scripted(t).next(say("你好！"));
  await run2.done;
  assert.equal(legacy.cfg?.workspace, path.resolve(home));

  assert.throws(() => sessionConfigSnapshot({ provider: "no-such-provider" }), /unknown provider/);
  assert.throws(() => sessionConfigSnapshot({ access: "everything" }), /invalid access/);
  assert.throws(() => sessionConfigSnapshot({ permissionMode: "bypass" }), /invalid permissionMode/);
  assert.throws(() => sessionConfigSnapshot({ workspace: path.join(mine, "no-such-dir") }), /does not exist/);
  assert.throws(() => sessionConfigSnapshot({ model: 42 }), /must be a non-empty string/);
  assert.throws(() => sessionConfigSnapshot("openai"), /must be an object/);
  dropSession(session.id);
  dropSession(legacy.id);
});
