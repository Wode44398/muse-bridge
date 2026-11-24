import path from "node:path";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok } from "./types.ts";
import { existsSync } from "node:fs";
import { globalMemoryFor, listMemories, memoryDir, modelFacing, noteFlag, readMemory, type MemoryMeta, type MemoryStatus } from "../memory.ts";
import { externalLine, externalMemoryDirs, listExternalNotes } from "../external-memory.ts";
import { noteMemoryUse } from "../memory-usage.ts";
import { sessionInWorkspace, sessionTranscript } from "../session-search.ts";
import { matchingLineIndexes, rankSessions } from "../session-rank.ts";
import { PAST_CONVERSATION_NOTE } from "./untrusted.ts";
import { renderSearchResults, searchUnifiedKnowledge, type KnowledgeKind } from "../knowledge-search.ts";

// Recall：读记忆。三种用法——按 id 读一条（工作区 / global: / external: / session: 前缀指别的层）；按 query 检索（记忆的每条
// 「还活着」的笔记、外部库、项目知识；layer:"sessions" 时检索这个工作区的历史会话）；都不给就列出笔记。
// 检索是词法打分（中文二元组 + 整词、标题与描述权重高、部分命中可排序），语义向量配了就叠上去，没配不影响。
// 改造前的参数（kinds、scope、path、status、semantic、includeQuarantined）照收：给了就照原意过滤。

