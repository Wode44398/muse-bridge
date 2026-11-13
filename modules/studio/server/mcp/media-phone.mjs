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
import { startJob } from '../jobs.mjs';
import { studioOwner } from '../providers.mjs';
import { explicitDefault } from '../catalog.mjs';

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
export function resultText(kind, info) {
  if (kind === 'image') {
    const size = info.width
      ? ' · ' + (info.imageSize && !info.isImagen ? '请求 ' + info.imageSize + ' → ' : '') + '实际 ' + info.width + '×' + info.height
      : (info.isImagen ? '' : ' · ' + info.imageSize);
    const low = info.downscaled
      ? '注意：实际像素明显低于请求的 ' + info.imageSize + ' 档；要大图请换模型或重试' + (info.aspectRatio === 'auto' ? '，或指定明确的 aspectRatio' : '') + '。'
      : '';
    return '已生成图片并展示给用户（' + info.model + size + ' · ' + info.aspectRatio + (info.thinkingLevel ? ' · 思考 ' + info.thinkingLevel : '') + '）。' + low + '绝对文件路径（可用 Read 查看，或 Bash 复制进项目当素材）：' + info.file;
  }
  if (kind === 'video') return '已生成视频并展示给用户（' + info.model + ' · ' + info.resolution + ' · ' + info.aspectRatio + ' · ' + info.durationSeconds + 's）。绝对文件路径：' + info.file;
  if (kind === 'audio') return '已生成语音并展示给用户。绝对文件路径：' + info.file;
  if (kind === 'music') return '已生成音乐并展示给用户。绝对文件路径：' + info.file;
  return '已生成。绝对文件路径：' + info.file;
}

function makeAdapter({ ctx, genKey, getGen }) {
  return {
    newId: () => vertexMedia.newId(),
    // 走 Studio 任务执行器：作品 id 预先定好（gen_media_start 已经报出去了），额度在任务里判（这里 quota:false，guarded 已判过）
    generate: async (kind, body, { id, onProgress }) => {
      const { done } = startJob(ctx, body, {
        source: 'claude', presetIds: [id], quota: false, autoSave: false,
        onEvent: (ev) => { if (ev.state === 'running') onProgress(ev.elapsed || 0); },
      });
      const job = await done;
      if (job.state !== 'done' || !job.result.length) throw new Error(job.error || job.note || '没有结果');
      const a = job.result[0];
      const rec = vertexMedia.get(a.id, ctx.media);
      // 图片带回实际像素（存作品时量的）与真正下发的参数（卡规范化之后）：回执报实际值、查是不是没拿到要的档位
      return { id: a.id, file: vertexMedia.mediaPath(a.id, rec?.ext || 'bin', ctx.media), model: rec?.model, width: rec?.width, height: rec?.height, params: rec?.params };
    },
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
function guarded(t, ctx) {
  return async (args, extra) => {
    // 建工具集之后设置可能又改了：调用时再判一次（工具集下一条消息才换新）
    const deny = agentMediaDeny('claude', TOOL_KIND[t.name]);
    if (deny) return { isError: true, content: [{ type: 'text', text: deny }] };
    if (t.name === 'generate_video' && args && args.resolution) args = { ...args, resolution: capVideoResolution(args.resolution) };
    if (ctx && ctx.kind === 'user') {
      const block = admitUsage(ctx, MEDIA_KIND[t.name] || 'media');
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
