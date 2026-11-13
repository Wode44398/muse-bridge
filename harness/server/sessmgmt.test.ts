// 会话管理（server/sessmgmt/）：稍后发送的队列、改名与 AI 标题、归档（含不活跃自动归档）、Tab 输入建议、经 bridge 的通知。
// 走真会话（session-fixture）与真接口（本文件自起一个 express，只挂会话管理的路由）；旁路小请求用脚本化 provider 顶替。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { StreamEvent } from "./agent/events.ts";
import type { Turn } from "./agent/turn.ts";
import { say, scripted, ScriptedAdapter } from "./test-harness/scripted-adapter.ts";
import { attachSession, send } from "./test-harness/session-fixture.ts";
import { persistNow, watchGlobal, type Session } from "./session.ts";
import { loadSession } from "./store.ts";
import { setPrefs } from "./prefs.ts";
import { mountSessionMgmt } from "./sessmgmt/index.ts";
import { setAuxAdapterFactory, auxCandidates } from "./sessmgmt/aux-model.ts";
import { archiveFilter, isArchived, setArchived, sweepInactive } from "./sessmgmt/archive.ts";
import { filterSuggestion, suggestionOf } from "./sessmgmt/suggest.ts";
import { parseTitle } from "./sessmgmt/titles.ts";
import { getFlags, getQueue, flushSessMgmtStore, reloadSessMgmtStore } from "./sessmgmt/store.ts";
import { notePresence, resetNotify } from "./sessmgmt/notify.ts";
import { sessionsDir } from "./paths.ts";

const roots: string[] = [];
const tmp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

// 旁路小请求（标题 / 建议）：按系统提示认是哪一种，答对应的话
let auxCalls: string[] = [];
let auxTitle = "修复登录按钮";
let auxSuggestion = "跑一下测试";
function auxStep(turn: Turn): StreamEvent[] {
  const sys = String(turn.system);
  const kind = sys.includes("SUGGESTION MODE") ? "suggest" : "title";
  auxCalls.push(kind);
  return say(kind === "suggest" ? auxSuggestion : auxTitle);
}

let base = "";
let server: http.Server;
const globalEvents: Record<string, unknown>[] = [];
before(async () => {
  setAuxAdapterFactory((cfg) => new ScriptedAdapter({ id: cfg.provider, model: cfg.model, validate: false }).always((turn) => auxStep(turn)));
  const app = express();
  app.use(express.json());
  mountSessionMgmt(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  watchGlobal((ev) => void globalEvents.push(ev));
});
after(() => {
  setAuxAdapterFactory(null);
  server?.close();
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows 句柄 */
    }
  }
});

