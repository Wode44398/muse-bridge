// Terminal 工具的共享模式：动作转给 bridge 的共享终端（bridge-runtime.ts），与 bridge 工作台的终端面板、Claude 的
// terminal 工具同一个 PTY。权限判定、命令围栏、偏好档、terminal 事件都在 tools/terminal.ts 本地照常做，这里只管转发与装回结果。
// 工作空间一律取会话沙箱的根（ctx.sandbox.root），不让模型指定。
import type { ToolContext, ToolRunResult } from "../types.ts";
import { fail, ok } from "../types.ts";
import { bridgePost, mcpText } from "../../bridge-runtime.ts";

// bridge 终端工具认的参数（src/mcp/terminal-tools.mjs）；别的字段不带过去
const PASS = ["action", "command", "text", "enter", "keys", "repeat", "lines", "screen", "waitSec", "until", "quietSec", "cols", "rows", "release"] as const;

const OUTCOME: Record<string, string> = {
  read: "读了终端",
  status: "看了终端状态",
  run: "在共享终端里跑了命令",
  write: "往终端里输入了文字",
  restart: "重开了终端",
  wait: "等终端安定",
  resize: "调整了终端尺寸",
};

export async function runSharedTerminal(action: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
  const sent: Record<string, unknown> = {};
  for (const k of PASS) if (args[k] !== undefined) sent[k] = args[k];
  // run 最多等 300 秒、wait 最多 600 秒（bridge 那边自己掐），这边多留一分钟给回程
  const waitSec = Number(args.waitSec) || 0;
  const timeoutMs = action === "run" || action === "wait" ? (Math.min(600, Math.max(waitSec, 20)) + 60) * 1000 : 60_000;
  try {
    const j = await bridgePost("/api/internal/agent-term", { ws: ctx.sandbox.root, args: sent }, { timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const text = mcpText(j.content) || "(no output)";
    if (j.isError) return fail(`terminal ${action} failed`, text);
    const outcome = action === "keys" ? `按了 ${String(args.keys ?? "")}` : OUTCOME[action];
    return { ...ok(`terminal ${action}`, text), ...(outcome ? { outcome } : {}) };
  } catch (e) {
    return fail("terminal error", `The shared terminal (in bridge) failed: ${(e as Error).message}`);
  }
}
