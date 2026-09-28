import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";

export const INTERNAL_TOKEN_HEADER = "x-dimensio-internal-token";
// <img>/<a download> 这类浏览器直连的资源 URL 带不了头：GET/HEAD 允许把同一把令牌放进
// query。参数名故意和 bridge 的 ?token= 区分——经 bridge 反代时 query 里的 token 是 bridge
// 管理员令牌，与本进程令牌永不相等，这里不认它（bridge 自己验完会补上头）。
export const QUERY_TOKEN_PARAM = "dimensio_token";

function safeEqual(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// CORS only: which browser origins may READ responses cross-origin (the 5178 Vite
// dev UI, the harness's own port, DIMENSIO_ALLOWED_ORIGINS). It no longer grants
// access by itself — every request still needs the token (apiRequestAuthorized).
export function allowedBrowserOrigin(
  rawOrigin: string | undefined,
  port: number,
  configured: ReadonlySet<string>,
): string | null {
  if (!rawOrigin) return null;
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return null;
  }
  if (configured.has(origin.origin)) return origin.origin;
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return null;
  const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
  const originPort = Number(origin.port || (origin.protocol === "https:" ? 443 : 80));
  return local && (originPort === port || originPort === 5178) ? origin.origin : null;
}

// S1（#12、#38①）：控制面一律要令牌。以前「回环 + 无 Origin」和「回环 + 白名单 Origin」
// 都免令牌放行，可 agent 的 Bash/WebFetch 就跑在回环上，agent 的浏览器打开 8799/5178 的
// 页面就是白名单 Origin——被管的一方能替自己批权限卡、切全自动、开整机访问。现在只有令牌
// 开门：bridge 反代带进程内令牌；独立开发页用 harness 启动时生成的 dev 令牌（index.ts）。
export function apiRequestAuthorized(
  req: Pick<Request, "get" | "method" | "query">,
  token: string | undefined,
): boolean {
  if (!token) return false;
  if (safeEqual(req.get(INTERNAL_TOKEN_HEADER), token)) return true;
  if (req.method === "GET" || req.method === "HEAD") {
    const q = req.query?.[QUERY_TOKEN_PARAM];
    if (typeof q === "string" && safeEqual(q, token)) return true;
  }
  return false;
}
