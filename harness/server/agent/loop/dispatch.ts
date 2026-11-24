// 工具调用的派发前处理：入参归一（别名 + 宽松类型转换）、每批开跑前注入 Bash 的当前目录、参数解析失败 / 不认识的工具 / 缺必填 /
// 没加载说明的推迟工具这几种不执行就能回话的情况，以及哪些调用能进并行批。
import type { AgentState } from "../state.ts";
import type { ToolRunResult } from "../../tools/types.ts";
import { fail } from "../../tools/types.ts";
import { missingArgsText, missingRequired, normalizeToolArgs } from "../tool-input.ts";
import { deferredGate, deferredLoaded } from "../deferred-tools.ts";
import { CWD_ARG, CWD_RESET_ARG, cwdProblem, sameDir, unusableNote } from "../../tools/bash/cwd.ts";

export interface LoopToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argsError?: string;
  argsRaw?: string;
  meta?: Record<string, unknown>;
}

export interface DispatchCall {
  // 交给权限判定与执行的那一份（归一过的）；转录里的原始调用不动
  call: LoopToolCall;
  // 不执行、直接回给模型的结果
  early?: ToolRunResult;
  // 推迟的工具没加载说明就直接执行：执行完附上这几件的完整说明
  docs?: string[];
}

// 带会话当前目录的工具（Bash，含 lean 姿态下 withoutVerify 包出来的那份）：按工具上的标记认，不按对象身份
const carriesShellCwd = (state: AgentState, name: string): boolean => state.toolMap.get(name)?.shellCwd === true;

// Bash 的隐藏键（当前目录、复位说明）只由 loop 写：模型自己写的同名键在派发前一律抹掉
function stripShellArgs(state: AgentState, call: LoopToolCall): LoopToolCall {
  if (!carriesShellCwd(state, call.name) || !(CWD_ARG in call.args || CWD_RESET_ARG in call.args)) return call;
  const args = { ...call.args };
  delete args[CWD_ARG];
  delete args[CWD_RESET_ARG];
  return { ...call, args };
}

/**
 * 每一批开跑前按会话此刻的目录重写 Bash 的 CWD_ARG（不是工作区根时才写）：同一轮里前一批（串行）的 cd 要作用到后面的 Bash。
 * 记着的目录已经用不了（删了、档位收紧了）就当场复位会话目录，改带一句说明（CWD_RESET_ARG）——权限判定、卡片与执行看到的是
 * 同一个目录。同一条调用可能被看好几次（判并行时往后看），复位说明看到过就留着。不执行就回话的调用不动。
 */
export function refreshShellCwd(state: AgentState, d: DispatchCall): DispatchCall {
  if (d.early || !carriesShellCwd(state, d.call.name)) return d;
  const shell = state.ctx.shell;
  const cwd = shell?.cwd;
  let keep = typeof cwd === "string" && cwd && !sameDir(cwd, state.ctx.sandbox.root) ? cwd : undefined;
  let reset: string | undefined;
  if (keep) {
    const why = cwdProblem(state.ctx, keep);
    if (why) {
      reset = unusableNote(keep, why);
      if (shell) shell.cwd = undefined;
      keep = undefined;
    }
  }
  const args = { ...d.call.args };
  delete args[CWD_ARG];
  if (keep) {
    args[CWD_ARG] = keep;
    delete args[CWD_RESET_ARG];
  } else if (reset) args[CWD_RESET_ARG] = reset;
  if (args[CWD_ARG] === d.call.args[CWD_ARG] && args[CWD_RESET_ARG] === d.call.args[CWD_RESET_ARG]) return d;
  return { ...d, call: { ...d.call, args } };
}

const loaded = (state: AgentState, call: LoopToolCall): boolean =>
  state.loadedTools.has(call.name) || deferredLoaded(state.messages, call.name, call.id);

export function prepareCall(state: AgentState, raw: LoopToolCall): DispatchCall {
  const tool = state.toolMap.get(raw.name);
  // P14（ZCode C6）：按工具声明的 schema 宽松归一化入参（别名换成规范名、只做强制转换不做拒绝）；转录里的原始参数不动，
  // 归一化后的只用于权限判定与执行（以及之后的门禁记账）
  const aliases = { ...state.profile.tools.pathAliases, ...(tool?.aliases ?? {}) };
  const normalized = normalizeToolArgs(tool?.def.parameters, raw.args, aliases);
  const call = stripShellArgs(state, normalized.changed.length ? { ...raw, args: normalized.args } : raw);
  // Arguments that never parsed as JSON: don't run the tool with {} —
  // feed the parse error back so the model can re-issue the call.
  if (call.argsError) {
    return {
      call,
      early: fail(
        "bad tool arguments",
        `The arguments for ${call.name} were not valid JSON (${call.argsError}). ` +
          `Raw arguments received:\n${call.argsRaw || "(empty)"}\n` +
          "Re-issue the tool call with complete, valid JSON arguments.",
      ),
    };
  }
  // A name the registry doesn't know (hallucinated or mangled): tell the
  // model what IS available instead of a confusing permission denial.
  if (!tool) {
    return { call, early: fail("unknown tool", `Unknown tool "${call.name}". Available tools: ${[...state.toolMap.keys()].join(", ")}.`) };
  }
  // 工具延迟加载（deferred-tools.ts）：说明还没加载就调了推迟的工具——参数过得了完整 schema 就照常执行、结果后附说明；
  // 过不了（或不看说明写不对的工具）就不执行，回完整说明（记为已加载），模型照着重发
  const deferred = state.ctx.deferredTools;
  if (deferred?.has(call.name) && !loaded(state, call)) {
    const gate = deferredGate(call.name, call.args, deferred);
    return gate.run ? { call, docs: gate.docs } : { call, early: gate.res };
  }
  // 缺必填：不执行，回一句照着就能改的话
  if (!tool.looseRequired) {
    const missing = missingRequired(tool.def.parameters, call.args);
    if (missing.length) return { call, early: fail("missing parameters", missingArgsText(call.name, tool.def.parameters, call.args, missing)) };
  }
  return { call };
}

/** 这次调用能不能进并行批：工具本身只读，或按这一次的入参判是只读（Bash 的只读命令）。不执行就回话的也算。 */
export function runsConcurrently(state: AgentState, d: DispatchCall): boolean {
  if (d.early) return true;
  const tool = state.toolMap.get(d.call.name);
  if (!tool) return true;
  if (tool.concurrencySafe) return true;
  try {
    return tool.concurrentFor?.(d.call.args) === true;
  } catch {
    return false;
  }
}

/** 结果里带了「这些推迟工具的说明已经给了」：记进会话状态（随会话落盘，压缩后不丢）。 */
export function noteLoadedTools(state: AgentState, res: ToolRunResult): void {
  const names = res.meta?.loadedTools;
  if (!Array.isArray(names)) return;
  for (const n of names) if (typeof n === "string") state.loadedTools.add(n);
}
