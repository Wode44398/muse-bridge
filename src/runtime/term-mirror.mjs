// 终端屏幕镜像：给每个 PTY 常驻一个 @xterm/headless，跟着 PTY 的输出与尺寸走。
// 面板重连时的「快照」不再是一摞原始输出字节，而是把镜像此刻的状态（滚回 + 屏幕 + 光标 +
// 几个关键模式）序列化成一段 ANSI——在同样行列的终端里写一遍就原样复现。
//
// 为什么（2026-11-13）：原始字节是按 PTY 当时的尺寸产生的（光标定位、ConPTY 改尺寸时的整屏
// 重绘都按那时的行列算）。手机上键盘一开一合、换卡片都会改尺寸，一摞跨越好几种尺寸的字节
// 不管按哪个尺寸重放都对不上：实测重连后整屏错位、复行、丢掉一屏。镜像始终和 PTY 同尺寸、
// 实时结算，序列化出来的就是「一直开着的那个终端此刻的样子」。顺带：400KB 原始缓冲整块
// 丢弃会把转义序列拦腰截断，镜像没有这个问题。
//
// @xterm/headless 只有完整服务端装（瘦客户端的 app-core 只带 src\ + node-pty）：加载不到就
// 返回 null，调用方退回原始字节缓冲（老行为）。

import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
let lib = null, libFailed = false;
function loadLib() {
  if (lib || libFailed) return lib;
  try { lib = require('@xterm/headless'); } catch { libFailed = true; }
  return lib;
}

export const MIRROR_SCROLLBACK = 5000;   // 与面板 xterm 的 scrollback 一致

// Windows 上的 PTY 是 ConPTY：它改尺寸时自己重排、重绘视口，和 xterm 自己的重排规则打架——行数变大时
// xterm 默认把滚回拉回视口，ConPTY 却在视口底部补空行再整屏重画，结果丢一屏（实测改两次尺寸丢 25 行）。
// xterm 的 windowsPty 选项就是为它准备的（VS Code 的终端同样开着）。镜像和面板的 xterm 必须用同一份设置，
// 服务端在 SSE hello 里把它（pty 字段）发给面板。osString：设备上报的 `Windows_NT 10.0.26200` 这种。
export function conptyCompat(osString) {
  const m = /Windows_NT\s+\d+\.\d+\.(\d+)/i.exec(String(osString || ''));
  return m ? { backend: 'conpty', buildNumber: +m[1] } : null;
}
/** 本机（服务器）上开的 PTY 的兼容信息；不是 Windows 返回 null。 */
export function hostPtyCompat() {
  return process.platform === 'win32' ? conptyCompat(`Windows_NT ${os.release()}`) : null;
}

/** 建一个镜像；@xterm/headless 不可用时返回 null。windowsPty 见 conptyCompat。 */
export function createMirror(cols, rows, { scrollback = MIRROR_SCROLLBACK, windowsPty = null } = {}) {
  const L = loadLib();
  if (!L) return null;
  let term;
  try { term = new L.Terminal({ cols, rows, scrollback, allowProposedApi: true, ...(windowsPty ? { windowsPty } : {}) }); } catch { return null; }
  let dead = false;
  return {
    term,
    write(d) { if (!dead && d) term.write(d); },
    resize(c, r) { if (!dead) { try { term.resize(c, r); } catch { /* 尺寸越界：保持原样 */ } } },
    reset() { if (!dead) term.write('\x1bc'); },   // 走写队列（ESC c），和前面还没解析完的输出保持先后
    // 在「此刻之前写进来的输出全部结算完」那一点上同步执行 fn（xterm 的写回调紧跟在它那一块之后，
    // 下一块还没开始解析）。用来切快照：这一点之前的进快照，之后的单独补发，不丢不重。
    at(fn) { if (dead) { fn(); return; } term.write('', fn); },
    serialize() { return dead ? '' : serializeTerm(term); },
    dispose() { if (dead) return; dead = true; try { term.dispose(); } catch { /* 已释放 */ } },
    get dead() { return dead; },
  };
}

// —— 序列化 ——

