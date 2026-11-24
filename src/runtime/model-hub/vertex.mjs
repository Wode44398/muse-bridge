// 模型网关的 Vertex 上游：把 Google Vertex AI 上的 Gemini 对话模型做成 Claude 与 dimensio 都能用的模型服务。
//
// 起因（2026-11-10）：Gemini 4 Carbon 只在 Vertex 上能调（Gemini Developer API 的 /models 里没有、models.get 404），
// 而 dimensio 的内置 Gemini 走的是 Developer API 的 key、Claude 的自定义服务只认 Anthropic / OpenAI 协议——两边都够不着 Vertex。
//
// 两种协议：
//   gemini   /models/<型号>:<方法>          → https://aiplatform.googleapis.com/v1/projects/<项目>/locations/<区>/publishers/google/models/<型号>:<方法>
//            请求体与 Developer API 同形，原样转发（dimensio 的 Gemini 适配器、Claude 本机代理的 Gemini 翻译都自己带思维签名）。
//            2026-11-13 起 Claude 也走这条（claude-providers-gemini.mjs）。
//   openai   /chat/completions            → …/v1/projects/<项目>/locations/<区>/endpoints/openapi/chat/completions（型号前补 google/）
//            11-13 之前 Claude 的本机代理把 Anthropic 请求翻成 OpenAI 格式后打到这里；现在没人用，留着给插件与老配置。
//
// 思维签名（实测 2026-11-10，gemini-4-carbon）：OpenAI 兼容端点回的 tool_calls 带 extra_content.google.thought_signature，
// 下一轮回放这条调用时不带它 → 400「Function call is missing a thought_signature」。翻译层不认识 extra_content，带不回来，
// 所以这里按 tool_call id 记下签名（内存，最多 SIG_MAX 条），回放时补上；记不到的（进程重启过、别家模型留下的调用）
// 填官方给的占位值 skip_thought_signature_validator——每一轮只需要第一条调用带签名，但都带上也没事。
//
// 凭据：设置页上传的那份（runtime/vertex-credentials.mjs）> GOOGLE_APPLICATION_CREDENTIALS > gcloud ADC，同 Media Studio。
import { googleAuthLib } from '../google-deps.mjs';
import { vertexCredentials, vertexCredsEpoch } from '../vertex-credentials.mjs';
import { VERTEX_PROJECT, VERTEX_LOCATION } from '../../config/index.mjs';
import { fetchReconnect } from '../upstream-conn.mjs';

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const SIG_MAX = 4000;
export const SKIP_SIGNATURE = 'skip_thought_signature_validator';

let client = null, clientEpoch = -1;
async function accessToken() {
  if (!client || clientEpoch !== vertexCredsEpoch()) {
    const credentials = vertexCredentials();
    clientEpoch = vertexCredsEpoch();
    client = await new (googleAuthLib().GoogleAuth)({ scopes: SCOPES, ...(credentials ? { credentials } : {}) }).getClient();
  }
  const t = await client.getAccessToken();
  if (!t?.token) throw Object.assign(new Error('拿不到 Google 云凭据的令牌：到 设置 › Media Studio 里上传 Vertex 凭据'), { status: 401 });
  return t.token;
}

