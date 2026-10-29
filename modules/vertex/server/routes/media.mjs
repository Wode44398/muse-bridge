// Vertex media routes: video (Veo, long-running SSE), image (Imagen/Nano Banana,
// sync JSON), TTS (sync JSON), music (Lyria, slow SSE because past Cloudflare's
// ~100s response cap), per-kind list endpoints
// and per-kind delete endpoints.
//
// Multi-user: every artifact is saved/listed/served/deleted in the CALLER's own
// media dir (admin -> ROOT/media; user -> their .bridge/media), so a user's
// generated results — including what Claude's media MCP produces — stay in their
// own folder. Long-running endpoints (Veo, music) deliberately do NOT abort on
// client disconnect — they are pay-per-second and the result must always land.

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readBody } from '@bridge/core/runtime/body.mjs';
import { writeSseHeaders, sseWrite, startHeartbeat } from '@bridge/core/runtime/sse.mjs';
import * as vertexMedia from '@bridge/core/vertex-media.mjs';
import {
  VEO_MODELS, VEO_MODEL_DEFAULT, VEO_ASPECTS, VEO_RESOLUTIONS, veoResSupport,
  veoDurClamp, veoTaskOk, veoOnlyParams, VEO_QUALITIES,
  IMAGE_MODELS, IMAGE_MODEL_DEFAULT, imgAspectFor, IMAGE_SIZES, imgSizeClamp,
  IMG_THINK_LEVELS, IMG_THINK_SUPPORT, IMG_SEARCH_SUPPORT, IMG_IMGSEARCH_SUPPORT, IMG_PERSON_GEN,
  TTS_MODELS, TTS_MODEL_DEFAULT, TTS_VOICES, TTS_VOICE_DEFAULT, TTS_MAX_SPEAKERS,
  MUSIC_MODELS, MUSIC_MODEL_DEFAULT, musicNegSupport,
} from '@bridge/core/config/capabilities.mjs';
import { VERTEX_PROJECT, VERTEX_LOCATION, VERTEX_MEDIA_LOCATION, GEMINI_API_KEY } from '@bridge/core/config/index.mjs';
import { requireCtx } from '@bridge/core/runtime/identity.mjs';
import { admitUsage } from '@bridge/core/runtime/quota.mjs';
import { ID_RE } from '@bridge/core/jsonfile.mjs';
import { mimeType } from '@bridge/core/runtime/http-file.mjs';
import { LOCAL_IMAGE_MODEL } from '../local-image.mjs';
import { registerLocalImageRoutes, handleLocalImage } from './local-image.mjs';

// 按 id 取文件（GET /api/vertex/media）已搬进核心 media-file.mjs；这里照旧转出 serveMediaFile。
export { serveMediaFile } from '@bridge/core/routes/media-file.mjs';

// Caller -> context (admin or a specific user), or null if unauthenticated.
// Auth + per-identity context resolution is shared in requireCtx (runtime/identity.mjs).
// An uploaded image path is only accepted if it's inside the caller's own uploads.
const ownUpload = (p, ctx) => typeof p === 'string' && path.resolve(p).startsWith(path.resolve(ctx.uploads) + path.sep) && existsSync(p);

// 参考图 mime 按扩展名映射——之前"非 png 一律标 jpeg"，webp/gif 误标会让 Vertex 解码失败。
const imgMime = (file) => mimeType(file, { fallback: 'image/jpeg' });

