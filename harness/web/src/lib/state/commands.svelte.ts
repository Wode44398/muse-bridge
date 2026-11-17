// 斜杠命令（技能清单与内置命令）与目标续跑。
import * as api from "../api.ts";
import { t, tr } from "../i18n.ts";
import type { Builtin } from "../slash.ts";
import { app, toast } from "./core.svelte.ts";
import { compactNow, handoffWithSummary, hygieneAvailable } from "./hygiene.ts";
import { newChat } from "./pool.ts";
import { send } from "./run.ts";

// ── E3（G7）：斜杠命令（/ 面板的技能清单；技能展开在服务端，内置命令见 runBuiltin）─────────────────────
export function commandsAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("commands"));
}
export const slashCommands = $state<{ list: api.CommandList | null; at: number }>({ list: null, at: 0 });
// 打开面板时取（一分钟内不重取；拿不到就只有内置命令）
export async function loadCommands(): Promise<void> {
  if (!commandsAvailable() || Date.now() - slashCommands.at < 60_000) return;
  slashCommands.at = Date.now();
  try {
    slashCommands.list = await api.listCommands();
  } catch {
    slashCommands.at = 0;
  }
}
// 内置命令此刻为什么用不了（面板上灰掉、发送时提示）；能用返回 undefined
export function builtinBlocked(b: Builtin): string | undefined {
  const chat = app.chat;
  if (b.idleOnly && chat.running) return t("这一轮跑完再用");
  if ((b.id === "compact" || b.id === "handoff") && (!hygieneAvailable() || !chat.id)) return chat.id ? t("服务端还不支持") : t("还没有对话");
  if (b.id === "goal" && !goalAvailable()) return t("服务端还不支持");
  return undefined;
}
// 执行内置命令。返回 true = 处理掉了（输入框清空）；false = 没执行（话留在输入框里）
export async function runBuiltin(b: Builtin, args: string): Promise<boolean> {
  const why = builtinBlocked(b);
  if (why) {
    toast(t("/{name}：{why}", { name: b.name, why }));
    return false;
  }
  switch (b.id) {
    case "new":
      newChat();
      return true;
    case "compact":
      void compactNow();
      return true;
    case "handoff":
      void handoffWithSummary();
      return true;
    case "goal": {
      const chat = app.chat;
      if (!chat.goalDraft?.on) toggleGoalDraft();
      // 没写目标：只把目标模式打开，接着在输入框里写
      if (args) void send(args);
      return true;
    }
  }
}

// ── O7（K64）：目标续跑 ──────────────────────────────────────────────────────────────────────
export function goalAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("goal"));
}
// 输入框上的「目标」开关：开着时发出去的那条就是目标
export function toggleGoalDraft(): void {
  const chat = app.chat;
  chat.goalDraft = chat.goalDraft?.on ? { ...chat.goalDraft, on: false } : { on: true, verify: chat.goalDraft?.verify ?? "", maxRounds: chat.goalDraft?.maxRounds ?? 10 };
}
// 状态条上的暂停 / 继续 / 结束
export async function goalControl(action: "pause" | "resume" | "clear"): Promise<void> {
  const chat = app.chat;
  if (!chat.id) return;
  try {
    const r = await api.goalAction(chat.id, action);
    if (app.chat === chat) chat.goal = r.goal ?? null;
    if (action === "resume" && r.goal?.status === "active") toast(t("接着做了"));
  } catch (e: any) {
    toast(t("操作失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}
