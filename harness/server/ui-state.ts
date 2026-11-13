// 工作区协同的两块地基（内存态，进程重启即清，不落盘）——对标 bridge 的 src/runtime/ui-state.mjs：
//
// ① 视图快照：前端把「用户此刻在看什么」防抖上报到 POST /api/ui/state——前台会话与工作空间、工作区开没开、
//    开着哪个工具、审阅里展开的文件、浏览器地址；嵌在 bridge 里时再带上宿主（bridge 文件面板 / 预览）的那份。
//    按 clientId 存，多设备同时在线全部保留、按新鲜度排序。Workspace(view) 读它。
// ② 请求-应答：agent 要前端「干一件事并交回结果」（取编辑器里未保存的草稿）时，makeUiRequest 经会话事件流
//    下发 { e:"workspace", op, id }，前端做完 POST /api/ui/answer 回来，挂起的工具调用当场返回。
//    事件会随 runLog 在重连时重放——前端按 id 去重 + 时效窗，这边过期 / 未知 id 的应答直接丢。
import { randomUUID } from "node:crypto";

export const FRESH_MS = 90_000; // 超过 90 秒没上报 = 用户可能已锁屏 / 关页
const MAX_CLIENTS = 8; // 最多留 8 个客户端（防伪造 clientId 撑爆）
const MAX_STATE_CHARS = 16_000;

export interface UiReport {
  clientId: string;
  client: string;
  state: Record<string, unknown>;
  at: number;
  fresh: boolean;
}

const states = new Map<string, { client: string; state: Record<string, unknown>; at: number }>();

export function noteUiState(clientId: string, client: string, state: unknown): void {
  const id = String(clientId || "").slice(0, 64);
  if (!id) return;
  let s = state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : {};
  if (JSON.stringify(s).length > MAX_STATE_CHARS) s = {};
  if (!states.has(id) && states.size >= MAX_CLIENTS) {
    let oldest: string | null = null;
    let at = Infinity;
    for (const [k, v] of states) if (v.at < at) (oldest = k), (at = v.at);
    if (oldest) states.delete(oldest);
  }
  states.set(id, { client: String(client || "web").slice(0, 24), state: s, at: Date.now() });
}

// 全部快照，最新的在前；十倍陈旧的直接清掉。
export function getUiState(): UiReport[] {
  const now = Date.now();
  const out: UiReport[] = [];
  for (const [clientId, v] of states) {
    if (now - v.at > FRESH_MS * 10) {
      states.delete(clientId);
      continue;
    }
    out.push({ clientId, client: v.client, state: v.state, at: v.at, fresh: now - v.at <= FRESH_MS });
  }
  return out.sort((a, b) => b.at - a.at);
}

// ── 请求-应答 ─────────────────────────────────────────────────────────────────

interface Pending {
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  grace: ReturnType<typeof setTimeout> | null;
}
const pending = new Map<string, Pending>();
// 多台设备都收到请求时，没有编辑器的那台会先答「没有」——别让它抢先：失败的应答等一小会儿，期间有成功的就用成功的
const ERROR_GRACE_MS = 1500;

export function makeUiRequest(
  emit: (ev: Record<string, unknown>) => void,
  op: string,
  opts: { timeoutMs?: number; client?: string; payload?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      const p = pending.get(id);
      pending.delete(id);
      if (p?.grace) clearTimeout(p.grace);
      reject(new Error("no answer from the user's app (it may be offline or too old)"));
    }, opts.timeoutMs ?? 15_000);
    pending.set(id, { resolve, reject, timer, grace: null });
    emit({ e: "workspace", op, id, at: Date.now(), ...(opts.client ? { client: opts.client } : {}), ...(opts.payload ?? {}) });
  });
}

// 前端应答落地；false = 过期 / 未知 id（重放的旧事件）。
export function answerUiRequest(id: string, result: unknown): boolean {
  const p = pending.get(id);
  if (!p) return false;
  const r = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  const settle = () => {
    pending.delete(id);
    clearTimeout(p.timer);
    if (p.grace) clearTimeout(p.grace);
    p.resolve(r);
  };
  if (r.error == null) settle();
  else if (!p.grace) p.grace = setTimeout(settle, ERROR_GRACE_MS);
  return true;
}

// 测试用
export function resetUiState(): void {
  states.clear();
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    if (p.grace) clearTimeout(p.grace);
  }
  pending.clear();
}
