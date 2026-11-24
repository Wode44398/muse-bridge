// 外部内容判定、没覆盖到的反向依赖测试、验证追问的措辞、待办提醒与几个小工具。
import type { TodoItem } from "../events.ts";
import type { Msg } from "../turn.ts";
import type { AgentState } from "../state.ts";
import { uncoveredReferencingTests } from "../revdeps.ts";
import type { ToolRunResult } from "../../tools/types.ts";
import { REVDEP_REPORT_MAX, VERIFY_NUDGE, VERIFY_UNDECLARED_NUDGE } from "./limits.ts";

// K9（X55）：会把外部内容（网页、搜索结果、浏览器里的页面、别的程序的界面）带进会话的工具。本会话真调过其中之一
// ——成没成都算，WebFetch 遇到 4xx / 5xx 照样带回页面正文——之后 Remember 想存成 active 的，一律先存成 proposed 等用户确认：
// 网页里写着的错误事实或注入，不能被模型自己写成以后每个会话都信的记忆。子 agent / Workflow 读过的，由它们的结果带上来。
// 设备工具都算：DeviceAct 的结果里也有别的程序的界面（落点控件名、窗口标题、输入回读、操作后截图），设备浏览器 / 命令 / 文件同理。
// LocalPCInspect / LocalPCAct 是它们的旧名：老会话的转录里还是旧名（transcriptReadExternal 从转录推）。
const EXTERNAL_CONTENT_TOOLS = new Set([
  "WebFetch", "WebSearch", "Browser", "ReadPage", "Eval", "Network", "DeviceInspect", "DeviceAct", "DeviceBrowser", "DeviceShell", "DeviceFiles", "LocalPCInspect", "LocalPCAct",
]);
// Bash 里直接抓网页同理：curl / wget、PowerShell 的 Invoke-WebRequest / Invoke-RestMethod 与别名 iwr / irm。只认命令位置
// （开头、管道 / 分隔符 / 子命令 / 赋值之后），`grep -r wget docs/` 这种当参数的不算。
const FETCH_COMMAND_RE = /(?:^|[;&|(\n`=]|\$\()\s*(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?(?=[\s;&|)]|$)/im;

function readsExternal(call: { name: string; args: Record<string, unknown> }): boolean {
  if (EXTERNAL_CONTENT_TOOLS.has(call.name)) return true;
  // E1：MCP 连接器是别人的程序 / 服务，回来的都算外部内容（McpResources：直连连接器的资源列读，失败时的错误文本也是连接器给的）
  if (call.name.startsWith("mcp__") || call.name === "McpCall" || call.name === "McpDescribe" || call.name === "McpResources") return true;
  return call.name === "Bash" && FETCH_COMMAND_RE.test(String(call.args.command ?? ""));
}

export function bringsExternalContent(call: { name: string; args: Record<string, unknown> }, res: ToolRunResult, invoked: boolean): boolean {
  return res.externalContent === true || (invoked && readsExternal(call));
}

// 恢复 K9 之前写的会话：转录里出现过这类调用就算（被拒的也算——转录里分不清，宁可多标；压缩掉的推不出来）
export function transcriptReadExternal(messages: readonly Msg[]): boolean {
  return messages.some((m) => m.content.some((b) => b.t === "tool_call" && readsExternal(b)));
}

// Cache for the reverse-dependency scan below, which walks the whole workspace.
// Both done-gate paths (the no-tool stop and the audit-closure early finish) call
// buildVerifyNudge, so a single run used to pay for two full scans of a large
// repo. The scan is a pure function of (root, editedFiles, ranCommands) — key on
// those and reuse while they are unchanged.
let revdepCache: { key: string; files: string[] } | null = null;

async function scanUncovered(state: AgentState): Promise<string[]> {
  // 键用 JSON.stringify：无需自造分隔符（早先版本用不可见控制字符当分隔符，
  // 结果 git 把整个文件当二进制，diff/grep 全失效）。
  const key = JSON.stringify([
    state.ctx.sandbox.root,
    [...state.editedFiles].sort(),
    [...state.ranCommands].sort(),
  ]);
  if (revdepCache?.key === key) return revdepCache.files;
  const files = await uncoveredReferencingTests(
    state.ctx.sandbox.root,
    state.editedFiles,
    state.ranCommands,
  );
  revdepCache = { key, files };
  return files;
}

// Decide what (if anything) to nudge with when the model stops after editing.
// Never throws — the scan is a best-effort heuristic.
export async function buildVerifyNudge(state: AgentState): Promise<string | null> {
  if (state.verificationAuditCompleted) return null;
  let uncovered: string[] = [];
  try {
    uncovered = await scanUncovered(state);
  } catch {
    // fall through — the dirty check below still applies
  }
  const list = uncovered.slice(0, REVDEP_REPORT_MAX).join(", ");
  const more = uncovered.length > REVDEP_REPORT_MAX ? ` (+${uncovered.length - REVDEP_REPORT_MAX} more)` : "";

  if (state.dirtySinceVerify) {
    // Same gate either way — only the accusation changes. Telling a model that
    // just ran a passing build "you have no verification evidence" reads as a
    // false report and teaches it to distrust the gate.
    const undeclared = state.undeclaredEvidence.slice(-2).join(" | ");
    const head = undeclared
      ? `${VERIFY_UNDECLARED_NUDGE} Commands that ran clean but were never declared: ${undeclared}.`
      : VERIFY_NUDGE + (state.lastVerification ? ` Last requested verification: ${state.lastVerification}.` : "");
    return head + (uncovered.length ? ` Start with the test files that reference what you changed: ${list}${more}.` : "");
  }
  if (uncovered.length) {
    return (
      `[Automated check] These test files reference modules you edited but were never run: ${list}${more}. ` +
      "Callers often depend on exact behavior, so your change may break them. Run them now and fix any failures before finishing."
    );
  }
  return null;
}

// 这一轮工具回合之后该不该在下一次请求末尾带一份待办清单（档案 loop.todoReminderEvery / todoReminderOnlyIncomplete）
export function todoReminderDue(state: AgentState): boolean {
  const { todoReminderEvery: every, todoReminderOnlyIncomplete: onlyOpen } = state.profile.loop;
  if (every <= 0 || !state.todos.length) return false;
  if (onlyOpen && !state.todos.some((t) => t.status !== "completed")) return false;
  return state.turnsSinceTodoSeen >= every;
}

// 正常结束的一次调用只带回了思考：没有答复正文、没有工具调用
export function thinkingOnlyReply(stop: string, text: string, thinkingText: string, callCount: number): boolean {
  return stop === "end" && callCount === 0 && !text.trim() && thinkingText.trim() !== "";
}

export function renderTodoReminder(todos: TodoItem[]): string {
  const lines = todos.map(
    (t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`,
  );
  return (
    `[Reminder — your current todo list]\n${lines.join("\n")}\n` +
    "Continue the in_progress item. Keep the list up to date with TodoWrite; mark items completed as soon as they are done."
  );
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function renderRaw(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw.slice(0, 800);
  try {
    return JSON.stringify(raw).slice(0, 800);
  } catch {
    return String(raw);
  }
}
