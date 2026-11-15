// 项目对话的工具（project-mode.ts）：项目记忆三件（协调者与讨论串都有）、协调者的只读 Bash，以及协调者工具表怎么裁。
//   · ProjectMemoryRead / Write / Delete：读写这个项目的共享记忆（projectMemoryRoot()/<项目对话>/，MEMORY.md 是索引）。
//     协调者没有写文件工具、讨论串的工作目录也不在记忆目录里，两边都经这三件读写同一份。项目 = projectIdFor(会话)。
//     协调者那份按 read 判（不碰工作区；项目对话的权限档是讨论串的权限，不拦协调者），讨论串那份写 / 删按 write 判（同 Remember）。
//   · 协调者的 Bash：只放行一条只读的 git / gh 查询（readonly-shell.ts 的判法），放行时改写成 git --no-optional-locks、不许挂后台，
//     交给真 Bash 去跑（路径守卫、超时、输出截断都照旧）；拦下的不执行、不弹卡。
//   · coordinatorToolTable：普通会话的工具表 → 协调者的（只读的看 / 查 / 问 / 计划 / 图表 + 会话工具 + 项目记忆 + 只读 Bash）。
import type { Tool, ToolEffect, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { bashTool } from "./bash.ts";
import { READONLY_DENY_HINT, readonlyCommandVerdict } from "./readonly-shell.ts";
import { SHOW_WIDGET, WIDGET_GUIDE } from "./visualize.ts";
import { MEMORY_INDEX, memoryList, memoryRead, memoryWrite, projectIdFor } from "../project-mode.ts";
import { noteListChanged } from "../session.ts";

const text = (summary: string, body: string, outcome?: string): ToolRunResult => ({ ok: true, summary, ...(outcome ? { outcome } : {}), content: [{ t: "text", text: body }] });
const pidOf = (ownerId: string | undefined) => projectIdFor(ownerId);
const NO_PROJECT = "This session does not belong to a project (only a project conversation and its threads have a project memory).";

function memoryReadTool(): Tool {
  return {
    effect: "read",
    concurrencySafe: true,
    def: {
      name: "ProjectMemoryRead",
      description: `Read this project's shared memory (requirements, decisions, the user's standing preferences, pitfalls) that the coordinator and every thread share. Without name: list the notes and return ${MEMORY_INDEX} (the index, one line per note). With name: return that note.`,
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: `A note's file name, e.g. "decisions.md". Omit to list the notes and read ${MEMORY_INDEX}.` } },
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const pid = pidOf(ctx.ownerId);
      if (!pid) return fail("no project", NO_PROJECT);
      const name = String(args.name ?? "").trim();
      if (name) {
        const t = memoryRead(pid, name);
        return t === null ? fail("not found", `The project memory has no note "${name}". Call again without name to list the notes.`) : text(`project memory: ${name}`, t || "(this note is empty)");
      }
      const list = memoryList(pid);
      if (!list.length) return text("project memory: empty", "The project memory is empty so far.", "项目记忆还是空的");
      const idx = memoryRead(pid, MEMORY_INDEX);
      return text(
        "project memory: index",
        `${list.length} note(s): ${list.map((f) => f.name).join(", ")}` + (idx ? `\n\n${MEMORY_INDEX}:\n${idx}` : `\n\nThere is no ${MEMORY_INDEX} index yet — create one when you write a note.`),
        `${list.length} 篇`,
      );
    },
  };
}

function memoryWriteTool(effect: ToolEffect): Tool {
  return {
    effect,
    concurrencySafe: false,
    def: {
      name: "ProjectMemoryWrite",
      description: `Write a note into this project's shared memory (replaces the whole note). Keep each note to one topic and add or update its line in ${MEMORY_INDEX} — "- file.md — one sentence" — in the same turn. Write what stays true for the project (decisions, conventions, the user's standing preferences, pitfalls), not progress logs.`,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `File name ending in .md (letters, digits, . _ -), e.g. "decisions.md" or "${MEMORY_INDEX}".` },
          content: { type: "string", description: "The whole note in markdown." },
        },
        required: ["name", "content"],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const pid = pidOf(ctx.ownerId);
      if (!pid) return fail("no project", NO_PROJECT);
      const name = String(args.name ?? "").trim();
      const r = await memoryWrite(pid, name, String(args.content ?? ""));
      if (!r.ok) return fail("not written", `Not written: ${r.error}`);
      noteListChanged("sessions"); // 项目概览跟着重拉
      return text(`project memory ← ${name}`, `Saved "${name}" in the project memory.` + (name !== MEMORY_INDEX ? ` Keep its line in ${MEMORY_INDEX} up to date.` : ""), `已写入项目记忆「${name}」`);
    },
  };
}

