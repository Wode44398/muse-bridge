// 旧的 Vertex 媒体接口（方案 §3.6 兼容层）：/api/vertex/{image,image-chat,video,tts,music}、各种类的列表与删除、
// 对话式图像的会话分组。旧 apk、agent 接口的 media.* 内部回放都还在用——2026-11-04 起改成 Media Studio 的薄转接：
// 请求体照旧解析（参数名、默认值、按模型夹紧都不变），转成 Studio 任务交给 jobs.mjs 跑，响应形状照旧
// （图像 / 配音同步 JSON；视频 / 音乐 SSE 的 start / progress / video|music / error，start 的 id 就是最后作品的 id，
// 断线后旧前端按它去历史里找）。模型参数收裸 id（按内置 Google 模型 id 找这个人能用的服务）或 '<服务>/<模型>'。
//
// Multi-user：作品照旧落在调用者自己的媒体目录（admin → ROOT/media；成员 → 他的 .bridge/media）。
// 视频 / 音乐这类长任务不随客户端断开而取消——按秒计费，结果必须落盘。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readBody } from '@bridge/core/runtime/body.mjs';
import { writeSseHeaders, sseWrite, startHeartbeat } from '@bridge/core/runtime/sse.mjs';
import * as vertexMedia from '@bridge/core/vertex-media.mjs';
import {
  VEO_MODELS, VEO_MODEL_DEFAULT, veoTaskOk, IMAGE_MODELS, TTS_MODELS, MUSIC_MODELS,
} from '@bridge/core/config/capabilities.mjs';
import { requireCtx } from '@bridge/core/runtime/identity.mjs';
import { ID_RE } from '@bridge/core/jsonfile.mjs';
import { startJob } from '../jobs.mjs';
import { parseModelKey } from '../providers.mjs';
import { registerLocalImageRoutes } from './local-image.mjs';

// 按 id 取文件（GET /api/vertex/media）在核心 media-file.mjs；这里照旧转出 serveMediaFile。
export { serveMediaFile } from '@bridge/core/routes/media-file.mjs';

// 上传的图只认调用者自己 uploads 里的（ownUpload 守卫）→ Studio 素材 { role, upload: <uploads 相对路径> }
const ownUpload = (p, ctx) => typeof p === 'string' && path.resolve(p).startsWith(path.resolve(ctx.uploads) + path.sep) && existsSync(p);
const uploadInput = (role, p, ctx) => ({ role, upload: path.relative(path.resolve(ctx.uploads), path.resolve(p)).split(path.sep).join('/') });

// 旧接口的模型参数：'<服务>/<模型>' 原样；认识的裸 id 原样；没给 / 不认识的 = ''（任务执行器用 Studio 的默认模型——
// 设置里没选过就是内置默认，与以前的旧默认同一个）
const pickModel = (v, known) => (typeof v === 'string' && (parseModelKey(v) || known.has(v)) ? v : '');

const textErr = (res, code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); };
const jsonOut = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
async function parse(req, res) {
  try { return JSON.parse(await readBody(req)); } catch { textErr(res, 400, 'bad json'); return null; }
}
// startJob 抛的错：没权限 / 额度用完照旧 403 / 429 JSON；其余交给各接口按旧形状报
function gateError(res, e) {
  if (e && (e.status === 403 || e.status === 429)) { jsonOut(res, e.status, { error: e.message, ...(e.title ? { title: e.title } : {}) }); return true; }
  return false;
}