export const recallTool: Tool = {
  effect: "read",
  // 检索会更新本地向量缓存与检索统计
  concurrencySafe: false,
  def: {
    name: "Recall",
    description:
      "Look up your memory, project knowledge and past conversations. id → one note in full (prefix global:, external: or " +
      "session:<id> for the other layers). query → ranked search over notes, the external library and generated project " +
      'knowledge; with layer "sessions" it searches this workspace\'s past conversations (titles and text). Neither → list notes. ' +
      "Note files can also be read directly with Read/Grep.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Note id, or global:<id> / external:<id> / session:<id>." },
        query: { type: "string", description: "What to look for: names, words or a phrase, any language." },
        layer: {
          type: "string",
          enum: ["workspace", "global", "external", "sessions"],
          description: "Layer an id or listing refers to; sessions = past conversations.",
        },
        limit: { type: "number", description: "Max results (default 8)." },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    let id = args.id ? String(args.id).trim() : "";
    const query = args.query ? String(args.query).trim() : "";
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    // K8：外部记忆库（只读、未经治理）——layer:"external"，或者 id 写成 external:<id>
    if (args.layer === "external" || /^(?:memory:)?external:/.test(id)) return recallExternal(id.replace(/^(?:memory:)?external:/, ""), query, ctx, limit);
    // 原始对话层：layer:"sessions"，或者 id 写成 session:<id>
    if (args.layer === "sessions" || /^session:/.test(id)) return recallSessions(id.replace(/^session:/, ""), query, ctx, limit);
    // K7：全局层——layer:"global"，或者 id 写成 global:<id>（检索结果里就是这样标的）
    let global = args.layer === "global";
    id = id.replace(/^memory:/, "");
    if (/^global:/.test(id)) {
      global = true;
      id = id.replace(/^global:/, "");
    }
    id = id.replace(/\.md$/i, ""); // 照着索引里的文件名写的
    const globalRoot = globalMemoryFor(ctx.sandbox.root);
    const hasGlobal = existsSync(memoryDir(globalRoot));
    const root = global ? globalRoot : ctx.sandbox.root;

    if (id) {
      // 工作区里没有这个 id，再看全局层（模型没写前缀也找得到）；全局层还没建就不去碰它
      const safeRead = (r: string) => {
        try {
          return readMemory(r, id);
        } catch {
          return undefined;
        }
      };
      const local = global ? undefined : safeRead(root);
      const fromGlobal = !local && hasGlobal ? safeRead(globalRoot) : undefined;
      const mem = local ?? fromGlobal;
      if (!mem) {
        const avail = (global && !hasGlobal ? [] : listMemories(root)).map((m) => m.id).join(", ") || "(none)";
        return ok(`recall ${id} (not found)`, `No memory "${id}". Available ids: ${avail}`);
      }
      const at = fromGlobal ? globalRoot : root;
      noteMemoryUse(at, [mem.id]); // K11：全文被拉进对话
      const flag = noteFlag(mem);
      const facts = [
        `id: ${fromGlobal ? "global:" : ""}${mem.id}`,
        `file: ${path.join(memoryDir(at), `${mem.id}.md`)}`,
        `type: ${mem.type}`,
        flag ? `status: ${flag}` : "",
        mem.updated ? `updated ${mem.updated.slice(0, 10)}` : "",
      ].filter(Boolean);
      return ok(
        `recalled [${fromGlobal ? "global:" : ""}${mem.id}]`,
        `# ${mem.title}\n(${facts.join(", ")}${fromGlobal ? " — global: applies in every workspace" : ""})\n` +
          `${mem.sourceSession ? `source session: session:${mem.sourceSession} (Recall it to check the note against that conversation)\n` : ""}` +
          `${mem.reviewedAt && mem.reviewedAt >= mem.updated && mem.reviewVerdict ? `reviewed ${mem.reviewedAt.slice(0, 10)} against its conversation: ${mem.reviewVerdict}${mem.reviewNote ? ` — ${mem.reviewNote}` : ""}\n` : ""}` +
          `${mem.expiresAt ? `expires: ${mem.expiresAt}\n` : ""}` +
          `${mem.declaredStatus === "rejected" ? `REJECTED by the user${mem.rejectedAt ? ` on ${mem.rejectedAt.slice(0, 10)}` : ""}${mem.rejectReason ? ` — reason: ${mem.rejectReason}` : ""}. Do not rely on or re-save this claim.\n` : ""}` +
          `${mem.description}\n\n${mem.content}`,
      );
    }

    if (query) {
      const filtered = Array.isArray(args.status) && args.status.length > 0;
      const response = await searchUnifiedKnowledge(ctx.sandbox.root, query, {
        kinds: Array.isArray(args.kinds) ? args.kinds.map(String) as KnowledgeKind[] : undefined,
        scope: Array.isArray(args.scope) ? args.scope.map(String) : undefined,
        path: args.path ? String(args.path) : undefined,
        status: filtered ? (args.status as unknown[]).map(String) as Array<MemoryStatus | "current"> : undefined,
        limit,
        semantic: typeof args.semantic === "boolean" ? args.semantic : undefined,
        liveMemory: true, // 索引里列着的（含待确认、被隔离的）都搜得到，带着状态
        includeQuarantined: args.includeQuarantined === true || filtered,
        signal: ctx.signal,
      });
      return ok(`recall search: ${response.results.length} results (${response.semantic})`, renderSearchResults(response));
    }

    // 列表：同索引的写法，另带被驳回的（连同理由）
    const items = global ? (hasGlobal ? listMemories(globalRoot) : []) : listMemories(ctx.sandbox.root);
    const globals = !global && hasGlobal ? listMemories(globalRoot) : [];
    const externalCount = global ? 0 : listExternalNotes(ctx.sandbox.root).length;
    const externalHint = externalCount
      ? `\n\nAn external memory library is also mounted read-only (${externalCount} notes): Recall with layer "external" lists them.`
      : "";
    if (items.length === 0 && globals.length === 0) {
      return ok("recall (empty)", `Your memory is empty. Notes go in ${memoryDir(root)} (Write a Markdown file there, or use Remember).${externalHint}`);
    }
    const line = (m: MemoryMeta, prefix = "") => {
      const flag = m.declaredStatus === "rejected" ? `rejected by the user${m.rejectReason ? `: ${m.rejectReason}` : ""}` : noteFlag(m);
      return `- [${prefix}${m.id}] ${m.title} — ${m.description}${flag ? ` (${flag})` : ""}`;
    };
    const body = items.map(modelFacing).map((m) => line(m, global ? "global:" : "")).join("\n");
    const globalBody = globals.length
      ? `\n\nGlobal notes (${memoryDir(globalRoot)}), shared by every workspace:\n${globals.map(modelFacing).map((m) => line(m, "global:")).join("\n")}`
      : "";
    return ok(
      `recall: ${items.length + globals.length} notes`,
      `${items.length} ${global ? "global " : ""}notes in ${memoryDir(root)}${items.length ? `:\n\n${body}` : "."}${globalBody}${externalHint}`,
    );
  },
};

