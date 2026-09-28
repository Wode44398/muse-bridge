// In-process MCP：给 Claude 分页的 agent 一双「终端手眼」。操作 claude-term.mjs 里
// 按工作空间 keyed 的共享 PTY——与右侧栏「终端」面板同一个 shell 会话：agent 敲的
// 命令用户实时看得见，用户敲的东西 agent 也读得到（真正的人机同座）。
// 读屏用 @xterm/headless 把原始 ANSI 缓冲渲染成真实屏幕文本（光标移动/擦行/备用屏
// 都按 xterm 语义结算，TUI 界面也能读），不是正则剥转义的近似。
// 单工具 action 枚举（少占提示词）；claude.mjs 里按 run 闭包 getGen 路由事件。

import { createRequire } from 'node:module';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getCurrentGen, genEmit } from '../runtime/gen.mjs';

const require = createRequire(import.meta.url);
let xtermLib = null;
const loadXterm = () => (xtermLib ||= require('@xterm/headless'));

const ACTIONS = ['status', 'read', 'run', 'write', 'keys', 'resize', 'restart'];

const DESC = `Operate the SHARED workspace terminal — the same PTY the user sees in their 终端 side panel (PowerShell on Windows, cwd = this workspace). Everything you type is live on the user's screen, and whatever the user typed/ran is in the same scrollback you read.
Actions:
- status(): does the shell exist, size, watchers, whether a program has the screen.
- read(lines?): render the terminal buffer (scrollback + screen) to plain text and return the last N lines (default 200). Use this to see what the user has been doing, what a TUI shows, or to check on a long-running command.
- run(command, waitSec?): type the command into the shared shell, press Enter, wait until output goes quiet (or waitSec, default 20, max 300), return the new output. ⚠ If an interactive program (vim / a CLI tool / a REPL) currently owns the screen, the text goes to THAT program, not to a fresh prompt — when unsure, read() or status() first.
- write(text, enter?): type raw text without pressing Enter (enter:true to submit) — for answering prompts and driving REPLs/TUIs.
- keys(keys, repeat?): send named keys, space-separated, e.g. "ctrl+c", "esc", "up up enter", "tab". Returns the screen afterwards so you see the effect.
- resize(cols, rows) / restart() — restart kills the shell and starts a fresh one (scrollback is wiped; never do this to a session the user might still need without asking).
The user may type at the same time — treat the terminal as a shared keyboard: don't fight the user for it, and prefer your own Bash tool for heavy scripted work; use this terminal when the point is the SHARED context (the user is watching, or you're driving something the user started).`;

