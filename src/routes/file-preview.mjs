import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream';
import {
  createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { requireReadCtx } from '../runtime/identity.mjs';
import { DATA_ROOT } from '../runtime/paths.mjs';
import { mimeType, safeJoin, streamFile } from '../runtime/http-file.mjs';
import { bad, scopeCtx } from './file-core.mjs';
import { isHtmlFile, respondHtmlSite } from '../runtime/html-site.mjs';
import {
  HEIF_EXT, LIST_THUMB_EXT, dropWorkDir, makeWorkDir, needsRaster, quickGate, rasterize, runTool,
} from './file-thumb.mjs';

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
// grid：文件列表的大图标 / 图标视图（手机两三列、电脑大图标），320 铺满方格裁切后发虚
export const THUMB_TIERS = {
  '1': { size: 320, q: 72, tag: '' },
  grid: { size: 640, q: 74, tag: '-grid' },
  preview: { size: 1280, q: 80, tag: '-prev' },
};
// 列表档（1 / grid）：多支持 gif 首帧、heic、tif、pdf / Office 首页、音频封面（见 file-thumb.mjs），
// 生成不了一律 404，前端回落类型图标；preview 档保持原样（失败回原图，图片查看器靠它兜底）
const LIST_TIERS = new Set(['1', 'grid']);
const thumbing = new Map();
const thumbFailures = new Set();
const MAX_THUMB_FAILURES = 512;

function rememberThumbFailure(key) {
  thumbFailures.add(key);
  while (thumbFailures.size > MAX_THUMB_FAILURES) {
    thumbFailures.delete(thumbFailures.values().next().value);
  }
}

// 视频抽一帧：并发上限与超时同 file-thumb.mjs 的外部进程（一屏几十个视频不会同时拉起几十个 ffmpeg）
async function extractFrame(src, framePng) {
  await quickGate(() => runTool(
    'ffmpeg',
    ['-y', '-ss', '0.2', '-i', src, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", framePng],
  ));
  if (!existsSync(framePng)) throw new Error('ffmpeg no frame');
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
    const ext = path.extname(file).slice(1).toLowerCase();
    let work = null;
    try {
      const sharp = (await import('sharp')).default;
      let input = file;
      if (isVideo) {
        await extractFrame(file, frameTmp);
        input = frameTmp;
      } else if (needsRaster(ext)) {
        work = makeWorkDir();
        input = await rasterize(file, ext, work, { size: tier.size, stat });
      }
      let options;
      if (/\.svg$/i.test(file)) {
        try {
          const metadata = await sharp(file).metadata();
          const side = Math.max(metadata.width || tier.size, metadata.height || tier.size);
          if (side < tier.size) options = { density: Math.min(2400, Math.ceil(72 * tier.size / side)) };
        } catch {}
      }
      // sharp 对 gif / 动 webp 默认只解第一帧 → 首帧静态图
      const encode = (src) => sharp(src, options)
        .rotate()
        .resize(tier.size, tier.size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: tier.q })
        .toFile(output + '.tmp');
      try {
        await encode(input);
      } catch (error) {
        // heic / avif：这台机器的 sharp 解不了（编解码器缺失）就让 ffmpeg 先转成 png
        if (!HEIF_EXT.has(ext) || work) throw error;
        work = makeWorkDir();
        await encode(await rasterize(file, ext, work, { size: tier.size, stat }));
      }
      renameSync(output + '.tmp', output);
      return output;
    } catch {
      try { rmSync(output + '.tmp', { force: true }); } catch {}
      rememberThumbFailure(key);
      return null;
    } finally {
      if (frameTmp) { try { rmSync(frameTmp, { force: true }); } catch {} }
      dropWorkDir(work);
      thumbing.delete(output);
    }
  })();
  thumbing.set(output, job);
  return job;
}

