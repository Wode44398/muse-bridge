// 会话内换型号 / 思考深度：以前型号菜单只写全局配置，已经开跑的会话照旧用建会话时拍下的型号——菜单上勾着新型号、
// 回答的还是旧的（用户在「模型服务」里自己加的服务型号多，最先撞上）。现在点名当前会话：空闲当场按新配置重建，
// 运行中下一条消息起生效；对话、读过的文件都留着，system 里的身份句跟着换，全局只作新对话的默认。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getConfig, setConfig } from "./config.ts";
import { addCustomProvider, removeCustomProvider, setCustomSecretsForTests } from "./custom-providers.ts";
import { createSession, dropSession, setSessionModel, startRun, watchSession, type Session } from "./session.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

// 生产路径建一条在 DeepSeek V4.1 Flash 上跑过一轮的会话；假 key 只为让它建得起来，模型换成脚本
async function startedSession(t: TestContext): Promise<Session> {
  t.mock.method(console, "log", () => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-session-model-"));
  roots.push(root);
  setConfig({ provider: "openai", model: "deepseek-flash", thinking: "low", apiKey: "DUMMY-session-model-key", workspace: root, permissionMode: "auto", access: "workspace" });
  const session = createSession();
  const run = startRun(session, "你好");
  session.state!.adapter = scripted(t).next(say("你好！"));
  await run.done;
  return session;
}

test("空闲时换型号：当场按新型号重建（对话保留、身份句跟着换、深度按新型号收档），全局不动、附着设备收到广播", async (t) => {
  const session = await startedSession(t);
  const before = session.state!;
  const messages = before.messages.length;
  before.ctx.readFileState.set("/tmp/x.txt", { mtimeMs: 1, size: 1 } as any);
  const events: any[] = [];
  watchSession(session, (ev) => events.push(ev));

  const r = setSessionModel(session, { model: "deepseek-v4-pro" });
  assert.deepEqual(r, { ok: true, model: "deepseek-v4-pro", thinking: "off" }, "V4 Pro 没有 low 档，收到不高于它的 off");
  const state = session.state!;
  assert.notEqual(state, before, "状态按新型号重建");
  assert.equal(state.adapter.model, "deepseek-v4-pro", "下一次请求就发给新型号");
  assert.equal(state.budget.thinking, "off");
  assert.equal(state.messages.length, messages, "对话一条不少");
  assert.ok(state.ctx.readFileState.has("/tmp/x.txt"), "读过的文件照旧算读过");
  assert.match(state.system, /You are running as the "deepseek-v4-pro" model/, "问它是什么模型要答对");
  assert.doesNotMatch(state.system, /"deepseek-flash" model/);
  assert.equal(session.cfg?.model, "deepseek-v4-pro", "快照配置跟上，重开会话不回退");
  assert.equal(session.cfg?.thinking, "off");
  assert.ok(events.some((e) => e.e === "model" && e.model === "deepseek-v4-pro" && e.thinking === "off"));
  assert.equal(getConfig().model, "deepseek-flash", "会话级：不改全局");

  // 新状态照样能切档（回调挂回来了）、能接着跑
  const run = startRun(session, "谢谢");
  session.state!.adapter = scripted(t).next(say("不客气"));
  await run.done;
  assert.equal(session.state!.messages.length > messages, true);
  dropSession(session.id);
});

test("同值 = 幂等（不重建、不广播）；只换深度也生效；别家的型号、乱写的深度挡在门外", async (t) => {
  const session = await startedSession(t);
  const events: any[] = [];
  watchSession(session, (ev) => events.push(ev));
  const before = session.state!;

  assert.deepEqual(setSessionModel(session, { model: "deepseek-flash" }), { ok: true, model: "deepseek-flash", thinking: "low" });
  assert.equal(session.state, before);
  assert.equal(events.filter((e) => e.e === "model").length, 0);

  assert.deepEqual(setSessionModel(session, { thinking: "max" }), { ok: true, model: "deepseek-flash", thinking: "max" });
  assert.equal(session.state!.budget.thinking, "max");

  assert.equal(setSessionModel(session, { model: "glm-5.2" }).ok, false, "换家 = 开新对话，不在会话里换");
  assert.equal(setSessionModel(session, { model: 42 }).ok, false);
  assert.deepEqual(setSessionModel(session, { thinking: "ultra" }), { ok: false, error: "invalid thinking level" });
  assert.equal(session.cfg?.model, "deepseek-flash");
  assert.deepEqual(setSessionModel(createSession(), { model: "deepseek-flash" }), { ok: false, error: "session has not started" });
  dropSession(session.id);
});

test("用户自己加的服务（custom-…）：会话里在它的型号之间换，同样当场生效", async (t) => {
  t.mock.method(console, "log", () => {});
  let store: Record<string, { headers?: Record<string, string> }> = {};
  setCustomSecretsForTests({ readSecrets: () => store, writeSecrets: (_root, map) => { store = JSON.parse(JSON.stringify(map)); } });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "my-chat-7b" }, { id: "my-chat-70b" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); setCustomSecretsForTests(null); });
  const { provider } = await addCustomProvider({ name: "网关", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "sk-FAKE-session-model" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-session-model-custom-"));
  roots.push(root);
  setConfig({ provider: provider.id, model: "my-chat-7b", workspace: root, permissionMode: "auto", access: "workspace" });
  const session = createSession();
  const run = startRun(session, "你好");
  session.state!.adapter = scripted(t).next(say("你好！"));
  await run.done;

  assert.deepEqual(setSessionModel(session, { model: "my-chat-70b" }), { ok: true, model: "my-chat-70b", thinking: "off" });
  assert.equal(session.state!.adapter.model, "my-chat-70b");
  assert.equal(session.state!.adapter.id, provider.id);
  assert.match(session.state!.system, new RegExp(`"my-chat-70b" model, served via the ${provider.id} provider`));
  dropSession(session.id);
  await removeCustomProvider(provider.id);
});

test("运行中换型号：这一轮不受影响，回 pending；下一轮开跑前按新型号重建", async (t) => {
  const session = await startedSession(t);
  const before = session.state!;
  session.running = true; // 正在跑的那一轮（只看分支，不真跑）
  const r = setSessionModel(session, { model: "deepseek-v4-pro" });
  assert.deepEqual(r, { ok: true, model: "deepseek-v4-pro", thinking: "off", pending: true });
  assert.equal(session.state, before, "跑着的这一轮不换状态");
  assert.equal(before.adapter.model, "fake");
  session.running = false;

  const run = startRun(session, "继续");
  const used = session.state!.adapter.model;
  session.state!.adapter = scripted(t).next(say("好"));
  await run.done;
  assert.equal(used, "deepseek-v4-pro", "下一条消息起用新型号");
  assert.notEqual(session.state, before);
  assert.equal(session.modelRebindPending, false);
  dropSession(session.id);
});
