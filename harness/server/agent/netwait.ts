// R3（#39）：连接失败分账。
//
// 以前「连接都没建立」（出口断开、Clash 抖动、DNS 暂时解析不了）与「流到一半断」共用每步 4 次尝试、
// 0.5→1→2s 的退避：出口断开 3.5 秒以上整轮就失败，Workflow 里在飞的 agent 同时死掉。而 net-proxy 的自愈
// 周期是 60 秒，两个时间尺度对不上。现在零字节的连接失败另记一本账：不消耗尝试次数，按 5s 起翻倍、每次
// 最多 60s 一直等到网络回来（总上限默认 30 分钟，并跟随 run 的 deadline），首次命中顺手让 net-proxy 立刻
// 重探。本机模型另算：llama-server 没启动就立刻明说，不干等；加载中（端口还没绑上 / 503）等到就绪，
// 上限 180 秒。已经收到字节之后的中断仍走原来的计数重试。

import { localAiStatus } from "../localai.ts";

export type WaitKind = "network" | "local_model";
export type LocalModelState = "off" | "starting" | "on";

const envMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
// 读取推迟到用时：测试进程可以在 import 之后再调小。
const netWaitCapMs = () => envMs("DIMENSIO_NET_WAIT_MS", 30 * 60_000);
const netWaitBaseMs = () => envMs("DIMENSIO_NET_WAIT_BASE_MS", 5_000);
const localLoadCapMs = () => envMs("DIMENSIO_LOCAL_LOAD_WAIT_MS", 180_000);
const localWaitBaseMs = () => envMs("DIMENSIO_LOCAL_WAIT_BASE_MS", 2_000);
const NET_WAIT_STEP_CAP_MS = 60_000;
const LOCAL_WAIT_STEP_CAP_MS = 10_000;

const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// undici 的形态：fetch() 本身被拒 = TypeError('fetch failed')，系统错误码在 cause 上。读响应体时断掉是
// TypeError('terminated')，那时已经有字节，不归这里。
export function isConnectFailure(e: unknown): boolean {
  if (!(e instanceof TypeError) || e.message !== "fetch failed") return false;
  const cause = (e as { cause?: unknown }).cause as { code?: unknown; message?: unknown; errors?: unknown } | undefined;
  if (!cause || typeof cause !== "object") return false;
  if (typeof cause.code === "string" && CONNECT_CODES.has(cause.code)) return true;
  // 走代理时 CONNECT 被拒（Clash 在、节点全挂）
  if (typeof cause.message === "string" && /Proxy response \(\d+\) !== 200/.test(cause.message)) return true;
  // 双栈并发连接（autoSelectFamily）全失败时是 AggregateError
  return Array.isArray(cause.errors) && cause.errors.length > 0 &&
    cause.errors.every((x) => CONNECT_CODES.has(String((x as { code?: unknown })?.code ?? "")));
}

// 本机 llama-server 加载期 /v1/chat/completions 回 503（「Loading model」）。
export const isLocalLoadingError = (kind: string): boolean => kind === "http_503";

let localModelProbe: () => Promise<LocalModelState> = async () => (await localAiStatus()).state;
// 测试用：本机没有 llama-server 也能模拟「没启动 / 加载中」。
export function setLocalModelProbe(probe: () => Promise<LocalModelState>): void {
  localModelProbe = probe;
}

export interface NetWait {
  kind: WaitKind;
  since: number;
  waits: number;
}

export type WaitPlan =
  | { wait: true; kind: WaitKind; delayMs: number; waitedMs: number; state: NetWait }
  | { wait: false; message: string };

// 下一次等多久；到上限（或本机模型根本没启动）就给出失败说明。deadlineAt 是 run 预算的截止时刻。
export async function planWait(
  local: boolean,
  prev: NetWait | null,
  deadlineAt: number | null,
  lastError: string,
): Promise<WaitPlan> {
  let kind: WaitKind = "network";
  if (local) {
    const st = await localModelProbe().catch((): LocalModelState => "starting");
    if (st === "off") {
      return { wait: false, message: "本机模型没有启动（llama-server 不在运行）：在输入框的「本机」胶囊里启动它，或换一个模型" };
    }
    kind = "local_model";
  }
  const now = Date.now();
  const state: NetWait = prev && prev.kind === kind ? prev : { kind, since: now, waits: 0 };
  const waitedMs = now - state.since;
  let cap = kind === "local_model" ? localLoadCapMs() : netWaitCapMs();
  if (deadlineAt !== null) cap = Math.min(cap, deadlineAt - state.since);
  const left = cap - waitedMs;
  if (left <= 0) {
    const mins = Math.max(1, Math.round(waitedMs / 60_000));
    return {
      wait: false,
      message: kind === "local_model"
        ? `本机模型 ${Math.round(waitedMs / 1000)} 秒还没加载好（${lastError}）`
        : `网络 ${mins} 分钟未恢复（最后一次：${lastError}）`,
    };
  }
  const step = kind === "local_model"
    ? Math.min(localWaitBaseMs() * 2 ** state.waits, LOCAL_WAIT_STEP_CAP_MS)
    : Math.min(netWaitBaseMs() * 2 ** state.waits, NET_WAIT_STEP_CAP_MS);
  state.waits++;
  return { wait: true, kind, delayMs: Math.min(step, left), waitedMs, state };
}

// 给人看的错误摘要：「fetch failed（ECONNREFUSED）」。
export function connectErrorLabel(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown; message?: unknown } })?.cause;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : "";
  return `${(e as Error)?.message ?? String(e)}${detail ? `（${detail}）` : ""}`;
}