const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const until = async (cond: () => boolean, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const userTexts = (s: Session) => s.state!.messages.filter((m) => m.role === "user" && !m.origin && !m.internal).map((m) => m.displayText ?? "");

test("会话管理的偏好项登记在注册表里（对齐 Claude 的同名设置，分组 chat / sessions / notify）", async () => {
  const r = (await import("./prefs.ts")).allPrefs();
  const by = new Map(r.items.map((i) => [i.key, i]));
  for (const [k, g] of [["promptSuggestions", "chat"], ["aiTitles", "chat"], ["autoArchiveDays", "sessions"], ["notifyPermission", "notify"], ["notifyQuestion", "notify"], ["notifyTaskComplete", "notify"]] as const) {
    assert.equal(by.get(k)?.group, g, k);
  }
  assert.equal(by.get("autoArchiveDays")?.default, "0", "默认不自动归档");
});

test("便宜模型：同一家里挑便宜档、失败再回会话自己的型号；没有便宜档的（本机、自定义）直接用会话的型号", () => {
  assert.deepEqual(auxCandidates({ provider: "anthropic", model: "claude-opus-5-5" }).map((c) => c.model), ["claude-haiku-5-5", "claude-opus-5-5"]);
  assert.deepEqual(auxCandidates({ provider: "openai", model: "deepseek-flash" }).map((c) => c.model), ["deepseek-flash"], "本来就是便宜档不重复");
  assert.deepEqual(auxCandidates({ provider: "local", model: "qwen3.8-27b" }).map((c) => c.model), ["qwen3.8-27b"]);
});

test("稍后发送：只在运行中排得进；这一轮收尾后整队合并成一条作为下一轮发出；队列落盘、各设备收到 queue 事件", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const adapter = scripted(t).next(
    async function* () {
      await gate;
      yield* say("第一轮做完了");
    },
    say("收到排队的两句"),
  );
  const session = attachSession(adapter, tmp("dimensio-sm-queue-"));
  // 没在跑：排不进（界面改走普通发送）
  assert.equal((await post(`/api/sessions/${session.id}/queue`, { text: "早了" })).status, 409);
  const run = send(session, "先做第一件事");
  await until(() => session.running, "开跑");
  const a = await post(`/api/sessions/${session.id}/queue`, { text: "然后提交", id: "q-test-0001" });
  assert.equal(a.status, 200);
  const b = await post(`/api/sessions/${session.id}/queue`, { text: "再推上去" });
  assert.equal(b.body.items.length, 2);
  assert.ok(globalEvents.some((e) => e.e === "queue" && e.id === session.id), "广播了 queue");
  await flushSessMgmtStore();
  const onDisk = JSON.parse(fs.readFileSync(path.join(sessionsDir(), "_mgmt", "queue.json"), "utf8"));
  assert.equal(onDisk[session.id].length, 2, "落盘了（服务重启不丢）");
  // 撤回一条再放回去：拿回来的就是原文
  const removed = await post(`/api/sessions/${session.id}/queue/remove`, { id: "q-test-0001" });
  assert.equal(removed.body.item.text, "然后提交");
  await post(`/api/sessions/${session.id}/queue`, { text: "然后提交" });
  release();
  await run;
  await until(() => userTexts(session).length === 2 && !session.running, "排队的话作为下一轮发出并跑完");
  assert.equal(userTexts(session)[1], "再推上去\n\n然后提交", "多条合并成一条（按排队顺序）");
  assert.equal(getQueue(session.id).length, 0, "发出后队列清空");
});

test("稍后发送 · 立即发送：从队列取出改成插话（这一轮还在跑）", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const adapter = scripted(t).next(
    async function* () {
      await gate;
      yield* say("第一步");
    },
  );
  const session = attachSession(adapter, tmp("dimensio-sm-promote-"));
  const run = send(session, "开始");
  await until(() => session.running, "开跑");
  const q = await post(`/api/sessions/${session.id}/queue`, { text: "顺便看下日志" });
  const p = await post(`/api/sessions/${session.id}/queue/promote`, { id: q.body.item.id });
  assert.deepEqual(p.body, { ok: true, how: "steer" });
  assert.equal(getQueue(session.id).length, 0);
  const steers: unknown[] = [];
  const off = (await import("./session.ts")).watchSession(session, (ev) => void (ev.e === "steer_returned" && steers.push(ev)));
  release();
  await run;
  off();
  // 这一轮没再到下一步就收了：插话按老规矩退回输入框（steer_returned）或已被读到——总之进了插话那条路，不在队列里了
  assert.ok(steers.length > 0 || session.state!.messages.some((m) => m.origin === "steer"), "走的是插话");
  assert.equal(getQueue(session.id).length, 0);
});

test("AI 起标题：首轮正常做完后用旁路请求起短标题并广播；用户改过名的不再覆盖；关了偏好就不起", async (t) => {
  auxCalls = [];
  auxTitle = "「修复登录按钮」";
  const adapter = scripted(t).next(say("改好了"), say("又改好了"));
  const session = attachSession(adapter, tmp("dimensio-sm-title-"));
  await send(session, "登录按钮在手机上点不动，帮我修一下");
  await until(() => session.title === "修复登录按钮", "AI 标题落到会话上");
  assert.ok(globalEvents.some((e) => e.e === "session_title" && e.id === session.id && e.title === "修复登录按钮"));
  assert.equal(getFlags(session.id).titleBy, "ai");
  // 用户改名：AI 不再动它
  const r = await post(`/api/sessions/${session.id}/rename`, { title: "  我的   登录修复 " });
  assert.deepEqual(r.body, { ok: true, title: "我的 登录修复" });
  assert.equal(getFlags(session.id).titleBy, "user");
  auxCalls = [];
  await send(session, "再看看注册页");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(session.title, "我的 登录修复");
  assert.ok(!auxCalls.includes("title"), "改过名的不再请求标题");
  assert.equal((await post(`/api/sessions/${session.id}/rename`, { title: "   " })).status, 400);
});

