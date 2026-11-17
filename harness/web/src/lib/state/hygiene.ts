// 上下文卫生：立即压缩、带摘要开新会话、计划转新会话实施、缓存变冷提示。
import * as api from "../api.ts";
import { t, tr } from "../i18n.ts";
import { haptic } from "../touch.ts";
import type { PlanItem } from "../timeline-types.ts";
import type { Chat } from "./chat.svelte.ts";
import { app, toast } from "./core.svelte.ts";
import { refreshSessions } from "./lists.ts";
import { evictChat, openSession } from "./pool.ts";

// ── C8：上下文卫生（立即压缩 / 带摘要开新会话 / 计划转新会话实施 / 缓存变冷提示）──────────────────
export function hygieneAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("hygiene"));
}

// 前缀缓存多久变冷：服务端随 context 事件给（ctx.cacheTtlMs，按模型算、模型中心可改；0 = 没有会过期的缓存）。
// 老服务端没给时按厂商默认兜底。本机 llama.cpp 与 DeepSeek（硬盘缓存）留得久，不提示；没列的按 5 分钟
const CACHE_TTL_MIN: Record<string, number | null> = { anthropic: 5, openai: 5, gemini: 5, kimi: 5, zhipu: 5, deepseek: null, local: null };

// 这段对话上一次跟模型打交道是什么时候（本机时钟优先；刚打开的老会话退回用列表里的 updatedAt）
function lastActivityAt(c: Chat): number {
  const meta = c.id ? app.sessions.find((s) => s.id === c.id) : undefined;
  return Math.max(c.lastRunEndAt || 0, meta?.updatedAt || 0);
}

// 偏好「提示缓存快过期时」（off 不提示 / hint 只提示 / compact 自动压缩，后两档都提示）：随 /api/config 下发；老服务端没有 = 提示
export function cacheExpiryMode(): string {
  const m = (app.config as any)?.cacheExpiry;
  return m === "off" || m === "hint" || m === "compact" ? m : "hint";
}

// 前缀缓存大概已经冷了：返回冷了几分钟；还热 / 不适用（没会话、在跑、没有会过期的缓存、设置成不提示……）返回 null。c：分屏时是哪一格的会话
export function cacheColdMinutes(now: number, c: Chat = app.chat): number | null {
  if (!c.id || c.running || !c.ctx.used || cacheExpiryMode() === "off") return null;
  let ttl: number | null;
  if (typeof c.ctx.cacheTtlMs === "number") ttl = c.ctx.cacheTtlMs > 0 ? c.ctx.cacheTtlMs / 60_000 : null;
  else {
    const provider = String(c.cfg?.provider ?? app.config?.provider ?? "");
    ttl = provider in CACHE_TTL_MIN ? CACHE_TTL_MIN[provider] : 5;
  }
  if (ttl == null) return null;
  const last = lastActivityAt(c);
  if (!last) return null;
  const minutes = Math.floor((now - last) / 60_000);
  return minutes >= ttl ? minutes : null;
}

// 回前台时顺手拿一次偏好（在 bridge 设置页改了「提示缓存快过期时」，切回来就生效）
async function refreshCacheExpiry() {
  try {
    const cfg: any = await api.getConfig();
    if (app.config && cfg && typeof cfg.cacheExpiry === "string" && (app.config as any).cacheExpiry !== cfg.cacheExpiry) app.config = { ...app.config, cacheExpiry: cfg.cacheExpiry } as any;
  } catch { /* 下次再说 */ }
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshCacheExpiry(); });

const kTok = (n?: number) => (n ? `${(n / 1000).toFixed(1)}k` : "?");

export async function compactNow(): Promise<boolean> {
  const sid = app.chat.id;
  if (!sid) return false;
  if (app.chat.running) {
    toast(t("这一轮跑完再压缩"));
    return false;
  }
  const r = await api.compactSessionNow(sid);
  if (!r.ok) {
    toast(r.code === "empty" ? t("对话还短，没什么可压的") : r.code === "running" ? t("这一轮跑完再压缩") : t("压缩没成：{reason}", { reason: tr(r.error ?? "") }));
    return false;
  }
  evictChat(sid);
  await openSession(sid);
  toast(t("压缩好了：上下文约 {a} → {b} token", { a: kTok(r.before), b: kTok(r.after) }));
  return true;
}

export async function handoffWithSummary(): Promise<boolean> {
  const sid = app.chat.id;
  if (!sid) return false;
  if (app.chat.running) {
    toast(t("这一轮跑完再开新会话"));
    return false;
  }
  const r = await api.handoffWithSummary(sid);
  if (!r.ok || !r.sessionId) {
    toast(r.code === "empty" ? t("对话里还没有内容") : t("没开成：{reason}", { reason: tr(r.error ?? "") }));
    return false;
  }
  await openSession(r.sessionId);
  if (app.features.sessions) void refreshSessions();
  toast(t("已带着摘要开了新会话，原会话还在列表里"));
  return true;
}

// 计划卡「在新会话中实施」：原会话这份计划落定为「转到新会话」，新会话以自主档起跑、首条消息就是计划
export async function handoffPlan(item: PlanItem): Promise<void> {
  const chat = app.chat;
  const sid = chat.id;
  if (!sid || item.decided) return;
  haptic("medium");
  const r = await api.handoffPlan(sid, item.id);
  if (!r.ok || !r.sessionId) {
    toast(r.code === "not_found" ? t("这份计划已经不等审批了（超时或这一轮已结束）") : t("没转成：{reason}", { reason: tr(r.error ?? "") }));
    return;
  }
  item.decided = "handoff";
  await openSession(r.sessionId);
  if (app.features.sessions) void refreshSessions();
}
