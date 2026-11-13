// 会话的拉取请求（审阅面板顶上的 PR 卡）：按会话镜像 bridge 的 PR 视图（GET /api/pr，能力位 pr），
// 看得见时定时刷新（间隔用服务端给的 pollMs：平时 30 秒，GitHub 额度紧时放宽）。同 bridge 里 Claude 的 web/src/lib/pr.svelte.js，
// 只是没有总线推送（dimensio 的页面不在 bridge 的总线上）：一轮结束时卡片自己补拉一次。
import { untrack } from "svelte";
import * as api from "./api.ts";
import { app } from "./state.svelte.ts";

export const prSupported = (): boolean => Boolean(app.compat?.caps?.includes("pr"));

export const prState = $state<{ by: Record<string, api.PrView> }>({ by: {} });
// 在途防重入用普通 Set，不进 $state：组件在 $effect 里调 watchPr → loadPr，读到响应式的在途标记会让 effect 依赖它、请求一结束就重跑
const inflight = new Set<string>();

export const prViewOf = (sid: string): api.PrView | null => (sid && prState.by[sid]) || null;

export async function loadPr(sid: string, refresh = false): Promise<void> {
  if (!sid || !prSupported() || (inflight.has(sid) && !refresh)) return;
  inflight.add(sid);
  try {
    prState.by[sid] = await api.prView(sid, refresh);
  } catch (e: any) {
    // 会话还没落盘（新会话第一轮之前）/ 没接上 bridge：先当不可用，隔一会儿再试（见 schedule）
    if (e?.status === 404) prState.by[sid] = { available: false, reason: "not_found" };
  } finally {
    inflight.delete(sid);
  }
}

/** 写操作。返回 { ok } 或 { ok:false, error }（error 是给人看的话，显示时过 tr()）。 */
export async function prAction(sid: string, op: "bind" | "unbind" | "monitor" | "refresh", args: { url?: string; autoFix?: boolean | null } = {}) {
  try {
    const r = await api.prOp(sid, op, args);
    if (r.view) prState.by[sid] = r.view;
    return { ok: true as const, result: r.result };
  } catch (e: any) {
    return { ok: false as const, error: String(e?.body?.error ?? e?.message ?? e), code: String(e?.body?.code ?? "") };
  }
}

// —— 看得见时定时刷新（同一会话共用一个计时器）——
const watchers = new Map<string, { n: number; timer: ReturnType<typeof setTimeout> | 0 }>();
function schedule(sid: string) {
  const w = watchers.get(sid);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  w.timer = 0;
  const v = prViewOf(sid);
  // 没接上 bridge / 成员实例：不再轮询；会话还没落盘拿到的 not_found：45 秒后再试
  if (v && v.available === false && v.reason !== "not_found") return;
  const idle = v && v.available && !(v.prs ?? []).length && !v.git?.github;
  const ms = v && v.available === false ? 45_000 : idle ? 300_000 : Math.max(15_000, v?.pollMs ?? 30_000);
  w.timer = setTimeout(async () => {
    if (!watchers.has(sid)) return;
    if (!document.hidden) await loadPr(sid);
    schedule(sid);
  }, ms);
}
/** 组件里 `$effect(() => watchPr(sid))`：整段 untrack，effect 只依赖调用方读的 sid。 */
export function watchPr(sid: string): () => void {
  if (!sid || !prSupported()) return () => {};
  let w = watchers.get(sid);
  if (!w) {
    w = { n: 0, timer: 0 };
    watchers.set(sid, w);
    void untrack(() => loadPr(sid)).then(() => schedule(sid));
  }
  w.n += 1;
  return () => {
    const cur = watchers.get(sid);
    if (!cur) return;
    cur.n -= 1;
    if (cur.n <= 0) {
      if (cur.timer) clearTimeout(cur.timer);
      watchers.delete(sid);
    }
  };
}
if (typeof document !== "undefined") {
  // 回到前台：立刻补一次
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) for (const sid of watchers.keys()) void loadPr(sid).then(() => schedule(sid));
  });
}
