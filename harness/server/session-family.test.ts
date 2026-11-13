// 会话协作（session-family.ts + tools/sessions.ts）：子会话派生、自动汇报唤醒、会话间消息（插话 / 唤醒）、防无限互唤、
// 重启后不丢消息、分叉、删会话，以及与 bridge 里 Claude 会话的互通（bridge 那一层用假的 familyBridge.call 顶替）。
// 走真会话（session-fixture 的 attachSession + 脚本化 provider），开跑 / 唤醒都经生产的 startRun。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, beforeEach, type TestContext } from "node:test";
import { attachSession } from "./test-harness/session-fixture.ts";
import { say, scripted, useTool, type ScriptedAdapter } from "./test-harness/scripted-adapter.ts";
import { answerAsk, deleteSession, getSession, startRun, watchSession, type Session } from "./session.ts";
import { readTool } from "./tools/read.ts";
import { SESSION_TOOLS } from "./tools/sessions.ts";
import { messageKind } from "./agent/injections.ts";
import { reloadPrefs, setPrefs } from "./prefs.ts";
import type { Msg, Turn } from "./agent/turn.ts";
import {
  _inbox,
  _outbox,
  _resetFamily,
  _streak,
  familyBridge,
  familyHooks,
  familyLink,
  familyPromptSection,
  familyView,
  flushFamily,
  inboundDeliver,
  inboundInfo,
  inboundSpawn,
  inboundState,
  sendMessage,
  spawnChild,
  startFamily,
} from "./session-family.ts";

// 台账与偏好落在这个测试文件自己的临时目录（别的测试进程共用同一套数据根，别互相看见）
const ownRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-family-"));
const prevConfig = process.env.DIMENSIO_CONFIG_FILE;
process.env.DIMENSIO_CONFIG_FILE = path.join(ownRoot, "runtime-config.json");
reloadPrefs();
after(() => {
  process.env.DIMENSIO_CONFIG_FILE = prevConfig;
  try { fs.rmSync(ownRoot, { recursive: true, force: true }); } catch { /* 留给 test-global 的清扫 */ }
});

const BG = "Background for the child: the overall goal is to verify the session family plumbing end to end in tests.";
const roots: string[] = [];
const created: Session[] = [];
beforeEach(() => {
  _resetFamily();
  familyHooks.createChild = undefined;
});
afterEach(async () => {
  for (const s of created.splice(0)) {
    s.abort?.abort();
    await s.runPromise?.catch(() => {});
  }
  familyHooks.createChild = undefined;
  await setPrefs({ "collab.maxAutoTurns": null, "collab.inbound": null, "collab.newSessionPolicy": null });
  await flushFamily();
  // 工作区里可能还有知识索引 worker 的句柄（Windows 上删不掉就留给收尾时整根清扫）
  while (roots.length) try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* 见上 */ }
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(ownRoot, "ws-"));
  roots.push(dir);
  return dir;
}
const TOOLS = [readTool, ...SESSION_TOOLS];
function session(adapter: ScriptedAdapter, root: string): Session {
  const s = attachSession(adapter, root, { tools: TOOLS });
  s.state!.ctx.ownerId = s.id; // 生产里 buildState 挂的就是会话 id
  created.push(s);
  return s;
}
// 子会话由夹具建（脚本化 provider），按顺序取
function childFactory(adapters: ScriptedAdapter[], root: string) {
  familyHooks.createChild = () => session(adapters.shift()!, root);
}

async function waitFor(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const idle = (s: Session | undefined) => Boolean(s) && !s!.running;
const allText = (t: Turn) => t.messages.map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join("")).join("\n");
const kinds = (msgs: Msg[]) => msgs.map((m) => messageKind(m)).filter(Boolean);

async function send(s: Session, text: string): Promise<void> {
  const run = startRun(s, text);
  assert.ok(run.started, "这一轮没起来");
  await run.done;
}

