// 媒体产物的只读服务 GET /api/vertex/media——核心件，不属于 Vertex 扩展。
//
// 生成（花钱）归 Vertex 扩展；但 Claude 的聊天记录、手机操控的 gen_media 事件、控制台都在
// 引用这些已落盘的图/视频/音频。Vertex 没装或被卸载时，历史媒体照样要能显示，所以「按 id
// 取文件」留在核心（路径名沿用 /api/vertex/media，历史消息里存的就是这个链接）。
//
// Multi-user: 文件只在调用者自己的 media 目录里找（admin -> ROOT/media；user -> .bridge/media）。

import path from 'node:path';
import { pipeline } from 'node:stream';
import { createReadStream } from 'node:fs';
import * as vertexMedia from '../vertex-media.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { mimeType, streamFile } from '../runtime/http-file.mjs';

const RANGE_EXT = new Set(['mp4', 'wav', 'mp3']);

// 把已定位的媒体文件流式发出（图片整发；视频/音频带 Range 206）。供普通端点与 admin 跨用户端点共用。
// 一律走 stream.pipeline：裸 pipe 在读流出错（文件被删/IO 错）时没人接 error 事件会
// 崩掉整个进程；客户端中断（拖视频进度条）也不会销毁源流、泄漏 fd。
export function serveMediaFile(req, res, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  streamFile(req, res, file, {
    contentType: mimeType(file),
    cacheControl: 'private, max-age=86400',
    range: RANGE_EXT.has(ext),
  });
}

async function handleMediaFile(req, res, url, identify) {
  const ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  const id = url.searchParams.get('id') || '';
  const file = vertexMedia.fileFor(id, ctx.media);
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  // ?v=thumb|preview：图像走 sharp 衍生图（320px 网格 / 1280px 对话流）——4K 原图单张 ~20MB，
  // 历史网格 28 张会瞬间拉垮手机。生成失败/非图像类型回退原图。内容随 id 不可变 → immutable 缓存。
  const variant = url.searchParams.get('v');
  if (variant === 'thumb' || variant === 'preview') {
    try {
      const d = await vertexMedia.derivedFor(id, ctx.media, variant);
      if (d) {
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable' });
        pipeline(createReadStream(d), res, () => {});
        return;
      }
    } catch {}
  }
  serveMediaFile(req, res, file);
}

export function registerMediaFileRoutes(router, { identify }) {
  router.on('GET', '/api/vertex/media', (req, res, url) => handleMediaFile(req, res, url, identify));
}
