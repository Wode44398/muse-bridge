// File-upload routes, per-identity. Each upload lands in the caller's own uploads
// dir (admin -> ROOT/uploads; user -> their .bridge/uploads), so attachments never
// cross between accounts. Two flavors:
//   /api/upload         single-shot JSON body with base64 data (capped at 20MB)
//   /api/upload-chunk   chunked streamed binary body (survives big videos)

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createWriteStream, createReadStream, existsSync, renameSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { readBody } from '../runtime/body.mjs';
import { sanitizeName, sweepStaleParts } from '../runtime/paths.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { imageThumb, THUMB_EXT, THUMB_TIERS } from './file-preview.mjs';

const MAX_UPLOAD = 2_000_000_000; // 2 GB
function validUploadId(s) { return /^[a-zA-Z0-9]{6,40}$/.test(s); }

// 「挂载文件夹」用：把客户端给的相对路径重建在 root 之下。逐段清洗（丢掉空/.、..、
// 盘符段并过 sanitizeName），再用 startsWith 兜底——按构造就穿越不出去。
// 返回 { dir, file } 绝对路径；越界返回 null。
function safeRelPath(root, rel) {
  const base = path.resolve(root);
  const parts = String(rel || '').split(/[\\/]+/)
    .filter((p) => p && p !== '.' && p !== '..' && !/^[a-zA-Z]:$/.test(p))
    .map((p) => sanitizeName(p));
  if (!parts.length) return null;
  const file = path.resolve(base, ...parts);
  if (!file.startsWith(base + path.sep)) return null;
  return { dir: path.dirname(file), file };
}

// 回读用附件 → content-type（历史会话重开时 <img> 显示已发送的图片）。
const RAW_CT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8' };