// —— 同步 JSON：图像（单发 / 对话式）、配音。本机 Qwen 的旧前端带 stream:true 时改回 SSE（start / progress / image / error）——
async function syncJob(req, res, identify, build, shape) {
  const ctx = requireCtx(identify, req, res); if (!ctx) return;
  const parsed = await parse(req, res); if (!parsed) return;
  const b = build(parsed, ctx);
  if (b.reject) return textErr(res, 400, b.reject);
  const stream = parsed.stream === true && /qwen-image/.test(String(b.job.key));   // 本机模型只认显式选的（旧前端总会带 model）
  let started;
  try {
    started = startJob(ctx, b.job, {
      source: 'legacy', ...(b.opts || {}),
      ...(stream ? { onEvent: (ev) => { if (ev.detail && res.headersSent && !res.writableEnded) sseWrite(res, { type: 'progress', ...ev.detail }); } } : {}),
    });
  } catch (e) {
    if (gateError(res, e)) return;
    return jsonOut(res, stream ? 400 : 200, { ok: false, error: shape.fail + String(e?.message ?? e).slice(0, 300) });
  }
  let hb;
  if (stream) { writeSseHeaders(res); hb = startHeartbeat(res); sseWrite(res, { type: 'start', sessionId: b.sessionId, model: b.job.key }); }
  try {
    const job = await started.done;
    const failed = job.state !== 'done' || !job.result.length;
    const out = failed ? { ok: false, error: shape.fail + String(job.error || job.note || '没有结果').slice(0, 300) } : shape.ok(job, b, ctx);
    if (!stream) return jsonOut(res, 200, out);
    sseWrite(res, failed ? { type: 'error', message: out.error } : { type: 'image', ...out });
  } finally {
    if (hb) clearInterval(hb);
    if (stream && !res.writableEnded) res.end();
  }
}

// —— SSE：视频、音乐（start 的 id = 作品 id，断线后旧前端按它找历史）——
async function sseJob(req, res, identify, build, doneType, failText) {
  const ctx = requireCtx(identify, req, res); if (!ctx) return;
  const parsed = await parse(req, res); if (!parsed) return;
  const b = build(parsed, ctx);
  if (b.reject) return textErr(res, 400, b.reject);
  const assetId = vertexMedia.newId();
  let started;
  try {
    started = startJob(ctx, b.job, {
      source: 'legacy', presetIds: [assetId],
      onEvent: (ev) => { if (ev.state === 'running' && res.headersSent && !res.writableEnded) sseWrite(res, { type: 'progress', elapsed: ev.elapsed || 0 }); },
    });
  } catch (e) {
    if (gateError(res, e)) return;
    writeSseHeaders(res); sseWrite(res, { type: 'error', message: failText + String(e?.message ?? e).slice(0, 300) }); res.end(); return;
  }
  writeSseHeaders(res);
  const hb = startHeartbeat(res);
  sseWrite(res, { type: 'start', id: assetId, ...(b.startExtra || {}) });
  try {
    const job = await started.done;
    const a = job.state === 'done' && job.result[0];
    if (a) sseWrite(res, { type: doneType, id: a.id, url: a.url, ...(doneType === 'video' ? { mime: 'video/mp4' } : {}) });
    else sseWrite(res, { type: 'error', message: failText + String(job.error || job.note || '没有结果').slice(0, 300) });
  } finally {
    clearInterval(hb);
    if (!res.writableEnded) res.end();
  }
}

// —— 各接口的旧参数 → Studio 任务 ——
function videoBuild(parsed, ctx) {
  const prompt = String(parsed.prompt ?? '').trim();
  const model = pickModel(parsed.model, VEO_MODELS);
  // 任务类型：不认或该模型不支持的一律回落 t2v；素材按任务取舍（Veo 收到尾帧却按 t2v 跑 = 白给钱）
  const bare = parseModelKey(model) ? '' : (model || VEO_MODEL_DEFAULT);
  const task = bare ? (veoTaskOk(bare, parsed.task) ? parsed.task : 't2v') : (['i2v', 'interp', 'ref'].includes(parsed.task) ? parsed.task : 't2v');
  const inputs = [];
  if (task !== 't2v' && task !== 'ref' && ownUpload(parsed.image, ctx)) inputs.push(uploadInput('first', parsed.image, ctx));
  if (task === 'interp' && ownUpload(parsed.lastFrame, ctx)) inputs.push(uploadInput('last', parsed.lastFrame, ctx));
  if (task === 'ref' && Array.isArray(parsed.referenceImages)) {
    for (const p of parsed.referenceImages.filter((x) => ownUpload(x, ctx)).slice(0, 3)) inputs.push(uploadInput('ref', p, ctx));
  }
  if (!prompt && !inputs.length) return { reject: 'empty prompt' };
  const params = {};
  for (const k of ['aspectRatio', 'resolution', 'durationSeconds', 'generateAudio', 'enhancePrompt', 'compressionQuality']) if (parsed[k] !== undefined) params[k] = parsed[k];
  return { job: { kind: 'video', key: model, prompt, negative: typeof parsed.negativePrompt === 'string' ? parsed.negativePrompt : '', params, inputs }, startExtra: { model: model || VEO_MODEL_DEFAULT } };
}

