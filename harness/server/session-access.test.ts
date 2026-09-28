// 访问范围（仅工作空间 / 整机）从设置页搬到输入框旁之后的契约：切范围要对【当前这条
// 会话】立刻生效——沙箱当场改判、下一次请求前追加「范围已变」片段（C4 起不改写 system）、快照配置与附着设备同步。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { AgentState } from "./agent/state.ts";
import { systemPrompt } from "./agent/prompt.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { Sandbox, SandboxError } from "./sandbox.ts";
import { createSession, dropSession, setSessionAccess, watchSession, type Session } from "./session.ts";
import { lastText, wireWorld } from "./test-harness/session-fixture.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) {
    try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});

const TOOLS = [writeTool, readTool];
const idleAdapter: ProviderAdapter = {
  id: "openai",
  model: "fake",
  capabilities: {
    contextWindow: 100_000,
    maxOutputTokens: 1000,
    thinking: false,
    image: false,
    video: false,
    cache: false,
    parallelToolCalls: false,
  },
  async *stream() {
    yield { e: "turn_done" as const, stopReason: "end" as const };
  },
};

function attach(session: Session, root: string): AgentState {
  let state!: AgentState;
  const ctx: ToolContext = {
    sandbox: new Sandbox(root, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    completeMemoryAudit: (d, r) => state.completeMemoryAudit(d, r),
  };
  state = new AgentState({
    adapter: idleAdapter,
    system: systemPrompt({
      root,
      access: "workspace",
      permissionMode: "auto",
      shell: "bash",
      platform: "linux",
      provider: "openai",
      model: "fake",
    }),
    tools: TOOLS.map((t) => t.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map(TOOLS.map((t) => [t.def.name, t])),
    permissionMode: "auto",
    permissionRules: { allow: [], deny: [], ask: [] },
  });
  session.state = state;
  session.cfg = {
    provider: "openai",
    model: "fake",
    thinking: "off",
    permissionMode: "auto",
    workspace: root,
    access: "workspace",
  };
  return state;
}

test("切范围落到四处：沙箱判定、下一次请求前的 World State 片段、会话快照配置、附着设备的广播（C4：system 一字不动）", () => {
  const root = temp("dimensio-access-");
  const outside = temp("dimensio-access-outside-");
  const session = createSession();
  const state = wireWorld(attach(session, root));
  const system = state.system;
  const events: any[] = [];
  watchSession(session, (ev) => events.push(ev));
  const sandbox = state.ctx.sandbox;
  const target = path.join(outside, "x.txt");

  assert.throws(() => sandbox.resolve(target), SandboxError, "仅工作空间：绝对路径越界必须拦");
  assert.equal(state.injectWorldDelta(false), false, "没变就不注入");

  assert.deepEqual(setSessionAccess(session, "full"), { ok: true });
  assert.equal(sandbox.access, "full");
  assert.equal(sandbox.resolve(target), path.resolve(target), "切整机后同一条路径当场放行");
  assert.equal(state.injectWorldDelta(false), true);
  assert.match(lastText(state), /FULL MACHINE/, "模型得知道边界挪了");
  assert.equal(session.cfg?.access, "full", "快照配置要跟上，否则重开会话又回到仅工作空间");
  assert.ok(events.some((e) => e.e === "access" && e.access === "full"));

  // 同值重复切 = 幂等，不再广播第二次
  const before = events.filter((e) => e.e === "access").length;
  assert.deepEqual(setSessionAccess(session, "full"), { ok: true });
  assert.equal(events.filter((e) => e.e === "access").length, before);

  // 切回去：拦截恢复，片段说的是 WORKSPACE ONLY
  assert.deepEqual(setSessionAccess(session, "workspace"), { ok: true });
  assert.throws(() => sandbox.resolve(target), SandboxError);
  assert.equal(state.injectWorldDelta(false), true);
  assert.match(lastText(state), /WORKSPACE ONLY/);
  assert.equal(session.cfg?.access, "workspace");
  // 以前每切一次就改写 system 的访问范围段，整个前缀缓存作废
  assert.equal(state.system, system, "切范围不改写 system");
  assert.equal(state.systemRewrites, 0);
  dropSession(session.id);
});

test("来回切、模型还没看见就切回原值：什么都不注入（C4）", () => {
  const root = temp("dimensio-access-flip-");
  const session = createSession();
  const state = wireWorld(attach(session, root));
  setSessionAccess(session, "full");
  setSessionAccess(session, "workspace");
  const count = state.messages.length;
  assert.equal(state.injectWorldDelta(false), false);
  assert.equal(state.messages.length, count);
  dropSession(session.id);
});

test("非法范围被挡在门外；密钥文件在整机模式下照旧封锁", () => {
  const root = temp("dimensio-access-bad-");
  const session = createSession();
  const state = attach(session, root);
  assert.deepEqual(setSessionAccess(session, "everything"), { ok: false, error: "invalid access" });
  assert.deepEqual(setSessionAccess(session, 1), { ok: false, error: "invalid access" });
  assert.equal(state.ctx.sandbox.access, "workspace");

  setSessionAccess(session, "full");
  const secret = path.join(os.homedir(), ".ssh", "id_rsa");
  assert.throws(() => state.ctx.sandbox.resolve(secret), SandboxError, "整机 ≠ 密钥也开放");
  dropSession(session.id);
});
