// 后台 job：启动、轮询、等待、收掉、watch、事件订阅与会话视图。
import { type ChildProcess, spawn } from "node:child_process";
import type { ToolContext, ToolRunResult } from "../types.ts";
import { fail, ok } from "../types.ts";
import { disposeAll, disposeOwner, registerResource } from "../../resources.ts";
import { jobState } from "./state.ts";
import { childEnv, shell } from "./env.ts";
import { closeSpill, dropJavaPickup, killTree, type OutBuf, pushOut, redactSecrets, renderOut, spillFor, streamPump, whenFinished } from "./output.ts";
import { controlOperators, unattributableVerify, VERIFY_ERREXIT, verifyOutcome } from "./verify.ts";

// ── Background jobs ───────────────────────────────────────────────────────────
// The sync path blocks until close and is capped at bashMaxTimeoutMs (10 min) —
// too short for full test suites of big repos. A background job returns a job id
// immediately, keeps running across turns, and is read back via poll. Servers
// still belong to the Preview tool (port-aware, live pane); this is for finite
// long commands. Jobs intentionally ignore the per-run abort signal — they are
// meant to outlive the turn — and die on poll/kill, hard timeout, or shutdown.

export interface BashJob {
  id: string;
  command: string;
  child: ChildProcess;
  out: OutBuf;
  done: boolean;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: number;
  // Session that started it ("" = unowned: sub-agents, tests, headless). poll and
  // kill only ever see jobs with the SAME owner, so a second concurrent session
  // cannot read another's output or kill its test run.
  owner: string;
  // 兜底收线：kill 之后进程没死透时，还是把 job 标成 done（见 whenFinished）。
  markKilled: () => void;
  // V1：以 verify:true 启动（bash 下带着 set -eo pipefail 跑）——之后 poll 时才能拿它当证据。
  verifyMode: boolean;
  // U11：结束的时刻（列表里算跑了多久）；killed = 被 Bash(kill) 或界面「停止」收掉的（不是自己退的）
  endedAt?: number;
  killed?: boolean;
  // O6（K63）：Bash(wait) 在等它的（结束时逐个唤醒）
  waiters: Set<() => void>;
  // 模型已经亲眼看到它的结局（poll/wait 拿到了结束状态，或是它自己 kill 的）——World State 不再把它当新消息报
  seenDone?: boolean;
  // World State 的 jobs 节已经把它的结局写进过一次请求（模型看到过一句「jobN (exit 0)」）——收尾时不必再叫醒会话
  announced?: boolean;
  // watch：输出里匹配这条正则的行要通知模型（只给以 background:true 起的 job）
  watch?: RegExp;
}

// 后台 job 的事件（job-notify.ts 订阅）：结束、watch 命中的行。只报有会话归属的 job（子 agent / 测试的不报）。
export interface JobEndInfo {
  id: string;
  owner: string;
  command: string;
  status: string; // exit 0 / exit 1 / timed out / killed
  ok: boolean;
  byUser: boolean; // 用户在界面上停的（他自己知道，不用再告诉模型）
  tail: string; // 输出末尾（已脱敏）
}
export type JobListener = {
  end?: (info: JobEndInfo) => void;
  lines?: (job: { id: string; owner: string; command: string }, lines: string[]) => void;
};
export function onBackgroundJobs(l: JobListener): () => void {
  jobState.jobListeners.add(l);
  return () => jobState.jobListeners.delete(l);
}

const JOB_TAIL_LINES = 20;
function jobTail(b: OutBuf): string {
  const text = redactSecrets(dropJavaPickup(b.tail || b.head)).replace(/\s+$/, "");
  const lines = text.split("\n");
  const tail = lines.slice(-JOB_TAIL_LINES).join("\n");
  return tail.length > 3_000 ? `…${tail.slice(-3_000)}` : tail;
}

