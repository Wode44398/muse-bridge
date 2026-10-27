// 自定义 API 的本机代理（注册表见 claude-providers.mjs，改写规则见 claude-providers-transform.mjs）。
//
// CLI 的 ANTHROPIC_BASE_URL 指到这里：http://127.0.0.1:<端口>/<随机键>/p/<服务 id>/<档位 id>[.f]/<模型 id 编码>（.f = 开 fast）
// 路径里带着「这一轮用哪个服务、哪个模型、哪一档思考」——它们本来就进停放复用签名（换了就冷起），
// 放进地址里就不用另设旁路。每个请求现读注册表：改参数、换 Key、换地址都立即对下一个请求生效。
//
//   /v1/messages              改写参数 → Anthropic 协议原样流式转发；OpenAI 协议整体翻译（含流式）
//   /v1/messages/count_tokens Anthropic 协议转发，失败或 OpenAI 协议就粗估
//   /v1/models                回本服务配置的模型
//
// 只在还没开始往回写时重试（429 / 5xx / 网络错）；CLI 断开就掐掉上游请求，别在后台继续烧钱。
// 上游的 404 / 401 / 403 / 非 JSON 的 4xx 一律改写成 400 + 人话（见 upstreamError；非 JSON 的 429 / 5xx 只换人话、状态码照旧）：
// CLI 对 404 只会说「所选模型有问题」、对 401 走「登录失效」，跟第三方的真实原因（地址或协议不对、Key 不对）对不上。
// 只监听 127.0.0.1；路径第一段是按 owner 派生的令牌（HMAC(进程随机键, owner)）——代理据此认出这是谁的注册表：
// 成员的 CLI 看得到自己 env 里的令牌，但拼不出主机或别的成员的，借不到别人的 Key。起来后常驻到进程退出。
// 成员（普通用户自带 Key）的服务只许连公网：每次发请求前查地址、直连时连接那一刻再查一遍（public-net.mjs）。
//
// 设置页用的几件（不经 CLI，直接按同一套规则打）：fetchRemoteModels 拉模型列表（附能力猜测）、testProvider 测试连接、
// detectProtocol 一键识别协议与地址、probeModel 真打几次探测一个模型的能力。
import http from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { Agent } from 'undici';
import { HOST_OWNER, isMemberOwner, providerProxyForced, getProvider, providerKey, resolveCustomModel, resolveSubagentModel, customModelId, customSupportsFast, fastCapableProvider, fastProbe, recordFastProbe } from './claude-providers.mjs';
import { assertPublicUrl, publicDispatcher } from './public-net.mjs';
import { applyParams, pickTarget, keepsBetas, isOfficial, toOpenAI, openAIReasoning, OpenAIStream, fromOpenAI, estimateTokens } from './claude-providers-transform.mjs';
// 型号知识 / 报错解读 / 检测与探测的判读和 dimensio 的自定义服务共用（src/model-knowledge/）
import { guessModel, siblingBaseUrls, anthropicUrl, openaiUrl, parseModelList, modelIdOf, labelOf, modelsUrlCandidates } from '../model-knowledge/knowledge.mjs';
import { vendorText, classifyProbe as classify, pickDetect, parseLimit, parseEffortList, looksNotChat, mentionsModel, endpointHint, RED_PNG } from '../model-knowledge/diagnose.mjs';
export { parseLimit, parseEffortList };

const DIRECT = new Agent({ connect: { timeout: 30_000 } });   // 「不走出站代理」的服务用它直连
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const DROP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

let server = null, origin = '', secret = null, starting = null;
const tokens = new Map();   // 路径令牌 → owner
/** owner 的路径令牌（同一进程里固定）。 */
function tokenFor(owner) {
  owner = owner || HOST_OWNER;
  secret ||= randomBytes(32);
  const t = createHmac('sha256', secret).update(owner).digest('hex').slice(0, 32);
  tokens.set(t, owner);
  return t;
}
// 日志、fast 退避按（owner, 服务 id）分开——服务 id 只在一个 owner 的注册表里唯一
const slot = (p) => (p.owner || HOST_OWNER) + '|' + p.id;

// —— 最近请求日志（每个服务 50 条，给设置页「最近请求」看）——
const logs = new Map();

// —— fast mode（只对 customSupportsFast 的官方 API 型号；档位段带 .f 后缀才发）——
// fast 的额度与普通额度分开算（dimensio 2026-10-14 实测：维护者 org 的 fast 额度是每分钟 0 input token，真对话一律 429）。
// 撞上 fast 自己的拒绝就当场按普通速度重发，这个服务 15 分钟内不再试 fast，并通知正在跑的轮在对话里说一声。
export const FAST_MODE_BETA = 'fast-mode-2026-02-01';
export const FAST_COOLDOWN_MS = 15 * 60_000;
const fastCooldown = new Map();   // 服务 id → 退避到期时间
const fastListeners = new Set();
export const fastCooling = (pid, owner) => (fastCooldown.get((owner || HOST_OWNER) + '|' + pid) || 0) > Date.now();
/** 订阅「fast 被拒、已退回普通速度」：cb({ pid, owner, cooldownMs, reason })。回退订函数。 */
export function onFastFallback(cb) { fastListeners.add(cb); return () => fastListeners.delete(cb); }
// 429 正文「…rate limit of N fast mode input tokens per minute…」；没开通 / 不认 speed 的 400 / 403 也带 fast 或 speed 字样
const fastRefused = (status, text) => (status === 429 || status === 400 || status === 403) && /fast[ _-]?mode|\bspeed\b/i.test(text || '');
export function _resetFastForTests() { fastCooldown.clear(); fastListeners.clear(); }

