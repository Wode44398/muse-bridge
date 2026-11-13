// 给 bridge 插件回报 dimensio 的回合（bridge 插件接口四期：插件用 ctx.events.on('turn.start' | 'turn.end') 订阅，
// 见 bridge 的 src/plugins/events.mjs）。被 bridge 拉起时带 BRIDGE_PLUGIN_API / BRIDGE_PLUGIN_SECRET（同机实例凭据），
// 独立跑的 dimensio 没有就什么都不发。fire-and-forget：3 秒时限、失败只吞掉，绝不拖慢或打断这一轮。
import type { Msg } from "./agent/turn.ts";

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

function channel(): { api: string; secret: string } | null {
  const api = String(process.env.BRIDGE_PLUGIN_API ?? "").trim().replace(/\/+$/, "");
  const secret = String(process.env.BRIDGE_PLUGIN_SECRET ?? "").trim();
  return LOOPBACK.test(api) && secret.length >= 16 ? { api, secret } : null;
}

// 进程内也能订阅同一对回合事件（会话管理：稍后发送的队列在 turn.end 后重放、输入建议与 AI 标题在 turn.end 后生成、
// 归档的会话在 turn.start 时取消归档，见 sessmgmt/）。订阅者同步调用、异常吞掉——绝不拖慢或打断这一轮。
type TurnListener = (event: "turn.start" | "turn.end", payload: Record<string, unknown>) => void;
const turnListeners = new Set<TurnListener>();
export function onTurnEvent(fn: TurnListener): () => void {
  turnListeners.add(fn);
  return () => turnListeners.delete(fn);
}

export function notifyBridge(event: "turn.start" | "turn.end", payload: Record<string, unknown>): void {
  for (const fn of turnListeners) {
    try {
      fn(event, payload);
    } catch (e) {
      console.warn(`[bridge-events] 回合订阅者出错：${(e as Error).message}`);
    }
  }
  const ch = channel();
  if (!ch) return;
  void fetch(ch.api + "/agent/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${ch.secret}`, "Content-Type": "application/json", "X-Bridge-Agent": "dimensio" },
    body: JSON.stringify({ event, payload }),
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

// 经 bridge 的推送渠道提醒用户（bridge 的 /agent/events 事件 notify → runtime/push-notices.mjs notePush：手机 App 的后台服务、
// 插件登记的通知渠道如飞书 / Telegram）。管理员实例按主机身份、成员实例按本人令牌落到各自名下。同样 fire-and-forget。
// 返回是否真的发了（没接 bridge 的独立 dimensio 返回 false）。
export function pushToBridge(payload: { title: string; message: string; sessionId?: string; level?: "info" | "warn" }): boolean {
  const ch = channel();
  if (!ch) return false;
  void fetch(ch.api + "/agent/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${ch.secret}`, "Content-Type": "application/json", "X-Bridge-Agent": "dimensio" },
    body: JSON.stringify({ event: "notify", payload }),
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  return true;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字）` : s);

/** 这一轮最后一条可见回答的文字（从 from 往后找）。 */
export function lastAnswer(messages: Msg[], from: number): string {
  for (let i = messages.length - 1; i >= Math.max(0, from); i--) {
    const m = messages[i];
    if (m.role !== "assistant" || m.internal) continue;
    // 转录里的块是 { t: "text" }（agent/turn.ts 的 Block），不是各家线上格式的 { type: "text" }
    const text = m.content.map((b) => (b && b.t === "text" ? b.text : "")).join("");
    if (text.trim()) return clip(text, 8000);
  }
  return "";
}

export const clipMessage = (s: string) => clip(String(s ?? ""), 4000);
