// 各方言的「新模型从哪来」（方案 §9.3 能力边界表）。只读列表接口 + 零成本探针，任何一步都不生成东西、不花钱。
//
// 每个 discover(provider, ctx) 回 { models: [{ id, label, kind, vendor? }], schemas?: { <id>: { src, kind, data, version?, priceHint? } },
//   schemasReplace?: bool（这次就是全部 schema）, complete: bool（清单是全量的：没列出的 remote 模型可以标下架）}。
// ctx：{ secret, dispatcher, signal, probes（Vertex 探针缓存 { <id>: { ok, at } }，就地更新）, log? }。
// 解析函数（parse*）是纯函数，单测直接喂 fixtures/ 里的真实样例。

import { http, authHeaders, joinUrl, AdapterError } from '../adapters/http.mjs';
import { GOOGLE_MODELS } from '../cards/google.mjs';
import { videoPriceHint } from './schema.mjs';

const FAL_API = 'https://api.fal.ai/v1';
export const OPENROUTER_PUBLIC = 'https://openrouter.ai/api/v1';

// —— 名字 ——
// OpenRouter 的名字带厂商前缀「OpenAI: GPT Image 2.6」：前缀交给 vendor，名字只留后半
export const cleanName = (name, id) => String(name || id || '').replace(/^[^:]{1,40}:\s+/, '').trim().slice(0, 80) || String(id || '');
/** 聚合服务里的厂商前缀：openai/gpt-image-2 → openai；fal 的 fal-ai/kling-video/… → kling。 */
export function vendorOf(dialect, id) {
  const segs = String(id || '').split('/');
  if (segs.length < 2) return undefined;
  if (dialect === 'fal' && segs[0] === 'fal-ai') return segs[1].split(/[-_.]/)[0] || undefined;
  return segs[0].split(':')[0] || undefined;
}

