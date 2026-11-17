// 会话运行的特征基准：拆分 session.ts 前后，对外的事件序列、发给模型的请求与落盘记录逐字不变。
// 走生产路径：startRun 同步建好会话状态（buildState：工具表、system、World State），在第一个 await 之前把适配器换成
// 脚本化 provider；子 agent 与新开的会话自己建适配器，那几步在 fetch 这一层假扮 provider。
//
// 不进 npm test（快照不做主断言）。拆分时这样跑（在 harness/ 下）：
//   node --import ./server/test-setup.ts --test-timeout=120000 --test server/characterization/*.test.ts
// 有意改行为时在未改动的代码上加 UPDATE_CHAR_BASELINE=1 重新生成基准。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import { setConfig } from "../config.ts";
import { newGoal } from "../goal.ts";
import { writeRunMarker } from "../run-markers.ts";
import {
  answerAsk,
  compactSession,
  createSession,
  deleteSession,
  dropSession,
  getOrLoadSession,
  getSession,
  goalAction,
  handoffPlan,
  handoffWithSummary,
  interruptWithSteer,
  resolvePermission,
  resolvePlan,
  resumeInterruptedRuns,
  rewindSession,
  rollbackSession,
  setSessionAccess,
  setSessionAway,
  setSessionMode,
  setSessionModel,
  startRun,
  steerSession,
  stopSession,
  undoRewind,
  watchGlobal,
  watchSession,
  withdrawSteer,
  type Session,
} from "../session.ts";
import { loadSession } from "../store.ts";
import type { StreamEvent } from "../agent/events.ts";
import type { Turn } from "../agent/turn.ts";
import { call, calls, fakeSummary, say, scripted, useTool, type ScriptedAdapter, type Step } from "../test-harness/scripted-adapter.ts";
import { fakeProviderFetch } from "../test-harness/wire-fakes.ts";
import { baselineStore, Normalizer, sha } from "./normalize.ts";

const BASE_URL = "https://openai.invalid/v1";
const store = baselineStore(path.join(import.meta.dirname, "session-flows.baseline.json"), {
  update: process.env.UPDATE_CHAR_BASELINE === "1",
  actualDir: process.env.CHAR_ACTUAL_DIR,
});
const roots: string[] = [];
// resumeInterruptedRuns 扫整个 running/ 目录：这个文件用自己的会话目录（收尾还原，不要 delete）
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-char-sessions-"));
roots.push(process.env.SESSIONS_DIR);
// 自动召回只走关键词（语义检索与本机模型 / 网络有关，不稳定）
const BASE_SEMANTIC = process.env.KNOWLEDGE_AUTO_SEMANTIC;
process.env.KNOWLEDGE_AUTO_SEMANTIC = "0";
after(() => {
  store.flush();
  process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  if (BASE_SEMANTIC === undefined) delete process.env.KNOWLEDGE_AUTO_SEMANTIC;
  else process.env.KNOWLEDGE_AUTO_SEMANTIC = BASE_SEMANTIC;
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

// 每个场景一个工作区：一个文本文件、一个子目录、一张最小的 PNG
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-char-ws-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "note.md"), "# note\n");
  fs.writeFileSync(path.join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
  return root;
}

function configure(root: string, over: Record<string, unknown> = {}): void {
  setConfig({
    provider: "openai",
    model: "deepseek-flash",
    thinking: "low",
    apiKey: "DUMMY-char-key",
    baseUrl: BASE_URL,
    workspace: root,
    permissionMode: "auto",
    access: "workspace",
    permissionRules: { allow: [], deny: [], ask: [] },
    ...over,
  } as Parameters<typeof setConfig>[0]);
}

async function waitFor(what: string, pred: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) assert.fail(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// 卡在半路的一步：放行之前测试可以插话、停它、附着
function gated(then: StreamEvent[]): { step: () => AsyncIterable<StreamEvent>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    release: () => release(),
    step: async function* () {
      await gate;
      yield* then;
    },
  };
}

// 一个场景的记录：会话事件、全局事件、模型请求、落盘记录，以及各接口的返回值
class Trace {
  readonly norm = new Normalizer();
  readonly global: Record<string, unknown>[] = [];
  private readonly offGlobal: () => void;
  private readonly systems = new Map<string, string>();
  private readonly toolSets = new Map<string, unknown>();
  readonly steps: Record<string, unknown>[] = [];
  readonly t: TestContext;

