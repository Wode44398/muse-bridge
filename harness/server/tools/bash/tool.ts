// Bash 工具本体：参数分派、前台执行与转后台。
import { spawn } from "node:child_process";
import path from "node:path";
import type { Tool, ToolContext, ToolRunResult } from "../types.ts";
import { fail, lenientVerify, verifyIgnored } from "../types.ts";
import { parseShell } from "../shell-words.ts";
import { tenantMode } from "../../tenant.ts";
import { assessParsed, destructiveView, readOnlyCommand, ruleSubjects, shellTouches, stablePrefixes } from "../shell-policy.ts";
import { jobState } from "./state.ts";
import { childEnv, shell } from "./env.ts";
import { type BashJob, BG_DEFAULT_TIMEOUT_MS, BG_MAX_TIMEOUT_MS, BOOT_TAG, foregroundKey, jobsResult, killJob, liveTail, LONG_RUN_MS, MAX_ACTIVE_JOBS, ownedJobs, parseWatch, pollJob, prependNote, startJob, trackJob, WAIT_DEFAULT_MS, waitJob, wakeWaiters } from "./jobs.ts";
import { closeSpill, killTree, type OutBuf, renderOut, spillFor, streamPump, whenFinished } from "./output.ts";
import { commandPolicyViolation, outsideReadDirs, shellDialect } from "./policy.ts";
import { commandCanVerify, unattributableFail, unattributableVerify, VERIFY_ERREXIT, verifyOutcome } from "./verify.ts";
import { commitCwd, CWD_ARG, cwdFile, cwdTrap, dropCwdFile, startDir, takeCwd } from "./cwd.ts";
import { ARG_ALIASES } from "../arg-aliases.ts";

