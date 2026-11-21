// Antigravity 本机上游转发代理（路线 A 核心）：
// 启动常驻 `agy acp --cloud_code_endpoint http://127.0.0.1:<端口>/<随机键>` 后，
// agy 发往 daily-cloudcode-pa.googleapis.com 的全部 /v1internal:* 请求都先经过这里：
//   · 零配置透传：单号默认状态下记录宿主实时 Bearer token / User-Agent / project，行为与直连完全一致；
//   · 零重启切号与智能分派：对 streamGenerateContent / generateContent / countTokens 按号池路由
//     替换 Authorization 头与请求体 project 字段；
//   · 会话中无缝换号：撞 429 QUOTA_EXHAUSTED / 401 / 403 VALIDATION_REQUIRED 且尚未写出响应头时，
//     记冷却、换号并原地重发（最多 3 次），agy 侧无感知、对话不中断；
//   · 旁路解析 SSE 里的 usageMetadata 与 retrieveUserQuotaSummary，反哺计量与额度缓存。

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { plainDispatcher } from '@bridge/core/runtime/net-proxy.mjs';
import {
  activeAccountId,
  getAccountInternal,
  highestTierAccountId,
  localAccountId,
} from './accounts.mjs';
import {
  CCPA_UPSTREAM,
  noteHostAuth,
  getAccessToken,
  fetchAccountProfile,
  invalidateAccessToken,
} from './oauth.mjs';
import { noteAccountMeta } from './accounts.mjs';
import { noteQuotaFromUpstream } from './quota.mjs';
import {
  pickForRequest,
  noteLimitHit,
  dispatchBegin,
  dispatchEnd,
  seamlessActive,
  routerEnabled,
  smartActive,
  resolveAcpSessionId,
  groupOfModel,
} from './router.mjs';

const DEBUG = process.env.BRIDGE_AGY_UPSTREAM_DEBUG === '1';
const MAX_SWITCHES = 3;

const DROP_REQ = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length', 'accept-encoding', 'authorization',
]);
const DROP_RES = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length',
]);

export const agyUpstreamEvents = new EventEmitter();
agyUpstreamEvents.setMaxListeners(0);

let server = null;
let baseUrl = '';
let routeKey = '';
let starting = null;
let lastServed = '';
const servedBySid = new Map();
const seenTurnRequest = new Set(); // 记录已跑过首请求的会话，供 primary 策略区分轮次边界

let fetchOverride = null;
function doFetch(url, init = {}) {
  if (fetchOverride) return fetchOverride(url, init);
  const plain = plainDispatcher();
  return fetch(url, { ...init, ...(plain ? { dispatcher: plain } : {}) });
}

function noteServed(sid, acctId) {
  lastServed = acctId;
  if (!sid) return;
  servedBySid.delete(sid);
  servedBySid.set(sid, acctId);
  if (servedBySid.size > 500) servedBySid.delete(servedBySid.keys().next().value);
}

export function lastServedAgyAccount(sid = '') {
  return (sid && servedBySid.get(sid)) || lastServed || activeAccountId();
}

export function extractSessionIdFromRequestId(requestId = '') {
  const m = /^agent\/([0-9a-f-]{8,64})(?:\/|$)/i.exec(String(requestId || '').trim());
  return m ? m[1] : '';
}

export function parseGoogleResetMs(text = '', headers = null) {
  const now = Date.now();
  const retryAfter = headers?.get?.('retry-after');
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec) && sec > 0) return now + sec * 1000;
    const dt = Date.parse(retryAfter);
    if (Number.isFinite(dt) && dt > now) return dt;
  }
  const isoMatch = /"(?:quotaResetTimeStamp|resetTime)"\s*:\s*"([^"]+)"/i.exec(text);
  if (isoMatch) {
    const dt = Date.parse(isoMatch[1]);
    if (Number.isFinite(dt) && dt > now) return dt;
  }
  const durMatch = /"(?:quotaResetDelay|retryDelay)"\s*:\s*"([^"]+)"/i.exec(text);
  if (durMatch) {
    const raw = durMatch[1];
    let ms = 0;
    for (const part of raw.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/gi)) {
      const n = Number(part[1]);
      const u = part[2].toLowerCase();
      if (u === 'h') ms += n * 3600_000;
      else if (u === 'm') ms += n * 60_000;
      else if (u === 's') ms += n * 1000;
    }
    if (ms > 0) return now + ms;
  }
  return 0;
}

