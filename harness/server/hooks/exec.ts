// 执行一条 hook 命令：用户机器上的任意命令，所以按 harness 自己的辅助进程对待——
//   · shell 与 Bash 工具同一个（Windows 上是 Git Bash，没有就 PowerShell），起跑目录是工作区；
//   · 环境去掉凭据类变量（helperEnv：provider key、harness 令牌、插件密钥都不给），保留真实 HOME——hook 是用户自己配的，
//     ~/.claude/hooks/x.sh 这类路径要能找到；另给 CLAUDE_PROJECT_DIR（Claude Code 的 hook 脚本靠它找项目）；
//   · 超时必杀、会话停止必杀，收整棵进程树（proc-tree.ts）；stdout / stderr 各有上限，超出的丢弃。
import { spawn } from "node:child_process";
import { helperEnv } from "../helper-proc.ts";
import { killChildTree } from "../proc-tree.ts";

// 用 Bash 工具探测到的那个 shell；按需取，静态引会形成模块加载环（Bash 工具模块在加载时就要用到它）
const shellInfo = () => import("../tools/bash/env.ts").then((m) => m.shell);

export const OUTPUT_CAP = 64 * 1024;
// 杀了之后等它真正退出的上限：进程树没收干净时不能让调用方一直挂着
const SETTLE_AFTER_KILL_MS = 5_000;

export interface HookRun {
  code: number | null; // null = 没正常退出（超时、被停、起不来）
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  error?: string; // 起不来的原因
}

export async function runHookCommand(
  command: string,
  input: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<HookRun> {
  const shell = await shellInfo();
  return new Promise<HookRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: Omit<HookRun, "stdout" | "stderr" | "timedOut" | "aborted">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ ...r, stdout, stderr, timedOut, aborted });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.path, shell.argsFor(command), {
        cwd: opts.cwd,
        windowsHide: true,
        env: helperEnv({ CLAUDE_PROJECT_DIR: opts.cwd, DIMENSIO_PROJECT_DIR: opts.cwd }),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: false, error: (e as Error).message });
      return;
    }
    const kill = () => {
      killChildTree(child);
      settleTimer ??= setTimeout(() => finish({ code: null }), SETTLE_AFTER_KILL_MS);
      settleTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    timer.unref?.();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      if (stdout.length < OUTPUT_CAP) stdout = (stdout + d).slice(0, OUTPUT_CAP);
    });
    child.stderr?.on("data", (d: string) => {
      if (stderr.length < OUTPUT_CAP) stderr = (stderr + d).slice(0, OUTPUT_CAP);
    });
    child.on("error", (e) => finish({ code: null, error: e.message }));
    child.on("close", (code) => finish({ code: timedOut || aborted ? null : code }));
    // 命令不读 stdin 就先退出了：写管道报 EPIPE，不算 hook 出错
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}
