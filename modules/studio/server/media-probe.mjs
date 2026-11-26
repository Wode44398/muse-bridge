// 作品的宽高、时长、波形（方案 §12.7）：作品墙按真实比例排格子，配音 / 音乐行画真波形。
//
// 图像读文件头（PNG IHDR / JPEG SOF / WebP VP8 / VP8L / VP8X / GIF / SVG），纯 JS、同步、只读头几百 KB，列表时现补；
// 视频要 ffprobe、非 WAV 的音频要 ffmpeg 解码，都是子进程：列表里不等它们，排进后台队列一个一个做，做完写回侧车，下次列表带上。
// 补上的宽高另记 dimsProbed：旧侧车没有 params 时 publicAsset 从散字段捡参数（含本机生图的 width / height），补的宽高不能被当成参数。
// 写回走 media.updateMeta（writeJson 先写 .tmp 再 rename）：侧车是硬链接时 rename 换掉的是这一侧的目录项，另一侧的文件不受影响。
// ffmpeg / ffprobe 不在、文件坏了：这一件这次进程里不再试（记在内存里），接口照常回，只是缺这几个字段。

import { spawn } from 'node:child_process';
import { openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import * as media from '@bridge/core/vertex-media.mjs';
import { imageDims } from './adapters/openrouter-image.mjs';

// —— 图像文件头 ——
/** 作品宽高：PNG / JPEG / WebP 读文件头；GIF 读逻辑屏幕宽高（字节 6–9 小端）；SVG 读根元素的 width / height，没有就用 viewBox（读不到回 null） */
export function outputDims(bytes, ext) {
  if (!bytes || !bytes.length) return null;
  if (ext === 'gif' || bytes.toString('ascii', 0, 6) === 'GIF89a' || bytes.toString('ascii', 0, 6) === 'GIF87a') {
    if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') {
      const w = bytes.readUInt16LE(6), h = bytes.readUInt16LE(8);
      return w > 0 && h > 0 ? [w, h] : null;
    }
    return null;
  }
  if (ext === 'svg') return svgDims(bytes);
  const d = imageDims(bytes);
  return d && d[0] > 0 && d[1] > 0 ? d : null;
}
const SVG_LEN = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i;   // 只认无单位 / px（%、em 这类没法换成像素）
export function svgDims(bytes) {
  try {
    const head = bytes.subarray(0, 65536).toString('utf8');
    const m = /<svg\b[^>]*>/i.exec(head);
    if (!m) return null;
    const attr = (name) => { const a = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(m[0]); return a ? a[2] : null; };
    const num = (s) => { const x = s != null ? SVG_LEN.exec(s) : null; return x ? Number(x[1]) : null; };
    let w = num(attr('width')), h = num(attr('height'));
    if (!(w > 0 && h > 0)) {
      const vb = String(attr('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        // 只给了一边：按 viewBox 的比例补另一边
        if (w > 0) h = w * vb[3] / vb[2];
        else if (h > 0) w = h * vb[2] / vb[3];
        else { w = vb[2]; h = vb[3]; }
      }
    }
    if (!(w > 0 && h > 0)) return null;
    const W = Math.round(w), H = Math.round(h);
    return W > 0 && H > 0 && W <= 100000 && H <= 100000 ? [W, H] : null;
  } catch { return null; }
}

const HEAD_BYTES = 256 * 1024;
const JPEG_FULL_MAX = 24 * 1024 * 1024;
function readHead(file, n) {
  const fd = openSync(file, 'r');
  try { const b = Buffer.alloc(n); const got = readSync(fd, b, 0, n, 0); return b.subarray(0, got); }
  finally { closeSync(fd); }
}
/** 图像文件的宽高：先读头 256KB；JPEG 的 SOF 被大块 EXIF / ICC 挤到后面时再整个读（有上限） */
export function fileImageDims(file, ext) {
  try {
    const e = String(ext || '').toLowerCase();
    const head = readHead(file, HEAD_BYTES);
    let d = outputDims(head, e);
    if (!d && head.length === HEAD_BYTES && head[0] === 0xff && head[1] === 0xd8 && statSync(file).size <= JPEG_FULL_MAX) d = outputDims(readFileSync(file), e);
    return d;
  } catch { return null; }
}

// —— WAV ——
/** RIFF/WAVE 头：按块走（fmt 之后可能夹着 LIST 之类），回 { format, channels, rate, bits, start, size, duration } 或 null */
export function parseWav(buf) {
  try {
    if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12, fmt = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      let size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ' && body + 16 <= buf.length) {
        let format = buf.readUInt16LE(body);
        // WAVE_FORMAT_EXTENSIBLE：真格式在子格式 GUID 的头两个字节
        if (format === 0xfffe && size >= 26 && body + 26 <= buf.length) format = buf.readUInt16LE(body + 24);
        fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
      } else if (id === 'data') {
        // 流式写出的 WAV 常把 data 长度写成 0 / 0xFFFFFFFF：按文件实长算
        if (!size || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
        if (!fmt || !fmt.channels || !fmt.rate || !fmt.bits) return null;
        const frameBytes = fmt.channels * fmt.bits / 8;
        return { ...fmt, start: body, size, duration: Math.round((size / frameBytes / fmt.rate) * 100) / 100 };
      }
      off = body + size + (size & 1);
    }
  } catch {}
  return null;
}

