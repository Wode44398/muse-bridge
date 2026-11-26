// 作品的宽高 / 波形（media-probe.mjs）：文件头解析、WAV 解析与波形公式、补侧车（含硬链接的侧车不改到另一侧）。
// 全用现造的小文件，不读真媒体库、不起 ffmpeg。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-probe-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');

const P = await import('./media-probe.mjs');
const media = await import('@bridge/core/vertex-media.mjs');
const { publicAsset, listAssets } = await import('./assets.mjs');

// —— 造文件 ——
function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
// JPEG：SOI + 一个 APP1（pad 字节）+ SOF0；pad 大于 256KB 时 SOF 落在头之外
function jpeg(w, h, pad = 10) {
  const parts = [Buffer.from([0xff, 0xd8])];
  let left = pad;
  while (left > 0) {
    const n = Math.min(left, 65533);
    const seg = Buffer.alloc(4 + n); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(n + 2, 2);
    parts.push(seg); left -= n;
  }
  const sof = Buffer.alloc(19); sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}
function webp(kind, w, h) {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(32, 4); b.write('WEBP', 8, 'ascii'); b.write(kind, 12, 'ascii');
  if (kind === 'VP8X') { b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); }
  if (kind === 'VP8 ') { b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); }
  if (kind === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21); }
  return b;
}
// 16-bit PCM WAV；samples(frameIndex, channel) → -1..1；extra = 在 fmt 和 data 之间插一个 LIST 块
function wav({ rate = 8000, channels = 1, frames = 8000, samples = () => 0, extra = false, extensible = false, dataLen } = {}) {
  const fmtLen = extensible ? 40 : 16;
  const fmt = Buffer.alloc(8 + fmtLen);
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(fmtLen, 4);
  fmt.writeUInt16LE(extensible ? 0xfffe : 1, 8); fmt.writeUInt16LE(channels, 10); fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * 2, 16); fmt.writeUInt16LE(channels * 2, 20); fmt.writeUInt16LE(16, 22);
  if (extensible) { fmt.writeUInt16LE(22, 24); fmt.writeUInt16LE(1, 32); }
  const list = extra ? Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([5, 0, 0, 0]), Buffer.from('INFOx'), Buffer.from([0])]) : Buffer.alloc(0);
  const pcm = Buffer.alloc(frames * channels * 2);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples(f, c) * 32767))), (f * channels + c) * 2);
  const data = Buffer.alloc(8); data.write('data', 0, 'ascii'); data.writeUInt32LE(dataLen ?? pcm.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, list, data, pcm]);
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

