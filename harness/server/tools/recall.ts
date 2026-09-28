import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok } from "./types.ts";
import { existsSync } from "node:fs";
import { GLOBAL_MEMORY, listMemories, memoryDir, modelFacing, readMemory, type MemoryMeta, type MemoryStatus } from "../memory.ts";
import { externalLine, listExternalNotes } from "../external-memory.ts";
import { noteMemoryUse } from "../memory-usage.ts";
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
      "Expired, conflicted, stale, proposed, superseded, and user-rejected notes are excluded from search unless includeQuarantined=true.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Note id to read in full. Omit to list all notes. A global note's id may be written as global:<id>.",
        },
        layer: {
          type: "string",
          enum: ["workspace", "global", "external"],
          description:
            "Which memory layer an id / listing refers to: workspace (default); global (notes about the user and this machine, shared by " +
            "every workspace); external (a read-only library other agents keep on this project, when one is mounted — not governed by dimensio).",
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
    // K7：全局层——layer:"global"，或者 id 写成 global:<id>（检索结果里就是这样标的）
    let global = args.layer === "global";
    if (/^(?:memory:)?global:/.test(id)) {
      global = true;
      id = id.replace(/^(?:memory:)?global:/, "");
    }
    const hasGlobal = existsSync(memoryDir(GLOBAL_MEMORY));
    const root = global ? GLOBAL_MEMORY : _ctx.sandbox.root;

    if (id) {
      // 工作区里没有这个 id，再看全局层（模型没写前缀也找得到）；全局层还没建就不去碰它
      const local = global ? undefined : readMemory(root, id);
      const fromGlobal = !local && hasGlobal ? readMemory(GLOBAL_MEMORY, id) : undefined;
      const mem = local ?? fromGlobal;
      if (!mem) {
        const avail = (global && !hasGlobal ? [] : listMemories(root)).map((m) => m.id).join(", ") || "(none)";
        return ok(`recall ${id} (not found)`, `No memory "${id}". Available ids: ${avail}`);
      }
      noteMemoryUse(fromGlobal ? GLOBAL_MEMORY : root, [mem.id]); // K11：全文被拉进对话
      return ok(
        `recalled [${fromGlobal ? "global:" : ""}${mem.id}]`,
        `# ${mem.title}\n` +
          `(id: ${fromGlobal ? "global:" : ""}${mem.id}${fromGlobal ? ", layer: global — applies in every workspace" : ""}, type: ${mem.type}, topic: ${mem.topic}, status: ${mem.status}` +
          `${mem.declaredStatus !== mem.status ? ` [declared ${mem.declaredStatus}]` : ""}, confidence: ${mem.confidence}` +
          `${mem.updated ? `, updated ${mem.updated}` : ""})\n` +
          `${mem.scope.length ? `scope: ${mem.scope.join(", ")}\n` : ""}` +
          `${mem.evidence.length ? `evidence: ${mem.evidence.join(" | ")}\n` : ""}` +
          `${mem.anchors.length ? `anchors: ${mem.anchors.join(", ")}\n` : ""}` +
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

    const items = global ? (hasGlobal ? listMemories(GLOBAL_MEMORY) : []) : listMemories(_ctx.sandbox.root);
    const globals = !global && hasGlobal ? listMemories(GLOBAL_MEMORY) : [];
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
