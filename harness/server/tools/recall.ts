import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok } from "./types.ts";
import { existsSync } from "node:fs";
import { globalMemoryFor, listMemories, memoryDir, modelFacing, readMemory, type MemoryMeta, type MemoryStatus } from "../memory.ts";
import { externalLine, listExternalNotes } from "../external-memory.ts";
import { noteMemoryUse } from "../memory-usage.ts";
import { searchSessions, sessionInWorkspace, sessionTranscript, searchTerms } from "../session-search.ts";
import { PAST_CONVERSATION_NOTE } from "./untrusted.ts";
import {
  renderSearchResults,
  searchUnifiedKnowledge,
  type KnowledgeKind,
} from "../knowledge-search.ts";

// Recall: read from cross-session memory. Without an id, list every note's
// id/title/summary. With an id, return that note's full body. The memory index
// is also injected into the system prompt at session start, so the model already
// knows what exists — Recall is for pulling the full text of a specific note.

export const recallTool: Tool = {
  effect: "read",
  // Hybrid search updates its local vector cache and aggregate metrics.
  concurrencySafe: false,
  def: {
    name: "Recall",
    description:
      "Recall current project knowledge and durable cross-session memory. With id → read one memory note in full. " +
      "With query → hybrid retrieval: exact path/scope and keywords rank first, embeddings supplement semantic matches, " +
      "and every result explains why it was selected. No id/query → list all memory notes for lifecycle diagnosis. " +
      "Expired, conflicted, stale, proposed, superseded, and user-rejected notes are excluded from search unless includeQuarantined=true. " +
      'layer:"sessions" searches the past conversations of this workspace instead (what the user and you actually said): with query → ' +
      'matching conversations with a snippet; with id "session:<id>" → the text of that conversation (plus query → only the matching parts). ' +
      "Use it to check a note against the conversation it came from (a note's source session is shown when you read it), or to find what was decided before.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Note id to read in full. Omit to list all notes. A global note's id may be written as global:<id>.",
        },
        layer: {
          type: "string",
          enum: ["workspace", "global", "external", "sessions"],
          description:
            "Which memory layer an id / listing refers to: workspace (default); global (notes about the user and this machine, shared by " +
            "every workspace); external (a read-only library other agents keep on this project, when one is mounted — not governed by dimensio); " +
            "sessions (past conversations in this workspace — the raw record notes are written from).",
        },
        query: { type: "string", description: "Task, question, symbol, route, command, or concept to search across memory and generated project knowledge." },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["memory", "profile", "command", "module", "test", "route", "config", "data", "ci", "deploy", "guide", "verification"] },
          description: "Optional exact knowledge-kind filter.",
        },
        scope: { type: "array", items: { type: "string" }, description: "Optional topic/scope filter; applied before ranking." },
        path: { type: "string", description: "Optional workspace-relative path filter; applied before ranking." },
        status: {
          type: "array",
          items: { type: "string", enum: ["active", "proposed", "stale", "superseded", "rejected", "current"] },
          description: "Optional exact lifecycle-status filter.",
        },
        limit: { type: "number", description: "Maximum results, 1-20 (default 8)." },
        semantic: { type: "boolean", description: "Use embedding reranking when configured (default true); deterministic lexical retrieval always remains available." },
        includeQuarantined: { type: "boolean", description: "Include non-active memory notes in query search for diagnosis (default false)." },
      },
    },
  },
  async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolRunResult> {
    let id = args.id ? String(args.id).trim() : "";
    const query = args.query ? String(args.query).trim() : "";
    // K8：外部记忆库（只读、未经治理）——layer:"external"，或者 id 写成 external:<id>
    if (args.layer === "external" || /^(?:memory:)?external:/.test(id)) {
      const extId = id.replace(/^(?:memory:)?external:/, "");
      const notes = listExternalNotes(_ctx.sandbox.root);
      if (!notes.length) return ok("recall external (none)", "No external memory library is mounted for this workspace.");
      if (!extId) {
        return ok(`recall external: ${notes.length} notes`, `External memory library (read-only, NOT governed by dimensio — may be out of date): ${notes.length} notes:\n\n${notes.map(externalLine).join("\n")}`);
      }
      const note = notes.find((n) => n.id === extId.toLowerCase());
      if (!note) return ok(`recall external:${extId} (not found)`, `No external note "${extId}". Recall with layer "external" lists them.`);
      return ok(
        `recalled [external:${note.id}]`,
        `# ${note.title}\n(id: external:${note.id}, type: ${note.type}, source: ${note.source} — EXTERNAL memory, read-only, not governed by dimensio: ` +
          "no expiry, evidence or anchors; it may be out of date, so check it against the files before relying on it)\n" +
          (note.withheld ? "(text withheld: this note matches prompt-injection patterns)" : `${note.description}\n\n${note.body}`),
      );
    }
    // 原始对话层：layer:"sessions"，或者 id 写成 session:<id>
    if (args.layer === "sessions" || /^session:/.test(id)) return recallSessions(id.replace(/^session:/, ""), query, _ctx);
    // K7：全局层——layer:"global"，或者 id 写成 global:<id>（检索结果里就是这样标的）
    let global = args.layer === "global";
    if (/^(?:memory:)?global:/.test(id)) {
      global = true;
      id = id.replace(/^(?:memory:)?global:/, "");
    }
    // 这个会话的全局层（评测隔离开着时按工作区各一份，见 memory.ts globalMemoryFor；正式服就是唯一那份）
    const globalRoot = globalMemoryFor(_ctx.sandbox.root);
    const hasGlobal = existsSync(memoryDir(globalRoot));
    const root = global ? globalRoot : _ctx.sandbox.root;

    if (id) {
      // 工作区里没有这个 id，再看全局层（模型没写前缀也找得到）；全局层还没建就不去碰它
      const local = global ? undefined : readMemory(root, id);
      const fromGlobal = !local && hasGlobal ? readMemory(globalRoot, id) : undefined;
      const mem = local ?? fromGlobal;
      if (!mem) {
        const avail = (global && !hasGlobal ? [] : listMemories(root)).map((m) => m.id).join(", ") || "(none)";
        return ok(`recall ${id} (not found)`, `No memory "${id}". Available ids: ${avail}`);
      }
      noteMemoryUse(fromGlobal ? globalRoot : root, [mem.id]); // K11：全文被拉进对话
      return ok(
        `recalled [${fromGlobal ? "global:" : ""}${mem.id}]`,
        `# ${mem.title}\n` +
          `(id: ${fromGlobal ? "global:" : ""}${mem.id}${fromGlobal ? ", layer: global — applies in every workspace" : ""}, type: ${mem.type}, topic: ${mem.topic}, status: ${mem.status}` +
          `${mem.declaredStatus !== mem.status ? ` [declared ${mem.declaredStatus}]` : ""}, confidence: ${mem.confidence}` +
          `${mem.updated ? `, updated ${mem.updated}` : ""})\n` +
          `${mem.scope.length ? `scope: ${mem.scope.join(", ")}\n` : ""}` +
          `${mem.evidence.length ? `evidence: ${mem.evidence.join(" | ")}\n` : ""}` +
          `${mem.anchors.length ? `anchors: ${mem.anchors.join(", ")}\n` : ""}` +
          `${mem.sourceSession ? `source session: session:${mem.sourceSession} (Recall it with layer "sessions" to check the note against that conversation)\n` : ""}` +
          `${mem.reviewedAt && mem.reviewedAt >= mem.updated && mem.reviewVerdict ? `reviewed ${mem.reviewedAt.slice(0, 10)} against its conversation: ${mem.reviewVerdict}${mem.reviewNote ? ` — ${mem.reviewNote}` : ""}\n` : ""}` +
          `${mem.expiresAt ? `expires: ${mem.expiresAt}\n` : ""}` +
          `${mem.declaredStatus === "rejected" ? `REJECTED by the user${mem.rejectedAt ? ` on ${mem.rejectedAt}` : ""}${mem.rejectReason ? ` — reason: ${mem.rejectReason}` : ""}. Do not rely on or re-save this claim.\n` : ""}` +
          `${mem.issues.length ? `QUALITY WARNINGS: ${mem.issues.join(", ")}\n` : ""}` +
          `${mem.description}\n\n${mem.content}`,
      );
    }

    if (query) {
      const response = await searchUnifiedKnowledge(_ctx.sandbox.root, query, {
        kinds: Array.isArray(args.kinds) ? args.kinds.map(String) as KnowledgeKind[] : undefined,
        scope: Array.isArray(args.scope) ? args.scope.map(String) : undefined,
        path: args.path ? String(args.path) : undefined,
        status: Array.isArray(args.status) ? args.status.map(String) as Array<MemoryStatus | "current"> : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        semantic: typeof args.semantic === "boolean" ? args.semantic : undefined,
        includeQuarantined: args.includeQuarantined === true,
        signal: _ctx.signal,
      });
      return ok(`recall search: ${response.results.length} results (${response.semantic})`, renderSearchResults(response));
    }

    const items = global ? (hasGlobal ? listMemories(globalRoot) : []) : listMemories(_ctx.sandbox.root);
    const globals = !global && hasGlobal ? listMemories(globalRoot) : [];
    // K8：挂着外部库就在末尾提一句（条目本身按 layer:"external" 列）
    const externalCount = global ? 0 : listExternalNotes(_ctx.sandbox.root).length;
    const externalHint = externalCount
      ? `\n\nAn external memory library is also mounted read-only (${externalCount} notes, not governed by dimensio): Recall with layer "external" lists them.`
      : "";
    if (items.length === 0 && globals.length === 0) {
      return ok("recall (empty)", `Your memory is empty. Use Remember to save durable knowledge.${externalHint}`);
    }
    const line = (m: MemoryMeta, prefix = "") =>
      `- [${prefix}${m.id}] (${m.type}; ${m.status}/${m.confidence}; topic=${m.topic}` +
      `${m.issues.length ? `; issues=${m.issues.join("|")}` : ""}) ${m.title} — ${m.description}` +
      `${m.declaredStatus === "rejected" && m.rejectReason ? ` [rejected by the user: ${m.rejectReason}]` : ""}`;
    // K9：命中注入特征的条目只露标题
    const body = items.map(modelFacing).map((m) => line(m, global ? "global:" : "")).join("\n");
    const globalBody = globals.length
      ? `\n\nGlobal notes (about the user and this machine, shared by every workspace):\n${globals.map(modelFacing).map((m) => line(m, "global:")).join("\n")}`
      : "";
    const total = items.length + globals.length;
    return ok(`recall: ${total} notes`, `You have ${items.length} remembered ${global ? "global " : ""}notes${items.length ? ":\n\n" + body : "."}${globalBody}${externalHint}`);
  },
};

