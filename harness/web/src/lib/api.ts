// REST + SSE 客户端 + 连接层。
//
// 两种连接模式（localStorage["harness.conn"]，JSON）：
//   direct — 直连 harness：base = http://<pc>:8799，无鉴权。
//   bridge — 经 bridge 反代：base = <bridge源>/api/harness，每个请求带
//            Authorization: Bearer <token>（bridge 的 admin token；appassets
//            跨源带不了 cookie，离线壳同款路径）。
//
// bridge 模式的双路自动切换（沿 bridge apk 的 LAN 直连机制）：
//   · 连上后调 <bridge>/api/lan 学习局域网地址（http://<ip>:8787），存起来；
//   · 每次取 base 前看当前路由；探活 <lan>/healthz（该端点 CORS:* 专为此设计）
//     短超时判可达 → 在家走 LAN，出门自动回隧道；
//   · 请求网络层失败时自动换路重试一次并触发重新探活。
// 浏览器同源使用（网页开 8799/bridge 页面）→ 无配置，空前缀直连。

import { featuresFromCaps, withProto } from "./protocol.ts";
import { thisDevice } from "./client-id.ts";
import type { GoalView } from "./timeline-types.ts";

export interface Conn {
  mode: "direct" | "bridge";
  url: string;    // direct: harness 地址；bridge: bridge 源（隧道或局域网）
  token?: string; // bridge 模式必填
  lan?: string;   // 学习到的 bridge 局域网源 http://ip:port
}

const CONN_KEY = "harness.conn";
const LEGACY_KEY = "harness.api";

let conn: Conn | null = null;
let route: "main" | "lan" = "main"; // bridge 模式当前走哪路
let lanAliveAt = 0;                 // 上次 LAN 探活成功时刻
let probing: Promise<boolean> | null = null;

// ── 嵌入模式（作为 bridge 分页运行）────────────────────────────────────────
// bridge 注入自己的基址（含 LAN/隧道自愈）与鉴权头；本模块的连接管理全部让位。
export interface ApiOverride {
  base: () => string;                    // 每次请求时求值（吃到宿主的路由自愈）
  headers: () => Record<string, string>; // 宿主鉴权（Bearer 等）
}
let override: ApiOverride | null = null;
export function configureApi(o: ApiOverride | null) {
  override = o;
}
export const isEmbedded = () => override !== null;

// ── 配置存取 ─────────────────────────────────────────────────────────────────
export function getConn(): Conn | null {
  if (conn) return conn;
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (raw) {
      conn = JSON.parse(raw);
      return conn;
    }
    // 旧版单地址配置迁移为 direct
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      conn = { mode: "direct", url: legacy.replace(/\/+$/, "") };
      localStorage.setItem(CONN_KEY, JSON.stringify(conn));
      return conn;
    }
  } catch { /* ignore */ }
  return null;
}