async function handleVeoVideo(req, res, identify) {
  const ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let parsed;
  try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
  const prompt = String(parsed.prompt ?? '').trim();
  const model = VEO_MODELS.has(parsed.model) ? parsed.model : VEO_MODEL_DEFAULT;
  // 默认「自动」：驱动侧不传比例参数——有首帧图跟源图，Omni 纯文字还会按 prompt 语义自选。
  const aspectRatio = VEO_ASPECTS.has(parsed.aspectRatio) ? parsed.aspectRatio : 'auto';
  // 分辨率按模型夹紧（360p 仅 Omni；传了该模型不支持的档就落到它最高档）。
  let resolution = VEO_RESOLUTIONS.has(parsed.resolution) ? parsed.resolution : '720p';
  const resAllowed = veoResSupport(model);
  if (!resAllowed.includes(resolution)) resolution = resAllowed.includes('720p') ? '720p' : resAllowed[resAllowed.length - 1];
  // 时长按模型夹紧（Omni 3–10 逐秒；Veo 3.1 只有 4/6/8）。旧版是「不在 4/6/8 就回落 8」，
  // Omni 用户选 3 秒会被悄悄改成 8 秒——多付一倍时长的钱还拿不到想要的片长。
  const durationSeconds = veoDurClamp(model, parsed.durationSeconds);
  const generateAudio = parsed.generateAudio === true;
  // 任务类型：不认或该模型不支持的一律回落 t2v；素材按任务取舍（下面各槽自己判）。
  const task = veoTaskOk(model, parsed.task) ? parsed.task : 't2v';
  let image;
  if (task !== 't2v' && ownUpload(parsed.image, ctx)) {
    image = { imageBytes: readFileSync(parsed.image).toString('base64'), mimeType: imgMime(parsed.image) };
  }
  // 尾帧（首尾插值，仅 interp 任务 + 支持的模型）。
  let lastFrame;
  if (task === 'interp' && ownUpload(parsed.lastFrame, ctx)) {
    lastFrame = { imageBytes: readFileSync(parsed.lastFrame).toString('base64'), mimeType: imgMime(parsed.lastFrame) };
  }
  // 参考图（asset 素材，最多 3 张，仅 Veo 3.1 的 ref 任务）：逐个 ownUpload 守卫。
  let referenceImages;
  if (task === 'ref' && Array.isArray(parsed.referenceImages)) {
    const refs = parsed.referenceImages.filter((p) => ownUpload(p, ctx)).slice(0, 3)
      .map((p) => ({ imageBytes: readFileSync(p).toString('base64'), mimeType: imgMime(p) }));
    if (refs.length) referenceImages = refs;
  }
  // Veo 专属三件：Omni 传过去会 400「Unknown parameter」，故按模型门控。
  const veoOnly = veoOnlyParams(model);
  const negativePrompt = veoOnly && typeof parsed.negativePrompt === 'string' ? parsed.negativePrompt.trim().slice(0, 500) : '';
  const enhancePrompt = veoOnly && parsed.enhancePrompt === false ? false : undefined;
  const compressionQuality = (veoOnly && VEO_QUALITIES.has(parsed.compressionQuality) && parsed.compressionQuality) || undefined;
  if (!prompt && !image && !lastFrame && !referenceImages) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('empty prompt'); return; }

  writeSseHeaders(res);
  const sendV = (obj) => sseWrite(res, obj);
  const hb = startHeartbeat(res);
  const id = vertexMedia.newId();
  sendV({ type: 'start', id, model });
  try {
    let buf;
    if (/^gemini-omni/.test(model)) {
      // Omni：Gemini Developer API Interactions（key 通道，../omni.mjs）；音频恒开，
      // 尾帧/参考图不支持（前端已按 imgCaps 隐藏入口，这里直接不传）。
      const omni = await import('../omni.mjs');
      const r = await omni.generate({
        model, prompt, image, aspectRatio, durationSeconds, resolution,
        apiKey: GEMINI_API_KEY,
        onProgress: (s) => sendV({ type: 'progress', elapsed: s }),
      });
      buf = r.bytes;
    } else {
      const veo = await import('../veo.mjs');
      const vids = await veo.generate({
        prompt, image, lastFrame, referenceImages, model,
        aspectRatio: aspectRatio === 'auto' ? undefined : aspectRatio,
        durationSeconds, generateAudio, numberOfVideos: 1,
        resolution, negativePrompt, enhancePrompt, compressionQuality,
        project: VERTEX_PROJECT, location: VERTEX_MEDIA_LOCATION,
        onProgress: (s) => sendV({ type: 'progress', elapsed: s }),
      });
      const v = vids[0];
      if (!v) throw new Error('Veo 没有返回视频');
      buf = await veo.fetchBytes(v, VERTEX_PROJECT, VERTEX_MEDIA_LOCATION);
    }
    vertexMedia.save(id, buf, 'mp4', { prompt, model, task, aspectRatio, durationSeconds, resolution, generateAudio, negativePrompt, compressionQuality: compressionQuality || '' }, ctx.media);
    sendV({ type: 'video', id, url: '/api/vertex/media?id=' + id, mime: 'video/mp4', bytes: buf.length });
  } catch (err) {
    sendV({ type: 'error', message: '视频生成失败：' + String(err?.message ?? err) });
  } finally {
    clearInterval(hb);
    if (!res.writableEnded) res.end();
  }
}

