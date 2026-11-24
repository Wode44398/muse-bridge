// hooks 在 agent 运行里的挂点：工具调用前后（PreToolUse / PostToolUse）、收尾（Stop / SubagentStop）、整段压缩之前
// （PreCompact）、一轮开跑时（项目级 hooks 的信任确认、SessionStart、UserPromptSubmit）。会话没有 hooks（ctx.hooks 没挂）
// 时每个挂点第一行就返回，什么都不多做。
//
// hook 给模型的话一律落进转录：工具调用的阻止原因与附加上下文是这次工具结果的一部分，其余（附加上下文、Stop 的继续理由）
// 是一条 harness 消息（kind hook，开头 [Hook: <事件>]）。
import type { AgentState } from "../agent/state.ts";
import type { Decision } from "../agent/permissions.ts";
import type { LoopToolCall } from "../agent/loop/dispatch.ts";
import { normalizeToolArgs } from "../agent/tool-input.ts";
import type { Block, Msg } from "../agent/turn.ts";
import { CWD_ARG, CWD_RESET_ARG } from "../tools/bash/cwd.ts";
import type { ToolRunResult } from "../tools/types.ts";
import { capText } from "./protocol.ts";
import { trustProjectHooks } from "./trust.ts";

export const HOOK_KIND = "hook";
export const hookHeader = (event: string) => `[Hook: ${event}]`;
export const HOOK_RULE = "hook·PreToolUse";
export const HOOK_TRUST_RULE = "内置·项目 hooks";
// 一轮里 Stop hook 最多拦几次收尾（再拦就照常收尾、记一行日志），防止 hook 与模型互相顶着转圈
export const MAX_STOP_HOOK_BLOCKS = 3;

const HIDDEN_ARGS = [CWD_ARG, CWD_RESET_ARG];
// 送给 hook 的参数按 Claude Code 的名字补一份（hook 脚本普遍读 tool_input.file_path）；hook 改的是这份名字也认
const CLAUDE_CODE_ARGS: Record<string, [alias: string, canonical: string][]> = {
  Read: [["file_path", "path"]],
  Write: [["file_path", "path"]],
  Edit: [["file_path", "path"]],
  Bash: [["run_in_background", "background"]],
};

function hookToolInput(call: LoopToolCall): Record<string, unknown> {
  const input: Record<string, unknown> = { ...call.args };
  for (const k of HIDDEN_ARGS) delete input[k];
  for (const [alias, canonical] of CLAUDE_CODE_ARGS[call.name] ?? []) {
    if (input[canonical] !== undefined && input[alias] === undefined) input[alias] = input[canonical];
  }
  return input;
}

// hook 给的新参数：Claude Code 名字改过的换回规范名，再按工具 schema 归一；loop 写的隐藏键沿用原调用的
function applyUpdatedInput(state: AgentState, call: LoopToolCall, sent: Record<string, unknown>, updated: Record<string, unknown>): LoopToolCall {
  const next: Record<string, unknown> = { ...updated };
  for (const k of HIDDEN_ARGS) delete next[k];
  for (const [alias, canonical] of CLAUDE_CODE_ARGS[call.name] ?? []) {
    if (alias in next) {
      if (next[alias] !== sent[alias]) next[canonical] = next[alias];
      delete next[alias];
    }
  }
  const tool = state.toolMap.get(call.name);
  const aliases = { ...state.profile.tools.pathAliases, ...(tool?.aliases ?? {}) };
  const args = normalizeToolArgs(tool?.def.parameters, next, aliases).args;
  for (const k of HIDDEN_ARGS) if (call.args[k] !== undefined) args[k] = call.args[k];
  return { ...call, args };
}

export interface PreToolHook {
  call: LoopToolCall; // 执行用的调用（hook 改了参数就是改过的）
  deny?: string;
  permission?: "allow" | "ask";
  reason?: string;
  context?: string;
}

export async function preToolHook(state: AgentState, call: LoopToolCall): Promise<PreToolHook | null> {
  const hooks = state.ctx.hooks;
  if (!hooks?.has("PreToolUse", call.name)) return null;
  const sent = hookToolInput(call);
  const outcome = await hooks.run(
    "PreToolUse",
    { tool_name: call.name, tool_input: sent, tool_use_id: call.id },
    { subject: call.name, signal: state.ctx.signal, permissionMode: state.effectiveMode() },
  );
  if (!outcome) return null;
  const out: PreToolHook = { call: outcome.updatedInput ? applyUpdatedInput(state, call, sent, outcome.updatedInput) : call };
  if (outcome.context) out.context = outcome.context;
  if (outcome.block) out.deny = outcome.block;
  else if (outcome.permission === "deny") out.deny = outcome.permissionReason ?? "a PreToolUse hook denied this call";
  else if (outcome.permission) {
    out.permission = outcome.permission;
    if (outcome.permissionReason) out.reason = outcome.permissionReason;
  }
  return out;
}