// 命名键 → 控制序列（xterm 语义；ctrl+字母 走通式计算）。
const KEYS = {
  enter: '\r', tab: '\t', esc: '\x1b', escape: '\x1b', backspace: '\x7f', space: ' ',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~', delete: '\x1b[3~',
  'shift+tab': '\x1b[Z',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~',
  f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};
function keySeq(name) {
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

// 原始 ANSI → 渲染后的纯文本行（真 xterm 结算，TUI/备用屏/光标编辑都正确）。
async function ansiToLines(raw, cols, rows) {
  const { Terminal } = loadXterm();
  const term = new Terminal({
    cols: Math.max(20, Math.min(320, cols | 0 || 100)),
    rows: Math.max(5, Math.min(120, rows | 0 || 30)),
    scrollback: 5000, allowProposedApi: true,
  });
  try {
    await new Promise((resolve) => term.write(raw, resolve));
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines;
  } finally {
    term.dispose();
  }
}

const tailText = (lines, n, maxChars = 24000) => {
  const kept = lines.slice(Math.max(0, lines.length - n));
  let text = kept.join('\n');
  const dropped = lines.length - kept.length;
  if (text.length > maxChars) text = '…(前文截断)\n' + text.slice(-maxChars);
  return (dropped > 0 ? `…(还有 ${dropped} 行更早的滚回未显示，加大 lines 可读)\n` : '') + text;
};

export const TERMINAL_NUDGE = '\n\n【共享终端】你有一个 MCP 工具 `mcp__terminal__terminal`：操作用户右侧栏「终端」面板里那个 PTY——你们共用同一个 shell 会话，你敲的每个字用户实时看得见，用户敲过/跑过的东西也全在你读到的滚回里。用户说「看我终端 / 我终端里报了个错 / 帮我在终端里跑」这类话时，直接 read() 读屏而不是让用户粘贴。跑普通命令优先用你自己的 Bash（互不干扰）；需要【共享上下文】时才用它——比如接管用户开着的 CLI/REPL、回应终端里正在等的交互式提问、或用户想全程看着你操作。终端里有前台程序时 run() 的文本会喂给那个程序，先 read() 看清状态。';

export const makeTerminalMcp = ({ getGen, ws } = {}) => createSdkMcpServer({
  name: 'terminal',
  version: '1.0.0',
  tools: [
    tool(
      'terminal',
      DESC,
      {
        action: z.enum(ACTIONS),
        command: z.string().optional().describe('run 要执行的命令（整行，不带结尾回车）'),
        text: z.string().optional().describe('write 要输入的原始文本'),
        enter: z.boolean().optional().describe('write 后是否补一个回车（默认否）'),
        keys: z.string().optional().describe('keys 的键名序列，空格分隔：ctrl+c esc up down enter tab …'),
        repeat: z.number().int().optional().describe('keys 整个序列重复次数（默认 1，最多 50）'),
        lines: z.number().int().optional().describe('read 返回最近多少行（默认 200，最多 3000）'),
        waitSec: z.number().optional().describe('run 最长等待秒数（默认 20，最多 300）；输出安静 ~0.8s 即提前返回'),
        cols: z.number().int().optional(),
        rows: z.number().int().optional(),
      },
      async (args) => {
        const gen = (getGen && getGen()) || getCurrentGen();
        const a = String(args?.action || '');
        const svc = await import('../runtime/claude-term.mjs');
        const emit = (action) => { if (gen) genEmit(gen, { type: 'term', action, at: Date.now() }); };
        const text = (t) => ({ content: [{ type: 'text', text: t }] });
        const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
        // 屏幕现状（末尾 rows 行）——write/keys 后回给模型看效果。
        const screenTail = async (t, extra = 8) => {
          const lines = await ansiToLines(svc.snapshotTerm(t), t.cols, t.rows);
          return tailText(lines, t.rows + extra, 8000);
        };
        try {
          if (a === 'status') {
            const t = svc.getTerm(ws);
            if (!t) return text('终端尚未启动（用户没开过面板、你也还没写过）。run/write/keys 会自动启动它。');
            return text(`终端运行中：${t.cols}×${t.rows}，用户侧观看连接 ${t.subs.size} 个，滚回缓冲 ${(t.bytes / 1024).toFixed(0)}KB${t.exited ? '，⚠ shell 已退出（restart 可重开）' : ''}。`);
          }
          if (a === 'read') {
            const t = svc.getTerm(ws);
            if (!t) return text('终端尚未启动，没有可读内容。（run/write 会自动启动它）');
            const n = Math.max(10, Math.min(3000, Number(args?.lines) || 200));
            const lines = await ansiToLines(svc.snapshotTerm(t), t.cols, t.rows);
            if (!lines.length) return text('（终端屏幕当前是空的）');
            return text(tailText(lines, n));
          }
          if (a === 'restart') {
            svc.killTerm(ws);
            const t = svc.ensureTerm(ws, args?.cols, args?.rows);
            emit('restart');
            await new Promise((r) => setTimeout(r, 900));   // 等 shell 出提示符
            return text(`终端已重启（${t.cols}×${t.rows}，全新 shell，滚回已清空）。\n${await screenTail(t)}`);
          }
          if (a === 'resize') {
            if (!args?.cols || !args?.rows) return err('resize 需要 cols 和 rows');
            if (!svc.resizeTerm(ws, args.cols, args.rows)) return err('终端尚未启动');
            const t = svc.getTerm(ws);
            return text(`已调整为 ${t.cols}×${t.rows}`);
          }
          if (a === 'run' || a === 'write' || a === 'keys') {
            let payload = '';
            if (a === 'run') {
              if (!args?.command || !String(args.command).trim()) return err('run 需要 command');
              payload = String(args.command).replace(/\r?\n$/, '') + '\r';
            } else if (a === 'write') {
              if (args?.text == null) return err('write 需要 text');
              payload = String(args.text) + (args?.enter ? '\r' : '');
            } else {
              const names = String(args?.keys || '').split(/\s+/).filter(Boolean);
              if (!names.length) return err('keys 需要键名序列，如 "ctrl+c" 或 "esc up enter"');
              const seqs = names.map((n) => { const s = keySeq(n); if (s == null) throw Object.assign(new Error(`不认识的键名 ${n}`), { friendly: true }); return s; });
              payload = seqs.join('').repeat(Math.max(1, Math.min(50, Number(args?.repeat) || 1)));
            }
            const live = svc.ensureTerm(ws, args?.cols, args?.rows);   // 已退出的旧壳会原地重生
            emit(a);

            if (a !== 'run') {
              svc.writeTerm(ws, payload);
              await new Promise((r) => setTimeout(r, 450));   // 给回显/界面反应留一拍
              return text(`已发送。当前屏幕：\n${await screenTail(live)}`);
            }

            // run：从写入起收集新输出，安静 0.8s 或超时即返回（渲染成纯文本）。
            const waitMs = Math.max(2, Math.min(300, Number(args?.waitSec) || 20)) * 1000;
            const QUIET_MS = 800;
            const CAP = 512 * 1024;
            let collected = '';
            let exited = null;
            await new Promise((resolve) => {
              let quietTimer = null;
              let done = false;
              const finish = () => { if (done) return; done = true; clearTimeout(quietTimer); clearTimeout(hardTimer); untap(); resolve(); };
              const untap = svc.tapTerm(live, (d, code) => {
                if (d == null) { exited = code; finish(); return; }
                collected += d;
                if (collected.length > CAP) collected = collected.slice(-CAP);
                clearTimeout(quietTimer);
                quietTimer = setTimeout(finish, QUIET_MS);
              });
              const hardTimer = setTimeout(finish, waitMs);
              svc.writeTerm(ws, payload);
              quietTimer = setTimeout(finish, Math.min(waitMs, 5000));   // 一直无输出也别干等到超时
            });
            const lines = await ansiToLines(collected, live.cols, live.rows);
            const out = lines.length ? tailText(lines, 500) : '（该命令没有产生新输出）';
            const note = exited != null ? `\n（shell 已退出，code ${exited}）` : '';
            return text(out + note + '\n\n（这些内容用户在终端面板里同步看到了）');
          }
          return err(`未知 action: ${a}`);
        } catch (e) {
          if (e && e.friendly) return err(String(e.message));
          return err(`终端操作失败：${String(e?.message || e)}`);
        }
      },
    ),
  ],
});
