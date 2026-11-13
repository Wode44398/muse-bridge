#!/usr/bin/env node
// 改版前后同状态对比图：两份 run.mjs 的输出目录，按「档 / 状态」两两并排（左旧右新），图上方一行标题。
//   node web/scripts/studio-qa/compare.mjs --a <旧输出目录> --b <新输出目录> --out <目录> [--la v2] [--lb v3] 档/状态 …
//   例：d1440/image-chain p393/ov-params-image p393-dark/drawer
// 发出去之前自己逐张看一遍：无头截图偶尔会坏（见 shotcheck.mjs），对比图里混进坏图就是误导。依赖 sharp。
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json'));
const sharp = require('sharp');
const argv = process.argv.slice(2);
const opt = { a: '', b: '', out: 'compare', la: 'v2', lb: 'v3', h: 900 };
const items = [];
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k.startsWith('--')) opt[k.slice(2)] = argv[++i];
  else items.push(k);
}
if (!opt.a || !opt.b || !items.length) throw new Error('用法：--a 旧目录 --b 新目录 --out 输出目录 档/状态 …');
mkdirSync(opt.out, { recursive: true });
const esc = (s) => String(s).replace(/[<&>"]/g, '');
const H = Number(opt.h);
for (const it of items) {
  const fa = path.join(opt.a, it + '.jpg'), fb = path.join(opt.b, it + '.jpg');
  if (!existsSync(fa) || !existsSync(fb)) { console.log('缺图，跳过：' + it); continue; }
  const one = async (f) => { const { data, info } = await sharp(f).resize({ height: H }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true }); return { data, w: info.width }; };
  const A = await one(fa), B = await one(fb);
  const gap = 24, top = 44, W = A.w + B.w + gap * 3;
  const label = (x, t) => `<text x="${x}" y="29" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="18" fill="#48453F">${esc(t)}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${top}">${label(gap, opt.la + ' · ' + it)}${label(gap * 2 + A.w, opt.lb + ' · ' + it)}</svg>`;
  const out = path.join(opt.out, it.replace(/[\\/]/g, '__') + '.jpg');
  await sharp({ create: { width: W, height: H + top + gap, channels: 3, background: '#E2DDD1' } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, { input: A.data, left: gap, top }, { input: B.data, left: gap * 2 + A.w, top }])
    .jpeg({ quality: 86 }).toFile(out);
  console.log(out);
}
