import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok, fail } from "./types.ts";
import {
  GLOBAL_MEMORY,
  saveMemory,
  deleteMemory,
  hasMemorySection,
  listMemories,
  memoryIdFor,
  readMemory,
  retireMemory,
  type MemoryConfidence,
  type MemoryMeta,
  type MemoryStatus,
  type MemoryType,
} from "../memory.ts";

// K5（N57）：连续失败计数（按工具上下文，也就是按会话）。连败 3 次就明说别再试——每次失败都多一轮往返，弱模型尤其
// 容易在这里原地打转。成功一次清零。
const failStreak = new WeakMap<ToolContext, number>();
function failed(ctx: ToolContext, title: string, text: string): ToolRunResult {
  const n = (failStreak.get(ctx) ?? 0) + 1;
  failStreak.set(ctx, n);
  const stop = n >= 3
    ? `\n\nThis is failed Remember #${n} in a row: do not retry it again in this turn. Finish the task; if the note matters, tell the user what you wanted to save.`
    : "";
  return fail(title, text + stop);
}

// K4：用户在记忆面板里驳回过的条目，模型改不了、删不掉——那是用户的决定记录。
function rejectedNote(m: MemoryMeta): string {
  const when = m.rejectedAt ? ` on ${m.rejectedAt.slice(0, 10)}` : "";
  return `the user rejected memory [${m.id}]${when}${m.rejectReason ? ` (reason: ${m.rejectReason})` : ""}`;
}

// Remember: save a durable note to cross-session memory. This is the model
// writing knowledge for its FUTURE self — things worth carrying across sessions
// that aren't obvious from the code (decisions, gotchas, user preferences,
// project context). Re-saving with the same title/id updates that note.

// K1（#61）：「verified」不能由模型自证。evidence 里至少要有一项用 `tool:<调用 id>` 点名本会话一次成功的
// 工具调用（服务端查转录核对；记忆与流程类工具不算证据），否则降为 observed + proposed。关于 harness /
// dimensio 自身工具行为的结论，除非用户确认过，一律 proposed——MiMo 就把自己猜错的「Grep 不支持中文
// 文件名」存成了 active + verified，之后每个会话都被它误导。
const NON_EVIDENCE_TOOLS = new Set(["Remember", "Recall", "MemoryAudit", "VerificationAudit", "TodoWrite", "ExitPlanMode"]);
const TOOL_REF_RE = /\btool:([A-Za-z0-9_.:-]+)/g;
const HARNESS_SUBJECT_RE = /\b(?:harness|dimensio)\b|工具限制|工具的?(?:bug|缺陷|限制)/i;

function aboutHarness(title: string, topic: string, description: string): boolean {
  return HARNESS_SUBJECT_RE.test(`${title} ${topic} ${description}`) || /^(?:harness|dimensio|tools?)[.\-_/]/i.test(topic);
}

