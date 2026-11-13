// 模型上游的连接保温——bridge 服务进程与 dimensio harness 共用（harness 经 core-link 取）。
//
// 病根（2026-11-12 实测，undici 7.29 经 Clash）：undici 的连接空闲 4 秒就丢，主流模型上游又都不回 Keep-Alive 头，
// 用户读回复、打字、工具跑过 4 秒后，下一次模型请求必然重新建隧道 + TLS 握手：Anthropic +0.45s、OpenRouter +0.5–1.1s、
// Gemini +0.4–1.1s、Vertex +1.2–2.3s，出口节点差时 3 秒以上。国内上游握手只有几十毫秒，无感。
// 只把 keepAliveTimeout 调大不够：Google / xAI 约 4 分钟、国内几家 30–90 秒就由对端回收，所以还要心跳。
//
// 三样东西：
//   KEEPALIVE         建 Agent / EnvHttpProxyAgent 时传的连接池参数；
//   withWarm(base)    给 dispatcher 套一层：见到模型请求就登记这个上游，之后每 20 秒发一次不带任何凭据的 GET 保温，
//                     距最后一次真实请求 15 分钟停；
//   fetchReconnect()  撞上已死的连接（对端 / 代理没打招呼就掐了）时立刻原样重发一次，不睡、不换线路。
//
// 本文件不 import undici（harness 与 bridge 各有各的 undici 实例；只用 dispatcher 自己的 compose / request），也没有顶层 await。

export const KEEPALIVE = Object.freeze({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });

const BEAT_MS = 20_000;          // 心跳间隔（< keepAliveTimeout，也 < 各家对端的空闲回收时间）
const IDLE_STOP_MS = 15 * 60_000; // 距最后一次真实请求多久停止保温
const MAX_ORIGINS = 8;
const BEAT_TIMEOUT_MS = 8_000;

// 只登记「模型请求」：WebFetch、拉模型列表、探测之类的杂请求不保温。
// /messages 只认 /v1/messages（各家的 Anthropic 入口都是这个形状）：MCP 的 SSE 传输也是 POST …/messages?sessionId=…，不是模型请求。
const MODEL_PATH = /\/v1\/messages(?:\?|$)|\/(?:chat\/completions|responses)(?:\?|$)|:(?:streamGenerateContent|generateContent)(?:\?|$)/;
const LOCAL_HOST = /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

/**
 * 真实请求的路径 → 心跳用的路径：同一个 origin 上不带凭据的轻 GET，401 / 403 / 404 都算保温成功。
 * 打的是一个不存在的型号（…/models/-），不是模型列表：OpenRouter 的列表不要凭据、一次 856KB，
 * 既费流量，读不完还会把连接搞断。实测各家对它都只回几十到几百字节，回完连接照留。
 */
export function beatPath(path) {
  const p = String(path || '/').split('?')[0];
  let m = /^(.*)\/(?:messages|chat\/completions|responses)$/.exec(p);
  if (m) return (m[1] || '') + '/models/-';
  m = /^(.*\/models)\/[^/]+:(?:streamGenerateContent|generateContent)$/.exec(p);
  if (m) return m[1] + '/-';
  return '/';
}

/** 这个请求要不要登记保温。 */
export function isModelRequest(opts) {
  if (!opts || String(opts.method || 'GET').toUpperCase() !== 'POST') return false;
  if (!MODEL_PATH.test(String(opts.path || ''))) return false;
  let host = '';
  try { host = new URL(String(opts.origin)).hostname; } catch { return false; }
  return !!host && !LOCAL_HOST.test(host);
}

const warmers = new Set();
let timer = null;
const stats = { beats: 0, beatFails: 0 };

function ensureTimer() {
  if (timer || process.env.BRIDGE_UPSTREAM_WARM === '0') return;
  timer = setInterval(tick, BEAT_MS);
  timer.unref?.();
}

async function beat(w, origin, e) {
  if (e.busy) return;
  e.busy = true;
  stats.beats += 1;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), BEAT_TIMEOUT_MS);
  try {
    // 绝不能用 HEAD：undici 发完 HEAD 就关连接（实测），等于白保。
    const r = await w.base.request({ origin, path: e.path, method: 'GET', headers: { accept: 'application/json' }, signal: ac.signal });
    await r.body.dump().catch(() => {});
  } catch {
    // 连不上 / 超时：摘掉，不重试。下一次真实请求会重新登记。
    stats.beatFails += 1;
    if (w.origins.get(origin) === e) w.origins.delete(origin);
  } finally {
    clearTimeout(t);
    e.busy = false;
  }
}

