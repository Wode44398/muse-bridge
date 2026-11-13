// Media Studio 分页标「错拍」—— 单一真相：几何、配色、全部产物。
// 用法：node scripts/brand/studio-mark.cjs        → 覆盖 web/public/assets/icons/studio-*.svg
//       node scripts/brand/studio-mark.cjs <目录>  → 产物写到别处（核对用），不碰仓库
//
// 构思：月桥（mark.cjs）是一道拱、一条水面、一道渐隐的倒影，拱与倒影合成一个整圆——静止的、此岸与彼岸。
// 把倒影沿水面往右错开半拍，圆就变成一个周期的波；倒影再收小两成、沿时间方向淡出，波就一拍比一拍弱——
// 像一个音敲响后的衰减，也像一帧接一帧往前走的影像。Studio 里的东西就是这样一件接一件长出来的：
// 先出图，再拿它出视频，再配乐。月桥是静的（同心、对称），它是动的（错开半拍、渐弱）：同一支笔，一静一动。
//
// 坐标：与月桥同一张 108 网格（Android 自适应图标画布），水面 y=55；笔画常量对齐 dimensio 的精绘标
// （harness/web/brand/geometry.mjs 的 FINE）：拱顶厚、拱脚薄，水面与倒影两头收。
// 产物：
//   studio-dark.svg   墨色标（亮底用）  ┐ 与 dimensio-* / chatgpt-* 同一约定：文件名说的是标本身的颜色，
//   studio-light.svg  象牙标（暗底用）  ┘ agentMark(id, dark) 在暗色主题取 light。透明底、方形 viewBox。
//     两个文件里都内嵌了 15/16/18/20/24/32 的像素对齐小号，按 <img> 的显示宽度用 @media 自动切换（≤33px 走小号）。
//   studio.svg        App 瓦片版（暖墨圆角瓦片 + 象牙标，与 dimensio.svg / 月桥瓦片同一块瓦片），给需要整块图标的列表用。
//   studio-mono.svg   单色版（倒影用单一不透明度、无渐变），可当 CSS mask 用：background: currentColor 染成任意色。
const fs = require('fs');
const path = require('path');

const INK = '#1d1b18';                      // 墨：设置页亮色的字色 / 强调色
const IVORY = '#F3EEE4';                    // 象牙：月桥标的颜色
const TILE = ['#282521', '#0F0E0C'];        // 瓦片：暖墨，上亮下暗（同月桥）

const f = (n) => +(+n).toFixed(3);
const pt = (cx, cy, r, deg) => { const a = deg * Math.PI / 180; return [f(cx + r * Math.cos(a)), f(cy + r * Math.sin(a))]; };
const P = (p) => `${f(p[0])} ${f(p[1])}`;
const range = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
// 过给定点列的平滑曲线（Catmull-Rom → 三次贝塞尔），返回 pts[0] 之后的 C 段（同 dimensio geometry.mjs）
function smooth(pts) {
  const n = pts.length;
  const at = (i) => (i < 0 ? [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]] : i >= n ? [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]] : pts[i]);
  let d = '';
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

// ── 几何（108 网格）──────────────────────────────────────────────────────────────────────
// wy 水面 · Ro 拱外沿半径 · crown/foot 拱顶/拱脚厚度 · archP 收势指数（同 dimensio FINE 的笔势：外沿正圆、内沿向拱脚收）
// k 倒影中线半径 / 拱脚中线半径（<1：后半拍比前半拍小，波在衰减）
// reflMid/reflEnd/reflP 倒影中段宽 / 端头宽 / 收势 · clear0/clear1 倒影左端（接拱脚）/ 右端离水面线下沿的空隙：
//   右端留 dimensio 那道缝；左端只留一道细缝——贴死了拱脚、水面、倒影会糊成一个结，留宽了 S 就断成「拱 + 一道弧」
// h0/h1 倒影沿 x 的渐隐：靠拱脚那端 → 远端 · flat 单色版倒影的单一不透明度
// lineMid/lineEnd/lineP 水面中段宽 / 端头宽 / 收势（同 dimensio）· over 水面两端各比整道波多出的长度
// ox 光学右移：拱在左上、倒影在右下，几何居中会显得往左上歪，整枚在画布里往右挪一点
const G = {
  wy: 55,
  Ro: 17.7, crown: 7.6, foot: 5.5, archP: 2.2,
  k: .8, reflMid: 3.6, reflEnd: 1.5, reflP: 1.6, clear0: .9, clear1: 2.2, h0: .85, h1: .38, flat: .6,
  lineMid: 2.2, lineEnd: 1.15, lineP: 3, over: 1.3,
  ox: 1.5,
};
// 墨量（同显示尺寸 alpha 总和）≈ dimensio 的 0.99（初版等宽笔画只有 0.84，和 dimensio、ChatGPT 并排像没画完）：
// 波比整圆扁、总笔长短，拱顶 / 拱脚因此比 dimensio（6.8 / 4.9）各加一成，倒影加厚、渐隐起点提高；
// 墨重心 x≈0.44（几何居中时 0.42，偏左上）。