async function handleVertexImage(req, res, identify) {
  const ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let parsed;
  try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
  const prompt = String(parsed.prompt ?? '').trim();
  const model = IMAGE_MODELS.has(parsed.model) ? parsed.model : IMAGE_MODEL_DEFAULT;
  if (model === LOCAL_IMAGE_MODEL) return handleLocalImage(req, res, { ctx, parsed, ownUpload });
  const aspectRatio = imgAspectFor(model, parsed.aspectRatio);
  const imageSize = imgSizeClamp(model, IMAGE_SIZES.has(parsed.imageSize) ? parsed.imageSize : undefined);
  const thinkingLevel = (IMG_THINK_SUPPORT.has(model) && IMG_THINK_LEVELS.has(parsed.thinkingLevel)) ? parsed.thinkingLevel : undefined;
  const useImageSearch = IMG_IMGSEARCH_SUPPORT.has(model) && parsed.useImageSearch === true;
  const useSearch = useImageSearch || (IMG_SEARCH_SUPPORT.has(model) && parsed.useSearch === true);
  const isNano = !/^imagen/.test(model);
  // 人物生成（Nano Banana 专属 imageConfig 键）：空/不认的值 = 不传，走模型默认。
  const personGeneration = isNano && IMG_PERSON_GEN.has(parsed.personGeneration) ? parsed.personGeneration : undefined;
  const clampNum = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : undefined;
  const temperature = isNano ? clampNum(parsed.temperature, 0, 2) : undefined;
  const topP = isNano ? clampNum(parsed.topP, 0, 1) : undefined;
  let image;
  if (ownUpload(parsed.image, ctx)) {
    image = { imageBytes: readFileSync(parsed.image).toString('base64'), mimeType: imgMime(parsed.image) };
  }
  if (!prompt && !image) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('empty prompt'); return; }
  try {
    const imagen = await import('../imagen.mjs');
    const imgLocation = /^imagen/.test(model) ? VERTEX_MEDIA_LOCATION : VERTEX_LOCATION;
    const r = await imagen.generate({ model, prompt, image, aspectRatio: aspectRatio === 'auto' ? undefined : aspectRatio, imageSize, thinkingLevel, useSearch, useImageSearch, personGeneration, temperature, topP, project: VERTEX_PROJECT, location: imgLocation });
    const ext = r.mime.includes('jpeg') ? 'jpg' : (r.mime.includes('webp') ? 'webp' : 'png');
    const id = vertexMedia.newId();
    vertexMedia.save(id, r.bytes, ext, { kind: 'image', prompt, model, aspectRatio, imageSize: imageSize || '', personGeneration: personGeneration || '' }, ctx.media);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id, url: '/api/vertex/media?id=' + id }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '图像生成失败：' + String(err?.message ?? err).slice(0, 300) }));
  }
}

