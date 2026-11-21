// 终端配色（xterm 的 theme 与最低对比度），明暗两套。
//
// 浅色模式要额外处理：命令行程序的配色几乎都是按深色终端调的——agy 这类 TUI 正文用 256 色里的
// 浅灰 / 浅紫（251、189、187…），印在白底上几乎看不见；输入框、代码块、选中项又爱垫一块
// 深灰底（235、236…），在白底上就是一块块黑斑。所以浅色模式下：
//  · 16 色换成在白底上读得清的深一档；
//  · 256 色里的灰阶（232–255）整条倒过来：「深底上的浅字」变成「浅底上的深字」，深灰垫底变成浅灰垫底，
//    程序想表达的「比正文淡一点 / 稍微垫一下」在浅色下照样成立；
//  · 打开最低对比度（同 VS Code 的 4.5）：剩下那些浅彩色的字，xterm 会就地调深到读得清。
// 深色模式保持原样——这些程序本来就是为它调的。

const CUBE = [0, 95, 135, 175, 215, 255];
const hex = (n) => n.toString(16).padStart(2, '0');
const rgb = (r, g, b) => `#${hex(r)}${hex(g)}${hex(b)}`;

/** 256 色的 16–255 段（xterm 的 extendedAnsi）。invertGrays：灰阶倒过来（浅色模式用）。 */
export function extendedAnsi(invertGrays = false) {
  const out = [];
  for (let i = 0; i < 216; i++) out.push(rgb(CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]));
  for (let i = 0; i < 24; i++) { const v = 8 + 10 * (invertGrays ? 23 - i : i); out.push(rgb(v, v, v)); }
  return out;
}

const DARK_ANSI = {
  black: '#3a3a37', brightBlack: '#8a8a84',
  red: '#e06c5f', brightRed: '#f0857a',
  green: '#7fb069', brightGreen: '#98c983',
  yellow: '#d9a05b', brightYellow: '#eab97a',
  blue: '#7aa2f7', brightBlue: '#93b6ff',
  magenta: '#bb9af7', brightMagenta: '#cdb3ff',
  cyan: '#6cb5c9', brightCyan: '#85cde0',
  white: '#d9d9d4', brightWhite: '#f5f5f0',
};
// 浅底上的一套：同色相、压暗到白底上对比度 ≥ 4.5 左右
const LIGHT_ANSI = {
  black: '#3d3d39', brightBlack: '#6f6f69',
  red: '#c0392b', brightRed: '#d0473a',
  green: '#3d7a2a', brightGreen: '#4a8a35',
  yellow: '#8f6200', brightYellow: '#9e6f05',
  blue: '#2c5fc4', brightBlue: '#3a6fd6',
  magenta: '#8a46b8', brightMagenta: '#9a55c8',
  cyan: '#17788f', brightCyan: '#1f879f',
  white: '#5c5c56', brightWhite: '#1a1915',
};

/**
 * vars(name, fallback) 取 CSS 变量（终端所在元素上的：工作台卡片把 --bg 换成了卡片色）。
 * 返回 { theme, minimumContrastRatio }，直接塞进 xterm 的 options。
 */
export function termTheme(dark, vars) {
  const v = (n, fb) => vars(n) || fb;
  const bg = v('--bg', dark ? '#262624' : '#faf9f5');
  return {
    theme: {
      background: bg,
      foreground: v('--text', dark ? '#eee' : '#1a1915'),
      cursor: v('--coral', '#d97757'),
      cursorAccent: bg,
      selectionBackground: dark ? 'rgba(217,119,87,.35)' : 'rgba(217,119,87,.28)',
      ...(dark ? DARK_ANSI : LIGHT_ANSI),
      extendedAnsi: extendedAnsi(!dark),
    },
    minimumContrastRatio: dark ? 1 : 4.5,
  };
}
