// 音视频播放器的服务端衍生物（VideoPlayer / AudioPlayer 按需拉取，全部只读、带缓存）：
//   GET /api/file/media-meta   → JSON：时长、标题/艺人/专辑（容器标签）、章节、帧率、显示宽高、有无内嵌封面、同目录同名字幕
//   GET /api/file/storyboard   → JSON 清单 { cols, rows, w, h, interval, count, v }；加 &img=1 取雪碧图本体（jpg）
//   GET /api/file/media-cover  → 内嵌封面（ID3 APIC / m4a covr / flac picture），≤800px jpg；没有就 404
//   GET /api/file/media-peaks  → JSON { peaks:[0..1]×N }：音频波形（解码成 4kHz 单声道取块峰值）
// 雪碧图 / 封面 / 波形落在数据根 thumb-cache/（键 = sha1(路径|mtime|大小)，文件被改写自然换键），
// 同一文件并发去重；ffmpeg / ffprobe 统一走 runTool：全局并发上限 + 排队上限 + 超时 kill（收尸），
// 失败记进内存黑名单不再反复重跑。鉴权与路径守卫与 /api/file/stream 相同（requireReadCtx → scopeCtx → safeJoin）。
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { statSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { requireReadCtx } from '../runtime/identity.mjs';
import { DATA_ROOT } from '../runtime/paths.mjs';
import { safeJoin } from '../runtime/http-file.mjs';
import { bad, scopeCtx } from './file-core.mjs';

const CACHE = path.join(DATA_ROOT, 'thumb-cache');
try { mkdirSync(CACHE, { recursive: true }); } catch {}

const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'aiff', 'aif', 'ape', 'weba']);
const SUB_EXT = new Set(['vtt', 'srt']);

// —— 子进程池：同时最多 MAX_CONC 个 ffmpeg/ffprobe，排队超过 MAX_QUEUE 直接 503，单个超时即 kill ——
const MAX_CONC = 2;
const MAX_QUEUE = 16;
let active = 0;
const waiting = [];
const children = new Set();
process.once('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } });

class BusyError extends Error {}

// —— 输入白名单：只许读本地文件、只许常见音视频容器的 demuxer ——
// 伪装成媒体的播放列表（HLS/ffconcat/SDP…）在旧版 ffmpeg 上会按内容探测出来，去拉 http 分片或读别的目录；
// 加在每个 -i（ffprobe 是文件名）前面。av_match_list 按逗号拆，demuxer 全名如 "mov,mp4,m4a,3gp,3g2,mj2" 命中其一即可。
// 实测 ffmpeg 8.1.1 下 mp4/mov/mkv/webm/avi/mp3/m4a/aac/flac/ogg/opus/wav/wma/aiff 全部照常（ffprobe 与 ffmpeg 都认）。
const FMT_WL = 'mov,matroska,avi,mpegts,mpeg,flv,asf,mp3,aac,flac,ogg,wav,w64,aiff,ape,wv,caf,amr,ac3,eac3,dts,truehd,h264,hevc,ivf,nut';
export const FF_INPUT_GUARD = Object.freeze(['-protocol_whitelist', 'file', '-format_whitelist', FMT_WL]);

function acquire() {
  if (active < MAX_CONC) { active += 1; return Promise.resolve(); }
  if (waiting.length >= MAX_QUEUE) return Promise.reject(new BusyError('busy'));
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active = Math.max(0, active - 1);
}

// 跑一个工具进程：收 stdout（Buffer 或逐块回调）、超时 kill、出口码非 0 视为失败。
async function runTool(cmd, args, { timeout = 30000, onData = null, maxOut = 8 << 20 } = {}) {
  await acquire();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true });
      children.add(child);
      const chunks = [];
      let size = 0, err = '', settled = false;
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done(new Error(cmd + ' timeout')); }, timeout);
      function done(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        children.delete(child);
        if (error) reject(error); else resolve(value);
      }
      child.stdout.on('data', (d) => {
        if (onData) { onData(d); return; }
        size += d.length;
        if (size > maxOut) { try { child.kill('SIGKILL'); } catch {} done(new Error(cmd + ' output too large')); return; }
        chunks.push(d);
      });
      child.stderr.on('data', (d) => { if (err.length < 1500) err += d; });
      child.on('error', (e) => done(e));
      child.on('close', (code) => {
        if (code === 0) done(null, Buffer.concat(chunks));
        else done(new Error(`${cmd} exit ${code} ${err.trim().slice(0, 140)}`));
      });
    });
  } finally { release(); }
}