  constructor(t: TestContext) {
    this.t = t;
    t.mock.method(console, "log", () => {});
    this.offGlobal = watchGlobal((ev) => this.global.push(structuredClone(ev)));
  }

  requests(inputs: readonly Turn[]): unknown[] {
    return inputs.map((turn) => {
      const system = this.norm.str(typeof turn.system === "string" ? turn.system : JSON.stringify(turn.system ?? ""));
      const sysKey = sha(system);
      this.systems.set(sysKey, system);
      const tools = this.norm.value(turn.tools ?? []);
      const toolKey = sha(JSON.stringify(tools));
      this.toolSets.set(toolKey, (turn.tools ?? []).map((d) => d.name));
      const { system: _s, tools: _t, messages, ...rest } = turn;
      return { system: sysKey, tools: toolKey, messages: this.norm.value(messages), rest: this.norm.value(rest) };
    });
  }

  wire(bodies: readonly any[]): unknown[] {
    return bodies.map((body) => {
      const { tools, messages, ...rest } = body ?? {};
      const names = (tools ?? []).map((x: any) => x?.function?.name ?? x?.name);
      const toolKey = sha(JSON.stringify(this.norm.value(tools ?? [])));
      this.toolSets.set(toolKey, names);
      const msgs = (messages ?? []).map((m: any) => {
        if (m.role !== "system") return this.norm.value(m);
        const text = this.norm.str(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
        const key = sha(text);
        this.systems.set(key, text);
        return { role: "system", content: key };
      });
      return { tools: toolKey, messages: msgs, rest: this.norm.value(rest) };
    });
  }

  record(rec: unknown): unknown {
    if (!rec || typeof rec !== "object") return rec ?? null;
    const r = rec as Record<string, unknown>;
    const system = this.norm.str(String(r.system ?? ""));
    const key = sha(system);
    this.systems.set(key, system);
    const { system: _s, world, prefixBaseline, ...rest } = r;
    return {
      ...(this.norm.value(rest) as object),
      system: key,
      world: world && typeof world === "object" ? Object.keys(world).sort() : world ?? null,
      prefixBaseline: prefixBaseline ? "<present>" : null,
    };
  }

  async disk(id: string): Promise<unknown> {
    return this.record(await loadSession(id));
  }

  note(label: string, value: unknown): void {
    this.steps.push({ label, value: this.norm.value(value) });
  }

  finish(name: string): void {
    this.offGlobal();
    store.check(name, {
      steps: this.steps,
      global: this.norm.value(this.global),
      systems: Object.fromEntries([...this.systems.entries()].sort()),
      toolSets: Object.fromEntries([...this.toolSets.entries()].sort()),
    });
  }
}

interface TurnOpts {
  attachments?: string[];
  start?: Parameters<typeof startRun>[5];
  // live()：附着之后本轮新到的事件（空闲时附着会先重放上一轮留下的日志尾巴，那部分不算）
  during?: (adapter: ScriptedAdapter, live: () => Record<string, unknown>[]) => Promise<void>;
  adapter?: ScriptedAdapter;
}

// 发一条、跑到收尾：返回这一轮看得到的事件与模型请求
async function turn(tr: Trace, session: Session, label: string, message: string, steps: Step[], opts: TurnOpts = {}): Promise<ScriptedAdapter> {
  const events: Record<string, unknown>[] = [];
  const off = watchSession(session, (ev) => events.push(structuredClone(ev)));
  const replayed = events.length;
  const live = () => events.slice(replayed);
  const adapter = opts.adapter ?? scripted(tr.t, { model: "deepseek-flash" });
  adapter.next(...steps);
  const before = adapter.inputs.length;
  const handle = startRun(session, message, undefined, opts.attachments ?? [], undefined, opts.start ?? {});
  if (handle.started) session.state!.adapter = adapter;
  if (opts.during) await opts.during(adapter, live);
  await handle.done;
  off();
  tr.note(label, {
    started: handle.started,
    ...(handle.retiring ? { retiring: true } : {}),
    ...(handle.rollingBack ? { rollingBack: true } : {}),
    events,
  });
  tr.steps.push({ label: `${label}:requests`, value: tr.requests(adapter.inputs.slice(before)) });
  return adapter;
}

async function calledAtLeast(adapter: ScriptedAdapter, n: number): Promise<void> {
  await waitFor(`模型被调到第 ${n} 次`, () => adapter.callCount >= n);
}

const readA = useTool("r1", "Read", { path: "a.txt" });

test("CH01 新会话：寒暄一句（建会话、system、工具表、落盘、全局状态）", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  await turn(tr, s, "run", "你好", [say("你好！有什么要做的？")]);
  tr.note("cfg", s.cfg);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH01-basic");
  dropSession(s.id);
});