function imageBuild(chat) {
  return (parsed, ctx) => {
    const prompt = String((chat ? parsed.message : parsed.prompt) ?? '').trim();
    const model = pickModel(parsed.model, IMAGE_MODELS);
    const inputs = [];
    if (ownUpload(parsed.image, ctx)) inputs.push(uploadInput('edit', parsed.image, ctx));
    // 本机 Qwen 的旧字段：images（多张参考，uploads 路径）/ referenceId（媒体库里的一张）
    if (Array.isArray(parsed.images)) for (const p of parsed.images.slice(0, 10)) if (ownUpload(p, ctx)) inputs.push(uploadInput('ref', p, ctx));
    if (!inputs.length && typeof parsed.referenceId === 'string' && ID_RE.test(parsed.referenceId)) inputs.push({ role: 'ref', asset: parsed.referenceId });
    if (chat ? !prompt : (!prompt && !inputs.length)) return { reject: chat ? 'empty message' : 'empty prompt' };
    const params = {};
    for (const k of ['aspectRatio', 'imageSize', 'thinkingLevel', 'useSearch', 'useImageSearch', 'personGeneration', 'temperature', 'topP', 'quality', 'outputFormat',
      'width', 'height', 'steps', 'seed', 'cfg', 'count', 'useKvCache', 'referenceResolution', 'transparent', 'sigmas']) if (parsed[k] !== undefined) params[k] = parsed[k];
    // 单发 /api/vertex/image 以前不传 temperature / topP 以外的对话参数：输出格式恒为图文
    if (!chat) delete params.outputFormat;
    // 会话 id（连续修改链的归并键）：续改时前端回传同一个；对话式首轮没有就新发一个（单发接口不进链）
    const sessionId = chat ? (typeof parsed.sessionId === 'string' && ID_RE.test(parsed.sessionId) ? parsed.sessionId : vertexMedia.newId()) : null;
    const turns = chat && Array.isArray(parsed.turns) ? parsed.turns.slice(-6).map((t) => ({ userText: String(t?.userText || ''), imageId: String(t?.imageId || '') })) : null;
    return {
      job: { kind: 'image', key: model, prompt, negative: typeof parsed.negativePrompt === 'string' ? parsed.negativePrompt : '', params, inputs, ...(sessionId ? { thread: sessionId } : {}) },
      opts: { turns: turns || [] },
      sessionId,
    };
  };
}

function ttsBuild(parsed) {
  const text = String(parsed.text ?? '').trim();
  if (!text) return { reject: 'empty text' };
  const model = pickModel(parsed.model, TTS_MODELS);
  const params = {};
  for (const k of ['voice', 'style', 'speakers']) if (parsed[k] !== undefined) params[k] = parsed[k];
  return { job: { kind: 'speech', key: model, prompt: text, params, inputs: [] } };
}

function musicBuild(parsed) {
  const prompt = String(parsed.prompt ?? '').trim();
  if (!prompt) return { reject: 'empty prompt' };
  const model = pickModel(parsed.model, MUSIC_MODELS);
  return { job: { kind: 'music', key: model, prompt, negative: parsed.negativePrompt ? String(parsed.negativePrompt) : '', params: {}, inputs: [] } };
}

