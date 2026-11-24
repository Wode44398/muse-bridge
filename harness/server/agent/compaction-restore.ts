// 整段压缩之后紧跟摘要的那条「工作现场」（harness 内部消息，kind compaction-restore）：当前待办、最近改过的几个文件的当前
// 磁盘内容、plan 模式下还没批准的计划、还在跑的后台任务与待触发的定时唤醒（ScheduleWakeup，并在后台任务那一节）、还在跑的后台子 agent。摘要只是笔记；这些是压完马上要用、又不该让模型重新摸索的现场。
// 回填过的文件按回填的范围记成「已读」（与 Read 记的同一个形状），不必重读就能接着改；没回填的照旧要先 Read。
// 回填有预算（单个文件、合计都按压缩窗口算、有绝对上限），压缩方放不下时按优先级裁：先丢最早改的文件，再丢计划；待办与
// 后台任务很短，始终保留。
// 反复压缩：上一次压缩把 Write / Edit / ExitPlanMode 调用换成了摘要，它们只剩在上一条回填里——所以上一条回填列过的文件与计划
// 也算来源（排在转录里还看得到的改动之后），没有新改动时照样回填。
// 回填替模型读文件，所以每个文件先按当前权限模式与规则判一次 Read：不是 allow（deny、要弹卡的 ask）就不回填。
// 延迟加载的工具：「已加载」是会话状态（AgentState.loadedTools），压缩不该把它丢掉；可它们的完整说明多半在被压掉的那段里。
// 所以说明已不在尾部里的已加载工具，在回填里再给一份说明（计入预算、裁剪时最先丢）；压缩提交时已加载集合按「压完的上下文里
// 看得到说明的」重算——裁掉的那几件回到未加载，下次调用照常附上说明。
import fs from "node:fs/promises";
import { redactOutput } from "../redact.ts";
import { runningJobsSummary } from "../tools/bash.ts";
import { pendingWakeupsSummary } from "../wakeup/store.ts";
import { runningAgentsSummary } from "./subagent/registry.ts";
import type { FileState } from "../tools/types.ts";
import type { AgentState } from "./state.ts";
import { tokensOf } from "./compaction-shape.ts";
import { messageKind } from "./injections.ts";
import { decide } from "./permissions.ts";
import { docsFor } from "./deferred-tools.ts";
import { toolArgStr } from "./tool-input.ts";
import { loadedDocSummary, LOADED_DOCS_HEADING } from "../project-docs/subdir.ts";
import type { Msg } from "./turn.ts";

export const RESTORE_KIND = "compaction-restore";
export const RESTORE_HEAD = "[Context restored after compaction]";
// 各节标题：renderRestore 写、priorRestore 按它们把上一条回填拆回来
const TODO_HEADING = "## Todo list";
export const PLAN_HEADING = "## Plan awaiting approval";
const JOBS_HEADING = "## Background jobs still running";
const WAKEUPS_HEADING = "## Scheduled wakeups pending"; // 没有在跑的后台任务、只有待触发的唤醒时这一节的标题
const AGENTS_HEADING = "## Background sub-agents still running";
const TOOLS_HEADING = "## Loaded deferred tools (full instructions)";
const FILES_HEADING = "## Recently edited files (current contents on disk)";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MAX_FILES = 5;
const TOTAL_CAP = 30_000; // 合计 token 的绝对上限
const PER_FILE_CAP = 8_000; // 单个文件 token 的绝对上限
const PLAN_CAP = 4_000;
const MIN_FILE_TOKENS = 200; // 剩下的地方连文件开头都放不下就不回填
const MAX_FILE_BYTES = 2_000_000; // 更大的不读（多半不是手改的源文件）
const MAX_LINE_LEN = 2_000; // 与 Read 同一个截断
const BINARY_SNIFF = 8_192;

export interface RestoredFile {
  abs: string;
  rel: string;
  text: string; // 渲染好的一节（标题 + 带行号的正文）
  tokens: number;
  read: FileState; // 回填后记进 readFileState 的状态
}

export interface Restore {
  todos: string;
  plan: string;
  jobs: string;
  wakeups?: string; // 待触发的定时唤醒（一行汇总）
  agents?: string; // 还在后台跑的子 agent（一行一个）
  files: RestoredFile[]; // 最近改的在前
  tools?: { names: string[]; text: string; tokens: number }; // 说明已不在尾部里的已加载延迟工具，再给一份说明
  loadedInTail?: string[]; // 尾部里看得到说明的已加载延迟工具（不必回填）
  editNeedsRead?: boolean; // 档案要求 Edit 前先 Read（readBeforeEdit strict）：措辞里说没回填的文件要先读
  docs?: string[]; // 按需加载过的子目录指令文件（只列路径，算「已加载」，不再整段注入）
}