test("CH02 工具调用：Read 一个文件再回答；接着第二轮", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  await turn(tr, s, "run1", "看看 a.txt 里写了什么", [readA, say("a.txt 里是 alpha。")]);
  await turn(tr, s, "run2", "再说一遍", [say("还是 alpha。")]);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH02-tool-call");
  dropSession(s.id);
});

test("CH03 附件：文本、文件夹、图片（当前型号不看图）一起挂上", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  await turn(tr, s, "run", "看看这些附件", [say("看到了。")], { attachments: ["a.txt", "sub", "pic.png"] });
  await turn(tr, s, "run-empty", "", [say("只有附件。")], { attachments: ["a.txt"] });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH03-attachments");
  dropSession(s.id);
});

test("CH04 权限卡：规则判定 ask 的 Write，允许一次；再一次拒绝并附言", async (t) => {
  const tr = new Trace(t);
  const root = workspace();
  configure(root, { permissionRules: { allow: [], deny: [], ask: ["Write"] } });
  const s = createSession();
  const answer = (decision: string, note?: string) => async (_a: ScriptedAdapter, live: () => Record<string, unknown>[]) => {
    await waitFor("权限卡", () => live().some((e) => e.e === "permission_ask"));
    const card = live().find((e) => e.e === "permission_ask")!;
    tr.note(`resolve-${decision}`, resolvePermission(s, String(card.id), decision, note));
  };
  await turn(tr, s, "allow", "写一个 b.txt", [useTool("w1", "Write", { path: "b.txt", content: "beta\n" }), say("写好了。")], { during: answer("once") });
  await turn(tr, s, "deny", "再写一个 c.txt", [useTool("w2", "Write", { path: "c.txt", content: "gamma\n" }), say("没写成。")], { during: answer("deny", "先别写") });
  tr.note("files", { b: fs.existsSync(path.join(root, "b.txt")), c: fs.existsSync(path.join(root, "c.txt")) });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH04-permission");
  dropSession(s.id);
});

test("CH05 问答卡：AskUserQuestion 等人答", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  const question = { questions: [{ header: "库", question: "用哪个库？", options: [{ label: "sqlite" }, { label: "postgres" }] }] };
  await turn(tr, s, "run", "帮我选个数据库", [calls(call("q1", "AskUserQuestion", question)), say("那就用 sqlite。")], {
    during: async (_a, live) => {
      await waitFor("问答卡", () => live().some((e) => e.e === "ask"));
      tr.note("answer", answerAsk(s, "q1", [{ selected: ["sqlite"] }]));
      tr.note("answer-again", answerAsk(s, "q1", [{ selected: ["postgres"] }]));
    },
  });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH05-ask");
  dropSession(s.id);
});

test("CH06 计划模式：ExitPlanMode 批准后同一轮切自主接着做", async (t) => {
  const tr = new Trace(t);
  configure(workspace(), { permissionMode: "plan" });
  const s = createSession();
  await turn(tr, s, "run", "规划一下怎么改 a.txt", [calls(call("p1", "ExitPlanMode", { plan: "1. 把 a.txt 改成 beta" })), say("开始实施。")], {
    during: async (_a, live) => {
      await waitFor("计划卡", () => live().some((e) => e.e === "plan_ask"));
      const card = live().find((e) => e.e === "plan_ask")!;
      tr.note("approve", resolvePlan(s, String(card.id), true, "可以"));
    },
  });
  tr.note("mode", s.cfg?.permissionMode);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH06-plan");
  dropSession(s.id);
});

