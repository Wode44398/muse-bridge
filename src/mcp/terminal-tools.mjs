// In-process MCP：给 Claude 分页的 agent 一双「终端手眼」。操作 claude-term.mjs 里
// 按工作空间 keyed 的共享 PTY——与右侧栏「终端」面板同一个 shell 会话：agent 敲的
// 命令用户实时看得见，用户敲的东西 agent 也读得到（真正的人机同座）。
// 单工具 action 枚举（少占提示词）；claude.mjs 里按 run 闭包 getGen 路由事件。
// 读屏、等待、键名在 ./terminal/ 下。

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runTerminalAction } from './terminal/actions.mjs';

const ACTIONS = ['status', 'read', 'run', 'write', 'keys', 'wait', 'resize', 'restart'];

const DESC = `Operate the SHARED workspace terminal — the same PTY the user sees in their 终端 side panel (PowerShell on Windows, cwd = this workspace). Everything you type is live on the user's screen, and whatever the user typed/ran is in the same scrollback you read.
Actions:
- status(): does the shell exist, size, watchers, whether a full-screen program has the screen.
- read(lines?, screen?): the terminal buffer as plain text, last N lines (default 200); soft-wrapped lines are joined back. screen:true = only the visible screen, row by row (best for TUIs).
- run(command, waitSec?): type the command into the shared shell, press Enter, wait until output goes quiet (or waitSec, default 20, max 300), return the new output. ⚠ If an interactive program (vim / a CLI tool / a REPL) currently owns the screen, the text goes to THAT program, not to a fresh prompt — when unsure, read() or status() first.
- write(text, enter?): type raw text (enter:true submits: the text is typed first, Enter is pressed separately once the echo settles, and the result tells you whether the input line was actually consumed). Multi-line text is sent as a bracketed paste when the program supports it.
- keys(keys, repeat?): send named keys, space-separated, e.g. "ctrl+c", "esc", "up up enter", "tab". Returns the screen afterwards.
- wait(until?, quietSec?, waitSec?): block until the screen shows \`until\` (plain text, or /regex/flags; only NEW appearances count), or the screen stops changing for quietSec (default 5; 0 = don't stop on quiet), or waitSec passes (default 120, max 600). Returns why it stopped, the screen, and a hint when the last lines look like a confirmation prompt or an error. Use this to wait for a TUI / long command instead of polling read() or sleeping.
- resize(cols, rows) takes over the terminal size: the user's panel stops shrinking it (on a phone it is only ~40 columns wide) and shows it scaled down instead. Use e.g. resize(cols:120, rows:40) before driving a TUI in a narrow terminal; resize(release:true) hands the size back. An untouched takeover expires after 15 minutes.
- restart() kills the shell and starts a fresh one (scrollback is wiped; never do this to a session the user might still need without asking).
The user may type at the same time — treat the terminal as a shared keyboard: don't fight the user for it, and prefer your own Bash tool for heavy scripted work; use this terminal when the point is the SHARED context (the user is watching, or you're driving something the user started).`;

export const TERMINAL_NUDGE = '\n\n【共享终端】你有一个 MCP 工具 `mcp__terminal__terminal`：操作用户右侧栏「终端」面板里那个 PTY——你们共用同一个 shell 会话，你敲的每个字用户实时看得见，用户敲过/跑过的东西也全在你读到的滚回里。用户说「看我终端 / 我终端里报了个错 / 帮我在终端里跑」这类话时，直接 read() 读屏而不是让用户粘贴。跑普通命令优先用你自己的 Bash（互不干扰）；需要【共享上下文】时才用它——比如接管用户开着的 CLI/REPL、回应终端里正在等的交互式提问、或用户想全程看着你操作。终端里有前台程序时 run() 的文本会喂给那个程序，先 read() 看清状态。等终端里的程序干完活用 wait()，别反复 read 或 sleep。';

// ws：终端池引用——工作空间路径，或 principal.poolRef(ctx, 路径)（池按（属主, 工作空间）键控，与右侧面板同一把键）。
export const makeTerminalMcp = ({ getGen, ws } = {}) => createSdkMcpServer({
  name: 'terminal',
  version: '1.1.0',
  tools: [
    tool(
      'terminal',
      DESC,
      {
        action: z.enum(ACTIONS),
        command: z.string().optional().describe('run 要执行的命令（整行，不带结尾回车）'),
        text: z.string().optional().describe('write 要输入的原始文本'),
        enter: z.boolean().optional().describe('write 后是否提交（单独补一个回车，默认否）'),
        keys: z.string().optional().describe('keys 的键名序列，空格分隔：ctrl+c esc up down enter tab …'),
        repeat: z.number().int().optional().describe('keys 整个序列重复次数（默认 1，最多 50）'),
        lines: z.number().int().optional().describe('read 返回最近多少行（默认 200，最多 3000）'),
        screen: z.boolean().optional().describe('read 只看可见屏幕、按行原样（TUI 用）'),
        until: z.string().optional().describe('wait 等这段文字出现（/正则/flags 也行）'),
        quietSec: z.number().optional().describe('wait：屏幕连续这么多秒不变就返回（默认 5，0 = 不因安静返回）'),
        waitSec: z.number().optional().describe('run 最长等待秒数（默认 20，最多 300）；wait 最长等待秒数（默认 120，最多 600）'),
        cols: z.number().int().optional(),
        rows: z.number().int().optional(),
        release: z.boolean().optional().describe('resize(release:true) 交还终端尺寸'),
      },
      (args, extra) => runTerminalAction({ getGen, ws }, args, extra),
    ),
  ],
});
