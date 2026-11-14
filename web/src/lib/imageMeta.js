// 图片文件头解析：原图像素尺寸、是否动图、EXIF（拍摄时间 / 相机 / 镜头 / 曝光参数）。
// 只用 Range 拉文件头几十 KB、不解码像素——画廊上屏的常是 1280 预览档，缩放上限、「100%」与文件信息里的尺寸
// 都要原图的真实像素，靠它补；webp / png 的预览档会丢动画，也靠它判断要不要直接上原图。
//
//   parseImageMeta(bytes)  → { format, w, h, orient, anim, exif } | { need }（JPEG 的 SOF 落在已读范围之外：need = 还要读到的字节偏移）
//   imageMeta(item)        → Promise<同上 | null>（按 item.key 缓存；dataUrl 条目直接解 base64 头）
//
// 尺寸按「显示方向」给：EXIF 方向 5–8（竖拍原始像素是横的）宽高互换，与浏览器 image-orientation: from-image 一致。

const HEAD = 72 * 1024;        // 首读：EXIF（含内嵌缩略）+ 量化表 + SOF 通常都在这里
const MORE = 64 * 1024;        // JPEG 段链没读完时每次补拉
const MAX_ROUNDS = 3;

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const ascii = (b, o, n) => { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; };

// —— EXIF（TIFF 结构）——
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
function parseTiff(b, base, len) {
  const end = Math.min(b.length, base + len);
  if (base + 8 > end) return null;
  const order = ascii(b, base, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const r16 = (o) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : u32be(b, o));
  const s32 = (o) => r32(o) | 0;
  const readIfd = (off) => {
    const out = new Map();
    const p = base + off;
    if (!off || p + 2 > end) return out;
    const n = r16(p);
    for (let i = 0; i < n && i < 512; i++) {
      const e = p + 2 + i * 12;
      if (e + 12 > end) break;
      const tag = r16(e), type = r16(e + 2), count = r32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * count;
      const vo = size <= 4 ? e + 8 : base + r32(e + 8);
      if (vo + Math.min(size, 4) > end) continue;
      let v;
      if (type === 2) v = ascii(b, vo, Math.min(count, 256)).replace(/\0.*$/s, '').trim();
      else if (type === 3) v = r16(vo);
      else if (type === 4) v = r32(vo);
      else if (type === 9) v = s32(vo);
      else if (type === 5 || type === 10) {
        if (vo + 8 > end) continue;
        const num = type === 5 ? r32(vo) : s32(vo), den = type === 5 ? r32(vo + 4) : s32(vo + 4);
        v = den ? num / den : 0;
        if (tag === 0x829a) v = { num, den };   // 曝光时间保留分数（1/120 比 0.00833 好读）
      } else v = null;
      out.set(tag, v);
    }
    return out;
  };
  const ifd0 = readIfd(r32(base + 4));
  const sub = ifd0.has(0x8769) ? readIfd(ifd0.get(0x8769)) : new Map();
  const exif = {
    make: ifd0.get(0x010f) || '',
    model: ifd0.get(0x0110) || '',
    date: sub.get(0x9003) || sub.get(0x9004) || ifd0.get(0x0132) || '',
    lens: sub.get(0xa434) || '',
    fnum: sub.get(0x829d) || 0,
    exposure: sub.get(0x829a) || null,
    iso: sub.get(0x8827) || 0,
    focal: sub.get(0x920a) || 0,
    pw: sub.get(0xa002) || 0, ph: sub.get(0xa003) || 0,
  };
  return { orient: ifd0.get(0x0112) || 1, exif };
}

function jpeg(b) {
  let o = 2, orient = 1, exif = null;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) { o++; continue; }          // 段间填充 / 容错
    const m = b[o + 1];
    if (m === 0xff) { o++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;            // 到压缩数据还没见 SOF：放弃
    const len = u16be(b, o + 2);
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (o + 9 > b.length) return { need: o + 9, partial: { orient, exif } };
      const h = u16be(b, o + 5), w = u16be(b, o + 7);
      return { format: 'jpeg', w, h, orient, anim: false, exif };
    }
    if (m === 0xe1 && !exif && ascii(b, o + 4, 6) === 'Exif\0\0') {
      if (o + 2 + len > b.length) return { need: o + 2 + len + 16 };
      const t = parseTiff(b, o + 10, len - 8);
      if (t) { orient = t.orient; exif = t.exif; }
    }
    o += 2 + len;
    if (o + 4 > b.length) return { need: o + 16, partial: { orient, exif } };
  }
  return null;
}

function png(b) {
  if (b.length < 24) return null;
  const w = u32be(b, 16), h = u32be(b, 20);
  let anim = false, o = 8;
  while (o + 8 <= b.length) {
    const len = u32be(b, o), type = ascii(b, o + 4, 4);
    if (type === 'acTL') { anim = true; break; }
    if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return { format: 'png', w, h, orient: 1, anim, exif: null };
}

function webp(b) {
  if (b.length < 30) return null;
  const c = ascii(b, 12, 4);
  let w = 0, h = 0, anim = false, exif = null, orient = 1;
  if (c === 'VP8 ') { w = u16le(b, 26) & 0x3fff; h = u16le(b, 28) & 0x3fff; }
  else if (c === 'VP8L') { const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0; w = 1 + (bits & 0x3fff); h = 1 + ((bits >>> 14) & 0x3fff); }
  else if (c === 'VP8X') {
    anim = !!(b[20] & 0x02);
    w = 1 + u24le(b, 24); h = 1 + u24le(b, 27);
    // 扩展格式里的 EXIF 块（手机导出的 webp 偶尔带）
    let o = 30;
    while (o + 8 <= b.length) {
      const len = b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24);
      if (ascii(b, o, 4) === 'EXIF') {
        let p = o + 8;
        if (ascii(b, p, 6) === 'Exif\0\0') p += 6;
        const t = parseTiff(b, p, len);
        if (t) { exif = t.exif; orient = t.orient; }
        break;
      }
      o += 8 + len + (len & 1);
    }
  } else return null;
  return { format: 'webp', w, h, orient, anim, exif };
}