// —— 画廊放大用：max 档 + 原图区域块（「原图加载」关着时；开着前端直接要原图，这里不参与）——
//   · &thumb=max：原图 ≤16.7MP（或 sharp 读不了）就回原字节；超了等比缩到 ≤16.7MP（不透明 jpeg / 带透明 webp），X-Bridge-Downscaled 标原尺寸
//   · &region=x,y,w,h&w=目标宽：显示方向（EXIF 转正后）的原图矩形 → 映射回未转正的原始坐标先裁、再转正、再缩到目标宽
//   两样都进 thumb-cache（键含 mtime / 大小），同一产物并发只算一次；失败的区域块 404（前端停在 max 档）
const SAFE_PIXELS = 4096 * 4096;
const ZOOM_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'tif', 'tiff']);
const zoomJobs = new Map();
function zoomJob(key, make) {
  for (const e of ['.jpg', '.webp']) { const f = path.join(THUMB_CACHE, key + e); if (existsSync(f)) return Promise.resolve(f); }
  if (zoomJobs.has(key)) return zoomJobs.get(key);
  const job = (async () => {
    let tmp = '';
    try {
      const { pipe, alpha } = await make();
      if (!pipe) return null;
      const out = path.join(THUMB_CACHE, key + (alpha ? '.webp' : '.jpg'));
      tmp = out + '.tmp';
      await (alpha ? pipe.webp({ quality: 84 }) : pipe.jpeg({ quality: 86 })).toFile(tmp);
      renameSync(tmp, out);
      return out;
    } catch {
      if (tmp) { try { rmSync(tmp, { force: true }); } catch {} }
      return null;
    } finally { zoomJobs.delete(key); }
  })();
  zoomJobs.set(key, job);
  return job;
}
const zoomKey = (file, stat, id) => crypto.createHash('sha1').update(`${file}|${stat.mtimeMs}|${stat.size}|${id}`).digest('hex') + '-z';
/** max 档：null = 用原图（不超上限 / 读不了）；否则 { file, downscaled } */
async function imageMax(file, stat, ext) {
  if (!ZOOM_EXT.has(ext)) return null;
  const sharp = (await import('sharp')).default;
  let m;
  try { m = await sharp(file).metadata(); } catch { return null; }
  const W = m.width || 0, H = m.height || 0;
  if (!W || !H || W * H <= SAFE_PIXELS) return null;
  const L = Math.max(1, Math.floor(Math.max(W, H) * Math.sqrt(SAFE_PIXELS / (W * H))));
  const out = await zoomJob(zoomKey(file, stat, 'max'), async () => ({
    pipe: sharp(file, { animated: false }).rotate().resize(L, L, { fit: 'inside', withoutEnlargement: true }), alpha: !!m.hasAlpha,
  }));
  return out ? { file: out, downscaled: W + 'x' + H } : null;
}
/** EXIF 方向 o 下，显示方向矩形 [x0,y0)-[x1,y1) 对应的未转正原始矩形（W×H 是原始宽高）。同安卓 LocalMedia.rawRect */
function rawRect(o, W, H, x0, y0, x1, y1) {
  const a = {
    2: [W - x0, y0, W - x1, y1], 3: [W - x0, H - y0, W - x1, H - y1], 4: [x0, H - y0, x1, H - y1],
    5: [y0, x0, y1, x1], 6: [y0, H - x0, y1, H - x1], 7: [W - y0, H - x0, W - y1, H - x1], 8: [W - y0, x0, W - y1, x1],
  }[o] || [x0, y0, x1, y1];
  return { left: Math.min(a[0], a[2]), top: Math.min(a[1], a[3]), width: Math.abs(a[2] - a[0]), height: Math.abs(a[3] - a[1]) };
}
async function imageRegion(file, stat, ext, q, wq) {
  if (!ZOOM_EXT.has(ext)) return null;
  const p = String(q).split(',').map((v) => Number.parseInt(v, 10));
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
  const [x, y, w, h] = p;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || h > w * 8 || w > h * 8) return null;
  let tw = Number.parseInt(wq, 10);
  if (!(tw > 0) || tw > w) tw = w;
  if (tw > 2048) return null;   // 一块输出宽上限（前端一块 1024 设备像素）
  const sharp = (await import('sharp')).default;
  return zoomJob(zoomKey(file, stat, `r${x}_${y}_${w}_${h}_${tw}`), async () => {
    const m = await sharp(file).metadata();
    const o = m.orientation || 1, W = m.width || 0, H = m.height || 0;
    const dW = o >= 5 ? H : W, dH = o >= 5 ? W : H;
    const x0 = Math.min(x, dW), y0 = Math.min(y, dH), x1 = Math.min(x + w, dW), y1 = Math.min(y + h, dH);
    if (x1 - x0 < 1 || y1 - y0 < 1) return { pipe: null };
    const outW = Math.max(1, Math.round((tw * (x1 - x0)) / w));
    // extract 写在 rotate 前 = 先在原始坐标上裁、再按 EXIF 转正（与「整图转正后再裁」逐像素一致）
    let pipe = sharp(file, { animated: false }).extract(rawRect(o, W, H, x0, y0, x1, y1)).rotate();
    if (outW < x1 - x0) pipe = pipe.resize({ width: outW });
    return { pipe, alpha: !!m.hasAlpha };
  });
}
const zoomType = (f) => (f.endsWith('.webp') ? 'image/webp' : 'image/jpeg');

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
  // HtmlView：挂成路径式站点，相对引用的 js/css/资源才解析得到（见 runtime/html-site.mjs）。
  if (url.searchParams.get('site') === '1' && isHtmlFile(file)) return respondHtmlSite(res, file, [ctx.cwd]);
  const ext = path.extname(file).slice(1).toLowerCase();
  const contentType = mimeType(file, { safe: true });
  const tierName = url.searchParams.get('thumb');
  const region = url.searchParams.get('region');
  if (region != null) {
    let out = null;
    try { out = await imageRegion(file, stat, ext, region, url.searchParams.get('w')); } catch {}
    if (res.destroyed) return;
    if (!out) return bad(res, 404, 'no region');
    res.writeHead(200, { 'Content-Type': zoomType(out), 'Cache-Control': 'private, max-age=86400', 'X-Bridge-Tier': 'region' });
    pipeline(createReadStream(out), res, () => {});
    return;
  }
  if (tierName === 'max') {
    let mx = null;
    try { mx = await imageMax(file, stat, ext); } catch {}
    if (res.destroyed) return;
    if (mx) {
      res.writeHead(200, { 'Content-Type': zoomType(mx.file), 'Cache-Control': 'private, max-age=86400', 'X-Bridge-Tier': 'max', 'X-Bridge-Downscaled': mx.downscaled });
      pipeline(createReadStream(mx.file), res, () => {});
      return;
    }
    // 不超上限 / 读不了：落到下面回原字节（max 档就是原图本身）
  }
  const tier = THUMB_TIERS[tierName];
  const listTier = LIST_TIERS.has(tierName);
  if (tier && (THUMB_EXT.has(ext) || THUMB_VIDEO_EXT.has(ext) || (listTier && LIST_THUMB_EXT.has(ext)))) {
    const isVideo = THUMB_VIDEO_EXT.has(ext);
    let thumb = null;
    try { thumb = await imageThumb(file, stat, isVideo, tier); } catch {}
    // 生成缩略图要时间，期间客户端可能已经走了（画廊快翻、预载器取消）：连接已断就别写。
    // 以前写头和 pipeline 包在同一个 try 里——对已断的连接 pipeline 同步抛错被吞掉，又落到下面 streamFile 再写一次头，
    // 抛 ERR_HTTP_HEADERS_SENT；路由兜底再写 500 又抛一次成了 unhandledRejection，60 秒里攒满 5 次进程就自杀。
    if (res.destroyed) return;
    if (thumb) {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400' });
      pipeline(createReadStream(thumb), res, () => {});
      return;
    }
    if (isVideo || listTier) return bad(res, 404, 'no thumb');
  } else if (listTier) {
    return bad(res, 404, 'no thumb');
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

// —— Office → PDF（LibreOffice 无头转换）——
// 文档 / 演示类（doc docx ppt pptx odt odp rtf，表格 xls xlsx ods 也认）由 soffice 转成 PDF，前端用 PdfView 像素级显示。
//   · 缓存：office-cache/<sha1(路径|mtime|大小)>.pdf，文件没改就直接给；转换用的 tmp-* 目录与 lo-prof-* 配置目录用完即删。
//   · 并发上限（缺省 2，BRIDGE_OFFICE_CONCURRENCY）+ 先来先转的队列：一下子点开十个 docx 也只有两个 soffice 在跑。
//   · 超时（缺省 90 秒，BRIDGE_OFFICE_TIMEOUT_MS）按【进程树】收掉：soffice.exe 只是个壳，真干活的是它拉起的 soffice.bin，
//     只 kill 直接子进程会留下孤儿。bridge 退出时还在转的也一并收掉。
//   · 失败记 5 分钟：坏文件不会每次打开都再烧一遍 90 秒；?retry=1 强制重试。
//   · ?status=1：不等转换，立刻回 JSON { state: ready|queued|converting|busy|failed|unavailable, ms, ahead, error }，
//     顺便把转换排上队——前端据此显示「正在转换 · 已用 x 秒」「排队中 · 前面还有 n 个」，转好了再来取 PDF。
//     不带 status 的老调用照旧：等转换完成后直接回 PDF（或 503）。
//   · 排队有上限（缺省 32，BRIDGE_OFFICE_QUEUE_MAX）：满了不再收新文件——status=1 回 busy（前端当排队、隔几秒再问），
//     直接取 PDF 的回 503 + Retry-After。没有上限时一口气点开几百个文档（或分享访客刷接口）会把队列和磁盘临时目录一路堆上去。
//   · 没人等的不转：排队期间既没有直接取 PDF 的请求挂着、又超过 90 秒没人来问状态（查看器早关了），轮到它时直接丢掉；
//     之后再打开会重新排队。已经开始转的照常转完（结果进缓存，下次秒开）。
const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
const OFFICE_CACHE = path.join(DATA_ROOT, 'office-cache');
try { mkdirSync(OFFICE_CACHE, { recursive: true }); } catch {}
const OFFICE_TIMEOUT_MS = Math.max(10_000, Number(process.env.BRIDGE_OFFICE_TIMEOUT_MS) || 90_000);
const OFFICE_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.BRIDGE_OFFICE_CONCURRENCY) || 2));
const OFFICE_FAIL_TTL = 5 * 60_000;
const OFFICE_QUEUE_MAX = Math.max(4, Number(process.env.BRIDGE_OFFICE_QUEUE_MAX) || 32);
const OFFICE_ABANDON_MS = 90_000;
const OFFICE_STALE_MS = 6 * 3600_000;

