// 号池「会话中无缝换号」：本机上游代理（可选，号池智能路由的子开关，默认关）。
//
// Claude Code 的每一步（每次调模型）都是一个独立、无状态的 /v1/messages 请求，带着完整对话历史；
// 服务端不把会话绑在账号上。所以只要让 CLI 的模型请求先经过 bridge，就能【每个请求】现选号、
// 现换 Authorization——换号落在两次模型请求之间（上一个工具已跑完、结果已进 transcript），
// 正在跑的会话不停、不重发、也不用等前端补一句「接着做」（无人值守同样成立）。
//
//   · 发出前：当前号对本请求的模型已用满 / 快满（account-router.leaveIfBlocked）→ 先换号；
//   · 被拒时：429 且额度被拒（unified-status=rejected / credits_required）或 401 → noteLimitHit
//     记冷却、换号，用新号原样重发同一个请求。429 在开始流式输出之前就回来，CLI 什么都看不到；
//     已经在流的请求即使中途跨过额度线也会正常跑完（额度只在请求准入时判）。
//   · 每个响应头里的 anthropic-ratelimit-unified-* 按【实际服务的号】记进 status.mjs 分槽，
//     不用另发探针就有逐请求的实时余量。
//
// CLI 侧怎么接（claude-account.claudeEngineEnv 经 engineUpstream() 注入）：
//   ANTHROPIC_BASE_URL=http://127.0.0.1:<端口>/<随机键>
//   _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 —— CLI 自带的开关（2.1.299 实测）：把这个地址当官方 API，
//     细粒度工具流式、工具搜索等 52 处「是否官方地址」的判断照常放行。少数仍按真实地址判的边角功能
//    （Remote Control、提示缓存保活）在这条路上是关的，bridge 用不到。
//   CLAUDE_CODE_OAUTH_TOKEN 固定成号池里第一个有 token 的号——推理请求的 token 反正由代理换掉，
//     固定下来停放的 CLI 才不会因为换号判「启动参数变了」被迫冷起；CLI 直连官方的旁路请求
//    （OAuth 接口、遥测）用它即可。
// 走过 ANTHROPIC_UNIX_SOCKET（claude ssh 的通道）：Windows 上 CLI 连不上命名管道，且会关掉 bootstrap，弃用。
//
// 代理只监听 127.0.0.1、路径带随机键；一旦起来就常驻到进程退出——停放 / 在跑的 CLI 的 env 里
// 写死了这个地址，中途关掉它们就断了。开关关掉后 engineUpstream() 回 null，新起的 CLI 回到直连；
// 还挂在代理上的旧 CLI 照常转发（沿用 CLI 自己的凭证，不再自动换号）。
//
// 第二个用途（2026-10-30）：官方订阅会话的子 agent 用第三方模型。动态工作流的 agent(prompt, { model:'mimo-v2.6-flash' })
// 会把模型名原样写进 body.model；直连 api.anthropic.com 时这只会 404。会话的身份能用自定义 API、这一轮开着动态工作流、
// 也有可派的第三方模型时，CLI 走这个代理并在地址里带一段 /r/<令牌>（claude-providers-proxy 的 owner 令牌，HMAC 派生，
// 成员拼不出别人的）：body.model 是第三方模型名（claude-* 与别名一律不算）→ 整个请求转给自定义 API 代理，
// 那边按该服务的 Key / 协议 / 档位表处理（子 agent 选的 output_config.effort 照常换算）；订阅 OAuth 凭证在这一跳就剥掉，
// 绝不发给第三方。其余请求照旧去 Anthropic。无缝换号没开时代理不换号，原样沿用 CLI 自己的 Authorization。

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { activeAccountId, accountIdForToken, listAccountsWithTokens, setEngineUpstream } from './claude-account.mjs';
import { isCustomModelId, resolveSubagentModel } from './claude-providers.mjs';
import { providersProxyBase, ownerOfRouteToken } from './claude-providers-proxy.mjs';
import { seamlessActive, leaveIfBlocked, noteLimitHit, onRouterSettings } from './account-router.mjs';
import { loginToken, bucket } from './account-usage.mjs';
import { applyProbedLimits } from './status.mjs';