// 布局：整道波（拱外沿 → 倒影远端）以自身外框居中在 x=54
function frame(g = G) {
  const rc = g.Ro - g.foot / 2, rr = g.k * rc;
  const ang = (c) => Math.asin(Math.min(1, (g.lineMid / 2 + c + g.reflEnd / 2) / rr)) * 180 / Math.PI;
  const gap0 = ang(g.clear0), gap1 = ang(g.clear1);                            // 倒影左 / 右端离水的角度
  const left = -(rc + g.Ro);                                                   // 相对过零点（拱右脚中线）
  const right = rr * (1 + Math.cos(gap1 * Math.PI / 180)) + g.reflEnd / 2;
  const x0 = 54 - (left + right) / 2;
  const half = (right - left) / 2 + g.over;
  return { rc, rr, gap0, gap1, x0, ax: x0 - rc, bx: x0 + rr, half };
}

function mark(g = G) {
  const { rr, gap0, gap1, x0, ax, bx, half } = frame(g);
  const wy = g.wy;
  // 拱：外沿正圆（左脚 → 顶 → 右脚），内沿按角度收（右脚 → 顶 → 左脚）
  const archW = (t) => g.foot + (g.crown - g.foot) * Math.sin(((t - 180) * Math.PI) / 180) ** g.archP;
  const inner = range(360, 180, 36).map((t) => pt(ax, wy, g.Ro - archW(t), t));
  const arch = `M${f(ax - g.Ro)} ${wy}A${g.Ro} ${g.Ro} 0 0 1 ${f(ax + g.Ro)} ${wy}L${P(inner[0])}${smooth(inner)}Z`;
  // 水面：上沿左 → 右，右端圆头，下沿右 → 左，左端圆头；中段 lineMid，向两头收成 lineEnd（同 dimensio）
  const lineT = (x) => g.lineEnd + (g.lineMid - g.lineEnd) * (1 - Math.abs(x / half) ** g.lineP);
  const xs = range(-half, half, 30);
  const topE = xs.map((x) => [54 + x, wy - lineT(x) / 2]);
  const botE = xs.slice().reverse().map((x) => [54 + x, wy + lineT(x) / 2]);
  const e = g.lineEnd / 2;
  const line = `M${P(topE[0])}${smooth(topE)}A${e} ${e} 0 0 1 ${P(botE[0])}${smooth(botE)}A${e} ${e} 0 0 1 ${P(topE[0])}Z`;
  // 倒影：圆心 (bx, wy)、中线半径 rr 的下半圆，右端离水 gap1°、左端 gap0°，两头收、圆头
  const reflW = (t) => g.reflEnd + (g.reflMid - g.reflEnd) * Math.sin((t * Math.PI) / 180) ** g.reflP;
  const as = range(gap1, 180 - gap0, 40);
  const outer = as.map((t) => pt(bx, wy, rr + reflW(t) / 2, t));
  const innerR = as.slice().reverse().map((t) => pt(bx, wy, rr - reflW(t) / 2, t));
  const c = g.reflEnd / 2;
  const refl = `M${P(outer[0])}${smooth(outer)}A${c} ${c} 0 0 1 ${P(innerR[0])}${smooth(innerR)}A${c} ${c} 0 0 1 ${P(outer[0])}Z`;
  return {
    arch, line, refl,
    // 渐隐沿 x：从倒影左端（靠拱脚）到右端
    fade: { x1: f(bx - rr), x2: f(bx + rr), o0: g.h0, o1: g.h1, flat: g.flat },
    box: { x: f(54 - half), y: f(wy - g.Ro), w: f(2 * half), h: f(g.Ro + rr + g.reflMid / 2) },
  };
}

