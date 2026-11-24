// Phone-bridge flavor of the media tools. Tool schemas/clamps live in ./media-tools.mjs
// (shared with the desktop stdio MCP in mcp-media.mjs). This file provides the phone adapter —
// how to generate (through the Media Studio job executor, so the artifact lands in the caller's
// media dir and shows up in Studio's job tray / 作品流), emit gen_media events to the right caller's
// in-flight gen, and phrase the result text in Chinese.
//
// Multi-user: makeMediaMcp({ ctx, getGen }) builds a media MCP scoped to one caller — a user gets their
// own .bridge/media + their own gen key + their own Studio services (and the admin's shared ones).
// getGen（per-run 闭包）精确路由到发起调用的那一轮——多对话并发下不能再按 key 找「唯一活跃 gen」；
// 不传则回落 key 查找（routines 等无 live 观众的路径）。MEDIA_MCP 是管理员 / 默认实例。

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import * as vertexMedia from '@bridge/core/vertex-media.mjs';
import { buildMediaTools } from './media-tools.mjs';
import { getCurrentGen, genEmit } from '@bridge/core/runtime/gen.mjs';
import { agentMediaDeny, capVideoResolution } from '@bridge/core/runtime/vertex-settings.mjs';
import { contextFor } from '@bridge/core/runtime/identity.mjs';
import path from 'node:path';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { startJob, cancelJob } from '../jobs.mjs';
import { studioOwner } from '../providers.mjs';
import { explicitDefault } from '../catalog.mjs';
import { mediaModelsText } from './media-models.mjs';

// 素材路径 → Studio 的素材写法（startJob 的 resolveInput 再过一遍守卫）。Claude 手里多是绝对路径：
// 媒体库里的作品文件 → asset（作品 id，血缘接得上）；上传目录 → upload；工作空间 → 相对 path；
// 都不在：管理员（本来就能读整台机器）拷进上传目录再用，成员照实报错。Windows 盘符 / 大小写不敏感。
const ID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]{2,5}$/i;
const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (root, abs) => { if (!root) return false; const r = norm(root), a = norm(abs); return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep); };
export function studioInput(ctx, x) {
  if (!x || typeof x !== 'object') throw new Error('素材格式不对');
  const role = x.role;
  if (x.asset) return { role, asset: String(x.asset) };
  const raw = typeof x.path === 'string' ? x.path.trim() : '';
  if (!raw) throw new Error('素材要给 path 或 asset');
  if (!path.isAbsolute(raw) && !path.win32.isAbsolute(raw)) return { role, path: raw };
  const abs = path.resolve(raw);
  if (inside(ctx.media, abs)) {
    const m = ID_FILE_RE.exec(path.basename(abs));
    if (m && norm(path.dirname(abs)) === norm(ctx.media)) return { role, asset: m[1].toLowerCase() };
  }
  if (inside(ctx.uploads, abs)) return { role, upload: abs };
  if (inside(ctx.cwd, abs)) return { role, path: path.relative(path.resolve(ctx.cwd), abs).split(path.sep).join('/') };
  if (ctx.kind === 'admin' && ctx.uploads) {
    let st;
    try { st = statSync(abs); } catch { throw new Error('素材文件不存在：' + raw); }
    if (!st.isFile()) throw new Error('素材不是文件：' + raw);
    const dir = path.join(ctx.uploads, 'claude-inputs');
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, Date.now().toString(36) + '-' + path.basename(abs));
    copyFileSync(abs, dest);
    return { role, upload: dest };
  }
  throw new Error('素材不在工作空间、上传目录或媒体库里：先把它复制进工作空间再用（' + raw + '）');
}

// Studio 设置里显式选的默认模型 → 工具描述补一句、不传 model 时用它（没设 = null，描述一字不变）
export function toolDefaults(owner) {
  return (kind) => {
    const r = explicitDefault(kind, owner);
    if (!r) return null;
    const google = r.provider.dialect === 'vertex' || r.provider.dialect === 'gemini';
    return { key: r.provider.id + '/' + r.entry.id, label: r.entry.label || r.entry.id, ...(google ? { bare: r.entry.id } : {}) };
  };
}