// —— fast 支持自动识别：官方地址上的每个启用对话模型真打一次带 speed 的 1 token 请求 ——
// 200 = 支持；429 且正文说 fast 额度 = 支持（只是这会儿额度不够，运行时有回退）；400 说型号不支持 speed = 不支持；
// 别的（Key 错、网络错、5xx）不下结论，10 分钟后再试。结论变了就通知订阅方（路由据此推总线、模型菜单的开关跟着出现 / 消失）。
const SPEED_UNSUPPORTED = /does not support the [`'"]?speed|speed[`'"]? (?:parameter )?is not supported/i;
const probeInflight = new Set();
const probeRetryAt = new Map();   // 型号 id → 不下结论后的下次可试时间
const probeListeners = new Set();
export function onFastProbeChange(cb) { probeListeners.add(cb); return () => probeListeners.delete(cb); }
function noteProbe(id, ok) { if (recordFastProbe(id, ok)) for (const cb of probeListeners) { try { cb({ model: id, fast: ok }); } catch {} } }
/** 官方 API 服务里还没探过（或过期）的启用对话模型逐个探一次；回本次新下结论的个数。 */
export async function ensureFastProbes(provider) {
  if (!fastCapableProvider(provider) || !provider.enabled) return 0;
  const key = providerKey(provider.id, provider.owner);
  if (!key) return 0;
  let n = 0;
  for (const m of provider.models) {
    if (!m.enabled || m.kind !== 'chat' || fastProbe(m.id) !== null || probeInflight.has(m.id) || (probeRetryAt.get(m.id) || 0) > Date.now()) continue;
    probeInflight.add(m.id);
    try {
      const up = await upstreamFetch({ ...provider, retries: 0, timeoutSec: 20 }, anthropicUrl(provider.baseUrl, '/v1/messages'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': FAST_MODE_BETA, ...customHeaders(provider), ...authHeaders(provider, key) },
        body: JSON.stringify({ model: m.id, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }], speed: 'fast' }),
      });
      const text = await up.text().catch(() => '');
      const verdict = up.ok ? true : up.status === 429 && /fast[ _-]?mode/i.test(text) ? true : up.status === 400 && SPEED_UNSUPPORTED.test(text) ? false : null;
      if (verdict === null) probeRetryAt.set(m.id, Date.now() + 10 * 60_000);
      else { noteProbe(m.id, verdict); n++; }
    } catch { probeRetryAt.set(m.id, Date.now() + 10 * 60_000); }
    finally { probeInflight.delete(m.id); }
  }
  return n;
}
export function _resetFastProbeStateForTests() { probeInflight.clear(); probeRetryAt.clear(); probeListeners.clear(); }
function note(p, entry) {
  const k = slot(p);
  const a = logs.get(k) || [];
  a.unshift({ at: Date.now(), ...entry });
  if (a.length > 50) a.length = 50;
  logs.set(k, a);
}
export function providerLog(pid, owner) { return logs.get((owner || HOST_OWNER) + '|' + pid) || []; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeaders(provider, key) {
  if (!key || provider.authStyle === 'none') return {};
  return provider.authStyle === 'bearer' ? { authorization: 'Bearer ' + key } : { 'x-api-key': key };
}
function customHeaders(provider) {
  const h = {};
  for (const x of provider.headers || []) h[x.name.toLowerCase()] = x.value;
  return h;
}

/**
 * 发一次上游请求（带超时、可选直连、有限重试）。返回 fetch Response；失败抛带 status 的错。
 * 超时只管到「响应头回来」：流式回答可以跑很久。
 */
async function upstreamFetch(provider, url, init, signal) {
  const tries = 1 + (provider.retries ?? 2);
  // 成员的服务：地址得是公网；直连时用连接那一刻再查地址的 dispatcher，走出站代理时 DNS 在代理那边，只能靠这道先查
  const member = isMemberOwner(provider.owner);
  if (member) await assertPublicUrl(url);
  // 部署方强制走出站代理（providerProxyForced）时，存档里早先关掉的也照走代理
  const direct = provider.compat?.useProxy === false && !providerProxyForced();
  const viaProxy = !direct && !!(process.env.HTTPS_PROXY || process.env.https_proxy);
  const dispatcher = member ? (viaProxy ? null : publicDispatcher()) : direct ? DIRECT : null;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(new Error('timeout')), (provider.timeoutSec || 600) * 1000);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal, redirect: 'manual', ...(dispatcher ? { dispatcher } : {}) });
      clearTimeout(timer);
      if (RETRY_STATUS.has(res.status) && i < tries - 1) {
        const ra = parseFloat(res.headers.get('retry-after') || '');
        await res.body?.cancel?.().catch(() => {});
        await sleep(Number.isFinite(ra) ? Math.min(ra * 1000, 20_000) : 800 * 2 ** i);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      lastErr = ac.signal.aborted ? Object.assign(new Error(`等了 ${provider.timeoutSec || 600} 秒没有响应`), { status: 504 }) : e;
      if (i < tries - 1) { await sleep(800 * 2 ** i); continue; }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  const msg = (lastErr && lastErr.cause && lastErr.cause.code) || (lastErr && lastErr.message) || String(lastErr);
  throw Object.assign(new Error('连不上模型服务：' + msg), { status: lastErr && lastErr.status || 502 });
}

