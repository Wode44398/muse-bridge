// bridge 月桥标记 —— 单一真相：几何、配色、各平台产物的 SVG 生成函数。
// 108 网格（Android 自适应图标的画布），中心 (54,54)；可见窗口 72（18..90），安全圆半径 33。
const IVORY = '#F3EEE4';
const BG = ['#282521', '#0F0E0C'];          // 瓦片底：暖墨，上亮下暗
const INK = '#161513';

const G = {
  cx: 54, wy: 55,        // 圆心 x、水面 y（整体下移 1，抵消上重下轻的视觉重心）
  R: 19,                 // 拱与倒影的中线半径
  arch: 7.4,             // 拱的笔画宽
  line: 2.2,             // 水面线宽
  half: 31,              // 水面半长（端点距圆心 31 + 圆头 1.1 < 安全圆 33）
  refl: 2.8,             // 倒影笔画宽
  gap: 11,               // 倒影两端离开水面的角度（度）
  r0: .58, r1: .12,      // 倒影渐隐：贴水面处 → 最低处的不透明度
  flat: .40,             // 不支持渐变的场合（单色层 / 小尺寸）倒影用的单一不透明度
};

const f = (n) => +n.toFixed(3);
function pt(r, deg, cy = G.wy) { const a = deg * Math.PI / 180; return [f(G.cx + r * Math.cos(a)), f(cy + r * Math.sin(a))]; }
// 上半拱：从左脚 (180°) 顺时针经顶点到右脚 (360°)。SVG 的 y 向下，所以 180→360 经过 270（顶部）。
function archD(g = G) { const [x0, y0] = pt(g.R, 180, g.wy), [x1, y1] = pt(g.R, 360, g.wy); return `M${x0} ${y0}A${g.R} ${g.R} 0 0 1 ${x1} ${y1}`; }
function lineD(g = G) { return `M${f(g.cx - g.half)} ${g.wy}H${f(g.cx + g.half)}`; }
function reflD(g = G) { const [x0, y0] = pt(g.R, g.gap, g.wy), [x1, y1] = pt(g.R, 180 - g.gap, g.wy); return `M${x0} ${y0}A${g.R} ${g.R} 0 0 1 ${x1} ${y1}`; }

// 标记本体（108 网格）。opts.color：主色；opts.grad：倒影是否用渐隐；opts.id：渐变 id 防重名
function markSVG({ color = IVORY, grad = true, id = 'rf', g = G } = {}) {
  const reflStroke = grad ? `url(#${id})` : color;
  const reflOp = grad ? '' : ` stroke-opacity="${g.flat}"`;
  const defs = grad ? `<defs><linearGradient id="${id}" x1="0" y1="${g.wy}" x2="0" y2="${f(g.wy + g.R + g.refl / 2)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${color}" stop-opacity="${g.r0}"/><stop offset="1" stop-color="${color}" stop-opacity="${g.r1}"/></linearGradient></defs>` : '';
  return `${defs}<g fill="none" stroke="${color}">`
    + `<path d="${archD(g)}" stroke-width="${g.arch}"/>`
    + `<path d="${lineD(g)}" stroke-width="${g.line}" stroke-linecap="round"/>`
    + `<path d="${reflD(g)}" stroke="${reflStroke}" stroke-width="${g.refl}" stroke-linecap="round"${reflOp}/>`
    + `</g>`;
}

// 圆角瓦片（桌面 / 网页 / favicon 母版）。scale：标记相对「72 可见窗 = 瓦片宽」的缩放。
function tileSVG(size, { scale = 1, radius = .2237, bleed = false, grad = true, border = true } = {}) {
  const k = (size / 72) * scale, off = size / 2 - 54 * k;
  const shape = bleed ? `<rect width="${size}" height="${size}" fill="url(#bg)"/>`
    : `<rect width="${size}" height="${size}" rx="${f(size * radius)}" fill="url(#bg)"/>`
      + (border ? `<rect x="${f(size / 256)}" y="${f(size / 256)}" width="${f(size - size / 128)}" height="${f(size - size / 128)}" rx="${f(size * radius - size / 256)}" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="${f(size / 128)}"/>` : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG[0]}"/><stop offset="1" stop-color="${BG[1]}"/></linearGradient></defs>`
    + shape
    + `<g transform="translate(${f(off)} ${f(off)}) scale(${f(k)})">${markSVG({ grad })}</g></svg>`;
}

module.exports = { G, IVORY, BG, INK, archD, lineD, reflD, markSVG, tileSVG, f, pt };