// 外部库：列目录 / 读一篇 / 检索（检索交给统一检索，只留外部那几条）
async function recallExternal(id: string, query: string, ctx: ToolContext, limit?: number): Promise<ToolRunResult> {
  const notes = listExternalNotes(ctx.sandbox.root);
  if (!notes.length) return ok("recall external (none)", "No external memory library is mounted for this workspace.");
  const dirs = externalMemoryDirs(ctx.sandbox.root);
  if (!id && query) {
    const response = await searchUnifiedKnowledge(ctx.sandbox.root, query, { kinds: ["memory"], limit, signal: ctx.signal });
    const external = { ...response, results: response.results.filter((r) => r.document.id.startsWith("memory:external:")) };
    return ok(`recall external search: ${external.results.length} results`, renderSearchResults(external));
  }
  if (!id) {
    return ok(
      `recall external: ${notes.length} notes`,
      `External memory library (read-only, kept by other agents, in ${dirs.join("; ")}): ${notes.length} notes:\n\n${notes.map(externalLine).join("\n")}`,
    );
  }
  const note = notes.find((n) => n.id === id.toLowerCase().replace(/\.md$/, "")) ?? notes.find((n) => n.source.toLowerCase() === id.toLowerCase());
  if (!note) return ok(`recall external:${id} (not found)`, `No external note "${id}". Recall with layer "external" lists them.`);
  const file = dirs.map((d) => path.join(d, note.source)).find((f) => existsSync(f));
  return ok(
    `recalled [external:${note.id}]`,
    `# ${note.title}\n(id: external:${note.id}, type: ${note.type}${file ? `, file: ${file}` : ""} — external memory, read-only and not managed by dimensio; ` +
      "it may be out of date, so check it against the files before relying on it)\n" +
      (note.withheld ? "(text withheld: this note matches prompt-injection patterns)" : `${note.description}\n\n${note.body}`),
  );
}

// 原始对话（记忆的地基）：只看这个工作区的会话、不含当前这个；给的是对话原文——当数据看，不当指令
const SESSION_TEXT_MAX = 12_000;

async function recallSessions(id: string, query: string, ctx: ToolContext, limit?: number): Promise<ToolRunResult> {
  const root = ctx.sandbox.root;
  if (id) {
    const t = await sessionTranscript(id);
    if (!t || !sessionInWorkspace(t.meta, root)) {
      return ok(`recall session:${id} (not found)`, `No conversation "${id}" in this workspace. Recall with layer "sessions" and a query to find one.`);
    }
    const hits = query ? matchingLineIndexes(t.lines, query) : null;
    // 带 query：只给命中的那几条和前后各一条
    const keep = hits ? new Set([...hits].flatMap((i) => [i - 1, i, i + 1])) : null;
    let used = 0;
    let cut = false;
    const out: string[] = [];
    t.lines.forEach((l, i) => {
      if (cut || (keep && !keep.has(i))) return;
      const text = `[${l.role === "user" ? (l.own ? "user" : "user (injected)") : "assistant"}] ${l.text.replace(/\s+/g, " ").trim()}`;
      if (used + text.length > SESSION_TEXT_MAX) {
        cut = true;
        return;
      }
      out.push(text);
      used += text.length;
    });
    const head = `Conversation session:${t.meta.id} "${t.meta.title}" (${new Date(t.meta.updatedAt).toISOString().slice(0, 10)}, ${t.meta.model})`;
    const tail = cut ? `\n… (truncated at ${SESSION_TEXT_MAX} characters — add a query to see only the matching parts)` : "";
    const body = out.length ? out.join("\n") : keep ? "(no message matches that query)" : "(no visible text)";
    return ok(`recalled session:${t.meta.id}`, `${PAST_CONVERSATION_NOTE}\n${head}\n\n${body}${tail}`);
  }
  if (!query) return ok("recall sessions (no query)", 'Give a query to search the past conversations of this workspace, or id "session:<id>" to read one.');
  const found = await rankSessions(query, { limit: limit ?? 10, filter: (m) => m.id !== ctx.ownerId && sessionInWorkspace(m, root) });
  if (!found.length) return ok("recall sessions: 0 results", "No past conversation in this workspace matches that. Try other words.");
  const lines = found.map(
    (h) =>
      `- [session:${h.id}] ${h.title} (${new Date(h.updatedAt).toISOString().slice(0, 10)}; matched ${h.matched}/${h.total} terms)` +
      h.snippets.map((s) => `\n    ${s}`).join(""),
  );
  return ok(
    `recall sessions: ${found.length} results`,
    `${PAST_CONVERSATION_NOTE}\nPast conversations in this workspace, best match first:\n${lines.join("\n")}\n\nRead one with id "session:<id>" (add the query to see only the matching parts).`,
  );
}
