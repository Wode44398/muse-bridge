// 运行设置的派生：顶栏右上角那颗按钮（RunButton）和上下文面板里的设置段（RunSettings）共用。
// 运行档位、访问范围、离开模式、目标模式、电脑、本机模型以前是输入框底行的一排胶囊（维护者 11-07 让它们全部离开输入框），
// 现在都住在上下文面板里；按钮上只在非默认时写出摘要（lib/mode-chip.ts 那套规则不变）。
import { accessMode, app, awayMode, goalAvailable, permissionMode, readRoots, type Chat } from "./state.svelte.ts";
import { pendingCards, replyTarget } from "./card-dock.ts";
import { modeChip } from "./mode-chip.ts";

// 目标模式：开着时输入框里这条就是目标。运行中、草稿正在回应一张卡时不给开（与输入框里的判断同一条）
export function goalState(chat: Chat): { ok: boolean; on: boolean } {
  const hasText = Boolean(chat.draft.trim());
  const target = hasText ? replyTarget(chat.draftTarget, chat.dockedCardId, pendingCards(chat.timeline, chat.running)) : null;
  const ok = goalAvailable() && !chat.running && !target;
  return { ok, on: ok && Boolean(chat.goalDraft?.on) };
}

// 按钮上的摘要：只读 / 计划 / 全权、仅工作空间、离开、目标——都是默认时 alt = false，按钮只剩用量环
export function runChip(chat: Chat) {
  const access = accessMode(chat);
  return modeChip({
    mode: permissionMode(chat),
    access,
    roots: access === "workspace" ? readRoots(chat).length : 0,
    away: awayMode(chat),
    goal: goalState(chat).on,
  });
}

// 这一格的服务是不是本机模型（是才有「本机模型」那一行和按钮上的状态点）
export function isLocalProvider(chat: Chat): boolean {
  return (chat.cfg?.provider ?? app.config?.provider) === "local";
}