// ── 小号像素对齐版（画布 s×s 的像素坐标）──────────────────────────────────────────────────
// 矢量母版缩到 15–32 时水面细过 1px、倒影淡到看不见，波就只剩半边拱，读成「换了个角度的月桥」。这里按像素网格重摆：
// 水面占整像素行；拱脚的竖笔落在整像素列上；拱仍是顶厚脚薄的月牙（外圆 + 下移的内圆）；
// 倒影比拱小两到三成、加重、贴着水面（一笔 S 形，一眼是波，不会读成换了角度的月桥）：15/16 不渐隐的实灰，18 起沿 x 渐弱。
// ly 水面像素行 [上沿, 下沿] · lx 水面两端圆头的圆心 x（圆头半径 = 线宽/2，两端各比波多出同样的量）
// ax/ro/cw/fw 拱圆心 x、外半径、拱顶厚、拱脚厚（拱脚落在 ly[0]）
// bx/by/br/bw 倒影圆心、中线半径、线宽 · gap 倒影两端离水角度（0 = 贴着水面）· op 倒影沿 x 的不透明度 [左, 右]
const SMALL = {
  15: { ly: [7, 8], lx: [2, 14], ax: 5.5, ro: 3.5, cw: 2, fw: 1, bx: 11, by: 8, br: 2.5, bw: 1, gap: 0, op: [.62, .62] },   // 桌面设置侧栏 15px
  16: { ly: [8, 9], lx: [2, 15], ax: 6, ro: 4, cw: 2, fw: 1, bx: 12, by: 9, br: 2.5, bw: 1, gap: 0, op: [.62, .62] },
  18: { ly: [9, 10], lx: [2, 17], ax: 6.5, ro: 4.5, cw: 2, fw: 1, bx: 13.5, by: 10.5, br: 3, bw: 1, gap: 0, op: [.62, .55] },   // 设置页行首格 18px
  20: { ly: [10, 11], lx: [2, 19], ax: 7, ro: 5, cw: 2, fw: 1, bx: 15, by: 11, br: 3.5, bw: 1, gap: 0, op: [.62, .5] },
  24: { ly: [12, 13], lx: [2, 22.75], ax: 8.5, ro: 6, cw: 2.5, fw: 1.5, bx: 17.75, by: 13, br: 4, bw: 1, gap: 0, op: [.64, .38] },
  32: { ly: [16, 17], lx: [2.5, 30.1], ax: 11, ro: 8, cw: 3, fw: 2, bx: 23.5, by: 17, br: 5.5, bw: 1.25, gap: 0, op: [.62, .34] },
};
// 显示宽度 → 用哪一号（媒体查询的上界，CSS px）；33 以上走矢量母版（桌面设置头图 34、Dock 42、设置头图 42、主页 62）
const SMALL_AT = [[15.5, 15], [17.5, 16], [19.5, 18], [22, 20], [27.5, 24], [33, 32]];

// 月牙拱：外圆 (ax, y0, ro)；内圆心下移 d、半径 ri，使拱顶厚 cw、拱脚厚 fw
function crescent(ax, y0, ro, cw, fw) {
  const p = ro - cw, q = ro - fw;
  const ri = (p + q * q / p) / 2;
  return `M${f(ax - ro)} ${y0}A${ro} ${ro} 0 0 1 ${f(ax + ro)} ${y0}L${f(ax + q)} ${y0}A${f(ri)} ${f(ri)} 0 0 0 ${f(ax - q)} ${y0}Z`;
}

function smallBody(s, color, id) {
  const p = SMALL[s];
  const ly = (p.ly[0] + p.ly[1]) / 2, lw = p.ly[1] - p.ly[0];
  const [x0, y0] = pt(p.bx, p.by, p.br, p.gap), [x1, y1] = pt(p.bx, p.by, p.br, 180 - p.gap);
  const flat = p.op[0] === p.op[1];
  const grad = !flat && id
    ? `<defs><linearGradient id="${id}" x1="${f(p.bx - p.br)}" y1="0" x2="${f(p.bx + p.br)}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${color}" stop-opacity="${p.op[0]}"/><stop offset="1" stop-color="${color}" stop-opacity="${p.op[1]}"/></linearGradient></defs>`
    : '';
  const reflPaint = grad ? `stroke="url(#${id})"` : `stroke="${color}" stroke-opacity="${f((p.op[0] + p.op[1]) / 2)}"`;
  // 先画倒影（贴水面时它的圆头压在水面线底下），再画拱和水面
  return grad
    + `<path d="M${x1} ${y1}A${p.br} ${p.br} 0 0 0 ${x0} ${y0}" fill="none" ${reflPaint} stroke-width="${p.bw}" stroke-linecap="round"/>`
    + `<path d="${crescent(p.ax, p.ly[0], p.ro, p.cw, p.fw)}" fill="${color}"/>`
    + `<path d="M${p.lx[0]} ${f(ly)}H${p.lx[1]}" stroke="${color}" stroke-width="${f(lw)}" stroke-linecap="round"/>`;
}

// ── SVG 拼装 ────────────────────────────────────────────────────────────────────────────
const open = (w, h, vb, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}"${extra}>`;

