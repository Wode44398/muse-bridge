// 由 geometry.mjs 拼出各种 SVG 字符串（构建脚本与品牌手册页共用）。
import { COLOR, TILE_RADIUS, f3, mark, markFine, pixelMark, r1, wordmark } from "./geometry.mjs";

const open = (w, h, vb, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}"${extra}>`;

const fadeDefs = (id, m, color) =>
  `<defs><linearGradient id="${id}" x1="0" y1="${m.fade.y1}" x2="0" y2="${m.fade.y2}" gradientUnits="userSpaceOnUse">` +
  `<stop offset="0" stop-color="${color}" stop-opacity="${m.fade.o0}"/><stop offset="1" stop-color="${color}" stop-opacity="${m.fade.o1}"/></linearGradient></defs>`;

// 标志本体（108 网格），默认精绘版（填充的三笔）。grad：倒影走渐隐（否则用单一不透明度，单色层 / 不支持渐变的场合）；
// id：渐变 id 防重名；transform：整枚标志的变换（品牌手册画出场中间帧用）；simple：月桥原样的描边版（小尺寸 / 对照）
export function markBody(color, { grad = true, id = "dmf", simple = false, transform = "" } = {}) {
  const t = transform ? ` transform="${transform}"` : "";
  if (simple) {
    const m = mark();
    const reflStroke = grad ? `url(#${id})` : color;
    const reflOp = grad ? "" : ` stroke-opacity="${m.fade.flat}"`;
    return (
      (grad ? fadeDefs(id, m, color) : "") +
      `<g fill="none" stroke="${color}"${t}>` +
      `<path d="${m.arch}" stroke-width="${m.archW}"/>` +
      `<path d="${m.line}" stroke-width="${m.lineW}" stroke-linecap="round"/>` +
      `<path d="${m.refl}" stroke="${reflStroke}" stroke-width="${m.reflW}" stroke-linecap="round"${reflOp}/>` +
      `</g>`
    );
  }
  const m = markFine();
  const reflFill = grad ? `url(#${id})` : color;
  const reflOp = grad ? "" : ` fill-opacity="${m.fade.flat}"`;
  return (
    (grad ? fadeDefs(id, m, color) : "") +
    `<g fill="${color}"${t}>` +
    `<path d="${m.arch}"/>` +
    `<path d="${m.line}"/>` +
    `<path d="${m.refl}" fill="${reflFill}"${reflOp}/>` +
    `</g>`
  );
}

// 像素版本体（size×size 瓦片的像素坐标）：水面线落在整像素行上，弧线照常抗锯齿
function pixelBody(size, color) {
  const p = pixelMark(size);
  return (
    `<g fill="none" stroke="${color}">` +
    `<path d="${p.arch}" stroke-width="${p.archW}"/>` +
    `<path d="${p.line}" stroke-width="${p.lineW}" stroke-linecap="round"/>` +
    `<path d="${p.refl}" stroke-width="${p.reflW}" stroke-opacity="${p.reflOpacity}" stroke-linecap="round"/>` +
    `</g>`
  );
}

// 标志（紧包围盒 + pad，方形画布）
export function markSVG({ color = COLOR.ink, size = 64, pad = 6, grad = true, id = "dmf", simple = false } = {}) {
  const m = simple ? mark() : markFine();
  const side = Math.max(m.box.w, m.box.h) + 2 * pad;
  const cx = m.box.x + m.box.w / 2, cy = m.box.y + m.box.h / 2;
  const vb = [cx - side / 2, cy - side / 2, side, side].map(f3);
  return open(size, size, vb.join(" ")) + markBody(color, { grad, id, simple }) + `</svg>`;
}

const tileDefs = (id = "dmt") =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLOR.tile[0]}"/><stop offset="1" stop-color="${COLOR.tile[1]}"/></linearGradient>`;

