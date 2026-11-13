// 模型网关（2026-11-10）：bridge 进程里的一个只听 127.0.0.1 的转发口，「模型中心」登记的每个服务在这里各有一段地址：
//
//   http://127.0.0.1:<随机端口>/<随机键>/<服务 id>/<协议>/…
//
// Claude 的本机代理和 dimensio 都把它当成一个普通的 OpenAI / Anthropic / Gemini 兼容端点来打，真正的上游、Key 与换 Key 都在这里：
//   · API 池（pool.mjs）：一个服务挂多条线路（各有 Key，可各有地址），按顺序 / 轮流取；撞 401 / 402 / 403 / 429 当场换下一条重发，
//     坏线路冷却，agent 那头看不出换过。
//   · Vertex（vertex.mjs）：替请求换上 Google 云凭据的令牌，把 Gemini 接口与 OpenAI 兼容接口映射到 Vertex 的地址上。
// 两个 agent 共用同一份线路状态——Claude 这边把某个 Key 打到限额，dimensio 那边下一条请求就已经绕开它。
//
// 上游处理器的形状：async handle({ service, proto, rest, search, method, headers, body, signal }) → Response | { status, json }。
// 网关只管收请求体、把上游的应答原样（状态码 + content-type + 流）转回去。
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_BODY = 96 * 1024 * 1024;   // 内联图片 / 长上下文
const PROTOS = new Set(['openai', 'anthropic', 'gemini']);

let server = null, starting = null, base = '', secret = '';
let resolveService = () => null;     // (id) → 服务记录（registry 注入）
const handlers = new Map();          // kind → handle

export function setServiceResolver(fn) { resolveService = fn; }
export function registerUpstream(kind, handle) { handlers.set(kind, handle); }

const fail = (res, status, message) => {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  // 三种协议的客户端都认得出的错误形状
  const body = JSON.stringify({ type: 'error', error: { type: 'bridge_gateway_error', code: status, message, status: 'BRIDGE_GATEWAY' } });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(Object.assign(new Error('请求体太大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sameKey = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const seg = u.pathname.split('/');   // ['', 键, 服务, 协议, …]
  if (seg.length < 4 || !sameKey(seg[1] || '', secret)) return fail(res, 404, 'not found');
  const service = resolveService(decodeURIComponent(seg[2]));
  if (!service) return fail(res, 404, '这个模型服务已经不在了（在「模型中心」里被删除或停用）');
  const proto = seg[3];
  if (!PROTOS.has(proto)) return fail(res, 404, 'not found');
  const h = handlers.get(service.kind);
  if (!h) return fail(res, 500, `模型网关不认识的服务类型：${service.kind}`);
  const rest = '/' + seg.slice(4).join('/');
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req);
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  let up;
  try {
    up = await h({ service, proto, rest, search: u.search, method: req.method, headers: req.headers, body, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return;
    return fail(res, e?.status && e.status >= 400 && e.status < 600 ? e.status : 502, String(e?.message || e));
  }
  if (!(up instanceof Response)) {
    res.writeHead(up.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(up.json ?? {}));
    return;
  }
  const out = {};
  for (const k of ['content-type', 'retry-after', 'request-id', 'x-request-id', 'x-ds-trace-id', 'x-trace-id']) { const v = up.headers.get(k); if (v) out[k] = v; }
  // Anthropic 的限额头原样带回（Claude 的本机代理不看，留给以后）
  for (const [k, v] of up.headers) if (k.startsWith('anthropic-ratelimit-')) out[k] = v;
  res.writeHead(up.status, out);
  if (!up.body) { res.end(); return; }
  try { await pipeline(Readable.fromWeb(up.body), res); } catch {}   // 任一头断开：各自收尾
}

async function start() {
  secret = randomBytes(18).toString('hex');
  const srv = http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error('[model-hub] gateway request failed:', e?.message || e); fail(res, e?.status || 502, '模型网关出错：' + String(e?.message || e).slice(0, 200)); });
  });
  srv.requestTimeout = 0;
  srv.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  srv.unref();
  server = srv;
  base = `http://127.0.0.1:${srv.address().port}/${secret}`;
  console.log(`[model-hub] gateway listening on 127.0.0.1:${srv.address().port}`);
}

/** 起好网关再返回根地址（http://127.0.0.1:端口/键）。重复调没事。 */
export async function ensureGateway() {
  if (!server) { starting ||= start().finally(() => { starting = null; }); await starting; }
  return base;
}
/** 服务在网关上的地址（协议段之前）。网关还没起来回 ''。 */
export const gatewayUrl = (sid, proto) => (base ? `${base}/${encodeURIComponent(sid)}/${proto}` : '');
export async function _stopGatewayForTests() { if (server) await new Promise((r) => server.close(r)); server = null; base = ''; }