test("AI 标题：模型回的东西收拾干净；不像标题的不要", () => {
  assert.equal(parseTitle('{"title": "Fix login button"}'), "Fix login button");
  assert.equal(parseTitle("标题：给 API 客户端加重试。"), "给 API 客户端加重试");
  assert.equal(parseTitle("\n“调试 CI”\n解释：……"), "调试 CI");
  assert.equal(parseTitle(""), null);
  assert.equal(parseTitle("x".repeat(80)), null);
});

test("AI 标题落盘：不在内存里的会话改名直接改盘上的记录，且不把它顶到列表最上面（updatedAt 不变）", async (t) => {
  const adapter = scripted(t).next(say("好"));
  const session = attachSession(adapter, tmp("dimensio-sm-rename-disk-"));
  await setPrefs({ aiTitles: false });
  t.after(() => setPrefs({ aiTitles: null }));
  await send(session, "记一下");
  await persistNow(session);
  const before = (await loadSession(session.id))!;
  const r = await post(`/api/sessions/${session.id}/rename`, { title: "备忘" });
  assert.equal(r.status, 200);
  const afterRec = (await loadSession(session.id))!;
  assert.equal(afterRec.title, "备忘");
  assert.equal(afterRec.updatedAt, before.updatedAt);
});

test("输入建议：早期对话不出；之后每轮做完给一条、广播 suggestion；新一轮开跑即作废", async (t) => {
  auxCalls = [];
  auxSuggestion = "跑一下测试";
  const adapter = scripted(t).next(say("写好了函数"), say("加好了测试"), say("测试都过了"));
  const session = attachSession(adapter, tmp("dimensio-sm-suggest-"));
  await send(session, "写一个解析函数");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(suggestionOf(session.id), null, "官方 early_conversation：只有一条回答不出");
  await send(session, "补上测试");
  await until(() => suggestionOf(session.id)?.text === "跑一下测试", "第二轮后有建议");
  assert.ok(globalEvents.some((e) => e.e === "suggestion" && e.id === session.id && e.text === "跑一下测试"));
  const extras = (await (await fetch(`${base}/api/sessions/${session.id}/extras`)).json()) as any;
  assert.equal(extras.suggestion.text, "跑一下测试", "打开会话时取得到");
  const p = send(session, "跑吧");
  assert.equal(suggestionOf(session.id), null, "新一轮开跑即作废");
  await p;
});

test("输入建议的过滤（官方规则 + 中文对应写法）", () => {
  assert.equal(filterSuggestion("run the tests"), "run the tests");
  assert.equal(filterSuggestion("跑一下测试。"), "跑一下测试");
  assert.equal(filterSuggestion("yes"), "yes");
  for (const bad of ["looks good", "thanks!", "Let me run it", "done", "(silence)", "【无】", "我来跑测试", "谢谢，不错", "Run it. Then push it.", "先跑测试。再提交。", "Suggestion: run it", "**run**", ""]) {
    assert.equal(filterSuggestion(bad), null, bad);
  }
});