export function registerUploadRoutes(router, { authOk, identify }) {
  // share = 公开只读分享身份，上传属写操作，与 requireCtx 同则一律 401（否则任何拿到
  // /w/ 链接的人都能往桶里灌 2GB/次）。snap 快照身份可写（聊天附件要传），保留。
  const ctxOf = (req) => { const id = identify(req); return id.kind === 'none' || id.kind === 'share' ? null : contextFor(id); };

  router.on('POST', '/api/upload', async (req, res) => {
    const ctx = ctxOf(req);
    if (!ctx) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    let parsed;
    try { parsed = JSON.parse(await readBody(req, 27_000_000)); }  // 收紧到 ~20MB 文件的 base64 上限，少缓冲一截内存
    catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return; }
    const buf = Buffer.from(String(parsed.dataBase64 || ''), 'base64');
    if (!buf.length) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('empty file'); return; }
    if (buf.length > 20_000_000) { res.writeHead(413, { 'Content-Type': 'text/plain' }); res.end('file too large (max 20MB)'); return; }
    try { mkdirSync(ctx.uploads, { recursive: true }); } catch {}
    const name = sanitizeName(parsed.name);
    const dest = path.join(ctx.uploads, Date.now() + '-' + name);
    await writeFile(dest, buf);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: dest, name }));
  });

  // GET /api/upload/raw?name=<存盘文件名>[&thumb=1|preview] —— 回读调用者自己上传过的附件，
  // 供历史会话重开时 <img> 显示。name = 上传时的存盘名（Date.now()-原名）；守卫强制落在
  // 本人 uploads 内，防目录穿越。跨源 <img> 带不了 Authorization 头，靠 ?token=
  // （见 auth.mjs QTOKEN_PATHS 白名单）。
  //
  // thumb= 与 /api/file 同语义（1=320px / preview=1280px 的 webp，共用 thumb-cache）：
  // 聊天气泡里的图此前一律拉原图，uploads 里实际躺着 15.8MB 的截图和 7MB 的手机照片，
  // 手机翻旧会话时既费流量又爆内存。缩略图不可用（无 sharp / 格式不支持）时自动回落原图，
  // 故前端可以无条件带上 thumb=，不必判断服务端能力。
  router.on('GET', '/api/upload/raw', async (req, res, url) => {
    const ctx = ctxOf(req);
    if (!ctx) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const name = sanitizeName(url.searchParams.get('name') || '');
    const file = path.join(ctx.uploads, name);
    if (!path.resolve(file).startsWith(path.resolve(ctx.uploads) + path.sep) || !existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    const tier = THUMB_TIERS[url.searchParams.get('thumb')];
    if (tier && THUMB_EXT.has(ext)) {
      try {
        const thumb = await imageThumb(file, statSync(file), false, tier);
        if (thumb) {
          res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable' });
          pipeline(createReadStream(thumb), res, () => {});
          return;
        }
      } catch {}
    }
    let size = 0; try { size = statSync(file).size; } catch {}
    res.writeHead(200, { 'Content-Type': RAW_CT[ext] || 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'private, max-age=31536000, immutable' });
    pipeline(createReadStream(file), res, () => {});
  });

  // 「挂载文件夹」第一步：铸一个属于本次挂载的根目录（uploads/<时间戳>-<文件夹名>），
  // 后续每个文件用 upload-chunk?fdir=<返回的 dirName>&frel=<相对路径> 落进去。
  // 服务端铸名 = 客户端拿不到构造目录名的笔，穿越面只剩 frel（safeRelPath 逐段清洗）。
  router.on('POST', '/api/upload/folder', async (req, res) => {
    const ctx = ctxOf(req);
    if (!ctx) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    let parsed = {};
    try { parsed = JSON.parse(await readBody(req, 8000) || '{}'); } catch {}
    const name = sanitizeName(parsed.name || 'folder');
    const dirName = Date.now() + '-' + name;
    const dir = path.join(ctx.uploads, dirName);
    try { mkdirSync(dir, { recursive: true }); }
    catch { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('mkdir failed'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ dirName, path: dir, name }));
  });

  router.on('POST', '/api/upload-chunk', (req, res, url) => {
    const ctx = ctxOf(req);
    if (!ctx) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const id = url.searchParams.get('id') || '';
    const last = url.searchParams.get('last') === '1';
    if (!validUploadId(id)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad id'); return; }
    try { mkdirSync(ctx.uploads, { recursive: true }); } catch {}
    const part = path.join(ctx.uploads, '.part-' + id);
    let existing = 0; try { existing = statSync(part).size; } catch {}
    if (!existing) sweepStaleParts(ctx.uploads); // first chunk: clear any abandoned .part-* here
    if (existing > MAX_UPLOAD) { try { rmSync(part, { force: true }); } catch {} res.writeHead(413, { 'Content-Type': 'text/plain' }); res.end('too large'); return; }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared >= 0 && existing + declared > MAX_UPLOAD) {
      try { rmSync(part, { force: true }); } catch {}
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('too large');
      req.resume();
      return;
    }
    const ws = createWriteStream(part, { flags: 'a' });
    let received = 0, overflow = false;
    const cleanupPart = () => { try { rmSync(part, { force: true }); } catch {} };
    const rejectTooLarge = () => {
      if (overflow) return;
      overflow = true;
      req.unpipe(ws);
      ws.once('close', cleanupPart);
      try { ws.destroy(); } catch {}
      cleanupPart();
      if (!res.writableEnded) { res.writeHead(413, { 'Content-Type': 'text/plain' }); res.end('too large'); }
      req.resume(); // preserve the socket until the 413 has been delivered
    };
    req.on('data', (c) => { received += c.length; if (existing + received > MAX_UPLOAD) rejectTooLarge(); });
    req.on('error', () => { try { ws.destroy(); } catch {} });
    ws.on('error', () => {
      if (overflow) cleanupPart();
      else if (!res.writableEnded) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('write error'); }
    });
    ws.on('finish', () => {
      if (overflow) { cleanupPart(); return; }
      if (!last) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
      const name = sanitizeName(decodeURIComponent(url.searchParams.get('name') || 'file'));
      // 文件夹挂载：落进 uploads/<fdir>/<frel>（保留目录结构，Claude 才能按原样 Glob/Read）；
      // 否则维持老行为——平铺在 uploads 里、名字带时间戳前缀。
      const fdir = url.searchParams.get('fdir') || '';
      const frel = url.searchParams.get('frel') || '';
      let dest;
      if (fdir && frel) {
        const root = path.join(ctx.uploads, sanitizeName(fdir));
        const hit = root.startsWith(path.resolve(ctx.uploads) + path.sep) && existsSync(root)
          ? safeRelPath(root, decodeURIComponent(frel)) : null;
        if (!hit) { cleanupPart(); res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad folder path'); return; }
        try { mkdirSync(hit.dir, { recursive: true }); } catch {}
        dest = hit.file;
      } else {
        dest = path.join(ctx.uploads, Date.now() + '-' + name);
      }
      try { renameSync(part, dest); }
      catch { cleanupPart(); res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('finalize error'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: dest, name }));
    });
    req.pipe(ws);
  });
}
