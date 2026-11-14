// 终端按键：手机按键条要发的控制序列 + 粘滞修饰键（Ctrl / Alt）作用到一次输入上。
// 纯函数，没有 DOM 依赖；单测见 termKeys.test.js（node --test web/src/lib/termKeys.test.js）。
//
// 序列按 xterm 的约定（PowerShell / PSReadLine、bash、vim 都认）：
//   · 方向键 / Home / End：平时 CSI（ESC [），程序开了「应用光标键」模式（vim、less 会开）时改 SS3（ESC O）；
//   · 带修饰时一律 CSI 1;<mod> X，mod = 1 + Shift(1) + Alt(2) + Ctrl(4)；PgUp / PgDn / Del 是 CSI n;<mod> ~。
//   · Alt+字符 = ESC 前缀；Ctrl+字符 = 对应的 C0 控制码（Ctrl+C = 0x03）。

const ESC = '\x1b';

// 方向 / 翻页这一类：final = CSI 序列末字母（或 ~ 序列的数字），ss3 = 应用光标键模式下能不能换 SS3
const NAV = {
  up: { f: 'A', ss3: true }, down: { f: 'B', ss3: true }, right: { f: 'C', ss3: true }, left: { f: 'D', ss3: true },
  home: { f: 'H', ss3: true }, end: { f: 'F', ss3: true },
  pgup: { n: 5 }, pgdn: { n: 6 }, del: { n: 3 }, ins: { n: 2 },
};
const PLAIN = { esc: ESC, tab: '\t', enter: '\r', bs: '\x7f' };

// Ctrl+字符 → 控制码；没有对应控制码的返回 null（调用方原样发字符）。
export function ctrlChar(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);   // @ A–Z [ \ ] ^ _
  switch (ch) {
    case ' ': case '2': return '\x00';
    case '3': return ESC;
    case '4': return '\x1c';
    case '5': return '\x1d';
    case '6': return '\x1e';
    case '7': case '/': return '\x1f';
    case '8': case '?': return '\x7f';
    default: return null;
  }
}

// 一次「打字」输入叠上粘滞修饰键。只对单个字符生效（输入法一次上屏一串时原样发，别把整串都 Ctrl 了）。
export function applyMods(data, { ctrl = false, alt = false } = {}) {
  if (!ctrl && !alt) return data;
  if (typeof data !== 'string' || [...data].length !== 1) return data;
  let out = data;
  if (ctrl) out = ctrlChar(data) ?? data;
  return alt ? ESC + out : out;
}

// 按键条上的一个功能键 → 要发的序列。app = 终端此刻是否处于应用光标键模式（term.modes.applicationCursorKeysMode）。
export function keySeq(name, { ctrl = false, alt = false, shift = false, app = false } = {}) {
  const nav = NAV[name];
  if (nav) {
    const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    if (nav.n) return mod > 1 ? `${ESC}[${nav.n};${mod}~` : `${ESC}[${nav.n}~`;
    if (mod > 1) return `${ESC}[1;${mod}${nav.f}`;
    return (app && nav.ss3 ? `${ESC}O` : `${ESC}[`) + nav.f;
  }
  if (name === 'tab' && shift) return `${ESC}[Z`;
  const p = PLAIN[name];
  if (p == null) return '';
  return alt ? ESC + p : p;
}

// 终端输出里的网址（只认带 http(s):// 的）。尾巴上的标点、没配对的右括号不算网址的一部分。
const URL_RE = /https?:\/\/[^\s"'<>`　-〿！-／：-＠]+/g;
export function findUrls(text) {
  const out = [];
  if (!text) return out;
  for (const m of String(text).matchAll(URL_RE)) {
    let u = m[0];
    for (;;) {
      const last = u.slice(-1);
      if (/[.,;:!?'"]/.test(last)) { u = u.slice(0, -1); continue; }
      if (last === ')' && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) { u = u.slice(0, -1); continue; }
      if (last === ']' && !u.includes('[')) { u = u.slice(0, -1); continue; }
      break;
    }
    if (u.length > 8) out.push({ start: m.index, end: m.index + u.length, url: u });
  }
  return out;
}

// 本机地址（dev server 之类）：开在服务器的终端里打印出来的，只有工作台浏览器（也在服务器上）够得着。
export function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:[/?#]|$)/i.test(String(url || ''));
}

// 输入行历史：去重（同一条挪到最新）、限长，最新在末尾。
export function pushHistory(list, cmd, max = 60) {
  const s = String(cmd || '').trim();
  const arr = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x !== s) : [];
  if (!s) return arr.slice(-max);
  arr.push(s);
  return arr.slice(-max);
}