function sendJson(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const apiError = (message, type = 'api_error') => ({ type: 'error', error: { type, message } });

/**
 * 上游没成功 → 给 CLI / 设置页的错误。回 { status, type, message }；回 null = 原样转发（普通 JSON 的 4xx / 429 / 5xx：
 * CLI 自己会按 429、5xx 重试，4xx 的厂商原文它会照实显示）。非 JSON 的 429 / 5xx 只换成人话、状态码照旧，CLI 照样重试、
 * 错误卡照样分得出「限流了」。
 * 人话不以「模型服务「名字」」开头：聊天错误卡的标题已经带了服务名（claude.mjs customErrorCard），英文界面按整句模式
 * 翻译时两段都以它开头会互相吞（i18n/en/claude-providers.js 里的模式键）。
 */
export function upstreamError(provider, url, status, text) {
  const v = vendorText(text);
  const where = `POST ${url}`;
  const fix = `去「设置 › Claude › 模型服务 › ${provider.name}」`;
  if (status === 404 && !(v.json && mentionsModel(v.msg))) {
    const kind = provider.protocol === 'openai' ? 'OpenAI Chat Completions' : 'Anthropic Messages';
    const hint = endpointHint(provider.protocol, provider.baseUrl);
    return { status: 400, type: 'invalid_request_error', message: `接口地址不对：${where} 返回 404，这里不是 ${kind} 接口。${hint}${fix}改地址，或点「检测连接」一键识别。` };
  }
  if (status === 404) return { status: 400, type: 'invalid_request_error', message: `找不到这个模型（404）：${v.msg}` };
  if (status === 401 || status === 403) return { status: 400, type: 'invalid_request_error', message: `这把 API Key 被拒绝了（${status}）${v.msg ? '：' + v.msg : ''}。${fix}检查 Key 和鉴权方式。` };
  if (!v.json) {
    const keep = status >= 500 || status === 429;
    return { status: keep ? status : 400, type: status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message: `上游返回 ${status}（不是 JSON，${where}）：${v.msg || '空'}` };
  }
  return null;
}

// 流式透传时顺手从 SSE 里抠用量（message_start 的 input、message_delta 的 output）
function sseUsageTap(onUsage) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line.indexOf('usage') < 0) continue;
      try {
        const d = JSON.parse(line.slice(5));
        const u = (d.message && d.message.usage) || d.usage;
        if (u) onUsage(u);
      } catch {}
    }
    if (buf.length > 1 << 20) buf = '';
  };
}

