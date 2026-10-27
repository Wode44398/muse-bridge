// 内置明亮壁纸「层峦」：程序化生成的山景 + 与之严格对齐的深度图（自有素材，替换来源不明的多洛米蒂照片）。
//
//   node scripts/spatial-depth/gen-ridges.mjs [--demo]
//
// 产物（固定种子，重跑字节级一致）：
//   web/public/assets/wallpapers/ridges.jpg          壁纸本体，3200×2400（4:3，cover 居中裁切；中央 9:16 也成构图）
//   web/public/assets/wallpapers/depth/ridges.png    深度图 1280×960，白 = 近、黑 = 远（空间壁纸 / SpatialLayer 用）
//   --demo 另写 web/demo/particle-reveal/bg.jpg（1600×1200）+ depth.png（800×600），粒子演示页用
//
// 画面由前到后五层：近处草坡 → 左侧缓坡草甸 → 林带（针叶树冠剪影）→ 浅色石灰岩群峰 → 天空（渐变、日晕、卷云）。
// 每层的上沿是一条按列算好的轮廓线，深度图按「像素落在哪一层」直接给值，不用任何深度估计模型，
// 所以层与层的分界在原图和深度图里完全重合。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_IMG = path.join(ROOT, 'web', 'public', 'assets', 'wallpapers', 'ridges.jpg');
const OUT_DEPTH = path.join(ROOT, 'web', 'public', 'assets', 'wallpapers', 'depth', 'ridges.png');
const DEMO_DIR = path.join(ROOT, 'web', 'demo', 'particle-reveal');
const SEED = 20261022;

// ── 噪声（种子化值噪声 + 分形叠加）──────────────────────────────────────────────
function hash2(i, j) {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(SEED, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 5) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) { s += amp * vnoise(x * f + o * 17.31, y * f + o * 9.17); norm += amp; amp *= 0.5; f *= 2.03; }
  return s / norm;
}
const fbm1 = (x, oct = 5) => fbm(x, 3.7, oct);
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ── 轮廓线（上沿，v 向下 0..1）──────────────────────────────────────────────────
// 石灰岩群峰：一串尖顶「帐篷」叠成主峰群（中）+ 左侧前峰 + 右侧远峰，再叠尖锐的塔峰（ridged 噪声）。
// massifBase 是不带塔峰的平滑轮廓：层内的明暗、雾气、深度渐变都按它算，免得塔峰在深度图里拉出竖条。
const tent = (u, c, h, w) => h * Math.pow(Math.max(0, 1 - Math.abs(u - c) / w), 1.25);
function massif(u) {
  return Math.max(
    tent(u, 0.47, 0.25, 0.2), tent(u, 0.56, 0.22, 0.18), tent(u, 0.38, 0.17, 0.16), tent(u, 0.65, 0.15, 0.13),
    tent(u, 0.03, 0.17, 0.15), tent(u, 0.13, 0.11, 0.11), tent(u, 0.84, 0.11, 0.1), tent(u, 0.96, 0.08, 0.08),
  );
}
const massifBase = (u) => 0.45 - massif(u);
function ridgeRock(u) {
  let spires = 0, amp = 1, f = 22, norm = 0;
  for (let o = 0; o < 4; o++) { spires += amp * (1 - Math.abs(2 * vnoise(u * f, 41.3 + o) - 1)); norm += amp; amp *= 0.55; f *= 2.1; }
  spires = Math.pow(spires / norm, 2.4);
  const k = clamp(massif(u) / 0.14);
  return massifBase(u) - 0.075 * spires * k - 0.01 * fbm1(u * 9);
}
// 林带：左高右低，树冠剪影是一排窄三角（密度随噪声成簇）
function treeTops(u, W) {
  const px = 1 / W, cell = 0.0062;
  const i0 = Math.floor(u / cell);
  let best = 0;
  for (let i = i0 - 2; i <= i0 + 2; i++) {
    if (hash2(i, 77) > 0.25 + 0.6 * fbm1(i * 0.21 + 3.1)) continue;   // 这一格没有树
    const cx = (i + 0.2 + 0.6 * hash2(i, 78)) * cell;
    const h = 0.018 + 0.022 * hash2(i, 79);
    const half = 0.0042 + 0.0022 * hash2(i, 80);
    const t = 1 - Math.abs(u - cx) / half;
    if (t > 0) best = Math.max(best, h * t + (vnoise((u - cx) * 900, i) - 0.5) * 6 * px);   // 枝叶毛边
  }
  return best;
}
const forestBase = (u) => 0.515 - 0.13 * Math.pow(1 - u, 1.7) + 0.02 * (fbm1(u * 5 + 11) - 0.5);
const ridgeForest = (u, W) => forestBase(u) - treeTops(u, W);
const ridgeMeadow = (u) => 0.655 - 0.17 * Math.pow(clamp(1 - u / 0.56), 1.5) + 0.012 * (fbm1(u * 7 + 23) - 0.5);
const ridgeFront = (u) => 0.8 - 0.035 * u + 0.022 * Math.sin(u * 4.2 + 0.8) + 0.03 * (fbm1(u * 4 + 37) - 0.5);