// —— 波形 ——
export const PEAK_BARS = 120;
/**
 * 16-bit 交错 PCM → 120 格波形。每格 = 峰值 × 0.35 + RMS × 0.65 × 2.2（只看峰值太尖、只看 RMS 太平）；
 * 整体除以最大格，再取 0.8 次方把弱的段落提起来一点；三位小数。step 隔帧取样（长 WAV 降到约 4kHz 再算，和 ffmpeg 那条路一致）。
 */
export function peaksFromS16(buf, start, bytes, channels = 1, { bars = PEAK_BARS, step = 1 } = {}) {
  const ch = Math.max(1, channels | 0);
  const frames = Math.floor(Math.max(0, Math.min(bytes, buf.length - start)) / (2 * ch));
  const out = new Array(bars).fill(0);
  if (!frames) return out;
  const st = Math.max(1, step | 0);
  const raw = new Array(bars).fill(0);
  for (let b = 0; b < bars; b++) {
    const f0 = Math.floor((b * frames) / bars), f1 = Math.max(f0 + 1, Math.floor(((b + 1) * frames) / bars));
    let peak = 0, sq = 0, n = 0;
    for (let f = f0; f < f1 && f < frames; f += st) {
      const base = start + f * 2 * ch;
      for (let c = 0; c < ch; c++) {
        const v = buf.readInt16LE(base + c * 2) / 32768;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sq += v * v; n++;
      }
    }
    raw[b] = n ? peak * 0.35 + Math.sqrt(sq / n) * 0.65 * 2.2 : 0;
  }
  const max = Math.max(...raw);
  if (!(max > 0)) return out;
  return raw.map((v) => Math.round(Math.pow(v / max, 0.8) * 1000) / 1000);
}

/** WAV 字节 → { peaks, duration }；不是 16-bit PCM 的（float、24-bit）只回 duration，peaks 留给 ffmpeg */
export function wavPeaks(buf) {
  const w = parseWav(buf);
  if (!w) return null;
  if (w.format !== 1 || w.bits !== 16) return { duration: w.duration };
  return { peaks: peaksFromS16(buf, w.start, w.size, w.channels, { step: Math.max(1, Math.round(w.rate / 4000)) }), duration: w.duration };
}

