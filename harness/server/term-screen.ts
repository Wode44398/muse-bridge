// 终端原始输出（ANSI）→ 屏幕上真正显示的文字行。共享终端的读屏（tools/terminal.ts）用。
// 优先用 @xterm/headless 真渲染（光标移动、擦行、备用屏、宽字符都按 xterm 语义结算，TUI 也读得对）；它不是 harness 自己的
// 依赖，跟着 bridge 部署时从上层 node_modules 解析得到。解析不到（独立部署）时退回下面这个最小的 VT 解释器：
// 回车换行退格制表、CSI 光标移动 / 定位 / 擦除、备用屏切换，颜色等其余序列跳过——不是正则剥转义，光标改写过的行也对。
import { createRequire } from "node:module";

interface HeadlessTerminal {
  write(data: string, cb: () => void): void;
  dispose(): void;
  buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } };
}
type XtermLib = { Terminal: new (opts: Record<string, unknown>) => HeadlessTerminal };

const require = createRequire(import.meta.url);
let xterm: XtermLib | null | undefined;
function loadXterm(): XtermLib | null {
  if (xterm === undefined) {
    try {
      xterm = require("@xterm/headless") as XtermLib;
    } catch {
      xterm = null;
    }
  }
  return xterm;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n) || lo));

export async function renderScreen(raw: string, cols: number, rows: number, opts: { fallbackOnly?: boolean } = {}): Promise<string[]> {
  const c = clamp(cols, 20, 320);
  const r = clamp(rows, 5, 120);
  const lib = opts.fallbackOnly ? null : loadXterm();
  let lines: string[];
  if (lib) {
    const term = new lib.Terminal({ cols: c, rows: r, scrollback: 5000, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => term.write(raw, resolve));
      const buf = term.buffer.active;
      lines = [];
      for (let i = 0; i < buf.length; i++) lines.push((buf.getLine(i)?.translateToString(true) ?? "").replace(/\s+$/, ""));
    } finally {
      term.dispose();
    }
  } else lines = miniVt(raw, c, r);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines;
}

// 最小 VT 解释器（见文件头）。
function miniVt(raw: string, cols: number, rows: number): string[] {
  let main: string[][] = [[]];
  let alt: string[][] | null = null;
  let buf = main;
  let row = 0;
  let col = 0;
  let top = 0; // 屏幕首行在 buf 里的下标
  let saved: { row: number; col: number; top: number } | null = null;
  const line = (i: number) => {
    while (buf.length <= i) buf.push([]);
    return buf[i]!;
  };
  const down = () => {
    row++;
    line(row);
    if (row >= top + rows) top = row - rows + 1;
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\x1b") {
      const next = raw[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < raw.length && !/[@-~]/.test(raw[j]!)) j++;
        const params = raw.slice(i + 2, j);
        const final = raw[j];
        i = j + 1;
        const priv = params.startsWith("?");
        const nums = params.replace(/^[?>=]/, "").split(";").map((x) => parseInt(x, 10));
        const n = (k = 0, d = 1) => (Number.isFinite(nums[k]) && nums[k]! > 0 ? nums[k]! : d);
        if (priv && (final === "h" || final === "l")) {
          if ([47, 1047, 1049].includes(nums[0]!)) {
            if (final === "h" && !alt) {
              saved = { row, col, top };
              alt = Array.from({ length: rows }, () => []);
              buf = alt;
              row = col = top = 0;
            } else if (final === "l" && alt) {
              alt = null;
              buf = main;
              ({ row, col, top } = saved ?? { row: buf.length - 1, col: 0, top: Math.max(0, buf.length - rows) });
            }
          }
          continue;
        }
        switch (final) {
          case "A": row = Math.max(top, row - n()); break;
          case "B": row = Math.min(top + rows - 1, row + n()); line(row); break;
          case "C": col = Math.min(cols - 1, col + n()); break;
          case "D": col = Math.max(0, col - n()); break;
          case "G": col = clamp(n() - 1, 0, cols - 1); break;
          case "H":
          case "f":
            row = top + clamp(n(0) - 1, 0, rows - 1);
            col = clamp(n(1) - 1, 0, cols - 1);
            line(row);
            break;
          case "J": {
            const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
            if (mode === 2 || mode === 3) {
              for (let k = top; k < top + rows && k < buf.length; k++) buf[k] = [];
            } else if (mode === 0) {
              line(row).length = Math.min(line(row).length, col);
              for (let k = row + 1; k < buf.length; k++) buf[k] = [];
            }
            break;
          }
          case "K": {
            const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
            const l = line(row);
            if (mode === 0) l.length = Math.min(l.length, col);
            else if (mode === 1) for (let k = 0; k <= col && k < l.length; k++) l[k] = " ";
            else buf[row] = [];
            break;
          }
          case "s": saved = { row, col, top }; break;
          case "u": if (saved) ({ row, col } = saved); break;
          default: break; // 颜色（m）等：不影响文字
        }
        continue;
      }
      if (next === "]") {
        // OSC：到 BEL 或 ESC \ 为止
        let j = i + 2;
        while (j < raw.length && raw[j] !== "\x07" && !(raw[j] === "\x1b" && raw[j + 1] === "\\")) j++;
        i = raw[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }
      i += 2;
      continue;
    }
    i++;
    if (ch === "\r") col = 0;
    else if (ch === "\n") down();
    else if (ch === "\b") col = Math.max(0, col - 1);
    else if (ch === "\t") col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
    else if (ch >= " " && ch !== "\x7f") {
      if (col >= cols) {
        down();
        col = 0;
      }
      const l = line(row);
      while (l.length < col) l.push(" ");
      l[col] = ch;
      col++;
    }
  }
  return buf.map((l) => l.join("").replace(/\s+$/, ""));
}
