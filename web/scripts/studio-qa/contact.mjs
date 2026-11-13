#!/usr/bin/env node
// 把一批截图拼成一张对照图（人工复核 / 修前修后对比用）：
//   node web/scripts/studio-qa/contact.mjs --out sheet.jpg [--w 300] [--cols 4] [--label] a.jpg b.jpg …
//   每张缩到同宽，按列排，图下写文件名（档 / 状态）。依赖 sharp（仓库根 node_modules 里有）。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json'));
const sharp = require('sharp');
const argv = process.argv.slice(2);
const opt = { out: 'contact.jpg', w: 300, cols: 4 };
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opt.out = argv[++i];
  else if (a === '--w') opt.w = Number(argv[++i]);
  else if (a === '--cols') opt.cols = Number(argv[++i]);
  else files.push(a);
}
if (!files.length) throw new Error('没给截图');
const W = opt.w, LH = 22;
const tiles = [];
for (const f of files) {
  const img = sharp(f).resize({ width: W });
  const { data, info } = await img.jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
  const name = path.basename(path.dirname(f)) + ' / ' + path.basename(f).replace(/\.jpg$/, '');
  tiles.push({ data, h: info.height, name });
}
const cols = Math.min(opt.cols, tiles.length);
const rows = Math.ceil(tiles.length / cols);
const rowH = [];
for (let r = 0; r < rows; r++) rowH.push(Math.max(...tiles.slice(r * cols, r * cols + cols).map((t) => t.h)) + LH);
const gap = 8;
const total = { w: cols * W + (cols + 1) * gap, h: rowH.reduce((a, b) => a + b, 0) + (rows + 1) * gap };
const comp = [];
let y = gap;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const t = tiles[r * cols + c];
    if (!t) continue;
    const x = gap + c * (W + gap);
    comp.push({ input: t.data, left: x, top: y });
    const esc = t.name.replace(/[<&>]/g, '');
    comp.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${LH}"><text x="2" y="15" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" fill="#222">${esc}</text></svg>`), left: x, top: y + t.h + 2 });
  }
  y += rowH[r] + gap;
}
await sharp({ create: { width: total.w, height: total.h, channels: 3, background: '#e9e7e1' } }).composite(comp).jpeg({ quality: 82 }).toFile(opt.out);
console.log(opt.out, total.w + '×' + total.h);
