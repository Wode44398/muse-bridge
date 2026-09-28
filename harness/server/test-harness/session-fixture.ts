// 真会话夹具：startRun 走生产路径（自动召回、检查点、落盘都在），state 用给定的 adapter（脚本化 provider，或真
// adapter + wire-fakes 的假 fetch）。Q2 的布局场景与 C1 的召回契约共用。
import assert from "node:assert/strict";
import type { PermissionMode } from "../agent/permissions.ts";
import { describeWorldChange, systemPrompt } from "../agent/prompt.ts";
import { AgentState } from "../agent/state.ts";
import { worldTokens, type WorldValues } from "../agent/world-state.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import { Sandbox } from "../sandbox.ts";
import { createSession, startRun, type Session } from "../session.ts";
import { memoryAuditTool } from "../tools/memoryaudit.ts";
import { readTool } from "../tools/read.ts";
import type { Tool, ToolContext } from "../tools/types.ts";

export interface SessionFixtureOptions {
  mode?: PermissionMode;
  // 记忆审计门禁默认关（它的收尾挪位会混进别的场景）；要测它时显式打开
  memoryAudit?: boolean;
  tools?: Tool[];
}

export function attachSession(adapter: ProviderAdapter, root: string, opts: SessionFixtureOptions = {}): Session {
  const mode = opts.mode ?? "auto";
  const tools = opts.tools ?? [readTool, memoryAuditTool];
  let state!: AgentState;
  const ctx: ToolContext = {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    completeMemoryAudit: (d, r) => state.completeMemoryAudit(d, r),
  };
  state = new AgentState({
    adapter,
    system: systemPrompt({ root, access: "workspace", permissionMode: mode, shell: "bash", platform: "linux", provider: adapter.id, model: adapter.model }),
    tools: tools.map((tool) => tool.def),
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx,
    toolMap: new Map(tools.map((tool) => [tool.def.name, tool])),
    permissionMode: mode,
    permissionRules: { allow: [], deny: [], ask: [] },
    memoryAuditRequired: opts.memoryAudit ?? false,
  });
  wireWorld(state);
  // P13：与 buildState 一样，沙箱现读会话放行的工作区外只读目录
  ctx.sandbox.setReadGrants(() => state.readRoots);
  const session = createSession();
  session.state = state;
  session.cfg = { provider: adapter.id, model: adapter.model, thinking: "off", permissionMode: mode, workspace: root, access: "workspace" };
  return session;
}

// C4：给夹具自建的 AgentState 挂上 World State（生产由 session.buildState 挂）。夹具的 system 是按当前模式与访问范围
// 建的，令牌就记这两节；其余节（GUIDE、技能、项目知识……）要测时由 values 给出。
export function wireWorld(state: AgentState, values: (runStart: boolean) => WorldValues = () => ({})): AgentState {
  state.systemWorld = worldTokens({ mode: state.permissionMode, access: state.ctx.sandbox.access });
  state.worldSource = values;
  state.worldDescribe = (section, value, was) => describeWorldChange(section, value, was);
  return state;
}

// 最后一条消息的文字（World State 片段、各种提醒都追加在末尾）
export function lastText(state: AgentState): string {
  return (state.messages.at(-1)?.content ?? []).map((b) => (b.t === "text" ? b.text : "")).join("");
}

export async function send(session: Session, text: string): Promise<void> {
  const run = startRun(session, text);
  assert.ok(run.started, "这一轮没起来");
  await run.done;
}