test("CH07 插话：工具回合之间送达；没有后续回合的插话在收尾时退回", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  const g1 = gated(useTool("r1", "Read", { path: "a.txt" }));
  await turn(tr, s, "delivered", "读一下 a.txt", [g1.step, say("读完了，也看了 sub。")], {
    during: async (adapter) => {
      await calledAtLeast(adapter, 1);
      tr.note("steer", steerSession(s, "顺便看看 sub 目录", undefined, "steer-char-0001"));
      g1.release();
    },
  });
  const g2 = gated(say("说完了。"));
  await turn(tr, s, "after-text", "说一句话", [g2.step, say("补上了。")], {
    during: async (adapter) => {
      await calledAtLeast(adapter, 1);
      tr.note("steer", steerSession(s, "再补一句", undefined, "steer-char-0002"));
      tr.note("steer-not-running", steerSession(createSession(), "x"));
      g2.release();
    },
  });
  const g4 = gated(say("被停了。"));
  await turn(tr, s, "returned", "再说一句话", [g4.step], {
    during: async (adapter) => {
      await calledAtLeast(adapter, 1);
      tr.note("steer", steerSession(s, "这句送不到", undefined, "steer-char-0005"));
      tr.note("stop", stopSession(s.id));
      g4.release();
    },
  });
  const g3 = gated(say("这句没人要了。"));
  await turn(tr, s, "withdrawn", "再说一句", [g3.step], {
    during: async (adapter) => {
      await calledAtLeast(adapter, 1);
      tr.note("steer", steerSession(s, "算了", undefined, "steer-char-0003"));
      tr.note("withdraw", withdrawSteer(s, "steer-char-0003"));
      tr.note("withdraw-again", withdrawSteer(s, "steer-char-0003"));
      g3.release();
    },
  });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH07-steer");
  dropSession(s.id);
});

test("CH08 中断：停止这一轮；带错的 runId 不动别人的那一轮", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  const g = gated(say("写到一半"));
  await turn(tr, s, "stopped", "写一篇长文", [g.step], {
    during: async (adapter) => {
      await calledAtLeast(adapter, 1);
      tr.note("stop-mismatch", stopSession(s.id, "not-this-run"));
      tr.note("stop", stopSession(s.id));
      g.release();
    },
  });
  tr.note("stop-idle", stopSession(s.id));
  tr.note("running", s.running);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH08-stop");
  dropSession(s.id);
});

test("CH09 立即中断并发送：撤回插话、停这一轮、以那句话开新一轮", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  const g = gated(say("旧方向"));
  const adapter = scripted(t, { model: "deepseek-flash" });
  await turn(tr, s, "run1", "按旧方向做", [g.step, say("改方向了。")], {
    adapter,
    during: async (a) => {
      await calledAtLeast(a, 1);
      tr.note("steer", steerSession(s, "换个方向", undefined, "steer-char-0004"));
      const p = interruptWithSteer(s, "steer-char-0004");
      g.release();
      tr.note("interrupt", await p);
    },
  });
  const events: Record<string, unknown>[] = [];
  const off = watchSession(s, (ev) => events.push(structuredClone(ev)));
  await s.runPromise;
  off();
  tr.note("run2", events);
  tr.steps.push({ label: "run2:requests", value: tr.requests(adapter.inputs.slice(1)) });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH09-interrupt-steer");
  dropSession(s.id);
});

test("CH10 镜像附着：跑到一半第二台设备附着，先收到重放再收到直播", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  const g = gated(say("读完了。"));
  const mirror: Record<string, unknown>[] = [];
  await turn(tr, s, "run", "读一下 a.txt", [readA, g.step], {
    during: async (adapter) => {
      await calledAtLeast(adapter, 2);
      watchSession(s, (ev) => mirror.push(structuredClone(ev)));
      g.release();
    },
  });
  tr.note("mirror", mirror.map((e) => (e.e === "run_clock" ? { e: "run_clock" } : e)));
  tr.finish("CH10-mirror");
  dropSession(s.id);
});