// —— OpenRouter：images / videos 目录各一次，每个模型自带参数描述 ——
const OR_IMAGE_KEEP = ['id', 'name', 'created', 'architecture', 'supported_parameters'];
const OR_VIDEO_KEEP = ['id', 'name', 'created', 'supported_resolutions', 'supported_aspect_ratios', 'supported_sizes', 'supported_durations',
  'supported_frame_images', 'generate_audio', 'seed', 'upscale_factor', 'creativity', 'pricing_skus', 'allowed_passthrough_parameters'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

export function parseOpenRouter(images = [], videos = []) {
  const models = [], schemas = {};
  for (const m of Array.isArray(images) ? images : []) {
    if (!m || !m.id || !(m.architecture?.output_modalities || ['image']).includes('image')) continue;
    models.push({ id: m.id, label: cleanName(m.name, m.id), kind: 'image', vendor: vendorOf('openrouter', m.id), created: m.created });
    schemas[m.id] = { src: 'openrouter-image', kind: 'image', data: pick(m, OR_IMAGE_KEEP) };
  }
  for (const m of Array.isArray(videos) ? videos : []) {
    if (!m || !m.id) continue;
    models.push({ id: m.id, label: cleanName(m.name, m.id), kind: 'video', vendor: vendorOf('openrouter', m.id), created: m.created });
    const priceHint = videoPriceHint(m.pricing_skus);
    schemas[m.id] = { src: 'openrouter-video', kind: 'video', data: pick(m, OR_VIDEO_KEEP), ...(priceHint ? { priceHint } : {}) };
  }
  return { models, schemas };
}

/** OpenRouter 公共媒体目录（参照库也用它；不带 Key 也能取）。 */
export async function fetchOpenRouterCatalog(base = OPENROUTER_PUBLIC, { headers = {}, dispatcher, signal } = {}) {
  const get = (p) => http(joinUrl(base, p), { headers, timeoutMs: 30_000, dispatcher, signal, label: 'OpenRouter 目录' });
  const [im, vi] = await Promise.all([get('images/models'), get('videos/models')]);
  return { images: Array.isArray(im?.data) ? im.data : [], videos: Array.isArray(vi?.data) ? vi.data : [] };
}

async function discoverOpenRouter(p, ctx) {
  const cat = await fetchOpenRouterCatalog(p.baseUrl || OPENROUTER_PUBLIC, { headers: authHeaders(p, ctx.secret?.key), dispatcher: ctx.dispatcher, signal: ctx.signal });
  return { ...parseOpenRouter(cat.images, cat.videos), schemasReplace: true, complete: true, catalog: cat };
}

/** 图像模型的单价（endpoints 接口，按服务商列 pricing）。拿不到回 null。 */
export async function fetchOpenRouterImageEndpoints(p, id, ctx) {
  if (!/^[\w.-]+\/[\w.:-]+$/.test(id)) return null;
  try {
    const j = await http(joinUrl(p.baseUrl || OPENROUTER_PUBLIC, `images/models/${id}/endpoints`), { headers: authHeaders(p, ctx.secret?.key), timeoutMs: 15_000, dispatcher: ctx.dispatcher, signal: ctx.signal, label: 'OpenRouter' });
    return Array.isArray(j?.endpoints) ? j.endpoints : null;
  } catch { return null; }
}

// —— Google（gemini / vertex 共用的分类）——
// 只收图像 / 视频 / 配音 / 音乐；对话、实时 / 双向、原生音频、转写、向量、机器人、电脑操作一律不收
const GOOGLE_EXCLUDE = /(native-audio|live|realtime|bidi|transcribe|embedding|robotics|computer-use|antigravity|deep-research|^aqa$|^gemma|customtools|translate)/;
// 已知不收的：旧款 Omni preview 被 1.1 全覆盖且不认分辨率参数（记忆 project_bridge_vertex_media 08-28 探针）
const GOOGLE_SKIP = new Set(['gemini-omni-flash-preview']);
export function classifyGoogle(id) {
  const s = String(id || '');
  if (GOOGLE_EXCLUDE.test(s) || GOOGLE_SKIP.has(s)) return null;
  if (/^veo-|^gemini-omni/.test(s)) return 'video';
  // 只认 Gemini 原生图像 / Imagen / Nano Banana（目录里还有 automl-vision-image-*、image-segmentation 这类识别模型）
  if (/^imagen|^nano-banana|^gemini-(.+-)?image(-|$)|^gemini-nano-banana/.test(s)) return 'image';
  if (/^gemini-.*(^|-)tts(-|$)/.test(s)) return 'speech';
  if (/^lyria/.test(s)) return 'music';
  return null;
}
// preview 转正后旧 id 会被回收（记忆：目录 ≠ 可用）：同一个模型有正式版就不收 preview 版
function dropSupersededPreviews(list) {
  const ids = new Set(list.map((m) => m.id));
  const gaNames = new Map();
  for (const m of list) if (!/preview/.test(m.id)) gaNames.set(m.kind + '|' + (m.label || ''), m.id);
  return list.filter((m) => {
    if (!/preview/.test(m.id)) return true;
    const ga = m.id.replace(/-preview(-\d{2}-\d{4})?/, '');
    if (ga !== m.id && ids.has(ga)) return false;
    return !(m.label && gaNames.has(m.kind + '|' + m.label));
  });
}

/** Gemini models.list（原样 JSON 的 models 数组）→ 媒体模型。 */
export function parseGeminiModels(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const id = String(m?.name || '').replace(/^models\//, '');
    if (!id) continue;
    const methods = m.supportedGenerationMethods || m.supportedActions || [];
    if (!methods.some((x) => /^(generateContent|predict|predictLongRunning)$/.test(x))) continue;
    const kind = classifyGoogle(id);
    if (!kind) continue;
    out.push({ id, label: String(m.displayName || id).slice(0, 80), kind });
  }
  return dropSupersededPreviews(out);
}

async function discoverGemini(p, ctx) {
  if (!ctx.secret?.key) throw new AdapterError('还没填 API Key');
  const base = p.baseUrl || 'https://generativelanguage.googleapis.com';
  const all = [];
  let page = '';
  for (let i = 0; i < 10; i++) {
    const j = await http(joinUrl(base, `v1beta/models?pageSize=1000${page ? '&pageToken=' + encodeURIComponent(page) : ''}`), { headers: authHeaders(p, ctx.secret.key), timeoutMs: 30_000, dispatcher: ctx.dispatcher, signal: ctx.signal, label: 'Gemini API' });
    all.push(...(Array.isArray(j?.models) ? j.models : []));
    page = j?.nextPageToken || '';
    if (!page) break;
  }
  return { models: parseGeminiModels(all), complete: true };
}

// Vertex 目录没有显示名：id 整理成可读名（gemini-3.8-flash-lite-tts → Gemini 3.8 Flash Lite TTS；veo-3.2-fast-generate-001 → Veo 3.2 Fast）
export function prettyGoogleId(id) {
  return String(id || '').replace(/-generate(-\d{3})?$/, '').replace(/-\d{3}$/, '').split('-').filter(Boolean)
    .map((w) => (w === 'tts' ? 'TTS' : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
}

// Vertex 目录（publisher models）→ 候选：只认能零成本探活的三类——Nano Banana 图像、TTS（generateContent → countTokens），
// Veo（predictLongRunning → 带保险丝非法值，只认 400）。Omni 在 Vertex 上只有配额 0 的 preview（走 Gemini API）、
// Lyria / Imagen 走 :predict 没有安全的探法（Imagen 本项目也没准入），一律不收。
export function parseVertexModels(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const id = String(m?.name || '').split('/').pop();
    const kind = classifyGoogle(id);
    if (!kind || /^gemini-omni|^lyria|^imagen/.test(id)) continue;
    if (kind === 'video' && !/^veo-/.test(id)) continue;
    out.push({ id, label: prettyGoogleId(id), kind, stage: m.launchStage || '' });
  }
  return dropSupersededPreviews(out);
}

export const PROBE_OK_TTL = 7 * 86400_000;
export const PROBE_BAD_TTL = 86400_000;
/** 探针结论：200 / 400（参数被校验 = 模型在）/ 429（限流）→ 可用；404 / 403 → 不可用；别的（5xx、网络）→ 说不准（null，下次再探）。 */
export function probeVerdict(status) {
  if (status === 200 || status === 400 || status === 429) return true;
  if (status === 404 || status === 403) return false;
  return null;
}

async function discoverVertex(p, ctx) {
  const { vertexTarget } = await import('../adapters/google.mjs');
  const { vertexGenAI, vertexAccessToken, vertexRestUrl } = await import('@bridge/core/runtime/google-clients.mjs');
  const t = vertexTarget(p, ctx.secret || {});
  const token = await vertexAccessToken(t.credentials);
  const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': t.project };
  const all = [];
  let page = '';
  for (let i = 0; i < 5; i++) {
    const j = await http(vertexRestUrl('us-central1', `v1beta1/publishers/google/models?listAllVersions=false&pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`), { headers, timeoutMs: 60_000, signal: ctx.signal, label: 'Vertex 模型目录' });
    all.push(...(Array.isArray(j?.publisherModels) ? j.publisherModels : []));
    page = j?.nextPageToken || '';
    if (!page) break;
  }
  const known = new Set(Object.values(GOOGLE_MODELS.vertex).flat());
  const probes = ctx.probes || {};
  const out = [];
  for (const c of parseVertexModels(all)) {
    if (known.has(c.id)) { out.push(c); continue; }   // 内置的：目录里还在就算在（不探）
    const hit = probes[c.id];
    // 手动「立即检查」：判过不可用的重探一次（可用的照旧信缓存）
    const fresh = hit && (hit.ok || !ctx.reprobe) && Date.now() - hit.at < (hit.ok ? PROBE_OK_TTL : PROBE_BAD_TTL);
    let ok = fresh ? hit.ok : null;
    if (!fresh) {
      ok = await probeVertex(c, t, { vertexGenAI, vertexRestUrl, headers, signal: ctx.signal, log: ctx.log });
      if (ok !== null) probes[c.id] = { ok, at: Date.now() };
    }
    if (ok) out.push(c);
  }
  const cands = new Set(parseVertexModels(all).map((c) => c.id));
  for (const id of Object.keys(probes)) if (!cands.has(id)) delete probes[id];   // 不再是候选的探针结论不留
  return { models: out.map(({ id, label, kind }) => ({ id, label, kind })), complete: true };
}

// 零成本探针（记忆「探针纪律」）：generateContent 类走 countTokens；Veo 必须带确定会被校验掉的保险丝（aspectRatio:'ZZZ'，最先校验），只有 400 算拿到结论
async function probeVertex(c, t, { vertexGenAI, vertexRestUrl, headers, signal, log }) {
  try {
    if (c.kind === 'video') {
      const url = vertexRestUrl(t.mediaLocation, `v1/projects/${t.project}/locations/${t.mediaLocation}/publishers/google/models/${c.id}:predictLongRunning`);
      try {
        await http(url, { method: 'POST', headers, body: { instances: [{ prompt: 'probe' }], parameters: { aspectRatio: 'ZZZ', sampleCount: 1, durationSeconds: 4 } }, timeoutMs: 30_000, signal, label: 'Vertex 探针' });
        // 走到这里 = 200 = 保险丝没起作用、任务开跑了：记一笔（这是事故，不是结论）
        console.error('[studio] Vertex 探针意外被受理（保险丝失效，可能产生费用）：', c.id);
        log?.('Vertex 探针意外被受理：' + c.id);
        return true;
      } catch (e) { return probeVerdict(e?.status); }
    }
    // TTS 先探媒体区，再探主区：2026-11-06 实测 3.8 Flash TTS 只在 global（us-central1 404），老三款两区都有；
    // 运行时 TTS 驱动同样是媒体区 404 就换主区（adapters/google.mjs）
    const locs = c.kind === 'image' ? [t.location] : [...new Set([t.mediaLocation, t.location])];
    let verdict = null;
    for (const location of locs) {
      const ai = vertexGenAI({ project: t.project, location, credentials: t.credentials });
      try { await ai.models.countTokens({ model: c.id, contents: 'ping', config: signal ? { abortSignal: signal } : undefined }); return true; }
      catch (e) { verdict = probeVerdict(Number(e?.status ?? e?.code)); if (verdict) return true; }
    }
    return verdict;
  } catch { return null; }
}

// —— Replicate / fal：列表走适配器已有的 listModels，参数走各自的 schema 接口 ——
async function discoverViaAdapter(p, ctx, { complete }) {
  const { adapterFor } = await import('../adapters/index.mjs');
  const list = await adapterFor(p.dialect).listModels(p, ctx);
  const models = (Array.isArray(list) ? list : []).filter((m) => m && m.id && m.kind && !m.builtin)
    .map((m) => ({ id: m.id, label: m.label || m.id, kind: m.kind, ...(vendorOf(p.dialect, m.id) ? { vendor: vendorOf(p.dialect, m.id) } : {}) }));
  return { models, complete };
}

// JSON Schema 里 Input 用到的 $ref 名字（只带被引用的定义进缓存，别把整个 components 存下来）
function refsOf(node, defs, seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return seen;
  if (typeof node.$ref === 'string') {
    const name = node.$ref.split('/').pop();
    if (!seen.has(name) && defs[name]) { seen.add(name); refsOf(defs[name], defs, seen, depth + 1); }
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') refsOf(v, defs, seen, depth + 1);
  return seen;
}
const pickDefs = (input, defs) => Object.fromEntries([...refsOf(input, defs)].map((n) => [n, defs[n]]));

/** Replicate 模型 JSON（GET /models/{owner}/{name} 或 /versions/{id}）→ { input, defs, version }。 */
export function replicateSchemaOf(j) {
  const v = j?.latest_version || j;
  const cs = v?.openapi_schema?.components?.schemas;
  if (!cs || !cs.Input) return null;
  return { input: cs.Input, defs: pickDefs(cs.Input, cs), version: v.id || '' };
}
/** fal 模型目录项（expand=openapi-3.0）→ { input, defs }。 */
export function falSchemaOf(item) {
  const o = item?.openapi;
  if (!o || !o.paths) return null;
  const cs = o.components?.schemas || {};
  for (const [pth, ops] of Object.entries(o.paths)) {
    if (/\{request_id\}/.test(pth) || !ops?.post) continue;
    const s = ops.post.requestBody?.content?.['application/json']?.schema;
    if (!s) continue;
    const input = s.$ref ? cs[s.$ref.split('/').pop()] : s;
    if (input) return { input, defs: pickDefs(input, cs), version: '' };
  }
  return null;
}

/** 按需取一个模型的 schema（巡检时给主列表里的、resolve 时给备选的）。回 { src, kind, data, version } 或 null。 */
export async function fetchModelSchema(p, entry, ctx) {
  try {
    if (p.dialect === 'replicate') {
      const m = /^([\w.-]+)\/([\w.-]+)(?::([\w]+))?$/.exec(entry.id);
      if (!m) return null;
      const url = m[3] ? `models/${m[1]}/${m[2]}/versions/${m[3]}` : `models/${m[1]}/${m[2]}`;
      const j = await http(joinUrl(p.baseUrl, url), { headers: authHeaders(p, ctx.secret?.key), timeoutMs: 20_000, dispatcher: ctx.dispatcher, signal: ctx.signal, label: 'Replicate' });
      const s = replicateSchemaOf(j);
      return s ? { src: 'jsonschema', kind: entry.kind, data: { input: s.input, defs: s.defs }, version: s.version } : null;
    }
    if (p.dialect === 'fal') {
      if (!/^[\w.-]+(\/[\w.-]+)*$/.test(entry.id)) return null;
      const j = await http(`${FAL_API}/models?endpoint_id=${encodeURIComponent(entry.id)}&expand=openapi-3.0`, { headers: authHeaders(p, ctx.secret?.key), timeoutMs: 20_000, dispatcher: ctx.dispatcher, signal: ctx.signal, label: 'fal' });
      const s = falSchemaOf((j?.models || [])[0]);
      return s ? { src: 'jsonschema', kind: entry.kind, data: { input: s.input, defs: s.defs } } : null;
    }
  } catch { return null; }
  return null;
}

export const SOURCES = {
  openrouter: discoverOpenRouter,
  gemini: discoverGemini,
  vertex: discoverVertex,
  replicate: (p, ctx) => discoverViaAdapter(p, ctx, { complete: false }),   // 官方集合是精选，不在集合里 ≠ 下架
  fal: (p, ctx) => discoverViaAdapter(p, ctx, { complete: false }),         // 每类只取前 50 个，同上
  openai: (p, ctx) => discoverViaAdapter(p, ctx, { complete: true }),
  elevenlabs: (p, ctx) => discoverViaAdapter(p, ctx, { complete: true }),
};
/** 这些方言有参数 schema 接口（主列表里的模型巡检时顺带取 schema）。 */
export const SCHEMA_DIALECTS = new Set(['replicate', 'fal']);
