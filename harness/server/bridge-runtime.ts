// 被 bridge 拉起（嵌入运行）时，Terminal 与 Browser / ReadPage / Eval / Network 操作的是 bridge 核心运行时里的同一个
// 终端与浏览器——工作台面板（bridge 的 /api/claude/term/*、/api/claude/browser/*）看到的就是它们。
//   POST {BRIDGE_PLUGIN_API}/api/internal/agent-term    { ws, args }
//   POST {BRIDGE_PLUGIN_API}/api/internal/agent-browser { ws, session, op, args }
// 凭据是 bridge 拉起本实例时给的同机凭据（BRIDGE_PLUGIN_API / BRIDGE_PLUGIN_SECRET：管理员实例 = 主机密钥，成员实例 = 按人令牌），
// 与设备开关无关、一直下发；bridge 只认本机直连。
//
// 走哪边在启动时由环境变量定死，运行中不切：连不上 bridge 就照实把错误回给模型，不悄悄退回本地那套——
// 退回去 agent 操作的就不是面板里那个了。DIMENSIO_SHARED_RUNTIME=0 / off 是回退手段（嵌在 bridge 里也走本地）。
// 没有命令行的成员（tenant.shell=false）：终端本来就没有；浏览器继续走本地那套（bridge 的浏览器要命令行权限）。
import { tenantShell } from "./tenant.ts";

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;
const MIN_SECRET = 16;

export interface BridgeRuntimeChannel {
  api: string;
  secret: string;
}

export function bridgeRuntimeChannel(): BridgeRuntimeChannel | null {
  const api = String(process.env.BRIDGE_PLUGIN_API ?? "").trim().replace(/\/+$/, "");
  const secret = String(process.env.BRIDGE_PLUGIN_SECRET ?? "").trim();
  return LOOPBACK.test(api) && secret.length >= MIN_SECRET ? { api, secret } : null;
}

function switchedOff(): boolean {
  const v = String(process.env.DIMENSIO_SHARED_RUNTIME ?? "").trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no";
}

/** 嵌入 bridge、没被关掉、有命令行：两样都走 bridge 的。 */
function sharedOn(): boolean {
  return !switchedOff() && tenantShell() && bridgeRuntimeChannel() !== null;
}
export const sharedTerminal = (): boolean => sharedOn();
export const sharedBrowser = (): boolean => sharedOn();

export class BridgeRuntimeError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** POST 一个内部接口；失败抛 BridgeRuntimeError（文字直接可以给模型看）。 */
export async function bridgePost(
  pathname: string,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, any>> {
  const ch = bridgeRuntimeChannel();
  if (!ch) throw new BridgeRuntimeError("Not connected to bridge (this dimensio was not started by bridge).", 0, "unavailable");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(ch.api + pathname, {
      method: "POST",
      headers: { Authorization: `Bearer ${ch.secret}`, "Content-Type": "application/json", "X-Bridge-Agent": "dimensio" },
      body: JSON.stringify(body),
      redirect: "error", // 凭据只发给这一个地址
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new BridgeRuntimeError("Stopped before bridge answered.", 0, "aborted");
    const name = (e as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new BridgeRuntimeError(`bridge did not answer within ${Math.round(timeoutMs / 1000)} s.`, 504, "timeout");
    const err = e as { message?: string; cause?: { code?: string } } | null;
    throw new BridgeRuntimeError(`Cannot reach bridge (${err?.cause?.code || err?.message || String(e)}) — it may be restarting; retry shortly.`, 502, "unreachable");
  }
  let j: Record<string, any> | null = null;
  try {
    j = (await res.json()) as Record<string, any>;
  } catch {
    /* 下面按状态码说 */
  }
  // 凭据不认与接口不存在 bridge 都回 404（前者故意装作不存在）
  if (res.status === 404) {
    throw new BridgeRuntimeError("bridge refused this call: its credential is no longer valid (restart dimensio from bridge), or this bridge is too old to have the shared terminal / browser.", 404, "unavailable");
  }
  if (!res.ok || !j) throw new BridgeRuntimeError(String(j?.error ?? `bridge answered HTTP ${res.status}`), res.status, String(j?.code ?? ""));
  return j;
}

/** bridge 回的 MCP 内容里的文字段，按顺序拼起来。 */
export function mcpText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } => !!c && typeof c === "object" && (c as { type?: unknown }).type === "text")
    .map((c) => String(c.text ?? ""))
    .join("\n");
}
