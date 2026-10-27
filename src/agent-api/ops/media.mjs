// 媒体生成（Vertex 扩展）：图片、视频、语音、音乐。经扩展自己的 /api/vertex/* 路由——开关、按人授权、
// 成员的媒体 / 视频额度、参数按模型夹紧都在那儿；没装扩展时这组操作对谁都不可用。
// 产物落在调用者自己的媒体目录（和界面上生成的同一处，Vertex 分页的历史里也看得到）；saveTo 可顺手复制进工作空间。

import path from 'node:path';
import { existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';
import { fileFor } from '../../vertex-media.mjs';
import { safeJoin } from '../../runtime/http-file.mjs';
import { protectedTarget, uniquePath } from '../../routes/file-core.mjs';

defineGroup('media', '媒体生成', '图片 / 视频 / 语音 / 音乐（Vertex 扩展，模型与参数见手册 vertex 章）。');

const SAVE_TO = { type: 'string', desc: '可选：生成后复制进工作空间的路径（文件夹以 / 结尾则用原文件名放进去）' };
const REF = { type: 'string', desc: '可选：参考图——服务器上的绝对路径，须在你的上传目录或工作空间里' };

function fail(r, what) {
  const code = r.status === 403 ? 'forbidden' : r.status === 429 ? 'quota' : r.status === 400 ? 'bad_args' : 'failed';
  throw new OpError(code, what + '：' + routeError(r));
}

function deliver(ctx, env, id, kind, saveTo) {
  const file = fileFor(id, ctx.media);
  const out = { id, kind, url: (env.origin || '') + '/api/vertex/media?id=' + encodeURIComponent(id), ...(file ? { serverPath: file } : {}) };
  if (saveTo && file) {
    const raw = String(saveTo).replace(/\\/g, '/');
    let dest = safeJoin(ctx.cwd, raw.replace(/\/+$/, ''));
    if (!dest || protectedTarget(ctx.cwd, dest, ctx)) throw new OpError('forbidden', 'saveTo 越界或指向系统目录');
    const asDir = raw.endsWith('/') || (existsSync(dest) && statSync(dest).isDirectory());
    if (asDir) { mkdirSync(dest, { recursive: true }); dest = path.join(dest, path.basename(file)); }
    else mkdirSync(path.dirname(dest), { recursive: true });
    dest = uniquePath(dest);
    copyFileSync(file, dest);
    out.savedTo = path.relative(path.resolve(ctx.cwd), dest).split(path.sep).join('/');
  }
  return out;
}

async function jsonGen(ctx, env, url, body, kind, what, saveTo) {
  const r = await internalRequest(env.identity, 'POST', url, body, { timeoutMs: 300_000 });
  if (r.status !== 200 || !r.json) fail(r, what);
  if (!r.json.ok) throw new OpError('failed', r.json.error || what + '失败');
  return deliver(ctx, env, r.json.id, kind, saveTo);
}

async function sseGen(ctx, env, url, body, kind, doneType, what, saveTo) {
  const r = await internalRequest(env.identity, 'POST', url, body, { timeoutMs: 15 * 60_000 });
  if (!r.sse) fail(r, what);
  const done = r.events.find((ev) => ev.type === doneType);
  const err = r.events.find((ev) => ev.type === 'error');
  if (!done) throw new OpError(r.timedOut ? 'timeout' : 'failed', (err && err.message) || (r.timedOut ? what + '超时' : what + '失败'));
  return deliver(ctx, env, done.id, kind, saveTo);
}

defineOp({
  name: 'media.image', title: '生成图片',
  desc: '文生图（给 image 则按参考图改）。几秒到几十秒。不填的参数走智能默认。',
  access: 'write', slow: true, need: ['agent:gemini'],
  params: {
    prompt: { type: 'string', required: true, max: 8000, desc: '画面描述：主体、场景、风格、光线、镜头' },
    model: { type: 'string', desc: '图像模型 id（见手册 vertex 章）' },
    aspectRatio: { type: 'string', desc: '比例，如 1:1、16:9、9:16、4:3' },
    imageSize: { type: 'string', desc: '1K / 2K / 4K（按模型夹紧）' },
    thinkingLevel: { type: 'string', desc: '思考档（只有部分模型支持）' },
    useSearch: { type: 'boolean', desc: '联网搜索增强（真实世界的人物 / 地标 / 新事物）' },
    useImageSearch: { type: 'boolean', desc: '图片搜索增强（部分模型）' },
    image: REF, saveTo: SAVE_TO,
  },
  example: { prompt: '雨夜的上海外滩，霓虹倒影，电影感，35mm', aspectRatio: '16:9', saveTo: 'images/' },
  handler: async (ctx, args, env) => {
    const { saveTo, ...body } = args;
    return jsonGen(ctx, env, '/api/vertex/image', body, 'image', '生成图片', saveTo);
  },
});

defineOp({
  name: 'media.video', title: '生成视频',
  desc: '文生视频（给 image 则以它为首帧）。约 1–3 分钟、按秒计费——用户没明确要视频时先确认。',
  access: 'danger', slow: true, need: ['agent:gemini'],
  params: {
    prompt: { type: 'string', required: true, max: 8000, desc: '画面 + 运动 + 镜头语言（推拉摇移、景别）' },
    model: { type: 'string' },
    aspectRatio: { type: 'string', desc: '16:9 / 9:16' },
    resolution: { type: 'string', desc: '720p / 1080p / 4k（按模型夹紧）' },
    durationSeconds: { type: 'integer', min: 1, max: 10 },
    generateAudio: { type: 'boolean', desc: '带声音' },
    negativePrompt: { type: 'string', max: 500 },
    image: REF, saveTo: SAVE_TO,
  },
  handler: async (ctx, args, env) => {
    const { saveTo, image, ...body } = args;
    if (image) { body.image = image; body.task = 'i2v'; }
    return sseGen(ctx, env, '/api/vertex/video', body, 'video', 'video', '生成视频', saveTo);
  },
});

defineOp({
  name: 'media.speech', title: '文字转语音',
  desc: '把一段文字读成语音（几秒）。',
  access: 'write', slow: true, need: ['agent:gemini'],
  params: {
    text: { type: 'string', required: true, max: 8000 },
    voice: { type: 'string', desc: '音色名（见手册 vertex 章）' },
    style: { type: 'string', max: 120, desc: '语气 / 风格提示，如「温柔地」「新闻播报」' },
    model: { type: 'string' },
    saveTo: SAVE_TO,
  },
  handler: async (ctx, args, env) => {
    const { saveTo, ...body } = args;
    return jsonGen(ctx, env, '/api/vertex/tts', body, 'speech', '生成语音', saveTo);
  },
});

defineOp({
  name: 'media.music', title: '生成音乐',
  desc: '按风格描述生成一段音乐（约 1–2 分钟出结果、按次计费——用户没明确要时先确认）。',
  access: 'danger', slow: true, need: ['agent:gemini'],
  params: {
    prompt: { type: 'string', required: true, max: 4000, desc: '风格 + 乐器 + 情绪 + 节奏（英文更准）' },
    negativePrompt: { type: 'string', max: 500, desc: '不要什么（部分模型生效）' },
    model: { type: 'string' },
    saveTo: SAVE_TO,
  },
  handler: async (ctx, args, env) => {
    const { saveTo, ...body } = args;
    return sseGen(ctx, env, '/api/vertex/music', body, 'music', 'music', '生成音乐', saveTo);
  },
});