// 合计不超过压缩窗口的 10%、单个不超过 3%，各有绝对上限
export function restoreBudget(limit: number): { total: number; perFile: number } {
  return { total: Math.min(TOTAL_CAP, Math.floor(limit * 0.1)), perFile: Math.min(PER_FILE_CAP, Math.floor(limit * 0.03)) };
}

// 模型原样写的参数（转录里存的那份）：认工具自带的别名（file_path / filePath …）
const pathArg = (tool: string, args: Record<string, unknown> | undefined): string | null => {
  const p = toolArgStr(tool, args, "path");
  return p && p.trim() ? p : null;
};

// 改过的文件，按最后一次改动从新到旧（只认成功的改动）
function editedPaths(messages: Msg[]): string[] {
  const ok = new Map<string, boolean>();
  for (const m of messages) for (const b of m.content) if (b.t === "tool_result") ok.set(b.id, b.ok);
  const last = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    for (const b of m.content) {
      if (b.t !== "tool_call" || !EDIT_TOOLS.has(b.name) || ok.get(b.id) !== true) continue;
      const p = pathArg(b.name, b.args);
      if (p) last.set(p, i);
    }
  });
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

// 上一条回填（若还在转录里）列过的文件（最近改的在前）与计划原文
export function priorRestore(messages: Msg[]): { files: string[]; plan: string } {
  let text = "";
  for (let i = messages.length - 1; i >= 0 && !text; i--) {
    if (messageKind(messages[i]) === RESTORE_KIND) text = messages[i].content.map((b) => (b.t === "text" ? b.text : "")).join("");
  }
  if (!text) return { files: [], plan: "" };
  const section = (heading: string): string => {
    const at = text.indexOf(`\n\n${heading}\n`);
    if (at < 0) return "";
    const start = at + heading.length + 3;
    const ends = [JOBS_HEADING, WAKEUPS_HEADING, AGENTS_HEADING, TOOLS_HEADING, FILES_HEADING, LOADED_DOCS_HEADING].map((h) => text.indexOf(`\n\n${h}\n`, start)).filter((n) => n >= 0);
    return text.slice(start, ends.length ? Math.min(...ends) : text.length);
  };
  const filesAt = text.indexOf(`\n\n${FILES_HEADING}\n`);
  const files = filesAt < 0 ? [] : [...text.slice(filesAt).matchAll(/^### (.+?) \(lines \d+-\d+ of \d+/gm)].map((m) => m[1]);
  return { files, plan: section(PLAN_HEADING).trim() };
}

function todoText(state: AgentState): string {
  if (!state.todos.length) return "";
  const lines = state.todos.map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`);
  return `${lines.join("\n")}\nKeep the list up to date with TodoWrite.`;
}

// plan 模式下最后一次交的计划还落在被压掉的那段里（尾部看不到它）：原文回填，并说明它还没被批准
function planText(state: AgentState, messages: Msg[], tailStart: number, budget: number, prior: string): string {
  if (state.permissionMode !== "plan") return "";
  let at = -1;
  let plan = "";
  let id = "";
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    for (const b of m.content) {
      if (b.t === "tool_call" && b.name === "ExitPlanMode" && typeof b.args?.plan === "string") {
        at = i;
        plan = b.args.plan;
        id = b.id;
      }
    }
  });
  // 转录里已经没有 ExitPlanMode 调用（上一次压缩把它换掉了）：沿用上一条回填里的计划原文
  if (at < 0) return prior ? clipTokens(prior, budget) : "";
  if (at >= tailStart || !plan.trim()) return "";
  let answer = "";
  for (const m of messages) {
    for (const b of m.content) {
      if (b.t === "tool_result" && b.id === id) answer = b.content.map((c) => (c.t === "text" ? c.text : "")).join(" ").replace(/\s+/g, " ").trim().slice(0, 400);
    }
  }
  const body = clipTokens(plan.trim(), budget);
  return `You are still in plan mode. The last plan you submitted with ExitPlanMode is not approved${answer ? ` (the response was: ${answer})` : ""}:\n${body}`;
}

function clipTokens(text: string, budget: number): string {
  if (tokensOf(text) <= budget) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const cost = tokensOf(l) + 1;
    if (used + cost > budget) break;
    out.push(l);
    used += cost;
  }
  return `${out.join("\n")}\n… (${lines.length - out.length} more lines not shown)`;
}

// 一个文件的一节：带行号（与 Read 的格式一样，Edit 照样认得出行号前缀），预算不够就只给开头并写明从哪接着读
function renderFile(rel: string, raw: string, budget: number): { text: string; shown: number; total: number } | null {
  const lines = raw.split("\n");
  const numbered: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].length > MAX_LINE_LEN ? `${lines[i].slice(0, MAX_LINE_LEN)} …[truncated]` : lines[i];
    const row = `${String(i + 1).padStart(6)}\t${line}`;
    const cost = tokensOf(row) + 1;
    if (used + cost > budget - 40) break;
    numbered.push(row);
    used += cost;
  }
  if (!numbered.length) return null;
  const shown = numbered.length;
  const more = shown < lines.length ? `; ${lines.length - shown} more lines not shown, Read with offset=${shown + 1} for the rest` : "";
  return { text: `### ${rel} (lines 1-${shown} of ${lines.length}${more})\n${redactOutput(numbered.join("\n"))}`, shown, total: lines.length };
}

// 这个文件现在许不许模型 Read：按当前模式与规则（含本会话允许、本 run 的拒绝台账）判；模型写过的原样路径、相对路径、绝对路径
// 三种写法都得是 allow（规则按字面匹配，换种写法不能绕过去）
function readAllowed(state: AgentState, paths: string[]): boolean {
  if (!state.toolMap.has("Read")) return false;
  const mode = state.effectiveMode();
  const rules = state.effectiveRules();
  const ctx = { root: state.ctx.sandbox.root, denied: state.deniedTargets };
  return [...new Set(paths)].every((path) => decide(mode, "Read", state.toolMap, { path }, rules, ctx).effect === "allow");
}

async function restoreFiles(state: AgentState, paths: string[], budget: { total: number; perFile: number }): Promise<RestoredFile[]> {
  const sandbox = state.ctx.sandbox;
  if (!sandbox || budget.perFile < MIN_FILE_TOKENS) return [];
  const out: RestoredFile[] = [];
  const seen = new Set<string>();
  let left = budget.total;
  for (const p of paths) {
    if (out.length >= MAX_FILES || left < MIN_FILE_TOKENS) break;
    let abs: string;
    try {
      abs = sandbox.resolve(p);
    } catch {
      continue; // 现在的访问范围读不到它（或路径不合法）：不回填
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!readAllowed(state, [p, sandbox.rel(abs), abs])) continue;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const bytes = await fs.readFile(abs);
      if (bytes.subarray(0, BINARY_SNIFF).includes(0)) continue;
      const raw = bytes.toString("utf8");
      const rel = sandbox.rel(abs);
      const r = renderFile(rel, raw, Math.min(budget.perFile, left));
      if (!r) continue;
      const tokens = Math.ceil(tokensOf(r.text));
      left -= tokens;
      out.push({ abs, rel, text: r.text, tokens, read: { mtimeMs: stat.mtimeMs, content: raw, readRanges: [[1, r.shown]], complete: r.shown >= r.total } });
    } catch {
      continue; // 文件没了、读不了：不回填
    }
  }
  return out;
}

// 这些消息里带着说明的延迟工具（ToolSearch / 拦截 / 直接执行的结果都在 meta.loadedTools 里记着）
function loadedIn(messages: Msg[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.t !== "tool_result" || !Array.isArray(b.meta?.loadedTools)) continue;
      for (const n of b.meta.loadedTools) if (typeof n === "string") out.add(n);
    }
  }
  return out;
}

