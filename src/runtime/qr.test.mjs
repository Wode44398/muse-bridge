// 自写二维码编码器：用网页端已有的 jsQR（MIT）把码解回来，比对原文。
// web/node_modules 没装（只跑服务端测试的环境）时解码那几条跳过，结构性检查照跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeQr, qrSvg, qrTerminal } from './qr.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const JSQR = path.join(here, '..', '..', 'web', 'node_modules', 'jsqr', 'dist', 'jsQR.js');
let jsQR = null;
if (existsSync(JSQR)) {
  const m = await import(pathToFileURL(JSQR).href);
  jsQR = m.default?.default || m.default || m;
}

// 码 → RGBA 位图（每模块 scale 像素，四周 4 模块静区）
function raster(q, scale = 3) {
  const quiet = 4;
  const n = (q.size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const mx = Math.floor(x / scale) - quiet, my = Math.floor(y / scale) - quiet;
    const v = q.dark(mx, my) ? 0 : 255;
    const i = (y * n + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
  }
  return { px, n };
}
function decode(q) {
  const { px, n } = raster(q);
  const r = jsQR(px, n, n, { inversionAttempts: 'dontInvert' });
  return r ? r.data : null;
}

const rnd = (len, seed) => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~:/?&=%';
  let s = '', x = seed;
  for (let i = 0; i < len; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += abc[x % abc.length]; }
  return s;
};

test('版本随长度增长，尺寸 = 4v+17', () => {
  const a = encodeQr('hi');
  assert.equal(a.version, 1);
  assert.equal(a.size, 21);
  const b = encodeQr(rnd(300, 7));
  assert.ok(b.version > 5);
  assert.equal(b.size, b.version * 4 + 17);
  assert.throws(() => encodeQr('x'.repeat(4000)), RangeError);
});

test('同一版本放得下时自动提高纠错级别', () => {
  assert.equal(encodeQr('a', { ecc: 'L' }).ecc, 'H');
  assert.equal(encodeQr('a', { ecc: 'L', boostEcc: false }).ecc, 'L');
});

test('解码回原文：各种长度 / 纠错级别 / 中文', { skip: !jsQR && 'web/node_modules/jsqr 没装' }, () => {
  const samples = [
    'https://example.com/?connect=AbCdEfGhIjKl.MnOpQrStUvWxYz0123456789&lan=192.168.1.5:8787&sid=srv_0123456789abcdef0123',
    'http://192.168.1.20:8787/?connect=abc.def',
    '连接你的 bridge 服务器 · The Bridge',
  ];
  for (let len = 1; len <= 700; len += 37) samples.push(rnd(len, len));
  for (const s of samples) {
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      let q;
      try { q = encodeQr(s, { ecc, boostEcc: false }); } catch { continue; }   // 太长放不下的级别跳过
      assert.equal(decode(q), s, `版本 ${q.version} ${ecc} 掩码 ${q.mask} 长度 ${s.length}`);
    }
  }
});

test('版本 7 以上（带版本信息块）也能解', { skip: !jsQR && 'web/node_modules/jsqr 没装' }, () => {
  for (const v of [7, 10, 14, 20, 27]) {
    const q = encodeQr(rnd(40, v), { minVersion: v, boostEcc: false });
    assert.equal(q.version, v);
    assert.equal(decode(q), rnd(40, v), '版本 ' + v);
  }
});

test('SVG：viewBox 与码一样大，只有一条 path', () => {
  const s = qrSvg('hello', { margin: 1 });
  const q = encodeQr('hello');
  assert.match(s, new RegExp(`viewBox="0 0 ${q.size + 2} ${q.size + 2}"`));
  assert.equal((s.match(/<path/g) || []).length, 1);
  assert.doesNotMatch(qrSvg('x', { color: '"/><script>' }), /<script>/);
});

test('终端字符画：行数 = (尺寸+静区)/2 向上取整，宽度 = 尺寸+静区', () => {
  const q = encodeQr('hello');
  const n = q.size + 4;
  const lines = qrTerminal('hello').split('\n');
  assert.equal(lines.length, Math.ceil(n / 2));
  for (const l of lines) assert.equal([...l].length, n);
  // 静区是浅色：深色终端上第一行整行都是前景色块
  assert.match(lines[0], /^█+$/);
  const ascii = qrTerminal('hello', { ascii: true }).split('\n');
  assert.equal(ascii.length, n);
  assert.equal(ascii[0].length, n * 2);
});