const keyOf = (file, stat) => crypto.createHash('sha1').update(`${file}|${stat.mtimeMs}|${stat.size}`).digest('hex');
const inflight = new Map();   // 键 → Promise（同一产物并发只跑一次）
const failed = new Set();     // 失败过的键（内存，进程重启清零）
function remember(set, k) { set.add(k); if (set.size > 512) set.delete(set.values().next().value); }
function once(k, fn) {
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => { try { return await fn(); } finally { inflight.delete(k); } })();
  inflight.set(k, p);
  return p;
}

// —— ffprobe 元数据（内存缓存 ≤300 条）——
const metaCache = new Map();
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
function rate(s) {
  const m = /^(\d+)\/(\d+)$/.exec(String(s || ''));
  if (!m || !+m[2]) return 0;
  const r = +m[1] / +m[2];
  return r > 0 && r < 1000 ? Math.round(r * 1000) / 1000 : 0;
}
function pickTag(tags, ...names) {
  if (!tags) return '';
  const low = {};
  for (const [k, v] of Object.entries(tags)) low[k.toLowerCase()] = v;
  for (const n of names) if (low[n]) return String(low[n]).slice(0, 300);
  return '';
}

async function probe(file, stat) {
  const k = keyOf(file, stat);
  const hit = metaCache.get(k);
  if (hit) return hit;
  return once('meta:' + k, async () => {
    const out = await runTool('ffprobe', [
      '-v', 'error', '-show_chapters',
      '-show_entries', 'format=duration:format_tags:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation',
      '-of', 'json', ...FF_INPUT_GUARD, file,
    ], { timeout: 15000 });
    const j = JSON.parse(String(out));
    const streams = j.streams || [];
    const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const cover = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic);
    let w = video?.width || 0, h = video?.height || 0;
    let rot = num(video?.tags?.rotate);
    for (const sd of video?.side_data_list || []) if (sd.rotation != null) rot = num(sd.rotation);
    if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
    const meta = {
      duration: num(j.format?.duration),
      width: w, height: h,
      fps: video ? (rate(video.avg_frame_rate) || rate(video.r_frame_rate)) : 0,
      hasVideo: !!video,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      hasCover: !!cover,
      title: pickTag(j.format?.tags, 'title'),
      artist: pickTag(j.format?.tags, 'artist', 'album_artist', 'performer'),
      album: pickTag(j.format?.tags, 'album'),
      chapters: (j.chapters || []).map((c) => ({
        start: num(c.start_time), end: num(c.end_time), title: pickTag(c.tags, 'title'),
      })).filter((c) => c.end > c.start).slice(0, 200),
    };
    if (metaCache.size > 300) metaCache.clear();
    metaCache.set(k, meta);
    return meta;
  });
}

// 同目录同名字幕：<名>.vtt / <名>.srt / <名>.<语言>.srt（不分大小写），最多 8 条
function siblingSubs(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file)).toLowerCase();
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const ext = path.extname(n).slice(1).toLowerCase();
    if (!SUB_EXT.has(ext)) continue;
    const stem = n.slice(0, n.length - ext.length - 1);
    const low = stem.toLowerCase();
    if (low === base) out.push({ name: n, lang: '', ext });
    else if (low.startsWith(base + '.')) {
      const lang = stem.slice(base.length + 1);
      if (lang && lang.length <= 16 && !lang.includes('.')) out.push({ name: n, lang, ext });
    }
    if (out.length >= 8) break;
  }
  return out.sort((a, b) => (a.lang ? 1 : 0) - (b.lang ? 1 : 0) || (a.ext === 'vtt' ? -1 : 1));
}

