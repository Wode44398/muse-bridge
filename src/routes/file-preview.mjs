import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
import {
  createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { requireReadCtx } from '../runtime/identity.mjs';
import { DATA_ROOT } from '../runtime/paths.mjs';
import { mimeType, safeJoin, streamFile } from '../runtime/http-file.mjs';
import { bad, scopeCtx } from './file-core.mjs';

const NATIVE = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'mp4', 'webm', 'mov',
  'm4v', 'mkv', 'avi', '3gp', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'pdf',
]);

const THUMB_CACHE = path.join(DATA_ROOT, 'thumb-cache');
try { mkdirSync(THUMB_CACHE, { recursive: true }); } catch {}
// 导出给 upload.mjs 复用：聊天附件（uploads/）此前只有原图一条路，手机上翻旧会话
// 要下载并解码几 MB~十几 MB 的原图（实测 uploads 里有 15.8MB 的 PNG），一张 4000px
// 的图解码进内存就是 30MB+ 的位图，滚过几张足以让 WebView 被系统回收重载。
export const THUMB_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg']);
export const THUMB_VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', '3gp']);
export const THUMB_TIERS = {
  '1': { size: 320, q: 72, tag: '' },
  preview: { size: 1280, q: 80, tag: '-prev' },
};
const thumbing = new Map();
const thumbFailures = new Set();
const MAX_THUMB_FAILURES = 512;

function rememberThumbFailure(key) {
  thumbFailures.add(key);
  while (thumbFailures.size > MAX_THUMB_FAILURES) {
    thumbFailures.delete(thumbFailures.values().next().value);
  }
}

function extractFrame(src, framePng) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-y', '-ss', '0.2', '-i', src, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", framePng],
      { windowsHide: true },
    );
    child.on('error', reject);
    child.stderr.on('data', () => {});
    child.on('close', (code) => (
      code === 0 && existsSync(framePng) ? resolve() : reject(new Error('ffmpeg exit ' + code))
    ));
  });
}

// 按 (路径|mtime|大小) 派生缓存键 → thumb-cache/<sha1><tier>.webp；同一文件并发只跑一次
// （thumbing 去重），失败进 thumbFailures 不再重试。工作空间与 uploads 共用这一套。
export async function imageThumb(file, stat, isVideo = false, tier = THUMB_TIERS['1']) {
  const key = crypto.createHash('sha1')
    .update(`${file}|${stat.mtimeMs}|${stat.size}`)
    .digest('hex') + tier.tag;
  const output = path.join(THUMB_CACHE, key + '.webp');
  if (existsSync(output)) return output;
  if (thumbFailures.has(key)) return null;
  if (thumbing.has(output)) return thumbing.get(output);
  const job = (async () => {
    const frameTmp = isVideo ? output + '.frame.png' : null;
    try {
      const sharp = (await import('sharp')).default;
      let input = file;
      if (isVideo) {
        await extractFrame(file, frameTmp);
        input = frameTmp;
      }
      let options;
      if (/\.svg$/i.test(file)) {
        try {
          const metadata = await sharp(file).metadata();
          const side = Math.max(metadata.width || tier.size, metadata.height || tier.size);
          if (side < tier.size) options = { density: Math.min(2400, Math.ceil(72 * tier.size / side)) };
        } catch {}
      }
      await sharp(input, options)
        .rotate()
        .resize(tier.size, tier.size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: tier.q })
        .toFile(output + '.tmp');
      renameSync(output + '.tmp', output);
      return output;
    } catch {
      try { rmSync(output + '.tmp', { force: true }); } catch {}
      rememberThumbFailure(key);
      return null;
    } finally {
      if (frameTmp) { try { rmSync(frameTmp, { force: true }); } catch {} }
      thumbing.delete(output);
    }
  })();
  thumbing.set(output, job);
  return job;
}