function bigBody(color, { id = 'sm', grad = true, g = G } = {}) {
  const m = mark(g);
  const defs = grad ? `<defs><linearGradient id="${id}" x1="${m.fade.x1}" y1="0" x2="${m.fade.x2}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${color}" stop-opacity="${m.fade.o0}"/><stop offset="1" stop-color="${color}" stop-opacity="${m.fade.o1}"/></linearGradient></defs>` : '';
  const reflPaint = grad ? `fill="url(#${id})"` : `fill-opacity="${m.fade.flat}"`;
  return defs + `<g fill="${color}"><path d="${m.arch}"/><path d="${m.line}"/><path d="${m.refl}" ${reflPaint}/></g>`;
}

// 标志的方形 viewBox：紧包围盒四周各留 pad（同 dimensio-light/dark：pad 1）
function markBox(pad = 1, g = G) {
  const b = mark(g).box;
  const side = Math.max(b.w, b.h) + 2 * pad;
  const cx = b.x + b.w / 2 - g.ox, cy = b.y + b.h / 2;   // 画布中心左移 ox = 标志在画布里右移 ox
  return { x: f(cx - side / 2), y: f(cy - side / 2), side: f(side) };
}

// 分页标：透明底。small=true 时内嵌小号，按显示宽度切换（不支持 SVG 内媒体查询的渲染器只画大号，照样能用）
function markSVG(color, { id, size = 64, pad = 1, small = true } = {}) {
  const b = markBox(pad);
  const tag = id || (color === INK ? 'sd' : 'sl');
  if (!small) return open(size, size, `${b.x} ${b.y} ${b.side} ${b.side}`) + bigBody(color, { id: tag }) + `</svg>`;
  // 小号各自是一张 s×s 的嵌套画布，铺满外层 viewBox
  const css = `.s{display:none}`
    + SMALL_AT.map(([max, s], i) => `@media (max-width:${max}px)${i ? ` and (min-width:${SMALL_AT[i - 1][0] + .01}px)` : ''}{.L{display:none}.s${s}{display:inline}}`).join('');
  const nest = SMALL_AT.map(([, s]) => `<svg class="s s${s}" x="${b.x}" y="${b.y}" width="${b.side}" height="${b.side}" viewBox="0 0 ${s} ${s}">${smallBody(s, color, `${tag}${s}`)}</svg>`).join('');
  return open(size, size, `${b.x} ${b.y} ${b.side} ${b.side}`) + `<style>${css}</style>`
    + `<g class="L">${bigBody(color, { id: tag })}</g>` + nest + `</svg>`;
}

// 单色版：无渐变，倒影用单一不透明度（mask / 单色图层用）
function monoSVG(size = 64) {
  const b = markBox(1);
  return open(size, size, `${b.x} ${b.y} ${b.side} ${b.side}`) + bigBody('#000', { grad: false }) + `</svg>`;
}

// App 瓦片：暖墨圆角瓦片 + 象牙标。瓦片圆角 22.37%、内缘 8% 白细线（同月桥 tileSVG）；标志占瓦片宽 ≈ 62%
function tileSVG(size = 64, { scale = .62 } = {}) {
  const b = mark().box;
  const k = (size * scale) / b.w;
  const tx = size / 2 - (b.x + b.w / 2 - G.ox) * k, ty = size / 2 - (b.y + b.h / 2) * k;
  const r = f(size * .2237), hair = size / 128;
  return open(size, size, `0 0 ${size} ${size}`)
    + `<defs><linearGradient id="stt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TILE[0]}"/><stop offset="1" stop-color="${TILE[1]}"/></linearGradient></defs>`
    + `<rect width="${size}" height="${size}" rx="${r}" fill="url(#stt)"/>`
    + `<rect x="${f(hair / 2)}" y="${f(hair / 2)}" width="${f(size - hair)}" height="${f(size - hair)}" rx="${f(r - hair / 2)}" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="${f(hair)}"/>`
    + `<g transform="translate(${f(tx)} ${f(ty)}) scale(${f(k)})">${bigBody(IVORY, { id: 'stf' })}</g></svg>`;
}

function build(outDir) {
  const out = (name, text) => { const p = path.join(outDir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  return [
    out('studio-dark.svg', markSVG(INK)),
    out('studio-light.svg', markSVG(IVORY)),
    out('studio.svg', tileSVG(64)),
    out('studio-mono.svg', monoSVG(64)),
  ];
}

module.exports = { G, SMALL, SMALL_AT, INK, IVORY, TILE, frame, mark, crescent, smallBody, bigBody, markBox, markSVG, monoSVG, tileSVG, build };

if (require.main === module) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', '..', 'web', 'public', 'assets', 'icons');
  for (const p of build(dir)) console.log(path.relative(process.cwd(), p));
}