test("StartSession 开子会话：首条是父会话派的任务卡；子会话收工自动汇报并唤醒父会话", async (t: TestContext) => {
  const root = workspace();
  const parentA = scripted(t);
  const childA = scripted(t);
  const parent = session(parentA, root);
  childFactory([childA], root);
  parentA.next(
    useTool("c1", "StartSession", { initiation: "user_asked", title: "Child task", prompt: "Check the thing in `a.txt`.", background: BG }),
    say("Handed off to a child session."),
    (turn: Turn) => {
      const text = allText(turn);
      assert.match(text, /<side-sessions-event>/);
      assert.match(text, /CHILD-RESULT: all good/);
      return say("The child reports all good.");
    },
  );
  childA.next((turn: Turn) => {
    const text = allText(turn);
    assert.match(text, /<session-message from="[^"]+" name="" title="[^"]*" relation="parent" kind="brief">/);
    assert.match(text, /【背景】[\s\S]*【任务】\nCheck the thing/);
    return say("CHILD-RESULT: all good");
  });

  await send(parent, "please open a separate session for the child task");
  const res = parent.state!.messages.find((m) => m.content.some((b) => b.t === "tool_result"))!;
  const tr = res.content.find((b) => b.t === "tool_result")!;
  assert.equal(tr.t === "tool_result" && tr.ok, true, "StartSession 应成功");
  const childId = String((tr.t === "tool_result" && (tr.meta?.family as { child?: string })?.child) || "");
  const link = familyLink(childId);
  assert.ok(link, "父子关系登记了");
  assert.equal(link!.parent, parent.id);
  assert.equal(link!.title, "Child task");

  await waitFor(() => parentA.callCount === 3 && idle(parent), "父会话被汇报唤醒并答完");
  const child = getSession(childId)!;
  assert.deepEqual(kinds(child.state!.messages), ["session-brief"]);
  assert.equal(child.title, "Child task");
  assert.ok(kinds(parent.state!.messages).includes("side-sessions-event"));
  // 汇报送完：父会话收件箱空了、连续自动续记了一轮
  assert.equal(_inbox(parent.id).length, 0);
  assert.equal(_streak(parent.id), 1);
  // 子会话的系统提示段
  assert.match(familyPromptSection(childId), /You are a child session[\s\S]*your name is child-task/);
  assert.doesNotMatch(familyPromptSection(parent.id), /You are a child session/);
  const view = familyView();
  assert.equal(view.links[childId]?.parent, parent.id);
});

test("SendMessage：对方空闲就唤醒、在跑就在两步之间注入（不冒充用户）；子会话被父会话叫醒的那轮照样汇报", async (t: TestContext) => {
  const root = workspace();
  const parentA = scripted(t);
  const childA = scripted(t);
  const parent = session(parentA, root);
  childFactory([childA], root);
  // 第一轮：直接开子会话（不经模型，省掉父会话那几步）
  const r = await spawnChild(parent.id, { title: "Helper", prompt: "Say hello.", background: BG });
  assert.ok(r.ok);
  const childId = r.ok ? r.id : "";
  // 子会话第一轮：跑着时父会话发来一条 → 两步之间注入；第二步看得见它
  childA.next(
    async function* () {
      const sent = await sendMessage(parent.id, "helper", "Also check b.txt please.");
      assert.deepEqual(sent, { ok: true, target: childId, how: "inserted" });
      yield* useTool("r1", "Read", { path: "nope.txt" });
    },
    (turn: Turn) => {
      const last = turn.messages.filter((m) => m.role === "user").map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join(""));
      assert.ok(last.some((x) => /<session-message [^>]*relation="parent"[^>]*>\nAlso check b\.txt/.test(x)), "插进来的会话消息");
      assert.ok(!last.some((x) => x.startsWith("[用户在运行中插话]")), "不冒充用户插话");
      return say("HELLO from helper");
    },
  );
  // 父会话被第一轮的汇报唤醒
  parentA.next((turn: Turn) => {
    assert.match(allText(turn), /HELLO from helper/);
    return say("ok");
  });
  await waitFor(() => parentA.callCount === 1 && idle(parent), "父会话被汇报唤醒");
  const child = getSession(childId)!;
  const injected = child.state!.messages.find((m) => messageKind(m) === "session-message");
  assert.ok(injected && injected.origin === "harness", "注入的是 harness 消息");

  // 子会话空闲：父会话发消息 → 唤醒子会话；那轮是父会话派的，收工照样汇报、再唤醒父会话
  childA.next((turn: Turn) => {
    assert.match(allText(turn), /<session-message [^>]*>\nSecond request/);
    assert.match(allText(turn), /<session-hint>/);
    return say("SECOND done");
  });
  parentA.next((turn: Turn) => {
    assert.match(allText(turn), /SECOND done/);
    return say("thanks");
  });
  const woke = await sendMessage(parent.id, childId, "Second request");
  assert.deepEqual(woke, { ok: true, target: childId, how: "woke" });
  await waitFor(() => parentA.callCount === 2 && idle(parent) && idle(child), "子会话答完、父会话被再次唤醒");
  // 找不到的目标如实报错
  const bad = await sendMessage(parent.id, "nobody", "hi");
  assert.equal(bad.ok, false);
});

