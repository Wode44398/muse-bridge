// 空闲压缩（对齐 Claude Code 2.1.299）：长对话空闲到提示缓存快过期时先压一次——用户回来接着聊，重写的是压完的那段，
// 不是整段原样（官方 1 小时缓存的写入按 2 倍计价，20 万 token 的对话重写一次就是好几美元）。
// 11-14 起按偏好「提示缓存快过期时」（cacheExpiry）：只有选「自动压缩」才做；缓存多久过期按模型算（适配器的 capabilities.cacheTtlMs，
// 来自 model-knowledge/cache-ttl.mjs 与模型中心里用户填的），不再只认 Anthropic 官方的 1 小时——5 分钟的缓存在 3 分 45 秒左右动手。
// 每轮收尾排一个定时器，用户再发话就撤掉；压的时候不占住会话——这时发话照常开跑，压缩被掐掉、不留痕迹。
import { compactIdleSession, getSession, sessionCacheTtlMs, type Session } from "./session.ts";
import { prefValue } from "./prefs.ts";

const LEAD_MS = 6 * 60_000; // 长缓存：比过期早这么久动手（摘要请求本身要几十秒）
const MIN_TTL_MS = 3 * 60_000; // 缓存短于这个的不做（来不及）

const timers = new Map<string, NodeJS.Timeout>();
const running = new Map<string, AbortController>();
let started = false;

const enabled = () => started && prefValue<string>("cacheExpiry") === "compact";

/** 服务启动时挂上（index.ts）。测试按需调。 */
export function startIdleCompact(): () => void {
  started = true;
  return () => {
    started = false;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const c of running.values()) c.abort();
    running.clear();
  };
}

/** 用户（或任何入口）要开一轮了：撤掉定时器，正在压的掐掉（startRun 里、同步、动消息之前）。 */
export function cancelIdleCompact(sessionId: string): void {
  const t = timers.get(sessionId);
  if (t) {
    clearTimeout(t);
    timers.delete(sessionId);
  }
  const c = running.get(sessionId);
  if (c) {
    c.abort();
    running.delete(sessionId);
  }
}

/** 一轮收尾（executeRun 的 finally）：按这个会话的缓存时长排一次空闲压缩。 */
export function idleCompactRunEnd(session: Session, now = Date.now()): void {
  cancelIdleCompact(session.id);
  if (!enabled()) return;
  const ttl = sessionCacheTtlMs(session);
  if (ttl < MIN_TTL_MS) return;
  const delay = idleDelay(ttl);
  const t = setTimeout(() => {
    timers.delete(session.id);
    void fire(session.id, now);
  }, delay);
  t.unref?.();
  timers.set(session.id, t);
}

// 什么时候动手：长缓存提前 6 分钟；短缓存在过了四分之三时（5 分钟 → 3 分 45 秒，10 分钟 → 7 分 30 秒），给摘要请求留够余量
export const idleDelay = (ttlMs: number): number => Math.max(60_000, Math.max(ttlMs - LEAD_MS, Math.round(ttlMs * 0.75)));

async function fire(sessionId: string, endedAt: number): Promise<void> {
  if (!enabled()) return;
  const live = getSession(sessionId);
  if (live?.running) return;
  const ctrl = new AbortController();
  running.set(sessionId, ctrl);
  const minTokens = Number(prefValue<number>("idleCompactMinTokens")) || 120_000;
  try {
    const r = await compactIdleSession(sessionId, minTokens, ctrl.signal);
    const idleMin = Math.round((Date.now() - endedAt) / 60_000);
    if (r.ok) console.log(`[idle-compact] ${sessionId.slice(0, 8)} idle ${idleMin} min: context ${r.before} → ${r.after} tokens`);
    else if (r.code === "failed") console.log(`[idle-compact] ${sessionId.slice(0, 8)} not compacted: ${r.error}`);
  } catch (e) {
    console.log(`[idle-compact] ${sessionId.slice(0, 8)}: ${(e as Error).message}`);
  } finally {
    if (running.get(sessionId) === ctrl) running.delete(sessionId);
  }
}

// 测试用：立刻触发（跳过定时器）
export function _fireIdleCompact(sessionId: string): Promise<void> {
  return fire(sessionId, Date.now());
}
export const _idleTimers = timers;