// 派发时带来的当前目录（loop 只在它不是工作区根时写进 CWD_ARG）：权限视图里的相对路径按它补成绝对路径
const viewCwd = (args: Record<string, unknown>): string | null => (typeof args[CWD_ARG] === "string" && args[CWD_ARG] ? (args[CWD_ARG] as string) : null);
const absolutize = (cwd: string | null, words: string[]): string[] =>
  cwd ? words.map((w) => (!w || w.startsWith("-") || path.isAbsolute(w) || /^~|[$`]|^[a-z][a-z0-9+.-]*:\/\//i.test(w) ? w : path.resolve(cwd, w))) : words;

export const bashTool: Tool = {
  effect: "exec",
  concurrencySafe: false,
  aliases: ARG_ALIASES.Bash,
  shellCwd: true,
  // 只读命令（与权限判定的只读降级同一个判法）和别的只读工具一样进并行批；并行批里的 cd 不带回会话
  concurrentFor(args) {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command || args.background === true || args.verify === true || args.jobs === true) return false;
    if ([args.poll, args.wait, args.kill].some((v) => typeof v === "string" && v.trim())) return false;
    return readOnlyCommand(parseShell(command, shellDialect()), viewCwd(args) !== null);
  },
  // P4：按子命令给规则判定（A5）、纯读命令降为 read（C9）、分析不了的高危命令转问（K5）。硬拒仍在 run() 里。
  // P5：顺带给「本会话按前缀允许」的候选前缀。P12：检查点兜不住的操作也转问——这两类都只给字面规则、不给前缀。
  permissionView(args) {
    const command = typeof args.command === "string" ? args.command : "";
    // U11：列 job、看 job 的输出都不跑命令——只读档 / 计划档也能用（kill 不算，那是动作）
    if (!command.trim() && (args.jobs === true || [args.poll, args.wait].some((v) => typeof v === "string" && v.trim()))) return { effect: "read" };
    if (!command.trim()) return null;
    const parsed = parseShell(command, shellDialect());
    const risk = assessParsed(parsed, command);
    const prefixes = stablePrefixes(parsed);
    // 当前目录不在工作区根上：写目标 / 提到的路径按它补成绝对路径（路径规则、拒绝台账、改动记账都按落点判）；
    // 而且等于「先 cd 过去再跑」——git 读命令会读那里的仓库配置，不再降为只读（与同一条命令里带 cd 同一道阀）
    const cwd = viewCwd(args);
    const elsewhere = cwd !== null;
    const touched = shellTouches(parsed, elsewhere);
    const touches = { writes: absolutize(cwd, touched.writes), edits: absolutize(cwd, touched.edits), mentions: absolutize(cwd, touched.mentions) };
    const destructive = destructiveView(parsed, command, elsewhere);
    return {
      ...(readOnlyCommand(parsed, elsewhere) && args.background !== true ? { effect: "read" as const } : {}),
      subjects: ruleSubjects(parsed),
      ...(parsed.unanalyzable ? { partial: true } : {}),
      ...(!risk.deny && risk.ask ? { ask: risk.ask } : {}),
      ...(!risk.deny && risk.irreversible ? { irreversible: risk.irreversible } : {}),
      ...(!risk.deny && risk.why ? { why: risk.why } : {}), // P11：给人看的那句
      ...(prefixes && !risk.ask && !risk.irreversible ? { prefixes } : {}),
      ...(touches.writes.length ? { writes: touches.writes } : {}),
      ...(touches.edits.length ? { edits: touches.edits } : {}),
      ...(touches.mentions.length ? { mentions: touches.mentions } : {}),
      // N26：poll / kill 不跑命令，不算
      ...(destructive.destroys && !args.poll && !args.wait && !args.kill ? { destroys: true } : {}),
      ...(destructive.onlyDestroys ? { onlyDestroys: true } : {}),
    };
  },
  // P11（kimi K20）：注定会被 run() 拦下的命令（危险命令名单、宿主自保、工作区围栏）在弹卡之前就回给模型——以前有 ask 规则
  // 或转问时先弹一张卡，批了才被拦，卡片白问。说法与 run() 里一字不差（run() 仍照拦，直接调 run 的不受影响）。
  prepare(args, ctx) {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return null;
    const readRoots = ctx.sandbox.grantedReadRoots();
    const cwd = startDir(args, ctx).dir;
    const policy = commandPolicyViolation(command, ctx.sandbox.root, ctx.sandbox.access, readRoots, cwd);
    if (!policy) return null;
    // P13：只差「读工作区外」的不在这里否决——run() 报出结构化的越界，loop 问人要不要放行这次读
    if (outsideReadDirs(command, ctx.sandbox.root, ctx.sandbox.access, readRoots, cwd)) return null;
    return { veto: { summary: "blocked", content: policy } };
  },
  def: {
    name: "Bash",
    description:
      `Run a shell command with ${shell.kind}. ` +
      (shell.kind === "powershell"
        ? "Use PowerShell syntax. "
        : "Use POSIX sh syntax — this is NOT PowerShell (no `&` call operator, no `@'...'@` here-strings), even on Windows. ") +
      // 保留目录靠 POSIX 的 EXIT trap：PowerShell 下每次都从工作区根起跑（run() 里 cwdOut 恒为 null），说明跟着分开
      (shell.kind === "powershell"
        ? "Every call starts in the workspace root: state (working directory, environment variables) does NOT persist between calls. "
        : "The first call starts in the workspace root and the working directory persists between calls (a cd carries over); environment variables do not. ") +
      (shell.kind === "bash" && process.platform === "win32"
        ? "Scratch files: this bash resolves /tmp through its own MSYS mount, which native Windows " +
          "programs do NOT share — python/java read \"/tmp/x\" against the current drive instead. " + // guard: tmp-literal ok — 给模型的说明文字，正是在提醒别这么写
          "Put anything both sides must see under $WORKSPACE_TMP (already set, already created) " +
          "or inside the workspace. "
        : "") +
      (tenantMode()
        ? ""
        : "HOME/USERPROFILE/APPDATA/LOCALAPPDATA point to an isolated scratch home, NOT the user's — to look for installed " +
          "programs or user config use $REAL_USERPROFILE / $REAL_LOCALAPPDATA / $REAL_APPDATA, and when launching a GUI app " +
          "that must run as the real user, export those back as USERPROFILE/LOCALAPPDATA/APPDATA for that command. ") +
      "For commands longer than ~2 minutes pass background:true: you get a job id at once, then poll / wait / kill it. " +
      "Servers belong in the Preview tool, not Bash.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute (omit when using poll/kill)." },
        timeout: {
          type: "integer",
          description:
            "Timeout in ms. Sync: default 120000, max 600000 — asking for more runs the command in the background; a sync command " +
            "that reaches its timeout is moved to the background (not killed) and you get a job id to poll. " +
            "Background: hard-kill limit, default 1800000 (30 min), max 7200000.",
        },
        background: {
          type: "boolean",
          description:
            "Run as a background job: returns a job id immediately instead of blocking. For long finite commands, not servers.",
        },
        watch: {
          type: "string",
          description:
            "With background:true: a regular expression (case-insensitive). Each output line that matches is delivered to you as it " +
            'appears (between your steps, or by continuing you after your turn has ended) — e.g. "error|failed|listening on". ' +
            "Use it to react to a long job's progress without polling.",
        },
        poll: { type: "string", description: "Job id to check: returns its accumulated output and status." },
        wait: {
          type: "string",
          description:
            "Job id to wait for: blocks until the job finishes (or until timeout ms, default 120000, max 600000) and returns what poll " +
            "would. Use this instead of polling in a loop or sleeping.",
        },
        kill: { type: "string", description: "Job id to terminate." },
        jobs: {
          type: "boolean",
          description: "List this session's background jobs (id, status, runtime, command) — e.g. to find a job id you no longer have.",
        },
        verify: {
          type: "boolean",
          description:
            "Mark this as completion evidence. Counts only when the command (or polled job) has finished with exit 0 " +
            "and actually ran tests; failed/running commands never clear the post-edit verification gate. The exit " +
            "status must belong to the check: `||` fallbacks, `&` backgrounding and a leading `!` are refused" +
            (shell.kind === "bash"
              ? "; pipes and multiple statements are fine (verify mode runs with set -eo pipefail)."
              : "; only a single plain command counts."),
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const owner = ctx.ownerId ?? "";
    if (args.jobs === true && !String(args.command ?? "").trim()) return jobsResult(owner);
    const pollId = args.poll ? String(args.poll) : "";
    if (pollId) return pollJob(pollId, args.verify === true, owner);
    const waitId = args.wait ? String(args.wait) : "";
    if (waitId) {
      const asked = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : WAIT_DEFAULT_MS;
      return waitJob(waitId, args.verify === true, owner, Math.min(asked, ctx.limits.bashMaxTimeoutMs), ctx);
    }
    const killId = args.kill ? String(args.kill) : "";
    if (killId) return killJob(killId, owner);

    const command = String(args.command ?? "").trim();
    if (!command) {
      return fail("empty command", "No command provided (pass command, poll/kill with a job id, or jobs:true to list the jobs).");
    }
    if (args.verify === true && !commandCanVerify(command)) {
      if (lenientVerify(ctx)) return verifyIgnored(await bashTool.run({ ...args, verify: false }, ctx), "a read-only/trivial command is not a meaningful check");
      return {
        ...fail(
          "not a verification command",
          "This read-only/trivial command cannot be used as completion evidence. Run a relevant test, build, assertion, or program check instead.",
        ),
        verification: { passed: false, detail: `${command} is not meaningful completion evidence` },
      };
    }

    const readRoots = ctx.sandbox.grantedReadRoots();
    const start = startDir(args, ctx);
    // 记着的目录已经用不了（删了、档位收紧了）：会话的当前目录回到工作区根
    if (start.note && ctx.shell && ctx.callId && !ctx.parallel) ctx.shell.cwd = undefined;
    const policy = commandPolicyViolation(command, ctx.sandbox.root, ctx.sandbox.access, readRoots, start.dir);
    if (policy) {
      // P13（X18）：只差「读工作区外」——带上要放行的目录，有人在场时 loop 会问一句、批了就重跑
      const dirs = outsideReadDirs(command, ctx.sandbox.root, ctx.sandbox.access, readRoots, start.dir);
      return { ...fail("blocked", policy), ...(dirs ? { outsideRead: { dirs } } : {}) };
    }

    if (args.verify === true) {
      const why = unattributableVerify(command);
      if (why && lenientVerify(ctx)) return verifyIgnored(await bashTool.run({ ...args, verify: false }, ctx), why);
      if (why) return unattributableFail(command, why);
    }

    const watch = parseWatch(args.watch);
    if (typeof watch === "string") return fail("bad watch", watch);
    if (watch && !args.background) return fail("bad watch", "watch only works with background:true (a foreground command already returns all of its output).");
    if (args.background) {
      const bgTimeout = Math.min(
        BG_MAX_TIMEOUT_MS,
        Math.max(1000, Number(args.timeout ?? BG_DEFAULT_TIMEOUT_MS)),
      );
      return withNote(await startJob(command, bgTimeout, start.dir, args.verify === true, owner, watch ?? undefined), start.note);
    }

    const asked = Number(args.timeout ?? ctx.limits.bashTimeoutMs);
    const requested = Number.isFinite(asked) ? asked : ctx.limits.bashTimeoutMs;
    // R14（N32）：要的时限超过前台上限，就直接交给后台 job——以前先在前台跑满上限再杀，白等 10 分钟还丢了结果。
    if (requested > ctx.limits.bashMaxTimeoutMs) {
      const started = await startJob(command, Math.min(BG_MAX_TIMEOUT_MS, requested), start.dir, args.verify === true, owner);
      return prependNote(
        started,
        `(The requested timeout of ${requested} ms is above the ${ctx.limits.bashMaxTimeoutMs} ms foreground limit, so this runs as a background job.)`,
      );
    }
    const timeout = Math.min(ctx.limits.bashMaxTimeoutMs, Math.max(1000, requested));

    const verifyMode = args.verify === true && shell.kind === "bash";
    // 跨调用保留当前目录：loop 派发的、不在并行批里的前台命令才带走 cd（PowerShell 不支持，始终从起跑目录开始）
    const cwdOut = ctx.shell && ctx.callId && !ctx.parallel && shell.kind !== "powershell" ? cwdFile() : null;
    const runCmd = (cwdOut ? cwdTrap(cwdOut) : "") + (verifyMode ? VERIFY_ERREXIT : "") + command;
    return await new Promise<ToolRunResult>((resolve) => {
      const startedAt = Date.now();
      const child = spawn(shell.path, shell.argsFor(runCmd), {
        cwd: start.dir,
        windowsHide: true,
        env: childEnv(),
      });

      const out: OutBuf = { head: "", tail: "", omitted: 0, spillTo: spillFor(ctx.ownerId) };
      const stdoutPump = streamPump(out);
      const stderrPump = streamPump(out);
      child.stdout.on("data", stdoutPump.write);
      child.stderr.on("data", stderrPump.write);

      // 这两条路径必须走 killTree，不能走 child.kill()。child 是 shell（Windows 上
      // 是 git-bash.exe），真正干活的命令是它的孙进程；TerminateProcess 只打 shell，
      // 孙进程当场变孤儿继续跑。实测（2026-09-10，bash -c 起一个每 300ms 写文件的
      // node）：plain kill 之后 4 秒内文件从 10 行涨到 23 行，taskkill /T /F 之后
      // 只多 1 行。后台 job 那条路一直是对的（startJob/killJob 都用 killTree），
      // 就这条同步路径漏了——表现就是「点了停止、按钮灰了，进程还在跑」。
      // 杀完还要 markKilled：进程万一没死透，'exit' 不会来，靠它保证有结局。
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let moved: BashJob | null = null;
      let bgTimer: ReturnType<typeof setTimeout> | undefined;
      const fgKey = ctx.callId ? foregroundKey(owner, ctx.callId) : null;

      const abort = () => {
        aborted = true;
        killTree(child);
        finished.markKilled();
      };

      // R14（B4 / K37）：到点（或用户点了「转后台」）不杀——把还活着的进程连同输出缓冲移交给后台 job 表，这一次调用先交回已有的
      // 输出和 job id，之后照常 poll / kill。后台的硬上限从开跑算 30 分钟。后台 job 已满时返回 false，调用方退回老办法（杀掉）。
      const moveToBackground = (why: "timeout" | "user"): boolean => {
        if (moved || settled) return false;
        if (ownedJobs(owner).filter((j) => !j.done).length >= MAX_ACTIVE_JOBS) return false;
        if (timer) clearTimeout(timer);
        stopTicker();
        ctx.signal?.removeEventListener("abort", abort);
        if (fgKey) jobState.foreground.delete(fgKey);
        const id = `job${++jobState.jobSeq}-${BOOT_TAG}`;
        const job: BashJob = {
          id, command, child, out, done: false, exitCode: null, timedOut: false, startedAt, owner,
          markKilled: finished.markKilled, verifyMode, waiters: new Set(),
        };
        jobState.jobs.set(id, job);
        trackJob(job);
        moved = job;
        bgTimer = setTimeout(() => {
          job.timedOut = true;
          killTree(child);
          finished.markKilled();
        }, Math.max(60_000, BG_DEFAULT_TIMEOUT_MS - (Date.now() - startedAt)));
        const secs = Math.round((Date.now() - startedAt) / 1000);
        const who = why === "user" ? "the user moved it" : "it hit the timeout and was moved";
        resolve({
          ok: true,
          summary: `bash: ${command.slice(0, 60)}${command.length > 60 ? "…" : ""} (moved to background as ${id})`,
          outcome: `跑了 ${secs} 秒还没完，转到后台继续（${id}）`,
          content: [{
            t: "text",
            text: `$ ${command}\n${renderOut(out) || "(no output yet)"}\n[still running after ${secs}s — ${who} to the background as ${id} ` +
              `instead of being killed. Poll it with Bash(poll:"${id}"), stop it with Bash(kill:"${id}").]`,
          }],
        });
        return true;
      };
      if (fgKey) jobState.foreground.set(fgKey, () => moveToBackground("user"));

      // R14（K37）：运行中的实时尾行——每秒看一次，输出有变化才推（跑满 10 秒时也推一次，界面据此亮「转后台」）；先脱敏。
      let lastTail: string | null = null;
      let longRun = false;
      const ticker =
        ctx.emit && ctx.callId
          ? setInterval(() => {
              const tail = liveTail(out);
              const elapsedMs = Date.now() - startedAt;
              const crossed = !longRun && elapsedMs >= LONG_RUN_MS;
              if (tail === lastTail && !crossed) return;
              lastTail = tail;
              if (crossed) longRun = true;
              ctx.emit!({ e: "tool_progress", id: ctx.callId!, tail, elapsedMs, canBackground: Boolean(fgKey) });
            }, 1_000)
          : undefined;
      const stopTicker = () => {
        if (ticker) clearInterval(ticker);
      };

      // R13：落盘文件写完关上之后再出结果（模型下一步就可能去 Read 它）
      const settleRun = async (code: number | null) => {
        settled = true;
        if (fgKey) jobState.foreground.delete(fgKey);
        if (timer) clearTimeout(timer);
        stopTicker();
        ctx.signal?.removeEventListener("abort", abort);
        if (moved) {
          // 已经转了后台：这次调用早就交回了，这里只给 job 收尾（它里面的 cd 不带回会话）
          if (bgTimer) clearTimeout(bgTimer);
          if (cwdOut) dropCwdFile(cwdOut);
          await closeSpill(out);
          moved.done = true;
          moved.exitCode = code;
          moved.endedAt ??= Date.now();
          wakeWaiters(moved);
          return;
        }
        await closeSpill(out);
        let body = renderOut(out);
        if (timedOut) {
          body +=
            `\n…[killed after ${timeout}ms timeout]` +
            (timeout >= ctx.limits.bashMaxTimeoutMs
              ? " — for longer commands, re-run with background:true and poll for output"
              : "");
        }
        if (aborted) body += "\n…[已中止 — 进程树已 kill]";
        const status = timedOut ? "timeout" : aborted ? "aborted" : `exit ${code}`;
        const header = `$ ${command}\n`;
        // 目录变了说一句（核不过的复位也说）；被中止 / 超时杀掉的不带走目录
        let cwdNote = "";
        if (cwdOut && (timedOut || aborted)) dropCwdFile(cwdOut);
        else if (cwdOut) cwdNote = commitCwd(ctx, start.dir, takeCwd(cwdOut));
        const parallelCd = ctx.parallel && ctx.shell && /(?:^|[\s;&|(])(?:cd|pushd)(?:\s|$)/.test(command)
          ? "[This ran in a parallel batch, so its cd does not carry over to later calls.]"
          : "";
        const notes = [start.note, cwdNote, parallelCd].filter(Boolean).join("\n");
        // U8（K36）：工具行第二行只说结果
        const outLines = body.split("\n").filter((l) => l.trim()).length;
        const outcome = timedOut
          ? `超时（${Math.round(timeout / 1000)} 秒）被停下`
          : aborted
            ? "被中止"
            : `退出码 ${code}${outLines ? ` · ${outLines} 行输出` : " · 没有输出"}`;
        resolve({
          ok: !timedOut && !aborted && code === 0,
          summary: `bash: ${command.slice(0, 60)}${command.length > 60 ? "…" : ""} (${status})`,
          outcome,
          content: [{ t: "text", text: header + (body || "(no output)") + `\n[${status}]` + (notes ? `\n${notes}` : "") }],
          ...(args.verify === true
            ? { verification: verifyOutcome(command, status, !timedOut && !aborted && code === 0, body) }
            : {}),
        });
      };
      const finished = whenFinished(child, [stdoutPump, stderrPump], (code) => void settleRun(code));

      timer = setTimeout(() => {
        if (moveToBackground("timeout")) return;
        timedOut = true;
        killTree(child);
        finished.markKilled();
      }, timeout);

      ctx.signal?.addEventListener("abort", abort, { once: true });

      child.on("error", (e) => {
        settled = true;
        if (cwdOut) dropCwdFile(cwdOut);
        if (fgKey) jobState.foreground.delete(fgKey);
        if (timer) clearTimeout(timer);
        stopTicker();
        ctx.signal?.removeEventListener("abort", abort);
        resolve(fail("spawn failed", `Failed to run command: ${e.message}`));
      });
    });
  },
};

// 起跑目录用不了、回到了工作区根：结果里说一句
function withNote(res: ToolRunResult, note?: string): ToolRunResult {
  if (!note) return res;
  return prependNote(res, note);
}