test("防无限互唤：连续自动续到上限就不再唤醒，攒着的汇报附在用户下一条消息后面", async (t: TestContext) => {
  await setPrefs({ "collab.maxAutoTurns": 1 });
  const root = workspace();
  const parentA = scripted(t);
  const parent = session(parentA, root);
  const childA = scripted(t);
  childFactory([childA], root);
  childA.next(say("first report"));
  parentA.next(say("woken once"));
  const r = await spawnChild(parent.id, { title: "Loop", prompt: "Go.", background: BG });
  assert.ok(r.ok);
  await waitFor(() => parentA.callCount === 1 && idle(parent), "父会话第一次被唤醒");
  assert.equal(_streak(parent.id), 1);
  // 子会话再被父会话叫醒一轮 → 再汇报；父会话已到上限，不唤醒
  childA.next(say("second report"));
  const s = await sendMessage(parent.id, r.ok ? r.id : "", "again");
  assert.equal(s.ok, true);
  await waitFor(() => _inbox(parent.id).length === 1, "第二份汇报进了收件箱");
  await new Promise((res) => setTimeout(res, 2200)); // 过了唤醒延迟也不唤醒
  assert.equal(parentA.callCount, 1);
  // 用户发话：清零，并把攒着的汇报附在这条后面
  parentA.next((turn: Turn) => {
    const texts = turn.messages.map((m) => m.content.map((b) => (b.t === "text" ? b.text : "")).join(""));
    const at = texts.lastIndexOf("what happened?");
    assert.ok(at >= 0 && /<side-sessions-event>[\s\S]*second report/.test(texts[at + 1] ?? ""), "攒着的汇报紧跟在用户这条后面");
    return say("summary");
  });
  await send(parent, "what happened?");
  assert.equal(_streak(parent.id), 0);
  assert.equal(_inbox(parent.id).length, 0);
});

test("重启不丢：收件箱落盘，起服后补唤醒；删会话清掉父子关系", async (t: TestContext) => {
  const root = workspace();
  const parentA = scripted(t);
  const parent = session(parentA, root);
  const childA = scripted(t);
  childFactory([childA], root);
  // 子会话的第一轮在父会话跑着时收工 → 汇报进收件箱；父会话跑完前「服务重启」（内存清空、只剩盘上）
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  parentA.next(async function* () {
    await gate;
    yield* say("busy work done");
  });
  const run = startRun(parent, "do something long");
  assert.ok(run.started);
  childA.next(say("REPORT-AFTER-RESTART"));
  const r = await spawnChild(parent.id, { title: "Persist", prompt: "Go.", background: BG });
  assert.ok(r.ok);
  await waitFor(() => _inbox(parent.id).length === 1, "汇报进了父会话收件箱");
  await flushFamily();
  _resetFamily(); // 模拟重启：内存里的父子表、收件箱都没了，只剩台账文件
  assert.equal(_inbox(parent.id).length, 1, "收件箱从盘上读回来了");
  release();
  await run.done;
  parentA.next((turn: Turn) => {
    assert.match(allText(turn), /REPORT-AFTER-RESTART/);
    return say("got the report");
  });
  startFamily();
  await waitFor(() => parentA.callCount === 2 && idle(parent), "起服后补唤醒");
  // 删父会话：子会话的父子关系一并清掉
  const childId = r.ok ? r.id : "";
  assert.ok(familyLink(childId));
  await deleteSession(parent.id);
  assert.equal(familyLink(childId), null);
});

