// GET /api/tool-image?sid=<会话>&t=<tool_use_id>&n=<序号>[&v=thumb]
// 状态行缩略图条的取图端点（见 runtime/tool-images.mjs）。鉴权与 /api/session 同（含聊天快照访客）：
// 先确认该身份能定位到这个会话的 transcript，再按身份自己的 media 目录取缓存；缓存没有就从 transcript 现取。

import { requireCtx } from '../runtime/identity.mjs';
import { mimeType, streamFile } from '../runtime/http-file.mjs';
import { toolImageFile, toolImageThumb, TOOL_ID_RE } from '../runtime/tool-images.mjs';
import { locateSession } from './sessions.mjs';

function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }

export function registerToolImageRoutes(router, { identify }) {
  router.on('GET', '/api/tool-image', async (req, res, url) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return;
    const sid = url.searchParams.get('sid') || '';
    const t = url.searchParams.get('t') || '';
    const n = Number(url.searchParams.get('n') || 0);
    if (!TOOL_ID_RE.test(t) || !Number.isInteger(n)) return notFound(res);
    const p = await locateSession(ctx, sid);
    if (!p || !ctx.media) return notFound(res);
    const file = await toolImageFile(ctx.media, t, n, p.file);
    if (!file) return notFound(res);
    const thumb = url.searchParams.get('v') === 'thumb' ? await toolImageThumb(file) : null;
    try {
      // 内容随 tool_use_id 不变 → 长缓存
      streamFile(req, res, thumb || file, { contentType: thumb ? 'image/webp' : mimeType(file), cacheControl: 'private, max-age=31536000, immutable', range: false });
    } catch { notFound(res); }
  });
}