// ── 各层颜色 ─────────────────────────────────────────────────────────────────
const SKY_TOP = [46, 104, 190], SKY_MID = [110, 162, 222], SKY_HOR = [204, 224, 241];
const SUN = [0.79, 0.17];
function sky(u, v) {
  let c = v < 0.3 ? mix(SKY_TOP, SKY_MID, smooth(0, 0.3, v)) : mix(SKY_MID, SKY_HOR, smooth(0.3, 0.56, v));
  const dx = (u - SUN[0]) * 1.33, dy = v - SUN[1], d2 = dx * dx + dy * dy;
  c = mix(c, [255, 246, 228], clamp(0.55 * Math.exp(-d2 / 0.03) + 0.35 * Math.exp(-d2 / 0.0025)));
  // 卷云：沿一个斜向拉长的分形，阈值成丝，越往上越多，成簇分布
  const a = -0.38, cu = u * Math.cos(a) - v * Math.sin(a), cv = u * Math.sin(a) + v * Math.cos(a);
  const wisp = smooth(0.52, 0.8, fbm(cu * 2.6, cv * 15, 6));
  const cluster = smooth(0.34, 0.68, fbm(u * 1.6 + 5, v * 2.2 + 2, 4)) * clamp(0.45 + 0.75 * (1 - u));   // 左上多、右边少
  const amt = wisp * cluster * smooth(0.5, 0.06, v) * 0.9;
  return mix(c, [250, 252, 255], clamp(amt));
}
// 岩面：高度场的横向差分当受光（右上来光），暖白受光面 / 冷灰背光面，竖向冲沟压暗，坡脚碎石发白，越低雾越重
const rockH = (u, v) => fbm(u * 30, v * 11, 6) + 0.35 * fbm(u * 90, v * 8, 4);
function rock(u, v, top, base) {
  const s = clamp((v - base) / 0.22), fromTop = clamp((v - top) / 0.05);
  const du = 0.0018;
  const lit = clamp(0.55 + 4.2 * (rockH(u + du, v) - rockH(u - du, v)) + 0.3 * (u - 0.45) + 0.15 * (1 - fromTop));
  let c = mix([128, 136, 156], [214, 205, 190], smooth(0.1, 0.55, lit));
  c = mix(c, [250, 240, 222], smooth(0.55, 0.95, lit));
  const gully = smooth(0.55, 0.85, fbm(u * 160, v * 7, 4));
  c = mix(c, c.map((x) => x * 0.78), gully * 0.4 * (1 - s));
  c = c.map((x) => x * (0.95 + 0.08 * vnoise(u * 900, v * 650)));   // 岩面细纹
  c = mix(c, [230, 226, 216], smooth(0.35, 0.9, s) * 0.75);   // 坡脚碎石
  return mix(c, SKY_HOR, 0.12 + 0.26 * s);                    // 大气透视
}
function forest(u, v, top, base) {
  const s = clamp((v - base) / 0.12);
  const n = vnoise(u * 900, v * 1100) * 0.55 + fbm(u * 40, v * 40, 3) * 0.45;
  let c = mix([28, 56, 42], [68, 108, 68], n);
  c = mix(c, [92, 128, 76], smooth(0.62, 1, fbm(u * 8 + 3, v * 10, 3)) * 0.3);   // 林间亮斑
  return mix(c, [150, 178, 196], 0.3 * (1 - s) + 0.08);
}
function meadow(u, v, top, base) {
  const s = clamp((v - base) / 0.2);
  const n = fbm(u * 10, v * 26, 4), g = vnoise(u * 1400, v * 500);
  let c = mix([176, 206, 108], [126, 170, 72], smooth(0, 1, s));
  c = mix(c, c.map((x) => x * 0.9), smooth(0.5, 0.75, n) * 0.45);
  c = c.map((x) => x * (0.96 + 0.07 * g));
  return mix(c, [252, 248, 218], clamp(1 - (v - top) / 0.005) * 0.3);   // 坡顶逆光描边
}
function front(u, v, top, base) {
  const s = clamp((v - base) / (1 - base));
  const blades = vnoise(u * 1300, v * 260), patch = fbm(u * 5 + 9, v * 9, 4);
  let c = mix([124, 170, 66], [72, 116, 42], s * 0.9);
  c = mix(c, c.map((x) => x * 0.8), smooth(0.5, 0.8, patch) * 0.6);
  c = c.map((x) => x * (0.9 + 0.16 * blades));
  return mix(c, c.map((x) => x * 0.7), smooth(0.72, 1, v) * 0.5);   // 底边压暗
}