// —— 子进程 ——
// 解码上限：4kHz 单声道 16-bit 一小时约 28.8MB，再长的只看前一小时
const DECODE_MAX = 4000 * 2 * 3600;
function run(cmd, args, { timeoutMs, maxBytes = 4 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve(null); return; }
    const chunks = []; let got = 0, capped = false, done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    // 超时就杀：坏文件 / 网络盘卡住时别让子进程一直挂着
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish(null); }, timeoutMs);
    p.on('error', () => finish(null));
    p.stdout.on('data', (c) => {
      if (capped) return;
      chunks.push(c); got += c.length;
      if (got >= maxBytes) { capped = true; try { p.kill('SIGKILL'); } catch {} }
    });
    p.on('close', (code) => finish(code === 0 || capped ? { out: Buffer.concat(chunks), capped } : null));
  });
}

/** ffprobe 一个媒体文件：{ w?, h?, duration? }（竖拍视频按旋转角换过宽高）；ffprobe 不在 / 失败回 null */
export async function probeFile(file) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_entries', 'stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation:format=duration', file], { timeoutMs: 10_000 });
  if (!r) return null;
  try {
    const o = JSON.parse(r.out.toString('utf8'));
    const v = (o.streams || []).find((s) => s.codec_type === 'video' && s.width > 0 && s.height > 0);
    const out = {};
    if (v) {
      const rot = Math.abs(Number(v.tags?.rotate ?? (v.side_data_list || []).find((x) => x.rotation != null)?.rotation ?? 0)) % 180;
      [out.w, out.h] = rot === 90 ? [v.height, v.width] : [v.width, v.height];
    }
    const d = Number(o.format?.duration);
    if (d > 0) out.duration = Math.round(d * 100) / 100;
    return out;
  } catch { return null; }
}

/** ffmpeg 把任意音频解成 4kHz 单声道 s16le 再算波形：{ peaks, duration }；ffmpeg 不在 / 解不了回 null */
export async function decodePeaks(file) {
  const r = await run('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', '4000', '-f', 's16le', '-'], { timeoutMs: 30_000, maxBytes: DECODE_MAX });
  if (!r || r.out.length < 2) return null;
  const peaks = peaksFromS16(r.out, 0, r.out.length, 1);
  return { peaks, ...(r.capped ? {} : { duration: Math.round((r.out.length / 2 / 4000) * 100) / 100 }) };
}

// —— 补侧车 ——
const failed = new Set();                 // `<目录>|<id>|<活>`：这次进程里补不出来的，别每次列表都再试
const inflight = new Map();
const keyOf = (dir, id, what) => dir + '|' + id + '|' + what;
const hasDims = (rec) => (rec.width || rec.w) > 0 && (rec.height || rec.h) > 0;
const hasPeaks = (rec) => Array.isArray(rec.peaks) && rec.peaks.length > 0;
const isAudio = (k) => k === 'audio' || k === 'music';

/** 图像缺宽高就地读文件头补上（同步、只读头），写回侧车；回补过的记录（rec 本身也改了） */
export function fillImageDims(dir, rec) {
  if ((rec.kind || 'video') !== 'image' || hasDims(rec)) return rec;
  const k = keyOf(dir, rec.id, 'dims');
  if (failed.has(k)) return rec;
  const f = media.fileFor(rec.id, dir);
  const d = f ? fileImageDims(f, rec.ext) : null;
  if (!d) { failed.add(k); return rec; }
  rec.width = d[0]; rec.height = d[1]; rec.dimsProbed = true;
  media.updateMeta(rec.id, { width: d[0], height: d[1], dimsProbed: true }, dir);
  return rec;
}

/** 视频的宽高 / 时长（ffprobe）→ 写回侧车；回补上的字段（{ w, h, duration } 的子集）或 null */
export function ensureVideoMeta(dir, id) {
  const k = keyOf(dir, id, 'video');
  if (inflight.has(k)) return inflight.get(k);
  const job = (async () => {
    const rec = media.get(id, dir);
    if (!rec || failed.has(k)) return null;
    if (hasDims(rec) && rec.duration > 0) return null;
    const f = media.fileFor(id, dir);
    const p = f ? await probeFile(f) : null;
    if (!p || (!p.w && !p.duration)) { failed.add(k); return null; }
    const patch = {};
    if (!hasDims(rec) && p.w > 0 && p.h > 0) { patch.width = p.w; patch.height = p.h; patch.dimsProbed = true; }
    if (!(rec.duration > 0) && p.duration > 0) patch.duration = p.duration;
    if (!Object.keys(patch).length) return null;
    media.updateMeta(id, patch, dir);
    return { ...(patch.width ? { w: patch.width, h: patch.height } : {}), ...(patch.duration ? { duration: patch.duration } : {}) };
  })().finally(() => inflight.delete(k));
  inflight.set(k, job);
  return job;
}