const UPSTREAM = String(process.env.BRIDGE_CLAUDE_UPSTREAM || 'https://api.anthropic.com').replace(/\/+$/, '');
const DEBUG = process.env.BRIDGE_UPSTREAM_DEBUG === '1';   // 逐请求打一行：用的哪个号、回了什么
const MAX_SWITCHES = 3;  // 同一个请求最多换几次号重发（防全员用尽时来回打转；noteLimitHit 无号可换也会停）

// 不往上游转的请求头：逐跳头、长度（body 原样重发由 fetch 重算）、编码（让 fetch 自己协商并解压）、鉴权（现换）。
const DROP_REQ = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'content-length', 'accept-encoding', 'authorization', 'x-api-key']);
// fetch 已解压，原始的编码与长度头不能再回给 CLI。
const DROP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length']);

// 响应头里的桶缩写 → status.mjs 的桶名（同 rate_limit_event.unifiedWindows 的键）。
const BUCKETS = { '5h': 'five_hour', '7d': 'seven_day', '7d_oi': 'seven_day_overage_included', '7d_opus': 'seven_day_opus', '7d_sonnet': 'seven_day_sonnet' };

export const upstreamEvents = new EventEmitter();   // 'switch' (entry) —— 在跑的轮据此给发起端弹「已换号」
upstreamEvents.setMaxListeners(0);

let server = null;
let baseUrl = '';
let starting = null;
let lastServed = '';   // 最近一个请求实际用的号（CLI 的 rate_limit_event 据此记账）

const tokenOf = (id) => { const a = listAccountsWithTokens().find((x) => x.id === id); return a ? (a.token || loginToken()) : ''; };

// 记下这次响应带的逐桶余量，记到实际服务的号名下。
function noteHeaders(headers, acct) {
  const h = (k) => headers.get('anthropic-ratelimit-unified-' + k);
  const out = {};
  for (const [abbr, name] of Object.entries(BUCKETS)) { const b = bucket(h, abbr); if (b) out[name] = b; }
  if (Object.keys(out).length) applyProbedLimits(out, acct);
}

// 429 是不是「额度被拒」（换号有用），而不是瞬时限流（CLI 自己退避重试就行）。
function quotaRejected(headers, text) {
  return headers.get('anthropic-ratelimit-unified-status') === 'rejected' || /credits_required/.test(text || '');
}

function resetMs(headers) {
  const s = parseInt(headers.get('anthropic-ratelimit-unified-reset') || '', 10);
  return Number.isFinite(s) ? s * 1000 : 0;
}

function writeHead(res, up) {
  const out = {};
  up.headers.forEach((v, k) => { if (!DROP_RES.has(k)) out[k] = v; });
  res.writeHead(up.status, out);
}