export const vertexProject = () => VERTEX_PROJECT;
export const vertexConfigured = () => !!VERTEX_PROJECT;
const host = (loc) => (loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`);

// —— 思维签名 ——
const sigs = new Map();   // tool_call id → 签名（插入序 = 新旧序）
export function rememberSignature(id, sig) {
  if (typeof id !== 'string' || !id || typeof sig !== 'string' || !sig) return;
  sigs.delete(id);
  sigs.set(id, sig);
  if (sigs.size > SIG_MAX) sigs.delete(sigs.keys().next().value);
}
const sigOf = (call) => call?.extra_content?.google?.thought_signature;

/** 发给 Vertex 之前：型号补 google/ 前缀；每条回放的 tool_call 补上签名。改的是传进来的对象。 */
export function prepareOpenAIBody(body) {
  if (typeof body.model === 'string' && !body.model.includes('/')) body.model = 'google/' + body.model;
  return signToolCalls(body);
}
/** 每条回放的 tool_call 补上记下的签名（记不到的填占位值）。Gemini 官方接口的 OpenAI 兼容层也是同一套规矩。改的是传进来的对象。 */
export function signToolCalls(body) {
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      if (!c || sigOf(c)) continue;
      c.extra_content = { ...(c.extra_content || {}), google: { ...(c.extra_content?.google || {}), thought_signature: sigs.get(c.id) || SKIP_SIGNATURE } };
    }
  }
  return body;
}

/** 上游回的一个 tool_call（或它的增量）：带签名就记下。 */
export function noteToolCall(c) { const s = sigOf(c); if (s && c.id) rememberSignature(c.id, s); }
function noteCalls(calls) {
  for (const c of Array.isArray(calls) ? calls : []) noteToolCall(c);
}
/** 非流式应答（已解析的 JSON）里的签名。 */
export function noteOpenAIResponse(j) {
  for (const ch of Array.isArray(j?.choices) ? j.choices : []) noteCalls(ch?.message?.tool_calls);
}
/** 流式应答：边转发边看每个 data: 行里的 tool_calls 增量。返回一个 TransformStream（字节进、字节出，内容不变）。 */
export function signatureTap() {
  const dec = new TextDecoder();
  let buf = '';
  const scan = (line) => {
    if (!line.startsWith('data:') || !line.includes('thought_signature')) return;
    try { for (const ch of JSON.parse(line.slice(5)).choices || []) noteCalls(ch?.delta?.tool_calls); } catch {}
  };
  return new TransformStream({
    transform(chunk, ctl) {
      ctl.enqueue(chunk);
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { scan(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
      if (buf.length > 4_000_000) buf = '';   // 没有换行的超长块：不是 SSE，别攒
    },
    flush() { if (buf) scan(buf.trim()); },
  });
}

const GEMINI_PATH = /^\/models\/([A-Za-z0-9._-]{1,120}):(generateContent|streamGenerateContent|countTokens)$/;

/** 网关的上游处理器。service.location 缺省 = 设置里的 Vertex 对话区（global）。 */
export async function handleVertex({ service, proto, rest, search, method, body, signal }) {
  if (!VERTEX_PROJECT) throw Object.assign(new Error('还没配 Vertex 项目：到 设置 › Media Studio 里填项目并上传凭据'), { status: 400 });
  const loc = service.location || VERTEX_LOCATION || 'global';
  const root = `${host(loc)}/v1/projects/${encodeURIComponent(VERTEX_PROJECT)}/locations/${encodeURIComponent(loc)}`;
  const headers = { authorization: 'Bearer ' + await accessToken(), 'content-type': 'application/json' };

  if (proto === 'gemini') {
    const m = GEMINI_PATH.exec(rest);
    if (!m || method !== 'POST') throw Object.assign(new Error('Vertex 服务只转发 generateContent / streamGenerateContent / countTokens'), { status: 404 });
    return fetchReconnect(`${root}/publishers/google/models/${m[1]}:${m[2]}${search || ''}`, { method: 'POST', headers, body, signal });
  }
  if (proto === 'openai') {
    if (rest === '/models' && method === 'GET') {
      return { status: 200, json: { object: 'list', data: (service.models || []).map((x) => ({ id: x.id, object: 'model', owned_by: 'google' })) } };
    }
    if (rest !== '/chat/completions' || method !== 'POST') throw Object.assign(new Error('Vertex 服务的 OpenAI 兼容接口只有 /chat/completions'), { status: 404 });
    let j;
    try { j = JSON.parse(body.toString('utf8')); } catch { throw Object.assign(new Error('请求体不是 JSON'), { status: 400 }); }
    prepareOpenAIBody(j);
    const up = await fetchReconnect(`${root}/endpoints/openapi/chat/completions`, { method: 'POST', headers, body: JSON.stringify(j), signal });
    if (!up.ok || !up.body) return up;
    if (j.stream) return new Response(up.body.pipeThrough(signatureTap()), { status: up.status, headers: up.headers });
    const text = await up.text();
    try { noteOpenAIResponse(JSON.parse(text)); } catch {}
    return new Response(text, { status: up.status, headers: up.headers });
  }
  throw Object.assign(new Error('Vertex 服务不支持 Anthropic 协议'), { status: 404 });
}

// —— 内置型号表（实测值；别的型号按名字猜）——
// gemini-4-carbon（2026-11-10，global 区）：thinkingLevel 收 LOW / MEDIUM / HIGH，MINIMAL 400，thinkingBudget 400；能识图。
export const VERTEX_KNOWN_MODELS = Object.freeze([
  { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', contextWindow: 1_048_576, maxOutput: 32_768, vision: true },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', contextWindow: 1_048_576, maxOutput: 32_768, vision: true },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_048_576, maxOutput: 65_536, vision: true },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', contextWindow: 1_048_576, maxOutput: 65_536, vision: true },
]);
export const VERTEX_DEFAULT_MODELS = Object.freeze(['gemini-4-carbon', 'gemini-4-argon']);

// —— 检测（2026-11-15）：Vertex 目录里有哪些对话模型、在对话区能不能调 ——
// 目录列出 ≠ 能调用（记忆 project_bridge_vertex_media：preview 转正后旧 id 会被回收、有的型号只在个别区），所以每个候选都在对话区
// 真打一次 countTokens——不生成、不计费。200 / 400（请求被校验 = 模型在）/ 429（限流）算能调，404 / 403 算调不通，别的说不准（null）。
// 只收对话模型：图像、配音、视频、音乐、向量、实时、电脑操作这些不是给 Claude / dimensio 聊天用的（媒体那几类由 Media Studio 自己巡检）。
const CHAT_EXCLUDE = /(image|nano-banana|tts|omni|embedding|native-audio|live|realtime|bidi|transcribe|robotics|computer-use|antigravity|deep-research|cyber|customtools|translate|learnlm)/;
/** 目录里的一个 id 是不是值得列出来的对话模型（1.x、2.0 这些老款不收）。 */
export const isVertexChatId = (id) => /^gemini-\d/.test(id) && !/^gemini-(1\.|2\.0)/.test(id) && !CHAT_EXCLUDE.test(id);

/** gemini-3.8-flash-lite-preview-09-2026 → Gemini 3.8 Flash Lite（预览版另有标签，名字里不带） */
export function prettyVertexId(id) {
  return String(id || '').replace(/-\d{2}-\d{4}$/, '').replace(/-\d{3}$/, '').replace(/-preview$/, '').split('-').filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
}

/** publisherModels → 对话候选 [{ id, stage }]；同一个模型有正式版就不收它的 preview 版。纯函数（单测用）。 */
export function parseVertexChatCatalog(list) {
  const out = new Map();
  for (const m of Array.isArray(list) ? list : []) {
    const id = String(m?.name || '').split('/').pop();
    if (!id || !isVertexChatId(id) || out.has(id)) continue;
    out.set(id, { id, stage: String(m?.launchStage || '') });
  }
  return [...out.values()].filter((m) => {
    if (!/preview/.test(m.id)) return true;
    const ga = m.id.replace(/-preview(-\d{2}-\d{4})?$/, '');
    return ga === m.id || !out.has(ga);
  });
}

/** 探针结论：true 能调 / false 调不通 / null 说不准。 */
export function vertexProbeVerdict(status) {
  if (status === 200 || status === 400 || status === 429) return true;
  if (status === 404 || status === 403) return false;
  return null;
}

async function listPublisherModels(token, signal) {
  const all = [];
  let page = '';
  for (let i = 0; i < 5; i++) {
    // 目录接口不分区；走 us-central1 的域名（Studio 的巡检同款，global 域名上这个 v1beta1 接口不稳）
    const url = `https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models?listAllVersions=false&pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`;
    const r = await fetchReconnect(url, { headers: { authorization: 'Bearer ' + token, 'x-goog-user-project': VERTEX_PROJECT }, signal });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      let msg = '';
      try { msg = JSON.parse(t)?.error?.message || ''; } catch {}
      throw Object.assign(new Error(`拉不到 Vertex 模型目录（HTTP ${r.status}）${msg ? '：' + msg.slice(0, 200) : ''}`), { status: 502 });
    }
    const j = await r.json().catch(() => null);
    all.push(...(Array.isArray(j?.publisherModels) ? j.publisherModels : []));
    page = j?.nextPageToken || '';
    if (!page) break;
  }
  return all;
}

async function probeChat(id, root, token, signal) {
  try {
    const r = await fetchReconnect(`${root}/publishers/google/models/${encodeURIComponent(id)}:countTokens`, {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    await r.body?.cancel?.().catch(() => {});
    return vertexProbeVerdict(r.status);
  } catch { return null; }
}

/**
 * 检测 → { at, location, models: [{ id, label, stage, listed, ok }] }。
 * extra：目录里没有、但也要探一下的型号（内置表里的、用户已经勾上的）。整体 90 秒封顶；目录拉不到就抛（人话）。
 */
export async function detectVertexChat({ extra = [] } = {}) {
  if (!VERTEX_PROJECT) throw Object.assign(new Error('还没配 Vertex 项目：先填项目 ID 并保存凭据'), { status: 400 });
  const signal = AbortSignal.timeout(90_000);
  const token = await accessToken();
  const listed = parseVertexChatCatalog(await listPublisherModels(token, signal));
  const loc = VERTEX_LOCATION || 'global';
  const root = `${host(loc)}/v1/projects/${encodeURIComponent(VERTEX_PROJECT)}/locations/${encodeURIComponent(loc)}`;
  const byId = new Map(listed.map((m) => [m.id, { ...m, listed: true }]));
  for (const id of extra) if (typeof id === 'string' && id && !byId.has(id)) byId.set(id, { id, stage: '', listed: false });
  const items = [...byId.values()];
  let i = 0;
  const worker = async () => { while (i < items.length) { const m = items[i++]; m.ok = await probeChat(m.id, root, token, signal); } };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  const known = new Map(VERTEX_KNOWN_MODELS.map((k) => [k.id, k.label]));
  return {
    at: Date.now(), location: loc,
    models: items.map((m) => ({ id: m.id, label: known.get(m.id) || prettyVertexId(m.id), stage: m.stage, listed: m.listed, ok: m.ok ?? null })),
  };
}
