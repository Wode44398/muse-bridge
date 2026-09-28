// 出站代理自适应。
//
// 背景：bridge 的出站请求（Claude Agent SDK 子进程、dimensio 的模型调用）在有些网络里必须经代理。
// Node 不读系统代理设置，只认 HTTP_PROXY/HTTPS_PROXY；代理一旦不在，出站就裸直连，模型网关按出口 IP
// 回 `403 forbidden: Request not allowed`——这条错在前端长得像鉴权失败，极易误判成 token 被封。
//
// 这里的目标：有没有本地代理都不出错（显式配了 HTTPS_PROXY 的，比如 Muse 部署，照配置走）。
//   · 探测本机常见的本地代理端口（7897/7890 等），活着就用它；
//   · 探不到就走直连——但**直连也必须先验证**，见下方 2026-08-24 判据重做；
//   · 本地代理后启动/换端口/退出都能在 60s 内自愈，不用重启 bridge。
//
// ── 2026-08-24 判据重做（实测驱动，harness/server/net-proxy.ts 同源）────────
// 生产日志里 `[net] 出站直连 ↔ 走代理` 交替了几十次。逐项实测后，**翻转不是探针在
// 抖**（经代理打探针累计 37/37 全通），站不住的是两个判据：
//   ① 探针目标没有判别力。旧探针 www.gstatic.com/generate_204 在国内是**时通时不
//      通**的目标——同一分钟直连三连测拿到「失败、失败、成功(57ms)」，它的 DNS 应答
//      里有能直连到达的 IP。既然直连也可能通，「经代理通」就证明不了「代理能出海」，
//      本来要防的「端口开着但节点全挂」根本防不住。实测有判别力（经代理 4/4 通、直
//      连 0/4 通）的是 www.google.com / clients3.google.com，任一通过即算通。
//   ② 「探不到代理就直连」是没验证过的假兜底。原注释写「TUN 模式下直连本来就是对
//      的」，但实测本机 TUN 网卡是 Disconnected，直连 googleapis 3/3 全死——误判一
//      次就从「能出海」切到「彻底不能出海」。现在直连也要先验证；验不通就粘住上次
//      可用配置，并如实报「当前无已验证出口」。
//   ③ 迟滞：从「代理可用」切到「直连」要连续 2 次判定才生效。
//   ④ validate() 每 60s new ProxyAgent 且从不释放，常驻进程句柄泄漏——现在用完即
//      destroy()（不是 close()，原因见 validateProxy 上方注释）。
//
// 生效面：
//   · 进程内 fetch —— setGlobalDispatcher(EnvHttpProxyAgent)，自动尊重 NO_PROXY；
//   · 子进程 —— 直接改 process.env，之后 spawn 的 claude.exe / codex / harness 继承。
//     注意：【已在跑】的常驻子进程（codex app-server、harness）不会热更新，代理状态
//     翻转后它们要重启才跟上。
//
// config.json 旋钮（都可选）：
//   outboundProxy: "auto"（默认）| "off" | "http://127.0.0.1:7897"（写死）
//   outboundProxyPorts: [7897, 7890]  —— 覆盖默认探测列表
// 启动时若环境里已有 HTTPS_PROXY（比如从带代理的终端手动起服务），视为「人工指定」，
// 本模块完全不插手。

import net from 'node:net';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { EnvHttpProxyAgent, Agent, setGlobalDispatcher, ProxyAgent } from 'undici';
import { CONFIG_PATH } from '../config/index.mjs';

const DEFAULT_PORTS = [7897, 7890, 7891, 10809, 1080, 8889];
const PROBE_TIMEOUT = 400;      // 本地端口，连不上就是没开——不用等
// 一轮探针的上限。经代理成功时实测 200~330ms，4s 已是 12 倍余量；打不通的目标只能
// 等满这个数（abort 未必能立刻掐断 DNS 阶段，实测一轮 6s 上限实际花了 ~10s）。
const VALIDATE_TIMEOUT = 4000;
// 整个 detect 的总预算。没有它的话，6 个端口全「开着但坏」时一轮探测就能顶穿 60s
// 刷新周期、让两轮叠在一起。超时按 unknown 处理 → 走粘滞，不会误切出口。
const DETECT_BUDGET_MS = 25_000;
const REFRESH_MS = 60_000;
const DIRECT_HYSTERESIS = 2;    // 从「有代理」切到「直连」需要连续几次判定

// 判据的全部要害：这些目标在国内**直连打不通**（实测 0/4），所以「经某条出口能通」
// 才真正等价于「这条出口能出海」。任一通过即算通。反面教材见文件头 ①。
const PROBE_URLS = String(
  process.env.BRIDGE_PROXY_PROBES ||
  'http://www.google.com/generate_204,http://clients3.google.com/generate_204',
).split(',').map((s) => s.trim()).filter(Boolean);

let state = {
  mode: 'init',   // 'auto' | 'pinned' | 'off' | 'manual' | 'init'
  proxy: '',      // 生效的代理 URL，'' = 直连
  checkedAt: 0,
  reason: '',
  verified: false, // 最近一轮是否拿到「已验证可出海」的结论
};
let lastGood = '';     // 上一个验证通过的代理；探测无结论时粘住它
let directStreak = 0;  // 连续判定为「直连可用」的次数（迟滞用）

