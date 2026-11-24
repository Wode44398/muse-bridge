import path from "node:path";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok, fail } from "./types.ts";
import {
  globalMemoryFor,
  saveMemory,
  deleteMemory,
  hasMemorySection,
  listMemories,
  memoryDir,
  memoryIdFor,
  readMemory,
  retireMemory,
  type MemoryConfidence,
  type MemoryMeta,
  type MemoryStatus,
  type MemoryType,
} from "../memory.ts";

// Remember：存 / 改 / 删一条跨会话记忆。一条记忆就是记忆目录里的一个 Markdown 文件，模型也可以直接 Write / Edit 它；
// 这个工具省掉拼 frontmatter，结果里告诉它文件落在哪。必填只有 title 与 content。
// 改造前的参数（why、howToApply、topic、status、confidence、scope、evidence、anchors、expiresAt、verifiedAt、verifiedCommit、
// supersedes）照收不报错，按原来的意思落进 frontmatter；写坏了的可选项丢掉照存（saveMemory 的 lenient）。
// 不再因为缺 why / 证据、可信度不够生效、同 topic 冲突而拒绝或降级——治理放到离线整理（memory-dream.ts）。
// 仍然自动处置的：疑似凭据拒存；命中注入特征、这个会话读过外部内容之后写的，存成 unconfirmed（proposed）等用户确认。

// 连续失败计数（按工具上下文，也就是按会话）：连败 3 次就明说别再试。成功一次清零。
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

// K1（#61）：旧参数里的 confidence "verified" 要在 evidence 里用 tool:<调用 id> 点名本会话一次成功的工具调用，否则记成 observed
//（只改可信度标签，不改生效与否）
const NON_EVIDENCE_TOOLS = new Set(["Remember", "Recall", "MemoryAudit", "VerificationAudit", "TodoWrite", "ExitPlanMode"]);
const TOOL_REF_RE = /\btool:([A-Za-z0-9_.:-]+)/g;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim());
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).map((v) => v.trim()).filter(Boolean) : []);