export function classifyUpstreamError(status, text = '') {
  const s = String(text || '');
  if (status === 401 || /\bUNAUTHENTICATED\b/i.test(s)) return 'auth';
  if (status === 403 && /\b(?:VALIDATION_REQUIRED|PERMISSION_DENIED|ineligible|account.*disabled)\b/i.test(s)) {
    return 'validation';
  }
  if (status === 429 || /\bRESOURCE_EXHAUSTED\b/i.test(s)) {
    if (/\b(?:MODEL_CAPACITY_EXHAUSTED|PREFILL_QUEUE_OVERLOADED)\b/i.test(s) && !/\bQUOTA_EXHAUSTED\b/i.test(s)) {
      return 'capacity';
    }
    return 'rate_limit';
  }
  if (status === 503 && /\b(?:MODEL_CAPACITY_EXHAUSTED|OVERLOADED)\b/i.test(s)) return 'capacity';
  return '';
}

function writeHead(res, up) {
  const out = {};
  up.headers.forEach((v, k) => {
    if (!DROP_RES.has(k.toLowerCase())) out[k] = v;
  });
  res.writeHead(up.status, out);
}

function failJson(res, status, message) {
  if (res.headersSent) { try { res.destroy(); } catch {} return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { code: status, message, status: 'UNAVAILABLE' } }));
}

function sseUsageTap(contentType, onDone) {
  const isSse = /event-stream/i.test(String(contentType || ''));
  const dec = new TextDecoder();
  let buf = '';
  let lastUsage = null;
  const inspectLine = (line) => {
    if (!line.includes('usageMetadata')) return;
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const j = JSON.parse(payload);
      const u = j?.response?.usageMetadata || j?.usageMetadata;
      if (u && typeof u === 'object') lastUsage = u;
    } catch {}
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        if (isSse) {
          buf += dec.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            inspectLine(buf.slice(0, idx).trimEnd());
            buf = buf.slice(idx + 1);
          }
          if (buf.length > (1 << 20)) buf = '';
        } else if (buf.length < (2 << 20)) {
          buf += dec.decode(chunk, { stream: true });
        }
      } catch {}
      cb(null, chunk);
    },
    flush(cb) {
      try {
        if (buf.trim()) inspectLine(buf.trimEnd());
      } catch {}
      try { onDone?.(lastUsage); } catch {}
      cb();
    },
  });
}

async function resolveAccountCredentials(accountId, hostAuthHeader, { forceRefresh = false } = {}) {
  const acct = getAccountInternal(accountId);
  if (!acct) return { authHeader: hostAuthHeader || '', project: '', isLocal: true, error: '' };
  if (!acct.refreshToken) {
    return {
      authHeader: hostAuthHeader || '',
      project: acct.project || '',
      isLocal: true,
      error: '',
    };
  }
  const tok = await getAccessToken(acct.id, { forceRefresh });
  if (!tok.token) {
    return { authHeader: '', project: acct.project || '', isLocal: false, error: tok.error || '令牌不可用' };
  }
  let project = acct.project || '';
  if (!project) {
    const prof = await fetchAccountProfile(tok.token);
    if (prof.email || prof.project || prof.tierId || prof.tierName) {
      noteAccountMeta(acct.id, prof);
      project = prof.project || '';
    }
  }
  return { authHeader: 'Bearer ' + tok.token, project, isLocal: false, error: '' };
}

function buildForwardHeaders(reqHeaders, authHeader) {
  const headers = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (DROP_REQ.has(k.toLowerCase()) || v == null) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (authHeader) headers.authorization = authHeader;
  return headers;
}