export function wakeWaiters(job: BashJob): void {
  for (const wake of [...job.waiters]) wake();
  if (!job.owner || !jobState.jobListeners.size) return;
  const info: JobEndInfo = {
    id: job.id,
    owner: job.owner,
    command: job.command,
    status: job.timedOut ? "timed out" : job.exitCode === null ? "killed" : `exit ${job.exitCode}`,
    ok: !job.timedOut && job.exitCode === 0,
    byUser: Boolean(job.killed),
    tail: jobTail(job.out),
  };
  for (const l of jobState.jobListeners) {
    try {
      l.end?.(info);
    } catch {
      /* 订阅方的问题 */
    }
  }
}

// 这个 job 此刻要不要叫醒会话：结局模型还没见过（没 poll / wait / kill 到，World State 也没报过）
export function jobNeedsNotice(owner: string, id: string): boolean {
  const j = findJob(id, owner);
  return Boolean(j && j.done && !j.seenDone && !j.announced);
}
// 通知已经送进会话：当作模型看到了结局
export function markJobNoticed(owner: string, id: string): void {
  const j = findJob(id, owner);
  if (j) j.seenDone = true;
}

// watch：按行切（半行留到下一段），命中的行交给订阅方；一个 job 最多报 WATCH_MAX_LINES 行，超了只报一次「后面不再报」
const WATCH_MAX_LINES = 200;
function attachWatch(job: BashJob): void {
  const re = job.watch;
  if (!re) return;
  let carry = "";
  let sent = 0;
  job.out.onText = (s) => {
    if (sent >= WATCH_MAX_LINES || !jobState.jobListeners.size) return;
    const parts = (carry + s).split(/\r?\n/);
    carry = parts.pop() ?? "";
    if (carry.length > 4_000) carry = carry.slice(-4_000);
    const hits: string[] = [];
    for (const line of parts) {
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      const clean = redactSecrets(line).slice(0, 500);
      hits.push(clean);
      if (++sent >= WATCH_MAX_LINES) {
        hits.push(`[watch: ${WATCH_MAX_LINES} matching lines reported — no more lines from this job will be reported; poll it for the rest]`);
        break;
      }
    }
    if (!hits.length) return;
    for (const l of jobState.jobListeners) {
      try {
        l.lines?.({ id: job.id, owner: job.owner, command: job.command }, hits);
      } catch {
        /* 订阅方的问题 */
      }
    }
  };
}

// watch 参数：一条正则（不分大小写）。编译不过就当场报给模型
export function parseWatch(v: unknown): RegExp | string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return "watch must be a regular expression string";
  if (v.length > 300) return "watch is too long (max 300 characters)";
  try {
    return new RegExp(v, "i");
  } catch (e) {
    return `watch is not a valid regular expression: ${(e as Error).message}`;
  }
}

// O6（K63）：job id 带这个进程的启动标记（job3-k2x9）。以前是进程内计数 job3——harness 一重启又从 job1 编起，模型拿重启前的
// job3 去 poll，读到的是重启后另一个 job 的输出（同一会话），或者只得到一句「没有这个 job」、不知道为什么。
const BOOT_AT = Date.now();
export const BOOT_TAG = BOOT_AT.toString(36).slice(-4);

// 按 id 找这个会话的 job：完整 id 精确匹配；不带标记的 job3 按本进程的第 3 个（兼容旧写法）
function findJob(id: string, owner: string): BashJob | undefined {
  const exact = jobState.jobs.get(id);
  if (exact) return exact.owner === owner ? exact : undefined;
  const bare = /^job(\d+)$/.exec(id);
  const j = bare ? jobState.jobs.get(`job${bare[1]}-${BOOT_TAG}`) : undefined;
  return j?.owner === owner ? j : undefined;
}

