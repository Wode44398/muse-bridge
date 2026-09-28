// 重出 dimensio 的全部品牌产物：node harness/web/brand/build.mjs（在仓库任意位置跑都行）
//   1. harness/web/src/lib/brand.ts        —— 界面组件用的几何常量（纯数据：标志三笔、字标轮廓）
//   2. harness/web/public/                  —— 独立运行时的 favicon / 触屏图标
//   3. web/public/assets/icons/dimensio*.svg —— bridge 主页 / 桌面主页的入口图标
//   4. harness/web/brand/kit/               —— 品牌资产包（SVG / PNG / ICO，给人用的）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { COLOR, MARK, PIXEL, mark, markFine, wordmark } from "./geometry.mjs";
import { appIconSVG, lockupSVG, markSVG, monoMarkSVG, wordmarkSVG } from "./svg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const REPO = path.resolve(WEB, "..", "..");
const KIT = path.join(HERE, "kit");

const rel = (file) => path.relative(REPO, file).replace(/\\/g, "/");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log("  ", rel(file));
};
// 栅格化：矢量母版按目标的两倍栅格化再缩到目标尺寸（边缘干净）；像素版（画布本身 ≤32）按 1:1 出，不重采样
const raster = (svg, size) => {
  const natural = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? size);
  const density = natural <= 32 ? 72 : 72 * Math.max(1, (2 * size) / natural);
  return sharp(Buffer.from(svg), { density }).resize(size, size);
};
const png = async (file, svg, size) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await raster(svg, size).png({ compressionLevel: 9 }).toFile(file);
  console.log("  ", rel(file));
};
const iconPng = (size) => (size <= 32 ? appIconSVG(size) : appIconSVG(1024));

