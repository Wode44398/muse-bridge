// 纯 JS 的 PNG 缩小（零第三方依赖，客户端的 app-core 里没有 sharp）。
//
// 用途：给用户自己的浏览器（Web Bridge）截图时不能让 Chromium 代缩——Page.captureScreenshot 带 clip 且
// scale≠1 时，渲染端会临时套一层设备指标覆盖来出图；截图途中链路断了（客户端重启、扩展重连、会话被回收），
// 这层覆盖就留在页面上：页面缩在窗口左上角、四周空着，CDP 的 clear / 重设都撤不掉，只有刷新或改窗口大小才好
// （2026-11-03 Edge 156 实测）。所以那条路上按原尺寸截（scale 1 打断了也不留痕），再在这里缩。
//
// 只认截图出来的那几种：8 位、无隔行、灰度 / RGB / 灰度+α / RGBA。缩放按面积平均（缩小时最清楚，不会出摩尔纹）。
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG → { width, height, channels, data(Uint8Array，逐行紧排) } */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG');
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const name = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (name === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; type = body[9]; interlace = body[12];
    } else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    off += 12 + len;
  }
  const channels = CHANNELS[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`不支持的 PNG（位深 ${depth}，类型 ${type}，隔行 ${interlace}）`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 0xff;
    }
    prev = row;
  }
  return { width, height, channels, data: out };
}

export function encodePng({ width, height, channels, data }) {
  const type = { 1: 0, 3: 2, 2: 4, 4: 6 }[channels];
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // 过滤器 Sub：截图大片同色，压得比不过滤小得多，又比逐行挑过滤器快
    const o = y * (stride + 1);
    raw[o] = 1;
    const row = data.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (row[i] - (i >= channels ? row[i - channels] : 0)) & 0xff;
  }
  const chunk = (name, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(name, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = type; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** 按面积平均缩小到 width×height（只缩不放；目标不小于原图就原样返回）。 */
export function scalePng(buf, width, height) {
  const img = decodePng(buf);
  const W = Math.max(1, Math.round(width)), H = Math.max(1, Math.round(height || img.height * W / img.width));
  if (W >= img.width && H >= img.height) return buf;
  const { channels: ch, data } = img;
  const sx = img.width / W, sy = img.height / H;
  const out = new Uint8Array(W * H * ch);
  const acc = new Float64Array(ch);
  for (let y = 0; y < H; y++) {
    const y0 = y * sy, y1 = y0 + sy;
    for (let x = 0; x < W; x++) {
      const x0 = x * sx, x1 = x0 + sx;
      acc.fill(0);
      let area = 0;
      for (let yy = Math.floor(y0); yy < Math.min(img.height, Math.ceil(y1)); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.min(img.width, Math.ceil(x1)); xx++) {
          const w = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
          const p = (yy * img.width + xx) * ch;
          for (let c = 0; c < ch; c++) acc[c] += data[p + c] * w;
          area += w;
        }
      }
      const q = (y * W + x) * ch;
      for (let c = 0; c < ch; c++) out[q + c] = Math.round(acc[c] / area);
    }
  }
  return encodePng({ width: W, height: H, channels: ch, data: out });
}