let sofficePath;
function findSoffice() {
  if (sofficePath !== undefined) return sofficePath;
  const candidates = [
    process.env.BRIDGE_SOFFICE,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/lib/libreoffice/program/soffice',
    '/opt/libreoffice/program/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ].filter(Boolean);
  sofficePath = candidates.find((candidate) => existsSync(candidate)) || null;
  return sofficePath;
}

// 整棵进程树收掉：Windows 用 taskkill /T（按 pid，绝不按映像名，别人的 LibreOffice 不碰）；其余平台子进程是独立进程组，对组发信号。
function killOfficeTree(child, sync = false) {
  const pid = child?.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T', '/F'];
    try {
      if (sync) spawnSync('taskkill', args, { windowsHide: true, timeout: 5000 });
      else execFile('taskkill', args, { windowsHide: true, timeout: 15_000 }, () => {});
    } catch {}
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

const officeChildren = new Set();
let officeExitHooked = false;
function trackOfficeChild(child) {
  officeChildren.add(child);
  child.once('exit', () => officeChildren.delete(child));
  if (officeExitHooked) return;
  officeExitHooked = true;
  // bridge 退出（重启 / 自更新）时还在转的 soffice 跟着走，别留孤儿；exit 回调里只能同步
  process.once('exit', () => { for (const c of officeChildren) killOfficeTree(c, true); });
}

const rmQuiet = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} };