// 已加载、说明却不在尾部里的延迟工具：回填一份说明（放不下合计预算就不给，提交时它们回到未加载）
function loadedToolDocs(state: AgentState, messages: Msg[], inTail: Set<string>, budget: number): Restore["tools"] {
  const deferred = state.ctx.deferredTools;
  if (!deferred?.size) return undefined;
  const loaded = new Set([...state.loadedTools, ...loadedIn(messages)]);
  const names = [...deferred.keys()].filter((n) => loaded.has(n) && !inTail.has(n));
  if (!names.length) return undefined;
  const text = docsFor(names, deferred);
  const tokens = Math.ceil(tokensOf(text));
  return tokens <= budget ? { names, text, tokens } : undefined;
}

// 压缩前（摘要请求之前）收集好；tailStart = 尾部在 messages 里从第几条开始（尾部原样留着的不必回填）
export async function gatherRestore(state: AgentState, messages: Msg[], tailStart: number, limit: number): Promise<Restore> {
  const budget = restoreBudget(limit);
  const owner = state.ctx.ownerId;
  const prior = priorRestore(messages);
  const inTail = state.ctx.deferredTools?.size ? loadedIn(messages.slice(tailStart)) : new Set<string>();
  const tools = loadedToolDocs(state, messages, inTail, budget.total);
  return {
    todos: todoText(state),
    plan: planText(state, messages, tailStart, Math.min(PLAN_CAP, budget.perFile), prior.plan),
    jobs: owner ? runningJobsSummary(owner) : "",
    // 待触发的唤醒与后台子 agent 只给主会话（有子 agent 控制口的那一层）：子 agent 自己（含 fork）的 ownerId 也是父会话的，
    // 但那些唤醒不是它约的、它也用不了 ScheduleWakeup，后台子 agent 的通知同样收不到
    wakeups: owner && state.ctx.subAgents ? pendingWakeupsSummary(owner) : "",
    agents: owner && state.ctx.subAgents ? runningAgentsSummary(owner) : "",
    files: await restoreFiles(state, [...editedPaths(messages), ...prior.files], { total: budget.total - (tools?.tokens ?? 0), perFile: budget.perFile }),
    ...(tools ? { tools } : {}),
    loadedInTail: [...inTail],
    editNeedsRead: state.profile.tools.readBeforeEdit === "strict",
    docs: loadedDocSummary(messages.slice(0, tailStart)),
  };
}