// hook 的 allow 只放开「要问人」的那一档（控制面文件、硬拒、模式限制照旧）；ask 把本来放行的调用转成问人
export function applyHookPermission(decision: Decision, pre: PreToolHook | null): Decision {
  if (!pre?.permission) return decision;
  if (pre.permission === "allow" && decision.effect === "ask" && !decision.noSession) return { effect: "allow", reason: "", rule: HOOK_RULE };
  if (pre.permission === "ask" && decision.effect === "allow") {
    return {
      effect: "ask",
      reason: `a PreToolUse hook asked for the user's approval${pre.reason ? ` (${pre.reason})` : ""}`,
      rule: HOOK_RULE,
      why: pre.reason ? `hook 要求先确认：${pre.reason}` : "用户配置的 hook 要求这一步先确认",
    };
  }
  return decision;
}

export function hookDeniedText(reason: string): string {
  return `${hookHeader("PreToolUse")} A PreToolUse hook blocked this call:\n${capText(reason)}`;
}

const textOf = (blocks: Block[]): string => blocks.map((b) => (b.t === "text" ? b.text : "")).join("\n");

// 工具跑完：PreToolUse 给的附加上下文、PostToolUse 的反馈（退出码 2 的 stderr、decision block 的 reason、附加上下文）附在结果后面
export async function postToolHook(state: AgentState, call: LoopToolCall, res: ToolRunResult, pre: PreToolHook | null): Promise<ToolRunResult> {
  const hooks = state.ctx.hooks;
  if (!hooks) return res;
  const notes: string[] = [];
  if (pre?.context) notes.push(`${hookHeader("PreToolUse")}\n${capText(pre.context)}`);
  if (hooks.has("PostToolUse", call.name)) {
    const input = hookToolInput(call);
    const outcome = await hooks.run(
      "PostToolUse",
      {
        tool_name: call.name,
        tool_input: input,
        tool_use_id: call.id,
        tool_response: {
          success: res.ok,
          summary: res.summary,
          output: capText(textOf(res.content), 20_000),
          ...(typeof input.file_path === "string" ? { filePath: input.file_path } : {}),
        },
      },
      { subject: call.name, signal: state.ctx.signal, permissionMode: state.effectiveMode() },
    );
    if (outcome?.block) notes.push(`${hookHeader("PostToolUse")} Feedback from a PostToolUse hook:\n${capText(outcome.block)}`);
    if (outcome?.context) notes.push(`${hookHeader("PostToolUse")}\n${capText(outcome.context)}`);
  }
  if (!notes.length) return res;
  return { ...res, content: [...res.content, ...notes.map((text): Block => ({ t: "text", text }))] };
}

function appendHookMessage(state: AgentState, event: string, body: string): Msg | null {
  state.appendUserBlocks([{ t: "text", text: `${hookHeader(event)}\n${capText(body)}` }], false, { origin: "harness", kind: HOOK_KIND });
  return state.messages.at(-1) ?? null;
}

// 要收尾了：Stop（子 agent 是 SubagentStop）hook 拦下就追加理由、返回 true（loop 接着跑一轮）。blocksSoFar = 这一轮已经拦过几次
export async function stopHook(state: AgentState, text: string, blocksSoFar: number): Promise<boolean> {
  const hooks = state.ctx.hooks;
  if (!hooks || state.budgetExhausted) return false;
  const event = hooks.subagent ? "SubagentStop" : "Stop";
  if (!hooks.has(event)) return false;
  const outcome = await hooks.run(
    event,
    { stop_hook_active: blocksSoFar > 0, last_assistant_message: text.slice(0, 20_000) },
    { signal: state.ctx.signal, permissionMode: state.effectiveMode() },
  );
  if (!outcome?.block) return false;
  if (blocksSoFar >= MAX_STOP_HOOK_BLOCKS) {
    console.warn(`[hooks] ${event} hook 这一轮已经拦了 ${blocksSoFar} 次收尾，这次不再拦`);
    return false;
  }
  appendHookMessage(state, event, `A ${event} hook did not let you finish yet. Its reason:\n${outcome.block}\n\nAddress it, then finish again.`);
  return true;
}

// signal = 这次压缩自己的中止信号（一轮里的压缩是这一轮的，空闲压缩是它那个；用户点的「立即压缩」没有）。不用 ctx.signal：
// 一轮结束后它还停在那一轮上（被停止过的话一直是 aborted），轮外的压缩拿它会让 hook 一起跑就被掐掉
export async function preCompactHook(state: AgentState, trigger: "manual" | "auto", signal?: AbortSignal): Promise<void> {
  const hooks = state.ctx.hooks;
  if (!hooks?.has("PreCompact", trigger)) return;
  const outcome = await hooks.run("PreCompact", { trigger, custom_instructions: "" }, { subject: trigger, signal, permissionMode: state.effectiveMode() });
  if (outcome?.block) console.warn(`[hooks] PreCompact hook 退出码 2（压缩照常进行）：${outcome.block.slice(0, 300)}`);
}

// ── 一轮开跑 ────────────────────────────────────────────────────────────────────

