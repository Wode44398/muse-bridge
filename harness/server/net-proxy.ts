// 出站代理自适应 —— 移植 bridge 的 src/runtime/net-proxy.mjs（病根与修法同源）。
//
// 旧行为：启动时环境里有 HTTP(S)_PROXY 才装一次 EnvHttpProxyAgent——那是 bridge
// spawn 本进程那一刻的快照。本机代理抖动 / 开机晚启动 / bridge 每 60s 自愈翻转，
// 常驻的 harness 都跟不上：WebSearch 的 Gemini 后端（googleapis）和 WebFetch 在
// 国内网络直连即整批 fetch failed（2026-08-05、08-09 两次实锤，后者正是全栈停机
// 重启日）。现在 harness 自己探测本地代理端口、验证出海、每分钟自愈；代理状态
// 同时写回 process.env，Bash 子进程经 childEnv 透传即时跟随。
//
// ── 2026-08-24 判据重做（实测驱动）────────────────────────────────────────
// 生产日志里 `[net] 出站直连 ↔ 走代理` 交替了几十次。逐项实测后，**翻转不是探针
// 在抖**（经代理打探针累计 37/37 全通，均 200~330ms），真正站不住的是两个判据：
//
//   ① 探针目标没有判别力。旧探针 `www.gstatic.com/generate_204` 在国内是**时通时
//      不通**的目标——同一分钟内直连三连测拿到「失败、失败、成功(57ms)」，因为它
//      的 DNS 应答轮询里有能直连到达的 IP。既然直连也可能通，那「经代理通」就证明
//      不了「这个代理能出海」，注释里原本要防的「端口开着但节点全挂」根本防不住。
//      实测有判别力（经代理 4/4 通、直连 0/4 通）的目标：www.google.com、
//      clients3.google.com。改用它们，且任一通过即算通（取或，避免单点抖动）。
//
//   ② 「探不到代理就直连」是没验证过的假兜底。原注释说「TUN 场景直连本就正确」，
//      但实测本机 TUN 网卡（LetsTAP）是 Disconnected，直连 googleapis 3/3 全死。
//      也就是说一旦误判，就会从「能出海」切到「彻底不能出海」。现在**直连也要先
//      验证**：验通了才敢宣布直连；验不通就保持上一次的配置（粘滞），并把「当前
//      没有可用出口」如实说出来，而不是假装直连可用。
//
//   ③ 迟滞：从「代理可用」切到「直连」要连续 2 次判定才生效，单次抖动不翻。
//   ④ validate() 旧实现每 60s `new ProxyAgent()` 且从不释放——常驻进程的句柄泄漏。
//      现在用完即 destroy()（不是 close()，原因见 validateProxy 上方注释）。

import net from "node:net";
import os from "node:os";
import { Agent, DecoratorHandler, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { currentTrace, SPAN_HEADER, TRACE_HEADER, type TraceContext } from "./trace.ts";
import { traceEvent } from "./trace-log.ts";

const DEFAULT_PORTS = [7897, 7890, 7891, 10809, 1080, 8889];
const PROBE_TIMEOUT = 400; // 本地端口，连不上就是没开——不用等
// 一轮探针的上限。经代理成功时实测 200~330ms，4s 已是 12 倍余量；打不通的目标只能
// 等满这个数（abort 未必能立刻掐断 DNS 阶段，实测一轮 6s 上限实际花了 ~10s）。
const VALIDATE_TIMEOUT = 4000;
// 整个 detect 的总预算。没有它的话，6 个端口全「开着但坏」时一轮探测就能顶穿 60s
// 刷新周期、让两轮叠在一起。超时按 unknown 处理 → 走粘滞，不会误切出口。
const DETECT_BUDGET_MS = 25_000;
const REFRESH_MS = 60_000;
/** 从「有代理」切到「直连」需要连续几次判定。 */
const DIRECT_HYSTERESIS = 2;

// 判据的全部要害：这些目标在国内**直连打不通**（实测 0/4），所以「经某条出口能通」
// 才真正等价于「这条出口能出海」。任一通过即算通。
// 反面教材见文件头 ①：www.gstatic.com 直连时通时不通，不能用。
const PROBE_URLS = (process.env.BRIDGE_PROXY_PROBES || "http://www.google.com/generate_204,http://clients3.google.com/generate_204")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface ProxyState {
  mode: "init" | "auto" | "pinned" | "off";
  proxy: string; // 生效的代理 URL，'' = 直连
  reason: string;
  checkedAt: number;
  /** 最近一次判定是否拿到了「已验证可出海」的结论（诊断用）。 */
  verified?: boolean;
}

let state: ProxyState = { mode: "init", proxy: "", reason: "", checkedAt: 0 };
/** 上一个验证通过的代理；探测无结论时粘住它。 */
let lastGood = "";
let directStreak = 0;

// 本机自己的 LAN 地址要绕过代理：CDP、本地预览、局域网直连都是内网流量。
function noProxyList(): string {
  const hosts = ["localhost", "127.0.0.1", "::1", ".local"];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) hosts.push(ni.address);
    }
  }
  return hosts.join(",");
}

function portAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(PROBE_TIMEOUT, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * 经给定 dispatcher 打一轮探针；任一目标 204/200 即算能出海。
 * **并发**跑而不是逐个试：串行的话单次验证上限 = 目标数 × VALIDATE_TIMEOUT，6 个端口
 * 全「开着但坏」时 detect 会超过 60s 的刷新周期、两轮叠在一起。并发把整轮压回一个超时。
 */
async function reachable(dispatcher: unknown): Promise<boolean> {
  const ac = new AbortController();
  const probes = PROBE_URLS.map(async (url) => {
    const r = await fetch(url, {
      // @ts-expect-error undici dispatcher option on global fetch
      dispatcher,
      signal: ac.signal,
      redirect: "manual",
    });
    if (r.status !== 204 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return true;
  });
  // 每个都先挂一个吞异常的 catch：下面用 race 提前离场后，落单的拒绝不能变成
  // unhandledRejection 把进程带走。
  for (const p of probes) p.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  try {
    // 超时必须能**直接赢下 race**：signal.abort() 掐不断已经进入 DNS/connect 阶段的
    // 请求（实测 4s 的 abort，Promise.any 仍等到 10.3s 才回），只靠 abort 会让一轮
    // 探测远超预算。被抛下的请求随后自己 abort 掉即可。
    return await Promise.race([
      Promise.any(probes).then(
        () => true,
        () => false, // AggregateError = 全部目标都没通
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), VALIDATE_TIMEOUT);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    ac.abort(); // 收掉还在飞的那几个
  }
}

// 端口开着 ≠ 能出海（节点全挂、订阅过期都可能）。
// 用完必须 destroy() 不能 close()：close() 会**优雅等待在途请求结束**，而被 abort 的
// 探针要等 TCP 自己超时——实测同一轮探测 close() 花 10.4s、destroy() 只花 4.0s（正好
// 等于 VALIDATE_TIMEOUT）。旧实现连关都不关，是常驻进程的句柄泄漏。
async function validateProxy(url: string): Promise<boolean> {
  const agent = new ProxyAgent(url);
  try {
    return await reachable(agent);
  } finally {
    await agent.destroy().catch(() => {});
  }
}

/** 直连能不能出海——不再假设「TUN 兜底一定行」，实测说了算。 */
async function validateDirect(): Promise<boolean> {
  const agent = new Agent();
  try {
    return await reachable(agent);
  } finally {
    await agent.destroy().catch(() => {});
  }
}

// ── Q12（F2）：全局出站拦截 ──────────────────────────────────────────────────────────────────────────
// 一轮 trace 里发出的每个请求记一行元数据（方法、主机 + 路径——不带查询串，里面可能有 key——状态码、耗时、出自哪个 span）
// 进会话的事件日志；只有模型调用（model span）加关联头（中继 / 自建模型服务的日志能据此对上这一轮），WebFetch 访问的
// 任意网站不带。不在任何 trace 里的请求（探测、后台任务）原样放行。
function withTraceHeaders(headers: Dispatcher.DispatchOptions["headers"], t: TraceContext): Dispatcher.DispatchOptions["headers"] {
  const extra: [string, string][] = [[TRACE_HEADER, t.traceId], [SPAN_HEADER, t.spanId]];
  if (!headers) return Object.fromEntries(extra);
  if (Array.isArray(headers)) {
    // 扁平数组 [k, v, k, v, …]，或成对数组 [[k, v], …]
    return (Array.isArray(headers[0]) ? [...headers, ...extra] : [...headers, ...extra.flat()]) as Dispatcher.DispatchOptions["headers"];
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === "function") {
    return [...(headers as Iterable<[string, string]>), ...extra] as Dispatcher.DispatchOptions["headers"];
  }
  return { ...(headers as Record<string, string>), [TRACE_HEADER]: t.traceId, [SPAN_HEADER]: t.spanId };
}

// DecoratorHandler 把老式处理器（onConnect / onHeaders …）规整成新接口；外面这层只看状态码与收尾，其余原样转交
function tracedHandler(handler: Dispatcher.DispatchHandler, done: (status: number, error?: Error) => void): Dispatcher.DispatchHandler {
  const inner = new DecoratorHandler(handler) as Dispatcher.DispatchHandler;
  let status = 0;
  return {
    onRequestStart: (controller, context) => inner.onRequestStart?.(controller, context),
    onRequestUpgrade: (controller, statusCode, headers, socket) => inner.onRequestUpgrade?.(controller, statusCode, headers, socket),
    onResponseStart: (controller, statusCode, headers, statusMessage) => {
      status = statusCode;
      return inner.onResponseStart?.(controller, statusCode, headers, statusMessage);
    },
    onResponseData: (controller, chunk) => inner.onResponseData?.(controller, chunk),
    onResponseEnd: (controller, trailers) => {
      done(status);
      return inner.onResponseEnd?.(controller, trailers);
    },
    onResponseError: (controller, error) => {
      done(status, error);
      return inner.onResponseError?.(controller, error);
    },
  };
}

const traceInterceptor: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
  const t = currentTrace();
  if (!t) return dispatch(opts, handler);
  const started = Date.now();
  const url = `${String(opts.origin ?? "")}${String(opts.path ?? "").split("?")[0]}`;
  const log = (status: number, error?: Error) => {
    traceEvent(t.sessionId, {
      e: "http",
      method: opts.method,
      url,
      status,
      durationMs: Date.now() - started,
      ...(t.kind !== "run" ? { from: `${t.kind}${t.name ? `:${t.name}` : ""}` } : {}),
      ...(error ? { error: error.message } : {}),
    }, t);
  };
  const next = t.kind === "model" ? { ...opts, headers: withTraceHeaders(opts.headers, t) } : opts;
  return dispatch(next, tracedHandler(handler, log));
};

export function tracedDispatcher(base: Dispatcher): Dispatcher {
  return base.compose(traceInterceptor);
}

function applyProxy(url: string): void {
  if (url) {
    process.env.HTTP_PROXY = url;
    process.env.HTTPS_PROXY = url;
    process.env.http_proxy = url;
    process.env.https_proxy = url;
    process.env.NO_PROXY = noProxyList();
    process.env.no_proxy = process.env.NO_PROXY;
    setGlobalDispatcher(tracedDispatcher(new EnvHttpProxyAgent()));
  } else {
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      delete process.env[k];
    }
    setGlobalDispatcher(tracedDispatcher(new Agent()));
  }
}

/** 一轮探测的结论。unknown = 代理与直连都没验证通过，此时不该动配置。 */
export type Detection =
  | { kind: "proxy"; proxy: string; reason: string }
  | { kind: "direct"; reason: string }
  | { kind: "unknown"; reason: string };

async function detect(): Promise<Detection> {
  const deadline = Date.now() + DETECT_BUDGET_MS;
  const spent = () => Date.now() >= deadline;

  // 继承的环境代理当第一候选：独立开发从带代理的终端起 8799 时立即命中。
  const inherited =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (inherited && (await validateProxy(inherited))) {
    return { kind: "proxy", proxy: inherited, reason: "环境代理验证可用" };
  }

  const envPorts = String(process.env.BRIDGE_PROXY_PORTS || "")
    .split(",")
    .map(Number)
    .filter(Boolean);
  const ports = envPorts.length ? envPorts : DEFAULT_PORTS;
  for (const port of ports) {
    if (spent()) return { kind: "unknown", reason: "探测超时（端口候选未试完）" };
    if (!(await portAlive(port))) continue;
    const url = `http://127.0.0.1:${port}`;
    if (await validateProxy(url)) return { kind: "proxy", proxy: url, reason: "探测到可用本地代理" };
    // 端口开着但出不去：多半是代理在但上游挂了。继续试下一个端口。
  }

  if (spent()) return { kind: "unknown", reason: "探测超时（未及验证直连）" };
  // 没有可用代理。**先验证直连真能出海再宣布直连**——旧代码在这里直接假设 TUN
  // 会兜底，实测本机 TUN 是断开的，那一步等于主动切进「完全不能出海」。
  if (await validateDirect()) {
    return { kind: "direct", reason: "无可用代理，直连已验证可出海（TUN / 已直通的网络）" };
  }
  return { kind: "unknown", reason: "代理与直连均未验证通过" };
}

/**
 * 纯状态机：拿一轮探测结论 + 当前状态，决定下一步。抽出来是为了能单测迟滞与粘滞
 * ——这两条恰恰是最难靠手工复现的（生产上的翻转窗口可遇不可求）。
 */
export function decideOutbound(
  cur: { proxy: string; mode: ProxyState["mode"] },
  d: Detection,
  ctx: { lastGood: string; directStreak: number },
): { proxy: string; reason: string; verified: boolean; directStreak: number; lastGood: string } {
  if (d.kind === "proxy") {
    return { proxy: d.proxy, reason: d.reason, verified: true, directStreak: 0, lastGood: d.proxy };
  }

  if (d.kind === "direct") {
    // 迟滞：正用着代理时，要连续 DIRECT_HYSTERESIS 次判定为直连才真切过去。
    const streak = ctx.directStreak + 1;
    if (cur.proxy && streak < DIRECT_HYSTERESIS) {
      return {
        proxy: cur.proxy,
        reason: `直连已验证可用，但仍在迟滞观察（${streak}/${DIRECT_HYSTERESIS}），暂保持代理`,
        verified: true,
        directStreak: streak,
        lastGood: ctx.lastGood,
      };
    }
    return { proxy: "", reason: d.reason, verified: true, directStreak: streak, lastGood: ctx.lastGood };
  }

  // unknown：两条路都没验证通过。这时候**不动配置**——把当前用着的粘住；如果当前
  // 是直连而历史上有过可用代理，回退到那个代理（它可能只是探针这一轮没打通）。
  const keep = cur.proxy || ctx.lastGood;
  return {
    proxy: keep,
    reason: keep
      ? `${d.reason}；保持上次可用配置 ${keep}`
      : `${d.reason}；当前无已验证出口，暂按直连处理`,
    verified: false,
    directStreak: 0,
    lastGood: ctx.lastGood,
  };
}

async function refresh(): Promise<ProxyState> {
  if (state.mode === "pinned" || state.mode === "off") return state;
  let d: Detection;
  try {
    d = await detect();
  } catch (e) {
    d = { kind: "unknown", reason: `探测失败：${(e as Error)?.message ?? e}` };
  }

  const next = decideOutbound({ proxy: state.proxy, mode: state.mode }, d, { lastGood, directStreak });
  directStreak = next.directStreak;
  lastGood = next.lastGood;

  const changed = next.proxy !== state.proxy;
  const reasonChanged = next.reason !== state.reason;
  state = { mode: "auto", proxy: next.proxy, reason: next.reason, verified: next.verified, checkedAt: Date.now() };
  if (changed) applyProxy(next.proxy);
  // 只在真的换了出口、或理由变了（例如掉进 unknown）时说话，别把日志刷成噪音。
  if (changed || reasonChanged) {
    console.log(`[net] 出站${next.proxy ? `走代理 ${next.proxy}` : "直连"}（${next.reason}）`);
  }
  return state;
}

// 启动时调用一次，之后每分钟自愈（代理后开 / 换端口 / 上游恢复都能跟上）。
export async function initOutboundProxy(): Promise<ProxyState> {
  const knob = (process.env.DIMENSIO_OUTBOUND_PROXY ?? "auto").trim();
  if (knob === "off") {
    state = { mode: "off", proxy: "", reason: "DIMENSIO_OUTBOUND_PROXY=off，强制直连", checkedAt: Date.now() };
    applyProxy("");
    console.log(`[net] 出站直连（${state.reason}）`);
    return state;
  }
  if (knob && knob !== "auto") {
    state = { mode: "pinned", proxy: knob, reason: "DIMENSIO_OUTBOUND_PROXY 写死", checkedAt: Date.now() };
    applyProxy(knob);
    console.log(`[net] 出站走代理 ${knob}（${state.reason}）`);
    return state;
  }
  // Q12：探测出结论之前（以及探不出结论时）也挂上出站拦截——Node 默认的 fetch 本来就是直连，换成带拦截的直连等价
  setGlobalDispatcher(tracedDispatcher(new Agent()));
  await refresh();
  setInterval(() => {
    refreshOnce().catch(() => {});
  }, REFRESH_MS).unref();
  return state;
}

// 同一时刻只跑一轮探测：定时自愈、手动重探、loop 撞上连接失败时的催促共用这一轮。
let refreshing: Promise<ProxyState> | null = null;
function refreshOnce(): Promise<ProxyState> {
  refreshing ??= refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// 状态查询（诊断用）。
export function outboundProxyStatus(): ProxyState {
  return state;
}

/** 立刻重探一轮（诊断/手动自愈用）。 */
export async function recheckOutboundProxy(): Promise<ProxyState> {
  return refreshOnce();
}

/**
 * R3：loop 撞上连接失败时叫一声，不等结果。只在自适应模式下生效（写死 / 关闭 / 还没初始化——例如
 * 测试进程——都不动），正在探测就并进那一轮。
 */
export function nudgeOutboundProxy(): void {
  if (state.mode !== "auto") return;
  refreshOnce().catch(() => {});
}
