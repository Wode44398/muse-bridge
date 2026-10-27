// 上传壁纸管理。上传壁纸存进【工作空间】的可见文件夹（WALLPAPER_DIR，默认「壁纸」）：
// 原图 <id>.<ext>、清单 index.json；上传时可附一张深度图（白=近、黑=远）存 <id>.depth.<ext>，
// 有深度图的才提供空间壁纸。服务端不再生成深度（只有内置默认壁纸带随包预生成的深度图）。
// 所有路径都在 ctx.cwd 沙箱内，且 id 由服务端生成（非用户输入）、清单里查得到才写，无遍历风险；
// 鉴权沿用 requireCtx（cookie/Bearer）。
import path from 'node:path';
import { createWriteStream, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { writeFile, rename, rm } from 'node:fs/promises';
import crypto from 'node:crypto';
import { requireCtx } from '../runtime/identity.mjs';
import { readBody } from '../runtime/body.mjs';
import { WALLPAPER_DIR } from '../config/index.mjs';

const bad = (res, code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
const okJson = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const MAX_WP = 40_000_000;   // 40MB 单张封顶（前端已降采样，正常 ≤2MB）
const OK_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);

function wpDir(ctx) { const d = path.join(ctx.cwd, WALLPAPER_DIR); try { mkdirSync(d, { recursive: true }); } catch {} return d; }
function manifestPath(dir) { return path.join(dir, 'index.json'); }
function readManifest(dir) {
  try {
    const m = JSON.parse(readFileSync(manifestPath(dir), 'utf8'));
    if (!m || !Array.isArray(m.items)) throw new Error('invalid manifest shape');
    return m;
  } catch (e) {
    if (e?.code === 'ENOENT') return { items: [] };
    // Never turn a corrupt manifest into an empty one and then overwrite it:
    // that makes every existing wallpaper disappear from the user's library.
    throw Object.assign(new Error('wallpaper manifest is corrupt'), { cause: e });
  }
}

// Per-workspace serialization makes every manifest mutation one read-modify-write
// transaction. The final rename is same-directory atomic, so a crash can leave
// either the old or new JSON but never a half-written manifest.
const manifestLocks = new Map();
async function withManifestLock(dir, fn) {
  const prev = manifestLocks.get(dir) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  manifestLocks.set(dir, turn);
  await prev.catch(() => {});
  try { return await fn(); }
  finally {
    release();
    if (manifestLocks.get(dir) === turn) manifestLocks.delete(dir);
  }
}
async function writeManifest(dir, m) {
  const dest = manifestPath(dir);
  const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, JSON.stringify(m, null, 2));
    await rename(tmp, dest);
  } catch (e) {
    try { await rm(tmp, { force: true }); } catch {}
    throw e;
  }
}
async function updateManifest(dir, mutate) {
  return withManifestLock(dir, async () => {
    const m = readManifest(dir);
    const result = await mutate(m);
    await writeManifest(dir, m);
    return result;
  });
}
// 对外条目：file/depthFile 是相对工作空间根的 rel 路径，前端用 cloudFileUrl() 拼成 /api/file URL。
function pubItem(it) {
  const rel = (f) => WALLPAPER_DIR + '/' + f;
  return {
    id: it.id, name: it.name, sys: it.sys === 'dark' ? 'dark' : 'light', hasDepth: !!it.hasDepth,
    file: rel(it.id + '.' + it.ext),
    depthFile: it.hasDepth ? rel(depthName(it)) : null,
  };
}
// 老条目（服务端 V2 生成的）没有 depthExt，一律是 png
const depthName = (it) => it.id + '.depth.' + (it.depthExt || 'png');
const extOf = (name) => {
  const ext = (path.extname(name).slice(1) || 'jpg').toLowerCase();
  return OK_EXT.has(ext) ? ext : 'jpg';
};

function handleList(req, res, identify) {
  const ctx = requireCtx(identify, req, res); if (!ctx) return;
  let m;
  try { m = readManifest(wpDir(ctx)); } catch { return bad(res, 500, 'manifest read error'); }
  okJson(res, { items: m.items.map(pubItem) });
}

