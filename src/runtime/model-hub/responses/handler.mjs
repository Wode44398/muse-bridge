// 网关的 Responses 段：/<键>/<服务 id>/responses/…（Codex 的自定义 provider 把 base_url 指到这里，它自己在后面拼 /responses）。
//
//   GET  /models      本地答：这个服务勾给 Codex 的模型（上游的 /models 形状 Codex 不认）
//   POST /responses   透传（上游自己就有 Responses 接口）或者翻译成 Chat Completions / Anthropic Messages，流式结果再翻回 Responses
//
// 透传走同一个 API 池（换 Key、冷却、保温都照旧）。翻译时先落成 Anthropic 形状，复用 Claude 外接服务的改写（applyParams / toOpenAI）：
// 输出上限夹窗口、采样参数、档位写法、各家回传思考的规矩都是同一份。
import { applyParams, toOpenAI, openAIReasoning } from '../../claude-providers-transform.mjs';
import { responsesModeOf } from '../advanced.mjs';
import { toMessagesBody, effortFor } from './request.mjs';
import { ResponsesBuilder } from './builder.mjs';
import { pumpChat, pumpMessages, feedChatJson, feedMessagesJson, StreamError, errorCode } from './upstream.mjs';
import { sseEvent } from './sse.mjs';
import { signToolCalls, noteToolCall } from '../vertex.mjs';

let profileOf = () => null;
/**
 * registry 注入：(服务记录) → { upstream, compat, models: [型号规格（同发布给 agent 的那份）+ agents] } | null。
 * 规格要的识别、型号知识、高级覆盖都在 registry 里，这里不反向 import 它。
 */
export function setResponsesModelSpec(fn) { profileOf = typeof fn === 'function' ? fn : () => null; }

const errJson = (status, message, code = 'invalid_request', type = 'invalid_request_error') => ({ status, json: { error: { message, type, code } } });

function profile(service) {
  try { return profileOf(service) || { models: [] }; } catch { return { models: [] }; }
}
const codexModels = (p) => (p.models || []).filter((m) => !Array.isArray(m.agents) || m.agents.includes('codex'));

const GEMINI_HOST = 'generativelanguage.googleapis.com';
/** Gemini 官方接口的 OpenAI 兼容地址；别的地址（自建转发等）不知道兼容接口在哪 → ''。 */
function geminiOpenAIBase(url) {
  try { const u = new URL(url); return u.hostname === GEMINI_HOST ? `${u.origin}/v1beta/openai` : ''; } catch { return ''; }
}
/** Gemini 协议的服务换成走它的 OpenAI 兼容接口（同一个服务 id：线路状态、冷却、Key 都是同一份）。 */
function geminiAsOpenAI(service) {
  const baseUrl = geminiOpenAIBase(service.baseUrl);
  if (!baseUrl) return null;
  const lines = [];
  for (const l of service.lines || []) {
    if (!l.baseUrl) { lines.push(l); continue; }
    const b = geminiOpenAIBase(l.baseUrl);
    if (!b) { if (l.enabled) return null; continue; }
    lines.push({ ...l, baseUrl: b });
  }
  const authStyle = !service.authStyle || service.authStyle === 'goog' ? 'bearer' : service.authStyle;
  return { ...service, kind: 'openai', baseUrl, lines, authStyle };
}

// Claude：开着思考时，工具循环里最后一条 assistant 必须以带签名的 thinking 块开头；Codex 回传的只有摘要、没有签名，
// 只能这一步不开思考（下一轮用户发话后照常开）
const CLAUDE_RE = /claude|(?:^|[/._-])(?:opus|sonnet|haiku|fable)-/i;
function inToolLoop(messages) {
  const last = messages[messages.length - 1];
  return !!last && last.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b && b.type === 'tool_result');
}
function dropThinking(body) {
  const b = { ...body };
  delete b.thinking;
  if (b.output_config && typeof b.output_config === 'object') {
    const { effort: _e, ...rest } = b.output_config;
    if (Object.keys(rest).length) b.output_config = rest; else delete b.output_config;
  }
  return b;
}

/**
 * 网关调它：service = 服务记录，upstream = 这个服务类型的上游处理器（池 / Vertex）。
 * 返回 Response（流）或 { status, json }，和别的上游处理器一样。
 */
