// Terminal：操作工作区「终端」面板里那个 PTY（对标 bridge 里 Claude 的 mcp__terminal__terminal，src/mcp/terminal-tools.mjs）。
// 与面板同一个壳（terminal.ts 按工作空间键控，agent 这边的键 = 会话工作空间 = 面板的 ws）：agent 敲的字用户实时看得见，
// 用户跑过的东西 agent 也读得到。读屏经 term-screen.ts 把原始 ANSI 渲染成屏幕上的文字。
// 闸门：没有命令行的租户不给这个工具（enabled，同 /api/dock/term/* 的 403）；偏好 workspace.terminal 可降到只读或关掉；
// run 与带回车的 write 按 Bash 的规则判权限、走 Bash 的命令围栏（同一条命令换个入口不该绕过去）。子 agent 不给。
import type { AgentEvent } from "../agent/events.ts";
import type { PermissionView, Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";
import { bashTool } from "./bash.ts";
import { ensureTerm, getTermIfAny, killTerm, snapshotTerm, subscribeTerm, writeTerm, type Term } from "../terminal.ts";
import { renderScreen } from "../term-screen.ts";
import { tenantShell } from "../tenant.ts";
import { prefValue } from "../prefs.ts";

const READ_ACTIONS = new Set(["status", "read"]);
const QUIET_MS = 800;
const OUT_CAP = 512 * 1024;

// 命名键 → 控制序列（xterm 语义）
const KEYS: Record<string, string> = {
  enter: "\r", tab: "\t", esc: "\x1b", escape: "\x1b", backspace: "\x7f", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  home: "\x1b[H", end: "\x1b[F", pgup: "\x1b[5~", pgdn: "\x1b[6~", delete: "\x1b[3~", "shift+tab": "\x1b[Z",
};
export function keySeq(name: string): string | null {
  const k = name.trim().toLowerCase();
  if (!k) return null;
  if (KEYS[k]) return KEYS[k]!;
  const ctrl = /^ctrl\+([a-z[\]\\^_])$/.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) & 31);
  const alt = /^alt\+(.)$/.exec(k);
  if (alt) return "\x1b" + alt[1];
  return k.length === 1 ? k : null;
}

function tail(lines: string[], n: number, maxChars = 24_000): string {
  const kept = lines.slice(Math.max(0, lines.length - n));
  let text = kept.join("\n");
  if (text.length > maxChars) text = "…(cut)\n" + text.slice(-maxChars);
  const dropped = lines.length - kept.length;
  return (dropped > 0 ? `…(${dropped} earlier lines not shown; raise lines to read more)\n` : "") + text;
}

const screenOf = async (t: Term, extra = 8) => tail(await renderScreen(snapshotTerm(t), t.cols, t.rows), t.rows + extra, 8000);

// 这一下要不要算成「敲命令」（按 Bash 判权限、过命令围栏）
function commandOf(args: Record<string, unknown>): string {
  if (args.action === "run") return typeof args.command === "string" ? args.command : "";
  if (args.action === "write" && args.enter === true) return typeof args.text === "string" ? args.text : "";
  return "";
}

function announce(ctx: ToolContext, action: string): void {
  ctx.emit?.({ e: "terminal", action, at: Date.now() } as AgentEvent);
}

async function runCommand(ws: string, t: Term, payload: string, waitSec: unknown): Promise<string> {
  const waitMs = Math.max(2, Math.min(300, Number(waitSec) || 20)) * 1000;
  let collected = "";
  let exited: number | null = null;
  await new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (quiet) clearTimeout(quiet);
      clearTimeout(hard);
      untap();
      resolve();
    };
    const untap = subscribeTerm(t, (ev) => {
      if (ev.kind === "exit") {
        exited = ev.code ?? null;
        finish();
        return;
      }
      collected += ev.d ?? "";
      if (collected.length > OUT_CAP) collected = collected.slice(-OUT_CAP);
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(finish, QUIET_MS);
    });
    const hard = setTimeout(finish, waitMs);
    writeTerm(ws, payload);
    quiet = setTimeout(finish, Math.min(waitMs, 5000)); // 一直没输出也别干等到超时
  });
  const lines = await renderScreen(collected, t.cols, t.rows);
  const body = lines.length ? tail(lines, 500) : "(no new output)";
  return body + (exited != null ? `\n(the shell exited, code ${exited})` : "") + "\n(The user saw this live in their terminal panel.)";
}

