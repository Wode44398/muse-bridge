// 图片文件头解析的单测（node --test web/src/lib/imageMeta.test.js）：用手拼的最小文件头验证尺寸、方向、动图与 EXIF。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageMeta, fmtExifDate, fmtCamera, fmtExposure } from './imageMeta.js';

// —— 拼 TIFF（小端）：entries = [{ tag, type, value }]，ASCII / RATIONAL 放到数据区 ——
function tiff(ifd0, sub) {
  const bytes = [];
  const w16 = (o, v) => { bytes[o] = v & 255; bytes[o + 1] = (v >> 8) & 255; };
  const w32 = (o, v) => { for (let i = 0; i < 4; i++) bytes[o + i] = (v >>> (i * 8)) & 255; };
  // 头：II 2A00 + IFD0 偏移 8
  bytes.push(0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0);
  const layout = (entries, at) => 2 + entries.length * 12 + 4;   // 一个 IFD 的定长部分
  const ifd0Len = layout(ifd0), subAt = 8 + ifd0Len, subLen = layout(sub);
  let data = subAt + subLen;
  const put = (at, entries) => {
    w16(at, entries.length);
    entries.forEach((e, i) => {
      const p = at + 2 + i * 12;
      w16(p, e.tag); w16(p + 2, e.type);
      if (e.type === 2) {
        const s = e.value + '\0';
        w32(p + 4, s.length);
        if (s.length <= 4) for (let k = 0; k < s.length; k++) bytes[p + 8 + k] = s.charCodeAt(k);
        else { w32(p + 8, data); for (let k = 0; k < s.length; k++) bytes[data + k] = s.charCodeAt(k); data += s.length; }
      } else if (e.type === 3) { w32(p + 4, 1); w16(p + 8, e.value); }
      else if (e.type === 4) { w32(p + 4, 1); w32(p + 8, e.value === 'SUB' ? subAt : e.value); }
      else if (e.type === 5) { w32(p + 4, 1); w32(p + 8, data); w32(data, e.value[0]); w32(data + 4, e.value[1]); data += 8; }
    });
    w32(at + 2 + entries.length * 12, 0);
  };
  put(8, ifd0);
  put(subAt, sub);
  for (let i = 0; i < data; i++) if (bytes[i] == null) bytes[i] = 0;
  return bytes;
}

function jpegWith({ w = 4000, h = 3000, orient = 1, exif = true, pad = 0 } = {}) {
  const out = [0xff, 0xd8];
  if (exif) {
    const t = tiff([
      { tag: 0x010f, type: 2, value: 'Canon' },
      { tag: 0x0110, type: 2, value: 'Canon EOS R5' },
      { tag: 0x0112, type: 3, value: orient },
      { tag: 0x8769, type: 4, value: 'SUB' },
    ], [
      { tag: 0x829a, type: 5, value: [1, 125] },
      { tag: 0x829d, type: 5, value: [28, 10] },
      { tag: 0x8827, type: 3, value: 400 },
      { tag: 0x9003, type: 2, value: '2024:05:01 12:34:56' },
      { tag: 0x920a, type: 5, value: [50, 1] },
      { tag: 0xa434, type: 2, value: 'RF24-70mm F2.8 L IS USM' },
    ]);
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t];
    const len = body.length + 2;
    out.push(0xff, 0xe1, len >> 8, len & 255, ...body);
  }
  if (pad) { const len = pad + 2; out.push(0xff, 0xe2, len >> 8, len & 255, ...new Array(pad).fill(7)); }
  // 量化表占位 + SOF0
  out.push(0xff, 0xdb, 0, 4, 0, 0);
  out.push(0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  out.push(0xff, 0xda, 0, 2);
  return new Uint8Array(out);
}

test('JPEG：SOF 尺寸 + EXIF 相机 / 时间 / 曝光', () => {
  const m = parseImageMeta(jpegWith());
  assert.equal(m.format, 'jpeg');
  assert.equal(m.w, 4000); assert.equal(m.h, 3000);
  assert.equal(m.orient, 1);
  assert.equal(m.exif.make, 'Canon');
  assert.equal(m.exif.model, 'Canon EOS R5');
  assert.equal(m.exif.date, '2024:05:01 12:34:56');
  assert.equal(m.exif.lens, 'RF24-70mm F2.8 L IS USM');
  assert.equal(m.exif.iso, 400);
  assert.equal(fmtExifDate(m.exif.date), '2024-05-01 12:34');
  assert.equal(fmtCamera(m.exif), 'Canon EOS R5');
  assert.equal(fmtExposure(m.exif), 'f/2.8 · 1/125 s · ISO 400 · 50 mm');
});