async function handle(req, res) {
  const url = req.url || '';
  // 档位段：档位 id（小写字母数字与 _ -，最长 24）或 '-'（没选），后缀 .f = 这一轮开了 fast mode
  const m = /^\/([0-9a-f]{32})\/p\/(p-[0-9a-f]{6,12})\/([a-z0-9_-]{1,24})(\.f)?\/([^/]+)(\/.*)$/.exec(url);
  const owner = m && tokens.get(m[1]);
  if (!owner) { res.writeHead(404); res.end(); return; }
  const [, , pid, effortSeg, fastSeg, modelEnc, rest] = m;
  const sub = rest.split('?')[0];
  let effort = effortSeg === '-' ? '' : effortSeg;
  let mainId = '';
  try { mainId = decodeURIComponent(modelEnc); } catch {}
  const resolved = resolveCustomModel(customModelId(pid, mainId), owner);
  let provider = resolved ? resolved.provider : getProvider(pid, owner);
  if (!provider) { sendJson(res, 400, apiError('这个模型服务已被删除', 'invalid_request_error')); return; }
  if (!resolved) { sendJson(res, 400, apiError(`模型「${mainId}」不存在或已停用（在「设置 › Claude › 模型服务 › ${provider.name}」里）`, 'invalid_request_error')); return; }
  let model = resolved.model;

  const chunks = [];
  try { for await (const c of req) chunks.push(c); } catch { return; }
  const raw = Buffer.concat(chunks).toString('utf8');
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  if (req.method === 'GET' && /^\/v1\/models\/?$/.test(sub)) {
    sendJson(res, 200, { data: provider.models.filter((x) => x.enabled).map((x) => ({ type: 'model', id: x.id, display_name: x.label, created_at: new Date(provider.createdAt).toISOString() })), has_more: false });
    return;
  }
  if (req.method !== 'POST' || !/^\/v1\/messages(\/count_tokens)?\/?$/.test(sub)) {
    sendJson(res, 404, apiError('bridge 自定义 API 代理不支持 ' + req.method + ' ' + sub, 'not_found_error'));
    return;
  }
  let body;
  try { body = JSON.parse(raw); } catch { sendJson(res, 400, apiError('请求体不是 JSON', 'invalid_request_error')); return; }
  // 子 agent 选模型 / 选档（transform 的 pickTarget）：写了别的服务里的模型名就整个换成那个服务（Key、协议、地址、日志跟着走）
  const pick = pickTarget(body, provider, model, effort, (name) => resolveSubagentModel(name, owner));
  provider = pick.provider; model = pick.model; effort = pick.effort;
  body = { ...body, model: model.id };
  const apiKey = providerKey(provider.id, provider.owner);
  const counting = /count_tokens/.test(sub);

  // count_tokens：Anthropic 协议试着转发，失败 / OpenAI 协议粗估（CLI 只拿它算上下文占用）
  if (counting) {
    if (provider.protocol === 'anthropic') {
      try {
        const { body: b } = applyParams({ ...body, max_tokens: body.max_tokens || 1 }, provider, model, effort);
        delete b.max_tokens; delete b.stream; delete b.temperature; delete b.top_p; delete b.top_k; delete b.stop_sequences;
        const up = await upstreamFetch({ ...provider, retries: 0, timeoutSec: 20 }, anthropicUrl(provider.baseUrl, '/v1/messages/count_tokens'), {
          method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(keepsBetas(provider) && req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}), ...customHeaders(provider), ...authHeaders(provider, apiKey) }, body: JSON.stringify(b),
        }, ac.signal);
        if (up.ok) { sendJson(res, 200, await up.json()); return; }
      } catch {}
    }
    sendJson(res, 200, { input_tokens: estimateTokens(body) });
    return;
  }

  const t0 = Date.now();
  const { body: out, model: target, effort: eff } = applyParams(body, provider, model, effort);
  // fast：开关开着（路径 .f）、型号支持（换成了别的型号——如后台小任务映射到 Haiku——就不发，带了必 400）、不在退避期
  const wantFast = !!fastSeg && !pick.routed && provider.protocol === 'anthropic' && customSupportsFast(provider, target);
  const fast = wantFast && !fastCooling(provider.id, provider.owner);
  const logBase = { model: target.id, effort: eff || '', stream: !!out.stream, ...(wantFast ? { fast } : {}) };
  const fail = (status, message, type) => {
    note(provider, { ...logBase, status, ms: Date.now() - t0, error: String(message).slice(0, 300) });
    sendJson(res, status, apiError(message, type || (status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error')));
  };

  try {
    if (provider.protocol === 'anthropic') {
      const headers = { 'content-type': 'application/json', 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01', ...customHeaders(provider), ...authHeaders(provider, apiKey) };
      if (keepsBetas(provider) && req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
      const upUrl = anthropicUrl(provider.baseUrl, '/v1/messages');
      // speed 离了 beta 头也是 400
      const send = (withFast, prov) => upstreamFetch(prov, upUrl, withFast
        ? { method: 'POST', headers: { ...headers, 'anthropic-beta': [headers['anthropic-beta'], FAST_MODE_BETA].filter(Boolean).join(',') }, body: JSON.stringify({ ...out, speed: 'fast' }) }
        : { method: 'POST', headers, body: JSON.stringify(out) }, ac.signal);
      let up = null, useFast = fast;
      if (fast) {
        // 带 fast 先只打一次（不走通用的 429 重试，不然 fast 限流会一直「被限流，N 秒后重试」不出字）
        const first = await send(true, { ...provider, retries: 0 });
        if (first.ok) up = first;
        else {
          const text = await first.text().catch(() => '');
          // 型号根本不认 speed（实测表 / 旧探测过时了）：记成不支持，菜单里的开关随之消失
          if (first.status === 400 && SPEED_UNSUPPORTED.test(text)) noteProbe(target.id, false);
          if (fastRefused(first.status, text)) {
            fastCooldown.set(slot(provider), Date.now() + FAST_COOLDOWN_MS);
            note(provider, { ...logBase, status: first.status, ms: Date.now() - t0, error: ('fast 被拒，已改用普通速度：' + vendorText(text).msg).slice(0, 300) });
            for (const cb of fastListeners) { try { cb({ pid: provider.id, owner: provider.owner || HOST_OWNER, cooldownMs: FAST_COOLDOWN_MS, status: first.status }); } catch {} }
            useFast = false;
            logBase.fast = false;
          }
          // 别的失败（5xx / 普通限流）：带着 fast 走正常重试
        }
      }
      if (!up) up = await send(useFast, provider);
      if (!up.ok) {
        const text = await up.text().catch(() => '');
        const mapped = upstreamError(provider, upUrl, up.status, text);
        if (mapped) { fail(mapped.status, mapped.message, mapped.type); return; }
        note(provider, { ...logBase, status: up.status, ms: Date.now() - t0, error: text.slice(0, 300) });
        const h = {}; up.headers.forEach((v, k) => { if (!DROP_RES.has(k)) h[k] = v; });
        res.writeHead(up.status, h); res.end(text);
        return;
      }
      const h = {}; up.headers.forEach((v, k) => { if (!DROP_RES.has(k)) h[k] = v; });
      res.writeHead(up.status, h);
      const usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
      let firstMs = 0;
      const tap = sseUsageTap((u) => {
        if (u.input_tokens != null && (u.input_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens)) {
          usage.in = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          usage.cacheRead = u.cache_read_input_tokens || 0; usage.cacheWrite = u.cache_creation_input_tokens || 0;
        }
        if (u.output_tokens) usage.out = u.output_tokens;
      });
      const dec = new TextDecoder();
      if (up.body) {
        for await (const c of up.body) {
          if (!firstMs) firstMs = Date.now() - t0;
          if (out.stream) tap(dec.decode(c, { stream: true }));
          if (!res.write(c)) await new Promise((r) => res.once('drain', r));
        }
      }
      res.end();
      if (!out.stream) { /* 非流式：用量在整段 JSON 里，日志不细抠 */ }
      note(provider, { ...logBase, status: up.status, ms: Date.now() - t0, firstMs, inTok: usage.in, outTok: usage.out, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
      return;
    }

    // —— OpenAI 协议：整体翻译 ——
    const oai = openAIReasoning(toOpenAI(out, provider, target), target, eff);
    // 额外请求体在 Anthropic 形状上合并过了；OpenAI 专属字段（如 reasoning、provider）也该能写进来——
    // 约定：额外请求体里的 openai 子对象原样并进翻译后的请求。
    const extraOai = out.openai && typeof out.openai === 'object' ? out.openai : null;
    if (extraOai) Object.assign(oai, extraOai);
    const headers = { 'content-type': 'application/json', ...customHeaders(provider), ...authHeaders(provider, apiKey) };
    const upUrl = openaiUrl(provider.baseUrl, '/chat/completions');
    const up = await upstreamFetch(provider, upUrl, { method: 'POST', headers, body: JSON.stringify(oai) }, ac.signal);
    if (!up.ok) {
      const text = await up.text().catch(() => '');
      const mapped = upstreamError(provider, upUrl, up.status, text);
      if (mapped) { fail(mapped.status, mapped.message, mapped.type); return; }
      fail(up.status, `上游返回 ${up.status}：${vendorText(text).msg}`);
      return;
    }
    if (!oai.stream) {
      const j = await up.json();
      const msg = fromOpenAI(j, target.id);
      note(provider, { ...logBase, status: 200, ms: Date.now() - t0, inTok: msg.usage.input_tokens, outTok: msg.usage.output_tokens });
      sendJson(res, 200, msg);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const tr = new OpenAIStream(target.id);
    const dec = new TextDecoder();
    let buf = '', firstMs = 0;
    const flush = (line) => {
      if (!line.startsWith('data:')) return;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') return;
      let j; try { j = JSON.parse(d); } catch { return; }
      if (j.error) { res.write(tr.error(j.error.message || JSON.stringify(j.error))); return; }
      const s = tr.push(j);
      if (s) res.write(s);
    };
    for await (const c of up.body) {
      if (!firstMs) firstMs = Date.now() - t0;
      buf += dec.decode(c, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); flush(line); }
    }
    if (buf.trim()) flush(buf.trim());
    res.end(tr.end());
    note(provider, { ...logBase, status: 200, ms: Date.now() - t0, firstMs, inTok: tr.usage.input_tokens, outTok: tr.usage.output_tokens });
  } catch (e) {
    if (e && e.aborted) { note(provider, { ...logBase, status: 499, ms: Date.now() - t0, error: '客户端中止' }); return; }
    if (res.headersSent) {
      try { res.write(new OpenAIStream(target.id).error((e && e.message) || String(e))); res.end(); } catch {}
      note(provider, { ...logBase, status: 502, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 300) });
      return;
    }
    fail((e && e.status) || 502, (e && e.message) || String(e), 'api_error');
  }
}

async function start() {
  const srv = http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error('[claude-providers] request failed:', (e && e.message) || e); sendJson(res, 502, apiError('bridge 自定义 API 代理出错')); });
  });
  srv.requestTimeout = 0;
  srv.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  srv.unref();
  server = srv;
  origin = `http://127.0.0.1:${srv.address().port}`;
  console.log(`[claude-providers] proxy listening on 127.0.0.1:${srv.address().port}`);
}

/** 代理就绪后这个 owner 的根地址（第一次调用时起服务；不传 owner = 主机管理员）。 */
export async function providersProxyBase(owner) {
  if (!origin) {
    if (!server && !starting) starting = start().finally(() => { starting = null; });
    await starting;
  }
  return `${origin}/${tokenFor(owner)}`;
}

/**
 * 给 CLI 子进程的环境变量：在 base（claudeEngineEnv 的结果或 process.env 副本）上改。
 * 去掉订阅 OAuth token（绝不能发给第三方）、指向本机代理、把后台小任务 / 子 agent 的模型别名映射到本服务。
 * effort = 这一轮的档位 id（'' = 没选，代理按模型默认档）；fast = 开 fast mode（调用方已按 customSupportsFast 门控）。
 * fast 由代理自己加 speed 与 beta 头：CLI 的 fast 判定要拿 env 里的 Key 去官方查组织额度，而这里给它的只是占位 Key，永远点不亮。
 */
export async function providerEngineEnv(base, { provider, model, effort, fast = false }) {
  const root = await providersProxyBase(provider.owner);
  const env = { ...base };
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
  env.ANTHROPIC_BASE_URL = `${root}/p/${provider.id}/${effort || '-'}${fast ? '.f' : ''}/${encodeURIComponent(model.id)}`;
  env.ANTHROPIC_API_KEY = 'bridge-local-proxy';   // 代理不认它，真 Key 只在代理里
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model.id;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model.id;
  const small = provider.fastModel && provider.models.some((m) => m.id === provider.fastModel && m.enabled && m.kind !== 'other') ? provider.fastModel : model.id;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
  env.ANTHROPIC_SMALL_FAST_MODEL = small;
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(model.maxOutput || 32000);
  // CLI 不认识第三方型号，上下文窗口一律按 200K 算（settings.autoCompactWindow 也会被它夹回 200K）——
  // 只有这个变量能告诉它真实窗口（实测 200000 → 1048576）。
  if (model.contextWindow > 0) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(model.contextWindow); else delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  // 重试只留一处旋钮：代理按「服务 › 失败重试」重试（认 Retry-After），CLI 自己只补 1 次——
  // 以前两边叠加（CLI 默认 10 次 × 代理 3 次），上游持续 503 时要干等好几分钟才报错。
  env.CLAUDE_CODE_MAX_RETRIES = '1';
  env.API_TIMEOUT_MS = String(((provider.timeoutSec || 600) + 30) * 1000);
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (!provider.compat?.promptCaching) env.DISABLE_PROMPT_CACHING = '1'; else delete env.DISABLE_PROMPT_CACHING;
  // 提示缓存 TTL：CLI 没设时「订阅号 1 小时、API Key 5 分钟」——主对话每轮带 ~10 万 token 的系统提示+工具定义，
  // 隔 5 分钟没说话就整段重算，首字从 <1s 退到 5–10s（这就是自定义 API 比订阅「慢半拍」的主因）。
  // 官方端点照订阅给 1 小时（1h 写入按 2× 计价、读仍 0.1×）；第三方不一定认 cache_control.ttl，不动。
  if (provider.compat?.promptCaching && isOfficial(provider)) env.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h'; else delete env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  for (const k of ['NO_PROXY', 'no_proxy']) if (!/(^|,)\s*127\.0\.0\.1\s*(,|$)/.test(env[k] || '')) env[k] = (env[k] ? env[k] + ',' : '') + '127.0.0.1';
  return env;
}

// —— 设置页用：拉模型列表、测试连接、识别协议、探测模型（不经 CLI，直接按同一套规则打）——

const keyOf = (draft) => (typeof draft.apiKey === 'string' && draft.apiKey ? draft.apiKey : (draft.id ? providerKey(draft.id, draft.owner) : ''));
const quick = (p, timeoutSec = 20) => ({ ...p, retries: 0, timeoutSec });

async function getModelsAt(p, url, headers) {
  const up = await upstreamFetch(p, url, { method: 'GET', headers });
  const text = await up.text().catch(() => '');
  if (!up.ok) return { ok: false, status: up.status, text };
  let j; try { j = JSON.parse(text); } catch { return { ok: false, status: up.status, text: '模型列表不是 JSON' }; }
  const list = parseModelList(j);
  return list ? { ok: true, list, url } : { ok: false, status: up.status, text: '模型列表格式认不出' };
}

/**
 * 拉端点的模型列表，每项附能力猜测（src/model-knowledge：接口元数据 → 内置型号表 → 名字）。
 * draft = 编辑中还没保存的配置（可带 apiKey；不带就用已存的 Key）。
 * Anthropic 协议的端点下常常没有 /v1/models（小米、DeepSeek 的 …/anthropic）：404 后再去同站的 OpenAI 兼容地址拉。
 */
export async function fetchRemoteModels(draft) {
  const key = keyOf(draft);
  const p = quick(draft);
  const isA = p.protocol !== 'openai';
  const base = String(p.baseUrl || '').replace(/\/+$/, '');
  // 主地址 + 备选地址（…/anthropic → …/v1、…/models、根下的 /v1/models；共用模块 modelsUrlCandidates）
  const [primary, ...alts] = modelsUrlCandidates(isA ? 'anthropic' : 'openai', base);
  const headers = { ...(isA ? { 'anthropic-version': '2023-06-01' } : {}), ...customHeaders(p), ...authHeaders(p, key) };
  let r = await getModelsAt(p, primary, headers);
  if (!r.ok && (r.status === 404 || r.status === 405 || !r.status || /JSON|格式/.test(r.text))) {
    // 备选地址两种鉴权头都带上（各家 /models 认的不一样）
    const both = key && p.authStyle !== 'none' ? { 'x-api-key': key, authorization: 'Bearer ' + key } : {};
    for (const u of alts) {
      try { const a = await getModelsAt(p, u, { ...customHeaders(p), ...both }); if (a.ok) { r = a; break; } } catch {}
    }
  }
  if (!r.ok) throw Object.assign(new Error(`拉取模型列表失败（${r.status || '网络错误'}）：${vendorText(r.text).msg}`), { status: 502 });
  return r.list.map((x) => {
    const id = modelIdOf(x);
    if (!id) return null;
    return { id, label: labelOf(x, id), ...guessModel(id, { protocol: p.protocol, api: x }) };
  }).filter(Boolean).slice(0, 1000);
}

/** 手动添加的型号（没有接口元数据）：只按内置型号表与名字猜。 */
export function guessModels(ids, protocol) {
  return (Array.isArray(ids) ? ids : []).slice(0, 50).map((id) => String(id || '').trim()).filter(Boolean).map((id) => ({ id, label: id, ...guessModel(id, { protocol }) }));
}

// 按 Anthropic 形状发一次（OpenAI 协议翻译过去），回 { status, ok, json, text, ms, msg, effort }（msg = 转回的 Anthropic message，
// effort = 实际发出去的档位 id）。opts.tier：档位 id（'' = 没选，按模型默认档）；opts.maxTokens：原样写进请求（探测输出上限时
// 绕过模型上限）；opts.oaiPatch：并进 OpenAI 请求；opts.keepPolicy：照服务 / 模型的「思考：始终开 / 始终关」改写档位——
// 只有「测试连接」要（测的就是真实发出去的样子）；探测逐档试时不能被策略改写，不然测的不是那一档。
async function callOnce(provider, model, key, { messages, maxTokens = 256, tier = '', oaiPatch = null, timeoutSec = 30, keepPolicy = false }) {
  const m = keepPolicy ? model : { ...model, params: { ...(model.params || {}), thinking: null } };
  const prov = keepPolicy ? { ...provider, models: [m] } : { ...provider, params: { ...(provider.params || {}), thinking: 'auto' }, models: [m] };
  const { body, effort } = applyParams({ model: m.id, max_tokens: 64, stream: false, messages }, prov, m, tier);
  body.max_tokens = maxTokens;
  if (body.thinking && body.thinking.budget_tokens && body.thinking.budget_tokens >= maxTokens) body.max_tokens = body.thinking.budget_tokens + 256;
  const t0 = Date.now();
  let url, init;
  if (provider.protocol === 'openai') {
    const oai = openAIReasoning(toOpenAI({ ...body, stream: false }, prov, m), m, effort);
    if (body.openai && typeof body.openai === 'object') Object.assign(oai, body.openai);
    if (oaiPatch) Object.assign(oai, oaiPatch);
    url = openaiUrl(provider.baseUrl, '/chat/completions');
    init = { method: 'POST', headers: { 'content-type': 'application/json', ...customHeaders(provider), ...authHeaders(provider, key) }, body: JSON.stringify(oai) };
  } else {
    url = anthropicUrl(provider.baseUrl, '/v1/messages');
    init = { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...customHeaders(provider), ...authHeaders(provider, key) }, body: JSON.stringify(body) };
  }
  const up = await upstreamFetch(quick(provider, timeoutSec), url, init);
  const text = await up.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch {}
  let msg = null;
  if (up.ok && json) msg = provider.protocol === 'openai' ? fromOpenAI(json, m.id) : json;
  return { status: up.status, ok: up.ok && !!json, json, text, url, ms: Date.now() - t0, msg, effort };
}
const replyOf = (msg) => ((msg && msg.content) || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
const thoughtOf = (msg) => ((msg && msg.content) || []).some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'));

/**
 * 测试连接：用这份配置发一条极短的请求，回延迟、回复、用量或错误。
 * { id } = 已存的服务；{ draft } = 编辑中还没保存的（可带 apiKey，不带用已存的 Key）。思考和真实对话没选档位时一样：
 * 模型默认档（没默认就不发），再按服务 / 模型的「思考：始终开 / 始终关」改写。
 */
export async function testProvider({ id, owner, draft, model: modelId } = {}) {
  const provider = draft || getProvider(id, owner);
  if (!provider) throw Object.assign(new Error('没有这个模型服务'), { status: 404 });
  const chat = provider.models.filter((m) => m.kind !== 'other');
  const model = provider.models.find((m) => m.id === (modelId || provider.defaultModel)) || chat[0] || provider.models[0];
  if (!model) throw Object.assign(new Error('先添加至少一个模型'), { status: 400 });
  const key = keyOf(provider);
  const pid = provider.id || '';
  const t0 = Date.now();
  // 失败也记进「最近请求」（只记已存的服务），设置页的状态点和日志才说得清是哪一次坏的
  const failed = (status, error, effort = '') => { if (pid) note(provider, { model: model.id, effort, stream: false, status: status || 502, ms: Date.now() - t0, error: String(error).slice(0, 300), test: true }); return { ok: false, status, ms: Date.now() - t0, model: model.id, error }; };
  try {
    const r = await callOnce(provider, { ...model, enabled: true }, key, { messages: [{ role: 'user', content: '只回复两个字母：OK' }], maxTokens: model.alwaysThinks ? 1024 : 64, tier: '', keepPolicy: true, timeoutSec: Math.min(provider.timeoutSec || 600, 120) });
    if (!r.ok) {
      const mapped = upstreamError(provider, r.url, r.status, r.text);
      return failed(r.status, mapped ? mapped.message : r.text.slice(0, 800), r.effort || '');
    }
    const msg = r.msg;
    const res = { ok: true, status: 200, ms: Date.now() - t0, model: model.id, reply: replyOf(msg).slice(0, 200), thinking: thoughtOf(msg), usage: msg.usage || null };
    if (pid) note(provider, { model: model.id, effort: r.effort || '', stream: false, status: 200, ms: res.ms, inTok: msg.usage?.input_tokens || 0, outTok: msg.usage?.output_tokens || 0, test: true });
    return res;
  } catch (e) {
    return failed((e && e.status) || 0, (e && e.message) || String(e));
  }
}

// —— 一键识别协议与地址 ——
// 在给定地址和它的兄弟地址（…/v1 ⇄ …/anthropic、根下的 /v1 与 /anthropic）上，各用两种协议发一条 max_tokens=1 的请求，
// 看哪个组合真通。分类（共用模块 classifyProbe）：ok 通了 / model 接口在但模型名不对 / auth 接口在但 Key 被拒 /
// missing 404 这里没有接口 / error 其它；推荐规则同 pickDetect（dimensio 的「检测连接」同一套）。

export async function detectProtocol(draft) {
  const key = keyOf(draft);
  let modelId = (draft.models || []).find((m) => m.enabled !== false && m.kind !== 'other')?.id || '';
  if (!modelId) {
    try { const list = await fetchRemoteModels(draft); modelId = (list.find((m) => m.kind === 'chat') || list[0] || {}).id || ''; } catch {}
  }
  const probeModel = modelId || 'test';
  const bases = siblingBaseUrls(draft.baseUrl).slice(0, 5);
  const tries = [];
  for (const b of bases) for (const protocol of ['anthropic', 'openai']) tries.push({ protocol, baseUrl: b });
  const results = await Promise.all(tries.map(async (t) => {
    const authStyle = draft.authStyle === 'none' ? 'none' : t.protocol === draft.protocol ? draft.authStyle : t.protocol === 'openai' ? 'bearer' : 'x-api-key';
    const p = quick({ ...draft, ...t, authStyle }, 15);
    const isA = t.protocol === 'anthropic';
    const url = isA ? anthropicUrl(t.baseUrl, '/v1/messages') : openaiUrl(t.baseUrl, '/chat/completions');
    const body = { model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
    const headers = { 'content-type': 'application/json', ...(isA ? { 'anthropic-version': '2023-06-01' } : {}), ...customHeaders(p), ...authHeaders(p, key) };
    const t0 = Date.now();
    try {
      const up = await upstreamFetch(p, url, { method: 'POST', headers, body: JSON.stringify(body) });
      const text = await up.text().catch(() => '');
      return { ...t, authStyle, url, status: up.status, result: classify(up.status, text), message: vendorText(text).msg.slice(0, 200), ms: Date.now() - t0 };
    } catch (e) {
      return { ...t, authStyle, url, status: 0, result: 'network', message: String((e && e.message) || e).slice(0, 200), ms: Date.now() - t0 };
    }
  }));
  return { model: modelId, results, ...pickDetect(results, draft) };
}

// —— 探测一个模型的能力（真打几次，只给管理员；花费很小：都是一两句话的请求）——
// 8×8 红图、输出上限 / 可选档位的报文解读在共用模块（RED_PNG、parseLimit、parseEffortList、looksNotChat）

export async function probeModel(draft, model) {
  const key = keyOf(draft);
  const m = { ...model, enabled: true };
  const plain = { ...m, efforts: [], effortDefault: '' };   // 不发任何思考参数
  const out = { model: m.id, notes: [] };
  const say = (s) => out.notes.push(s);
  const run = (fn) => fn().catch((e) => ({ status: 0, ok: false, text: String((e && e.message) || e), json: null }));
  const [text, limit, vision] = await Promise.all([
    run(() => callOnce(draft, plain, key, { messages: [{ role: 'user', content: '1+1 等于几？只回答数字。' }], maxTokens: 2048 })),
    run(() => callOnce(draft, plain, key, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 10_000_000 })),
    run(() => callOnce(draft, { ...plain, vision: true }, key, { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG } }, { type: 'text', text: '这张图是什么颜色？只回答颜色。' }] }], maxTokens: 2048 })),
  ]);
  // 对话：普通问题就 400 的（语音识别 / 合成要专门的输入）判成非对话模型
  if (text.ok) {
    out.kind = 'chat';
    out.thinksByDefault = thoughtOf(text.msg);
    say(out.thinksByDefault ? '不发思考参数也会思考' : '不发思考参数时不思考');
  } else {
    const v = vendorText(text.text).msg;
    if (looksNotChat(text.status, text.text)) { out.kind = 'other'; say('普通对话被拒：' + v.slice(0, 120)); }
    else { out.error = upstreamError(draft, text.url || '', text.status, text.text)?.message || `HTTP ${text.status}：${v.slice(0, 200)}`; return out; }
  }
  // 输出上限：报错里读出范围（不扣费）；没报错说明上限 ≥ 请求值，读不出
  if (!limit.ok) { const n = parseLimit(limit.text); if (n) { out.maxOutput = n; say(`输出上限 ${n}`); } }
  else say('输出上限没读出来（端点没校验）');
  // 视觉
  if (vision.ok) { const r = replyOf(vision.msg); out.vision = /红|red/i.test(r); say(out.vision ? '能看图' : `看图答错了（${r.slice(0, 20)}）`); }
  else if (vision.status === 400) { out.vision = false; say('不收图片'); }
  if (out.kind === 'other') return out;
  // 档位：逐个试，400 = 端点不认这一档的值
  const tiers = (m.efforts || []).filter((t) => t.value !== null && t.value !== undefined).slice(0, 8);
  out.tiers = await Promise.all(tiers.map(async (t) => {
    const r = await run(() => callOnce(draft, m, key, { messages: [{ role: 'user', content: '1+1 等于几？只回答数字。' }], maxTokens: 2048, tier: t.id }));
    return { id: t.id, ok: !!r.ok, status: r.status, thinking: r.ok ? thoughtOf(r.msg) : null, error: r.ok ? '' : vendorText(r.text).msg.slice(0, 160) };
  }));
  // OpenAI 端点：乱填 reasoning_effort，从报错里读出它认的档位
  if (draft.protocol === 'openai') {
    const r = await run(() => callOnce(draft, plain, key, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 16, oaiPatch: { reasoning_effort: 'zzz-bridge-probe' } }));
    const ids = !r.ok ? parseEffortList(r.text) : null;
    if (ids) { out.effortIds = ids; say('reasoning_effort 可选：' + ids.join(' / ')); }
  }
  return out;
}