test("分叉：子会话先接上父会话这段对话的副本（到父会话这一轮的用户消息为止）", async (t: TestContext) => {
  const root = workspace();
  const parentA = scripted(t);
  const parent = session(parentA, root);
  const childA = scripted(t);
  childFactory([childA], root);
  parentA.next(say("earlier answer"));
  await send(parent, "EARLIER-QUESTION");
  childA.next((turn: Turn) => {
    const text = allText(turn);
    assert.match(text, /EARLIER-QUESTION[\s\S]*earlier answer[\s\S]*kind="brief"/);
    assert.doesNotMatch(text, /【背景】/, "fork 不带背景段");
    return say("forked done");
  });
  parentA.next(say("report seen"));
  const r = await spawnChild(parent.id, { title: "Fork it", prompt: "Continue from here.", context: "fork" });
  assert.ok(r.ok);
  await waitFor(() => parentA.callCount === 2 && idle(parent), "分叉的子会话收工、父会话被唤醒");
  assert.equal(familyLink(r.ok ? r.id : "")?.kind, "fork");
});

test("问卡：先问我档的 offer 用户选「在这里做」就不开；不是用户发起的轮不开新会话", async (t: TestContext) => {
  const root = workspace();
  const parentA = scripted(t);
  const parent = session(parentA, root);
  // 问卡走生产那条路（registerAsk → ask 事件 → answerAsk），这里扮演用户点「在这里做」
  const unwatch = watchSession(parent, (ev) => {
    if (ev.e !== "ask") return;
    const qs = ev.questions as { options: { label: string }[] }[];
    assert.equal(qs[0].options.map((o) => o.label).join("/"), "新会话/在这里做");
    setImmediate(() => answerAsk(parent, String(ev.id), [{ selected: ["在这里做"] }]));
  });
  t.after(unwatch);
  parentA.next(
    useTool("c1", "StartSession", { initiation: "offer", title: "Unrelated", prompt: "Do the unrelated thing.", background: BG }),
    (turn: Turn) => {
      assert.match(JSON.stringify(turn.messages), /Do it here/); // 工具结果嵌在 tool_result 里
      return say("doing it here");
    },
  );
  await send(parent, "also, unrelated: fix the other thing");
  assert.equal(Object.values(familyView().links).filter((l) => l.parent === parent.id).length, 0, "没开会话");
});

