// R7：provider 错误分类。以前只看状态码——429 / 5xx 重试，别的一律不重试。于是出口被拒的 403 报成「key 不对」，
// 欠费的 429 被当成限流傻等十次，超窗的 400 整轮直接失败。现在按「provider 自己的业务码 / 错误类型 → 话术 → 状态码
// → 响应头」的顺序判：给出类别、要不要重试、要不要先压缩再试、一句人话；上游关联头（request-id、cf-ray、server）
// 一并带上，找 provider 客服或查代理日志时对得上号。
// 覆盖的形状：Anthropic（{type:"error", error:{type,message}}）、OpenAI 兼容（{error:{type,code,message}}：OpenAI、
// DeepSeek、Kimi、智谱、通义、MiMo、llama.cpp 兼容服务）、Gemini（{error:{code,status,message}}）、通义原生（{code,message}），
// 以及代理 / CDN 自己回的 HTML 页。

import type { StreamEvent } from "../agent/events.ts";
import { retryAfterMs } from "./sse.ts";

export type ErrorClass =
  | "auth" // key 无效、过期、没这个模型的权限——provider 自己说的
  | "egress_blocked" // 请求在出口被拒：代理 / CDN / 地区限制，不是 key 的问题
  | "rate_limit" // 这把 key 被限流
  | "upstream_busy" // 上游繁忙 / 过载，和 key 无关
  | "billing" // 欠费、额度用完——等多久都没用
  | "context_overflow" // 超出模型窗口
  | "request_too_large" // 请求体过大（多半是图片或很长的工具结果）
  | "timeout" // 上游 / 网关超时
  | "server" // 其余 5xx
  | "bad_request" // 其余 4xx：请求本身有问题，重试没用
  | "unknown";

export interface Classified {
  class: ErrorClass;
  retriable: boolean;
  compress: boolean; // 先压缩上下文再试一次
  summary: string; // 一句人话，报给用户
  upstream?: string; // request-id / cf-ray / server
}

const SUMMARY: Record<ErrorClass, string> = {
  auth: "API key 无效、过期或没有这个模型的权限（provider 说的）：去设置里换 key 或换模型",
  egress_blocked: "请求在出口被拒（代理、CDN 或地区限制，不是 key 的问题）：检查出站代理的出口",
  rate_limit: "被限流了：会稍后自动重试",
  upstream_busy: "上游繁忙或过载：会稍后自动重试",
  billing: "账户欠费或额度用完：充值或换一个模型后再试（重试没用）",
  context_overflow: "上下文超出了模型窗口：先压缩再试",
  request_too_large: "请求体过大（多半是图片或很长的工具结果）：先压缩再试",
  timeout: "上游或网关超时：会稍后自动重试",
  server: "provider 服务端出错：会稍后自动重试",
  bad_request: "请求被拒绝（参数或模型名不对）：重试没用",
  unknown: "未知错误",
};

const RETRIABLE = new Set<ErrorClass>(["rate_limit", "upstream_busy", "timeout", "server"]);
const COMPRESS = new Set<ErrorClass>(["context_overflow", "request_too_large"]);

interface Parsed {
  code: string; // 业务码 / 错误码（字符串化）
  type: string; // 错误类型（Anthropic 的 type、OpenAI 的 type、Gemini 的 status）
  message: string;
  schema: boolean; // 认得出是 provider 自己的错误结构（不是代理 / CDN 的页面）
  html: boolean;
}

function parseError(raw: unknown): Parsed {
  let v: unknown = raw;
  let html = false;
  if (typeof raw === "string") {
    html = /<html|<!doctype html|<body/i.test(raw);
    try {
      v = JSON.parse(raw);
    } catch {
      const text = html ? raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : raw;
      return { code: "", type: "", message: text.slice(0, 500), schema: false, html };
    }
  }
  if (!v || typeof v !== "object") return { code: "", type: "", message: String(v ?? ""), schema: false, html };
  const o = v as Record<string, any>;
  const e = (o.error && typeof o.error === "object" ? o.error : o) as Record<string, any>;
  const str = (x: unknown) => (x === undefined || x === null ? "" : String(x));
  const code = str(e.code ?? o.code ?? e.error_code);
  const type = str(e.type ?? e.status ?? o.status ?? "");
  const message = str(e.message ?? o.message ?? e.msg ?? (typeof o.error === "string" ? o.error : ""));
  const schema = Boolean(code || type || message) && !html;
  return { code, type: type === "error" ? "" : type, message, schema, html };
}

