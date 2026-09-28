// dimensio 品牌几何 —— 单一真相源。字标、标志、App 图标、小尺寸像素版都从这里算出来。
//
// 概念：就是 bridge 的「月桥」——一道拱横跨水面，倒影在水下补成整圆（一笔重拱、一根细线、一道渐隐的倒影）。
//   dimensio 的「换一个维度」不写在静态图形里，写在出场里：先绕出整圆，一根竖着贯穿圆心的线再转过 90° 躺平成水面。
//   静态图形与月桥逐数相同（bridge 仓库 scripts/brand/mark.cjs / small.cjs），两边改数要一起改。
//   （09-25 那版把拱转成小写 d 的腹、竖线只在上方出头；09-27 改回月桥。）
//
// 坐标约定：标志用 108 网格（Android 自适应图标画布，可见窗 18..90，安全圆半径 33），圆心 (54,55)；
// 字标用字体单位（思源宋体 wght 600，UPM 1000，基线 y=0，y 向下为正）。
// 改这里的数之后跑 `node brand/build.mjs` 重出全部产物（src/lib/brand.ts、public 图标、brand/kit）。
import fs from "node:fs";

const SERIF = JSON.parse(fs.readFileSync(new URL("./serif-600.json", import.meta.url), "utf8"));

export const f3 = (n) => +n.toFixed(3);
export const r1 = (n) => Math.round(n * 10) / 10;
export const pt = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [f3(cx + r * Math.cos(a)), f3(cy + r * Math.sin(a))];
};

// ── 色板（品牌常量；界面令牌在 src/lib/theme.ts，取同一组值）──────────────────────────
// 与 bridge 同一张纸、同一块墨：纸 / 墨取官网，象牙 / 瓦片取月桥。
export const COLOR = {
  ink: "#171614", // 墨：浅底上的字标、标志
  paper: "#F4F1EA", // 纸：浅底
  ivory: "#F3EEE4", // 象牙：深底上的字标、标志
  night: "#131210", // 夜：深底
  tile: ["#282521", "#0F0E0C"], // App 图标瓦片：暖墨，上亮下暗
  zhu: "#C8412B", // 朱：只给「正在发生」的东西（浅底）
  zhuBright: "#E4553A", // 朱：深底
};

// ── 标志（108 网格）──────────────────────────────────────────────────────────────────
// cx/wy 圆心 x、水面 y（整体下移 1，抵消上重下轻）· R 拱与倒影的中线半径 · arch 拱的笔画宽 · line 水面线宽
// half 水面半长（两端都出头：端点距圆心 31 + 圆头 1.1 < 安全圆 33）· refl 倒影宽 · gap 倒影两端离开水面的角度
// r0/r1 倒影渐隐：贴水面处 → 最低处的不透明度 · flat 不支持渐变的场合倒影用的单一不透明度
export const MARK = { cx: 54, wy: 55, R: 19, arch: 7.4, line: 2.2, half: 31, refl: 2.8, gap: 11, r0: 0.58, r1: 0.12, flat: 0.4 };

