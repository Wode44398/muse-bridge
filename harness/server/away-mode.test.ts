// P3（#6）：离开模式（AFK）开关——会话级、与权限模式正交、默认关。开着时问答 / 权限 / 计划卡不再让这一轮
// 永久挂起；用户在这个会话发新消息或插话即自动关。
//
// 修前：正常会话里这三类卡没有任何超时，只有停止能让它们落定——人一走开，这一轮就永久挂起，还占着并发名额。
// （ZCode 篇 #6；无探针，按源码取证写。每个用例都和一个定时器赛跑：修前的表现就是「挂住」。）

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import {
  createSession,
  dropSession,
  getOrLoadSession,
  persistNow,
  setSessionAway,
  startRun,
  steerSession,
  stopSession,
  watchSession,
  type Session,
} from "./session.ts";
import { Sandbox } from "./sandbox.ts";
import { askUserQuestionTool } from "./tools/ask.ts";
import { exitPlanModeTool } from "./tools/exitplanmode.ts";
import { rememberTool } from "./tools/remember.ts";
import { listMemories } from "./memory.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { PermissionMode } from "./agent/permissions.ts";
import type { Tool } from "./tools/types.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const caps = { contextWindow: 100_000, maxOutputTokens: 1000, thinking: false, image: false, video: false, cache: false, parallelToolCalls: false };

function attach(session: Session, adapter: ProviderAdapter, tools: Tool[], opts: { ask?: string[]; mode?: PermissionMode } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-p3-"));
  roots.push(root);
  const mode = opts.mode ?? "auto";
  session.state = new AgentState({
    adapter, system: "t", tools: tools.map((t) => t.def), budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: false },
    toolMap: new Map(tools.map((t) => [t.def.name, t])),
    permissionMode: mode,
    permissionRules: { allow: [], deny: [], ask: opts.ask ?? [] },
    memoryAuditRequired: false,
  });
  session.cfg = { provider: "openai", model: "fake", thinking: "off", permissionMode: mode, workspace: root, access: "workspace" };
}

// 第一轮发出 call，之后收尾；seen 记下模型收到的工具结果
function scripted(call: { id: string; name: string; args: Record<string, unknown> }, seen: string[]): ProviderAdapter {
  let n = 0;
  return {
    id: "openai", model: "fake", capabilities: caps,
    async *stream(t) {
      n++;
      const res = t.messages.at(-1)?.content.find((b) => b.t === "tool_result");
      if (res && res.t === "tool_result") seen.push(res.content.map((b) => (b.t === "text" ? b.text : "")).join(""));
      if (n === 1) {
        yield { e: "tool_call", ...call };
        yield { e: "turn_done", stopReason: "tool_use" };
        return;
      }
      yield { e: "text_delta", text: "done" };
      yield { e: "turn_done", stopReason: "end" };
    },
  };
}

// 修前会一直挂着：挂住就停掉这一轮并报「挂住」。判据不看墙钟——全量并发下开跑前的检查点 git 与自动召回能慢到
// 五秒以上，以前固定 5 秒的窗口在负载下误报过——而是看这一轮有没有弹出没人答的卡（card 是那张卡的事件名）；
// 另留 60 秒安全上限。
async function settle(session: Session, done: Promise<void>, card: string): Promise<"done" | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cardShown = () => {};
  const hung = new Promise<"hung">((r) => {
    cardShown = () => r("hung");
    timer = setTimeout(() => r("hung"), 60_000);
  });
  watchSession(session, (ev) => {
    if (ev.e === card) cardShown();
  });
  const out = await Promise.race([done.then(() => "done" as const), hung]);
  clearTimeout(timer);
  if (out === "hung") {
    stopSession(session.id);
    await done;
  }
  return out;
}

const question = { questions: [{ header: "方案", question: "走哪条？", options: [{ label: "A" }, { label: "B" }] }] };

test("默认关；开关校验；开关广播给所有设备并随会话落盘", async () => {
  const session = createSession();
  attach(session, scripted({ id: "x", name: "AskUserQuestion", args: question }, []), [askUserQuestionTool]);
  assert.notEqual(session.cfg?.away, true, "默认关");
  assert.equal(setSessionAway(session, "yes").ok, false);
  const events: Record<string, unknown>[] = [];
  watchSession(session, (ev) => events.push(ev));
  assert.equal(setSessionAway(session, true).ok, true);
  assert.ok(events.some((e) => e.e === "away" && e.away === true), "广播给所有设备");
  session.state!.messages.push({ role: "user", content: [{ t: "text", text: "hi" }] });
  await persistNow(session);
  const id = session.id;
  dropSession(id);
  const again = await getOrLoadSession(id).catch(() => undefined);
  // 假 provider 没有 key 时恢复会失败；落盘记录本身才是这里要看的
  const rec = JSON.parse(fs.readFileSync(path.join(process.env.SESSIONS_DIR!, `${id}.json`), "utf8"));
  assert.equal(rec.config.away, true, "随会话落盘");
  if (again) dropSession(id);
});

