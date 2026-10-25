// 新会话一开跑就要出现在会话列表里（以前发了个「你好」之后列表里压根没这个对话）。
// 列表原来只读磁盘，而新会话第一次落盘要等检查点 + 知识召回——大工作区十几秒，期间侧栏刷新拿不到它。
// 现在 /api/sessions 把内存里已开跑的会话（liveSessionMetas）并进来，盘上有的以盘上为准。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setConfig } from "./config.ts";
import { createSession, dropSession, liveSessionMetas, startRun } from "./session.ts";
import { listSessionsPage, sessionFilePath } from "./store.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";

test("startRun 当下（盘上还没有记录）新会话就在列表里，带标题、工作区与配置；删掉的不再出现", async (t) => {
  t.mock.method(console, "log", () => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-list-visible-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  setConfig({ provider: "openai", model: "deepseek-flash", apiKey: "DUMMY-list-visible-key", workspace: root, access: "workspace" });
  const session = createSession();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = startRun(session, "你好");
  session.state!.adapter = scripted(t).next(async function* () {
    await gate;
    yield* say("你好！");
  });
  try {
    assert.equal(fs.existsSync(sessionFilePath(session.id)!), false, "前提：这一刻盘上还没有它");
    const page = await listSessionsPage({ live: liveSessionMetas() });
    const row = page.items.find((m) => m.id === session.id);
    assert.ok(row, "会话在跑第一轮，列表里就该有它");
    assert.equal(row!.title, "你好");
    assert.equal(row!.workspace, root);
    assert.equal(row!.provider, "openai");
    assert.equal(page.items[0].id, session.id, "最新的排在最前");
    assert.equal(page.items.filter((m) => m.id === session.id).length, 1);
  } finally {
    release();
    await run.done;
  }
  const after = await listSessionsPage({ live: liveSessionMetas() });
  assert.equal(after.items.filter((m) => m.id === session.id).length, 1, "落盘之后盘上 + 内存不重复");
  dropSession(session.id);
  const gone = liveSessionMetas().some((m) => m.id === session.id);
  assert.equal(gone, false, "删掉（discarded）的会话不从内存补回列表");
});