// 原始对话（记忆的地基）：只看这个工作区的会话、不含当前这个；给的是对话原文——当数据看，不当指令
const SESSION_TEXT_MAX = 12_000;

async function recallSessions(id: string, query: string, ctx: ToolContext): Promise<ToolRunResult> {
  const root = ctx.sandbox.root;
  if (id) {
    const t = await sessionTranscript(id);
    if (!t || !sessionInWorkspace(t.meta, root)) {
      return ok(`recall session:${id} (not found)`, `No conversation "${id}" in this workspace. Recall with layer "sessions" and a query to find one.`);
    }
    const terms = searchTerms(query).map((w) => w.toLowerCase());
    const all = t.lines.map((l, i) => ({ ...l, i }));
    // 带 query：只给命中的那几条和前后各一条
    const keep = terms.length
      ? new Set(all.filter((l) => terms.some((w) => l.text.toLowerCase().includes(w))).flatMap((l) => [l.i - 1, l.i, l.i + 1]))
      : null;
    let used = 0;
    let cut = false;
    const out: string[] = [];
    for (const l of all) {
      if (keep && !keep.has(l.i)) continue;
      const line = `[${l.role === "user" ? (l.own ? "user" : "user (injected)") : "assistant"}] ${l.text.replace(/\s+/g, " ").trim()}`;
      if (used + line.length > SESSION_TEXT_MAX) {
        cut = true;
        break;
      }
      out.push(line);
      used += line.length;
    }
    const head = `Conversation session:${t.meta.id} "${t.meta.title}" (${new Date(t.meta.updatedAt).toISOString().slice(0, 10)}, ${t.meta.model})`;
    const tail = cut ? `\n… (truncated at ${SESSION_TEXT_MAX} characters — add a query to see only the matching parts)` : "";
    const body = out.length ? out.join("\n") : keep ? "(no message matches that query)" : "(no visible text)";
    return ok(`recalled session:${t.meta.id}`, `${PAST_CONVERSATION_NOTE}\n${head}\n\n${body}${tail}`);
  }
  if (!query) return ok("recall sessions (no query)", 'Give a query to search the past conversations of this workspace, or id "session:<id>" to read one.');
  const found = await searchSessions(query, { limit: 10, filter: (m) => m.id !== ctx.ownerId && sessionInWorkspace(m, root) });
  if (!found.items.length) {
    return ok("recall sessions: 0 results", `No past conversation in this workspace mentions all of: ${searchTerms(query).join(", ")}.`);
  }
  const lines = found.items.map(
    (h) => `- [session:${h.id}] ${h.title} (${new Date(h.updatedAt).toISOString().slice(0, 10)}, ${h.hits} hit${h.hits === 1 ? "" : "s"}): ${h.snippet.before}«${h.snippet.match}»${h.snippet.after}`,
  );
  return ok(
    `recall sessions: ${found.items.length} results`,
    `${PAST_CONVERSATION_NOTE}\nPast conversations in this workspace:\n${lines.join("\n")}\n\nRead one with id "session:<id>" (add the query to see only the matching parts).`,
  );
}