export function mark(g = MARK) {
  const { cx, wy, R } = g;
  const [e0x, e0y] = pt(cx, wy, R, g.gap);
  const [e1x, e1y] = pt(cx, wy, R, 180 - g.gap);
  const top = wy - R - g.arch / 2, bottom = wy + R + g.refl / 2;
  const left = cx - g.half - g.line / 2, right = cx + g.half + g.line / 2;
  // 路径方向 = 出场时画的方向：拱从左脚顺时针越过顶点到右脚，倒影接着从右经水下回到左——一笔绕成整圆；
  // 水面是贯穿圆心的直线（出场时先竖着从圆心往两头长出来，再转过 90° 躺平，见 Mark.svelte）。
  return {
    cx,
    cy: wy,
    R,
    arch: `M${f3(cx - R)} ${wy}A${R} ${R} 0 0 1 ${f3(cx + R)} ${wy}`,
    archW: g.arch,
    archLen: f3(Math.PI * R),
    line: `M${f3(cx - g.half)} ${wy}H${f3(cx + g.half)}`,
    lineW: g.line,
    lineLen: 2 * g.half,
    refl: `M${e0x} ${e0y}A${R} ${R} 0 0 1 ${e1x} ${e1y}`,
    reflW: g.refl,
    reflLen: f3((Math.PI * R * (180 - 2 * g.gap)) / 180),
    archMask: { d: `M${f3(cx - R)} ${wy}A${R} ${R} 0 0 1 ${f3(cx + R)} ${wy}`, w: g.arch + 3 },
    reflMask: { d: (() => { const [x0, y0] = pt(cx, wy, R, g.gap - 6); const [x1, y1] = pt(cx, wy, R, 186 - g.gap); return `M${x0} ${y0}A${R} ${R} 0 0 1 ${x1} ${y1}`; })(), w: g.refl + 3 },
    // 倒影的渐隐：沿竖直方向，从水面（r0）到最低处（r1）
    fade: { y1: wy, y2: f3(bottom), o0: g.r0, o1: g.r1, flat: g.flat },
    box: { x: f3(left), y: f3(top), w: f3(right - left), h: f3(bottom - top) },
  };
}

// ── 精绘版（大尺寸：首页、App 图标 ≥48px、组合字标、品牌资产）──────────────────────────────
// 上面的 MARK 是月桥原样——粗笔画、等宽线，给小图标用（界面里的 14–24px、bridge 自己的图标）。
// 放大到展示尺寸时细化成有笔势的三笔，与宋体字标同一种手感：
//   拱：外沿是正圆，内沿由拱顶向两脚收——拱顶厚 crown、拱脚薄 foot（像宋体的横细竖粗，只是换成了圆）；
//   水面：中段 lineMid，向两头收成 lineEnd 的圆尖；
//   倒影：中线半径 Rr（对齐拱脚的中线，拱与倒影仍合成一个圆），最低处 reflMid，两端收到 reflEnd。
// p = 收势的指数（越大，厚的那一段越长、收得越急）
export const FINE = {
  cx: 54, wy: 55,
  Ro: 22, crown: 6.8, foot: 4.9, archP: 2.2,
  half: 30, lineMid: 2.2, lineEnd: 1.15, lineP: 3,
  Rr: 19.6, reflMid: 3, reflEnd: 1.4, reflP: 1.6, gap: 12,
  r0: 0.6, r1: 0.12, flat: 0.4,
};

// 过给定点列的平滑曲线（Catmull-Rom → 三次贝塞尔），返回从 pts[0] 之后开始的 C 段
function smooth(pts) {
  const n = pts.length;
  const at = (i) => (i < 0 ? [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]] : i >= n ? [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]] : pts[i]);
  let d = "";
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    d += `C${f3(p1[0] + (p2[0] - p0[0]) / 6)} ${f3(p1[1] + (p2[1] - p0[1]) / 6)} ${f3(p2[0] - (p3[0] - p1[0]) / 6)} ${f3(p2[1] - (p3[1] - p1[1]) / 6)} ${f3(p2[0])} ${f3(p2[1])}`;
  }
  return d;
}
const range = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
const P = (p) => `${f3(p[0])} ${f3(p[1])}`;