// 多轮对话式图像编辑（Nano Banana）。前端传 turns=[{userText, imageId}] 历史 + 当前 message；
// 后端读每个 imageId 的 media 图 + 存在 meta 里的 thoughtSignature，重建 contents 给模型续改。
async function handleImageChat(req, res, identify) {
  const ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let parsed;
  try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
  const message = String(parsed.message ?? '').trim();
  if (!message) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('empty message'); return; }
  const model = IMAGE_MODELS.has(parsed.model) ? parsed.model : IMAGE_MODEL_DEFAULT;
  if (model === LOCAL_IMAGE_MODEL) return handleLocalImage(req, res, { ctx, parsed, ownUpload, stream: parsed.stream === true });
  const isNano = !/^imagen/.test(model);
  const aspectRatio = imgAspectFor(model, parsed.aspectRatio);
  const imageSize = imgSizeClamp(model, IMAGE_SIZES.has(parsed.imageSize) ? parsed.imageSize : undefined);
  const thinkingLevel = (IMG_THINK_SUPPORT.has(model) && IMG_THINK_LEVELS.has(parsed.thinkingLevel)) ? parsed.thinkingLevel : undefined;
  const useImageSearch = IMG_IMGSEARCH_SUPPORT.has(model) && parsed.useImageSearch === true;
  const useSearch = useImageSearch || (IMG_SEARCH_SUPPORT.has(model) && parsed.useSearch === true);
  const personGeneration = isNano && IMG_PERSON_GEN.has(parsed.personGeneration) ? parsed.personGeneration : undefined;
  const outputFormat = parsed.outputFormat === 'image' ? 'image' : 'both';
  const clampNum = (v, lo, hi) => (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : undefined;
  const temperature = clampNum(parsed.temperature, 0, 2);
  const topP = clampNum(parsed.topP, 0, 1);
  // 会话 id（"连续修改"链的归并键）：前端续改时回传同一个；首轮没有则后端新发一个。
  // 由后端兜底生成 → 不依赖前端 crypto.randomUUID（局域网直连是非安全上下文，可能缺失）。
  const sessionId = (typeof parsed.sessionId === 'string' && ID_RE.test(parsed.sessionId)) ? parsed.sessionId : vertexMedia.newId();
  // 源图（编辑起点，仅 Nano Banana 用）：上传须在调用者自己的 uploads 内（ownUpload 守卫）。
  let srcImage;
  if (ownUpload(parsed.image, ctx)) srcImage = { mimeType: imgMime(parsed.image), data: readFileSync(parsed.image).toString('base64') };

  try {
    const imagen = await import('../imagen.mjs');
    let r;
    if (isNano) {
      // Nano Banana：重建 contents 多轮（历史每轮 user 文字 + model 图 + thoughtSignature），带视觉上下文续改。
      // 只带最近 6 轮的图：每张 2K/4K 图 base64 后数 MB，全量重发几轮就会撞 Vertex ~20MB
      // 请求上限，此后该对话永久报错。6 张已足够延续视觉上下文。
      const turns = (Array.isArray(parsed.turns) ? parsed.turns : []).slice(-6);
      const contents = [];
      for (const t of turns) {
        const tid = String(t.imageId || '');
        const rec = vertexMedia.get(tid, ctx.media);
        const f = vertexMedia.fileFor(tid, ctx.media);
        if (!rec || !f) continue;
        if (t.userText) contents.push({ role: 'user', parts: [{ text: String(t.userText) }] });
        const ex = path.extname(f).slice(1).toLowerCase();
        const mp = { inlineData: { mimeType: ex === 'jpg' ? 'image/jpeg' : (ex === 'webp' ? 'image/webp' : 'image/png'), data: readFileSync(f).toString('base64') } };
        if (rec.signature) mp.thoughtSignature = rec.signature;
        contents.push({ role: 'model', parts: [mp] });
      }
      // 当前用户轮：有源图则连图带文（首轮「编辑这张图」）；后续轮靠 turns + thoughtSignature 续上下文。
      const lastParts = [];
      if (srcImage) lastParts.push({ inlineData: { mimeType: srcImage.mimeType, data: srcImage.data } });
      lastParts.push({ text: message });
      contents.push({ role: 'user', parts: lastParts });
      r = await imagen.generateChat({ model, contents, aspectRatio: aspectRatio === 'auto' ? undefined : aspectRatio, imageSize, thinkingLevel, useSearch, useImageSearch, personGeneration, temperature, topP, outputFormat, project: VERTEX_PROJECT, location: VERTEX_LOCATION });
    } else {
      // Imagen：无对话上下文，turns 忽略，每轮独立文生图
      r = await imagen.generate({ model, prompt: message, aspectRatio: aspectRatio === 'auto' ? undefined : aspectRatio, imageSize, project: VERTEX_PROJECT, location: VERTEX_MEDIA_LOCATION });
      r.signature = '';
    }
    const ext = r.mime.includes('jpeg') ? 'jpg' : (r.mime.includes('webp') ? 'webp' : 'png');
    const id = vertexMedia.newId();
    vertexMedia.save(id, r.bytes, ext, { kind: 'image', prompt: message, model, signature: r.signature || '', sessionId }, ctx.media);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id, url: '/api/vertex/media?id=' + id, sessionId }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '对话式图像失败：' + String(err?.message ?? err).slice(0, 300) }));
  }
}

