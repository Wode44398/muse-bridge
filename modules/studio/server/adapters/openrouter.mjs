// openrouter 方言（图像 + 视频）。
//
// 图像：POST {baseUrl}/images（chat/completions 对图像专用模型 404）。
//   · GPT Image（内置卡 / 继承卡 / 通用卡）：原驱动 openrouter-image.mjs——像素只认 size:'WxH'，按比例 + 档位算
//     （记忆 project_bridge_vertex_media 11-04 段）；没有多轮上下文：续改＝当前给的素材，没给就拿续改链上一张出图当参考。
//   · 其余模型（2026-11-06 自动识别，schema 卡）：参数键就是 /images 请求体的字段名（aspect_ratio / resolution / size / quality /
//     background / output_format / output_compression / n / seed），原样透传；参考图进 input_references；data[] 里每张都收。
// 视频（2026-11-06）：POST {baseUrl}/videos → 202 { id, polling_url, status } → 轮询 GET /videos/{id}（pending / in_progress /
//   completed / failed / cancelled / expired；没有进度字段）→ GET /videos/{id}/content?index=N 取 mp4（要带 Key）。
//   官方没有取消接口：提交即 uncancelable。首尾帧 frame_images:[{ type:'image_url', image_url:{url}, frame_type }]；
//   参考图 / 视频 / 音频进 input_references（{ type:'image_url'|'video_url'|'audio_url', … }）。
//   服务商专属参数（provider.options.<服务商>）不做成参数，要用就写进「原始参数」。

import { generateOpenRouterImage } from './openrouter-image.mjs';
import { http, authHeaders, joinUrl, poll, isTransient, longWaitMs, dataUrl, sleepMs, AdapterError } from './http.mjs';
import { wireBody } from '../discovery/schema.mjs';

const VIDEO_POLL_MS = 8000;
const DONE = 'completed';
const FAILED = new Set(['failed', 'cancelled', 'canceled', 'expired']);
const sameOrigin = (u, base) => { try { return new URL(u).origin === new URL(base).origin; } catch { return false; } };
const imgPart = (x) => ({ type: 'image_url', image_url: { url: dataUrl(x.data, x.mime) } });

export const openrouterAdapter = {
  dialect: 'openrouter',
  kinds: ['image', 'video'],

  // GET /key：查 Key 本身（额度、限额），不花钱
  async test(provider, { secret, dispatcher }) {
    if (!secret.key) throw new AdapterError('还没填 API Key');
    const j = await http(joinUrl(provider.baseUrl, 'key'), { headers: authHeaders(provider, secret.key), timeoutMs: 30_000, dispatcher, label: 'OpenRouter' });
    const d = j?.data || {};
    const left = d.limit_remaining ?? (d.limit != null ? d.limit - (d.usage || 0) : null);
    return { detail: left != null ? `剩余额度 $${Number(left).toFixed(2)}` : 'Key 有效' };
  },

  // 图像 + 视频目录（/images/models、/videos/models：每个模型自带参数描述，巡检也用这两个接口）
  async listModels(provider, { secret, dispatcher }) {
    const get = (p) => http(joinUrl(provider.baseUrl, p), { headers: authHeaders(provider, secret.key), timeoutMs: 30_000, dispatcher, label: 'OpenRouter' });
    const [im, vi] = await Promise.allSettled([get('images/models'), get('videos/models')]);
    if (im.status === 'rejected' && vi.status === 'rejected') throw im.reason;
    const name = (m) => String(m.name || m.id).replace(/^[^:]{1,40}:\s+/, '');
    return [
      ...(im.status === 'fulfilled' ? im.value?.data || [] : []).map((m) => ({ id: m.id, label: name(m), kind: 'image' })),
      ...(vi.status === 'fulfilled' ? vi.value?.data || [] : []).map((m) => ({ id: m.id, label: name(m), kind: 'video' })),
    ];
  },

  async run(req, provider, ctx) {
    if (req.kind === 'video') return runVideo(req, provider, ctx);
    if (req.card?.wire) return runSchemaImage(req, provider, ctx);
    const p = req.params || {};
    let refs = req.inputs.filter((x) => x.role === 'edit' || x.role === 'ref').map((x) => ({ data: x.data.toString('base64'), mimeType: x.mime }));
    if (!refs.length && req.thread?.turns?.length) {
      const last = req.thread.turns[req.thread.turns.length - 1];
      refs = [{ data: last.data.toString('base64'), mimeType: last.mime }];
    }
    const r = await generateOpenRouterImage({
      model: req.model, prompt: req.prompt, refs, aspectRatio: p.aspectRatio, imageSize: p.imageSize, quality: p.quality,
      signal: ctx.signal, apiKey: ctx.secret.key, baseUrl: provider.baseUrl, headers: provider.headers,
      extra: { ...(provider.params || {}), ...(p.extra || {}) }, timeoutMs: (provider.timeoutSec || 300) * 1000, dispatcher: ctx.dispatcher,
    });
    return { assets: [{ bytes: r.bytes, mime: r.mime }] };
  },
};

// —— 图像（schema 卡）——
async function runSchemaImage(req, provider, ctx) {
  if (!ctx.secret?.key) throw new AdapterError('这个 OpenRouter 服务还没填 API Key');
  const p = req.params || {};
  const body = {
    model: req.model,
    ...wireBody(req.card.wire, p, { ...req, prompt: req.prompt || '生成一张图片' }, imgPart),
    ...(provider.params || {}), ...(p.extra || {}),
  };
  if (Array.isArray(body.input_references)) body.input_references = body.input_references.slice(-16);
  const j = await http(joinUrl(provider.baseUrl, 'images'), {
    method: 'POST', headers: authHeaders(provider, ctx.secret.key, { 'X-Title': 'bridge' }), body,
    timeoutMs: (provider.timeoutSec || 300) * 1000, signal: ctx.signal, dispatcher: ctx.dispatcher, label: 'OpenRouter',
  });
  const assets = (Array.isArray(j?.data) ? j.data : []).filter((d) => d && d.b64_json)
    .map((d) => ({ bytes: Buffer.from(d.b64_json, 'base64'), mime: d.media_type || 'image/png' }));
  if (!assets.length) throw new AdapterError('OpenRouter 没有返回图片', { detail: JSON.stringify(j ?? null).slice(0, 300) });
  return { assets };
}

