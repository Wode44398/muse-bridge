// 共享终端 keys 动作的键名 → 控制序列（xterm 语义；ctrl+字母 走通式计算）。

const KEYS = {
  enter: '\r', tab: '\t', esc: '\x1b', escape: '\x1b', backspace: '\x7f', space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~', delete: '\x1b[3~',
  'shift+tab': '\x1b[Z',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~',
  f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};

export function keySeq(name) {
  const k = String(name || '').trim().toLowerCase();
  if (!k) return null;
  if (KEYS[k]) return KEYS[k];
  const m = /^ctrl\+([a-z\[\]\\^_])$/.exec(k);
  if (m) return String.fromCharCode(m[1].charCodeAt(0) === 91 ? 27 : (m[1].charCodeAt(0) & 31));
  const alt = /^alt\+(.)$/.exec(k);
  if (alt) return '\x1b' + alt[1];
  if (k.length === 1) return k;
  return null;
}