async function handleVertexTTS(req, res, identify) {
  const ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let parsed;
  try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
  const text = String(parsed.text ?? '').trim();
  const model = TTS_MODELS.has(parsed.model) ? parsed.model : TTS_MODEL_DEFAULT;
  const voice = TTS_VOICES.has(parsed.voice) ? parsed.voice : TTS_VOICE_DEFAULT;
  // 风格指令：Gemini TTS 的风格控制就是自然语言，拼在正文前一起送（官方用法）。
  const style = String(parsed.style ?? '').trim().slice(0, 120);
  // 多人对白（最多 2 人）：speakerVoiceConfigs 的 speaker 名要和正文里的「名字：」对上，
  // 缺名字或缺音色的行直接丢掉；不足 2 人就退回单人合成。
  const speakers = (Array.isArray(parsed.speakers) ? parsed.speakers : [])
    .map((sp) => ({ speaker: String(sp?.speaker ?? '').trim().slice(0, 24), voice: TTS_VOICES.has(sp?.voice) ? sp.voice : '' }))
    .filter((sp) => sp.speaker && sp.voice)
    .slice(0, TTS_MAX_SPEAKERS);
  if (!text) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('empty text'); return; }
  try {
    const tts = await import('../tts.mjs');
    const r = await tts.generate({ model, text, style, voiceName: voice, speakers: speakers.length >= 2 ? speakers : null, project: VERTEX_PROJECT, location: VERTEX_MEDIA_LOCATION });
    const id = vertexMedia.newId();
    vertexMedia.save(id, r.bytes, 'wav', { kind: 'audio', prompt: text, model, voice: speakers.length >= 2 ? speakers.map((sp) => sp.speaker + '=' + sp.voice).join(' / ') : voice, style }, ctx.media);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id, url: '/api/vertex/media?id=' + id }));
  } catch (err) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '语音生成失败：' + String(err?.message ?? err).slice(0, 300) }));
  }
}

async function handleVertexMusic(req, res, identify) {
  const ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let parsed;
  try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
  const prompt = String(parsed.prompt ?? '').trim();
  const model = MUSIC_MODELS.has(parsed.model) ? parsed.model : MUSIC_MODEL_DEFAULT;
  // 负面提示词只有 lyria-002 的 Vertex :predict 通道吃；lyria-3 走 generateContent 没这参数。
  const negativePrompt = (musicNegSupport(model) && parsed.negativePrompt) ? String(parsed.negativePrompt).trim() : '';
  if (!prompt) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('empty prompt'); return; }

  writeSseHeaders(res);
  const sendM = (obj) => sseWrite(res, obj);
  const hb = startHeartbeat(res);
  const start = Date.now();
  const tick = setInterval(() => sendM({ type: 'progress', elapsed: Math.round((Date.now() - start) / 1000) }), 5000);
  const id = vertexMedia.newId();
  sendM({ type: 'start', id });
  try {
    const music = await import('../music.mjs');
    const r = await music.generate({ model, prompt, negativePrompt, project: VERTEX_PROJECT, location: VERTEX_MEDIA_LOCATION, apiKey: GEMINI_API_KEY });
    const ext = /mpeg|mp3/.test(r.mime || '') ? 'mp3' : 'wav';
    vertexMedia.save(id, r.bytes, ext, { kind: 'music', prompt, model }, ctx.media);
    sendM({ type: 'music', id, url: '/api/vertex/media?id=' + id });
  } catch (err) {
    sendM({ type: 'error', message: '音乐生成失败：' + String(err?.message ?? err).slice(0, 300) });
  } finally {
    clearInterval(hb); clearInterval(tick);
    if (!res.writableEnded) res.end();
  }
}