test('图像文件头：PNG / JPEG（SOF 在大 EXIF 后面）/ WebP 三种 / GIF', () => {
  const dir = path.join(tmp, 'hdr'); mkdirSync(dir, { recursive: true });
  const put = (name, buf) => { const f = path.join(dir, name); writeFileSync(f, buf); return f; };
  assert.deepEqual(P.fileImageDims(put('a.png', png(1536, 1024)), 'png'), [1536, 1024]);
  assert.deepEqual(P.fileImageDims(put('a.jpg', jpeg(800, 1200)), 'jpg'), [800, 1200]);
  assert.deepEqual(P.fileImageDims(put('b.jpg', jpeg(640, 480, 300 * 1024)), 'jpg'), [640, 480], 'SOF 不在头 256KB 里时整个读');
  assert.deepEqual(P.fileImageDims(put('x.webp', webp('VP8X', 2048, 1152)), 'webp'), [2048, 1152]);
  assert.deepEqual(P.fileImageDims(put('l.webp', webp('VP8L', 300, 200)), 'webp'), [300, 200]);
  assert.deepEqual(P.fileImageDims(put('y.webp', webp('VP8 ', 1024, 576)), 'webp'), [1024, 576]);
  const gif = Buffer.alloc(16); gif.write('GIF89a', 0, 'ascii'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(200, 8);
  assert.deepEqual(P.fileImageDims(put('g.gif', gif), 'gif'), [320, 200]);
  assert.equal(P.fileImageDims(put('bad.png', Buffer.from('nope')), 'png'), null);
  assert.equal(P.fileImageDims(path.join(dir, 'missing.png'), 'png'), null);
});

test('WAV：按块走（夹着 LIST、EXTENSIBLE、data 长度写成 0）、多声道时长', () => {
  const a = P.parseWav(wav({ rate: 8000, channels: 2, frames: 12000, extra: true }));
  assert.equal(a.channels, 2); assert.equal(a.bits, 16); assert.equal(a.format, 1);
  assert.equal(a.duration, 1.5);
  assert.equal(P.parseWav(wav({ extensible: true, frames: 4000 })).format, 1);
  assert.equal(P.parseWav(wav({ frames: 4000, dataLen: 0 })).duration, 0.5, '流式写出的 data 长度 0：按文件实长');
  assert.equal(P.parseWav(Buffer.from('RIFF....WAVEjunk')), null);
  assert.equal(P.parseWav(png(1, 1)), null);
});

test('波形：120 格、整体归一、0.8 次方、三位小数；静音全 0；双声道两路都算', () => {
  // 前一半静音，后一半满幅方波：后 60 格全是 1，前 60 格是 0
  const half = P.wavPeaks(wav({ frames: 12000, samples: (f) => (f < 6000 ? 0 : (f % 2 ? 1 : -1)) }));
  assert.equal(half.peaks.length, 120);
  assert.equal(half.duration, 1.5);
  assert.ok(half.peaks.slice(0, 59).every((v) => v === 0));
  assert.ok(half.peaks.slice(61).every((v) => v === 1));
  // 两段不同幅度：比值按公式算（峰值 0.35 + RMS×0.65×2.2，方波的 RMS = 幅度），再 0.8 次方
  const two = P.wavPeaks(wav({ frames: 12000, samples: (f) => (f % 2 ? 1 : -1) * (f < 6000 ? 0.25 : 1) }));
  const expect = Math.round(Math.pow((0.25 * 0.35 + 0.25 * 0.65 * 2.2) / (0.35 + 0.65 * 2.2), 0.8) * 1000) / 1000;
  assert.ok(Math.abs(two.peaks[10] - expect) <= 0.002, `${two.peaks[10]} ≈ ${expect}`);
  assert.equal(Math.max(...two.peaks), 1);
  assert.ok(two.peaks.every((v) => v >= 0 && v <= 1 && Math.round(v * 1000) === v * 1000));
  assert.ok(P.wavPeaks(wav({ frames: 8000 })).peaks.every((v) => v === 0));
  // 左声道静音、右声道有声：照样有波形
  const st = P.wavPeaks(wav({ channels: 2, frames: 8000, samples: (f, c) => (c ? (f % 2 ? 0.5 : -0.5) : 0) }));
  assert.equal(Math.max(...st.peaks), 1);
  // 很短（帧数比格数少）：不炸，空格是 0
  assert.equal(P.wavPeaks(wav({ frames: 50, samples: () => 0.5 })).peaks.length, 120);
});

test('补侧车：图像缺宽高读头补上写回；侧车是硬链接时另一侧不变；publicAsset 带 peaks / duration', async () => {
  const dir = path.join(tmp, 'media-a'); mkdirSync(dir, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  media.save(id, png(900, 1600), 'png', { kind: 'image', prompt: '竖图' }, dir);
  // 模拟旧作品：侧车里没有宽高；再给侧车做一个硬链接（测试环境的媒体库就是这样硬链接自正式库的）
  const side = path.join(dir, id + '.json');
  const rec0 = JSON.parse(readFileSync(side, 'utf8'));
  writeFileSync(side, JSON.stringify({ ...rec0, width: undefined, height: undefined }));
  const twin = path.join(tmp, 'twin.json');
  linkSync(side, twin);
  assert.equal(statSync(side).nlink, 2);
  const before = readFileSync(twin, 'utf8');
  const out = listAssets(dir, {});
  const a = out.items.find((x) => x.id === id);
  assert.equal(a.w, 900); assert.equal(a.h, 1600);
  assert.equal(JSON.parse(readFileSync(side, 'utf8')).width, 900, '写回侧车，下次不再算');
  assert.equal(readFileSync(twin, 'utf8'), before, '硬链接的另一侧没被改到');
  assert.equal(statSync(twin).nlink, 1);
  // 旧侧车没有 params（参数从散字段捡）：补上的宽高不能混进参数
  const lid = '44444444-4444-4444-8444-444444444444';
  media.save(lid, png(640, 360), 'png', { kind: 'image', prompt: '旧', aspectRatio: '16:9' }, dir);
  const ls = path.join(dir, lid + '.json');
  writeFileSync(ls, JSON.stringify({ ...JSON.parse(readFileSync(ls, 'utf8')), width: undefined, height: undefined }));
  const la = listAssets(dir, {}).items.find((x) => x.id === lid);
  assert.equal(la.w, 640);
  assert.deepEqual(la.params, { aspectRatio: '16:9' });

  const aid = '22222222-2222-4222-8222-222222222222';
  media.save(aid, wav({ frames: 16000, samples: (f) => Math.sin(f / 10) }), 'wav', { kind: 'audio', prompt: '你好' }, dir);
  assert.equal(publicAsset(media.get(aid, dir)).peaks, undefined);
  const r = await P.ensurePeaks(dir, aid);
  assert.equal(r.peaks.length, 120);
  assert.equal(r.duration, 2);
  const pub = publicAsset(media.get(aid, dir));
  assert.equal(pub.peaks.length, 120);
  assert.equal(pub.duration, 2);
  assert.equal(await P.ensurePeaks(dir, '33333333-3333-4333-8333-333333333333'), null, '没有这件作品');
  assert.equal(await P.ensurePeaks(dir, id), null, '图像不算波形');
});