// 找不到的 job：带着别的启动标记（或者是重启前的旧写法）→ 明说是重启丢的，别让模型对着「不存在」发愣
function unknownJob(id: string, owner: string): ToolRunResult {
  const known = ownedJobs(owner).map((x) => x.id).join(", ") || "(none)";
  const tag = /^job\d+-([a-z0-9]+)$/.exec(id)?.[1];
  const fromBefore = (tag !== undefined && tag !== BOOT_TAG) || /^job\d+$/.test(id);
  const since = new Date(BOOT_AT).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return fail(
    "unknown job",
    fromBefore
      ? `No background job "${id}" in this harness process. Background jobs do not survive a harness restart, and this process ` +
          `started at ${since} — a job started before that was stopped with it. Known jobs now: ${known}. Re-run the command if you still need it.`
      : `No background job "${id}". Known jobs: ${known}.`,
  );
}

// R14（K37）：正在前台跑的 Bash 调用（会话 + 调用 id → 转后台的开关）。界面上的「转后台」经 API 按到这里；只认同一个会话的。
export const foregroundKey = (owner: string, callId: string) => `${owner}\u0000${callId}`;
export function moveForegroundToBackground(owner: string, callId: string): boolean {
  return jobState.foreground.get(foregroundKey(owner, callId))?.() ?? false;
}

// R14（K37）：界面上的实时尾行——最后 12 行、至多 2000 字，先脱敏；跑满这么久才给「转后台」按钮
export const LONG_RUN_MS = 10_000;
export function liveTail(b: OutBuf): string {
  const text = redactSecrets(dropJavaPickup(b.tail || b.head));
  return text.split("\n").slice(-12).join("\n").slice(-2_000);
}

export function prependNote(r: ToolRunResult, note: string): ToolRunResult {
  const [first, ...rest] = r.content ?? [];
  if (first?.t !== "text") return { ...r, content: [{ t: "text", text: note }, ...(r.content ?? [])] };
  return { ...r, content: [{ t: "text", text: `${note}\n${first.text}` }, ...rest] };
}
export const MAX_ACTIVE_JOBS = 8;
export const BG_DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min hard kill unless overridden
export const BG_MAX_TIMEOUT_MS = 7_200_000; // 2 h ceiling
const BG_EARLY_WINDOW_MS = 1_200; // catch instant failures before returning

// Jobs visible to one owner. Scoping is per session, so the 8-job budget is
// per session too (a busy session can't starve another out of background slots).
export const ownedJobs = (owner: string) => [...jobState.jobs.values()].filter((j) => j.owner === owner);