// 深度值（白近黑远）：每层一个区间，层内越往下越近（按平滑轮廓算，不随塔峰 / 树冠起伏）
const DEPTH = [
  () => 0,
  (v, base) => 0.16 + 0.08 * clamp((v - base + 0.12) / 0.34),
  (v, base) => 0.38 + 0.1 * clamp((v - base) / 0.12),
  (v, base) => 0.56 + 0.16 * clamp((v - base) / 0.2),
  (v, base) => 0.78 + 0.22 * clamp((v - base) / (1 - base)),
];
const COLOR = [(u, v) => sky(u, v), rock, forest, meadow, front];

// 渲染：按列先算四条轮廓线（及各自的平滑基线），再逐像素按覆盖度由后往前合成（边缘 1px 抗锯齿）
function render(W, H, { depth = false } = {}) {
  const ridges = [null, new Float64Array(W), new Float64Array(W), new Float64Array(W), new Float64Array(W)];
  const bases = [null, new Float64Array(W), new Float64Array(W), new Float64Array(W), new Float64Array(W)];
  for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W;
    ridges[1][x] = ridgeRock(u); ridges[2][x] = ridgeForest(u, W); ridges[3][x] = ridgeMeadow(u); ridges[4][x] = ridgeFront(u);
    bases[1][x] = massifBase(u); bases[2][x] = forestBase(u); bases[3][x] = ridges[3][x]; bases[4][x] = ridges[4][x];
  }
  const ch = depth ? 1 : 3;
  const out = Buffer.alloc(W * H * ch);
  const e = 0.75 / H;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const cov = [1, 0, 0, 0, 0];
      let base = 0;
      for (let i = 1; i <= 4; i++) {
        cov[i] = smooth(ridges[i][x] - e, ridges[i][x] + e, v);
        if (cov[i] >= 1) base = i;
      }
      const o = (y * W + x) * ch;
      if (depth) {
        let d = DEPTH[base](v, bases[base]?.[x] ?? 0);
        for (let i = base + 1; i <= 4; i++) if (cov[i] > 0) d += (DEPTH[i](v, bases[i][x]) - d) * cov[i];
        out[o] = Math.round(clamp(d) * 255);
      } else {
        let c = COLOR[base](u, v, ridges[base]?.[x] ?? 0, bases[base]?.[x] ?? 0);
        for (let i = base + 1; i <= 4; i++) if (cov[i] > 0) c = mix(c, COLOR[i](u, v, ridges[i][x], bases[i][x]), cov[i]);
        const dither = (hash2(x, y + 7919) - 0.5) * 3;   // 去色带
        out[o] = clamp(Math.round(c[0] + dither), 0, 255);
        out[o + 1] = clamp(Math.round(c[1] + dither), 0, 255);
        out[o + 2] = clamp(Math.round(c[2] + dither), 0, 255);
      }
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: ch } });
}

// --preview <目录>：小尺寸试渲染到别处（调参用），不动仓库里的产物
const pi = process.argv.indexOf('--preview');
const PREVIEW = pi > 0 ? path.resolve(process.argv[pi + 1]) : '';
const t0 = Date.now();
const [imgW, imgH, dW, dH] = PREVIEW ? [960, 720, 480, 360] : [3200, 2400, 1280, 960];
const outImg = PREVIEW ? path.join(PREVIEW, 'ridges.jpg') : OUT_IMG;
const outDepth = PREVIEW ? path.join(PREVIEW, 'ridges-depth.png') : OUT_DEPTH;
mkdirSync(path.dirname(outDepth), { recursive: true });
const img = await render(imgW, imgH).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
writeFileSync(outImg, img);
const depth = await render(dW, dH, { depth: true }).blur(1.2).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(outDepth, depth);
console.log(`壁纸 ${outImg}（${(img.length / 1024).toFixed(0)} KB）+ 深度图 ${outDepth}（${(depth.length / 1024).toFixed(0)} KB），${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (process.argv.includes('--demo')) {
  mkdirSync(DEMO_DIR, { recursive: true });
  await sharp(img).resize(1600, 1200).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(DEMO_DIR, 'bg.jpg'));
  await sharp(depth).resize(800, 600).png({ compressionLevel: 9 }).toFile(path.join(DEMO_DIR, 'depth.png'));
  console.log('演示页 ' + DEMO_DIR + '\\{bg.jpg,depth.png}');
}