// 本机 Qwen 的旧前端要的形状：首张的字段平铺 + images 全部（含 seed / 宽高等细节）
function localShape(job, b, ctx) {
  const outputs = job.result.map((a) => {
    const rec = vertexMedia.get(a.id, ctx.media) || {};
    const { id, ext, kind, created, prompt, model, provider, providerName, dialect, params, parents, jobId, source, sessionId, ...details } = rec;
    return { id: a.id, url: a.url, ...details };
  });
  return { ok: true, ...outputs[0], images: outputs, sessionId: b.sessionId || job.result[0]?.thread };
}

export function registerMediaRoutes(router, { identify }) {
  registerLocalImageRoutes(router, { identify });
  router.on('POST', '/api/vertex/video', (req, res) => sseJob(req, res, identify, videoBuild, 'video', '视频生成失败：'));
  router.on('POST', '/api/vertex/music', (req, res) => sseJob(req, res, identify, musicBuild, 'music', '音乐生成失败：'));
  router.on('POST', '/api/vertex/tts', (req, res) => syncJob(req, res, identify, ttsBuild, {
    fail: '语音生成失败：', ok: (job) => ({ ok: true, id: job.result[0].id, url: job.result[0].url }),
  }));
  router.on('POST', '/api/vertex/image', (req, res) => syncJob(req, res, identify, imageBuild(false), {
    fail: '图像生成失败：',
    ok: (job, b, ctx) => (/qwen-image/.test(job.key) ? localShape(job, b, ctx) : { ok: true, id: job.result[0].id, url: job.result[0].url }),
  }));
  router.on('POST', '/api/vertex/image-chat', (req, res) => syncJob(req, res, identify, imageBuild(true), {
    fail: '对话式图像失败：',
    ok: (job, b, ctx) => (/qwen-image/.test(job.key) ? localShape(job, b, ctx) : { ok: true, id: job.result[0].id, url: job.result[0].url, sessionId: b.sessionId }),
  }));

  // 对话式图像的「会话」维度（按 sessionId 分组）：历史抽屉列会话、点开还原整条修改链、删整条。
  router.on('GET', '/api/vertex/image-chats', (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    jsonOut(res, 200, { sessions: vertexMedia.listImageChats(ctx.media) });
  });
  router.on('GET', '/api/vertex/image-chat/session', (req, res, url) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const data = vertexMedia.loadImageChat(url.searchParams.get('id') || '', ctx.media);
    if (!data) return textErr(res, 404, 'not found');
    jsonOut(res, 200, data);
  });
  router.on('POST', '/api/vertex/image-chat/delete', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const body = await parse(req, res); if (!body) return;
    const ok = vertexMedia.removeImageChat(String(body.id || ''), ctx.media);
    jsonOut(res, ok ? 200 : 400, { ok });
  });

  // Per-kind list endpoints (return both `videos` legacy + `media` keys), scoped to the caller's own media dir.
  for (const [p, kind] of [['/api/vertex/videos', 'video'], ['/api/vertex/images', 'image'], ['/api/vertex/audios', 'audio'], ['/api/vertex/musics', 'music']]) {
    router.on('GET', p, (req, res) => {
      const ctx = requireCtx(identify, req, res); if (!ctx) return;
      const items = vertexMedia.list(kind, ctx.media);
      jsonOut(res, 200, { videos: items, media: items });
    });
  }

  // Per-kind delete endpoints (shared id namespace -> same remove()).
  for (const p of ['/api/vertex/video/delete', '/api/vertex/image/delete', '/api/vertex/audio/delete', '/api/vertex/music/delete']) {
    router.on('POST', p, async (req, res) => {
      const ctx = requireCtx(identify, req, res); if (!ctx) return;
      const body = await parse(req, res); if (!body) return;
      const ok = vertexMedia.remove(String(body.id || ''), ctx.media);
      jsonOut(res, ok ? 200 : 400, { ok });
    });
  }
}