export function markFine(g = FINE) {
  const { cx, wy } = g;
  // 拱：外沿正圆（左脚 → 顶 → 右脚），内沿按角度收（右脚 → 顶 → 左脚）
  const archW = (a) => g.foot + (g.crown - g.foot) * Math.sin(((a - 180) * Math.PI) / 180) ** g.archP;
  const inner = range(360, 180, 36).map((a) => pt(cx, wy, g.Ro - archW(a), a));
  const arch = `M${f3(cx - g.Ro)} ${wy}A${g.Ro} ${g.Ro} 0 0 1 ${f3(cx + g.Ro)} ${wy}L${P(inner[0])}${smooth(inner)}Z`;

  // 水面：上沿左 → 右，右端圆尖，下沿右 → 左，左端圆尖
  const lineT = (x) => g.lineEnd + (g.lineMid - g.lineEnd) * (1 - Math.abs(x / g.half) ** g.lineP);
  const xs = range(-g.half, g.half, 30);
  const topE = xs.map((x) => [cx + x, wy - lineT(x) / 2]);
  const botE = xs.slice().reverse().map((x) => [cx + x, wy + lineT(x) / 2]);
  const e = g.lineEnd / 2;
  const line = `M${P(topE[0])}${smooth(topE)}A${e} ${e} 0 0 1 ${P(botE[0])}${smooth(botE)}A${e} ${e} 0 0 1 ${P(topE[0])}Z`;

  // 倒影：外沿 gap → 180-gap，端头圆，内沿回来，端头圆
  const reflW = (a) => g.reflEnd + (g.reflMid - g.reflEnd) * Math.sin((a * Math.PI) / 180) ** g.reflP;
  const as = range(g.gap, 180 - g.gap, 36);
  const outer = as.map((a) => pt(cx, wy, g.Rr + reflW(a) / 2, a));
  const innerR = as.slice().reverse().map((a) => pt(cx, wy, g.Rr - reflW(a) / 2, a));
  const c = g.reflEnd / 2;
  const refl = `M${P(outer[0])}${smooth(outer)}A${c} ${c} 0 0 1 ${P(innerR[0])}${smooth(innerR)}A${c} ${c} 0 0 1 ${P(outer[0])}Z`;

  const top = wy - g.Ro, bottom = wy + g.Rr + g.reflMid / 2;
  const left = cx - g.half - g.lineEnd / 2, right = cx + g.half + g.lineEnd / 2;
  return {
    cx,
    cy: wy,
    R: g.Rr, // 光点绕行半径 = 倒影中线（也落在拱的笔画里）
    arch,
    line,
    refl,
    // 出场「一笔绕圆」用的描绘遮罩：沿拱 / 倒影中线的粗描边，dashoffset 走完即全显
    // 水面的收势参数：动效里线会伸缩、弯成 S，要按同一条收势现算轮廓（lib/mark-motion.ts），静止时与上面的 line 重合
    lineTaper: { half: g.half, mid: g.lineMid, end: g.lineEnd, p: g.lineP },
    archMask: { d: `M${f3(cx - g.Ro + g.crown / 2)} ${wy}A${f3(g.Ro - g.crown / 2)} ${f3(g.Ro - g.crown / 2)} 0 0 1 ${f3(cx + g.Ro - g.crown / 2)} ${wy}`, w: g.crown + 3 },
    reflMask: { d: (() => { const [x0, y0] = pt(cx, wy, g.Rr, g.gap - 6); const [x1, y1] = pt(cx, wy, g.Rr, 186 - g.gap); return `M${x0} ${y0}A${g.Rr} ${g.Rr} 0 0 1 ${x1} ${y1}`; })(), w: g.reflMid + 3 },
    fade: { y1: wy, y2: f3(bottom), o0: g.r0, o1: g.r1, flat: g.flat },
    box: { x: f3(left), y: f3(top), w: f3(right - left), h: f3(bottom - top) },
  };
}