// 上次 bridge 被硬杀时没来得及删的 lo-prof-* / tmp-*（每个进程只扫一次，只删 6 小时前的，正在用的不碰）
let officeSwept = false;
function sweepOfficeLeftovers() {
  if (officeSwept) return;
  officeSwept = true;
  const now = Date.now();
  const sweep = (dir, prefix) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(dir, name);
      try { if (now - statSync(full).mtimeMs > OFFICE_STALE_MS) rmQuiet(full); } catch {}
    }
  };
  sweep(os.tmpdir(), 'lo-prof-');
  sweep(OFFICE_CACHE, 'tmp-');
}

async function convertOffice(src, outPdf) {
  const soffice = findSoffice();
  if (!soffice) throw new Error('LibreOffice 未安装');
  sweepOfficeLeftovers();
  const tag = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(OFFICE_CACHE, 'tmp-' + tag);
  const profile = path.join(os.tmpdir(), 'lo-prof-' + tag);
  mkdirSync(tmp, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(soffice, [
        '--headless', '--norestore', '--nolockcheck', '--nologo', '--nodefault', '--convert-to', 'pdf',
        '--outdir', tmp, src, '-env:UserInstallation=' + pathToFileURL(profile).href,
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
      trackOfficeChild(child);
      let errorOutput = '';
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => {
        killOfficeTree(child);
        finish(new Error(`转换超时（${Math.round(OFFICE_TIMEOUT_MS / 1000)} 秒）`));
      }, OFFICE_TIMEOUT_MS);
      child.stderr.on('data', (data) => { if (errorOutput.length < 2000) errorOutput += data; });
      child.on('error', finish);
      child.on('close', (code) => finish(code === 0 ? null : new Error(`soffice exit ${code} ${errorOutput.slice(0, 160)}`)));
    });
    const produced = path.join(tmp, path.basename(src, path.extname(src)) + '.pdf');
    if (!existsSync(produced)) throw new Error('未产出 PDF');
    renameSync(produced, outPdf);
  } finally {
    rmQuiet(tmp);
    rmQuiet(profile);
  }
}

