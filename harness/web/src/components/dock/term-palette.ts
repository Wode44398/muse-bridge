// 终端（xterm）配色：全部从主题根上的 CSS 变量现取、在运行时推出来，源码里不写任何色值。
// xterm 只认 #hex / rgb(a)：令牌是 #hex（色）或 rgba（线 / 选区），这里统一解析再输出这两种格式。
// ANSI 八色的来路：红 = --err、绿 = --ok、黄 = --warn、青 = --accent；蓝 / 品红 = 把 --accent 的色相转到蓝 / 品红
// （饱和度、明度沿用青，深浅两档自然各自协调）；黑 / 白 = 画布与字的色阶；亮色 = 往前景色混 28%。

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function parseColor(input: string): Rgba | null {
  const s = (input || "").trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(s);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith("%") ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    return { r: clamp(Number(fn[1]), 0, 255), g: clamp(Number(fn[2]), 0, 255), b: clamp(Number(fn[3]), 0, 255), a: clamp(alpha, 0, 1) };
  }
  return null;
}

const h2 = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
export function toCss(c: Rgba): string {
  if (c.a >= 1) return `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${Number(c.a.toFixed(3))})`;
}

// a → b 按 t 混合（t = b 的占比）
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

// 透明色压到底色上（xterm 的前景 / ANSI 色要不透明）
function flatten(c: Rgba, over: Rgba): Rgba {
  return c.a >= 1 ? c : { ...mix(over, { ...c, a: 1 }, c.a), a: 1 };
}

function toHsl({ r, g, b }: Rgba): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number, a = 1): Rgba {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a };
  return { r: ch(hh + 1 / 3) * 255, g: ch(hh) * 255, b: ch(hh - 1 / 3) * 255, a };
}

// 保留饱和度与明度，只换色相
export function withHue(c: Rgba, hue: number): Rgba {
  const [, s, l] = toHsl(c);
  return fromHsl(hue, Math.max(s, 0.35), l, c.a);
}

const luminance = ({ r, g, b }: Rgba) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

// read(name) = 主题根上某个 CSS 变量的值（getComputedStyle 读出来的原文）。拿不到的令牌按顺序找替身；
// 连替身都没有（主题还没写上）才返回 null，调用方先不设主题（xterm 用它自己的默认值）。
export function termTheme(read: (name: string) => string): TermTheme | null {
  const get = (...names: string[]): Rgba | null => {
    for (const n of names) {
      const c = parseColor(read(n));
      if (c) return c;
    }
    return null;
  };
  const bg0 = get("--code-bg", "--bg");
  const fg0 = get("--text");
  if (!bg0 || !fg0) return null;
  const bg = flatten(bg0, bg0);
  const fg = flatten(fg0, bg);
  const solid = (...names: string[]) => {
    const c = get(...names);
    return c ? flatten(c, bg) : fg;
  };
  const accent = solid("--accent");
  const err = solid("--err", "--accent");
  const ok = solid("--ok", "--accent");
  const warn = solid("--warn", "--accent");
  const text2 = solid("--text2");
  const text3 = solid("--text3", "--text2");
  const dark = luminance(bg) < 0.5;
  const black = dark ? solid("--surface3", "--surface2") : text2;
  const sel = get("--selection") ?? { ...accent, a: 0.24 };
  const bright = (c: Rgba) => mix(c, fg, 0.28);
  const blue = withHue(accent, 214);
  const magenta = withHue(accent, 300);
  return {
    background: toCss(bg),
    foreground: toCss(fg),
    cursor: toCss(accent),
    cursorAccent: toCss(bg),
    selectionBackground: toCss(sel),
    black: toCss(black),
    red: toCss(err),
    green: toCss(ok),
    yellow: toCss(warn),
    blue: toCss(blue),
    magenta: toCss(magenta),
    cyan: toCss(accent),
    white: toCss(text2),
    brightBlack: toCss(text3),
    brightRed: toCss(bright(err)),
    brightGreen: toCss(bright(ok)),
    brightYellow: toCss(bright(warn)),
    brightBlue: toCss(bright(blue)),
    brightMagenta: toCss(bright(magenta)),
    brightCyan: toCss(bright(accent)),
    brightWhite: toCss(fg),
  };
}