test("CH11 恢复：从内存逐出后从盘上读回，接着聊（system 原样沿用）", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  await turn(tr, s, "run1", "看看 a.txt", [readA, say("alpha。")]);
  const id = s.id;
  dropSession(id);
  const back = await getOrLoadSession(id);
  assert.ok(back);
  tr.note("hydrated", { same: back === s, running: back.running, title: back.title, cfg: back.cfg, messages: back.state!.messages.length });
  await turn(tr, back, "run2", "现在呢", [say("还是 alpha。")]);
  tr.steps.push({ label: "disk", value: await tr.disk(id) });
  tr.finish("CH11-resume-from-disk");
  dropSession(id);
});

test("CH12 自动续跑：盘上留着开跑 marker（进程死掉），起来续一轮", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  await turn(tr, s, "run1", "写报告", [say("开始写。")]);
  writeRunMarker(s.id, { runId: "r-char-crash", startedAt: Date.now(), resumes: 0 });
  const adapter = scripted(t, { model: "deepseek-flash" }).next(say("接着写完了。"));
  s.state!.adapter = adapter;
  const events: Record<string, unknown>[] = [];
  const r = await resumeInterruptedRuns();
  const off = watchSession(s, (ev) => events.push(structuredClone(ev)));
  await s.runPromise;
  off();
  tr.note("resume", { resumed: r.resumed.length, gaveUp: r.gaveUp.length, events });
  tr.steps.push({ label: "resume:requests", value: tr.requests(adapter.inputs) });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH12-auto-resume");
  dropSession(s.id);
});

test("CH13 会话级开关：档位、访问范围、离开模式、型号（空闲当场重建）", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  tr.note("mode-before-start", setSessionMode(s, "plan"));
  await turn(tr, s, "run1", "你好", [say("你好。")]);
  const events: Record<string, unknown>[] = [];
  const off = watchSession(s, (ev) => events.push(structuredClone(ev)));
  tr.note("mode-plan", setSessionMode(s, "plan"));
  tr.note("mode-bad", setSessionMode(s, "nope"));
  tr.note("mode-auto", setSessionMode(s, "auto"));
  tr.note("access-full", setSessionAccess(s, "full"));
  tr.note("access-same", setSessionAccess(s, "full"));
  tr.note("access-workspace", setSessionAccess(s, "workspace"));
  tr.note("access-bad", setSessionAccess(s, "everything"));
  tr.note("away-on", setSessionAway(s, true));
  tr.note("away-bad", setSessionAway(s, "yes"));
  tr.note("model", setSessionModel(s, { model: "deepseek-v4-pro" }));
  tr.note("model-bad", setSessionModel(s, { thinking: "ultra" }));
  off();
  tr.note("idle-events", events);
  tr.note("cfg", s.cfg);
  await turn(tr, s, "run2", "现在你是谁", [say("我是新型号。")]);
  tr.note("cfg-after", s.cfg);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH13-session-switches");
  dropSession(s.id);
});

test("CH14 运行中换型号：这一轮不受影响，下一轮开跑前重建", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  const g = gated(say("旧型号答的。"));
  await turn(tr, s, "run1", "第一句", [g.step], {
    during: async (adapter) => {
      await calledAtLeast(adapter, 1);
      tr.note("switch", setSessionModel(s, { model: "deepseek-v4-pro" }));
      g.release();
    },
  });
  await turn(tr, s, "run2", "第二句", [say("新型号答的。")]);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH14-model-switch-running");
  dropSession(s.id);
});

