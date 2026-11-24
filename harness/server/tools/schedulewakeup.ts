// ScheduleWakeup：模型自己约「稍后再来」（形状贴近 Claude Code 的 ScheduleWakeup：delaySeconds、reason、prompt），另带 list / cancel。
// 这一轮照常结束；到点由 harness 给这个会话开一轮（会话正在跑就在两步之间注入），见 wakeup/scheduler.ts。账本在 wakeup/store.ts。
// 只给主会话：要会话 id（ctx.ownerId），而且得是主会话自己的上下文——子 agent（含 fork，它沿用父会话的工具表）的 ownerId 也是父会话的，
// 可它们的上下文没有 memoryWriter（主会话才挂的那一项，见 tools/types.ts），在这里一律不收。
import { addWakeup, cancelWakeup, describeWakeup, MAX_DELAY_S, MAX_PENDING, MIN_DELAY_S, pendingWakeups } from "../wakeup/store.ts";
import type { Tool, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";

export const SCHEDULE_WAKEUP = "ScheduleWakeup";

const done = (summary: string, outcome: string, text: string): ToolRunResult => ({ ok: true, summary, outcome, content: [{ t: "text", text }] });

export const scheduleWakeupTool: Tool = {
  effect: "read", // 只记一笔；到点那一轮照会话当时的模式与权限办事
  concurrencySafe: false,
  def: {
    name: SCHEDULE_WAKEUP,
    description:
      "Schedule this conversation to resume later: after delaySeconds the harness starts a new turn with your prompt, even if nobody is around. " +
      "Use it to check back on something slow (CI, a deploy, a long job) instead of waiting; this turn ends as usual. " +
      `delaySeconds is ${MIN_DELAY_S} to ${MAX_DELAY_S}. Up to ${MAX_PENDING} can be pending; they survive server restarts, and stopping or ` +
      'deleting the conversation cancels them. action "list" shows the pending ones, "cancel" removes one by id.',
    parameters: {
      type: "object",
      properties: {
        delaySeconds: { type: "integer", description: `Seconds from now (${MIN_DELAY_S}-${MAX_DELAY_S}; values outside are clamped).` },
        reason: { type: "string", description: "One short sentence on what you are waiting for (shown to the user)." },
        prompt: { type: "string", description: "What to do when it fires — written to your future self, with the context you will need." },
        action: { type: "string", enum: ["schedule", "list", "cancel"], description: '"schedule" (default), "list", or "cancel".' },
        id: { type: "string", description: "Wakeup id to cancel." },
      },
    },
  },
  async run(args, ctx) {
    const owner = ctx.ownerId;
    if (!owner || !ctx.memoryWriter) return fail("not available", "Wakeups can only be scheduled from a main conversation.");
    const action = typeof args.action === "string" && args.action ? args.action : "schedule";
    if (action === "list") {
      const list = pendingWakeups(owner);
      return done(
        `${list.length} pending wakeup(s)`,
        list.length ? `有 ${list.length} 个待触发的唤醒` : "没有待触发的唤醒",
        list.length ? `Pending wakeups: ${list.map((w) => describeWakeup(w)).join(", ")}.` : "No wakeups are pending.",
      );
    }
    if (action === "cancel") {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return fail("no id", 'Give the id of the wakeup to cancel (action "list" shows them).');
      const hit = cancelWakeup(owner, id);
      if (!hit) {
        const left = pendingWakeups(owner);
        return fail("no such wakeup", `No pending wakeup ${id}.${left.length ? ` Pending: ${left.map((w) => w.id).join(", ")}.` : " None are pending."}`);
      }
      return done(`cancelled ${hit.id}`, "取消了一个唤醒", `Cancelled ${hit.id}.`);
    }
    if (action !== "schedule") return fail("bad action", 'action is "schedule", "list" or "cancel".');
    if (args.delaySeconds === undefined || args.delaySeconds === null || args.delaySeconds === "") {
      return fail("missing delaySeconds", `Give delaySeconds (${MIN_DELAY_S}-${MAX_DELAY_S}).`);
    }
    const r = addWakeup(owner, { delaySeconds: Number(args.delaySeconds), reason: String(args.reason ?? ""), prompt: String(args.prompt ?? "") });
    if (!r.ok) return fail("not scheduled", `${r.error}.`);
    const w = r.wakeup;
    const at = new Date(w.dueAt);
    const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const note = r.clamped === "min" ? ` (raised to the ${MIN_DELAY_S}s minimum)` : r.clamped === "max" ? ` (capped at the ${MAX_DELAY_S / 3600}h maximum)` : "";
    return done(
      `wakeup ${w.id} at ${clock}`,
      `约了 ${clock} 唤醒`,
      `Scheduled ${w.id} for ${Math.round((w.dueAt - w.createdAt) / 1000)}s from now${note}, around ${clock} server time. You can end this turn; the wakeup starts a new one.`,
    );
  },
};