test("归档：列表过滤三种视图；在跑 / 有排队的跳过；真人在里面发消息自动取消归档", async (t) => {
  const adapter = scripted(t).next(say("好"), say("接着来"));
  const session = attachSession(adapter, tmp("dimensio-sm-archive-"));
  await send(session, "随便聊聊");
  const r = await post(`/api/sessions/${session.id}/archive`, { on: true });
  assert.deepEqual(r.body.changed, [session.id]);
  assert.ok(isArchived(session.id));
  const meta = { id: session.id } as Parameters<ReturnType<typeof archiveFilter>>[0];
  assert.equal(archiveFilter("exclude")(meta), false);
  assert.equal(archiveFilter("only")(meta), true);
  assert.equal(archiveFilter("include")(meta), true);
  assert.equal(archiveFilter("exclude", () => false)({ id: "other" } as typeof meta), false, "内层过滤照旧生效");
  await send(session, "回来接着做");
  assert.equal(isArchived(session.id), false, "发消息 = 要接着用");
  assert.ok(getFlags(session.id).unarchivedAt, "取消过的以后不再被自动归档");
  // 在跑的不归档
  session.running = true;
  try {
    assert.deepEqual(setArchived([session.id], true).skipped, [session.id]);
  } finally {
    session.running = false;
  }
});

test("不活跃自动归档：N 天没动过的归档（0 = 关）；取消过归档的、快照对话不归", async (t) => {
  const adapter = scripted(t).next(say("一"), say("二"));
  const a = attachSession(adapter, tmp("dimensio-sm-auto-a-"));
  const b = attachSession(adapter, tmp("dimensio-sm-auto-b-"));
  await send(a, "旧对话");
  await send(b, "被取消过归档的旧对话");
  await persistNow(a);
  await persistNow(b);
  setArchived([b.id], true);
  setArchived([b.id], false);
  const later = Date.now() + 8 * 86_400_000;
  assert.deepEqual(await sweepInactive(later), [], "默认关");
  await setPrefs({ autoArchiveDays: "7" });
  t.after(() => setPrefs({ autoArchiveDays: null }));
  const done = await sweepInactive(later);
  assert.ok(done.includes(a.id), "8 天没动过的归档了");
  assert.ok(!done.includes(b.id), "取消过归档的不再自动归档");
  assert.equal(getFlags(a.id).archivedBy, "inactive");
  assert.deepEqual(await sweepInactive(Date.now()), [], "刚动过的不归");
  // 旁路记录跨进程留得住
  await flushSessMgmtStore();
  reloadSessMgmtStore();
  assert.ok(isArchived(a.id));
});

test("通知：新挂的卡 / 一轮做完时按偏好经 bridge 推送；有界面可见时不推；人停的不推", async (t) => {
  const got: any[] = [];
  const fake = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const j = JSON.parse(b || "{}");
      if (j.event === "notify") got.push({ auth: req.headers.authorization, ...j.payload });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const prev = { api: process.env.BRIDGE_PLUGIN_API, secret: process.env.BRIDGE_PLUGIN_SECRET };
  process.env.BRIDGE_PLUGIN_API = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.BRIDGE_PLUGIN_SECRET = "FAKE-DUMMY-SECRET-0123456789";
  t.after(() => {
    for (const [k, v] of [["BRIDGE_PLUGIN_API", prev.api], ["BRIDGE_PLUGIN_SECRET", prev.secret]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fake.close();
    resetNotify();
  });
  resetNotify();
  await setPrefs({ aiTitles: false, promptSuggestions: false });
  t.after(() => setPrefs({ aiTitles: null, promptSuggestions: null, notifyTaskComplete: null }));

  const adapter = scripted(t).next(say("一"), say("二"), say("三"));
  const s = attachSession(adapter, tmp("dimensio-sm-notify-"));
  await send(s, "做件事");
  await until(() => got.length === 1, "一轮做完推了一条");
  assert.equal(got[0].title, "dimensio · 完成");
  assert.match(got[0].message, /这一轮跑完了/);
  assert.equal(got[0].auth, "Bearer FAKE-DUMMY-SECRET-0123456789");
  // 有界面可见：不推
  notePresence("dev-test-1", true, s.id);
  await send(s, "再做一件");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(got.length, 1, "人就在 App 前，不经 bridge 推");
  // 界面不可见 + 偏好关了「任务完成」：不推
  notePresence("dev-test-1", false, null);
  await setPrefs({ notifyTaskComplete: false });
  await send(s, "第三件");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(got.length, 1, "任务完成这一类关了");
  const st = (await (await fetch(`${base}/api/sessmgmt/state`)).json()) as any;
  assert.equal(st.notify.done, false, "界面与原生服务取得到三项开关");
});