// 转换队列：同一个输出只排一次；最多 OFFICE_CONCURRENCY 个同时跑，其余先来先转
const officeJobs = new Map();     // outPdf → job { state: 'queued'|'converting', since, started, touched, waiters, promise }
const officeQueue = [];
const officeFailures = new Map(); // outPdf → { at, error }
let officeRunning = 0;

function pumpOffice() {
  while (officeRunning < OFFICE_CONCURRENCY && officeQueue.length) {
    const job = officeQueue.shift();
    if (!job.waiters && Date.now() - job.touched > OFFICE_ABANDON_MS) {
      // 排队期间没人再来问、也没有请求在等：不替已经走掉的人白跑一趟 soffice
      officeJobs.delete(job.out);
      job.reject(new Error('abandoned'));
      continue;
    }
    officeRunning++;
    job.state = 'converting';
    job.started = Date.now();
    convertOffice(job.src, job.out).then(
      () => { officeFailures.delete(job.out); job.resolve(); },
      (error) => {
        officeFailures.set(job.out, { at: Date.now(), error: String(error?.message || error).slice(0, 200) });
        while (officeFailures.size > 256) officeFailures.delete(officeFailures.keys().next().value);
        job.reject(error);
      },
    ).finally(() => {
      officeRunning--;
      officeJobs.delete(job.out);
      pumpOffice();
    });
  }
}

// 返回 null = 队列已满（调用方回 busy / 503）
function enqueueOffice(src, out) {
  let job = officeJobs.get(out);
  if (job) { job.touched = Date.now(); return job; }
  if (officeQueue.length >= OFFICE_QUEUE_MAX) return null;
  job = { src, out, state: 'queued', since: Date.now(), started: 0, touched: Date.now(), waiters: 0 };
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  job.promise.catch(() => {});   // 只查状态、没人 await 时别成未处理的拒绝
  officeJobs.set(out, job);
  officeQueue.push(job);
  pumpOffice();
  return job;
}

function recentOfficeFailure(out) {
  const f = officeFailures.get(out);
  if (!f) return null;
  if (Date.now() - f.at > OFFICE_FAIL_TTL) { officeFailures.delete(out); return null; }
  return f;
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
  const statusOnly = url.searchParams.get('status') === '1';
  if (url.searchParams.get('retry') === '1') officeFailures.delete(outPdf);

  if (statusOnly) {
    const send = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (existsSync(outPdf)) return send({ state: 'ready' });
    if (!findSoffice()) return send({ state: 'unavailable', error: 'LibreOffice 未安装' });
    const failed = recentOfficeFailure(outPdf);
    if (failed) return send({ state: 'failed', error: failed.error });
    const job = enqueueOffice(file, outPdf);
    if (!job) return send({ state: 'busy', ahead: officeQueue.length + officeRunning, retryMs: 3000, timeoutMs: OFFICE_TIMEOUT_MS });
    const ahead = job.state === 'queued' ? officeQueue.indexOf(job) + officeRunning : 0;
    return send({
      state: job.state,
      ms: Date.now() - (job.started || job.since),
      ahead,
      timeoutMs: OFFICE_TIMEOUT_MS,
    });
  }

  try {
    if (!existsSync(outPdf)) {
      const failed = recentOfficeFailure(outPdf);
      if (failed) throw new Error(failed.error);
      const job = enqueueOffice(file, outPdf);
      if (!job) { res.setHeader('Retry-After', '15'); return bad(res, 503, 'office convert busy'); }
      // 挂着等的请求算「有人在等」（不会被当没人要丢掉）；请求断开就不算了
      let held = true;
      const release = () => { if (held) { held = false; job.waiters--; job.touched = Date.now(); } };
      job.waiters++;
      res.once('close', release);
      try { await job.promise; } finally { release(); res.off('close', release); }
    }
  } catch (error) {
    return bad(res, 503, 'office convert unavailable: ' + String(error?.message || error).slice(0, 120));
  }
  streamFile(req, res, outPdf, {
    contentType: 'application/pdf',
    cacheControl: 'private, max-age=3600',
  });
}