function fail(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

/**
 * 官方订阅会话里，这个模型名该不该转给第三方服务：回 { provider, model } 或 null（照旧去 Anthropic）。
 * claude-* 与 CLI 的别名一律不转——哪怕某个中转站也挂了同名的 Claude 型号，主循环和后台小任务也不能被拐去花别人的 Key。
 */
export function routedModel(name, owner) {
  if (!owner || typeof name !== 'string' || !name) return null;
  if (!isCustomModelId(name) && /^(claude[-_.]|opus|sonnet|haiku|fable)/i.test(name)) return null;
  return resolveSubagentModel(name, owner);
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

// 整个请求交给自定义 API 代理（同进程、127.0.0.1，用 http.request 直连，不吃全局出站代理）。
// 地址按会话的 owner 拼（不是服务的 owner）：成员用管理员共享的服务时也只拿得到自己的令牌，规则同 providerEngineEnv。
async function toProvider(req, res, hit, owner, path, body, signal) {
  const root = await providersProxyBase(owner);
  const target = new URL(`${root}/p/${hit.provider.id}/-/${encodeURIComponent(hit.model.id)}${path}`);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k) && v != null) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  if (body.length) headers['content-length'] = String(body.length);
  if (DEBUG) console.log(`[claude-upstream] ${req.method} ${path.split('?')[0]} ${hit.model.id} → 第三方 ${hit.provider.name}`);
  await new Promise((resolve) => {
    const up = http.request(target, { method: req.method, headers }, (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k) && v != null) out[k] = v;
      res.writeHead(r.statusCode || 502, out);
      pipeline(r, res).catch(() => {}).finally(resolve);
    });
    up.on('error', (e) => { if (!signal.aborted) fail(res, 502, 'bridge 上游代理转不到自定义 API 代理：' + ((e && e.message) || e)); resolve(); });
    signal.addEventListener('abort', () => { up.destroy(); resolve(); }, { once: true });
    up.end(body.length ? body : undefined);
  });
}

async function handle(req, res, key) {
  const prefix = '/' + key;
  const url = req.url || '';
  if (!url.startsWith(prefix + '/')) { res.writeHead(404); res.end(); return; }
  let path = url.slice(prefix.length);
  // /r/<令牌>：这个 CLI 的子 agent 可以派第三方模型（令牌认不出 = 拼的，一律 404）
  let owner = null;
  const rm = /^\/r\/([0-9a-f]{32})(\/.*)$/.exec(path);
  if (rm) {
    owner = ownerOfRouteToken(rm[1]);
    if (!owner) { res.writeHead(404); res.end(); return; }
    path = rm[2];
  }
  const chunks = [];
  try { for await (const c of req) chunks.push(c); } catch { return; }
  const body = Buffer.concat(chunks);
  const isMessages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(path);
  const isCount = req.method === 'POST' && /^\/v1\/messages\/count_tokens(\?|$)/.test(path);
  let model = '';
  if (isMessages || isCount) { try { model = String(JSON.parse(body.toString('utf8')).model || ''); } catch {} }

  // CLI 断开（用户停止 / 进程退出）就掐掉上游请求，别让它在后台继续烧额度。
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  const hit = owner && (isMessages || isCount) ? routedModel(model, owner) : null;
  if (hit) { await toProvider(req, res, hit, owner, path, body, ac.signal); return; }

  // 无缝换号没开（只为第三方子 agent 走这里）：不选号、不换号，沿用 CLI 自己的凭证
  const seam = seamlessActive();
  if (isMessages && seam) {
    const sw = await leaveIfBlocked(model);
    if (sw) upstreamEvents.emit('switch', sw);
  }

  for (let switches = 0; ; ) {
    const cliTok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const acct = seam ? activeAccountId() : (accountIdForToken(cliTok) || activeAccountId());
    const token = seam ? tokenOf(acct) : '';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k) && v != null) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    if (token) headers.authorization = 'Bearer ' + token;
    else if (req.headers.authorization) headers.authorization = req.headers.authorization;   // 没登记 token：沿用 CLI 自己的凭证
    let up;
    try {
      up = await fetch(UPSTREAM + path, { method: req.method, headers, body: body.length ? body : undefined, signal: ac.signal, redirect: 'manual' });
    } catch (e) {
      if (!ac.signal.aborted) fail(res, 502, 'bridge 上游代理连不上 Anthropic：' + ((e && e.cause && e.cause.code) || (e && e.message) || e));
      return;
    }
    if (seam) lastServed = acct;
    noteHeaders(up.headers, acct);
    if (DEBUG) console.log(`[claude-upstream] ${req.method} ${path.split('?')[0]} ${model || '-'} via ${acct} → ${up.status}`);
    if (isMessages && (up.status === 429 || up.status === 401) && seamlessActive() && switches < MAX_SWITCHES) {
      const text = await up.text().catch(() => '');
      const kind = up.status === 401 ? 'auth' : quotaRejected(up.headers, text) ? 'rate_limit' : '';
      if (kind) {
        const sw = await noteLimitHit(acct, {
          kind, model, resetsAt: resetMs(up.headers),
          type: kind === 'auth' ? '' : (up.headers.get('anthropic-ratelimit-unified-representative-claim') || ''),
        });
        if (sw && activeAccountId() !== acct) {
          console.log(`[claude-upstream] ${up.status} on ${sw.fromLabel} → retry on ${sw.toLabel}`);
          // already：并发的另一个请求刚替我们换过了——提示它已经发过，别弹两次。
          if (!sw.already) upstreamEvents.emit('switch', sw);
          switches++;
          continue;
        }
      }
      writeHead(res, up);
      res.end(text);
      return;
    }
    writeHead(res, up);
    if (!up.body) { res.end(); return; }
    try { await pipeline(Readable.fromWeb(up.body), res); } catch {}   // CLI 断开 / 上游断流：两头各自收尾
    return;
  }
}