export const terminalTool: Tool = {
  effect: "exec",
  concurrencySafe: false,
  enabled: () => tenantShell(),
  permissionView(args): PermissionView | null {
    if (READ_ACTIONS.has(String(args.action))) return { effect: "read" };
    const command = commandOf(args);
    if (!command.trim()) return null;
    const v = bashTool.permissionView?.({ command }) ?? null;
    if (!v) return null;
    // 共享终端里可能有前台程序，「这是只读命令」的判断不作数：一律按执行算
    const { effect: _effect, ...rest } = v;
    return rest;
  },
  prepare(args, ctx) {
    const command = commandOf(args);
    return command.trim() && bashTool.prepare ? bashTool.prepare({ command }, ctx) : null;
  },
  def: {
    name: "Terminal",
    description:
      "The SHARED terminal in the user's side panel (same PTY they see; PowerShell on Windows, cwd = workspace): whatever " +
      "you type appears live on their screen, and what they ran is in the scrollback you read. read(lines?) = the screen as " +
      "text — use it when they mention their terminal instead of asking them to paste. run(command, waitSec?) types a line + " +
      "Enter and returns output once it goes quiet. write(text, enter?) / keys(\"ctrl+c\", \"up enter\"…) drive prompts, REPLs " +
      "and TUIs. If a program owns the screen (vim, a REPL, a CLI asking something), run/write go to THAT program — read() " +
      "first. status() / restart() (restart wipes it; ask first). Prefer your own Bash for routine work; use this when the " +
      "user should watch or the context is theirs.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "read", "run", "write", "keys", "restart"] },
        command: { type: "string", description: "run: one command line, no trailing newline." },
        text: { type: "string", description: "write: raw text." },
        enter: { type: "boolean", description: "write: press Enter after the text." },
        keys: { type: "string", description: "keys: space-separated names (ctrl+c esc up down left right enter tab …)." },
        repeat: { type: "number", description: "keys: repeat the sequence (max 50)." },
        lines: { type: "number", description: "read: last N lines (default 200, max 3000)." },
        waitSec: { type: "number", description: "run: max seconds to wait (default 20, max 300)." },
      },
      required: ["action"],
    },
  },
  async run(args, ctx): Promise<ToolRunResult> {
    const action = String(args.action ?? "");
    const mode = prefValue<string>("workspace.terminal");
    if (mode === "off") return fail("off", "The user does not let you use their terminal (settings › dimensio › workspace). Use Bash.");
    if (mode === "read" && !READ_ACTIONS.has(action)) {
      return fail("read only", "The user lets you read their terminal but not type into it. Use Bash, or tell them what to run.");
    }
    const ws = ctx.sandbox.root;
    try {
      if (action === "status") {
        const t = getTermIfAny(ws);
        if (!t) return ok("not started", "The terminal is not running (the user has not opened it). run/write/keys start it.");
        return ok("status", `Running: ${t.cols}×${t.rows}, ${t.subs.size} viewer(s), ${Math.round(t.bytes / 1024)}KB scrollback${t.exited ? ", the shell has EXITED (restart opens a new one)" : ""}.`);
      }
      if (action === "read") {
        const t = getTermIfAny(ws);
        if (!t) return ok("not started", "The terminal is not running, nothing to read.");
        const lines = await renderScreen(snapshotTerm(t), t.cols, t.rows);
        const n = Math.max(10, Math.min(3000, Number(args.lines) || 200));
        return { ...ok("read", lines.length ? tail(lines, n) : "(the screen is empty)"), outcome: `读了终端（${lines.length} 行）` };
      }
      if (action === "restart") {
        killTerm(ws);
        const t = ensureTerm(ws);
        announce(ctx, "restart");
        await new Promise((r) => setTimeout(r, 900)); // 等提示符
        return { ...ok("restarted", `Fresh shell (${t.cols}×${t.rows}, scrollback wiped).\n${await screenOf(t)}`), outcome: "重开了终端" };
      }
      if (action !== "run" && action !== "write" && action !== "keys") return fail("bad action", `Unknown action: ${action}.`);

      let payload: string;
      if (action === "run") {
        const command = typeof args.command === "string" ? args.command.replace(/\r?\n$/, "") : "";
        if (!command.trim()) return fail("no command", "run needs command.");
        payload = command + "\r";
      } else if (action === "write") {
        if (typeof args.text !== "string") return fail("no text", "write needs text.");
        payload = args.text + (args.enter === true ? "\r" : "");
      } else {
        const names = String(args.keys ?? "").split(/\s+/).filter(Boolean);
        if (!names.length) return fail("no keys", 'keys needs names, e.g. "ctrl+c" or "esc up enter".');
        const seqs: string[] = [];
        for (const n of names) {
          const s = keySeq(n);
          if (s == null) return fail("bad key", `Unknown key name: ${n}.`);
          seqs.push(s);
        }
        payload = seqs.join("").repeat(Math.max(1, Math.min(50, Number(args.repeat) || 1)));
      }
      const t = ensureTerm(ws); // 退出了的旧壳原地重生
      announce(ctx, action);
      if (action === "run") {
        const out = await runCommand(ws, t, payload, args.waitSec);
        return { ...ok("ran", out), outcome: "在共享终端里跑了命令" };
      }
      writeTerm(ws, payload);
      await new Promise((r) => setTimeout(r, 450)); // 给回显留一拍
      return { ...ok("sent", `Sent. Screen now:\n${await screenOf(t)}`), outcome: action === "keys" ? `按了 ${String(args.keys)}` : "往终端里输入了文字" };
    } catch (e) {
      return fail("terminal error", `Terminal failed: ${(e as Error).message}`);
    }
  },
};