test("跨 agent：dimensio 开 Claude 子会话、收 Claude 的汇报；Claude 开 dimensio 子会话、它收工汇报回 bridge；入站设置", async (t: TestContext) => {
  const prevApi = process.env.BRIDGE_PLUGIN_API;
  const prevSecret = process.env.BRIDGE_PLUGIN_SECRET;
  process.env.BRIDGE_PLUGIN_API = "http://127.0.0.1:9";
  process.env.BRIDGE_PLUGIN_SECRET = "FAKE-bridge-secret-for-tests";
  const realCall = familyBridge.call;
  const calls: { op: string; body: Record<string, unknown> }[] = [];
  familyBridge.call = async (op, body) => {
    calls.push({ op, body });
    if (op === "spawn") return { ok: true, id: "c1aude00-0000-4000-8000-000000000001", name: "claude-side", title: String(body.title) };
    if (op === "info") return { ok: true, sessions: { "c1aude00-0000-4000-8000-000000000001": { title: "Claude side", state: "idle", report: "claude report text" } } };
    return { ok: true, how: "woke" };
  };
  t.after(() => {
    familyBridge.call = realCall;
    process.env.BRIDGE_PLUGIN_API = prevApi;
    process.env.BRIDGE_PLUGIN_SECRET = prevSecret;
  });
  const root = workspace();
  const parentA = scripted(t);
  const parent = session(parentA, root);
  // ① dimensio → Claude：StartSession agent:"claude"
  parentA.next(
    useTool("c1", "StartSession", { initiation: "user_asked", agent: "claude", title: "Ask Claude", prompt: "Review it.", background: BG }),
    say("handed to Claude"),
  );
  await send(parent, "let Claude review it in its own session");
  const claudeId = "c1aude00-0000-4000-8000-000000000001";
  assert.equal(calls[0]?.op, "spawn");
  assert.equal(calls[0]?.body.parent, parent.id);
  assert.equal(familyLink(claudeId)?.agent, "claude");
  // Claude 子会话收工 → bridge 投来汇报 → 父会话被唤醒，信封标着 agent="claude"
  parentA.next((turn: Turn) => {
    assert.match(allText(turn), /<note from="c1aude00[^"]*"[^>]*agent="claude">\nclaude says done/);
    return say("Claude is done");
  });
  assert.equal(inboundState({ sid: claudeId, working: true }), true);
  const note = await inboundDeliver({ from: claudeId, to: parent.id, kind: "note", text: "claude says done", status: "done" });
  assert.equal(note.ok, true);
  await waitFor(() => parentA.callCount === 3 && idle(parent), "父会话收到 Claude 子会话的汇报");
  // dimensio 发给 Claude 会话：经 bridge
  const sent = await sendMessage(parent.id, "claude-side", "one more thing");
  assert.deepEqual(sent, { ok: true, target: claudeId, how: "woke" });
  assert.equal(calls.at(-1)?.op, "send");
  // 无关的会话不让投
  const stranger = await inboundDeliver({ from: "c1aude00-0000-4000-8000-0000000000ff", to: parent.id, kind: "message", text: "hi" });
  assert.equal(stranger.ok, false);

  // ② Claude → dimensio：bridge 来开一个 dimensio 子会话；它收工 → 汇报经外发箱回 bridge
  const childA = scripted(t);
  childFactory([childA], root);
  childA.next((turn: Turn) => {
    assert.match(allText(turn), /relation="parent" agent="claude" kind="brief"/);
    return say("DIM-RESULT ready");
  });
  const claudeParent = "c1aude00-0000-4000-8000-0000000000aa";
  const sp = await inboundSpawn({ parent: claudeParent, parentTitle: "Claude parent", title: "Dim task", prompt: "Do it.", background: BG });
  assert.ok(sp.ok);
  const dimChild = sp.ok ? sp.id : "";
  assert.equal(familyLink(dimChild)?.parentAgent, "claude");
  await waitFor(() => calls.some((c) => c.op === "send" && c.body.kind === "note" && c.body.to === claudeParent), "汇报发回 bridge");
  const back = calls.find((c) => c.op === "send" && c.body.kind === "note")!;
  assert.match(String(back.body.text), /DIM-RESULT ready/);
  assert.ok(calls.some((c) => c.op === "state" && c.body.sid === dimChild), "开工 / 收工状态告诉了 bridge");
  assert.equal(_outbox().length, 0);
  // bridge 来问这个 dimensio 会话的情况
  const info = await inboundInfo([dimChild, parent.id]);
  assert.match(info[dimChild]?.report ?? "", /DIM-RESULT/);
  assert.equal(info[parent.id]?.title !== undefined, true, "有 Claude 子会话的 dimensio 父会话也答");

  // ③ 入站设置：先存着 → 不唤醒；拒收 → 不收
  await setPrefs({ "collab.inbound": "hold" });
  const held = await inboundDeliver({ from: claudeParent, to: dimChild, kind: "message", text: "held msg" });
  assert.deepEqual(held, { ok: true, target: dimChild, how: "held" });
  await setPrefs({ "collab.inbound": "refuse" });
  const refused = await inboundDeliver({ from: claudeParent, to: dimChild, kind: "message", text: "nope" });
  assert.equal(refused.ok, false);
  const spawnRefused = await inboundSpawn({ parent: claudeParent, title: "x", prompt: "y" });
  assert.equal(spawnRefused.ok, false);
});