function tick() {
  const now = Date.now();
  let live = 0;
  for (const w of warmers) {
    for (const [origin, e] of w.origins) {
      if (now - e.last > IDLE_STOP_MS) { w.origins.delete(origin); continue; }
      live += 1;
      // 刚有真实流量的不用打：连接自己就是热的
      if (now - Math.max(e.last, e.beatAt) >= BEAT_MS - 1000) { e.beatAt = now; beat(w, origin, e); }
    }
    if (!w.origins.size && w.stopped) warmers.delete(w);
  }
  if (!live && timer) { clearInterval(timer); timer = null; }
}

/**
 * 给 dispatcher 套上保温：返回的 dispatcher 行为与 base 完全一样，只是会记下它见过的模型上游并替它们保温。
 * 返回值上挂 stopWarm()：换出口、弃用这个 dispatcher 时调，停掉它名下的心跳（否则旧连接池会被心跳一直吊着）。
 */
export function withWarm(base) {
  const w = { base, origins: new Map(), stopped: false };
  warmers.add(w);
  const out = base.compose((dispatch) => (opts, handler) => {
    if (!w.stopped && isModelRequest(opts)) {
      const origin = String(opts.origin).replace(/\/+$/, '');
      const e = w.origins.get(origin);
      if (e) { e.last = Date.now(); w.origins.delete(origin); w.origins.set(origin, e); }   // 挪到最新
      else {
        if (w.origins.size >= MAX_ORIGINS) w.origins.delete(w.origins.keys().next().value);
        w.origins.set(origin, { path: beatPath(opts.path), last: Date.now(), beatAt: 0, busy: false });
      }
      ensureTimer();
    }
    return dispatch(opts, handler);
  });
  out.stopWarm = () => { w.stopped = true; w.origins.clear(); warmers.delete(w); };
  return out;
}

/** 弃用一个 dispatcher：停心跳并优雅关闭（在飞的请求跑完才真关；调大 keep-alive 后不能再指望它 4 秒自己死）。 */
export function retireDispatcher(d) {
  if (!d) return;
  try { d.stopWarm?.(); } catch {}
  try { Promise.resolve(d.close?.()).catch(() => {}); } catch {}
}

/** 现在保温着哪些上游（给状态接口 / 日志用）。 */
export function warmStatus() {
  const now = Date.now();
  const origins = [];
  for (const w of warmers) for (const [origin, e] of w.origins) origins.push({ origin, idleSec: Math.round((now - e.last) / 1000) });
  return { origins, beats: stats.beats, beatFails: stats.beatFails };
}

const DEAD_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
function deadCode(e) {
  for (let x = e, i = 0; x && i < 4; x = x.cause, i++) if (x.code && DEAD_CODES.has(x.code)) return x.code;
  return '';
}
const replayable = (b) => b == null || typeof b === 'string' || b instanceof Uint8Array || b instanceof ArrayBuffer;

const DEAD_FAST_MS = 2000;
/**
 * fetch，外加「撞上死连接立刻重发一次」。长连接被对端或代理硬掐（没有 FIN）时，下一次请求一写进去就报错（实测回环约 2 毫秒，
 * 经代理几百毫秒）——这是连接层的瞬时事件，等几秒或换线路都没有意义。只在失败来得很快时重发：等了很久才断的，请求多半已被上游
 * 收下（可能已经在生成、计费），不在这里重发，交回调用方原有的重试 / 换线路 / 等网络逻辑。只重发一次；请求体必须能重放
 *（字符串 / 字节）；调用方自己中断的不重发。
 */
export async function fetchReconnect(url, init, fetchImpl = globalThis.fetch) {
  const t0 = Date.now();
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    if (init?.signal?.aborted || !deadCode(e) || !replayable(init?.body) || Date.now() - t0 > DEAD_FAST_MS) throw e;
    return fetchImpl(url, init);
  }
}

/** 读应答正文，最多等 ms 毫秒（读不完回已知的空串并丢掉连接）：只为判读小小的报错正文，别让卡住的正文把请求挂住。 */
export async function textWithin(res, ms = 5000) {
  let timer;
  try {
    return await Promise.race([
      res.text().catch(() => ''),
      new Promise((resolve) => { timer = setTimeout(() => { res.body?.cancel?.().catch(() => {}); resolve(''); }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** 测试用：清空状态、停表。 */
export function _resetWarm() {
  for (const w of warmers) { w.stopped = true; w.origins.clear(); }
  warmers.clear();
  if (timer) { clearInterval(timer); timer = null; }
  stats.beats = 0; stats.beatFails = 0;
}
export const _tick = tick;
