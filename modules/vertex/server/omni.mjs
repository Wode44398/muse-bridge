// Gemini Omni (gemini-omni-*) video generation — the conversational video family
// that replaced/complements Veo (omni-1.1: up to ~40s via extensions, 360p-4k,
// native audio always on, min duration 3s).
//
// Channel: the Gemini Developer API Interactions endpoint (API key), same
// precedent as lyria-3 in music.mjs. Vertex lists gemini-omni-*-preview ids and
// its Interactions API accepts them, but this project's Vertex quota for the
// omni base models is effectively 0 (instant 429 on first call, 2026-08-28) —
// so the working channel is the dev API with config.geminiApiKey.
//
// Probe-verified dialect (2026-08-28): interactions.create with
//   { model, input, response_format: { type:'video', resolution, aspect_ratio,
//     duration:'Ns' }, background: true }
// resolution 360p/720p/1080p/4k, aspect 16:9|9:16, duration >= 3s. Small clips
// come back inline (base64 in a video content part); larger ones may switch to
// uri delivery (download needs the x-goog-api-key header). background+poll is
// mandatory — a blocking create hits the SDK client timeout on 4k renders.
import { geminiGenAI, geminiFileUrl } from './google-clients.mjs';

export const isOmni = (model) => /^gemini-omni/.test(model);

let devClient = null, devKey = null;
function client(apiKey) {
  if (!devClient || devKey !== apiKey) { devClient = geminiGenAI(apiKey); devKey = apiKey; }
  return devClient;
}

// Find the first video content part anywhere in the interaction (steps/outputs).
function findVideo(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'video' && (obj.data || obj.uri)) return obj;
  for (const v of Object.values(obj)) {
    const hit = findVideo(v);
    if (hit) return hit;
  }
  return null;
}

/**
 * Generate one Omni video clip and wait for completion.
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function generate({
  model, prompt, image, aspectRatio, durationSeconds, resolution,
  apiKey, onProgress, signal, pollMs = 8000, timeoutMs = 600000,
}) {
  if (!apiKey) throw new Error('Omni 需要 Gemini API key（config.geminiApiKey），且该 key 的项目要开通付费');
  const ai = client(apiKey);
  // First-frame image => image_to_video (mixed input); Omni infers the task.
  const input = image && image.imageBytes
    ? [{ type: 'image', data: image.imageBytes, mime_type: image.mimeType || 'image/png' }, { type: 'text', text: String(prompt || '') }]
    : String(prompt || '');
  const response_format = { type: 'video' };
  if (resolution) response_format.resolution = resolution;
  // 'auto' = 不传比例：Omni 有首帧图跟源图，纯文字按 prompt 语义自选（实测竖版描述真出竖片）。
  if (aspectRatio && aspectRatio !== 'auto') response_format.aspect_ratio = aspectRatio;
  // 时长 3–10 秒（2026-08-29 探针，400 原文给的闭区间）；越界会被 API 直接打回，
  // 这里兜一层夹紧，免得旧客户端/MCP 传个 12 就整轮失败。
  if (durationSeconds) response_format.duration = Math.min(10, Math.max(3, Number(durationSeconds))) + 's';
  let out = await ai.interactions.create({ model, input, response_format, background: true });
  const start = Date.now();
  while (out && out.status && !/completed|failed|cancelled/i.test(out.status)) {
    if (signal && signal.aborted) throw new Error('aborted');
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, pollMs));
    if (onProgress) onProgress(Math.round((Date.now() - start) / 1000));
    out = await ai.interactions.get(out.id);
  }
  if (!out || !/completed/i.test(out.status || '')) {
    throw new Error('Omni 生成失败：status=' + (out && out.status) + ' ' + JSON.stringify((out && out.errors) || '').slice(0, 200));
  }
  const vid = findVideo(out);
  if (!vid) throw new Error('Omni 未返回视频（可能被安全策略拦截或只回了文本）');
  const mime = vid.mime_type || vid.mimeType || 'video/mp4';
  if (vid.data) return { bytes: Buffer.from(vid.data, 'base64'), mime };
  // uri delivery (clip too large for inline) — download with the API key header.
  const r = await fetch(geminiFileUrl(vid.uri), { headers: { 'x-goog-api-key': apiKey } });
  if (!r.ok) throw new Error('Omni 视频下载失败 HTTP ' + r.status);
  return { bytes: Buffer.from(await r.arrayBuffer()), mime };
}