// 一格的显示属性 → SGR 参数串（'' = 全默认）
function sgrOf(c) {
  const p = [];
  if (c.isBold()) p.push('1');
  if (c.isDim()) p.push('2');
  if (c.isItalic()) p.push('3');
  if (c.isUnderline()) p.push('4');
  if (c.isBlink()) p.push('5');
  if (c.isInverse()) p.push('7');
  if (c.isInvisible()) p.push('8');
  if (c.isStrikethrough()) p.push('9');
  if (c.isOverline()) p.push('53');
  if (c.isFgRGB()) { const v = c.getFgColor(); p.push(`38;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`); }
  else if (c.isFgPalette()) { const v = c.getFgColor(); p.push(v < 8 ? String(30 + v) : v < 16 ? String(82 + v) : `38;5;${v}`); }
  if (c.isBgRGB()) { const v = c.getBgColor(); p.push(`48;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`); }
  else if (c.isBgPalette()) { const v = c.getBgColor(); p.push(v < 8 ? String(40 + v) : v < 16 ? String(92 + v) : `48;5;${v}`); }
  return p.join(';');
}

// 一块缓冲 → ANSI。每行写到最后一个写过内容（或带底色 / 反显 / 下划线）的格子为止；后面接着折行的那一行
// 整宽写满，靠自动换行接上（复现出来的下一行同样带 isWrapped）；行与行之间 CRLF。总行数与原缓冲一致，
// 所以在同样行数的终端里写完，滚回 / 屏幕的分界也一致；最后把光标放回原处（相对屏幕顶）。
function serializeBuffer(buf, cols) {
  let s = '';
  let cur = '';
  const cell = buf.getNullCell();
  const n = buf.length;
  for (let y = 0; y < n; y++) {
    const line = buf.getLine(y);
    const wrappedNext = y + 1 < n && !!buf.getLine(y + 1)?.isWrapped;
    if (line) {
      const full = Math.min(cols, line.length);
      // 只裁从没写过的空格子；写过的空格（表格补齐、提示符后的空格）照留
      let tail = full;
      while (tail > 0) {
        line.getCell(tail - 1, cell);
        if (cell.getChars() || !cell.isBgDefault() || cell.isInverse() || cell.isUnderline()) break;
        tail--;
      }
      let end = tail;
      if (wrappedNext) {
        // 折行：整宽写满，靠自动换行接到下一行。例外是「行末只剩一格、下一行开头是宽字符」——那是宽字符
        // 放不下被挤过去的，那一格本来就空着：不写它，让重放端照样把宽字符折过去
        end = full;
        if (full - tail === 1) {
          buf.getLine(y + 1).getCell(0, cell);
          if (cell.getWidth() === 2) end = tail;
        }
      }
      for (let x = 0; x < end; x++) {
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue;          // 宽字符的后半格
        const sig = sgrOf(cell);
        if (sig !== cur) { s += sig ? `\x1b[0;${sig}m` : '\x1b[0m'; cur = sig; }
        s += cell.getChars() || ' ';
      }
    }
    if (y < n - 1 && !wrappedNext) {
      if (cur) { s += '\x1b[0m'; cur = ''; }
      s += '\r\n';
    }
  }
  if (cur) s += '\x1b[0m';
  s += `\x1b[${buf.cursorY + 1};${buf.cursorX + 1}H`;
  return s;
}

/** 把一个 xterm（headless 或浏览器版都行）的当前状态序列化成 ANSI：在同样行列、刚 reset 过的终端里写一遍即复现。 */
export function serializeTerm(term) {
  const out = [];
  // 普通屏先写（光标也放好）：程序退出备用屏时 1049l 恢复的就是这个光标
  out.push(serializeBuffer(term.buffer.normal, term.cols));
  if (term.buffer.active.type === 'alternate') {
    out.push('\x1b[?1049h\x1b[H');
    out.push(serializeBuffer(term.buffer.alternate, term.cols));
  }
  // 程序开着的输入模式：不补的话，重连后 vim 里方向键 / 粘贴 / 鼠标都不对
  const m = term.modes || {};
  if (m.applicationCursorKeysMode) out.push('\x1b[?1h');
  if (m.applicationKeypadMode) out.push('\x1b=');
  if (m.bracketedPasteMode) out.push('\x1b[?2004h');
  if (m.insertMode) out.push('\x1b[4h');
  if (m.wraparoundMode === false) out.push('\x1b[?7l');
  if (m.sendFocusMode) out.push('\x1b[?1004h');
  const mouse = { x10: 9, vt200: 1000, drag: 1002, any: 1003 }[m.mouseTrackingMode];
  if (mouse) out.push(`\x1b[?${mouse}h\x1b[?1006h`);
  return out.join('');
}