export async function handleFile(req, res, url, identify) {
  let ctx = requireReadCtx(identify, req, res);
  if (!ctx) return;
  ctx = scopeCtx(ctx, url.searchParams.get('ws'), res);
  if (!ctx) return;
  const file = safeJoin(ctx.cwd, url.searchParams.get('path') || '');
  if (!file) return bad(res, 403, 'forbidden');
  let stat;
  try { stat = statSync(file); } catch { return bad(res, 404, 'not found'); }
  if (stat.isDirectory()) return bad(res, 400, 'is a directory');
  const ext = path.extname(file).slice(1).toLowerCase();
  const contentType = mimeType(file, { safe: true });
  const tier = THUMB_TIERS[url.searchParams.get('thumb')];
  if (tier && (THUMB_EXT.has(ext) || THUMB_VIDEO_EXT.has(ext))) {
    const isVideo = THUMB_VIDEO_EXT.has(ext);
    try {
      const thumb = await imageThumb(file, stat, isVideo, tier);
      if (thumb) {
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400' });
        pipeline(createReadStream(thumb), res, () => {});
        return;
      }
    } catch {}
    if (isVideo) return bad(res, 404, 'no thumb');
  }
  const download = url.searchParams.get('dl') === '1'
    || (!NATIVE.has(ext) && contentType === 'application/octet-stream');
  streamFile(req, res, file, {
    stat,
    contentType,
    cacheControl: 'private, max-age=30',
    highWaterMark: 1 << 20,
    ...(download ? { downloadName: path.basename(file), download: true } : {}),
  });
}

const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
const OFFICE_CACHE = path.join(DATA_ROOT, 'office-cache');
try { mkdirSync(OFFICE_CACHE, { recursive: true }); } catch {}

let sofficePath;
function findSoffice() {
  if (sofficePath !== undefined) return sofficePath;
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/opt/libreoffice/program/soffice',
  ];
  sofficePath = candidates.find((candidate) => existsSync(candidate)) || null;
  return sofficePath;
}

const officeJobs = new Map();
async function convertOffice(src, outPdf) {
  const soffice = findSoffice();
  if (!soffice) throw new Error('LibreOffice 未安装');
  const tmp = path.join(OFFICE_CACHE, 'tmp-' + crypto.randomBytes(6).toString('hex'));
  mkdirSync(tmp, { recursive: true });
  const profile = 'file:///' + path.join(os.tmpdir(), 'lo-prof-' + crypto.randomBytes(4).toString('hex')).replace(/\\/g, '/');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(soffice, [
        '--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf',
        '--outdir', tmp, src, '-env:UserInstallation=' + profile,
      ], { windowsHide: true });
      let errorOutput = '';
      child.stderr.on('data', (data) => { errorOutput += data; });
      child.on('error', reject);
      child.on('close', (code) => (
        code === 0
          ? resolve()
          : reject(new Error(`soffice exit ${code} ${errorOutput.slice(0, 160)}`))
      ));
    });
    const produced = path.join(tmp, path.basename(src, path.extname(src)) + '.pdf');
    if (!existsSync(produced)) throw new Error('未产出 PDF');
    renameSync(produced, outPdf);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

export async function handleOfficePdf(req, res, url, identify) {
  let ctx = requireReadCtx(identify, req, res);
  if (!ctx) return;
  ctx = scopeCtx(ctx, url.searchParams.get('ws'), res);
  if (!ctx) return;
  const file = safeJoin(ctx.cwd, url.searchParams.get('path') || '');
  if (!file) return bad(res, 403, 'forbidden');
  let stat;
  try { stat = statSync(file); } catch { return bad(res, 404, 'not found'); }
  if (stat.isDirectory()) return bad(res, 400, 'is a directory');
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!OFFICE_EXT.has(ext)) return bad(res, 415, 'not an office file');
  const key = crypto.createHash('sha1')
    .update(`${file}|${stat.mtimeMs}|${stat.size}`)
    .digest('hex');
  const outPdf = path.join(OFFICE_CACHE, key + '.pdf');
  try {
    if (!existsSync(outPdf)) {
      let job = officeJobs.get(outPdf);
      if (!job) {
        job = convertOffice(file, outPdf).finally(() => officeJobs.delete(outPdf));
        officeJobs.set(outPdf, job);
      }
      await job;
    }
  } catch (error) {
    return bad(res, 503, 'office convert unavailable: ' + String(error?.message || error).slice(0, 120));
  }
  streamFile(req, res, outPdf, {
    contentType: 'application/pdf',
    cacheControl: 'private, max-age=3600',
  });
}