export function renderRestore(r: Restore): Msg | null {
  const parts: string[] = [];
  if (r.todos) parts.push(`${TODO_HEADING}\n${r.todos}`);
  if (r.plan) parts.push(`${PLAN_HEADING}\n${r.plan}`);
  // 后台任务与待触发的定时唤醒同一节（都短，始终保留）
  const wakeups = r.wakeups ? `Scheduled wakeups you set (ScheduleWakeup) still pending: ${r.wakeups}. ScheduleWakeup(action:"list") shows them, action "cancel" with an id drops one.` : "";
  if (r.jobs) {
    parts.push(`${JOBS_HEADING}\n${r.jobs}. Bash(wait:"<id>") waits for one to finish; Bash(poll:"<id>") reads its output now.${wakeups ? `\n${wakeups}` : ""}`);
  } else if (wakeups) {
    parts.push(`${WAKEUPS_HEADING}\n${wakeups}`);
  }
  if (r.agents) {
    parts.push(`${AGENTS_HEADING}\n${r.agents}\nEach one's report arrives as a notification when it finishes; Agent(action:"list") shows their status.`);
  }
  if (r.tools?.names.length) {
    parts.push(`${TOOLS_HEADING}\nThese deferred tools were loaded before the compaction; their instructions are repeated here.\n\n${r.tools.text}`);
  }
  if (r.files.length) {
    // 已读状态不落盘：会话重新加载后这句的前半就不成立了，所以写明 Edit 要求先 Read 时照做。
    // 档案不要求 Edit 前先读（lean）时，不说「别的文件改之前都要先 Read」
    parts.push(
      `${FILES_HEADING}\n` +
        "These count as read, so you can usually Edit them without reading them again; if an Edit says you must Read the file " +
        `first (for example after a restart), Read it.${r.editNeedsRead === false ? "" : " Any other file must be Read before you edit it."}\n\n` +
        r.files.map((f) => f.text).join("\n\n"),
    );
  }
  if (r.docs?.length) {
    parts.push(`${LOADED_DOCS_HEADING}\nThe instruction files of these subdirectories were loaded before the compaction; they still apply. Read them again if you need their text.\n${r.docs.join("\n")}`);
  }
  if (!parts.length) return null;
  return {
    role: "user",
    origin: "harness",
    kind: RESTORE_KIND,
    internal: true,
    content: [{ t: "text", text: `${RESTORE_HEAD} Working state as of the compaction, re-attached after the summary above.\n\n${parts.join("\n\n")}` }],
  };
}

// 放不下时裁一步：先丢延迟工具的说明（下次调用会照常附上），再丢最早改的那个文件，文件丢完再丢计划；没得裁了返回 null
//（待办、后台任务与后台子 agent 始终保留）
export function trimRestore(r: Restore): Restore | null {
  if (r.tools) return { ...r, tools: undefined };
  if (r.files.length) return { ...r, files: r.files.slice(0, -1) };
  if (r.plan) return { ...r, plan: "" };
  return null;
}

// 压缩提交时：已读状态只留回填过的文件（按回填的范围）
export function applyRestoredReads(readFileState: Map<string, FileState>, r: Restore | null): void {
  readFileState.clear();
  for (const f of r?.files ?? []) readFileState.set(f.abs, f.read);
}

// 压缩提交时：已加载的延迟工具只留压完的上下文里看得到说明的（尾部里的 + 回填里的）；会话没推迟工具就不动
export function applyRestoredTools(state: AgentState, r: Restore | null): void {
  if (!state.ctx.deferredTools?.size || !r) return;
  state.loadedTools = new Set([...(r.loadedInTail ?? []), ...(r.tools?.names ?? [])]);
}
