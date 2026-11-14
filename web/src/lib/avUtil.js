// 音视频播放器的纯函数（零依赖，node --test 可直接跑，见 avUtil.test.js）：
// 时间格式、字幕解析（编码识别、SRT→VTT、VTT→cue 数组、按时间取 cue）、章节、storyboard 取格、
// 续播位置 LRU、全局播放偏好（音量 / 静音 / 倍速）、倍速档位、ID3v2 标签解析、占位波形。

// —— 时间 ——
export function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}

// 'hh:mm:ss.mmm' / 'mm:ss.mmm' / 'hh:mm:ss,mmm'（SRT 逗号）→ 秒；不合法返回 NaN
export function parseTimecode(s) {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(String(s || ''));
  if (!m) return NaN;
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return (m[1] ? parseInt(m[1], 10) : 0) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + ms / 1000;
}

// —— 字幕 ——
const ARROW = /-->/;
function lines(text) { return String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n'); }

// SRT → WebVTT：时间戳逗号改点、补 WEBVTT 头，序号行原样当 cue 标识（VTT 允许）
export function srtToVtt(text) {
  const body = lines(text).trim().replace(/(\d{1,2}:\d{1,2}:\d{1,2}),(\d{1,3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body + '\n';
}

const ENT = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'", lrm: '', rlm: '' };
function cueText(raw) {
  return raw
    .replace(/<[^>]*>/g, '')   // <i> <b> <c.x> <v 名字> <00:00:01.000> 一律去掉，只留文字
    .replace(/\{\\[^}]*\}/g, '')   // SRT 里偶见的 ASS 覆盖码 {\an8}
    .replace(/&(amp|lt|gt|nbsp|quot|apos|lrm|rlm);/g, (_, k) => ENT[k])
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

// VTT 或 SRT 文本 → [{ start, end, text }]（按 start 排序；空文本 cue 丢掉）
export function parseCues(text) {
  const src = lines(text);
  const blocks = src.split(/\n{2,}/);
  const out = [];
  for (const b of blocks) {
    const ls = b.split('\n');
    let i = ls.findIndex((l) => ARROW.test(l));
    if (i < 0) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(ls[0])) continue;
    const [a, rest] = ls[i].split(ARROW);
    const start = parseTimecode(a);
    const end = parseTimecode(String(rest || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const txt = cueText(ls.slice(i + 1).join('\n'));
    if (txt) out.push({ start, end, text: txt });
  }
  return out.sort((x, y) => x.start - y.start || x.end - y.end);
}

// t 时刻生效的 cue 文本（可能多条重叠）。二分到最后一个 start ≤ t，再往回看 30 条够覆盖重叠。
export function cuesAt(cues, t) {
  if (!cues || !cues.length || !Number.isFinite(t)) return [];
  let lo = 0, hi = cues.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  const res = [];
  for (let j = k; j >= 0 && j > k - 30; j--) if (cues[j].end > t) res.unshift(cues[j].text);
  return res;
}

// 字幕文件字节 → 文本：认 BOM（UTF-8 / UTF-16LE / UTF-16BE）；无 BOM 先按 UTF-8 严格解，
// 解不动再按 GB18030（国内字幕组的老 SRT 大量是 GBK）
export function decodeSubtitle(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || 0);
  const dec = (enc, x, fatal = false) => new TextDecoder(enc, { fatal }).decode(x);
  try {
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return dec('utf-8', b.subarray(3));
    if (b[0] === 0xff && b[1] === 0xfe) return dec('utf-16le', b.subarray(2));
    if (b[0] === 0xfe && b[1] === 0xff) return dec('utf-16be', b.subarray(2));
    return dec('utf-8', b, true);
  } catch {}
  try { return dec('gb18030', b); } catch { return dec('utf-8', b); }
}

// —— 章节 ——
export function chapterAt(chapters, t) {
  if (!chapters || !chapters.length) return null;
  for (let i = chapters.length - 1; i >= 0; i--) if (t >= chapters[i].start) return chapters[i];
  return chapters[0];
}

// —— storyboard：t 秒落在哪一格（清单见服务端 file-media.mjs）——
export function storyboardCell(sb, t) {
  if (!sb || !(sb.count > 0) || !(sb.interval > 0)) return null;
  const i = Math.max(0, Math.min(sb.count - 1, Math.round((Number(t) || 0) / sb.interval)));
  const col = i % sb.cols, row = Math.floor(i / sb.cols);
  return { i, col, row, x: col * sb.w, y: row * sb.h, w: sb.w, h: sb.h, W: sb.cols * sb.w, H: sb.rows * sb.h };
}

// —— 续播位置：localStorage 里一张 LRU 表（最多 cap 条），键 = 条目缓存键 / key ——
// 规则：播过 30s、离结尾还有 >10s 且没过 97% 才记；否则清掉（看完了就别再提示续播）。
export const RESUME_MIN = 30;
export function resumeWorthy(t, d) {
  if (!(t >= RESUME_MIN)) return false;
  if (d > 0 && (d - t <= 10 || t / d >= 0.97)) return false;
  return true;
}
export function resumeStore(storage, { key = 'pv.resume', cap = 200 } = {}) {
  const read = () => { try { const o = JSON.parse(storage?.getItem(key) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  const write = (o) => { try { storage?.setItem(key, JSON.stringify(o)); } catch {} };
  return {
    get(id) {
      if (!id) return null;
      const e = read()[id];
      return e && Number.isFinite(e.t) ? e : null;
    },
    set(id, t, d) {
      if (!id) return;
      const o = read();
      if (!resumeWorthy(t, d)) { if (o[id]) { delete o[id]; write(o); } return; }
      delete o[id];
      o[id] = { t: Math.round(t * 10) / 10, d: Math.round((d || 0) * 10) / 10, at: Date.now() };
      const ks = Object.keys(o);
      for (let i = 0; i < ks.length - cap; i++) delete o[ks[i]];   // 插入序即新旧序，最旧的在前
      write(o);
    },
    clear(id) { const o = read(); if (id && o[id]) { delete o[id]; write(o); } },
  };
}

// —— 全局播放偏好：音量 / 静音 / 倍速（视频与音频共用）——
export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const clampRate = (r) => Math.max(0.25, Math.min(2, Math.round(r * 100) / 100));
export function loadAvPrefs(storage, key = 'pv.av') {
  let o = {};
  try { o = JSON.parse(storage?.getItem(key) || '{}') || {}; } catch {}
  const volume = Number.isFinite(o.volume) ? Math.max(0, Math.min(1, o.volume)) : 1;
  const rate = Number.isFinite(o.rate) ? clampRate(o.rate) : 1;
  return { volume, muted: !!o.muted, rate };
}
export function saveAvPrefs(storage, p, key = 'pv.av') {
  try { storage?.setItem(key, JSON.stringify({ volume: p.volume, muted: !!p.muted, rate: p.rate })); } catch {}
}
// Shift+< / Shift+>：沿标准档位走一档（当前是自定义值时落到相邻档）
export function stepRate(cur, dir) {
  if (dir > 0) { for (const r of RATES) if (r > cur + 1e-6) return r; return RATES[RATES.length - 1]; }
  for (let i = RATES.length - 1; i >= 0; i--) if (RATES[i] < cur - 1e-6) return RATES[i];
  return RATES[0];
}
export { clampRate };

// —— ID3v2（mp3 标签）：标题 / 艺人 / 专辑 / 封面。buf 是文件开头的字节（至少含整个标签）——
function synchsafe(b, o) { return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f); }
export function id3Size(b) {
  if (!b || b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;   // 'ID3'
  return 10 + synchsafe(b, 6) + ((b[5] & 0x10) ? 10 : 0);
}
function decodeText(b, enc) {
  try {
    if (enc === 0) return new TextDecoder('latin1').decode(b);
    if (enc === 1) return new TextDecoder('utf-16').decode(b);   // 带 BOM
    if (enc === 2) return new TextDecoder('utf-16be').decode(b);
    return new TextDecoder('utf-8').decode(b);
  } catch { return ''; }
}
const clean = (s) => String(s || '').replace(/\u0000+$/g, '').split('\u0000')[0].trim();
function termLen(b, o, enc) {   // 从 o 起到字符串结束符（含）的长度
  if (enc === 1 || enc === 2) { for (let i = o; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i - o + 2; return b.length - o; }
  for (let i = o; i < b.length; i++) if (b[i] === 0) return i - o + 1;
  return b.length - o;
}
export function parseId3(b) {
  const total = id3Size(b);
  if (!total) return null;
  const ver = b[3];
  const out = { title: '', artist: '', album: '', cover: null };
  let o = 10;
  if (b[5] & 0x40) o += ver === 4 ? synchsafe(b, 10) : 4 + ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]);   // 扩展头
  const end = Math.min(total, b.length);
  const v22 = ver === 2;
  const hl = v22 ? 6 : 10;
  while (o + hl <= end) {
    const id = String.fromCharCode(...b.subarray(o, o + (v22 ? 3 : 4)));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;   // 补白区
    let size;
    if (v22) size = (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5];
    else if (ver === 4) size = synchsafe(b, o + 4);
    else size = ((b[o + 4] << 24) >>> 0) + (b[o + 5] << 16) + (b[o + 6] << 8) + b[o + 7];
    const d = o + hl;
    if (size <= 0 || d + size > end) break;
    const f = b.subarray(d, d + size);
    if (id === 'TIT2' || id === 'TT2') out.title = clean(decodeText(f.subarray(1), f[0]));
    else if (id === 'TPE1' || id === 'TP1') out.artist = clean(decodeText(f.subarray(1), f[0]));
    else if (id === 'TALB' || id === 'TAL') out.album = clean(decodeText(f.subarray(1), f[0]));
    else if ((id === 'APIC' || id === 'PIC') && !out.cover) {
      const enc = f[0];
      let p = 1, mime;
      if (v22) { const fmt = String.fromCharCode(f[1], f[2], f[3]).toLowerCase(); mime = fmt === 'png' ? 'image/png' : 'image/jpeg'; p = 4; }
      else { const ml = termLen(f, 1, 0); mime = new TextDecoder('latin1').decode(f.subarray(1, 1 + ml - 1)) || 'image/jpeg'; p = 1 + ml; }
      p += 1;   // 图片类型
      p += termLen(f, p, enc);   // 描述
      if (p < f.length) out.cover = { mime: mime.includes('/') ? mime : 'image/' + mime, data: f.subarray(p) };
    }
    o = d + size;
  }
  return out;
}

// —— 占位波形：没有真波形时按文件名生成一条稳定的「像音乐」的起伏（默认封面 / 波形轨用）——
export function fakePeaks(seed, n = 48) {
  let h = 2166136261;
  for (const ch of String(seed || 'a')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
  const out = [];
  for (let i = 0; i < n; i++) {
    const env = 0.55 + 0.45 * Math.sin((i / n) * Math.PI);   // 两头收、中间满
    out.push(Math.round((0.18 + 0.82 * env * (0.35 + 0.65 * rnd())) * 100) / 100);
  }
  return out;
}

// 把任意长度的峰值数组重采样成 n 点（取每段最大）
export function resamplePeaks(p, n) {
  if (!p || !p.length || n <= 0) return [];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * p.length / n), b = Math.max(a + 1, Math.floor((i + 1) * p.length / n));
    let m = 0;
    for (let j = a; j < b && j < p.length; j++) if (p[j] > m) m = p[j];
    out[i] = m;
  }
  return out;
}

// 解码后的 PCM（AudioBuffer 各声道的 Float32Array）→ 波形峰值，与服务端 /api/file/media-peaks 同一算法：
// 多声道取平均成单声道，每 0.05s 一块取绝对值峰值，再按块最大重采样到 ≤n 点、按全局最大归一到 0..1（两位小数）。
// 给服务端不认识的音频（vertex / 上传 / 本地 blob）在前端自己出真波形，和云端 mp3 的波形一个样子
export function peaksFromChannels(chs, rate, n = 400) {
  const list = (chs || []).filter((c) => c && c.length);
  if (!list.length || !(rate > 0) || n <= 0) return [];
  let len = Infinity;
  for (const c of list) if (c.length < len) len = c.length;
  const B = Math.max(1, Math.round(rate * 0.05)), nc = list.length;
  const blocks = [];
  for (let i = 0; i < len; i += B) {
    const e = Math.min(len, i + B);
    let m = 0;
    for (let j = i; j < e; j++) {
      let v = 0;
      for (let c = 0; c < nc; c++) v += list[c][j];
      v = Math.abs(v / nc);
      if (v > m) m = v;
    }
    blocks.push(m);
  }
  const res = resamplePeaks(blocks, Math.min(n, blocks.length));
  let max = 1 / 32768;   // 同服务端 max 起步 1（s16 的一个最小刻度）：全静音不除零
  for (const v of res) if (v > max) max = v;
  return res.map((v) => Math.round((v / max) * 100) / 100);
}

// 滚轮 → 整格数（上 / 右滚为正）：触控板的细碎 delta 攒够一格（≈px 像素）才出一步，停 idleMs 清零重来；
// 一串滚动的第一下只要有 0.4 格就算一格（有的鼠标一格只报 40~60px）。deltaMode 1（行）/ 2（页）先换算成像素
export function wheelStepper(px = 100, idleMs = 400) {
  let acc = 0, last = -Infinity;
  return (e, now = Date.now()) => {
    const k = e.deltaMode === 1 ? px / 3 : e.deltaMode === 2 ? px : 1;
    const dy = (e.deltaY || 0) * k, dx = (e.deltaX || 0) * k;
    let d = Math.abs(dy) >= Math.abs(dx) ? -dy : dx;
    if (now - last > idleMs) { acc = 0; if (Math.abs(d) >= px * 0.4 && Math.abs(d) < px) d = Math.sign(d) * px; }
    last = now;
    acc += d;
    const n = acc > 0 ? Math.floor(acc / px) : Math.ceil(acc / px);
    acc -= n * px;
    return n;
  };
}

// Svelte action：use:wheelStep={fn}，滚一格回调 fn(整格数)。非被动监听：要 preventDefault，免得页面跟着滚、
// 画廊的滚轮缩放跟着缩；Ctrl+滚轮（浏览器缩放 / 触控板捏合）不拦
export function wheelStep(node, fn) {
  let cb = fn;
  const step = wheelStepper();
  const on = (e) => {
    if (e.ctrlKey || typeof cb !== 'function') return;
    e.preventDefault(); e.stopPropagation();
    const n = step(e, e.timeStamp || Date.now());
    if (n) cb(n);
  };
  node.addEventListener('wheel', on, { passive: false });
  return { update(f) { cb = f; }, destroy() { node.removeEventListener('wheel', on); } };
}