test('JPEG：EXIF 方向 6 宽高互换（按显示方向给）', () => {
  const m = parseImageMeta(jpegWith({ orient: 6 }));
  assert.equal(m.orient, 6);
  assert.equal(m.w, 3000); assert.equal(m.h, 4000);
});

test('JPEG：没有 EXIF 也能拿尺寸', () => {
  const m = parseImageMeta(jpegWith({ exif: false, w: 12000, h: 800 }));
  assert.equal(m.w, 12000); assert.equal(m.h, 800);
  assert.equal(m.exif, null);
});

test('JPEG：SOF 不在已读范围里 → 报 need，补齐后解出', () => {
  const full = jpegWith({ pad: 5000 });
  const head = full.slice(0, 3000);
  const r = parseImageMeta(head);
  assert.ok(r && r.need > head.length, '应当要求继续读');
  const m = parseImageMeta(full.slice(0, r.need + 64));
  assert.equal(m.w, 4000);
});

function pngWith({ w, h, anim }) {
  const chunk = (type, data) => { const n = data.length; return [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]; };
  const be = (v) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be(w), ...be(h), 8, 6, 0, 0, 0]),
    ...(anim ? chunk('acTL', [...be(12), ...be(0)]) : []),
    ...chunk('IDAT', [1, 2, 3])]);
}

test('PNG：IHDR 尺寸 + acTL 判动图', () => {
  assert.deepEqual([parseImageMeta(pngWith({ w: 1200, h: 900 })).w, parseImageMeta(pngWith({ w: 1200, h: 900 })).h], [1200, 900]);
  assert.equal(parseImageMeta(pngWith({ w: 10, h: 10 })).anim, false);
  assert.equal(parseImageMeta(pngWith({ w: 10, h: 10, anim: true })).anim, true);
});

const riff = (fourcc, data) => {
  const n = data.length;
  const body = [...[...fourcc].map((c) => c.charCodeAt(0)), n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255, ...data];
  const total = 4 + body.length;
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, total & 255, (total >> 8) & 255, (total >> 16) & 255, 0, 0x57, 0x45, 0x42, 0x50, ...body]);
};

test('WebP：VP8X 动图标志 + 画布尺寸', () => {
  const w = 2400 - 1, h = 1600 - 1;
  const m = parseImageMeta(riff('VP8X', [0x02, 0, 0, 0, w & 255, (w >> 8) & 255, w >> 16, h & 255, (h >> 8) & 255, h >> 16]));
  assert.equal(m.format, 'webp'); assert.equal(m.anim, true);
  assert.equal(m.w, 2400); assert.equal(m.h, 1600);
});

test('WebP：VP8 有损 / VP8L 无损尺寸', () => {
  const vp8 = parseImageMeta(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 640 & 255, 640 >> 8, 480 & 255, 480 >> 8]));
  assert.deepEqual([vp8.w, vp8.h, vp8.anim], [640, 480, false]);
  const bits = (100 - 1) | ((50 - 1) << 14);
  const vp8l = parseImageMeta(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0]));
  assert.deepEqual([vp8l.w, vp8l.h], [100, 50]);
});

test('GIF：逻辑屏尺寸', () => {
  const m = parseImageMeta(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 480 & 255, 480 >> 8, 360 & 255, 360 >> 8, 0, 0]));
  assert.deepEqual([m.format, m.w, m.h], ['gif', 480, 360]);
});

test('认不出的字节给 null', () => {
  assert.equal(parseImageMeta(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])), null);
  assert.equal(parseImageMeta(new Uint8Array(0)), null);
});

test('格式化：相机名不重复厂商、长曝光按秒', () => {
  assert.equal(fmtCamera({ make: 'Apple', model: 'iPhone 15 Pro' }), 'Apple iPhone 15 Pro');
  assert.equal(fmtCamera({ make: 'SONY', model: 'ILCE-7M4' }), 'SONY ILCE-7M4');
  assert.equal(fmtCamera({ make: 'samsung', model: 'Galaxy S24' }), 'samsung Galaxy S24');
  assert.equal(fmtCamera({ make: 'NIKON CORPORATION', model: 'NIKON Z 6' }), 'NIKON Z 6');
  assert.equal(fmtExposure({ exposure: { num: 2, den: 1 } }), '2 s');
  assert.equal(fmtExifDate('bad'), '');
});