// 各家的超窗话术（英文 + 国内厂商的中文）；llama.cpp 的「request exceeds the available context size」也在内
const OVERFLOW_RE =
  /prompt is too long|context[_ ]length|maximum context|context window|context size|too many tokens|exceeds? the (maximum|max|available)|input token count|(model|context|maximum) token limit|maximum number of tokens|range of input length|上下文(长度)?(超|过)|超出.{0,8}(长度|上限|限制)|(prompt|输入).{0,6}(超长|过长)/i;
const BILLING_RE =
  /insufficient[_ ]?(quota|balance|funds)|exceeded_current_quota|credit balance is too low|billing|arrearage|payment required|余额不足|欠费|额度(已)?(用完|用尽|不足|耗尽)|充值|quota.{0,40}per ?day|per ?day.{0,40}quota/i;
const AUTH_RE =
  /authentication|invalid[_ ]?(api[_ ]?)?key|incorrect api key|api key (not valid|invalid|expired)|unauthenticated|unauthorized|invalid_authentication|permission_error|鉴权|令牌(无效|过期)|密钥(无效|错误|过期)/i;
const EGRESS_RE = /request not allowed|user location is not supported|unsupported_country|unsupported (country|region)|not available in your (country|region)|access denied|forbidden by/i;
const UPSTREAM_BUSY_RE = /overloaded|engine_overloaded|server is busy|upstream|temporarily unavailable|capacity|繁忙|过载|服务(暂时)?不可用/i;
const TIMEOUT_RE = /timed? ?out|timeout|deadline exceeded|超时/i;

// 智谱等以数字业务码表态的：1113 欠费、1261 超长、1302 / 1303 限流、1305 过载
const CODE_CLASS: Record<string, ErrorClass> = {
  "1113": "billing",
  "1261": "context_overflow",
  "1302": "rate_limit",
  "1303": "rate_limit",
  "1305": "upstream_busy",
  arrearage: "billing",
  throttling: "rate_limit",
  "throttling.ratequota": "rate_limit",
  insufficient_quota: "billing",
  context_length_exceeded: "context_overflow",
  rate_limit_exceeded: "rate_limit",
  invalid_api_key: "auth",
};
// Anthropic 的 error.type、Gemini 的 status
const TYPE_CLASS: Record<string, ErrorClass> = {
  overloaded_error: "upstream_busy",
  rate_limit_error: "rate_limit",
  api_error: "server",
  authentication_error: "auth",
  permission_error: "auth",
  billing_error: "billing",
  request_too_large: "request_too_large",
  not_found_error: "bad_request",
  exceeded_current_quota_error: "billing",
  rate_limit_reached_error: "rate_limit",
  engine_overloaded_error: "upstream_busy",
  unauthenticated: "auth",
  permission_denied: "auth",
  unavailable: "upstream_busy",
  deadline_exceeded: "timeout",
  internal: "server",
};

function upstreamOf(headers?: Headers): string | undefined {
  if (!headers) return undefined;
  const parts: string[] = [];
  const rid = headers.get("request-id") ?? headers.get("x-request-id") ?? headers.get("x-req-id");
  if (rid) parts.push(`request-id=${rid}`);
  const ray = headers.get("cf-ray");
  if (ray) parts.push(`cf-ray=${ray}`);
  const server = headers.get("server");
  if (server) parts.push(`server=${server}`);
  return parts.length ? parts.join("; ") : undefined;
}

function done(cls: ErrorClass, upstream?: string): Classified {
  return { class: cls, retriable: RETRIABLE.has(cls), compress: COMPRESS.has(cls), summary: SUMMARY[cls], ...(upstream ? { upstream } : {}) };
}