export async function handleResponses({ service, upstream, rest, search, method, headers, body, signal }) {
  const path = rest.replace(/\/+$/, '') || '/';
  const p = profile(service);
  if (method === 'GET' && path === '/models') {
    return { status: 200, json: { object: 'list', data: codexModels(p).map((m) => ({ id: m.id, object: 'model', owned_by: service.name || service.id })) } };
  }
  if (!upstream) return errJson(500, `模型网关不认识的服务类型：${service.kind}`, 'server_error', 'server_error');
  const mode = service.kind === 'vertex' ? 'translate' : responsesModeOf(service);
  if (mode === 'native' && service.kind === 'openai') {
    return upstream({ service, proto: service.kind, rest, search, method, headers, body, signal });
  }
  if (method !== 'POST' || path !== '/responses') {
    return errJson(404, `这个服务的 Responses 接口是翻译出来的，只支持 POST /responses（${method} ${path} 不支持）`, 'not_found');
  }
  let req;
  try { req = JSON.parse(Buffer.from(body || []).toString('utf8') || '{}'); } catch { return errJson(400, '请求体不是 JSON'); }
  if (!req || typeof req !== 'object') return errJson(400, '请求体不是 JSON 对象');

  // 落到哪个上游、用什么协议
  let svc = service, protocol;
  if (service.kind === 'anthropic') protocol = 'anthropic';
  else if (service.kind === 'openai' || service.kind === 'vertex') protocol = 'openai';
  else if (service.kind === 'gemini') {
    svc = geminiAsOpenAI(service);
    if (!svc) return errJson(400, `「${service.name || service.id}」是 Gemini 协议、地址不是 Google 官方接口（${GEMINI_HOST}），找不到它的 OpenAI 兼容接口，没法给 Codex 用；改用 OpenAI 协议接入这个服务`);
    protocol = 'openai';
  } else return errJson(400, `${service.kind} 类型的服务不能给 Codex 用`);

  const models = p.models || [];
  const spec = models.find((m) => m.id === req.model) || { id: String(req.model || models[0]?.id || ''), efforts: [], maxOutput: 0, contextWindow: 0, vision: true };
  if (!spec.id) return errJson(400, '请求里没有 model');
  const provider = {
    id: service.id, name: service.name || service.id, protocol, baseUrl: svc.baseUrl || '',
    upstream: p.upstream || '', compat: p.compat || {}, params: {},
    models: [{ ...spec, enabled: true }],
  };
  const { body: aBody, names } = toMessagesBody(req, { replayThinking: protocol !== 'anthropic' });
  const applied = applyParams(aBody, provider, provider.models[0], effortFor(req, spec));
  let upBody, upRest, upHeaders;
  if (protocol === 'anthropic') {
    upBody = applied.body;
    if (upBody.thinking && CLAUDE_RE.test(applied.model.id) && inToolLoop(upBody.messages)) upBody = dropThinking(upBody);
    upRest = '/v1/messages';
    upHeaders = { 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01' };
  } else {
    const extraOai = applied.body.openai && typeof applied.body.openai === 'object' ? applied.body.openai : null;
    upBody = openAIReasoning(toOpenAI(applied.body, provider, applied.model), applied.model, applied.effort);
    if (extraOai) Object.assign(upBody, extraOai);
    upRest = '/chat/completions';
    upHeaders = { 'content-type': 'application/json', accept: 'text/event-stream' };
  }
  upBody.stream = true;
  // Gemini 官方接口的 OpenAI 兼容层：回放的 tool_call 要带思维签名（同 Vertex，Vertex 的上游处理器自己补，这里只管 gemini 转过来的）
  const geminiCompat = service.kind === 'gemini';
  if (geminiCompat) signToolCalls(upBody);
  const onCall = geminiCompat ? noteToolCall : undefined;

  // 读的一方断开（Codex 取消 / 关连接）或者我们自己的输出流被取消：都要把上游的流关掉，不然它在后台接着生成
  const local = new AbortController();
  const sig = signal ? AbortSignal.any([signal, local.signal]) : local.signal;

  const up = await upstream({ service: svc, proto: svc.kind === 'vertex' ? 'openai' : svc.kind, rest: upRest, search: '', method: 'POST', headers: upHeaders, body: Buffer.from(JSON.stringify(upBody)), signal: sig });
  if (!(up instanceof Response)) {
    const m = up?.json?.error?.message || up?.json?.message || `上游返回 ${up?.status || 502}`;
    return errJson(up?.status || 502, String(m), errorCode(m, up?.status), 'upstream_error');
  }
  if (!up.ok || !up.body) {
    const text = await up.text().catch(() => '');
    let m = text;
    try { const j = JSON.parse(text); m = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || text; } catch {}
    m = String(m || `上游返回 ${up.status}`).slice(0, 2000);
    return errJson(up.ok ? 502 : up.status, m, errorCode(m, up.status), 'upstream_error');
  }
  // 有的上游不理 stream:true、回整段 JSON：按整段应答解析，别当 SSE 读成空流
  const isJson = /application\/json/i.test(up.headers.get('content-type') || '');
  const pump = isJson
    ? async (body, b) => {
      const text = await new Response(body).text();
      let j;
      try { j = JSON.parse(text); } catch { throw new StreamError('上游回的不是 SSE 也不是合法 JSON', 'server_error'); }
      return protocol === 'anthropic' ? feedMessagesJson(j, b) : feedChatJson(j, b, { onCall });
    }
    : (body, b) => (protocol === 'anthropic' ? pumpMessages(body, b, { signal: sig }) : pumpChat(body, b, { signal: sig, onCall }));
  const run = async (b) => {
    try { return await pump(up.body, b); } catch (e) {
      if (e instanceof StreamError) b.fail(e.message, e.code);
      else b.fail(sig.aborted ? 'request aborted' : `上游的流断了：${e?.message || e}`, 'server_error');
      return null;
    }
  };

  if (req.stream === false) {
    let failed = null;
    const b = new ResponsesBuilder({ model: spec.id, names, emit: (ev) => { if (ev.type === 'response.failed') failed = ev.response; } });
    const done = await run(b);
    if (done) return { status: 200, json: done };
    return errJson(502, failed?.error?.message || 'upstream error', failed?.error?.code || 'server_error', 'upstream_error');
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(ctrl) {
      let open = true;
      const b = new ResponsesBuilder({ model: spec.id, names, emit: (ev) => { if (open) { try { ctrl.enqueue(enc.encode(sseEvent(ev))); } catch { open = false; } } } });
      b.start();
      // 不在 start 里等：泵完之前读的一方就要能读到已经发出的事件
      run(b).finally(() => { if (open) { open = false; try { ctrl.close(); } catch {} } });
    },
    // 泵那边拿着上游流的读锁，直接 cancel 上游会失败：发中断信号，由 readSse 取消上游
    cancel() { local.abort(); },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}