/**
 * 配音 / 音乐的波形：侧车里有就直接回；WAV 纯 JS 解；其余 ffmpeg。算出来写回侧车。
 * 回 { peaks?, duration? }（ffmpeg 不在时只有 duration，可能连 duration 都没有）；作品不存在回 null。
 */
export function ensurePeaks(dir, id) {
  const k = keyOf(dir, id, 'peaks');
  if (inflight.has(k)) return inflight.get(k);
  const job = (async () => {
    const rec = media.get(id, dir);
    if (!rec || !isAudio(rec.kind)) return null;
    if (hasPeaks(rec)) return { peaks: rec.peaks, ...(rec.duration > 0 ? { duration: rec.duration } : {}) };
    const dur = rec.duration > 0 ? { duration: rec.duration } : {};
    if (failed.has(k)) return dur;
    const f = media.fileFor(id, dir);
    if (!f) { failed.add(k); return dur; }
    let r = null;
    if (String(rec.ext || '').toLowerCase() === 'wav') { try { r = wavPeaks(readFileSync(f)); } catch {} }
    if (!r?.peaks) {
      const d = await decodePeaks(f);
      if (d) r = { ...r, ...d, duration: d.duration || r?.duration };
    }
    if (!r?.duration && !dur.duration) { const p = await probeFile(f); if (p?.duration) r = { ...r, duration: p.duration }; }
    const patch = {};
    if (r?.peaks) patch.peaks = r.peaks;
    if (!(rec.duration > 0) && r?.duration > 0) patch.duration = r.duration;
    if (Object.keys(patch).length) media.updateMeta(id, patch, dir);
    if (!patch.peaks) failed.add(k);
    return { ...dur, ...patch };
  })().finally(() => inflight.delete(k));
  inflight.set(k, job);
  return job;
}

// 后台补：一次只跑一个子进程（手机一进来就列表，别同时起几十个 ffprobe）
const queue = [];
const queued = new Set();
let pumping = false;
function enqueue(key, fn) {
  if (queued.has(key) || inflight.has(key) || failed.has(key)) return;
  queued.add(key);
  queue.push([key, fn]);
  if (!pumping) pump();
}
async function pump() {
  pumping = true;
  while (queue.length) {
    const [key, fn] = queue.shift();
    queued.delete(key);
    try { await fn(); } catch {}
  }
  pumping = false;
}

/** 列表 / 单件出去之前：图像缺宽高现补；视频缺宽高时长、音频缺波形的排进后台，下次列表带上 */
export function hydrate(dir, rec) {
  const kind = rec.kind || 'video';
  if (kind === 'image') return fillImageDims(dir, rec);
  if (kind === 'video' && !(hasDims(rec) && rec.duration > 0)) enqueue(keyOf(dir, rec.id, 'video'), () => ensureVideoMeta(dir, rec.id));
  else if (isAudio(kind) && !hasPeaks(rec)) enqueue(keyOf(dir, rec.id, 'peaks'), () => ensurePeaks(dir, rec.id));
  return rec;
}

/** 测试用：清掉进程内的失败记忆与队列 */
export function _resetProbe() { failed.clear(); queue.length = 0; queued.clear(); }
/** 测试用：等后台队列跑完 */
export async function _drainProbe() { while (pumping || queue.length || inflight.size) await new Promise((r) => setTimeout(r, 10)); }