function memoryDeleteTool(effect: ToolEffect): Tool {
  return {
    effect,
    concurrencySafe: false,
    def: {
      name: "ProjectMemoryDelete",
      description: `Delete a note from this project's shared memory (and remove its line from ${MEMORY_INDEX}) when it turned out wrong or no longer applies.`,
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The note to delete." } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const pid = pidOf(ctx.ownerId);
      if (!pid) return fail("no project", NO_PROJECT);
      const name = String(args.name ?? "").trim();
      if (memoryRead(pid, name) === null) return fail("not found", `The project memory has no note "${name}".`);
      const r = await memoryWrite(pid, name, null);
      if (!r.ok) return fail("not deleted", `Not deleted: ${r.error}`);
      noteListChanged("sessions");
      return text(`project memory: deleted ${name}`, `Deleted "${name}".` + (name !== MEMORY_INDEX ? ` Remove its line from ${MEMORY_INDEX} too.` : ""), `已删掉「${name}」`);
    },
  };
}

/** 协调者的三件（都按 read 判）。 */
export const coordinatorMemoryTools = (): Tool[] => [memoryReadTool(), memoryWriteTool("read"), memoryDeleteTool("read")];
/** 讨论串的三件（写 / 删按 write 判，同 Remember）。 */
export const threadMemoryTools = (): Tool[] => [memoryReadTool(), memoryWriteTool("write"), memoryDeleteTool("write")];

// ── 协调者的 Bash ─────────────────────────────────────────────────────────────
const SYNC_TIMEOUT_MS = 120_000;

function verdictOf(args: Record<string, unknown>) {
  return readonlyCommandVerdict(typeof args.command === "string" ? args.command : "");
}

export const coordinatorBashTool: Tool = {
  // 只有判过是只读查询的才会跑：按 read 判，计划 / 只读档也能用；用户写的 deny 规则照样按子命令管它
  effect: "read",
  concurrencySafe: false,
  // 规则按模型写的原命令比（改写只是补了 --no-optional-locks，用户的 Bash(git log:*) 这类规则要照样认得出）
  permissionView(args) {
    const view = bashTool.permissionView?.({ command: String(args.command ?? "") }) ?? null;
    return { ...(view?.subjects ? { subjects: view.subjects } : {}), ...(view?.partial ? { partial: true } : {}), effect: "read" };
  },
  // 拦下的在弹卡之前就回给模型（不执行）；放行的照真 Bash 的规划（路径守卫的否决）
  prepare(args, ctx) {
    const v = verdictOf(args);
    if (!v.ok) return { veto: { summary: "blocked", content: `Not run: ${v.reason}. ${READONLY_DENY_HINT}` } };
    return bashTool.prepare?.({ command: v.command }, ctx) ?? null;
  },
  def: {
    name: "Bash",
    description:
      "Run ONE read-only git or gh query to check a thread's work — git status / log / diff / show / branch / blame / ls-files …, " +
      "git -C <dir> … for another worktree, gh pr view / list / checks / diff, gh run list / view, gh issue view. " +
      "Anything else (tests, builds, writes, commits, pushes, other programs) is refused before it runs; so are pipes, redirects, " +
      "globs, chaining and $ expansion — one simple command per call. Windows paths: forward slashes or single quotes.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "One read-only git / gh command." },
        timeout: { type: "integer", description: `Timeout in ms (default and max ${SYNC_TIMEOUT_MS}).` },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const v = verdictOf(args);
    if (!v.ok) return fail("blocked", `Not run: ${v.reason}. ${READONLY_DENY_HINT}`);
    const asked = Number(args.timeout);
    const timeout = Number.isFinite(asked) && asked > 0 ? Math.min(asked, SYNC_TIMEOUT_MS) : SYNC_TIMEOUT_MS;
    return bashTool.run({ command: v.command, timeout }, ctx);
  },
};

// ── 协调者的工具表 ───────────────────────────────────────────────────────────
// 原样留下的（都只读）；Bash / StartSession 换成协调者版，后面追加停 / 标已解决与项目记忆
const KEEP = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion", "TodoWrite", WIDGET_GUIDE, SHOW_WIDGET, "SendMessage", "ListSessions", "ReadSession"]);

/**
 * 普通会话的工具表 → 协调者的（保持原有先后，换掉的就地换，新增的排在最后）。原表里被禁用的（租户、没 key）不会被补回来。
 * sessionTools = tools/sessions.ts 的 COORDINATOR_SESSION_TOOLS（协调者版 StartSession 在前）：由调用方传进来——本模块要是
 * import 那边，从这里进入的模块图会先撞上 sessions.ts → session.ts → registry.ts 的环。
 */
export function coordinatorToolTable(tools: Map<string, Tool>, sessionTools: readonly Tool[]): Map<string, Tool> {
  const out = new Map<string, Tool>();
  const [startTool, ...manage] = sessionTools;
  for (const [name, tool] of tools) {
    if (name === "Bash") out.set(name, coordinatorBashTool);
    else if (name === "StartSession") out.set(name, startTool);
    else if (KEEP.has(name)) out.set(name, tool);
  }
  if (out.has("StartSession")) for (const t of manage) out.set(t.def.name, t);
  for (const t of coordinatorMemoryTools()) out.set(t.def.name, t);
  return out;
}

/** 协调者工具表里的工具名（测试与说明用）。 */
export const COORDINATOR_KEEP = KEEP;