test("CH15 离开模式：问答立即按默认落定、权限卡直接拒；外部事件那一轮照样关掉离开模式", async (t) => {
  const tr = new Trace(t);
  configure(workspace(), { permissionRules: { allow: [], deny: [], ask: ["Write"] } });
  const s = createSession();
  await turn(tr, s, "run1", "你好", [say("你好。")]);
  tr.note("away-on", setSessionAway(s, true));
  const question = { questions: [{ header: "库", question: "用哪个库？", options: [{ label: "sqlite" }, { label: "postgres" }] }] };
  // 定时任务那一轮不算人回来：离开模式开着，问答按默认落定、权限卡直接拒
  await turn(tr, s, "routine", "每天检查一下", [calls(call("q1", "AskUserQuestion", question)), useTool("w1", "Write", { path: "b.txt", content: "x\n" }), say("按默认做了。")], {
    start: { routine: { text: "[Routine] scheduled run, nobody is watching." }, family: { kind: "auto" } },
  });
  tr.note("away-after-routine", s.cfg?.away ?? null);
  await turn(tr, s, "event", "", [say("看到 CI 失败了。")], {
    start: { event: { text: "<ci-monitor-event>CI failed</ci-monitor-event>", kind: "ci-event", label: "CI 失败" } },
  });
  tr.note("away-after-event", s.cfg?.away ?? null);
  tr.note("away-on-2", setSessionAway(s, true));
  await turn(tr, s, "head", "", [say("收到消息。")], { start: { head: { text: "[Session message] hi", kind: "session-message", title: "会话消息" } } });
  tr.note("away-after-head", s.cfg?.away ?? null);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH15-away-and-heads");
  dropSession(s.id);
});

test("CH16 目标续跑：两轮做完，第二轮 UpdateGoal 声明达成", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  s.goal = newGoal("把 a.txt 读一遍并确认", { maxRounds: 3 });
  const adapter = scripted(t, { model: "deepseek-flash" });
  await turn(tr, s, "round1", "把 a.txt 读一遍并确认", [readA, say("第一轮读完了。"), useTool("g1", "UpdateGoal", { status: "done", summary: "读完了" }), say("目标达成。")], { adapter });
  await waitFor("目标收尾", () => !s.running && s.goal?.status !== "active");
  tr.steps.push({ label: "all:requests", value: tr.requests(adapter.inputs) });
  tr.note("goal", s.goal);
  tr.note("goal-clear", await goalAction(s.id, "clear"));
  tr.note("goal-none", await goalAction(s.id, "pause"));
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH16-goal");
  dropSession(s.id);
});

test("CH17 立即压缩与带摘要开新会话", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  const adapter = scripted(t, { model: "deepseek-flash" });
  await turn(tr, s, "run1", "看看 a.txt", [readA, say("alpha。")], { adapter });
  await turn(tr, s, "run2", "再看看 sub/note.md", [useTool("r2", "Read", { path: "sub/note.md" }), say("是个标题。")], { adapter });
  await turn(tr, s, "run3", "总结一下", [say("读了两个文件。")], { adapter });
  adapter.next(say(fakeSummary("读了 a.txt（alpha）与 sub/note.md（标题）。")));
  const before = adapter.inputs.length;
  tr.note("compact", await compactSession(s.id));
  tr.steps.push({ label: "compact:requests", value: tr.requests(adapter.inputs.slice(before)) });
  adapter.next(say(fakeSummary("接续摘要：读过两个文件。")));
  const before2 = adapter.inputs.length;
  const h = await handoffWithSummary(s.id);
  tr.note("handoff", h);
  tr.steps.push({ label: "handoff:requests", value: tr.requests(adapter.inputs.slice(before2)) });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  if (h.sessionId) {
    tr.steps.push({ label: "disk-next", value: await tr.disk(h.sessionId) });
    dropSession(h.sessionId);
  }
  tr.finish("CH17-compact-handoff");
  dropSession(s.id);
});

test("CH18 计划卡「在新会话中实施」：原会话落定为转交，新会话以自主档起跑（真适配器、假 fetch）", async (t) => {
  const tr = new Trace(t);
  configure(workspace(), { permissionMode: "plan" });
  const fake = fakeProviderFetch(t, { baseUrl: BASE_URL, shape: "openai", steps: [say("按计划开始。")] });
  const s = createSession();
  let next: string | undefined;
  await turn(tr, s, "run", "规划一下", [calls(call("p1", "ExitPlanMode", { plan: "# 改 a.txt\n1. 改成 beta" })), say("已转到新会话。")], {
    during: async (_a, live) => {
      await waitFor("计划卡", () => live().some((e) => e.e === "plan_ask"));
      const card = live().find((e) => e.e === "plan_ask")!;
      const r = handoffPlan(s.id, String(card.id));
      next = r.sessionId;
      tr.note("handoff", r);
      tr.note("handoff-again", handoffPlan(s.id, String(card.id)));
    },
  });
  assert.ok(next);
  const n = await getOrLoadSession(next);
  await n?.runPromise;
  tr.steps.push({ label: "wire", value: tr.wire(fake.bodies) });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.steps.push({ label: "disk-next", value: await tr.disk(next) });
  tr.finish("CH18-handoff-plan");
  dropSession(s.id);
  dropSession(next);
});