export const rememberTool: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: {
    name: "Remember",
    description:
      "Save a durable note to your cross-session memory so a FUTURE session can recall it. " +
      "Use for knowledge that is NOT recoverable by reading the code: a decision and its reason, " +
      "a non-obvious gotcha you hit, a user preference, project context/goals. Do NOT store things " +
      "derivable from the current files. Keep each note focused and self-contained. " +
      "Do NOT store: environment-dependent failures or workarounds, claims that a tool or service \"does not work\", " +
      "transient errors that went away, one-off task narration, or a failure you never found a fix for — when a tool " +
      "failed, store only the fix that worked. Write the note as a statement of fact (\"this project builds with JDK 17\"), " +
      "not a command (\"always use JDK 17\"). Observations about tools, the environment or third-party services need expiresAt. " +
      "Give it a stable topic key and one-sentence relevance description. Classify its lifecycle explicitly: " +
      "proposed notes are quarantined from fresh prompts; active notes require user-confirmed or verified evidence. " +
      "For active feedback/project notes pass why and howToApply (or put Why: / How to apply: sections in the content). " +
      "If something only blocks active status, the note is saved as proposed and the result says what to add. " +
      "Never store credentials. A second active note with the same topic must explicitly supersede the old one. " +
      "Saving with an existing title/id overwrites that note (use this to update; fix a wrong note in place rather than adding a correction). " +
      "Set action:\"delete\" with an id to remove a note that is wrong or obsolete.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short, specific title (becomes the note's id if none given).",
        },
        content: {
          type: "string",
          description: "The note body, written as statements of fact. Include WHY, not just WHAT. Markdown is fine.",
        },
        why: {
          type: "string",
          description: "Why this is so (added to the content as a Why: section unless it already has one). Needed for an active project/feedback note.",
        },
        howToApply: {
          type: "string",
          description: "What to do when this comes up (added as a How to apply: section unless present). Needed for an active project/feedback note.",
        },
        description: {
          type: "string",
          description: "One concise sentence explaining when this note is relevant.",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "user=lasting preference; feedback=working guidance; project=goal/decision; reference=external pointer.",
        },
        topic: {
          type: "string",
          description: "Stable lowercase subject key, e.g. android-build.jdk or user.response-language.",
        },
        status: {
          type: "string",
          enum: ["proposed", "active", "superseded", "stale"],
          description: "proposed until confirmed; active only when trustworthy; stale/superseded are not prompt-injected.",
        },
        confidence: {
          type: "string",
          enum: ["user_confirmed", "verified", "observed", "inferred"],
          description:
            "Why this note is trustworthy. verified/observed require evidence; verified also requires verifiedAt AND an " +
            "evidence item citing a successful tool call of THIS session as tool:<call id> (the run whose output proves " +
            "it) — without that the note is saved as observed + proposed. Conclusions about the harness's own tools are " +
            "saved as proposed unless the user confirmed them.",
        },
        scope: {
          type: "array",
          items: { type: "string" },
          description: "Optional modules/areas where the note applies.",
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Commands, user statements, or source references supporting the note. Never include secret values.",
        },
        anchors: {
          type: "array",
          items: { type: "string" },
          description: "Optional workspace-relative files/directories; missing anchors automatically make the note stale.",
        },
        expiresAt: {
          type: "string",
          description: "Optional ISO timestamp after which the note automatically becomes stale.",
        },
        verifiedAt: {
          type: "string",
          description: "ISO timestamp required when confidence=verified.",
        },
        verifiedCommit: {
          type: "string",
          description: "Optional 7-64 hex commit id at which the note was verified.",
        },
        supersedes: {
          type: "string",
          description: "Existing active note id replaced by this active note; topics must match.",
        },
        id: {
          type: "string",
          description: "Optional stable id to update a specific note. Defaults to a slug of the title.",
        },
        action: {
          type: "string",
          enum: ["save", "delete"],
          description: "save (default) or delete.",
        },
        layer: {
          type: "string",
          enum: ["workspace", "global"],
          description:
            "workspace (default) = this project only. global = a fact about the user (who they are, how they like to work) or about " +
            "this machine's environment that holds in EVERY workspace; only type user or reference, no anchors, keep it short. " +
            "A global note always waits as proposed until the user confirms it in the memory panel.",
        },
      },
      // Every field the save path hard-requires is declared here. Leaving them
      // out made the schema lie: the call "validated", then failed at runtime
      // one missing field at a time.
      required: ["title", "content", "description", "type", "topic", "status", "confidence"],
    },
  },
  async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolRunResult> {
    const action = String(args.action ?? "save");
    // K7：全局层（关于用户与这台机器、每个工作区都适用的）；其余照旧是这个工作区的
    const global = args.layer === "global";
    const root = global ? GLOBAL_MEMORY : _ctx.sandbox.root;
    const panel = global ? "记忆面板的「全局」" : "项目记忆";

    // K2（#28）：来源由服务端填——这条路径永远是模型写的；有没有人在场看会话是否有客户端连着。
    const origin = { writer: "model" as const, attended: _ctx.humanAttended?.() };

    if (action === "delete") {
      const id = String(args.id ?? args.title ?? "").trim();
      if (!id) return failed(_ctx, "remember", "delete needs an id (or the title).");
      // 用户确认过、或验证过的条目，模型只能软删（标成 stale，旧版进 .history，用户可以恢复）；
      // 其余的真删，但旧版同样进 .history。
      const existing = readMemory(root, id);
      if (existing?.declaredStatus === "rejected") {
        return failed(_ctx, "remember", `Not deleted: ${rejectedNote(existing)}. It stays as the user's decision record; only the user can remove it, in the memory panel.`);
      }
      if (existing && (existing.confidence === "user_confirmed" || existing.confidence === "verified")) {
        retireMemory(root, id, origin);
        _ctx.noteMemoryChanged?.();
        return ok(
          `retired ${id}`,
          `Memory "${id}" was ${existing.confidence}, so it was retired instead of deleted: marked stale (no longer ` +
            "injected into new sessions, still visible through Recall), previous version kept in history. The user can restore or remove it.",
        );
      }
      const gone = deleteMemory(root, id);
      if (!gone) return failed(_ctx, "remember", `No memory with id "${id}".`);
      failStreak.delete(_ctx);
      _ctx.noteMemoryChanged?.();
      return ok(`forgot ${id}`, `Deleted memory "${id}" (previous version kept in history).`);
    }

    const title = String(args.title ?? "").trim();
    let content = String(args.content ?? "").trim();
    // K5：why / howToApply 是独立参数——正文里还没有同名小节才补进去（写在正文里的照旧认）
    const why = String(args.why ?? "").trim();
    const howToApply = String(args.howToApply ?? "").trim();
    if (content && why && !hasMemorySection(content, "Why")) content += `\n\nWhy: ${why}`;
    if (content && howToApply && !hasMemorySection(content, "How to apply")) content += `\n\nHow to apply: ${howToApply}`;
    const description = String(args.description ?? "").trim();
    const type = String(args.type ?? "") as MemoryType;
    const topic = String(args.topic ?? "").trim();
    let status = String(args.status ?? "") as MemoryStatus;
    let confidence = String(args.confidence ?? "") as MemoryConfidence;
    // No presence/enum checks here on purpose: saveMemory validates the same
    // fields AND the conditional rules (verified needs evidence + verifiedAt,
    // active project/feedback need Why/How to apply) and reports every problem
    // in one message. Duplicating the easy half here would return the easy half
    // first and hide the rest until the next call.

    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.map(String).map((v) => v.trim()).filter(Boolean) : [];

    // K1：没给任何 evidence 时不动它，让 saveMemory 把全部问题一次报出来。
    const evidence = strings(args.evidence);
    const adjusted: string[] = [];
    let verifiedAt = args.verifiedAt ? String(args.verifiedAt) : undefined;
    if (confidence === "verified" && evidence.length) {
      const proven = evidence
        .flatMap((item) => [...item.matchAll(TOOL_REF_RE)].map((m) => m[1]))
        .map((id) => _ctx.lookupToolCall?.(id))
        .some((call) => call && call.ok === true && !NON_EVIDENCE_TOOLS.has(call.name));
      // K5：验证就发生在本会话（刚核对过那次工具调用），没给 verifiedAt 就记成现在，不为它拒绝一次
      if (proven && !verifiedAt) verifiedAt = new Date().toISOString();
      if (!proven) {
        confidence = "observed";
        if (status === "active") status = "proposed";
        adjusted.push(
          "saved as observed + proposed: confidence \"verified\" needs an evidence item citing a successful tool call " +
            "of THIS session as tool:<call id> (e.g. the Bash run whose output proves it)",
        );
      }
    }
    if (status === "active" && confidence !== "user_confirmed" && aboutHarness(title, topic, description)) {
      status = "proposed";
      adjusted.push("saved as proposed: conclusions about the harness's own tools are not auto-activated — the user confirms them");
    }

    // K4：同一个 id 被用户驳回过 → 不许覆盖；同一个 topic 上有被驳回的 → 存照存，结果里提醒别重复那个结论。
    let target: MemoryMeta | undefined;
    try {
      target = title ? readMemory(root, memoryIdFor(title, args.id ? String(args.id) : undefined)) : undefined;
    } catch {
      target = undefined; // id 不合法：交给 saveMemory 报
    }
    if (target?.declaredStatus === "rejected") {
      return failed(
        _ctx,
        "remember",
        `Not saved: ${rejectedNote(target)}. Do not re-save that note. If you have new evidence that it is right after all, ` +
          "tell the user — they can restore it in the memory panel.",
      );
    }
    const rejectedPeers = topic
      ? listMemories(root).filter((m) => m.declaredStatus === "rejected" && m.topic === topic.toLowerCase())
      : [];
    if (rejectedPeers.length) {
      adjusted.push(`${rejectedPeers.map(rejectedNote).join("; ")} on this same topic — make sure this note does not repeat that claim`);
    }

    try {
      const saved = saveMemory(root, {
        title,
        description,
        type,
        topic,
        status,
        confidence,
        content,
        id: args.id ? String(args.id) : undefined,
        scope: strings(args.scope),
        evidence,
        anchors: strings(args.anchors),
        expiresAt: args.expiresAt ? String(args.expiresAt) : undefined,
        verifiedAt,
        verifiedCommit: args.verifiedCommit ? String(args.verifiedCommit) : undefined,
        supersedes: args.supersedes ? String(args.supersedes) : undefined,
        origin,
        lenient: true, // K5：只影响生效资格的问题降级存成 proposed，不整条拒绝
        externalTaint: _ctx.externalContent?.() === true, // K9（X55）
      });
      const { id, created, status: savedStatus } = saved;
      failStreak.delete(_ctx);
      _ctx.noteMemoryChanged?.();
      // K5：没按要求的状态 / 可信度存下时，头一句就说存成了什么，再逐条列出差什么、怎么补（可照抄）
      const shifted = savedStatus !== status || saved.confidence !== confidence;
      const fixes = saved.downgraded.length
        ? ` ${shifted ? `Saved as ${savedStatus} (${saved.confidence}) instead of ${status} (${confidence}). ` : ""}` +
          `To get what you asked for, fix and save again: ${saved.downgraded.map((d, i) => `(${i + 1}) ${d}`).join("; ")}.`
        : "";
      // K9：这类改参数改不掉，只有用户能放行——明说别再存，告诉用户去哪确认
      const held = saved.held.length
        ? ` Held as proposed until the user confirms it: ${saved.held.join("; ")}. Saving it again will not change that — ` +
          `if the note matters, tell the user it is waiting in the memory panel (${panel}).`
        : "";
      return ok(
        `${created ? "saved" : "updated"} memory [${id}]${saved.downgraded.length || saved.held.length ? ` as ${savedStatus}` : ""}`,
        `${created ? "Saved new" : "Updated"} ${savedStatus} memory "${title}" (id: ${id}, topic: ${topic}). ` +
          (savedStatus === "active"
            ? "A future session will see it in the active memory index."
            : "It is quarantined from fresh prompts but remains visible through Recall.") +
          fixes +
          held +
          (adjusted.length ? ` Note: ${adjusted.join("; ")}.` : ""),
      );
    } catch (e) {
      return failed(_ctx, "remember", `Could not save memory: ${(e as Error).message}`);
    }
  },
};