function gif(b) {
  if (b.length < 10) return null;
  return { format: 'gif', w: u16le(b, 6), h: u16le(b, 8), orient: 1, anim: null, exif: null };
}

/** 解析文件头字节（Uint8Array）。返回 meta、{ need }（还要读更多）或 null（认不出 / 不是图） */
export function parseImageMeta(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 12) return null;
  let r = null;
  if (b[0] === 0xff && b[1] === 0xd8) r = jpeg(b);
  else if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') r = png(b);
  else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') r = webp(b);
  else if (ascii(b, 0, 4) === 'GIF8') r = gif(b);
  if (!r || r.need) return r;
  if (r.orient >= 5 && r.orient <= 8) { const w = r.w; r.w = r.h; r.h = w; }
  if (!(r.w > 0 && r.h > 0)) return null;
  return r;
}

// —— 展示用格式化（文件信息面板）——
/** EXIF 时间「2024:05:01 12:34:56」→「2024-05-01 12:34」 */
export function fmtExifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '';
}
/** 相机：厂商 + 型号（型号里已含厂商名就不重复） */
export function fmtCamera(ex) {
  if (!ex) return '';
  const make = String(ex.make || '').trim(), model = String(ex.model || '').trim();
  if (!model) return make;
  if (!make || model.toLowerCase().startsWith(make.toLowerCase().split(/\s+/)[0])) return model;
  return make + ' ' + model;
}
/** 曝光参数：f/1.8 · 1/120 s · ISO 100 · 26 mm */
export function fmtExposure(ex) {
  if (!ex) return '';
  const out = [];
  if (ex.fnum > 0) out.push('f/' + (+ex.fnum.toFixed(1)));
  const e = ex.exposure;
  if (e && e.den > 0 && e.num > 0) {
    const sec = e.num / e.den;
    out.push(sec >= 1 ? (+sec.toFixed(1)) + ' s' : '1/' + Math.round(e.den / e.num) + ' s');
  }
  if (ex.iso > 0) out.push('ISO ' + ex.iso);
  if (ex.focal > 0) out.push((+ex.focal.toFixed(1)) + ' mm');
  return out.join(' · ');
}

// —— 取文件头 ——
async function readRange(url, from, len, signal) {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${from + len - 1}` }, signal, credentials: 'same-origin' });
  if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
  // 服务端不认 Range（回 200 整文件）：读够就掐断，别把 40MB 原图全拉下来
  const whole = res.status === 200;
  const reader = res.body?.getReader?.();
  if (!reader) return { bytes: new Uint8Array(await res.arrayBuffer()).slice(whole ? from : 0, whole ? from + len : len), whole };
  const parts = []; let got = 0;
  const want = whole ? from + len : len;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (got >= want) { try { reader.cancel(); } catch {} break; }
  }
  const all = new Uint8Array(got);
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  return { bytes: whole ? all.slice(from, from + len) : all, whole };
}

function dataUrlHead(u, n) {
  const i = u.indexOf(',');
  if (i < 0 || !/;base64$/i.test(u.slice(0, i))) return null;
  const b64 = u.slice(i + 1, i + 1 + Math.ceil(n / 3) * 4);
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let k = 0; k < s.length; k++) out[k] = s.charCodeAt(k) & 255;
    return out;
  } catch { return null; }
}

const cache = new Map();
/** 取条目原图的头部信息（失败 / 认不出给 null）。同一条目只拉一次 */
export function imageMeta(item, { url } = {}) {
  if (!item) return Promise.resolve(null);
  const key = item.key || item.url;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    if (item.dataUrl) return parseImageMeta(dataUrlHead(item.dataUrl, 512 * 1024) || []) || null;
    const src = url || item.url;
    if (!src || /^blob:/.test(src)) return null;
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ac?.abort(), 10000);   // 服务端卡住也别让缓存里挂一个永远不落定的 Promise
    let buf = new Uint8Array(0), r = null;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const from = buf.length;
        const want = round === 0 ? HEAD : Math.max(MORE, (r?.need || 0) - from + 1024);
        const got = await readRange(src, from, want, ac?.signal);
        if (!got.bytes.length) break;
        const all = new Uint8Array(buf.length + got.bytes.length);
        all.set(buf); all.set(got.bytes, buf.length); buf = all;
        r = parseImageMeta(buf);
        if (!r || !r.need) break;
        if (got.bytes.length < want) break;        // 文件读完了还要：坏文件
      }
    } finally { clearTimeout(timer); }
    return r && !r.need ? r : null;
  })().catch(() => null);
  cache.set(key, p);
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return p;
}