// —— 雪碧图：一次 ffmpeg 出整张（fps 抽样 → 缩放 → tile 拼版）——
// 间隔 = max(1s, 时长/120)，最多 120 格、10 列；长片（>90s）只解关键帧（-skip_frame nokey），6 分钟 720p 实测 <0.5s，
// 代价是格子落在最近的关键帧上（误差 ≤ 一个 GOP），悬停预览够用。
const SB_COLS = 10, SB_MAX = 120, SB_LONG = 90;
function sbLayout(meta) {
  const dur = meta.duration;
  const interval = Math.max(1, dur / SB_MAX);
  const count = Math.max(1, Math.min(SB_MAX, Math.ceil(dur / interval)));
  let w = 160, h = 90;
  if (meta.width > 0 && meta.height > 0) {
    if (meta.width >= meta.height) { w = 160; h = Math.max(2, Math.round(160 * meta.height / meta.width / 2) * 2); }
    else { h = 160; w = Math.max(2, Math.round(160 * meta.width / meta.height / 2) * 2); }
  }
  const cols = Math.min(SB_COLS, count);
  return { cols, rows: Math.ceil(count / cols), w, h, interval: Math.round(interval * 1000) / 1000, count };
}
async function storyboard(file, stat) {
  const k = keyOf(file, stat) + '-sb';
  const img = path.join(CACHE, k + '.jpg'), man = path.join(CACHE, k + '.json');
  if (existsSync(img) && existsSync(man)) { try { return { img, manifest: JSON.parse(readFileSync(man, 'utf8')) }; } catch {} }
  if (failed.has(k)) return null;
  return once(k, async () => {
    try {
      const meta = await probe(file, stat);
      if (!meta.hasVideo || !(meta.duration > 0)) { remember(failed, k); return null; }
      const L = sbLayout(meta);
      const tmp = img + '.tmp.jpg';
      await runTool('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        ...(meta.duration > SB_LONG ? ['-skip_frame', 'nokey'] : []),
        ...FF_INPUT_GUARD, '-i', file, '-map', '0:V:0', '-an', '-sn', '-dn',
        '-vf', `fps=1/${L.interval},scale=${L.w}:${L.h}:force_original_aspect_ratio=decrease,pad=${L.w}:${L.h}:(ow-iw)/2:(oh-ih)/2:color=black,tile=${L.cols}x${L.rows}`,
        '-frames:v', '1', '-q:v', '5', '-y', tmp,
      ], { timeout: 45000 });
      if (!existsSync(tmp)) throw new Error('no output');
      renameSync(tmp, img);
      const manifest = { ...L, v: Math.round(stat.mtimeMs) };
      writeFileSync(man, JSON.stringify(manifest));
      return { img, manifest };
    } catch (e) {
      try { rmSync(img + '.tmp.jpg', { force: true }); } catch {}
      if (!(e instanceof BusyError)) remember(failed, k);
      throw e;
    }
  });
}

// —— 内嵌封面：取 attached_pic 那一路，长边 ≤800 转 jpg ——
async function cover(file, stat) {
  const k = keyOf(file, stat) + '-cover';
  const out = path.join(CACHE, k + '.jpg');
  if (existsSync(out)) return out;
  if (failed.has(k)) return null;
  return once(k, async () => {
    try {
      const meta = await probe(file, stat);
      if (!meta.hasCover) { remember(failed, k); return null; }
      const tmp = out + '.tmp.jpg';
      await runTool('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', ...FF_INPUT_GUARD, '-i', file, '-map', '0:v:0', '-an', '-frames:v', '1',
        '-vf', "scale='min(800,iw)':'min(800,ih)':force_original_aspect_ratio=decrease", '-q:v', '3', '-y', tmp,
      ], { timeout: 15000 });
      renameSync(tmp, out);
      return out;
    } catch (e) {
      try { rmSync(out + '.tmp.jpg', { force: true }); } catch {}
      if (!(e instanceof BusyError)) remember(failed, k);
      throw e;
    }
  });
}

