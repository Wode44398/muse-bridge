// 模型网关里「ChatGPT 订阅」服务的上游处理器（gateway.registerUpstream('chatgpt', …)）。
//
//   /<服务>/openai/chat/completions   Claude 的本机代理、dimensio 发来的 Chat Completions → 翻成 Responses 打订阅通道 → 翻回来
//   /<服务>/openai/models             这个服务已添加的文本模型
//   /<服务>/responses/responses        Codex（经 responses/handler.mjs 转进来）：清洗请求体后透传
//
// 一条线路 = 一个 ChatGPT 账号：按线路池的顺序取，账号额度用完 / 不能用就冷却、换下一个；401 先刷新令牌再试一次。
// 订阅通道的失败可能在流开始之后才以 response.failed 到达：先读到第一条有内容的事件再决定成败，在那之前的失败照样能换账号。
import { Agent } from 'undici';
import { readSse, sseEvent } from '../responses/sse.mjs';
import { lineOrder, noteLine } from '../pool.mjs';
import { accessTokenFor } from './tokens.mjs';
import { chatToResponses } from './chat-in.mjs';
import { ChatFromResponses, isContentEvent, isTerminalEvent, failureOf } from './chat-out.mjs';
import { rememberReasoning, recallReasoning } from './reasoning-cache.mjs';
import { EP, USAGE_URL, UNSUPPORTED_FIELDS, UNSUPPORTED_TOOLS } from './const.mjs';

const MIN = 60_000;
const DIRECT = new Agent({ connect: { timeout: 30_000 } });
const errJson = (status, message, code = 'invalid_request_error', type = 'invalid_request_error') => ({ status, json: { error: { message, type, code } } });

const LIMIT_MSG = `ChatGPT 套餐额度用完了（可能是套餐本身的额度、Plus 的 5 小时窗口，或你给这个应用设的上限）。到 ChatGPT 设置 › 用量 查看：${USAGE_URL}`;

/**
 * 订阅通道的失败 → 怎么处理。官方的码表（errors-and-recovery）：额度用完别猜重置时间；不能用套餐的别反复重试；
 * 查不到额度 / 用户信息暂时不可用的退避重试。failover = 换下一个账号能不能有用。
 */
export function classify(status, code, detail = '') {
  const d = String(detail || '').slice(0, 200);
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded': return { status: 429, cool: 15 * MIN, why: '额度用完', failover: true, message: LIMIT_MSG };
    case 'subscription_sharing_user_not_eligible': return { status: 403, cool: 6 * 60 * MIN, why: '不能用套餐额度', failover: true, message: '这个 ChatGPT 账号不能用套餐额度（需要付费套餐，或被所在工作区的策略限制）' };
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable': return { status: 503, cool: MIN, why: '暂时不可用', failover: true, message: `ChatGPT 暂时查不到这个账号的额度，稍后再试${d ? `（${d}）` : ''}` };
    case 'subscription_sharing_invalid_user': return { status: 401, cool: 30 * MIN, why: '凭据不被接受', failover: true, message: '这个 ChatGPT 账号的凭据不被接受，请在「模型中心」里重新登录' };
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context': return { status: 403, cool: 30 * MIN, why: '授权不够', failover: true, message: `这个账号的授权不允许这次请求，请在「模型中心」里重新登录并同意使用套餐额度${d ? `（${d}）` : ''}` };
    case 'subscription_sharing_route_not_supported': return { status: 400, cool: 0, failover: false, message: `订阅通道不支持这个接口${d ? `：${d}` : ''}` };
    case 'subscription_sharing_unsupported_capability': return { status: 400, cool: 0, failover: false, message: `订阅通道不支持这次请求里的某项功能${d ? `：${d}` : ''}` };
    default: break;
  }
  if (status === 401) return { status, cool: 30 * MIN, why: '凭据不被接受', failover: true, message: `ChatGPT 不接受这个账号的凭据，请在「模型中心」里重新登录${d ? `（${d}）` : ''}` };
  if (status === 403) return { status, cool: 30 * MIN, why: '被拒绝', failover: true, message: `ChatGPT 拒绝了这次请求（权限或所在地区的限制）${d ? `：${d}` : ''}` };
  if (status === 429) return { status, cool: MIN, why: '限流', failover: true, message: `ChatGPT 限流了，稍后再试${d ? `（${d}）` : ''}` };
  if (status === 503) return { status, cool: MIN, why: '暂时不可用', failover: true, message: `订阅通道暂时不可用，稍后再试${d ? `（${d}）` : ''}` };
  if (status >= 500) return { status, cool: 20_000, why: '上游出错', failover: true, message: `ChatGPT 那边出错了（HTTP ${status}）${d ? `：${d}` : ''}` };
  return { status: status || 400, cool: 0, failover: false, message: d || `ChatGPT 拒绝了这次请求（HTTP ${status}）` };
}