// 生成（花钱）的端点跟着 Gemini 这个 agent 开关走（全局开关 ∩ 按人授权）；已生成的产物照常能看、能删——
// 关掉 Gemini 之后，Claude 聊天记录里以前生成的图也还得显示。
// 成员还要过媒体额度（核心 runtime/quota.mjs admitUsage：成员没开放媒体 / 视频生成、或今天的次数用完就拦，放行即记一次）。
const geminiGate = (identify, handler, kind = 'media') => (req, res, url) => {
  const ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  if (!ctx.allowGemini) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Gemini 未启用，或你的账号没有使用权限' })); return; }
  const block = admitUsage(ctx, kind);
  if (block) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: block.message, title: block.title })); return; }
  return handler(req, res, url);
};

export function registerMediaRoutes(router, { authOk, identify }) {
  registerLocalImageRoutes(router, { identify });
  router.on('POST', '/api/vertex/video', geminiGate(identify, (req, res) => handleVeoVideo(req, res, identify), 'video'));
  router.on('POST', '/api/vertex/image', geminiGate(identify, (req, res) => handleVertexImage(req, res, identify)));
  router.on('POST', '/api/vertex/image-chat', geminiGate(identify, (req, res) => handleImageChat(req, res, identify)));
  // 对话式图像的"会话"维度（按 sessionId 分组）：历史抽屉列会话、点开还原整条修改链、删整条。
  router.on('GET', '/api/vertex/image-chats', (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: vertexMedia.listImageChats(ctx.media) }));
  });
  router.on('GET', '/api/vertex/image-chat/session', (req, res, url) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const data = vertexMedia.loadImageChat(url.searchParams.get('id') || '', ctx.media);
    if (!data) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  });
  router.on('POST', '/api/vertex/image-chat/delete', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const ok = vertexMedia.removeImageChat(String(body.id || ''), ctx.media);
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
  });
  router.on('POST', '/api/vertex/tts', geminiGate(identify, (req, res) => handleVertexTTS(req, res, identify)));
  router.on('POST', '/api/vertex/music', geminiGate(identify, (req, res) => handleVertexMusic(req, res, identify)));

  // Per-kind list endpoints (return both `videos` legacy + `media` keys), scoped
  // to the caller's own media dir.
  for (const [p, kind] of [
    ['/api/vertex/videos', 'video'],
    ['/api/vertex/images', 'image'],
    ['/api/vertex/audios', 'audio'],
    ['/api/vertex/musics', 'music'],
  ]) {
    router.on('GET', p, (req, res) => {
      const ctx = requireCtx(identify, req, res);
      if (!ctx) return;
      const items = vertexMedia.list(kind, ctx.media);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ videos: items, media: items }));
    });
  }

  // Per-kind delete endpoints (shared id namespace -> same remove()).
  for (const p of ['/api/vertex/video/delete', '/api/vertex/image/delete', '/api/vertex/audio/delete', '/api/vertex/music/delete']) {
    router.on('POST', p, async (req, res) => {
      const ctx = requireCtx(identify, req, res);
      if (!ctx) return;
      let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
      const ok = vertexMedia.remove(String(body.id || ''), ctx.media);
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    });
  }
}