// 成功回执。图片报实际像素（「请求 4K → 实际 768×1376」，2026-11-07 回执只回显请求档位、看不出拿到的是 1K）；
// 明显低于请求档位时直说。量不到像素（作品侧车没有宽高）照旧只报请求档位。媒体 id 留在文件路径里（sessions.mjs 按它还原转录）。
// 同一次多出的几件（params 里的张数 / 条数）：接在回执末尾逐个列路径（转录还原按路径里的媒体 id 一件一段）
export function resultText(kind, info) {
  const more = (info.more || []).filter((x) => x && x.file);
  const t = baseResultText(kind, info);
  return more.length ? t + '\n同一次另外生成的 ' + more.length + ' 件：\n' + more.map((x) => x.file).join('\n') : t;
}
function baseResultText(kind, info) {
  if (kind === 'image') {
    const size = info.width
      ? ' · ' + (info.imageSize && !info.isImagen ? '请求 ' + info.imageSize + ' → ' : '') + '实际 ' + info.width + '×' + info.height
      : (info.isImagen ? '' : ' · ' + info.imageSize);
    const low = info.downscaled
      ? '注意：实际像素明显低于请求的 ' + info.imageSize + ' 档；要大图请换模型或重试' + (info.aspectRatio === 'auto' ? '，或指定明确的 aspectRatio' : '') + '。'
      : '';
    return '已生成图片并展示给用户（' + info.model + size + ' · ' + info.aspectRatio + (info.thinkingLevel ? ' · 思考 ' + info.thinkingLevel : '') + '）。' + low + (info.id ? '作品 id ' + info.id + '（接着改这张传 continueFrom）。' : '') + '绝对文件路径（可用 Read 查看，或 Bash 复制进项目当素材）：' + info.file;
  }
  if (kind === 'video') return '已生成视频并展示给用户（' + info.model + ' · ' + info.resolution + ' · ' + info.aspectRatio + ' · ' + info.durationSeconds + 's）。绝对文件路径：' + info.file;
  if (kind === 'audio') return '已生成语音并展示给用户。绝对文件路径：' + info.file;
  if (kind === 'music') return '已生成音乐并展示给用户。绝对文件路径：' + info.file;
  return '已生成。绝对文件路径：' + info.file;
}

export function makeAdapter({ ctx, genKey, getGen }) {
  return {
    newId: () => vertexMedia.newId(),
    // 走 Studio 任务执行器：作品 id 预先定好（gen_media_start 已经报出去了），额度在任务里判（这里 quota:false，guarded 已判过）
    generate: async (kind, body, { id, onProgress, signal }) => {
      const { continueFrom, ...b } = body;
      if (b.inputs) b.inputs = b.inputs.map((x) => studioInput(ctx, x));
      // 接着改某张图：接回它的续改链（链 id = 它的 sessionId，第一张自成一条 = 它自己的 id），parent 记血缘
      if (continueFrom) {
        const rec = vertexMedia.get(continueFrom, ctx.media);
        if (!rec) throw new Error('continueFrom 指的作品不存在：' + continueFrom);
        b.thread = rec.sessionId || continueFrom;
        b.parent = continueFrom;
      }
      if (signal?.aborted) throw new Error('已取消');
      const { job: j0, done, warnings } = startJob(ctx, b, {
        source: 'claude', presetIds: [id], quota: false, autoSave: false,
        onEvent: (ev) => { if (ev.state === 'running') onProgress(ev.elapsed || 0); },
      });
      // Claude 这一轮被中断：取消 Studio 任务（已提交到上游、取消不了的，任务里记「已放弃」）
      const onAbort = () => { try { cancelJob(studioOwner(ctx) || 'admin', j0.id); } catch {} };
      signal?.addEventListener('abort', onAbort, { once: true });
      let job;
      try { job = await done; } finally { signal?.removeEventListener('abort', onAbort); }
      if (job.state !== 'done' || !job.result.length) throw Object.assign(new Error(job.error || job.note || '没有结果'), { warnings });
      const fileOf = (aid) => vertexMedia.mediaPath(aid, vertexMedia.get(aid, ctx.media)?.ext || 'bin', ctx.media);
      const a = job.result[0];
      const rec = vertexMedia.get(a.id, ctx.media);
      // 图片带回实际像素（存作品时量的）与真正下发的参数（卡规范化之后）：回执报实际值、查是不是没拿到要的档位
      return {
        id: a.id, file: fileOf(a.id), model: rec?.model, width: rec?.width, height: rec?.height, params: rec?.params, warnings,
        ...(job.result.length > 1 ? { more: job.result.slice(1).map((x) => ({ id: x.id, file: fileOf(x.id) })) } : {}),
      };
    },
    models: (args) => mediaModelsText(studioOwner(ctx) || 'admin', args, { kinds: ['image', 'video', 'speech', 'music'].filter((k) => !agentMediaDeny('claude', k)) }),
    emit: (ev) => {
      const gen = (getGen && getGen()) || getCurrentGen(genKey);
      if (!gen) return;
      // The served URL lets the page render the artifact inline; the media-serve
      // route resolves it from the SAME caller's media dir.
      if (ev.type === 'gen_media' && ev.id) ev.url = '/api/vertex/media?id=' + ev.id;
      genEmit(gen, ev);
    },
    resultText,
    errorText: (kind, e) => {
      const m = String(e?.message ?? e).slice(0, 200);
      if (kind === 'image') return '图像生成失败：' + m;
      if (kind === 'video') return '视频生成失败：' + m;
      if (kind === 'audio') return '语音生成失败：' + m;
      if (kind === 'music') return '音乐生成失败：' + m;
      return '生成失败：' + m;
    },
  };
}