export async function startJob(
  command: string,
  timeoutMs: number,
  cwd: string,
  verify: boolean,
  owner: string,
  watch?: RegExp,
): Promise<ToolRunResult> {
  const active = ownedJobs(owner).filter((j) => !j.done).length;
  if (active >= MAX_ACTIVE_JOBS) {
    return fail(
      "too many jobs",
      `${MAX_ACTIVE_JOBS} background jobs are already running. Poll them (Bash(poll:"<id>")) or kill one (Bash(kill:"<id>")) first.`,
    );
  }
  const id = `job${++jobState.jobSeq}-${BOOT_TAG}`;
  const verifyMode = verify && shell.kind === "bash";
  const child = spawn(shell.path, shell.argsFor(verifyMode ? VERIFY_ERREXIT + command : command), {
    cwd,
    windowsHide: true,
    env: childEnv(),
  });
  const job: BashJob = {
    id,
    command,
    child,
    out: { head: "", tail: "", omitted: 0, spillTo: spillFor(owner || undefined) },
    done: false,
    exitCode: null,
    timedOut: false,
    startedAt: Date.now(),
    owner,
    markKilled: () => {},
    verifyMode,
    waiters: new Set(),
    ...(watch && owner ? { watch } : {}),
  };
  jobState.jobs.set(id, job);
  trackJob(job);
  attachWatch(job);

  const stdoutPump = streamPump(job.out);
  const stderrPump = streamPump(job.out);
  child.stdout?.on("data", stdoutPump.write);
  child.stderr?.on("data", stderrPump.write);

  let timer: ReturnType<typeof setTimeout> | undefined;
  // 早退窗口的收线；命令结束得比窗口还快就当场松开。
  let onFinished: () => void = () => {};

  // 同步路径那个死锁在这儿是另一副面孔：job 永远不 done，poll 永远回「running for
  // Ns」，kill 打的又是早就退了的 shell —— 一个已经结束的 job 在会话里永远交代不掉。
  const finished = whenFinished(child, [stdoutPump, stderrPump], (code) => {
    if (timer) clearTimeout(timer);
    // R13：落盘文件写完关上再报完成（poll 到「完成」时文件已经齐了）
    void closeSpill(job.out).finally(() => {
      job.done = true;
      job.exitCode = code;
      job.endedAt ??= Date.now();
      onFinished();
      wakeWaiters(job);
    });
  });
  job.markKilled = finished.markKilled;

  timer = setTimeout(() => {
    job.timedOut = true;
    killTree(child);
    finished.markKilled();
  }, timeoutMs);

  child.on("error", (e) => {
    pushOut(job.out, `\n[spawn error: ${e.message}]`);
    job.done = true;
    job.endedAt ??= Date.now();
    if (timer) clearTimeout(timer);
    onFinished();
    wakeWaiters(job);
  });

  // Brief grace window so a typo'd command reports its failure right away
  // instead of costing the model a poll turn to discover it.
  await new Promise<void>((resolve) => {
    if (job.done) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, BG_EARLY_WINDOW_MS);
    onFinished = () => {
      clearTimeout(t);
      resolve();
    };
  });

  if (job.done) {
    job.seenDone = true;
    const status = job.timedOut ? "timeout" : `exit ${job.exitCode}`;
    const output = renderOut(job.out);
    return {
      ok: !job.timedOut && job.exitCode === 0,
      summary: `bash job ${id} exited immediately (${status})`,
      content: [
        {
          t: "text",
          text: `$ ${command}\n[background job ${id} exited immediately: ${status}]\n${output || "(no output)"}`,
        },
      ],
      ...(verify ? { verification: verifyOutcome(command, status, !job.timedOut && job.exitCode === 0, output) } : {}),
    };
  }
  const early = renderOut(job.out);
  return {
    ok: true,
    summary: `bash job ${id} started: ${command.slice(0, 50)}${command.length > 50 ? "…" : ""}`,
    content: [
      {
        t: "text",
        text:
          `Started background job ${id}: $ ${command}\n` +
          `It keeps running across turns (hard kill after ${Math.round(timeoutMs / 60_000)} min). ` +
          `Read its output with Bash(poll:"${id}"); stop it with Bash(kill:"${id}").` +
          (owner && jobState.jobListeners.size
            ? ` If it finishes after your turn has ended, you are continued automatically with its result — no need to stay ` +
              `around polling; use Bash(wait:"${id}") only when you need the result before you can go on.` +
              (job.watch ? " Output lines matching watch are delivered to you as they appear." : "")
            : "") +
          (early ? `\nEarly output:\n${early}` : ""),
      },
    ],
  };
}

export function pollJob(id: string, verify: boolean, owner: string, waited?: { ms: number; stillRunning: boolean }): ToolRunResult {
  const j = findJob(id, owner);
  // Another session's job reads as "unknown" — never confirm it exists, and never
  // hand back its output.
  if (!j) return unknownJob(id, owner);
  const elapsed = Math.round((Date.now() - j.startedAt) / 1000);
  const status = j.done
    ? j.timedOut
      ? "killed by timeout"
      : `exit ${j.exitCode}`
    : `running for ${elapsed}s`;
  if (j.done) j.seenDone = true;
  const output = renderOut(j.out);
  const body = output || "(no output yet)";
  // V1：poll 时拿 job 当证据，它得是以 verify:true 启动的（pipefail 已开），或本来就是一条单独的命令。
  const why = verify
    ? unattributableVerify(j.command) ??
      (!j.verifyMode && controlOperators(j.command.trim()).length
        ? "the job was started without verify:true, so its pipes/statements ran without pipefail"
        : null)
    : null;
  return {
    ok: j.done ? !j.timedOut && j.exitCode === 0 : true,
    summary: `bash job ${j.id}: ${status}`,
    content: [
      {
        t: "text",
        text:
          `$ ${j.command}\n[${status}]\n${body}` +
          (j.done
            ? ""
            : waited?.stillRunning
              ? `\n[still running after waiting ${Math.round(waited.ms / 1000)}s — wait again, poll later, or kill it]`
              : "\n[still running — wait for it, poll again later, or kill it]") +
          (why ? `\n[not recorded as verification evidence: ${why}]` : ""),
      },
    ],
    ...(verify && j.done && !why
      ? { verification: verifyOutcome(j.command, status, !j.timedOut && j.exitCode === 0, output) }
      : {}),
  };
}