// raw body 落盘到 dest（MAX_WP 封顶，超限/出错自清理并回错误）；写完调 onDone(cleanupDest)。
function receiveRaw(req, res, dest, onDone) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared >= 0 && declared > MAX_WP) {
    bad(res, 413, 'too large');
    req.resume();
    return;
  }
  const ws = createWriteStream(dest);
  let received = 0, overflow = false;
  const cleanupDest = () => { try { rmSync(dest, { force: true }); } catch {} };
  const rejectTooLarge = () => {
    if (overflow) return;
    overflow = true;
    req.unpipe(ws);
    ws.once('close', cleanupDest);
    try { ws.destroy(); } catch {}
    cleanupDest();
    if (!res.writableEnded) bad(res, 413, 'too large');
    req.resume();
  };
  req.on('data', (c) => { received += c.length; if (received > MAX_WP) rejectTooLarge(); });
  req.on('error', () => { try { ws.destroy(); } catch {} });
  ws.on('error', () => { if (overflow) cleanupDest(); else if (!res.writableEnded) bad(res, 500, 'write error'); });
  ws.on('finish', () => {
    if (overflow) { cleanupDest(); return; }
    onDone(cleanupDest);
  });
  req.pipe(ws);
}

// 直传原图（raw body）→ 工作空间 壁纸/<id>.<ext> + 入清单。?name=原文件名 &sys=light|dark
function handleUpload(req, res, url, identify) {
  const ctx = requireCtx(identify, req, res); if (!ctx) return;
  const dir = wpDir(ctx);
  const orig = decodeURIComponent(url.searchParams.get('name') || 'image.jpg');
  const ext = extOf(orig);
  const sys = url.searchParams.get('sys') === 'dark' ? 'dark' : 'light';
  const id = 'up-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  receiveRaw(req, res, path.join(dir, id + '.' + ext), async (cleanupDest) => {
    const title = orig.replace(/\.[^.]+$/, '').slice(0, 40) || '我的壁纸';
    const it = { id, name: title, ext, sys, hasDepth: false, ts: Date.now() };
    try {
      await updateManifest(dir, (m) => { m.items.push(it); });
      okJson(res, { ok: true, item: pubItem(it) });
    } catch {
      cleanupDest();
      if (!res.writableEnded) bad(res, 500, 'manifest write error');
    }
  });
}

// 给已上传壁纸附深度图（raw body）→ 壁纸/<id>.depth.<ext>，清单标 hasDepth。?id= &name=原文件名
function handleDepth(req, res, url, identify) {
  const ctx = requireCtx(identify, req, res); if (!ctx) return;
  const dir = wpDir(ctx);
  const id = url.searchParams.get('id') || '';
  let it;
  try { it = readManifest(dir).items.find((x) => x.id === id); }
  catch { req.resume(); return bad(res, 500, 'manifest read error'); }
  if (!it) { req.resume(); return bad(res, 404, 'no such wallpaper'); }
  const depthExt = extOf(decodeURIComponent(url.searchParams.get('name') || 'depth.png'));
  const tmp = path.join(dir, `${id}.depth-${crypto.randomBytes(4).toString('hex')}.tmp`);
  receiveRaw(req, res, tmp, async (cleanupDest) => {
    try {
      const updated = await updateManifest(dir, async (m) => {
        const live = m.items.find((x) => x.id === id);
        if (!live) throw Object.assign(new Error('deleted'), { status: 404 });
        // 换了格式的旧深度图先清掉，再把临时文件挪成正式名
        if (live.hasDepth && (live.depthExt || 'png') !== depthExt) await rm(path.join(dir, depthName(live)), { force: true });
        await rename(tmp, path.join(dir, depthName({ id, depthExt })));
        live.hasDepth = true; live.depthExt = depthExt;
        return { ...live };
      });
      okJson(res, { ok: true, item: pubItem(updated) });
    } catch (e) {
      cleanupDest();
      if (!res.writableEnded) bad(res, e?.status || 500, e?.status === 404 ? 'wallpaper was deleted' : 'depth write error');
    }
  });
}

async function handleDelete(req, res, identify) {
  const ctx = requireCtx(identify, req, res); if (!ctx) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  const dir = wpDir(ctx);
  let it;
  try {
    it = await updateManifest(dir, (m) => {
      const idx = m.items.findIndex((x) => x.id === body.id);
      if (idx < 0) throw Object.assign(new Error('not found'), { status: 404 });
      return m.items.splice(idx, 1)[0];
    });
  } catch (e) { return bad(res, e?.status || 500, e?.status === 404 ? 'not found' : 'manifest write error'); }
  try { rmSync(path.join(dir, it.id + '.' + it.ext), { force: true }); } catch {}
  if (it.hasDepth) try { rmSync(path.join(dir, depthName(it)), { force: true }); } catch {}
  okJson(res, { ok: true });
}

export function registerWallpaperRoutes(router, { identify }) {
  router.on('GET', '/api/wallpaper/list', (req, res) => handleList(req, res, identify));
  router.on('POST', '/api/wallpaper/upload', (req, res, url) => handleUpload(req, res, url, identify));
  router.on('POST', '/api/wallpaper/depth', (req, res, url) => handleDepth(req, res, url, identify));
  router.on('POST', '/api/wallpaper/delete', (req, res) => handleDelete(req, res, identify));
}
