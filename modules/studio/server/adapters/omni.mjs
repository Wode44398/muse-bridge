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
import { geminiGenAI, geminiFileUrl } from '@bridge/core/runtime/google-clients.mjs';

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
// 首尾帧插值只能 3–10 秒（超了 invalid argument，aistudio.google.com/docs/omni §limitations）
const INTERP_MAX = 10;
// 显式任务（generation_config.video_config.task）：只在首尾帧 / 参考图两种任务下带——两张图喂进去，模型分不清是首尾帧还是参考图；
// 文生 / 图生照旧不带（官方建议先靠提示词推断，task 会加硬约束）。带上以后的实际表现待真打。
const TASK_WIRE = { interp: 'image_to_video', ref: 'reference_to_video' };

/** 拼 Interactions 请求体（单测直接测它，不联网）。 */
export function buildRequest({ model, prompt, task, image, lastFrame, referenceImages, aspectRatio, durationSeconds, resolution, maxDuration = 10, seed }) {
  const part = (img) => ({ type: 'image', data: img.imageBytes, mime_type: img.mimeType || 'image/png' });
  const images = [];
  if (image && image.imageBytes) images.push(part(image));                                     // 首帧在前
  if (image && image.imageBytes && lastFrame && lastFrame.imageBytes) images.push(part(lastFrame));   // 尾帧紧跟其后（文档示例的顺序）
  for (const r of referenceImages || []) if (r && r.imageBytes) images.push(part(r));
  // 有图 => 混合输入（图在前、文字在后）；没图就是纯文字
  const input = images.length ? [...images, { type: 'text', text: String(prompt || '') }] : String(prompt || '');
  const response_format = { type: 'video' };
  if (resolution) response_format.resolution = resolution;
  // 'auto' = 不传比例：Omni 有首帧图跟源图，纯文字按 prompt 语义自选（实测竖版描述真出竖片）。
  if (aspectRatio && aspectRatio !== 'auto') response_format.aspect_ratio = aspectRatio;
  // 时长：1.1 是 3–10 秒（2026-08-29 探针，400 原文给的闭区间）；上限按模型卡给（1.2 是 15 秒）；首尾帧插值另封顶 10 秒。
  // 越界会被 API 直接打回，这里兜一层夹紧，免得旧客户端/MCP 传个 12 就整轮失败。
  const interp = !!(image && image.imageBytes && lastFrame && lastFrame.imageBytes);
  const max = Math.min(Number(maxDuration) || 10, interp ? INTERP_MAX : Infinity);
  if (durationSeconds) response_format.duration = Math.min(max, Math.max(3, Number(durationSeconds))) + 's';
  const body = { model, input, response_format, background: true };
  const generation_config = {};
  if (typeof seed === 'number') generation_config.seed = seed;
  if (TASK_WIRE[task] && images.length) generation_config.video_config = { task: TASK_WIRE[task] };
  if (Object.keys(generation_config).length) body.generation_config = generation_config;
  return body;
}

export async function generate({
  model, prompt, task, image, lastFrame, referenceImages, aspectRatio, durationSeconds, resolution, maxDuration = 10, seed,
  apiKey, onProgress, onSubmit, signal, pollMs = 8000, timeoutMs = 600000,
}) {
  if (!apiKey) throw new Error('Omni 要用 Gemini API 服务（填好 API Key），且该 key 的项目要开通付费');
  const ai = client(apiKey);
  let out = await ai.interactions.create(buildRequest({ model, prompt, task, image, lastFrame, referenceImages, aspectRatio, durationSeconds, resolution, maxDuration, seed }));
  if (onSubmit) onSubmit(out);   // 后台任务已经开跑，取消只能放弃等待
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