export function killJob(id: string, owner: string): ToolRunResult {
  const j = findJob(id, owner);
  if (!j) return unknownJob(id, owner);
  if (!j.done) {
    j.killed = true;
    killTree(j.child);
    j.markKilled();
  }
  j.seenDone = true;
  return {
    ok: true,
    summary: `bash job ${j.id} killed`,
    content: [
      { t: "text", text: `Killed job ${j.id}.\nOutput so far:\n${renderOut(j.out) || "(no output)"}` },
    ],
  };
}

// O6（K63）：等一个后台 job 跑完（或等到时限）再交回，和 poll 同样的输出——以前模型只能一遍遍 poll，或者自己 sleep 再 poll。
// 这一轮被停止时不等了、照当下的样子交回；等的时候照前台命令的样子推实时尾行。
export const WAIT_DEFAULT_MS = 120_000;
export async function waitJob(id: string, verify: boolean, owner: string, timeoutMs: number, ctx: ToolContext): Promise<ToolRunResult> {
  const j = findJob(id, owner);
  if (!j) return unknownJob(id, owner);
  const started = Date.now();
  if (!j.done) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearInterval(tick);
        clearTimeout(limit);
        j.waiters.delete(done);
        ctx.signal?.removeEventListener("abort", done);
        resolve();
      };
      j.waiters.add(done);
      const limit = setTimeout(done, timeoutMs);
      const tick = setInterval(() => {
        if (ctx.emit && ctx.callId) ctx.emit({ e: "tool_progress", id: ctx.callId, tail: liveTail(j.out), elapsedMs: Date.now() - j.startedAt, canBackground: false });
      }, 1_000);
      if (ctx.signal?.aborted) done();
      else ctx.signal?.addEventListener("abort", done, { once: true });
    });
  }
  return pollJob(j.id, verify, owner, { ms: Date.now() - started, stillRunning: !j.done });
}

// O6（K63）：压缩之后提醒还在跑的 job——摘要的锚点索引收不到 job id，模型压完就不知道自己有什么在跑
export function runningJobsSummary(owner: string): string {
  return ownedJobs(owner)
    .filter((j) => !j.done)
    .map((j) => `${j.id} ($ ${j.command.length > 60 ? j.command.slice(0, 60) + "…" : j.command}; running ${Math.max(1, Math.round((Date.now() - j.startedAt) / 60_000))} min)`)
    .join(", ");
}

// U11：一个会话的后台 job 一览——Bash(jobs:true) 给模型（压缩之后 job id 丢了也找得回来），/api/sessions/:id/jobs 给
// 任务面板。只认这个会话自己的；输出只给实时尾行那一截（最后 12 行、至多 2000 字、先脱敏），命令本身也先脱敏。
export interface JobInfo {
  id: string;
  command: string;
  state: "running" | "exited" | "timeout" | "killed";
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  // 按服务端时钟算好的已跑时长——手机与电脑的时钟对不齐，界面拿它加上本机流逝的时间，不自己拿 startedAt 减
  elapsedMs: number;
  tail: string;
}