// 业务码 / 类型 / 话术能定的先定（不看状态码）；定不了返回 null
function bySemantics(p: Parsed): ErrorClass | null {
  const code = p.code.toLowerCase();
  const type = p.type.toLowerCase();
  const text = `${p.code} ${p.type} ${p.message}`;
  if (CODE_CLASS[code]) return CODE_CLASS[code];
  // Gemini 的配额用完：按分钟的文案里也写着「check your plan and billing」，只有按天的才算欠费
  if (type === "resource_exhausted") return /per ?day/i.test(text) ? "billing" : "rate_limit";
  if (BILLING_RE.test(text)) return "billing"; // 先于类型：Anthropic 的欠费是 invalid_request_error + 话术
  if (TYPE_CLASS[type]) return TYPE_CLASS[type]; // provider 自己的错误类型比话术准（request_too_large 的文案也写着 exceeds the maximum）
  if (OVERFLOW_RE.test(p.message) || code === "context_length_exceeded") return "context_overflow";
  if (type === "failed_precondition" && EGRESS_RE.test(p.message)) return "egress_blocked";
  return null;
}

export function classifyHttpError(status: number, body: string, headers?: Headers): Classified {
  const p = parseError(body);
  const upstream = upstreamOf(headers);
  const server = headers?.get("server")?.toLowerCase() ?? "";
  const viaCdn = Boolean(headers?.get("cf-ray")) || server.includes("cloudflare");

  if (status === 403) {
    // provider 自己说的鉴权问题才算鉴权；出口 / 地区话术、或者根本不是 provider 的错误结构（代理、CDN 的页面）都算出口被拒
    if (EGRESS_RE.test(p.message)) return done("egress_blocked", upstream);
    if (!p.schema && (p.html || viaCdn || !p.message)) return done("egress_blocked", upstream);
  }
  const semantic = bySemantics(p);
  if (semantic) return done(semantic, upstream);
  if (status === 401) return done("auth", upstream);
  if (status === 402) return done("billing", upstream);
  if (status === 403) return done(AUTH_RE.test(p.message) || p.schema ? "auth" : "egress_blocked", upstream);
  if (status === 413) return done("request_too_large", upstream);
  if (status === 408 || status === 504 || status === 524) return done("timeout", upstream);
  if (status === 429) return done(UPSTREAM_BUSY_RE.test(p.message) ? "upstream_busy" : "rate_limit", upstream);
  if (status === 529 || status === 503 || status === 502) return done("upstream_busy", upstream);
  if (status >= 500) return done(TIMEOUT_RE.test(p.message) ? "timeout" : "server", upstream);
  if (status >= 400) return done(AUTH_RE.test(p.message) ? "auth" : "bad_request", upstream);
  return done("unknown", upstream);
}

// 流里来的错误（HTTP 200 已经回了）：Anthropic 的 error 事件、Gemini 的 error 字段、国内厂商夹在 SSE 块里的 {error:…}
export function classifyStreamError(err: unknown): Classified {
  const p = parseError(err);
  const semantic = bySemantics(p);
  if (semantic) return done(semantic);
  const numeric = Number(p.code);
  if (Number.isFinite(numeric) && numeric >= 400) return classifyHttpError(numeric, JSON.stringify(err));
  if (UPSTREAM_BUSY_RE.test(p.message)) return done("upstream_busy");
  if (TIMEOUT_RE.test(p.message)) return done("timeout");
  return done("unknown");
}

type ErrorEvent = Extract<StreamEvent, { e: "error" }>;

function eventOf(kind: string, c: Classified, raw: unknown, retryAfter?: number): ErrorEvent {
  return {
    e: "error",
    kind,
    retriable: c.retriable,
    raw,
    ...(c.retriable && retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    class: c.class,
    compress: c.compress,
    summary: c.summary,
    ...(c.upstream ? { upstream: c.upstream } : {}),
  };
}

// 适配器用：HTTP 层的错误（状态码不是 2xx）。kind 仍是 http_<状态码>，别处按它认具体状态。
export function httpErrorEvent(res: Response, raw: string): ErrorEvent {
  return eventOf(`http_${res.status}`, classifyHttpError(res.status, raw, res.headers), raw, retryAfterMs(res));
}

// 适配器用：流里来的错误。kind 沿用各家自己的类型名（没有就 stream_error）。
export function streamErrorEvent(kind: string, err: unknown): ErrorEvent {
  return eventOf(kind, classifyStreamError(err), err);
}