test("CH19 从这里改写与撤销改写", async (t) => {
  const tr = new Trace(t);
  const root = workspace();
  configure(root);
  const s = createSession();
  await turn(tr, s, "run1", "第一句", [say("一。")]);
  await turn(tr, s, "run2", "第二句", [useTool("w1", "Write", { path: "b.txt", content: "beta\n" }), say("二。")]);
  const id = s.id;
  const r = await rewindSession(id, { ordinal: 1, text: "第二句" });
  tr.note("rewind", r);
  tr.note("rewind-missing", await rewindSession(id, { ordinal: 5, text: "没有这句" }));
  tr.steps.push({ label: "disk-rewound", value: await tr.disk(id) });
  tr.note("file-after-rewind", fs.existsSync(path.join(root, "b.txt")));
  if (r.undo) tr.note("undo", await undoRewind(id, r.undo.n, r.undo.length));
  tr.steps.push({ label: "disk-undone", value: await tr.disk(id) });
  tr.finish("CH19-rewind");
  dropSession(id);
});

test("CH20 检查点回滚：文件与对话一起回到第 1 张之前", async (t) => {
  const tr = new Trace(t);
  const root = workspace();
  configure(root);
  const s = createSession();
  await turn(tr, s, "run1", "把 a.txt 改成 beta", [useTool("w1", "Write", { path: "a.txt", content: "beta\n" }), say("改好了。")]);
  await turn(tr, s, "run2", "再加一个 c.txt", [useTool("w2", "Write", { path: "c.txt", content: "gamma\n" }), say("加好了。")]);
  const id = s.id;
  tr.note("rollback-bad", await rollbackSession(id, 99));
  tr.note("rollback", await rollbackSession(id, 2));
  tr.note("files", { a: fs.readFileSync(path.join(root, "a.txt"), "utf8"), c: fs.existsSync(path.join(root, "c.txt")) });
  tr.note("in-memory", Boolean(getSession(id)));
  tr.steps.push({ label: "disk", value: await tr.disk(id) });
  tr.finish("CH20-rollback");
  dropSession(id);
});

test("CH21 子 agent：Agent 工具按本会话的厂商 / 型号起子 agent（真适配器、假 fetch）", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const fake = fakeProviderFetch(t, { baseUrl: BASE_URL, shape: "openai", steps: [say("a.txt 里写的是 alpha。")] });
  const s = createSession();
  await turn(tr, s, "run", "让子 agent 读一下 a.txt", [useTool("ag1", "Agent", { prompt: "读 a.txt 并报告内容", description: "读文件" }), say("子 agent 说是 alpha。")]);
  tr.steps.push({ label: "child-wire", value: tr.wire(fake.bodies) });
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH21-subagent");
  dropSession(s.id);
});

test("CH22 Bash 前台命令与 TodoWrite", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  await turn(tr, s, "run", "跑个命令并记个待办", [
    useTool("t1", "TodoWrite", { todos: [{ content: "跑命令", status: "in_progress" }] }),
    useTool("b1", "Bash", { command: "echo char-bash-out" }),
    say("跑完了。"),
  ]);
  tr.note("todos", s.state!.todos);
  tr.steps.push({ label: "disk", value: await tr.disk(s.id) });
  tr.finish("CH22-bash-todo");
  dropSession(s.id);
});

test("CH23 删除会话：记录、内存一并清掉；运行中不能重复起跑", async (t) => {
  const tr = new Trace(t);
  configure(workspace());
  const s = createSession();
  const g = gated(say("完。"));
  await turn(tr, s, "run", "开始", [g.step], {
    during: async (adapter) => {
      await calledAtLeast(adapter, 1);
      const again = startRun(s, "又一条");
      tr.note("start-while-running", { started: again.started });
      g.release();
    },
  });
  const r = await deleteSession(s.id);
  tr.note("delete", r);
  tr.note("disk-after", (await loadSession(s.id)) ?? null);
  tr.finish("CH23-delete");
});