function rewriteProjectBody(rawBody, bodyObj, targetProject) {
  if (!bodyObj || typeof bodyObj !== 'object') return rawBody;
  if (!Object.hasOwn(bodyObj, 'project') || !targetProject) return rawBody;
  if (bodyObj.project === targetProject) return rawBody;
  return Buffer.from(JSON.stringify({ ...bodyObj, project: targetProject }), 'utf8');
}

async function handleRequest(req, res) {
  const prefix = '/' + routeKey;
  const rawUrl = req.url || '';
  if (!rawUrl.startsWith(prefix + '/')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const upstreamPath = rawUrl.slice(prefix.length);
  const chunks = [];
  try {
    for await (const c of req) chunks.push(c);
  } catch {
    return;
  }
  const rawBody = Buffer.concat(chunks);
  const hostAuthHeader = String(req.headers.authorization || '').trim();
  const hostUa = String(req.headers['user-agent'] || '').trim();

  let bodyObj = null;
  if (rawBody.length > 0 && /json/i.test(String(req.headers['content-type'] || ''))) {
    try { bodyObj = JSON.parse(rawBody.toString('utf8')); } catch {}
  }

  // 记录本机宿主 agy 的实时认证上下文（仅在内存里，给默认账号直查额度与 UA 复用）。
  if (hostAuthHeader || hostUa) {
    noteHostAuth({
      authHeader: hostAuthHeader,
      userAgent: hostUa,
      project: typeof bodyObj?.project === 'string' ? bodyObj.project : '',
    });
  }

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  const isInference = req.method === 'POST' && /^\/v1internal:(?:streamGenerateContent|generateContent)(\?|$)/i.test(upstreamPath);
  const isCountTokens = req.method === 'POST' && /^\/v1internal:countTokens(\?|$)/i.test(upstreamPath);
  const isQuotaSummary = req.method === 'POST' && /^\/v1internal:retrieveUserQuotaSummary(\?|$)/i.test(upstreamPath);
  const isModelsList = req.method === 'POST' && /^\/v1internal:fetchAvailableModels(\?|$)/i.test(upstreamPath);
  const isLoadCodeAssist = req.method === 'POST' && /^\/v1internal:loadCodeAssist(\?|$)/i.test(upstreamPath);
  const isFetchUserInfo = req.method === 'POST' && /^\/v1internal:fetchUserInfo(\?|$)/i.test(upstreamPath);

  // ── 1. 非推理控制面请求 ──────────────────────────────────────────────────────
  if (!isInference && !isCountTokens) {
    let targetId = activeAccountId();
    // 拉模型目录用池内最高档号，避免低档号把 Ultra 模型隐藏掉；loadCodeAssist 优先沿用宿主号拿宿主 project。
    if (isModelsList) targetId = highestTierAccountId() || targetId;
    else if ((isLoadCodeAssist || isFetchUserInfo) && hostAuthHeader) targetId = localAccountId() || targetId;
    else if (isQuotaSummary && smartActive()) targetId = activeAccountId();

    let creds = await resolveAccountCredentials(targetId, hostAuthHeader);
    // 宿主没登录但池里有 OAuth 号时，控制面也代签，保证纯号池模式可独立启动。
    if (!creds.authHeader && hostAuthHeader) creds = { authHeader: hostAuthHeader, project: '', isLocal: true };

    const fwdBody = creds.isLocal ? rawBody : rewriteProjectBody(rawBody, bodyObj, creds.project);
    const headers = buildForwardHeaders(req.headers, creds.authHeader);
    let up;
    try {
      up = await doFetch(CCPA_UPSTREAM() + upstreamPath, {
        method: req.method,
        headers,
        body: fwdBody.length ? fwdBody : undefined,
        signal: ac.signal,
        redirect: 'manual',
      });
    } catch (e) {
      if (!ac.signal.aborted) failJson(res, 502, 'Antigravity 上游代理连接失败：' + (e?.message || e));
      return;
    }

    if (isLoadCodeAssist || isQuotaSummary || isFetchUserInfo) {
      const text = await up.text().catch(() => '');
      try {
        const parsed = JSON.parse(text);
        if (isLoadCodeAssist && parsed?.cloudaicompanionProject) {
          const tier = parsed.paidTier || parsed.currentTier || null;
          if (creds.isLocal) {
            noteHostAuth({
              project: parsed.cloudaicompanionProject,
              tierId: tier?.id || '',
              tierName: tier?.name || '',
            });
          } else if (targetId) {
            noteAccountMeta(targetId, {
              project: parsed.cloudaicompanionProject,
              tierId: tier?.id || '',
              tierName: tier?.name || '',
            });
          }
        } else if (isFetchUserInfo) {
          const email = String(parsed?.email || parsed?.userEmail || parsed?.userInfo?.email || '').trim();
          if (email) {
            if (creds.isLocal) noteHostAuth({ email });
            else if (targetId) noteAccountMeta(targetId, { email });
          }
        } else if (isQuotaSummary && up.ok && targetId) {
          noteQuotaFromUpstream(targetId, parsed);
        }
      } catch {}
      writeHead(res, up);
      res.end(text);
      return;
    }

    writeHead(res, up);
    if (!up.body) { res.end(); return; }
    try { await pipeline(Readable.fromWeb(up.body), res); } catch {}
    return;
  }

  // ── 2. 模型推理与 countTokens：按号池路由选号 + 撞墙无缝换号重发 ──────────────
  const model = String(bodyObj?.model || '');
  const requestType = String(bodyObj?.requestType || 'agent');
  const rawSid = extractSessionIdFromRequestId(bodyObj?.requestId || '');
  const innerSid = String(bodyObj?.request?.sessionId || '');
  const resolvedSid = resolveAcpSessionId(rawSid, innerSid);
  const hasContinuation = Boolean(
    bodyObj?.continuation_token || bodyObj?.continuationToken || bodyObj?.request?.continuation_token
  );
  const turnKey = resolvedSid ? `${resolvedSid}:${groupOfModel(model)}` : '';
  const isPrimaryTurnStart = isInference && requestType === 'agent' && (!turnKey || !seenTurnRequest.has(turnKey));
  if (turnKey) {
    seenTurnRequest.add(turnKey);
    if (seenTurnRequest.size > 400) seenTurnRequest.clear();
  }

  let refreshedOnce = new Set();

  for (let switches = 0; ; ) {
    const picked = await pickForRequest({
      sid: rawSid,
      innerSid,
      model,
      requestType,
      hasContinuation,
      isPrimaryTurnStart: switches === 0 && isPrimaryTurnStart,
    });
    if (picked.entry && !picked.entry.already) {
      agyUpstreamEvents.emit('switch', picked.entry);
    }

    const acctId = picked.accountId || activeAccountId();
    const task = isInference ? picked.task : null;
    const creds = await resolveAccountCredentials(acctId, hostAuthHeader, { forceRefresh: false });

    if (!creds.authHeader) {
      if (isInference && routerEnabled() && seamlessActive() && switches < MAX_SWITCHES) {
        const sw = await noteLimitHit(acctId, { kind: 'auth', model, sid: resolvedSid });
        if (sw && sw.to !== acctId) {
          if (!sw.already) agyUpstreamEvents.emit('switch', sw);
          switches++;
          continue;
        }
      }
      failJson(res, 401, creds.error || '当前账号缺少有效凭据，请检查账号池登录状态');
      return;
    }

    const fwdBody = creds.isLocal ? rawBody : rewriteProjectBody(rawBody, bodyObj, creds.project);
    const headers = buildForwardHeaders(req.headers, creds.authHeader);

    dispatchBegin(task);
    let up;
    try {
      up = await doFetch(CCPA_UPSTREAM() + upstreamPath, {
        method: req.method,
        headers,
        body: fwdBody.length ? fwdBody : undefined,
        signal: ac.signal,
        redirect: 'manual',
      });
    } catch (e) {
      dispatchEnd(task);
      if (!ac.signal.aborted) failJson(res, 502, 'Antigravity 上游代理连接失败：' + (e?.message || e));
      return;
    }

    if (DEBUG) console.log(`[agy-upstream] ${req.method} ${upstreamPath.split('?')[0]} ${model || '-'} via ${acctId} → ${up.status}`);
    noteServed(resolvedSid, acctId);

    // 401 先尝试原地强制刷新一次 OAuth token；仍失败再进入换号流程。
    if (up.status === 401 && !creds.isLocal && !refreshedOnce.has(acctId)) {
      refreshedOnce.add(acctId);
      invalidateAccessToken(acctId);
      await up.text().catch(() => {});
      dispatchEnd(task);
      const retryCreds = await resolveAccountCredentials(acctId, hostAuthHeader, { forceRefresh: true });
      if (retryCreds.authHeader) continue;
    }

    // 拦截 429 / 401 / 403 VALIDATION_REQUIRED / 503 过载：记冷却并在开着无缝换号时原地切号重发。
    if (!up.ok && (up.status === 429 || up.status === 401 || up.status === 403 || up.status === 503)) {
      const errText = await up.text().catch(() => '');
      dispatchEnd(task);
      const errKind = classifyUpstreamError(up.status, errText);
      if (errKind && isInference) {
        const resetAt = parseGoogleResetMs(errText, up.headers);
        const sw = await noteLimitHit(acctId, { kind: errKind, model, resetAt, sid: resolvedSid });
        if (sw && sw.to !== acctId && seamlessActive() && switches < MAX_SWITCHES) {
          if (!sw.already) agyUpstreamEvents.emit('switch', sw);
          switches++;
          continue;
        }
      }
      writeHead(res, up);
      res.end(errText);
      return;
    }

    writeHead(res, up);
    if (!up.body) {
      dispatchEnd(task);
      res.end();
      return;
    }
    try {
      if (isInference && up.ok) {
        await pipeline(
          Readable.fromWeb(up.body),
          sseUsageTap(up.headers.get('content-type'), (u) => {
            const total = u ? (Number(u.totalTokenCount) || ((Number(u.promptTokenCount) || 0) + (Number(u.candidatesTokenCount) || 0))) : 0;
            dispatchEnd(task, total);
          }),
          res,
        );
      } else {
        await pipeline(Readable.fromWeb(up.body), res);
        dispatchEnd(task);
      }
    } catch {
      dispatchEnd(task);
    }
    return;
  }
}

async function startServer() {
  routeKey = randomBytes(12).toString('hex');
  const srv = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[agy-upstream] 请求处理失败：', err?.message || err);
      failJson(res, 502, 'Antigravity 上游代理内部错误');
    });
  });
  srv.requestTimeout = 0;
  srv.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  srv.unref?.();
  server = srv;
  baseUrl = `http://127.0.0.1:${srv.address().port}/${routeKey}`;
  console.log(`[agy-upstream] listening on 127.0.0.1:${srv.address().port}`);
  return baseUrl;
}

export async function ensureAgyUpstream() {
  if (baseUrl && server) return baseUrl;
  if (starting) return starting;
  starting = startServer()
    .catch((err) => {
      console.error('[agy-upstream] 启动失败：', err?.message || err);
      return '';
    })
    .finally(() => { starting = null; });
  return starting;
}

export function getAgyUpstreamUrl() {
  return baseUrl;
}

export function agyUpstreamStatus() {
  return {
    running: !!(server && baseUrl),
    port: server?.address?.()?.port || null,
  };
}

export function stopAgyUpstream() {
  if (!server) return;
  try { server.closeAllConnections?.(); } catch {}
  try { server.close(); } catch {}
  server = null;
  baseUrl = '';
  routeKey = '';
}

export function _setUpstreamFetchForTest(fn) {
  fetchOverride = fn || null;
}

export function _resetUpstreamForTest() {
  stopAgyUpstream();
  lastServed = '';
  servedBySid.clear();
  seenTurnRequest.clear();
  fetchOverride = null;
}

process.once('exit', () => {
  try { stopAgyUpstream(); } catch {}
});
