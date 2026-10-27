// 小尺寸手工对齐版（16/20/24/32）：像素网格上摆笔画，避免矢量直接缩小后糊成一团。
const { BG, IVORY, f } = require('./mark.cjs');

// spec: 瓦片尺寸 s、圆角 rx、拱圆心 (cx, cy)、拱外/内半径、水面线 [y0,y1]（像素行）、水面 x 范围、倒影圆心 y、倒影半径/线宽/不透明度/起始角
const SPECS = {
  16: { rx: 3.5, cx: 8, cy: 8, ro: 5, ri: 3, ly: [8, 9], lx: [2.5, 13.5], rcy: 9, rr: 4, rw: 1, rop: .5, gap: 22 },
  20: { rx: 4.5, cx: 10, cy: 10, ro: 6.5, ri: 4, ly: [10, 11], lx: [2.5, 17.5], rcy: 11, rr: 5.25, rw: 1.25, rop: .48, gap: 18 },
  24: { rx: 5.4, cx: 12, cy: 12, ro: 8, ri: 5, ly: [12, 13], lx: [3, 21], rcy: 13, rr: 6.5, rw: 1.4, rop: .46, gap: 15 },
  32: { rx: 7.2, cx: 16, cy: 16, ro: 11, ri: 7, ly: [16, 17.5], lx: [4, 28], rcy: 17.5, rr: 9, rw: 1.8, rop: .45, gap: 14 },
};

function smallSVG(s) {
  const p = SPECS[s];
  const rc = (p.ro + p.ri) / 2, w = p.ro - p.ri;               // 拱中线半径 / 线宽
  const ly = (p.ly[0] + p.ly[1]) / 2, lw = p.ly[1] - p.ly[0];
  const a = p.gap * Math.PI / 180;
  const rx0 = f(p.cx + p.rr * Math.cos(a)), ry0 = f(p.rcy + p.rr * Math.sin(a));
  const rx1 = f(p.cx - p.rr * Math.cos(a));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">`
    + `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG[0]}"/><stop offset="1" stop-color="${BG[1]}"/></linearGradient></defs>`
    + `<rect width="${s}" height="${s}" rx="${p.rx}" fill="url(#bg)"/>`
    + `<g fill="none" stroke="${IVORY}">`
    + `<path d="M${p.cx - rc} ${p.cy}A${rc} ${rc} 0 0 1 ${p.cx + rc} ${p.cy}" stroke-width="${w}"/>`
    + `<path d="M${p.lx[0]} ${ly}H${p.lx[1]}" stroke-width="${lw}" stroke-linecap="round"/>`
    + `<path d="M${rx0} ${ry0}A${p.rr} ${p.rr} 0 0 1 ${rx1} ${ry0}" stroke-width="${p.rw}" stroke-opacity="${p.rop}" stroke-linecap="round"/>`
    + `</g></svg>`;
}
module.exports = { smallSVG, SPECS };