// 成员的媒体额度（核心 runtime/quota.mjs admitUsage）：每次调用先过闸，放行即记一次；拦下就把原因当工具结果回给 Claude。
// 管理员不限。花的是成员自己 Key 的也照旧计一次（同升级前：成员经 Claude 生成媒体一律计额度）。
import { admitUsage } from '@bridge/core/runtime/quota.mjs';
const MEDIA_KIND = { generate_video: 'video' };
// 工具 → 设置里的媒体种类（设置 › Media Studio「agent 能生成什么」）
const TOOL_KIND = { generate_image: 'image', generate_video: 'video', generate_speech: 'speech', generate_music: 'music' };
// 一次要出几件（params 里的张数 / 条数，键名同 jobs.mjs 的 COUNT_KEY）：额度按件计，没给就是 1
const COUNT_KEY = /^(n|count|num_images|numImages|num_outputs|number_of_images|numberOfImages|batch_size|sample_count|sampleCount|num_videos)$/;
export function unitsOfArgs(args) {
  const p = args && args.params && typeof args.params === 'object' ? args.params : {};
  let n = 1;
  for (const [k, v] of Object.entries(p)) if (COUNT_KEY.test(k) && Number.isFinite(Number(v))) n = Math.max(n, Math.floor(Number(v)));
  return Math.min(Math.max(n, 1), 16);
}
function guarded(t, ctx) {
  // 查模型只读、不花钱：不判种类、不计额度
  if (!TOOL_KIND[t.name]) return t.handler;
  return async (args, extra) => {
    // 建工具集之后设置可能又改了：调用时再判一次（工具集下一条消息才换新）
    const deny = agentMediaDeny('claude', TOOL_KIND[t.name]);
    if (deny) return { isError: true, content: [{ type: 'text', text: deny }] };
    if (t.name === 'generate_video' && args) {
      // 分辨率上限：工具字段和 params 里的都夹
      if (args.resolution) args = { ...args, resolution: capVideoResolution(args.resolution) };
      if (args.params && typeof args.params === 'object' && typeof args.params.resolution === 'string') args = { ...args, params: { ...args.params, resolution: capVideoResolution(args.params.resolution) } };
    }
    if (ctx && ctx.kind === 'user') {
      const block = admitUsage(ctx, MEDIA_KIND[t.name] || 'media', unitsOfArgs(args));
      if (block) return { isError: true, content: [{ type: 'text', text: block.title + '：' + block.message }] };
    }
    return t.handler(args, extra);
  };
}

const ADMIN_CTX = () => contextFor({ kind: 'admin', user: null });

// Build a media MCP scoped to one caller. ctx 不传 = 管理员 / 默认实例（主机媒体目录、'admin' gen key）。
export function makeMediaMcp({ ctx = null, genKey, getGen } = {}) {
  const c = ctx || ADMIN_CTX();
  const owner = studioOwner(c) || 'admin';
  return createSdkMcpServer({
    name: 'media',
    version: '1.0.0',
    tools: buildMediaTools({
      flavor: 'phone',
      adapter: makeAdapter({ ctx: c, genKey: genKey || c.key || 'admin', getGen }),
      defaults: toolDefaults(owner),
    }).filter((t) => !agentMediaDeny('claude', TOOL_KIND[t.name]))   // 管理员关掉的种类不给
      .map((t) => tool(t.name, t.description, t.schema, guarded(t, ctx && ctx.kind === 'user' ? ctx : null))),
  });
}