// ICO：内嵌 PNG 的多尺寸图标（Vista 起的 Windows 与所有现代浏览器都认）；≤32 用像素版
async function ico(file, sizes) {
  const images = [];
  for (const s of sizes) images.push(await raster(iconPng(s), s).png().toBuffer());
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const s = sizes[i];
    const e = 6 + 16 * i;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(img.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  fs.writeFileSync(file, Buffer.concat([header, ...images]));
  console.log("  ", rel(file));
}

// ── 1. brand.ts ─────────────────────────────────────────────────────────────────────
const w = wordmark();
const m = mark();
write(
  path.join(WEB, "src", "lib", "brand.ts"),
  `// 由 harness/web/brand/build.mjs 生成，别手改——改 brand/geometry.mjs 再重跑。
// dimensio 的标志与字标几何（纯数据）。组件（components/brand/*）拿它画 SVG，颜色一律走主题令牌。

// 标志：就是 bridge 的月桥——拱、贯穿圆心的水面线、渐隐的倒影（合成整圆）。108 网格。出场动画见 components/brand/Mark.svelte。
// MARK = 月桥原样（描边，小尺寸用）；MARK_FINE = 精绘版（填充的三笔，拱有粗细、水面与倒影两头收，大尺寸用）。
export const MARK = ${JSON.stringify(m, null, 2)} as const;

export const MARK_FINE = ${JSON.stringify(markFine(), null, 2)} as const;

// 字标：思源宋体（Noto Serif SC，SIL OFL）wght 600 的「dimensio」轮廓——与 bridge 官网字标同一款字。字体单位，基线 y=0。
export const WORDMARK = ${JSON.stringify(w, null, 2)} as const;
`,
);

// ── 2. 独立运行（8799）的 favicon / 触屏图标 ─────────────────────────────────────────────
const pub = path.join(WEB, "public");
write(path.join(pub, "favicon.svg"), appIconSVG(64));
await png(path.join(pub, "icon-180.png"), appIconSVG(1024, { square: true }), 180);
await png(path.join(pub, "icon-512.png"), appIconSVG(1024), 512);

// ── 3. bridge 入口图标 ───────────────────────────────────────────────────────────────
// 主页 / 桌面主页的入口格本身就是一块玻璃瓦片，邻居（Claude 小人、ChatGPT、Gemini）都是纯图形——
// 这里也给纯图形，按玻璃明暗二选一（与 ChatGPT 同一套约定：light = 深底用的象牙版，dark = 亮底用的墨色版）。
const icons = path.join(REPO, "web", "public", "assets", "icons");
write(path.join(icons, "dimensio.svg"), appIconSVG(64));
write(path.join(icons, "dimensio-light.svg"), markSVG({ color: COLOR.ivory, size: 64, pad: 1, id: "dil" }));
write(path.join(icons, "dimensio-dark.svg"), markSVG({ color: COLOR.ink, size: 64, pad: 1, id: "did" }));

// ── 4. 品牌资产包 ─────────────────────────────────────────────────────────────────────
console.log("kit:");
// 先清掉本脚本自己的旧产物（改名 / 去掉的变体不留尸体）；png/cover*.png 归 cover.mjs 管，不动
fs.rmSync(path.join(KIT, "svg"), { recursive: true, force: true });
if (fs.existsSync(path.join(KIT, "png"))) {
  for (const f of fs.readdirSync(path.join(KIT, "png"))) if (/^(app-icon|wordmark|lockup|mark)/.test(f)) fs.rmSync(path.join(KIT, "png", f));
}
write(path.join(KIT, "svg", "wordmark.svg"), wordmarkSVG({ height: 120 }));
write(path.join(KIT, "svg", "wordmark-reverse.svg"), wordmarkSVG({ color: COLOR.ivory, height: 120 }));
write(path.join(KIT, "svg", "mark.svg"), markSVG({ size: 256 }));
write(path.join(KIT, "svg", "mark-reverse.svg"), markSVG({ color: COLOR.ivory, size: 256 }));
write(path.join(KIT, "svg", "mark-flat.svg"), markSVG({ size: 256, grad: false }));
write(path.join(KIT, "svg", "lockup.svg"), lockupSVG({ height: 160 }));
write(path.join(KIT, "svg", "lockup-reverse.svg"), lockupSVG({ color: COLOR.ivory, height: 160 }));
write(path.join(KIT, "svg", "lockup-tile.svg"), lockupSVG({ height: 160, tile: true }));
write(path.join(KIT, "svg", "app-icon.svg"), appIconSVG(1024));
write(path.join(KIT, "svg", "app-icon-maskable.svg"), appIconSVG(1024, { bleed: true }));
write(path.join(KIT, "svg", "app-icon-monochrome.svg"), monoMarkSVG(432));
write(path.join(KIT, "svg", "favicon.svg"), appIconSVG(64));
for (const s of [1024, 512, 256, 192, 180, 128, 64, 48]) await png(path.join(KIT, "png", `app-icon-${s}.png`), appIconSVG(1024), s);
for (const s of Object.keys(PIXEL).map(Number)) await png(path.join(KIT, "png", `app-icon-${s}.png`), appIconSVG(s), s);
await png(path.join(KIT, "png", "app-icon-maskable-512.png"), appIconSVG(1024, { bleed: true }), 512);
await ico(path.join(KIT, "favicon.ico"), [16, 20, 24, 32, 48, 64]);
// 字标 / 组合 PNG（透明底，高 240 = 2 倍）
for (const [name, svg, h] of [
  ["wordmark@2x.png", wordmarkSVG({ height: 120 }), 240],
  ["wordmark-reverse@2x.png", wordmarkSVG({ color: COLOR.ivory, height: 120 }), 240],
  ["lockup@2x.png", lockupSVG({ height: 160 }), 320],
  ["lockup-reverse@2x.png", lockupSVG({ color: COLOR.ivory, height: 160 }), 320],
  ["lockup-tile@2x.png", lockupSVG({ height: 160, tile: true }), 320],
]) {
  const file = path.join(KIT, "png", name);
  await sharp(Buffer.from(svg), { density: 300 }).resize({ height: h }).png({ compressionLevel: 9 }).toFile(file);
  console.log("  ", rel(file));
}
console.log(`MARK ${JSON.stringify(MARK)}`);
