// 稍后发送（与 Claude 分页 / 官方 Desktop 的 Ctrl+Enter 同语义）：运行中把一句话排进这个会话的队列，不交给正在跑的这一轮；
// 这一轮从任何出口收尾（做完、停止、报错）后，队列里的话合并成一条，作为下一轮发出。
//   · 只在运行中排得进（没在跑就该直接发：回 not_running，界面改走普通发送）；
//   · 撤回 / 改（拿回输入框）/ 立即发送（从队列取出、改成插话，这一轮下一步就读到）/ 全部清除；
//   · 队列落盘（服务重启不丢）：重启后没有续跑接上的会话，等一会儿照样发出；
//   · 每次变化经全局事件 queue 广播（各设备的队列条同步）。
// 收尾到重放之间不留空档给别的东西插队：turn.end 一到就排一拍（比目标续跑的下一轮早），撞上已经在跑（别的设备先发了、
// 续跑先起了）就留着，等下一次收尾。
import { randomUUID } from "node:crypto";
import { emitGlobal, getOrLoadSession, getSession, startRun, steerSession, type Session } from "../session.ts";
import { getQueue, setQueue, allQueues, type QueuedMessage } from "./store.ts";

export const QUEUE_MAX = 20;
export const QUEUE_TEXT_MAX = 20_000;
const ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

function broadcast(sessionId: string): void {
  emitGlobal({ e: "queue", id: sessionId, items: getQueue(sessionId), at: Date.now() });
}

export function listQueue(sessionId: string): QueuedMessage[] {
  return getQueue(sessionId);
}

export type QueueAddResult = { ok: true; item: QueuedMessage; items: QueuedMessage[] } | { ok: false; error: "empty" | "not_running" | "full" };

export function enqueue(session: Session, raw: unknown, clientId?: unknown): QueueAddResult {
  const text = String(raw ?? "").trim().slice(0, QUEUE_TEXT_MAX);
  if (!text) return { ok: false, error: "empty" };
  if (!session.running) return { ok: false, error: "not_running" };
  const items = getQueue(session.id);
  if (items.length >= QUEUE_MAX) return { ok: false, error: "full" };
  const id = typeof clientId === "string" && ID_RE.test(clientId) && !items.some((x) => x.id === clientId) ? clientId : randomUUID();
  const item: QueuedMessage = { id, text, at: Date.now() };
  setQueue(session.id, [...items, item]);
  broadcast(session.id);
  return { ok: true, item, items: getQueue(session.id) };
}

// 拿出一条（撤回 / 拿回去改）：返回它的原文
export function dequeue(sessionId: string, id: string): QueuedMessage | null {
  const items = getQueue(sessionId);
  const hit = items.find((x) => x.id === id);
  if (!hit) return null;
  setQueue(sessionId, items.filter((x) => x.id !== id));
  broadcast(sessionId);
  return hit;
}

export function clearQueue(sessionId: string): number {
  const n = getQueue(sessionId).length;
  if (!n) return 0;
  setQueue(sessionId, []);
  broadcast(sessionId);
  return n;
}

// 立即发送：从队列取出、改成插话（这一轮还在跑）；这一轮刚好收了，就照普通的一轮发出
export function promote(session: Session, id: string): { ok: boolean; how?: "steer" | "run"; error?: string } {
  const hit = getQueue(session.id).find((x) => x.id === id);
  if (!hit) return { ok: false, error: "gone" };
  if (session.running) {
    const r = steerSession(session, hit.text);
    if (!r.ok) return { ok: false, error: r.error };
    dequeue(session.id, id);
    return { ok: true, how: "steer" };
  }
  dequeue(session.id, id);
  const run = startRun(session, hit.text);
  if (!run.started) {
    // 没起来（服务要重启、正在回滚）：放回队首
    setQueue(session.id, [hit, ...getQueue(session.id)]);
    broadcast(session.id);
    return { ok: false, error: "busy" };
  }
  return { ok: true, how: "run" };
}

export function mergeQueued(items: QueuedMessage[]): string {
  return items.map((x) => x.text).join("\n\n");
}

// 收尾后重放：整队合并成一条起下一轮。起不来（在跑、退役、回滚）就原样留着。
export function drain(session: Session): boolean {
  const items = getQueue(session.id);
  if (!items.length || session.running || session.discarded) return false;
  const run = startRun(session, mergeQueued(items));
  if (!run.started) return false;
  setQueue(session.id, []);
  broadcast(session.id);
  return true;
}

// turn.end 之后排一拍再重放（收尾的同步部分走完；目标续跑在收尾的最后才排，这里先到）
export function scheduleDrain(sessionId: string): void {
  if (!getQueue(sessionId).length) return;
  setTimeout(() => {
    const s = getSession(sessionId);
    if (s) drain(s);
  }, 0);
}

// 启动时：上次留下的队列，等续跑（服务重启后自动续跑那一轮）先起，之后还空闲的会话照样发出
export function drainLeftoversLater(delayMs = 8_000): void {
  const ids = Object.keys(allQueues());
  if (!ids.length) return;
  const t = setTimeout(() => {
    for (const id of ids) {
      void getOrLoadSession(id).then(
        (s) => {
          if (s && !s.running) drain(s);
        },
        (e) => console.warn(`[sessmgmt] 启动时重放队列：会话 ${id} 读不回来（${(e as Error).message}）`),
      );
    }
  }, delayMs);
  t.unref?.();
}