export function setConn(c: Conn | null) {
  conn = c;
  route = "main";
  lanAliveAt = 0;
  try {
    if (c) localStorage.setItem(CONN_KEY, JSON.stringify(c));
    else localStorage.removeItem(CONN_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* ignore */ }
}

export function isShell(): boolean {
  return location.hostname === "appassets.androidplatform.net" || Boolean((window as any).HarnessShell);
}

export function needsSetup(): boolean {
  if (override) return false; // 宿主管连接
  return isShell() && !getConn();
}

// 当前实际使用的 API 前缀（含 bridge 的 /api/harness 路径）
export function apiBase(): string {
  if (override) return override.base();
  const c = getConn();
  if (!c) return ""; // 同源
  if (c.mode === "direct") return c.url;
  const origin = route === "lan" && c.lan ? c.lan : c.url;
  return origin + "/api/harness";
}

// 给设置页显示：当前路由
export function activeRoute(): "same-origin" | "direct" | "tunnel" | "lan" | "embed" {
  if (override) return "embed";
  const c = getConn();
  if (!c) return "same-origin";
  if (c.mode === "direct") return "direct";
  return route === "lan" && c.lan ? "lan" : "tunnel";
}

// ── 独立开发页的令牌（S1）──────────────────────────────────────────────────
// harness 的 API 一律要令牌。经 bridge 时由 bridge 代劳；直连 harness（8799 同源页、
// 5178 vite 开发页、direct 连接）时用 harness 独立启动打印在控制台里的开发页地址
// http://127.0.0.1:8799/#dimensio-token=<令牌>：首次打开把它收进 localStorage、从地址栏抹掉。
const DEV_TOKEN_KEY = "harness.devToken";
const DEV_TOKEN_HEADER = "x-dimensio-internal-token";
const DEV_TOKEN_QUERY = "dimensio_token";
const devToken: string | null = (() => {
  try {
    const m = /(?:^#|&)dimensio-token=([^&]*)/.exec(location.hash);
    if (m) {
      const token = decodeURIComponent(m[1]);
      localStorage.setItem(DEV_TOKEN_KEY, token);
      const rest = location.hash.slice(1).split("&").filter((p) => !p.startsWith("dimensio-token=")).join("&");
      history.replaceState(history.state, "", location.pathname + location.search + (rest ? "#" + rest : ""));
      return token;
    }
    return localStorage.getItem(DEV_TOKEN_KEY);
  } catch {
    return null;
  }
})();

// 直连 harness 本体（不经 bridge）时才带 dev 令牌。
function directToHarness(): boolean {
  return !override && getConn()?.mode !== "bridge";
}

function authHeaders(): Record<string, string> {
  if (override) return override.headers();
  const c = getConn();
  if (c?.mode === "bridge") return c.token ? { Authorization: `Bearer ${c.token}` } : {};
  return devToken ? { [DEV_TOKEN_HEADER]: devToken } : {};
}

// <img>/<a> 这类浏览器直连 URL 带不了头：经 bridge 镜像 bridge 的 ?token=，
// 直连 harness 则镜像 dev 令牌（harness 只对 GET 认 ?dimensio_token=）。
function setResourceToken(q: URLSearchParams): void {
  const token = bearerToken();
  if (token) q.set("token", token);
  else if (directToHarness() && devToken) q.set(DEV_TOKEN_QUERY, devToken);
}

// DeepSeek 整页（iframe 供纸）：文档请求带不了头，把 Bearer 凭证抽出来
// 由宿主拼进 iframe src 的 ?token=，页内再转回 Authorization 头。
export function bearerToken(): string | null {
  const m = /^Bearer\s+(.+)$/.exec(
    authHeaders().Authorization ?? (authHeaders() as any).authorization ?? "",
  );
  return m ? m[1] : null;
}

// Browser-loadable artifact URLs cannot carry Authorization headers, so the
// bridge token is mirrored into the query string just like iframe/media URLs.
export function artifactUrl(sessionId: string, path: string, download = false): string {
  const query = new URLSearchParams({ path });
  if (download) query.set("dl", "1");
  setResourceToken(query);
  return `${apiBase()}/api/sessions/${encodeURIComponent(sessionId)}/artifact?${query}`;
}

// R12（二）：会话资产（截图等）的浏览器直连 URL——事件里只带资产 id，令牌同上镜像进查询串。
export function sessionAssetUrl(sessionId: string, asset: string): string {
  const query = new URLSearchParams();
  setResourceToken(query);
  const q = query.toString();
  return `${apiBase()}/api/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(asset)}${q ? `?${q}` : ""}`;
}

// ── LAN 探活 / 学习（bridge 模式）────────────────────────────────────────────
async function probeLan(): Promise<boolean> {
  const c = getConn();
  if (c?.mode !== "bridge" || !c.lan) return false;
  if (probing) return probing;
  probing = (async () => {
    try {
      const res = await fetch(`${c.lan}/healthz`, { signal: AbortSignal.timeout(900), cache: "no-store" });
      const ok = res.ok;
      route = ok ? "lan" : "main";
      if (ok) lanAliveAt = Date.now();
      return ok;
    } catch {
      route = "main";
      return false;
    } finally {
      probing = null;
    }
  })();
  return probing;
}

// 连上 bridge 后学习/刷新局域网地址（拿不到就保持原样，无碍）
export async function learnLan(): Promise<void> {
  const c = getConn();
  if (c?.mode !== "bridge") return;
  try {
    const res = await fetch(`${c.url}/api/lan`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return;
    const { ips, port } = await res.json();
    for (const ip of ips ?? []) {
      const cand = `http://${ip}:${port}`;
      try {
        const h = await fetch(`${cand}/healthz`, { signal: AbortSignal.timeout(900), cache: "no-store" });
        if (h.ok) {
          conn = { ...c, lan: cand };
          localStorage.setItem(CONN_KEY, JSON.stringify(conn));
          route = "lan";
          lanAliveAt = Date.now();
          return;
        }
      } catch { /* 下一个候选 */ }
    }
  } catch { /* 隧道都不通时自然失败 */ }
}

// 启动时恢复路由：有学习过的 LAN 就先探一下（嵌入模式由宿主管路由，跳过）
export async function initRoute(): Promise<void> {
  if (override) return;
  const c = getConn();
  if (c?.mode === "bridge") {
    if (c.lan) await probeLan();
    if (route === "main") void learnLan(); // 在外时静默失败，无碍
  }
}

// ── 统一请求（带鉴权 + 换路重试 + 可选超时）──────────────────────────────────
// timeoutMs：手机上的半开连接 read() 永远不返回，裸 fetch 会永久挂着不 settle。
// 断线对账（status/记录拉取）全靠 await 的返回推进状态机，一条挂死的请求就能让
// 「重连中」永久卡住 —— 凡是对账路径上的请求都必须带时限。长命 SSE 流不带
// （它有自己的 signal 与字节看门狗）。
export interface HFetchInit extends RequestInit {
  timeoutMs?: number;
}

// 每次【尝试】现造一条超时信号：换路重试若复用已 abort 的信号会当场再死一次。
// 用 AbortController 手搓而不是 AbortSignal.any（Chrome 116+，壳里 WebView 未必有）。
// 计时器【故意不清】：fetch 在响应头到达就 resolve，body 读一半断网同样会挂死，
// 留着它到期 abort 才连读 body 的那段也一起兜住（body 读完后 abort 是空操作）。
function timeoutSignal(ms: number, outer?: AbortSignal | null): AbortSignal {
  const ctl = new AbortController();
  const onOuter = () => ctl.abort((outer as any)?.reason);
  setTimeout(() => {
    outer?.removeEventListener("abort", onOuter);
    ctl.abort(new DOMException("timeout", "TimeoutError"));
  }, ms);
  outer?.addEventListener("abort", onOuter, { once: true });
  return ctl.signal;
}

async function hfetch(path: string, init?: HFetchInit): Promise<Response> {
  const c = getConn();
  const { timeoutMs, ...rest } = init ?? {};
  const doFetch = () =>
    fetch(apiBase() + path, {
      ...rest,
      signal: timeoutMs ? timeoutSignal(timeoutMs, rest.signal) : rest.signal,
      headers: { ...authHeaders(), ...(rest.headers as Record<string, string> | undefined) },
    });
  try {
    return await doFetch();
  } catch (e) {
    // 网络层失败：bridge 模式换一路再试一次（LAN 掉线→回隧道；隧道抽风→试 LAN）
    if (c?.mode === "bridge" && (e as Error)?.name !== "AbortError") {
      const prev = route;
      route = prev === "lan" ? "main" : c.lan ? "lan" : "main";
      if (route !== prev) {
        try {
          const res = await doFetch();
          if (prev === "lan") lanAliveAt = 0; // LAN 已死，别再赖着
          return res;
        } catch {
          route = prev;
        }
      }
      void probeLan();
    }
    throw e;
  }
}

async function j<T = any>(path: string, init?: HFetchInit): Promise<T> {
  const res = await hfetch(path, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let body: any;
    try {
      body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* keep status */ }
    const err = new Error(msg) as Error & { status?: number; body?: any };
    err.status = res.status;
    err.body = body; // 结构化的错误细节（例如自定义服务的 needsModel）
    throw err;
  }
  return res.json();
}

const POST = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

// ── 元信息 / 配置 ─────────────────────────────────────────────────────────────
export const getInfo = () => j("/api/info");
export const getConfig = () => j("/api/config");
export const patchConfig = (patch: Record<string, unknown>) => j("/api/config", POST(patch));

// ── 自定义模型服务（「模型服务」面板的「＋」卡；能力位 custom-providers）─────────────
export interface CustomProviderForm {
  name: string;
  baseUrl: string;
  apiKey?: string; // 编辑时留空 = 保持不变
  model?: string; // 接口列不出模型时手填
}
export type CustomProviderSaved = { ok: true; id: string; models: number; warning?: string };
export const addCustomProvider = (form: CustomProviderForm) => j<CustomProviderSaved>("/api/custom-providers", POST(form));
export const updateCustomProvider = (id: string, form: CustomProviderForm) =>
  j<CustomProviderSaved>(`/api/custom-providers/${encodeURIComponent(id)}`, POST(form));
export const deleteCustomProvider = (id: string) => j<{ ok: true; config: any }>(`/api/custom-providers/${encodeURIComponent(id)}/delete`, POST());

// ── 会话 ──────────────────────────────────────────────────────────────────────
export const listSessions = () => j<any[]>("/api/sessions");
// 分页取会话：服务端按 updatedAt 倒序，总数走 X-Total-Count（超过一页的旧会话
// 以前完全够不着）。经 bridge 反代时该头可能被过滤 → total 回退成 -1，
// 调用方据此按「拿满一页就可能还有」处理。
export async function listSessionsPage(
  offset: number,
  limit: number,
  timeoutMs?: number,
): Promise<{ items: any[]; total: number }> {
  const res = await hfetch(
    `/api/sessions?offset=${offset}&limit=${limit}`,
    timeoutMs ? { timeoutMs } : undefined,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const items = (await res.json()) as any[];
  const raw = res.headers.get("X-Total-Count");
  const total = raw == null ? -1 : Number(raw);
  return { items, total: Number.isFinite(total) ? total : -1 };
}
// K10（D5）：侧栏搜索的正文命中（服务端能力位 "session-search"）。摘录分成前文 / 命中 / 后文三段，高亮由前端加，不拼 HTML。
export interface SessionSearchHit {
  id: string;
  title: string;
  workspace?: string;
  provider: string;
  updatedAt: number;
  hits: number;
  snippet: { before: string; match: string; after: string };
}
export async function searchSessions(q: string, signal?: AbortSignal): Promise<SessionSearchHit[]> {
  const res = await hfetch(`/api/sessions/search?q=${encodeURIComponent(q)}`, { signal, timeoutMs: 15_000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.items) ? body.items : [];
}
// timeoutMs：断线对账拉记录时必须带（见 hfetch 注释）；普通打开会话不设时限。
export const getSession = (id: string, timeoutMs?: number) =>
  j(`/api/sessions/${encodeURIComponent(id)}`, timeoutMs ? { timeoutMs } : undefined);
// 一次工作流运行的逐 agent 明细（prompt / 工具轨迹 / 答复）：只存在工作流日志里，
// 任务面板打开某个 agent 的转录时才按需拉。
export const workflowDetail = (sessionId: string, wfId: string) =>
  j<{ id: string; name: string; agents: Record<string, any> }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(wfId)}`,
    { timeoutMs: 15_000 },
  );
// 删除走 POST 别名：bridge 反代的 CORS 只放 GET/POST，跨源 DELETE 过不了预检
export const deleteSession = (id: string) =>
  j(`/api/sessions/${encodeURIComponent(id)}/delete`, POST()).catch((e) => {
    // 旧后端没有别名路由 → 退回 DELETE（同源/直连场景无 CORS 限制）
    if ((e as any)?.status === 404) {
      return j(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
    throw e;
  });
// M2（#44）：runId = 本端附着到的那一轮。服务端此刻在跑的是另一轮 → 409 run_mismatch，什么都不动。
export const stopRun = (sessionId: string, runId?: string | null) =>
  j("/api/stop", POST({ sessionId, ...(runId ? { runId } : {}) }));

// R14（K37）：把正在前台跑的那次 Bash 调用转到后台（不杀）。false = 它已经跑完 / 已经转过 / 后台满了。
export async function moveToolToBackground(sessionId: string, callId: string): Promise<boolean> {
  try {
    const r = await j<{ moved: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(callId)}/background`,
      POST(),
    );
    return r.moved === true;
  } catch {
    return false;
  }
}

// U9：「从这里改写」（服务端能力位有 "rewind" 才可用）。ordinal = 点的是第几个用户气泡（0 起），text = 气泡上的字。
// 回执的 undo 给「撤销」用；changedFiles = 那之后改过、没有回退的文件（量不出来时没有这一项）。
export interface RewindReply {
  ok: boolean;
  error?: string;
  code?: string;
  undo?: { n: number; length: number };
  changedFiles?: string[];
}
async function rewindCall(path: string, body: unknown): Promise<RewindReply> {
  const res = await hfetch(path, { ...POST(body), timeoutMs: 30_000 });
  const data = (await res.json().catch(() => ({}))) as RewindReply;
  return res.ok ? { ...data, ok: true } : { ok: false, error: data.error ?? `HTTP ${res.status}`, code: data.code };
}
export const rewindSession = (id: string, ordinal: number, text: string) =>
  rewindCall(`/api/sessions/${encodeURIComponent(id)}/rewind`, { ordinal, text });
export const undoRewind = (id: string, n: number, length: number) =>
  rewindCall(`/api/sessions/${encodeURIComponent(id)}/rewind/undo`, { n, length });

// C8：上下文卫生（服务端能力位有 "hygiene" 才可用）。sessionId = 新开的会话；before / after = 压缩前后的估算 token。
export interface HygieneReply {
  ok: boolean;
  error?: string;
  code?: string;
  sessionId?: string;
  before?: number;
  after?: number;
}
async function hygieneCall(path: string, body: unknown, timeoutMs: number): Promise<HygieneReply> {
  try {
    const res = await hfetch(path, { ...POST(body), timeoutMs });
    const data = (await res.json().catch(() => ({}))) as HygieneReply;
    return res.ok ? { ...data, ok: true } : { ok: false, error: data.error ?? `HTTP ${res.status}`, code: data.code };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
// 压缩与写摘要都要调一次模型（慢的模型可能要一两分钟）
export const compactSessionNow = (id: string) => hygieneCall(`/api/sessions/${encodeURIComponent(id)}/compact`, {}, 240_000);
export const handoffWithSummary = (id: string) =>
  hygieneCall(`/api/sessions/${encodeURIComponent(id)}/handoff`, { kind: "summary" }, 240_000);
export const handoffPlan = (id: string, planId: string) =>
  hygieneCall(`/api/sessions/${encodeURIComponent(id)}/handoff`, { kind: "plan", planId, by: thisDevice() }, 30_000);

// U11：会话的 Bash 后台 job（服务端能力位有 "jobs" 才可用）。elapsedMs 按服务端时钟算好，界面只加本机流逝的时间。
export interface JobInfo {
  id: string;
  command: string;
  state: "running" | "exited" | "timeout" | "killed";
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  elapsedMs: number;
  tail: string;
}
export async function listSessionJobs(sessionId: string): Promise<JobInfo[]> {
  const r = await j<{ jobs: JobInfo[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/jobs`, { timeoutMs: 8_000 });
  return Array.isArray(r?.jobs) ? r.jobs : [];
}
// false = 没有这个 job / 它已经结束了
export async function killSessionJob(sessionId: string, jobId: string): Promise<boolean> {
  try {
    const r = await j<{ killed: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(jobId)}/kill`,
      POST(),
    );
    return r.killed === true;
  } catch {
    return false;
  }
}

// M2（#51）：按发送时带的 clientRunId 问「那一条落地了没有」。null = 不知道（网络不通 / 旧后端没有这个接口）。
export async function lookupRun(
  clientRunId: string,
  timeoutMs?: number,
): Promise<{ known: boolean; sessionId?: string; runId?: string; running?: boolean } | null> {
  try {
    const res = await hfetch(`/api/runs/${encodeURIComponent(clientRunId)}`, timeoutMs ? { timeoutMs } : undefined);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 回答 agent 抛出的 AskUserQuestion：answers 与问题同序，每项 { selected: string[], custom?: boolean }。
// ok:false = 该 ask 已失效（会话没在跑 / 已被别的设备答过 / 重复提交）。
// 运行中插话：把消息投进正在跑的那一轮（服务端在下一个回合边界注入）。
// 409 = 那一轮刚好结束了 → 调用方回退成正常发送。
// M2：带上 runId；409 且 message 为 run_mismatch = 在跑的已是另一轮，别把这句话当新消息发。
// U2：id = 这条插话的身份（本机乐观气泡与回来的 steer_queued 按它对号）。
export const steer = (sessionId: string, text: string, runId?: string | null, id?: string) =>
  j<{ ok: boolean; id?: string }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/steer`,
    POST({ text, ...(runId ? { runId } : {}), ...(id ? { id } : {}) }),
  );

// 细粒度权限裁决 / 计划批准（与 answerAsk 同一条阻塞-落定链路）
// P10：by = 这台设备（别的设备的回执写「在手机上…」）；note = 拒绝时附的话（N43：输入框里的话落到卡上）
export const decidePermission = (
  sessionId: string,
  id: string,
  decision: "once" | "session" | "deny" | "deny_stop",
  scope?: "prefix",
  note?: string,
) =>
  j<{ ok: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/permission`,
    POST({ id, decision, ...(scope ? { scope } : {}), ...(note ? { note } : {}), by: thisDevice() }),
  );

// 会话内切运行档位（输入框旁的档位胶囊）。全局 config 里的同名字段只管新对话的
// 默认值，已经开跑的会话跑自己的快照 cfg —— 所以切档要点名这条会话。
export const setSessionMode = (sessionId: string, mode: string) =>
  j<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/mode`, POST({ mode }));

// 会话内切访问范围（仅工作空间 / 整机）——与切档同构：点名当前会话当场生效。
export const setSessionAccess = (sessionId: string, access: string) =>
  j<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/access`, POST({ access }));
// U2（X36 第二步）：撤回一条还没送达的插话；立即中断并发送（服务端撤回、停这一轮、以这句开新一轮）
export const withdrawSteer = (sessionId: string, id: string) =>
  j<{ ok: boolean; reason?: "delivered" | "not_running" }>(`/api/sessions/${encodeURIComponent(sessionId)}/steer/withdraw`, POST({ id }));
export const interruptSteer = (sessionId: string, id: string) =>
  j<{ ok: boolean; reason?: "delivered" | "not_running" | "busy" }>(`/api/sessions/${encodeURIComponent(sessionId)}/steer/interrupt`, POST({ id }));
// P13（X18）：撤掉本会话放行的一个工作区外只读目录（放行在权限卡上做）
export const revokeReadRoot = (sessionId: string, dir: string) =>
  j<{ ok: boolean; roots: string[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/read-roots`, POST({ remove: dir }));

// P3：离开模式（会话级开关，与档位正交）。
export const setSessionAway = (sessionId: string, away: boolean) =>
  j<{ ok: boolean; away: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/away`, POST({ away }));

export const decidePlan = (sessionId: string, id: string, approved: boolean, note?: string) =>
  j<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/plan`, POST({ id, approved, note, by: thisDevice() }));

export const answerAsk = (
  sessionId: string,
  askId: string,
  answers: { selected: string[]; custom?: boolean }[],
) => j<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, POST({ askId, answers, by: thisDevice() }));

// ── 项目（显示名 ↔ workspace 绝对路径）─────────────────────────────────────
export const listProjects = () => j<any[]>("/api/projects");
export const createProject = (name: string) => j("/api/projects", POST({ mode: "blank", name }));
export const importProject = (path: string) => j("/api/projects", POST({ mode: "existing", path }));
// 置顶 / 隐藏：身份是 workspace 绝对路径（隐式项目也能设），POST 而非 PATCH
// 是因为 bridge 反代的 CORS 只放 GET/POST。
export const setProjectFlags = (path: string, patch: { pinned?: boolean; hidden?: boolean }) =>
  j<any>("/api/projects/flags", POST({ path, ...patch }));
// 侧栏拖动排序（能力位 "project-order"）：一个区拖完之后的完整次序
export const setProjectOrder = (paths: string[]) => j<{ ok: boolean }>("/api/projects/order", POST({ paths }));
// 「新建快照」：服务端换一只全新的一次性桶（旧桶留盘不删，只是不再列出），
// 返回带 quick 标记的项目对象。
export const newQuickChat = () => j<any>("/api/quick/new", POST({}));

// SSE-over-fetch 读循环（三条流共用）。onAlive 在每次收到字节时触发——包括
// 服务端 15s 一发的 ": ping" 注释行（它不产生事件但证明连接活着），断线
// watchdog 全靠这个时间戳判断半开死连接。
async function readSse(
  res: Response,
  onEvent: (ev: any) => void,
  onAlive?: () => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onAlive?.();
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, boundary);
      buf = buf.slice(boundary + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).replace(/^ /, "")));
        } catch { /* keep-alive / partial */ }
      }
    }
  }
}

// 轻量运行状态探测：手机回前台的对账入口，不拉全量转录。旧后端没有该端点
// （SPA 通配路由会兜底成 200 HTML）→ 按 content-type 识别并退化拉全量会话。
export interface SessionStatus {
  exists: boolean;
  running: boolean;
  runStartMsgCount?: number;
  // 内容指纹：与手里这份记录的 fp 相同 = 什么都没变，不必再拉整份转录
  // （长会话 300KB+，切回来一次付一次）。旧后端不给 → undefined → 照旧拉。
  fp?: string;
}
export async function sessionStatus(id: string, timeoutMs?: number): Promise<SessionStatus> {
  const opts: HFetchInit | undefined = timeoutMs ? { timeoutMs } : undefined;
  const res = await hfetch(`/api/sessions/${encodeURIComponent(id)}/status`, opts);
  if (res.ok && (res.headers.get("content-type") ?? "").includes("application/json")) {
    return res.json();
  }
  const full = await hfetch(`/api/sessions/${encodeURIComponent(id)}`, opts);
  if (full.status === 404) return { exists: false, running: false };
  if (!full.ok) throw new Error(`HTTP ${full.status}`);
  const rec = await full.json();
  return { exists: true, running: Boolean(rec.running), runStartMsgCount: rec.runStartMsgCount };
}

// 直播镜像：附着到一个正在运行的会话（本机断线重连 / 另一台设备发起的），
// 回放本轮已发生的事件后持续直播到本轮结束。409 = 会话没在跑。
export async function sessionStream(
  id: string,
  onEvent: (ev: any) => void,
  signal?: AbortSignal,
  onAlive?: () => void,
): Promise<void> {
  const res = await hfetch(withProto(`/api/sessions/${encodeURIComponent(id)}/stream`), { signal });
  if (!res.ok || !res.body) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  await readSse(res, onEvent, onAlive);
}

// P8（K30）：全局事件通道——先来一份快照（snapshot），之后每个会话的状态变化（开跑 / 收尾 / 挂起一张卡 / 卡落定）
// 一条 session_status。旧后端没有这个端点（SPA 通配会回 200 HTML）→ 按 content-type 认出来，抛 404 让调用方别再连。
export async function globalEvents(onEvent: (ev: any) => void, signal?: AbortSignal, onAlive?: () => void): Promise<void> {
  const res = await hfetch(withProto("/api/events"), { signal });
  const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!res.ok || !res.body || !sse) {
    const err = new Error(`HTTP ${sse ? res.status : 404}`) as Error & { status?: number };
    err.status = sse ? res.status : 404;
    throw err;
  }
  await readSse(res, onEvent, onAlive);
}

// ── 记忆治理（K4）：按项目看、晋升、驳回、撤销驳回、删除 ─────────────────────────────
// 服务端能力位有 "memory" 才可用（旧服务端的 /api/memory 只认全局工作区）。
export type MemoryStatus = "proposed" | "active" | "superseded" | "stale" | "rejected";
export interface MemoryMeta {
  id: string;
  title: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  topic: string;
  status: MemoryStatus; // 算上到期 / 锚点 / 冲突之后的实际状态
  declaredStatus: MemoryStatus; // 笔记自己写的
  confidence: "user_confirmed" | "verified" | "observed" | "inferred";
  updated: string;
  scope: string[];
  evidence: string[];
  anchors: string[];
  expiresAt?: string;
  verifiedAt?: string;
  supersedes?: string;
  supersededBy?: string;
  origin?: string;
  attended?: boolean;
  external?: boolean; // K9：写它的会话读过外部内容
  rejectedAt?: string;
  rejectReason?: string;
  issues: string[];
}
export interface MemoryNote extends MemoryMeta {
  content: string;
}
export interface MemoryEdits {
  title?: string;
  description?: string;
  content?: string;
  expiresAt?: string | null;
}
const memoryPath = (id: string, action = "") => `/api/memory/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
// K7：全局层记忆（关于你与这台机器、每个项目都适用）用这个特殊值代替工作区路径；服务端能力位有 "memory-global" 才有
export const GLOBAL_MEMORY_WS = "@global";
const inWorkspace = (ws: string) => (ws === GLOBAL_MEMORY_WS ? "layer=global" : `workspace=${encodeURIComponent(ws)}`);
const wsBody = (ws: string) => (ws === GLOBAL_MEMORY_WS ? { layer: "global" } : { workspace: ws });
export const listMemory = (ws: string) => j<MemoryMeta[]>(`/api/memory?${inWorkspace(ws)}`);
export const readMemoryNote = (ws: string, id: string) => j<MemoryNote>(`${memoryPath(id)}?${inWorkspace(ws)}`);
export const rejectMemoryNote = (ws: string, id: string, reason?: string) => j(memoryPath(id, "reject"), POST({ ...wsBody(ws), reason }));
export const restoreMemoryNote = (ws: string, id: string) => j(memoryPath(id, "restore"), POST(wsBody(ws)));
export const deleteMemoryNote = (ws: string, id: string) => j<{ deleted: boolean }>(memoryPath(id, "delete"), POST(wsBody(ws)));
// K11：记忆总览（设置里的「记忆」面板）——全局层 + 各项目 + 旧快照桶一次拿齐；服务端能力位有 "memory-overview" 才有
export type MemoryHistoryWhy = "overwrite" | "delete" | "retire" | "superseded" | "reject" | "restore";
export interface MemoryOverviewItem extends MemoryMeta {
  uses?: number; // 全文被拉进对话的次数（开跑自动召回 + Recall 按 id 读）
  firstUsed?: string;
  lastUsed?: string;
}
export interface MemoryBucket {
  kind: "global" | "project" | "quick";
  ws: string; // 调 /api/memory* 用的工作区（全局层 = GLOBAL_MEMORY_WS）
  name: string;
  current?: boolean;
  hidden?: boolean;
  createdAt?: number;
  items: MemoryOverviewItem[];
  promptChars: number;
  history: Array<{ id: string; at: string; why: MemoryHistoryWhy }>;
}
export interface MemoryOverview {
  at: string;
  budget: number;
  buckets: MemoryBucket[];
  emptyProjects: number;
}
export const memoryOverview = () => j<MemoryOverview>("/api/memory/overview");
// 晋升不抛：校验不过带回问题清单；同一个 topic 已有生效条目时带回冲突（界面给「替换它」，再带 supersedes 发一次）；
// code "global_budget" = 全局层生效的条目合计超了上限（K7）
export type PromoteResult = { ok: true } | { ok: false; error: string; code?: string; conflicts?: Array<{ id: string; title: string }> };
export async function promoteMemoryNote(
  ws: string,
  id: string,
  opts: { edits?: MemoryEdits; supersedes?: string } = {},
): Promise<PromoteResult> {
  const res = await hfetch(memoryPath(id, "promote"), POST({ ...wsBody(ws), ...opts }));
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  return {
    ok: false,
    error: String(body?.error ?? `HTTP ${res.status}`),
    code: typeof body?.code === "string" ? body.code : undefined,
    conflicts: Array.isArray(body?.conflicts) ? body.conflicts : undefined,
  };
}

// ── 诊断包（Q13）：服务端写进会话工作区的 .dimensio/diagnostics/<id>/，回一个产物描述 ─────────────
// 服务端能力位有 "diagnostics" 才可用。
export const createDiagnostics = (sessionId: string) =>
  j<{ path: string; name: string; kind: "text"; size: number }>(`/api/sessions/${encodeURIComponent(sessionId)}/diagnostics`, POST({}));

// ── checkpoint / 回滚 ────────────────────────────────────────────────────────
export const listCheckpoints = (id: string) =>
  j<any[]>(`/api/sessions/${encodeURIComponent(id)}/checkpoints`);
export async function checkpointDiff(id: string, n: number): Promise<string> {
  const res = await hfetch(`/api/sessions/${encodeURIComponent(id)}/checkpoints/${n}/diff`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
// P9（K22）：服务端拒绝回滚（409）不抛，带回原因——code "external" 时 external 是对话之外改过、回滚会覆盖的文件，
// 人确认后带 force 再发一次。
export type RollbackResult =
  | { ok: true }
  | { ok: false; error: string; code?: "running" | "external"; external?: string[] };
export async function rollback(id: string, n: number, force = false): Promise<RollbackResult> {
  const res = await hfetch(`/api/sessions/${encodeURIComponent(id)}/rollback`, POST({ n, force }));
  if (res.ok) return { ok: true };
  let body: any = null;
  try {
    body = await res.json();
  } catch { /* keep status */ }
  if (res.status === 409) {
    return {
      ok: false,
      error: body?.error ?? `HTTP ${res.status}`,
      code: body?.code,
      external: Array.isArray(body?.external) ? body.external : undefined,
    };
  }
  const err = new Error(body?.error ?? `HTTP ${res.status}`) as Error & { status?: number };
  err.status = res.status;
  throw err;
}

// ── 工作空间选择器（整盘目录导航，仅目录名）──────────────────────────────────
export interface FsDirs {
  path: string;
  parent: string | null;
  dirs: string[];
  drives: string[];
}
export const fsDirs = (path: string) => j<FsDirs>(`/api/fs/dirs?path=${encodeURIComponent(path)}`);
export const fsMkdir = (path: string) => j("/api/fs/mkdir", POST({ path }));

// ── 工作空间文件 ──────────────────────────────────────────────────────────────
export const listDir = (path: string) => j(`/api/files?path=${encodeURIComponent(path)}`);
// U4（K08）：sessionId = 落进这个会话的工作区（新对话还没有 id 时不传，服务端用全局工作区）。返回服务端实际落盘的
// 工作区相对路径——会话附件目录里同名不覆盖，会被加序号。旧服务端回的 path 就是传进去的那个。
export async function uploadFile(destPath: string, file: File, sessionId?: string | null): Promise<string> {
  const q = new URLSearchParams({ path: destPath });
  if (sessionId) q.set("sessionId", sessionId);
  const res = await hfetch(`/api/files/upload?${q}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    const body = await res.json();
    return typeof body?.path === "string" && body.path ? body.path.replace(/\\/g, "/") : destPath;
  } catch {
    return destPath;
  }
}

// ── 预览 ──────────────────────────────────────────────────────────────────────
export const stopPreviews = (serviceId?: string) =>
  j("/api/preview/stop", POST(serviceId ? { serviceId } : {})).catch(() => {});

// ── Agent 浏览器（screencast 直播 + 输入回传）────────────────────────────────
export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}
export const browserState = () =>
  j<{ alive: boolean; url?: string; viewport?: { width: number; height: number }; tabs?: BrowserTab[] }>("/api/browser/state");
export const browserNavigate = (body: { url?: string; dir?: "back" | "forward" }) =>
  j<{ ok: boolean; url: string }>("/api/browser/navigate", POST(body));
export const browserInput = (body: Record<string, unknown>) =>
  j<{ ok: boolean; url: string }>("/api/browser/input", POST(body));
export const browserResize = (body: { preset?: "mobile" | "tablet" | "desktop"; width?: number; height?: number }) =>
  j<{ ok: boolean; viewport: { width: number; height: number } }>("/api/browser/resize", POST(body));
// 标签页：＋新建（浏览器没跑时会顺手拉起）、点选切换、×关闭（最后一个=关整个浏览器）
export const browserTabNew = (url?: string) =>
  j<{ ok: boolean; tabs: BrowserTab[]; url: string }>("/api/browser/tabs/new", POST(url ? { url } : {}));
export const browserTabActivate = (id: string) =>
  j<{ ok: boolean; tabs: BrowserTab[]; url: string }>("/api/browser/tabs/activate", POST({ id }));
export const browserTabClose = (id: string) =>
  j<{ ok: boolean; tabs: BrowserTab[]; alive: boolean }>("/api/browser/tabs/close", POST({ id }));

// 帧流（SSE over fetch，同 runStream 的读法；面板可见时才订阅，关了就断）。
// native=1：桌面壳原生视图观众——后端不发 frame，只发 state/tabs/pointer。
export async function browserStream(
  onEvent: (ev: any) => void,
  signal?: AbortSignal,
  native = false,
): Promise<void> {
  const res = await hfetch(`/api/browser/stream${native ? "?native=1" : ""}`, { signal });
  if (!res.ok || !res.body) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  await readSse(res, onEvent);
}

// ── 特性探测（旧后端降级）────────────────────────────────────────────────────
export interface Features {
  sessions: boolean;
  files: boolean;
  projects: boolean;
}
// M10：服务端在 /api/info 里报了能力位就直接用（不再多打三个请求，其中一个是整页会话列表）；
// caps 为 null = M10 之前的后端，才挨个探端点。
export async function detectFeatures(caps?: string[] | null): Promise<Features> {
  if (caps) return featuresFromCaps(caps);
  // 不能只看 status：旧后端的 SPA 通配路由会把未知 /api/* 兜底成 200 HTML。
  // 真实的 API 一律回 JSON —— 按 content-type 判。
  const probe = async (path: string) => {
    try {
      const res = await hfetch(path, { method: "GET" });
      if (!res.ok) return false;
      return (res.headers.get("content-type") ?? "").includes("application/json");
    } catch {
      return false;
    }
  };
  const [sessions, files, projects] = await Promise.all([
    probe("/api/sessions"),
    probe("/api/files?path="),
    probe("/api/projects"),
  ]);
  return { sessions, files, projects };
}

// ── 运行（SSE over fetch）────────────────────────────────────────────────────
export interface RunBody {
  sessionId?: string | null;
  message: string;
  attachments?: string[];
  // M2（#51）：这一条的发送身份——断流后按它问「落地了没有」，同一个 id 重发不会起第二轮。
  clientRunId?: string;
  // M11（N33）：新会话带上界面此刻显示的配置（全局配置是「最后一个切前台的设备」写的，不能当成这台设备的选择）。
  // 旧服务端不认这个字段，照旧读全局。
  config?: RunConfig;
  // O7（K64）：这一条开一个目标（服务端能力位有 "goal" 才发）
  goal?: { verify?: string; maxRounds?: number; maxMinutes?: number };
  // 引用会话：被引用对话的 id（服务端能力位有 "session-refs" 才发）
  refs?: string[];
}

// O8（N39）：这个会话的用量账本（厂商 × 型号 × 任务；服务端能力位有 "usage-ledger" 才有）
export interface UsageRow {
  provider: string;
  model: string;
  task: "main" | "subagent" | "workflow" | "compaction" | "memory";
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
}
export const sessionUsage = (id: string) => j<{ rows: UsageRow[] }>(`/api/sessions/${encodeURIComponent(id)}/usage`);

// E3（G7）：输入框 / 面板的技能清单（服务端能力位有 "commands" 才有；内置命令在前端 lib/slash.ts）
export interface CommandList {
  skills: { name: string; description: string; pkg?: string; argumentHint?: string; userOnly?: boolean }[];
  packages: { name: string; count: number }[];
}
export const listCommands = () => j<CommandList>("/api/commands");

// O7：目标续跑的暂停 / 继续 / 结束（回当前的目标状态；结束 = null）
export const goalAction = (id: string, action: "pause" | "resume" | "clear") =>
  j<{ ok: boolean; goal: GoalView | null }>(`/api/sessions/${encodeURIComponent(id)}/goal`, POST({ action }));

export interface RunConfig {
  provider?: string;
  model?: string;
  thinking?: string;
  workspace?: string;
  access?: string;
  permissionMode?: string;
}

export async function runStream(
  body: RunBody,
  onEvent: (ev: any) => void,
  signal?: AbortSignal,
  onAlive?: () => void,
): Promise<void> {
  const res = await hfetch(withProto("/api/run"), { ...POST(body), signal });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    let b: any = null;
    try {
      b = await res.json();
      if (b?.error) msg = b.error;
    } catch { /* keep */ }
    // status：服务端明确拒收（这一条没起一轮）；body 里 duplicate_run 带着已落地的那一轮
    onEvent({ e: "error", message: msg, retriable: false, status: res.status, body: b });
    return;
  }
  await readSse(res, onEvent, onAlive);
}

// ── 工作区 Dock（审阅 / 终端 / 文件；SSE 事件一律 {e:"..."} 字段）──────────────
// 作用域：ws = 工作空间绝对路径优先；拿不到退 chatId，让后端按会话兜底其 workspace。
export interface DockScope {
  ws?: string;
  chatId?: string;
}
function dockQuery(scope: DockScope, extra?: Record<string, string>): string {
  const q = new URLSearchParams();
  if (scope.ws) q.set("ws", scope.ws);
  else if (scope.chatId) q.set("chatId", scope.chatId);
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

// 审阅：worktree 概览 + 单文件 unified diff（u=1 标记未跟踪文件）
export interface DockReviewFile {
  path: string;
  from?: string;
  add: number;
  del: number;
  bin: boolean;
  st: "A" | "D" | "M" | "R" | "C" | "U";
}
export interface DockReview {
  git: boolean;
  branch?: string;
  base?: string;
  files?: DockReviewFile[];
  total?: { add: number; del: number };
  truncated?: boolean;
}
export const dockReview = (scope: DockScope) => j<DockReview>(`/api/dock/review${dockQuery(scope)}`);
export const dockReviewDiff = (
  scope: DockScope,
  file: string,
  opts?: { from?: string; untracked?: boolean },
) =>
  j<{ diff: string; truncated: boolean; bin: boolean }>(
    `/api/dock/review/diff${dockQuery(scope, {
      file,
      ...(opts?.from ? { from: opts.from } : {}),
      ...(opts?.untracked ? { u: "1" } : {}),
    })}`,
  );

// U10（K38）：审阅「本会话」——基线 = 这个会话第一条消息之前；只列这个对话改过的文件（external = 它改完之后又在对话之外
// 被改过），可逐个撤销（退回会话开始之前，新建的删掉）。服务端能力位有 "session-review" 才可用。
export interface SessionReviewFile {
  path: string;
  st: "A" | "M" | "D";
  add: number;
  del: number;
  bin: boolean;
  external: boolean;
}
export type SessionReview =
  | { scope: "session"; available: false; reason: string }
  | {
      scope: "session";
      available: true;
      since: number;
      files: SessionReviewFile[];
      total: { add: number; del: number };
      truncated: boolean;
      others: number; // 这段时间里对话之外改过、这个对话没碰过的文件数（不列）
      busy: boolean; // 有会话在跑 / 正在回滚：现在撤销不了
    };
export const sessionReview = (chatId: string) =>
  j<SessionReview>(`/api/dock/review?${new URLSearchParams({ scope: "session", chatId })}`);
export const sessionReviewDiff = (chatId: string, file: string) =>
  j<{ diff: string; truncated: boolean; bin: boolean }>(`/api/dock/review/diff?${new URLSearchParams({ scope: "session", chatId, file })}`);
// 服务端拒绝（409）不抛，带回原因：running（有会话在跑）/ external（现在的内容不是这个对话留下的，人确认后带 force
// 再发）/ stale（列表过期）/ unavailable（没有检查点）
export type RestoreFilesResult =
  | { ok: true; restored: string[]; removed: string[]; undo?: { n: number } }
  | { ok: false; error: string; code?: string; external?: string[] };
export async function restoreFiles(id: string, paths: string[], force = false): Promise<RestoreFilesResult> {
  const res = await hfetch(`/api/sessions/${encodeURIComponent(id)}/files/restore`, { ...POST({ paths, force }), timeoutMs: 60_000 });
  let body: any = null;
  try {
    body = await res.json();
  } catch { /* keep status */ }
  if (res.ok) return { ok: true, restored: body?.restored ?? [], removed: body?.removed ?? [], undo: body?.undo };
  if (res.status === 409) {
    return { ok: false, error: body?.error ?? `HTTP ${res.status}`, code: body?.code, external: Array.isArray(body?.external) ? body.external : undefined };
  }
  const err = new Error(body?.error ?? `HTTP ${res.status}`) as Error & { status?: number };
  err.status = res.status;
  throw err;
}

// 文件：目录列表（shape 对齐 server/files.ts listDir）+ 原始文件内容 URL
export interface DockFileEntry {
  name: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}
export interface DockFileList {
  path: string;
  entries: DockFileEntry[];
  truncated: boolean;
}
export const dockFiles = (scope: DockScope, path: string) =>
  j<DockFileList>(`/api/dock/files${dockQuery(scope, { path })}`);
// <img>/<a> 这类浏览器直连 URL 带不了 Authorization 头，token 镜像进 query（同 artifactUrl）
export function dockFileUrl(scope: DockScope, path: string): string {
  const q = new URLSearchParams();
  if (scope.ws) q.set("ws", scope.ws);
  else if (scope.chatId) q.set("chatId", scope.chatId);
  q.set("path", path);
  setResourceToken(q);
  return `${apiBase()}/api/dock/file?${q}`;
}

// 终端：输入 16ms 微批上行；resize 去重上行；kill 后重连 = 新会话
export const dockTermInput = (scope: DockScope, data: string) =>
  j("/api/dock/term/input", POST({ ws: scope.ws, chatId: scope.chatId, data }));
export const dockTermResize = (scope: DockScope, cols: number, rows: number) =>
  j("/api/dock/term/resize", POST({ ws: scope.ws, chatId: scope.chatId, cols, rows }));
export const dockTermKill = (scope: DockScope) =>
  j("/api/dock/term/kill", POST({ ws: scope.ws, chatId: scope.chatId }));

// 终端输出流（SSE-over-fetch，readSse 复用）：hello/snapshot/data/exit。
// 返回 Promise 随流结束落地（EOF/断流/abort 都会 settle），重连策略由面板定。
export async function dockTermStream(
  scope: DockScope,
  cols: number,
  rows: number,
  onEvent: (ev: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await hfetch(
    `/api/dock/term/stream${dockQuery(scope, { cols: String(cols), rows: String(rows) })}`,
    { signal },
  );
  if (!res.ok || !res.body) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  await readSse(res, onEvent);
}
