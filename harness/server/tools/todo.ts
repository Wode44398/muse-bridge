import type { TodoItem } from "../agent/events.ts";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";

// Weaker (non-Claude) models lean on external todo decomposition even more than
// Claude does, so this pays off across providers. Enforces one in_progress item.
// TodoWrite 的参数 → 待办清单（U9 从转录里重算「那一刻的待办」也用它）
export function parseTodos(args: Record<string, unknown>): TodoItem[] {
  const raw = Array.isArray(args.todos) ? args.todos : [];
  return raw.map((t: any) => ({
    content: String(t?.content ?? ""),
    status: ["pending", "in_progress", "completed"].includes(t?.status) ? t.status : "pending",
  }));
}

export const todoTool: Tool = {
  effect: "read",
  concurrencySafe: false,
  def: {
    name: "TodoWrite",
    description:
      "Track a multi-step task as a checklist. Send the FULL list each call. Keep exactly one " +
      "item in_progress at a time; mark items completed as soon as they are done. Use for any " +
      "task with 3+ steps.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete todo list.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What to do (imperative)." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const items = parseTodos(args);

    const active = items.filter((t) => t.status === "in_progress").length;
    if (active > 1) {
      return fail("too many active", "Only one todo may be in_progress at a time.");
    }

    ctx.setTodos(items);

    const done = items.filter((t) => t.status === "completed").length;
    const rendered = items
      .map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`)
      .join("\n");
    return {
      ok: true,
      summary: `todos: ${done}/${items.length} done`,
      content: [{ t: "text", text: rendered || "(empty todo list)" }],
    };
  },
};