// 项目级 hooks 还没确认过：有人在场就问一次（确认卡，只能「允许这一次」= 信任这份配置）；没人在场这一轮不执行项目级的
async function ensureProjectTrust(state: AgentState): Promise<void> {
  const hooks = state.ctx.hooks;
  if (!hooks || hooks.trust !== "pending" || hooks.subagent) return;
  const ask = state.ctx.requestPermission;
  if (!ask || state.ctx.humanAttended?.() === false) {
    console.warn(`[hooks] ${hooks.workspace} 的项目级 hooks 还没确认过、此刻没人在场，这一轮不执行它们`);
    return;
  }
  const list = hooks.projectHooks();
  // 命令点名的脚本也列出来：信任的是这些文件此刻的内容（改了要重新确认，见 script-refs.ts）
  const lines = list.map((h) => `${h.event}${h.matcher ? ` [${h.matcher}]` : ""}: ${h.command}${h.refs?.length ? `\n  runs: ${h.refs.join(", ")}` : ""}`);
  const text = lines.join("\n");
  const verdict = await ask({
    tool: "Hooks",
    subject: hooks.workspace,
    rule: HOOK_TRUST_RULE,
    noSession: true,
    why: `这个工作区的项目设置里配了 ${list.length} 条 hooks，会在本机自动执行命令（${[...new Set(list.map((h) => h.file))].join("、")}）。允许 = 信任这份配置，以后不再问；配置改了会再问。`,
    preview: { kind: "text", text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text, ...(text.length > 4000 ? { truncated: true } : {}) },
  });
  if (verdict.decision !== "deny" && !verdict.away && hooks.projectHash) {
    try {
      trustProjectHooks(hooks.workspace, hooks.projectHash);
    } catch (e) {
      console.warn(`[hooks] 信任记录没写成（${(e as Error).message.slice(0, 160)}），这个会话照常执行，下次还会再问`);
    }
    hooks.setTrust("trusted");
  } else if (verdict.decision === "deny" && !verdict.unanswered) {
    hooks.setTrust("declined"); // 这个会话里不再问
  } else {
    console.warn(`[hooks] ${hooks.workspace} 的项目级 hooks 没得到确认（${verdict.away ? "离开模式" : verdict.timedOut ? "超时" : "没答"}），这一轮不执行它们`);
  }
}

const promptOf = (m: Msg): string =>
  typeof m.displayText === "string" ? m.displayText : m.content.map((b) => (b.t === "text" ? b.text : "")).join("\n");

// 一轮开跑、第一次请求之前。userMsg = 这一轮用户本人发的那条（续跑、目标续轮、会话消息开的轮没有）。
// UserPromptSubmit 拦下：这条消息和它后面跟着的 harness 片段从转录里拿掉（还没送进模型），返回原因给用户看
export async function runStartHooks(state: AgentState, userMsg: Msg | null): Promise<{ blocked?: string }> {
  const hooks = state.ctx.hooks;
  if (!hooks || hooks.subagent) return {};
  await ensureProjectTrust(state);
  const signal = state.ctx.signal;
  const permissionMode = state.effectiveMode();
  // SessionStart 给的上下文（这条消息被拦下时它要留着：SessionStart 每个会话只发一次，删了就再也拿不到）
  let startMsg: Msg | null = null;
  if (hooks.takeSessionStart()) {
    const source = userMsg && state.messages.indexOf(userMsg) === 0 ? "startup" : "resume";
    const outcome = await hooks.run("SessionStart", { source }, { subject: source, signal, permissionMode });
    if (outcome?.block) console.warn(`[hooks] SessionStart hook 退出码 2：${outcome.block.slice(0, 300)}`);
    if (outcome?.context) startMsg = appendHookMessage(state, "SessionStart", outcome.context);
  }
  if (!userMsg) return {};
  const outcome = await userPromptHook(state, promptOf(userMsg));
  if (outcome.blocked) {
    const at = state.messages.indexOf(userMsg);
    if (at >= 0) {
      const removed = state.messages.splice(at);
      if (startMsg && removed.includes(startMsg)) state.messages.push(startMsg);
    }
    return { blocked: outcome.blocked };
  }
  if (outcome.context) appendHookMessage(state, "UserPromptSubmit", outcome.context);
  return {};
}

// UserPromptSubmit：一轮开头那条用户消息与运行中的插话都过它。blocked = 拦下的原因；context = 要紧跟在这条消息后面的附加上下文
export async function userPromptHook(state: AgentState, prompt: string): Promise<{ blocked?: string; context?: string }> {
  const hooks = state.ctx.hooks;
  if (!hooks || hooks.subagent) return {};
  const outcome = await hooks.run("UserPromptSubmit", { prompt }, { signal: state.ctx.signal, permissionMode: state.effectiveMode() });
  if (outcome?.block) return { blocked: outcome.block };
  return outcome?.context ? { context: outcome.context } : {};
}

// 插话的附加上下文：跟在插话（及它带的 /技能、/命令正文）后面
export function appendPromptContext(state: AgentState, context: string): void {
  appendHookMessage(state, "UserPromptSubmit", context);
}
