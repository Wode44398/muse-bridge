// Phone-bridge flavor of the media tools. Tool schemas/handlers/clamps live in
// ./media-tools.mjs (shared with the desktop stdio MCP in mcp-media.mjs).
// This file provides the phone adapter — how to save artifacts (into a given media
// dir), emit gen_media events to the right caller's in-flight gen, and phrase the
// result text in Chinese.
//
// Multi-user: makeMediaMcp({ mediaDir, genKey, getGen }) builds a media MCP scoped
// to one caller — a user gets their own .bridge/media + their own gen key, so
// Claude's generated images/etc. land in (and stream to) that user's space.
// getGen（per-run 闭包）精确路由到发起调用的那一轮——多对话并发下不能再按 key 找
// 「唯一活跃 gen」；不传则回落 key 查找（routines 等无 live 观众的路径）。MEDIA_MCP
// is the admin/default instance (global media dir, 'admin' gen key).

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import * as vertexMedia from '@bridge/core/vertex-media.mjs';
import { buildMediaTools } from './media-tools.mjs';
import { getCurrentGen, genEmit } from '@bridge/core/runtime/gen.mjs';
import { admitUsage } from '@bridge/core/runtime/quota.mjs';
import { VERTEX_PROJECT, VERTEX_LOCATION, VERTEX_MEDIA_LOCATION, GEMINI_API_KEY } from '@bridge/core/config/index.mjs';

function makeAdapter({ mediaDir, genKey, getGen }) {
  return {
    newId: () => vertexMedia.newId(),
    // mediaDir undefined -> vertexMedia defaults to the global/admin media dir.
    save: (id, bytes, ext, meta) => {
      vertexMedia.save(id, bytes, ext, meta, mediaDir);
      return vertexMedia.mediaPath(id, ext, mediaDir);
    },
    emit: (ev) => {
      const gen = (getGen && getGen()) || getCurrentGen(genKey);
      if (!gen) return;
      // The served URL lets the page render the artifact inline; the media-serve
      // route resolves it from the SAME caller's media dir.
      if (ev.type === 'gen_media' && ev.id) ev.url = '/api/vertex/media?id=' + ev.id;
      genEmit(gen, ev);
    },
    resultText: (kind, info) => {
      if (kind === 'image') return '已生成图片并展示给用户（' + info.model + (info.isImagen ? '' : ' · ' + info.imageSize) + ' · ' + info.aspectRatio + (info.thinkingLevel ? ' · 思考 ' + info.thinkingLevel : '') + '）。绝对文件路径（可用 Read 查看，或 Bash 复制进项目当素材）：' + info.file;
      if (kind === 'video') return '已生成视频并展示给用户（' + info.model + ' · ' + info.resolution + ' · ' + info.aspectRatio + ' · ' + info.durationSeconds + 's）。绝对文件路径：' + info.file;
      if (kind === 'audio') return '已生成语音并展示给用户。绝对文件路径：' + info.file;
      if (kind === 'music') return '已生成音乐并展示给用户。绝对文件路径：' + info.file;
      return '已生成。绝对文件路径：' + info.file;
    },
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
// ctx 不传（管理员 / 桌面 stdio 版）= 不限。
const MEDIA_KIND = { generate_video: 'video' };
function guarded(t, ctx) {
  if (!ctx) return t.handler;
  return async (args, extra) => {
    const block = admitUsage(ctx, MEDIA_KIND[t.name] || 'media');
    if (block) return { isError: true, content: [{ type: 'text', text: block.title + '：' + block.message }] };
    return t.handler(args, extra);
  };
}

// Build a media MCP scoped to one caller. mediaDir=undefined + genKey='admin' is
// the admin/default flavor.
export function makeMediaMcp({ mediaDir, genKey = 'admin', getGen, ctx = null } = {}) {
  return createSdkMcpServer({
    name: 'media',
    version: '1.0.0',
    tools: buildMediaTools({
      flavor: 'phone',
      adapter: makeAdapter({ mediaDir, genKey, getGen }),
      // getter：设置页改了 Vertex 配置即时生效，常驻的 MEDIA_MCP 也读到新值
      loc: { get project() { return VERTEX_PROJECT; }, get globalLoc() { return VERTEX_LOCATION; }, get mediaLoc() { return VERTEX_MEDIA_LOCATION; }, get apiKey() { return GEMINI_API_KEY; } },
    }).map((t) => tool(t.name, t.description, t.schema, guarded(t, ctx))),
  });
}

export const MEDIA_MCP = makeMediaMcp({ genKey: 'admin' });