function jobInfo(j: BashJob): JobInfo {
  const state = !j.done ? "running" : j.timedOut ? "timeout" : j.killed ? "killed" : "exited";
  const endedAt = j.done ? j.endedAt : undefined;
  return {
    id: j.id,
    command: redactSecrets(j.command).slice(0, 2_000),
    state,
    exitCode: j.exitCode,
    startedAt: j.startedAt,
    ...(endedAt ? { endedAt } : {}),
    elapsedMs: Math.max(0, (endedAt ?? Date.now()) - j.startedAt),
    tail: liveTail(j.out),
  };
}

// 新的在前
export function listJobs(owner: string): JobInfo[] {
  return ownedJobs(owner)
    .map(jobInfo)
    .sort((a, b) => b.startedAt - a.startedAt || Number(b.id.slice(3)) - Number(a.id.slice(3)));
}

// 界面「停止」：只认这个会话自己的、还在跑的 job。false = 没有这个 job / 已经结束了。
export function stopJob(owner: string, id: string): boolean {
  const j = findJob(id, owner);
  if (!j || j.done) return false;
  killJob(j.id, owner);
  return true;
}

export function jobsResult(owner: string): ToolRunResult {
  const list = listJobs(owner);
  if (!list.length) return ok("bash jobs: none", "No background jobs in this session.");
  const line = (j: JobInfo) => {
    const secs = Math.round(j.elapsedMs / 1000);
    const status =
      j.state === "running"
        ? `running for ${secs}s`
        : j.state === "timeout"
          ? `killed by timeout after ${secs}s`
          : j.state === "killed"
            ? `killed after ${secs}s`
            : `exit ${j.exitCode} after ${secs}s`;
    return `- ${j.id} · ${status} · $ ${j.command.length > 200 ? `${j.command.slice(0, 200)}…` : j.command}`;
  };
  const running = list.filter((j) => j.state === "running").length;
  return ok(
    `bash jobs: ${running} running, ${list.length - running} finished`,
    `Background jobs of this session (${list.length}, newest first):\n${list.map(line).join("\n")}\n` +
      'Read one\'s output with Bash(poll:"<id>"); stop a running one with Bash(kill:"<id>").',
  );
}

// M5（K03）：后台 job 一起来就进会话资源账本（resources.ts）——停止 / 删除会话由账本逆序收掉：活着的杀进程树，
// 记录一并删。两条起 job 的路（startJob、前台转后台）都登记。
export function trackJob(job: BashJob): void {
  registerResource(job.owner, "job", job.id, () => {
    const live = !job.done;
    if (live) killTree(job.child);
    jobState.jobs.delete(job.id);
    return live;
  });
}

// Shutdown cleanup (wired into the server's exit handlers).
export function killAllJobs(): void {
  disposeAll("shutdown", ["job"]);
  for (const j of jobState.jobs.values()) {
    if (!j.done) killTree(j.child);
  }
  jobState.jobs.clear();
}

// Stop one session's background jobs — what "stop this session" has to mean, and
// what session deletion needs so a deleted conversation's test run doesn't keep
// burning CPU. Returns how many live jobs were actually killed.
export function killJobsFor(owner: string): number {
  return disposeOwner(owner, "stop", ["job"]).job;
}

// Live job count for one owner (stopSession reports honestly with this).
export function liveJobCount(owner: string): number {
  return ownedJobs(owner).filter((j) => !j.done).length;
}

// C4：这个会话已经结束的后台 job（World State 的 jobs 节）。只列结束了的——开跑是模型自己做的，结束它才不知道；
// 不带耗时之类每轮都变的东西，只在又有 job 结束时才变。模型已经 poll / wait 到结局或自己 kill 的不算新消息，不列。
export function finishedJobsSummary(owner: string): string {
  const done = ownedJobs(owner).filter((j) => j.done && !j.seenDone);
  // 这一节会跟着这次请求发出去：模型看到了「jobN (exit 0)」，收尾时 job-notify 不必再叫醒会话报同一件事
  for (const j of done) j.announced = true;
  return done
    .map((j) => `${j.id} (${j.timedOut ? "timed out" : j.exitCode === null ? "killed" : `exit ${j.exitCode}`})`)
    .join(", ");
}
