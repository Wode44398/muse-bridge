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

export function notifyBridge(event: "turn.start" | "turn.end", payload: Record<string, unknown>): void {
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

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字）` : s);

/** 这一轮最后一条可见回答的文字（从 from 往后找）。 */
export function lastAnswer(messages: Msg[], from: number): string {
  for (let i = messages.length - 1; i >= Math.max(0, from); i--) {
    const m = messages[i];
    if (m.role !== "assistant" || m.internal) continue;
    const text = m.content.map((b) => (b && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : "")).join("");
    if (text.trim()) return clip(text, 8000);
  }
  return "";
}

export const clipMessage = (s: string) => clip(String(s ?? ""), 4000);