/** 失败应答的正文 → { code, message, param }（直连准入阶段可能只有 { detail }）。 */
async function errorBody(res) {
  let text = '';
  try { text = (await res.text()).slice(0, 4000); } catch {}
  let j = null;
  try { j = JSON.parse(text); } catch {}
  const e = j?.error && typeof j.error === 'object' ? j.error : null;
  return {
    code: String(e?.code || (typeof j?.error === 'string' ? j.error : '') || ''),
    message: String(e?.message || j?.detail || j?.message || text || '').slice(0, 300),
    param: String(e?.param || ''),
    text,
  };
}

function post(service, token, body, signal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), (service.timeoutSec || 600) * 1000);
  const sig = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
  return fetch(`${EP.plan}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body), signal: sig,
    ...(service.useProxy === false ? { dispatcher: DIRECT } : {}),
  }).finally(() => clearTimeout(timer));
}

const parseEv = ({ data }) => {
  if (!data || data === '[DONE]') return null;
  try { const j = JSON.parse(data); return j && typeof j === 'object' && typeof j.type === 'string' ? j : null; } catch { return null; }
};
/** 读到第一条有内容（或结束）的事件为止 → { iter, head: 已读的事件, first }。 */
async function peek(res, signal) {
  const iter = readSse(res.body, signal)[Symbol.asyncIterator]();
  const head = [];
  for (;;) {
    const { value, done } = await iter.next();
    if (done) return { iter, head, first: null };
    const ev = parseEv(value);
    if (!ev) continue;
    head.push(ev);
    if (isContentEvent(ev) || isTerminalEvent(ev)) return { iter, head, first: ev };
  }
}
async function* events(p) {
  for (const ev of p.head) yield ev;
  for (;;) {
    const { value, done } = await p.iter.next();
    if (done) return;
    const ev = parseEv(value);
    if (ev) yield ev;
  }
}

// 被拒的请求体能不能改一下再发一次（同一个账号）：回放的加密推理不认（换过账号 / 过期）→ 不回放；
// 某个工具不被支持（多半是 web_search：看模型与账号策略）→ 去掉那一类工具
function fixFor(err, tried) {
  const t = `${err.code} ${err.param} ${err.message}`;
  if (!tried.has('noReplay') && /encrypted|reasoning/i.test(t) && err.code !== 'subscription_sharing_unsupported_capability') return 'noReplay';
  if (!tried.has('noWebSearch') && err.code === 'subscription_sharing_unsupported_capability' && /tool|web_search/i.test(t)) return 'noWebSearch';
  return '';
}

/**
 * 按账号依次发：build(line, fixes) → Responses 请求体。成功 → { ok: true, line, p（peek 的结果）}；
 * 失败 → { ok: false, status, json }（换完所有账号都不行，或者请求本身有问题）。
 */
async function send(service, build, signal) {
  const order = lineOrder(service);
  if (!order.length) return errJson(503, `「${service.name}」没有启用的 ChatGPT 账号：到「模型中心」里添加或启用一个账号`, 'no_account', 'server_error');
  const fails = [];
  for (const line of order) {
    const fail = (c) => { noteLine(service.id, line.id, { status: c.status, error: c.why || c.message, coolMs: c.cool, why: c.why || '' }); fails.push({ line, c }); };
    let token;
    try { token = await accessTokenFor(service.id, line.id); }
    catch (e) {
      const transient = e?.code === 'transient';
      fail({ status: transient ? 503 : 401, cool: transient ? 20_000 : 30 * MIN, why: transient ? '刷新令牌失败' : '要重新登录', failover: true, message: String(e?.message || e) });
      continue;
    }
    const tried = new Set();
    let res, err = null;
    for (let round = 0; round < 4; round++) {
      try { res = await post(service, token, build(line, tried), signal); }
      catch (e) {
        if (signal?.aborted) throw e;
        res = null;
        fail({ status: 0, cool: 20_000, why: '连不上', failover: true, message: `连不上 ChatGPT 的接口：${String(e?.cause?.code || e?.message || e).slice(0, 120)}（检查出站代理）` });
        break;
      }
      if (res.status === 401 && !tried.has('refresh')) {
        tried.add('refresh');
        await res.body?.cancel?.().catch(() => {});
        try { token = await accessTokenFor(service.id, line.id, { force: true }); continue; }
        catch (e) { res = null; fail({ status: 401, cool: 30 * MIN, why: '要重新登录', failover: true, message: String(e?.message || e) }); break; }
      }
      if (res.ok) break;
      err = await errorBody(res);
      const fix = res.status === 400 ? fixFor(err, tried) : '';
      if (fix) { tried.add(fix); err = null; continue; }
      break;
    }
    if (!res) continue;
    if (!res.ok) {
      const c = classify(res.status, err?.code, err?.message);
      if (!c.failover) { noteLine(service.id, line.id, { status: res.status, error: c.message }); return errJson(c.status, c.message, err?.code || 'invalid_request_error'); }
      fail(c);
      continue;
    }
    let p;
    try { p = await peek(res, signal); }
    catch (e) {
      if (signal?.aborted) throw e;
      fail({ status: 502, cool: 20_000, why: '流断了', failover: true, message: `ChatGPT 的回复流断了：${String(e?.message || e).slice(0, 120)}` });
      continue;
    }
    const f = p.first;
    if (!f || f.type === 'response.failed' || f.type === 'error') {
      await p.iter.return?.().catch(() => {});
      const fe = f ? failureOf(f) : { code: 'server_error', message: 'ChatGPT 没有回任何内容' };
      const c = classify(fe.code === 'server_error' ? 502 : 0, fe.code, fe.message);
      if (!c.failover) { noteLine(service.id, line.id, { status: c.status, error: c.message }); return errJson(c.status, c.message, fe.code); }
      fail(c);
      continue;
    }
    noteLine(service.id, line.id, { ok: true, status: 200 });
    return { ok: true, line, p };
  }
  return allFailed(fails);
}

// 所有账号都不行：额度用完的优先报（agent 会按限流处理、等一会儿），多个账号时逐个写明原因
function allFailed(fails) {
  if (!fails.length) return errJson(502, '所有 ChatGPT 账号都不可用', 'upstream_error', 'upstream_error');
  const main = fails.find((f) => f.c.status === 429) || fails[fails.length - 1];
  const each = fails.length > 1 ? '\n' + fails.map((f) => `· ${f.line.label || f.line.id}：${f.c.why || f.c.message}`).join('\n') : '';
  const st = main.c.status || 502;
  return errJson(st, main.c.message + each, st === 429 ? 'rate_limit_exceeded' : 'upstream_error', 'upstream_error');
}

// 流里中途失败（已经开始回内容之后）：账号该冷却的照样冷却，下一次请求就绕开它
const coolOnFail = (service, line) => (fe) => {
  const c = classify(0, fe.code, fe.message);
  if (c.cool) noteLine(service.id, line.id, { status: c.status, error: c.why, coolMs: c.cool, why: c.why, counted: false });
};

// —— Chat Completions ——————————————————————————————————————————

async function chatCompletions(service, body, signal) {
  let chat;
  try { chat = JSON.parse(Buffer.from(body || []).toString('utf8') || '{}'); } catch { return errJson(400, '请求体不是 JSON'); }
  if (!chat || typeof chat !== 'object' || !Array.isArray(chat.messages)) return errJson(400, '请求里没有 messages');
  const model = String(chat.model || service.defaultModel || '');
  if (!model) return errJson(400, '请求里没有 model');
  chat.model = model;
  const scope = (line) => `${service.id}/${line.id}`;
  const build = (line, tried) => {
    const b = chatToResponses(chat, { recall: tried.has('noReplay') ? null : (q) => recallReasoning(scope(line), q) });
    if (tried.has('noWebSearch') && b.tools) b.tools = b.tools.filter((t) => t.type !== 'web_search');
    return b;
  };
  const r = await send(service, build, signal);
  if (!r.ok) return r;
  const tr = new ChatFromResponses({
    model, includeUsage: chat.stream_options?.include_usage !== false,
    onDone: (x) => rememberReasoning(scope(r.line), x),
    onFail: coolOnFail(service, r.line),
  });
  if (chat.stream !== true) {
    try { for await (const ev of events(r.p)) { tr.push(ev); if (tr.done) break; } }
    finally { await r.p.iter.return?.().catch(() => {}); }
    if (tr.error) return errJson(502, tr.error.message, tr.error.code, 'upstream_error');
    if (!tr.done) return errJson(502, 'ChatGPT 的回复流没说完就断了', 'server_error', 'upstream_error');
    return { status: 200, json: tr.message() };
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const write = (o) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      try {
        for await (const ev of events(r.p)) { for (const c of tr.push(ev)) write(c); if (tr.done) break; }
        if (!tr.done) for (const c of tr.cut()) write(c);
      } catch (e) {
        if (!tr.done) write({ error: { message: `ChatGPT 的回复流断了：${String(e?.message || e).slice(0, 160)}`, type: 'upstream_error', code: 'server_error' } });
      } finally {
        await r.p.iter.return?.().catch(() => {});
        try { ctrl.enqueue(enc.encode('data: [DONE]\n\n')); ctrl.close(); } catch {}
      }
    },
    cancel() { r.p.iter.return?.().catch(() => {}); },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

// —— Responses 透传（Codex）——————————————————————————————————————

/** Codex 发来的 Responses 请求 → 订阅通道收的形状。 */
export function sanitizeResponses(req, { dropTools = [] } = {}) {
  const b = { ...req };
  for (const k of UNSUPPORTED_FIELDS) delete b[k];
  b.store = false;
  b.stream = true;
  if (typeof b.input === 'string') b.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: b.input }] }];
  else if (Array.isArray(b.input)) b.input = b.input.map((it) => (it && it.type === 'message' && it.role === 'system' ? { ...it, role: 'developer' } : it));
  if (Array.isArray(b.tools)) {
    b.tools = b.tools.filter((t) => t && !UNSUPPORTED_TOOLS.has(t.type) && !dropTools.includes(t.type));
    if (!b.tools.length) { delete b.tools; delete b.tool_choice; delete b.parallel_tool_calls; }
  }
  return b;
}

async function responsesPassthrough(service, body, signal) {
  let req;
  try { req = JSON.parse(Buffer.from(body || []).toString('utf8') || '{}'); } catch { return errJson(400, '请求体不是 JSON'); }
  if (!req || typeof req !== 'object') return errJson(400, '请求体不是 JSON 对象');
  const wantStream = req.stream !== false;
  const build = (_line, tried) => sanitizeResponses(req, { dropTools: tried.has('noWebSearch') ? ['web_search', 'web_search_preview'] : [] });
  const r = await send(service, build, signal);
  if (!r.ok) return r;
  const onFail = coolOnFail(service, r.line);
  if (!wantStream) {
    let final = null, failed = null;
    try {
      for await (const ev of events(r.p)) {
        if (ev.type === 'response.completed' || ev.type === 'response.incomplete') { final = ev.response; break; }
        if (ev.type === 'response.failed' || ev.type === 'error') { failed = failureOf(ev); onFail(failed); break; }
      }
    } finally { await r.p.iter.return?.().catch(() => {}); }
    if (final) return { status: 200, json: final };
    return errJson(502, failed?.message || 'ChatGPT 的回复流没说完就断了', failed?.code || 'server_error', 'upstream_error');
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      let ended = false;
      try {
        for await (const ev of events(r.p)) {
          ctrl.enqueue(enc.encode(sseEvent(ev)));
          if (ev.type === 'response.failed' || ev.type === 'error') onFail(failureOf(ev));
          if (isTerminalEvent(ev)) { ended = true; break; }
        }
      } catch {}
      finally {
        // 没等到结束事件就断了：补一条 response.failed，让 Codex 重试而不是把半截输出当完整结果
        if (!ended) { try { ctrl.enqueue(enc.encode(sseEvent({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'ChatGPT 的回复流没说完就断了' } } }))); } catch {} }
        await r.p.iter.return?.().catch(() => {});
        try { ctrl.close(); } catch {}
      }
    },
    cancel() { r.p.iter.return?.().catch(() => {}); },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

// —— 入口 ——————————————————————————————————————————————

export async function handleChatgpt({ service, proto, rest, method, body, signal }) {
  const path = (rest || '/').replace(/\/+$/, '') || '/';
  if (proto === 'openai') {
    if (method === 'GET' && path === '/models') {
      const data = (service.models || []).filter((m) => m.kind === 'text').map((m) => ({ id: m.id, object: 'model', owned_by: 'chatgpt' }));
      return { status: 200, json: { object: 'list', data } };
    }
    if (method === 'POST' && path === '/chat/completions') return chatCompletions(service, body, signal);
    return errJson(404, `ChatGPT 订阅服务不支持 ${method} ${path}`, 'not_found');
  }
  if (proto === 'responses') {
    if (method === 'POST' && path === '/responses') return responsesPassthrough(service, body, signal);
    return errJson(404, `ChatGPT 订阅服务的 Responses 接口只支持 POST /responses（${method} ${path} 不支持）`, 'not_found');
  }
  return errJson(404, 'ChatGPT 订阅服务只提供 OpenAI（Chat Completions）与 Responses 两种接口', 'not_found');
}