// App 图标：暖墨圆角瓦片 + 象牙标志（与月桥同一块瓦片：rx 22.37%、上亮下暗、内缘 8% 白细线）。
// size ≤ 32 且不出血时走像素版；bleed = 满幅方形（Android 自适应图标 / maskable），标志缩进安全区；
// square = 方形瓦片、标志不缩（iOS 触屏图标：圆角由系统切）。
export function appIconSVG(size, { bleed = false, square = false, flat = false, id = "dmt" } = {}) {
  const pixel = size <= 32 && !bleed && !square;
  const fill = flat ? COLOR.tile[1] : `url(#${id})`;
  const defs = flat ? "" : `<defs>${tileDefs(id)}</defs>`;
  if (pixel) {
    const p = pixelMark(size);
    return (
      open(size, size, `0 0 ${size} ${size}`) +
      defs +
      `<rect width="${size}" height="${size}" rx="${p.rx}" fill="${fill}"/>` +
      pixelBody(size, COLOR.ivory) +
      `</svg>`
    );
  }
  // 108 网格：可见窗 18..90（72）= 瓦片；出血版画满 0..108，标志不动（落在 66 直径的安全圆里）
  const vb = bleed ? "0 0 108 108" : "18 18 72 72";
  const tile = bleed
    ? `<rect width="108" height="108" fill="${fill}"/>`
    : square
      ? `<rect x="18" y="18" width="72" height="72" fill="${fill}"/>`
      : `<rect x="18" y="18" width="72" height="72" rx="${f3(72 * TILE_RADIUS)}" fill="${fill}"/>` +
      `<rect x="18.28" y="18.28" width="71.44" height="71.44" rx="${f3(72 * TILE_RADIUS - 0.28)}" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width=".56"/>`;
  return open(size, size, vb) + defs + tile + markBody(COLOR.ivory, { id: `${id}f` }) + `</svg>`;
}

// 单色标志（Android 13 主题图标 / 通知栏）：只有形状，颜色交给系统；倒影用单一不透明度
export function monoMarkSVG(size = 108) {
  return open(size, size, "0 0 108 108") + markBody("#000", { grad: false }) + `</svg>`;
}

// 字标：pad = 四周留白（字体单位）；height = 输出像素高
export function wordmarkSVG({ color = COLOR.ink, height = 64, pad = 0, bg = "" } = {}) {
  const w = wordmark();
  const vb = [w.box.x - pad, w.box.y - pad, w.box.w + 2 * pad, w.box.h + 2 * pad].map(r1);
  const px = r1((vb[2] / vb[3]) * height);
  return (
    open(px, height, vb.join(" ")) +
    (bg ? `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="${bg}"/>` : "") +
    `<path d="${w.d}" fill="${color}"/></svg>`
  );
}

// 组合（与官网导航的「月桥 + bridge」同一种排法）：拱的外沿顶对齐字标 d 的升部顶，倒影的外沿底落在基线上——
// 整圆正好撑满字标的升部线到基线。间距 = 0.4 个 x 高。
// tile：用 App 图标瓦片代替裸标志（资产包里的「图标 + 字标」横排）
export function lockupGeometry({ tile = false } = {}) {
  const w = wordmark();
  const m = markFine();
  const asc = w.ascender;
  let k, mx, my, mw;
  if (tile) {
    // 瓦片边长 = 升部高；上沿对齐升部顶、下沿对齐基线
    k = asc / 72;
    mw = 72 * k;
    mx = w.box.x - w.xHeight * 0.5 - mw;
    my = -asc;
  } else {
    // 标志：拱外沿顶 ↔ 升部顶；倒影外沿底 ↔ 基线
    k = asc / m.box.h;
    mw = m.box.w * k;
    mx = w.box.x - w.xHeight * 0.4 - mw;
    my = -asc;
  }
  return { w, m, k, mx, my, mw };
}

export function lockupSVG({ color = COLOR.ink, height = 96, bg = "", tile = false, pad } = {}) {
  const { w, m, k, mx, my } = lockupGeometry({ tile });
  const p = pad ?? w.xHeight * 0.35;
  const top = Math.min(my, w.box.y);
  const bottom = w.box.y + w.box.h;
  const vb = [mx - p, top - p, w.box.x + w.box.w - mx + 2 * p, bottom - top + 2 * p].map(r1);
  const px = r1((vb[2] / vb[3]) * height);
  const art = tile
    ? `<g transform="translate(${r1(mx)} ${r1(my)}) scale(${f3(k)}) translate(-18 -18)">` +
      appIconSVG(1000, { id: "lkt" }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "") +
      `</g>`
    : `<g transform="translate(${r1(mx)} ${r1(my)}) scale(${f3(k)}) translate(${f3(-m.box.x)} ${f3(-m.box.y)})">${markBody(color, { id: "lkf" })}</g>`;
  return (
    open(px, height, vb.join(" ")) +
    (bg ? `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="${bg}"/>` : "") +
    art +
    `<path d="${w.d}" fill="${color}"/></svg>`
  );
}
