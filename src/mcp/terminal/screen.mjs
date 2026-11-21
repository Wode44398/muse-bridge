// 共享终端的读屏：直接读 PTY 常驻的屏幕镜像（runtime/term-mirror.mjs），镜像不可用时把原始字节在
// 一个临时 headless xterm 里渲染一遍。读出来的是 xterm 结算后的真实屏幕（光标移动 / 擦行 / 备用屏都对），
// 不是正则剥转义的近似。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let xtermLib = null;
const loadXterm = () => (xtermLib ||= require('@xterm/headless'));

/**
 * 缓冲 [from, to) → 逻辑行：被自动折行拆开的几行拼回一行。终端窄的时候（手机侧栏四十来列）
 * 一行长输出会被拆成好几截，不拼回去 agent 读到的全是碎行、网址和路径也是断的。
 */
export function bufferLines(buf, from = 0, to = buf.length) {
  const out = [];
  for (let i = Math.max(0, from); i < to; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const next = i + 1 < buf.length ? buf.getLine(i + 1) : null;
    // 后面还接着折行：这一行整宽取（行尾空格是正文的一部分）
    const s = line.translateToString(!(next && next.isWrapped));
    if (line.isWrapped && out.length && i > from) out[out.length - 1] += s;
    else out.push(s);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/** 原始 ANSI → 逻辑行（run 收集到的新输出、或镜像不可用时的整段滚回）。 */
export async function ansiToLines(raw, cols, rows) {
  const { Terminal } = loadXterm();
  const term = new Terminal({
    cols: Math.max(20, Math.min(320, cols | 0 || 100)),
    rows: Math.max(5, Math.min(120, rows | 0 || 30)),
    scrollback: 5000, allowProposedApi: true,
  });
  try {
    await new Promise((resolve) => term.write(raw, resolve));
    return bufferLines(term.buffer.active);
  } finally {
    term.dispose();
  }
}

const mirrorOf = (t) => (t.mirror && !t.mirror.dead ? t.mirror : null);
// 镜像的解析是异步的：等此刻之前到的输出全部结算完再读
const settled = (m) => new Promise((r) => m.at(r));

/** 整个缓冲（滚回 + 屏幕）的逻辑行。 */
export async function allLines(svc, t) {
  const m = mirrorOf(t);
  if (m) { await settled(m); return bufferLines(m.term.buffer.active); }
  return ansiToLines(svc.snapshotTerm(t), t.cols, t.rows);
}

/**
 * 屏幕此刻的样子：可见的物理行（TUI 是按行排版的，按行看才对得上）、是否备用屏、光标、输入模式。
 * term 是镜像本身（等待新输出时要在上面打标记），镜像不可用时为 null。
 */
export async function screenState(svc, t) {
  const m = mirrorOf(t);
  if (m) {
    await settled(m);
    const term = m.term, b = term.buffer.active;
    const rows = [];
    for (let y = 0; y < term.rows; y++) rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
    return { rows, alt: b.type === 'alternate', cursorX: b.cursorX, cursorY: b.cursorY, modes: term.modes || {}, term };
  }
  const lines = await ansiToLines(svc.snapshotTerm(t), t.cols, t.rows);
  const rows = lines.slice(-t.rows);
  return { rows, alt: false, cursorX: 0, cursorY: Math.max(0, rows.length - 1), modes: {}, term: null };
}

/** 屏幕的可读文本：去掉底下的空行。 */
export function screenText(st) {
  const rows = st.rows.slice();
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  return rows.join('\n');
}

export const tailText = (lines, n, maxChars = 24000) => {
  const kept = lines.slice(Math.max(0, lines.length - n));
  let text = kept.join('\n');
  const dropped = lines.length - kept.length;
  if (text.length > maxChars) text = '…(前文截断)\n' + text.slice(-maxChars);
  return (dropped > 0 ? `…(还有 ${dropped} 行更早的滚回未显示，加大 lines 可读)\n` : '') + text;
};