test("离开模式下 agent 提问：不弹卡、立即按合理默认继续并要求写明假设", async () => {
  const session = createSession();
  const seen: string[] = [];
  attach(session, scripted({ id: "call_ask", name: "AskUserQuestion", args: question }, seen), [askUserQuestionTool]);
  setSessionAway(session, true);
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "问我一个问题");
  watchSession(session, (ev) => events.push(ev));
  // startRun = 用户发了新消息 → 自动关；这里要测的是「开着时」的行为，所以开跑后再打开一次
  setSessionAway(session, true);
  assert.equal(await settle(session, run.done, "ask"), "done", "修前这一轮挂在没人答的问题上");
  assert.ok(!events.some((e) => e.e === "ask"), "没弹卡");
  assert.match(seen.join("\n"), /away/i);
  assert.match(seen.join("\n"), /assumptions/i);
  dropSession(session.id);
});

test("离开模式下命中 ask 规则：立即拒绝并注明未经批准（不是「用户拒绝」）", async () => {
  const session = createSession();
  let deployed = false;
  const deploy: Tool = {
    effect: "exec", concurrencySafe: false,
    def: { name: "Deploy", description: "deploy", parameters: { type: "object", properties: {} } },
    async run() {
      deployed = true;
      return { ok: true, summary: "deployed", content: [{ t: "text", text: "deployed" }] };
    },
  };
  const seen: string[] = [];
  attach(session, scripted({ id: "call_dep", name: "Deploy", args: {} }, seen), [deploy], { ask: ["Deploy"] });
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "发版");
  watchSession(session, (ev) => events.push(ev));
  setSessionAway(session, true);
  assert.equal(await settle(session, run.done, "permission_ask"), "done", "修前这一轮挂在没人点的权限卡上");
  assert.equal(deployed, false, "安全偏向拒：没人批准就不执行");
  assert.ok(!events.some((e) => e.e === "permission_ask"), "没弹卡");
  const transcript = JSON.stringify(session.state!.messages);
  assert.match(transcript, /not approved: the user is away/);
  assert.doesNotMatch(transcript, /user declined/);
  dropSession(session.id);
});

test("离开模式下提交计划：不弹卡、保持 plan，本轮以计划作答（不自动批准）", async () => {
  const session = createSession();
  const seen: string[] = [];
  attach(session, scripted({ id: "call_plan", name: "ExitPlanMode", args: { plan: "1. 改 A\n2. 跑测试" } }, seen), [exitPlanModeTool], { mode: "plan" });
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "先出计划");
  watchSession(session, (ev) => events.push(ev));
  setSessionAway(session, true);
  assert.equal(await settle(session, run.done, "plan_ask"), "done", "修前这一轮挂在没人批的计划卡上");
  assert.ok(!events.some((e) => e.e === "plan_ask"), "没弹卡");
  assert.equal(session.state!.permissionMode, "plan", "没有自动批准");
  assert.match(seen.join("\n"), /away/i);
  dropSession(session.id);
});

// #71（09-24 定）：无人值守那套先不做，照常默认有人在。以前「在场」按有没有客户端连着判，手机一熄屏
// （SSE 断开）写下的记忆就被记成「没人在场」；现在只有明确开了离开模式才算不在。
test("#71 记忆来源的「在场」默认成立：没有客户端连着也算在场，开着离开模式才算不在", async () => {
  const baseMemory = process.env.MEMORY_DIR;
  try {
    for (const [away, expected] of [[false, true], [true, false]] as const) {
      const memory = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-71-memory-"));
      roots.push(memory);
      process.env.MEMORY_DIR = memory;
      const topic = away ? "misc.away" : "misc.present";
      const session = createSession();
      attach(session, scripted({
        id: "call_rem", name: "Remember",
        args: { title: `note ${topic}`, description: "d.", type: "reference", topic, status: "proposed", confidence: "observed", evidence: ["x"], content: "c" },
      }, []), [rememberTool]);
      const run = startRun(session, "记一下"); // 故意不 watchSession：没有任何客户端连着
      if (away) setSessionAway(session, true); // startRun 会自动关离开模式，开跑后再打开
      await run.done;
      const note = listMemories(session.cfg!.workspace!).find((m) => m.topic === topic);
      assert.ok(note, "记忆写下了");
      assert.equal(note!.attended, expected, away ? "开着离开模式：不在场" : "没有客户端连着：照常算在场");
      dropSession(session.id);
    }
  } finally {
    if (baseMemory === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = baseMemory;
  }
});

test("用户发新消息或插话 = 人回来了：离开模式自动关", async () => {
  const session = createSession();
  let released = false;
  let wake = () => {};
  const release = () => {
    released = true;
    wake();
  };
  let n = 0;
  attach(session, {
    id: "openai", model: "fake", capabilities: caps,
    async *stream() {
      n++;
      if (n === 1 && !released) await new Promise<void>((r) => { wake = r; });
      yield { e: "text_delta", text: "ok" };
      yield { e: "turn_done", stopReason: "end" };
    },
  }, []);
  setSessionAway(session, true);
  const events: Record<string, unknown>[] = [];
  const run = startRun(session, "新消息");
  watchSession(session, (ev) => events.push(ev));
  assert.notEqual(session.cfg?.away, true, "发新消息自动关");
  assert.ok(events.some((e) => e.e === "away" && e.away === false), "关掉也广播（附着的设备重放得到）");

  setSessionAway(session, true);
  assert.equal(steerSession(session, "我回来了").ok, true);
  assert.notEqual(session.cfg?.away, true, "插话也自动关");
  release();
  await run.done;
  dropSession(session.id);
});