function cfg() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// 本机自己的 LAN 地址要绕过代理：手机直连、预览子域等都是内网流量。
function noProxyList() {
  const hosts = ['localhost', '127.0.0.1', '::1', '.local'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) hosts.push(ni.address);
  }
  return hosts.join(',');
}

// 端口活着吗。TCP 连上即可——本地端口被占用的误判概率远低于每次都发 HTTP 探针的开销，
// 真假由后面的 validate() 兜底。
function portAlive(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(PROBE_TIMEOUT, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// 经给定 dispatcher 打一轮探针；任一目标 204/200 即算能出海。
// **并发**跑而不是逐个试：串行的话单次验证上限 = 目标数 × VALIDATE_TIMEOUT，6 个端口
// 全「开着但坏」时 detect 会超过 60s 的刷新周期、两轮叠在一起。并发把整轮压回一个超时。
async function reachable(dispatcher) {
  const ac = new AbortController();
  const probes = PROBE_URLS.map(async (url) => {
    const r = await fetch(url, { dispatcher, signal: ac.signal, redirect: 'manual' });
    if (r.status !== 204 && r.status !== 200) throw new Error('HTTP ' + r.status);
    return true;
  });
  // 每个都先挂一个吞异常的 catch：下面用 race 提前离场后，落单的拒绝不能变成
  // unhandledRejection 把进程带走。
  for (const p of probes) p.catch(() => {});

  let timer;
  try {
    // 超时必须能**直接赢下 race**：signal.abort() 掐不断已经进入 DNS/connect 阶段的
    // 请求（实测 4s 的 abort，Promise.any 仍等到 10.3s 才回），只靠 abort 会让一轮
    // 探测远超预算。被抛下的请求随后自己 abort 掉即可。
    return await Promise.race([
      Promise.any(probes).then(() => true, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), VALIDATE_TIMEOUT); }),
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
async function validateProxy(url) {
  const agent = new ProxyAgent(url);
  try { return await reachable(agent); }
  finally { await agent.destroy().catch(() => {}); }
}

// 直连能不能出海——不再假设「TUN 兜底一定行」，实测说了算。
async function validateDirect() {
  const agent = new Agent();
  try { return await reachable(agent); }
  finally { await agent.destroy().catch(() => {}); }
}

function applyProxy(url) {
  if (url) {
    process.env.HTTP_PROXY = url;
    process.env.HTTPS_PROXY = url;
    process.env.http_proxy = url;
    process.env.https_proxy = url;
    process.env.NO_PROXY = noProxyList();
    process.env.no_proxy = process.env.NO_PROXY;
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } else {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
    setGlobalDispatcher(new Agent());
  }
}

// 一轮探测的结论。'unknown' = 代理与直连都没验证通过，此时不该动配置。
// config 的 off/pinned 每轮现读，所以改 config.json 无需重启即可在 60s 内生效。
async function detect() {
  const c = cfg();
  const raw = String(c.outboundProxy || 'auto').trim();

  if (raw === 'off') return { kind: 'off', proxy: '', reason: 'config.outboundProxy=off，强制直连' };
  if (raw && raw !== 'auto') return { kind: 'pinned', proxy: raw, reason: 'config.outboundProxy 写死' };

  const envPorts = String(process.env.BRIDGE_PROXY_PORTS || '').split(',').map(Number).filter(Boolean);
  const ports = envPorts.length ? envPorts
    : (Array.isArray(c.outboundProxyPorts) && c.outboundProxyPorts.length
      ? c.outboundProxyPorts.map(Number).filter(Boolean) : DEFAULT_PORTS);

  const deadline = Date.now() + DETECT_BUDGET_MS;
  for (const port of ports) {
    if (Date.now() >= deadline) return { kind: 'unknown', proxy: '', reason: '探测超时（端口候选未试完）' };
    if (!(await portAlive(port))) continue;
    const url = 'http://127.0.0.1:' + port;
    if (await validateProxy(url)) return { kind: 'proxy', proxy: url, reason: '探测到可用本地代理' };
    // 端口开着但出不去：多半是本地代理在但它的上游挂了。继续试下一个端口。
  }

  if (Date.now() >= deadline) return { kind: 'unknown', proxy: '', reason: '探测超时（未及验证直连）' };
  // 没有可用代理。**先验证直连真能出海再宣布直连**——旧代码在这里直接假设 TUN 会
  // 兜底，实测本机 TUN 是断开的，那一步等于主动切进「完全不能出海」。
  if (await validateDirect()) {
    return { kind: 'direct', proxy: '', reason: '无可用代理，直连已验证可出海（TUN / 已直通的网络）' };
  }
  return { kind: 'unknown', proxy: '', reason: '代理与直连均未验证通过' };
}

/**
 * 纯状态机：拿一轮探测结论 + 当前状态，决定下一步。抽出来是为了能单测迟滞与粘滞
 * ——这两条恰恰最难靠手工复现（生产上的翻转窗口可遇不可求）。
 */
export function decideOutbound(cur, d, ctx) {
  if (d.kind === 'proxy') {
    return { proxy: d.proxy, reason: d.reason, verified: true, directStreak: 0, lastGood: d.proxy };
  }
  if (d.kind === 'direct') {
    // 迟滞：正用着代理时，要连续 DIRECT_HYSTERESIS 次判定为直连才真切过去。
    const streak = ctx.directStreak + 1;
    if (cur.proxy && streak < DIRECT_HYSTERESIS) {
      return {
        proxy: cur.proxy,
        reason: '直连已验证可用，但仍在迟滞观察（' + streak + '/' + DIRECT_HYSTERESIS + '），暂保持代理',
        verified: true, directStreak: streak, lastGood: ctx.lastGood,
      };
    }
    return { proxy: '', reason: d.reason, verified: true, directStreak: streak, lastGood: ctx.lastGood };
  }
  // unknown：两条路都没验证通过。**不动配置**——把当前用着的粘住；当前若是直连而历
  // 史上有过可用代理，回退到那个代理（它可能只是这一轮探针没打通）。
  const keep = cur.proxy || ctx.lastGood;
  return {
    proxy: keep,
    reason: keep ? d.reason + '；保持上次可用配置 ' + keep : d.reason + '；当前无已验证出口，暂按直连处理',
    verified: false, directStreak: 0, lastGood: ctx.lastGood,
  };
}

async function refresh(quiet = false) {
  if (state.mode === 'manual') return state;
  let d;
  try { d = await detect(); } catch (e) { d = { kind: 'unknown', proxy: '', reason: '探测失败：' + ((e && e.message) || e) }; }

  // off / pinned 是人意，直接照办，不走状态机。
  if (d.kind === 'off' || d.kind === 'pinned') {
    const changed = d.proxy !== state.proxy || d.kind !== state.mode;
    state = { mode: d.kind, proxy: d.proxy, reason: d.reason, verified: false, checkedAt: Date.now() };
    if (changed) {
      applyProxy(d.proxy);
      if (!quiet) console.log('[net] 出站' + (d.proxy ? '走代理 ' + d.proxy : '直连') + '（' + d.reason + '）');
    }
    return state;
  }

  const next = decideOutbound({ proxy: state.proxy, mode: state.mode }, d, { lastGood, directStreak });
  directStreak = next.directStreak;
  lastGood = next.lastGood;

  const changed = next.proxy !== state.proxy || state.mode !== 'auto';
  const reasonChanged = next.reason !== state.reason;
  state = { mode: 'auto', proxy: next.proxy, reason: next.reason, verified: next.verified, checkedAt: Date.now() };
  if (changed) applyProxy(next.proxy);
  // 只在真换了出口、或理由变了（例如掉进 unknown）时说话，别把日志刷成噪音。
  if (!quiet && (changed || reasonChanged)) {
    console.log('[net] 出站' + (next.proxy ? '走代理 ' + next.proxy : '直连') + '（' + next.reason + '）');
  }
  return state;
}

// 启动时调用一次，然后每分钟自愈一次（本地代理后开 / 换端口 / 退出都能跟上）。
export async function initOutboundProxy() {
  const preset = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (preset) {
    state = { mode: 'manual', proxy: preset, checkedAt: Date.now(), reason: '沿用启动环境里已有的代理设置' };
    if (!process.env.NO_PROXY) { process.env.NO_PROXY = noProxyList(); process.env.no_proxy = process.env.NO_PROXY; }
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log('[net] 出站走代理 ' + preset + '（环境变量已指定，不自动探测）');
    return state;
  }
  await refresh();
  setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS).unref?.();
  return state;
}

// 状态查询（给 /api/admin/status 和错误提示用）。
export function outboundProxyStatus() {
  return { mode: state.mode, proxy: state.proxy, reason: state.reason, checkedAt: state.checkedAt, verified: state.verified };
}

// 出海失败时按当前出站状态给一句人话。403 "Request not allowed" 是 Anthropic 按出口
// IP 拒绝，前端会显示成 "Failed to authenticate"，务必别让人再去查 token。
export function outboundHint(err) {
  const msg = String((err && (err.message || err)) || '');
  if (!/Request not allowed|403/.test(msg)) return '';
  if (state.proxy) {
    return '（出站正走代理 ' + state.proxy + '，但仍被网关拒绝——多半是代理节点所在地区不被支持，换个节点试试）';
  }
  // verified=false 的直连 ≠ 「TUN 兜底中」，而是「压根没验证出可用出口」——别再让人
  // 以为直连是正常状态（2026-08-24：实测 TUN 断开时直连 googleapis 100% 失败）。
  return state.verified
    ? '（当前是直连出站且已验证可出海，但仍被网关拒绝——多半是出口 IP 所在地区不被支持）'
    : '（当前没有已验证的出口：本地代理端口探不到、直连也打不通探针。请检查出站代理（HTTPS_PROXY）或本地代理端口，bridge 会在 1 分钟内自动接上）';
}

// 立刻重新探测一次（刚改了代理想马上生效时用）。
export function recheckOutboundProxy() { return refresh(); }