// —— 视频 ——
// 请求体：schema 卡的键就是 /videos 的字段名；通用卡（aspectRatio / durationSeconds）换成 aspect_ratio / duration
export function videoBody(req) {
  const p = req.params || {};
  const body = { model: req.model, ...(req.prompt ? { prompt: req.prompt } : {}) };
  for (const [k, v] of Object.entries(p)) {
    if (k === 'extra' || v === undefined || v === null || v === '') continue;
    if (k === 'aspectRatio') { if (v !== 'auto') body.aspect_ratio = v; continue; }
    if (k === 'durationSeconds') { body.duration = Number(v); continue; }
    body[k] = v;
  }
  if (body.duration !== undefined) body.duration = Number(body.duration);
  const frames = [], refs = [];
  for (const x of req.inputs || []) {
    if (x.role === 'first' || x.role === 'last') frames.push({ ...imgPart(x), frame_type: x.role === 'first' ? 'first_frame' : 'last_frame' });
    else if (x.role === 'ref' || x.role === 'edit') refs.push(imgPart(x));
    else if (x.role === 'video') refs.push({ type: 'video_url', video_url: { url: dataUrl(x.data, x.mime) } });
    else if (x.role === 'audio') refs.push({ type: 'audio_url', audio_url: { url: dataUrl(x.data, x.mime) } });
  }
  if (frames.length) body.frame_images = frames;
  if (refs.length) body.input_references = refs;
  return body;
}

async function runVideo(req, provider, ctx) {
  const key = ctx.secret?.key;
  if (!key) throw new AdapterError('这个 OpenRouter 服务还没填 API Key');
  const base = provider.baseUrl;
  const headers = authHeaders(provider, key, { 'X-Title': 'bridge' });
  const timeoutMs = (provider.timeoutSec || 600) * 1000;
  const { signal, dispatcher } = ctx;
  const body = { ...videoBody(req), ...(provider.params || {}), ...(req.params?.extra || {}) };
  const sub = await http(joinUrl(base, 'videos'), { method: 'POST', headers, body, timeoutMs: 120_000, signal, dispatcher, label: 'OpenRouter 视频提交' });
  if (!sub || !sub.id) throw new AdapterError('OpenRouter 没有返回任务编号', { detail: JSON.stringify(sub ?? null).slice(0, 300) });
  ctx.submitted?.();   // 已受理：没有取消接口，之后取消只能放弃等待（仍可能计费），也不再自动重试
  const id = String(sub.id);
  if (!/^[\w.-]{1,120}$/.test(id)) throw new AdapterError('OpenRouter 返回的任务编号不对');
  // 轮询地址：服务方给的（可能是相对路径）只认同源的，外来地址拿不到 Key
  let statusUrl = joinUrl(base, `videos/${id}`);
  if (typeof sub.polling_url === 'string') {
    try { const u = new URL(sub.polling_url, base); if (sameOrigin(u.href, base)) statusUrl = u.href; } catch {}
  }
  const job = await poll(async () => {
    let s;
    try { s = await http(statusUrl, { headers, timeoutMs: 60_000, signal, dispatcher, label: 'OpenRouter 视频状态' }); }
    catch (e) { if (signal?.aborted || !isTransient(e)) throw e; return { done: false }; }
    const st = String(s?.status || '').toLowerCase();
    if (st === DONE) return { done: true, value: s };
    if (FAILED.has(st)) return { failed: true, error: typeof s?.error === 'string' ? s.error : (st === 'expired' ? '任务过期了' : st === 'cancelled' ? '服务方取消了这个任务' : '') };
    ctx.progress?.({ note: st === 'pending' ? '排队中' : '生成中' });
    return { done: false };
  }, { intervalMs: ctx.pollMs || VIDEO_POLL_MS, timeoutMs: longWaitMs(provider), signal, label: 'OpenRouter 视频' });

  const n = Math.max(1, Array.isArray(job?.unsigned_urls) ? job.unsigned_urls.length : 1);
  const assets = [];
  for (let i = 0; i < Math.min(n, 4); i++) {
    const url = joinUrl(base, `videos/${id}/content?index=${i}`);
    let bytes = null, mime = 'video/mp4';
    // 409「稍后再试」：成片还在转存，隔几秒再取（钱已经花了，别因为一次冲突丢结果）
    for (let k = 0; k < 6 && !bytes; k++) {
      try {
        const res = await http(url, { headers, timeoutMs, signal, dispatcher, raw: true, label: 'OpenRouter 取片' });
        bytes = Buffer.from(await res.arrayBuffer());
        mime = (res.headers.get('content-type') || '').split(';')[0].trim() || mime;
      } catch (e) {
        if (signal?.aborted || !(e?.status === 409 || isTransient(e)) || k === 5) throw e;
        await sleepMs(5000, signal);
      }
    }
    if (bytes?.length) assets.push({ bytes, mime: /^video\//.test(mime) ? mime : 'video/mp4', meta: { ...(job?.usage?.cost != null ? { cost: job.usage.cost } : {}) } });
  }
  if (!assets.length) throw new AdapterError('OpenRouter 没有返回视频');
  return { assets };
}