async function start() {
  const key = randomBytes(16).toString('hex');
  const srv = http.createServer((req, res) => {
    handle(req, res, key).catch((e) => { console.error('[claude-upstream] request failed:', (e && e.message) || e); fail(res, 502, 'bridge 上游代理出错'); });
  });
  srv.requestTimeout = 0;           // 长思考的流式回答可以跑很久
  srv.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  srv.unref();
  server = srv;
  baseUrl = `http://127.0.0.1:${srv.address().port}/${key}`;
  console.log(`[claude-upstream] listening on 127.0.0.1:${srv.address().port}`);
}

function ensure() {
  if (server || starting) return starting;
  starting = start().catch((e) => { console.error('[claude-upstream] start failed:', (e && e.message) || e); }).finally(() => { starting = null; });
  return starting;
}

// 启动时调一次：开关开着就把代理起好；之后开关一开就起（起了就不关，见文件头）。
export function initClaudeUpstream() {
  setEngineUpstream(engineUpstream);
  if (seamlessActive()) ensure();
  onRouterSettings(() => { if (seamlessActive()) ensure(); });
}

// claude-account.claudeEngineEnv 用：无缝换号生效、或这一轮要派第三方子 agent（route = providerRouteToken(owner)），
// 且代理已就绪 → { baseUrl, token? }，否则 null（直连，行为同以前）。只为第三方子 agent 走代理时不带 token
//（CLI 照旧用激活号，代理原样转发）。刚打开开关、代理还在起的那一轮照旧直连——要派第三方的轮先 await ensureClaudeUpstream()。
export function engineUpstream({ route } = {}) {
  const seam = seamlessActive();
  if (!seam && !route) return null;
  if (!baseUrl) { ensure(); return null; }
  const url = route ? `${baseUrl}/r/${route}` : baseUrl;
  if (!seam) return { baseUrl: url };
  const first = listAccountsWithTokens().find((a) => a.token);
  return { baseUrl: url, token: first ? first.token : '' };
}

/** 起好代理再返回（要派第三方子 agent 的轮在取 env 之前调，免得第一轮直连）。 */
export async function ensureClaudeUpstream() { await ensure(); return !!baseUrl; }

// 这个 env 是不是「无缝换号」的走法（一轮可能横跨几个号，额度事件记到实际服务的号名下）。只为第三方子 agent 走代理的不算。
export function isUpstreamEnv(env) { return !!(env && baseUrl && seamlessActive() && String(env.ANTHROPIC_BASE_URL || '').startsWith(baseUrl)); }

// 最近一个推理请求实际用的号（无缝模式下一轮可能横跨几个号，额度事件记到它名下）。
export function lastServedAccount() { return lastServed; }