export const rememberTool: Tool = {
  effect: "write",
  concurrencySafe: false,
  // delete 只要 id，save 才要 title 与 content：必填随动作而变，由工具自己报
  looseRequired: true,
  def: {
    name: "Remember",
    description:
      "Save or update a note in your cross-session memory: a Markdown file in this workspace's memory directory (Write/Edit on it " +
      "works too). One durable fact per note, as a statement; update the existing note (id) instead of adding a near-duplicate. " +
      "Never store credentials. action \"delete\" with an id removes a note.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, specific title." },
        content: { type: "string", description: "The note (Markdown); include the reason when it matters." },
        description: { type: "string", description: "One line: when it is relevant." },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "user: about the user; feedback: how they want work done; project: goals, decisions, context; reference: outside resources.",
        },
        layer: { type: "string", enum: ["workspace", "global"], description: "global: about the user or this machine, true in every workspace." },
        id: { type: "string", description: "Existing note id (file name without .md) to update or delete." },
        action: { type: "string", enum: ["save", "delete"] },
      },
      required: ["title", "content"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const action = str(args.action) || "save";
    // K7：全局层（关于用户与这台机器、每个工作区都适用的）；其余是这个工作区的
    const global = args.layer === "global";
    const root = global ? globalMemoryFor(ctx.sandbox.root) : ctx.sandbox.root;
    const fileOf = (id: string): string => path.join(memoryDir(root), `${id}.md`);

    // K2（#28）：来源由服务端填——这条路径永远是模型写的；有没有人在场看会话是否在离开模式
    const origin = { writer: "model" as const, attended: ctx.humanAttended?.() };

    if (action === "delete") {
      const id = (str(args.id) || str(args.title)).replace(/\.md$/i, "");
      if (!id) return failed(ctx, "remember", "delete needs an id.");
      let existing: MemoryMeta | undefined;
      try {
        existing = readMemory(root, id);
      } catch {
        existing = undefined;
      }
      if (existing?.declaredStatus === "rejected") {
        return failed(ctx, "remember", `Not deleted: ${rejectedNote(existing)}. It stays as the user's decision record; only the user can remove it, in the memory panel.`);
      }
      // 用户确认过、或验证过的条目，模型只能软删（标成 stale，旧版进 .history，用户可以恢复）；其余的真删，旧版同样进 .history
      if (existing && (existing.confidence === "user_confirmed" || existing.confidence === "verified")) {
        retireMemory(root, existing.id, origin);
        failStreak.delete(ctx);
        ctx.noteMemoryChanged?.();
        return ok(
          `retired ${existing.id}`,
          `Memory "${existing.id}" was ${existing.confidence === "verified" ? "verified" : "confirmed by the user"}, so it was retired instead of deleted: ` +
            "marked stale (shown as retired in the index), previous version kept in history. The user can restore or remove it.",
        );
      }
      let gone = false;
      try {
        gone = deleteMemory(root, id);
      } catch {
        gone = false;
      }
      if (!gone) return failed(ctx, "remember", `No memory with id "${id}".`);
      failStreak.delete(ctx);
      ctx.noteMemoryChanged?.();
      return ok(`forgot ${id}`, `Deleted memory "${id}" (previous version kept in history).`);
    }

    const title = str(args.title);
    let content = str(args.content);
    // 旧参数 why / howToApply：正文里还没有同名小节才补进去
    const why = str(args.why);
    const howToApply = str(args.howToApply);
    if (content && why && !hasMemorySection(content, "Why")) content += `\n\nWhy: ${why}`;
    if (content && howToApply && !hasMemorySection(content, "How to apply")) content += `\n\nHow to apply: ${howToApply}`;
    const topic = str(args.topic);
    const status = (str(args.status) || undefined) as MemoryStatus | undefined;
    let confidence = (str(args.confidence) || undefined) as MemoryConfidence | undefined;
    const evidence = strings(args.evidence);
    let verifiedAt = str(args.verifiedAt) || undefined;
    const adjusted: string[] = [];
    if (confidence === "verified") {
      const proven = evidence
        .flatMap((item) => [...item.matchAll(TOOL_REF_RE)].map((m) => m[1]))
        .map((id) => ctx.lookupToolCall?.(id))
        .some((call) => call && call.ok === true && !NON_EVIDENCE_TOOLS.has(call.name));
      if (proven) verifiedAt ??= new Date().toISOString();
      else {
        confidence = "observed";
        adjusted.push('confidence recorded as "observed": "verified" needs an evidence item citing a successful tool call of this session as tool:<call id>');
      }
    }

    // K4：同一个 id 被用户驳回过 → 不许覆盖；同一个 topic 上有被驳回的 → 存照存，结果里提醒别重复那个结论
    let target: MemoryMeta | undefined;
    try {
      target = title ? readMemory(root, memoryIdFor(title, str(args.id) || undefined, root)) : undefined;
    } catch {
      target = undefined; // id 不合法：交给 saveMemory 报
    }
    if (target?.declaredStatus === "rejected") {
      return failed(
        ctx,
        "remember",
        `Not saved: ${rejectedNote(target)}. Do not re-save that note. If you have new evidence that it is right after all, tell the user — they can restore it in the memory panel.`,
      );
    }
    const rejectedPeers = topic ? listMemories(root).filter((m) => m.declaredStatus === "rejected" && m.topic === topic.toLowerCase()) : [];
    if (rejectedPeers.length) adjusted.push(`${rejectedPeers.map(rejectedNote).join("; ")} on this same topic — make sure this note does not repeat that claim`);

    try {
      const saved = saveMemory(root, {
        title,
        content,
        description: str(args.description) || undefined,
        type: (str(args.type) || undefined) as MemoryType | undefined,
        topic: topic || undefined,
        status,
        confidence,
        id: str(args.id) || undefined,
        scope: strings(args.scope),
        evidence,
        anchors: strings(args.anchors),
        expiresAt: str(args.expiresAt) || undefined,
        verifiedAt,
        verifiedCommit: str(args.verifiedCommit) || undefined,
        supersedes: str(args.supersedes) || undefined,
        origin,
        lenient: true,
        externalTaint: ctx.externalContent?.() === true, // K9（X55）
        sourceSession: ctx.ownerId, // 离线整理据它回看写这条时的原始对话
      });
      failStreak.delete(ctx);
      ctx.noteMemoryChanged?.();
      const where = fileOf(saved.id);
      const state =
        saved.status === "active"
          ? ""
          : saved.held.length
            ? ` Saved as unconfirmed until the user confirms it in the memory panel: ${saved.held.join("; ")}. Saving it again will not change that.`
            : ` Saved as ${saved.status === "proposed" ? "unconfirmed" : saved.status}.`;
      const notes = [...saved.downgraded, ...adjusted];
      return ok(
        `${saved.created ? "saved" : "updated"} memory [${saved.id}]${saved.status === "active" ? "" : ` as ${saved.status}`}`,
        `${saved.created ? "Saved" : "Updated"} memory "${saved.title}" (id: ${saved.id}${global ? ", global" : ""}) in ${where}.${state}` +
          (notes.length ? ` Note: ${notes.join("; ")}.` : ""),
      );
    } catch (e) {
      return failed(ctx, "remember", `Could not save memory: ${(e as Error).message}`);
    }
  },
};