// —— 波形：解码成 4kHz 单声道 s16le，按 0.05s 一块取峰值，最后重采样成 N 点（0..1，按最大值归一）——
const PEAKS_N = 400;
async function peaks(file, stat) {
  const k = keyOf(file, stat) + '-peaks';
  const out = path.join(CACHE, k + '.json');
  if (existsSync(out)) { try { return JSON.parse(readFileSync(out, 'utf8')); } catch {} }
  if (failed.has(k)) return null;
  return once(k, async () => {
    try {
      const blocks = [];
      let cur = 0, n = 0, carry = null;
      const BLOCK = 200;   // 4000Hz × 0.05s
      await runTool('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', ...FF_INPUT_GUARD, '-i', file, '-map', '0:a:0', '-vn', '-sn',
        '-ac', '1', '-ar', '4000', '-f', 's16le', 'pipe:1',
      ], {
        timeout: 90000,
        onData: (buf) => {
          if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
          const len = buf.length - (buf.length % 2);
          if (len < buf.length) carry = buf.subarray(len);
          for (let i = 0; i < len; i += 2) {
            const v = Math.abs(buf.readInt16LE(i));
            if (v > cur) cur = v;
            if (++n >= BLOCK) { blocks.push(cur); cur = 0; n = 0; }
          }
        },
      });
      if (n) blocks.push(cur);
      if (!blocks.length) { remember(failed, k); return null; }
      const N = Math.min(PEAKS_N, blocks.length);
      const res = new Array(N);
      let max = 1;
      for (let i = 0; i < N; i++) {
        const a = Math.floor(i * blocks.length / N), b = Math.max(a + 1, Math.floor((i + 1) * blocks.length / N));
        let m = 0;
        for (let j = a; j < b; j++) if (blocks[j] > m) m = blocks[j];
        res[i] = m;
        if (m > max) max = m;
      }
      const data = { peaks: res.map((v) => Math.round(v / max * 100) / 100) };
      writeFileSync(out, JSON.stringify(data));
      return data;
    } catch (e) {
      if (!(e instanceof BusyError)) remember(failed, k);
      throw e;
    }
  });
}

// —— 路由公共前半段：鉴权 → 作用域 → 路径守卫 → stat → 扩展名门槛 ——
function resolveFile(req, res, url, identify, exts) {
  let ctx = requireReadCtx(identify, req, res);
  if (!ctx) return null;
  ctx = scopeCtx(ctx, url.searchParams.get('ws'), res);
  if (!ctx) return null;
  const file = safeJoin(ctx.cwd, url.searchParams.get('path') || '');
  if (!file) { bad(res, 403, 'forbidden'); return null; }
  let stat;
  try { stat = statSync(file); } catch { bad(res, 404, 'not found'); return null; }
  if (stat.isDirectory()) { bad(res, 400, 'is a directory'); return null; }
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!exts.some((s) => s.has(ext))) { bad(res, 415, 'not a media file'); return null; }
  return { file, stat };
}
function json(res, data, maxAge = 3600) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': `private, max-age=${maxAge}` });
  res.end(JSON.stringify(data));
}
function sendImage(res, file) {
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
  pipeline(createReadStream(file), res, () => {});
}
// 失败：细节（ffmpeg stderr 里带服务器绝对路径）只进服务端日志，客户端（含分享访客）只拿通用错误码
function fail(res, e, code = 'media_failed') {
  if (res.headersSent) return;
  if (e instanceof BusyError) { res.setHeader('Retry-After', '3'); bad(res, 503, 'media tools busy'); return; }
  console.warn('[file-media]', code, String(e?.message || e).slice(0, 300));
  bad(res, 500, code);
}

export async function handleMediaMeta(req, res, url, identify) {
  const r = resolveFile(req, res, url, identify, [VIDEO_EXT, AUDIO_EXT]);
  if (!r) return;
  try {
    const meta = await probe(r.file, r.stat);
    json(res, { ...meta, subs: siblingSubs(r.file) }, 60);
  } catch (e) { fail(res, e, 'probe_failed'); }
}

export async function handleStoryboard(req, res, url, identify) {
  const r = resolveFile(req, res, url, identify, [VIDEO_EXT]);
  if (!r) return;
  try {
    const sb = await storyboard(r.file, r.stat);
    if (!sb) return bad(res, 404, 'no storyboard');
    if (url.searchParams.get('img') === '1') return sendImage(res, sb.img);
    json(res, sb.manifest, 86400);
  } catch (e) { fail(res, e); }
}

export async function handleMediaCover(req, res, url, identify) {
  const r = resolveFile(req, res, url, identify, [AUDIO_EXT, VIDEO_EXT]);
  if (!r) return;
  try {
    const f = await cover(r.file, r.stat);
    if (!f) return bad(res, 404, 'no cover');
    sendImage(res, f);
  } catch (e) { fail(res, e); }
}

export async function handleMediaPeaks(req, res, url, identify) {
  const r = resolveFile(req, res, url, identify, [AUDIO_EXT]);
  if (!r) return;
  try {
    const p = await peaks(r.file, r.stat);
    if (!p) return bad(res, 404, 'no audio');
    json(res, p, 86400);
  } catch (e) { fail(res, e); }
}