// ── 小尺寸像素版：16/20/24/32 的瓦片里逐像素摆笔画（矢量直接缩小会糊成一团）──────────────
// 与 bridge scripts/brand/small.cjs 同值。单位是「size×size 瓦片里的像素」。
// rx 瓦片圆角 · cx/cy 拱心 · ro/ri 拱的外 / 内半径 · ly 水面线占的像素行 [上, 下] · lx 水面 x 范围
// rcy 倒影圆心 y · rr/rw/rop 倒影半径 / 线宽 / 不透明度 · gap 倒影起始角
export const PIXEL = {
  16: { rx: 3.5, cx: 8, cy: 8, ro: 5, ri: 3, ly: [8, 9], lx: [2.5, 13.5], rcy: 9, rr: 4, rw: 1, rop: 0.5, gap: 22 },
  20: { rx: 4.5, cx: 10, cy: 10, ro: 6.5, ri: 4, ly: [10, 11], lx: [2.5, 17.5], rcy: 11, rr: 5.25, rw: 1.25, rop: 0.48, gap: 18 },
  24: { rx: 5.4, cx: 12, cy: 12, ro: 8, ri: 5, ly: [12, 13], lx: [3, 21], rcy: 13, rr: 6.5, rw: 1.4, rop: 0.46, gap: 15 },
  32: { rx: 7.2, cx: 16, cy: 16, ro: 11, ri: 7, ly: [16, 17.5], lx: [4, 28], rcy: 17.5, rr: 9, rw: 1.8, rop: 0.45, gap: 14 },
};

export function pixelMark(size, p = PIXEL[size]) {
  const rc = (p.ro + p.ri) / 2;
  const ly = (p.ly[0] + p.ly[1]) / 2;
  const [ex0, ey0] = pt(p.cx, p.rcy, p.rr, p.gap);
  const [ex1] = pt(p.cx, p.rcy, p.rr, 180 - p.gap);
  return {
    rx: p.rx,
    arch: `M${p.cx - rc} ${p.cy}A${rc} ${rc} 0 0 1 ${p.cx + rc} ${p.cy}`,
    archW: p.ro - p.ri,
    line: `M${p.lx[0]} ${ly}H${p.lx[1]}`,
    lineW: p.ly[1] - p.ly[0],
    refl: `M${ex0} ${ey0}A${p.rr} ${p.rr} 0 0 1 ${ex1} ${ey0}`,
    reflW: p.rw,
    reflOpacity: p.rop,
  };
}

// ── 字标：思源宋体 600 的「dimensio」（与官网字标 bridge 同一款字、同一字重）────────────────
export const WORD = { track: 6 }; // 额外字距（字体单位）：展示尺寸下略放开一点，小字号更透气

// 把 fontTools 输出的绝对坐标 path（M/L/Q/C/H/V/Z）整体平移 dx
function shiftPath(d, dx) {
  const tokens = d.match(/[MLQCHVZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const out = [];
  let cmd = "";
  let idx = 0;
  for (const tk of tokens) {
    if (/^[A-Za-z]$/.test(tk)) {
      cmd = tk.toUpperCase();
      idx = 0;
      out.push(tk);
      continue;
    }
    const n = Number(tk);
    let v = n;
    if (cmd === "H") v = n + dx;
    else if (cmd === "M" || cmd === "L" || cmd === "Q" || cmd === "C") v = idx % 2 === 0 ? n + dx : n;
    idx++;
    out.push(String(r1(v)));
  }
  return out.join(" ").replace(/ ([MLQCHVZ]) /gi, "$1").replace(/ ([MLQCHVZ])$/gi, "$1").replace(/^([MLQCHVZ]) /i, "$1");
}

export function wordmark(word = WORD) {
  let x = 0;
  const paths = [];
  let right = 0;
  for (const g of SERIF.glyphs) {
    paths.push(shiftPath(g.d, x));
    right = x + g.bounds[2];
    x += g.adv + g.kern + word.track;
  }
  const first = SERIF.glyphs[0];
  const left = first.bounds[0];
  const top = -Math.max(...SERIF.glyphs.map((g) => g.bounds[3]));
  const bottom = -Math.min(...SERIF.glyphs.map((g) => g.bounds[1]));
  return {
    d: paths.join(""),
    box: { x: r1(left), y: r1(top), w: r1(right - left), h: r1(bottom - top) },
    xHeight: SERIF.xHeight,
    ascender: r1(SERIF.ascender),
  };
}

// ── 瓦片：与月桥同一种圆角方块（rx = 22.37%）─────────────────────────────────────────────
export const TILE_RADIUS = 0.2237;
