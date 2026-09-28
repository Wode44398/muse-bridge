// Q13（X49 / K50 / F4，按 Codex C8 修订）：诊断内存环 + 崩溃留痕。
//
// 以前 harness 的输出混在 bridge 的 stdout 里、server.log 停在 07-07——手机上「卡住了、慢了、报错了」之后，想看当时
// harness 说过什么，无处可查。现在：进程里所有 console 输出照常打印，同时进一个 4 MiB 的内存环，每条带当时所在的会话 /
// traceId（Q12 的 AsyncLocalStorage）。只在两种时候落盘：
//   · 用户导出诊断包：取这个会话的切片（diagnostics.ts）；
//   · 进程非正常退出前（fatal-guard 判定坏状态、任何非零退出码）：整环落一次盘 = 崩溃留痕。
// 比按会话滚动日志文件轻（Windows 上滚动文件还有句柄占用的麻烦）。每条先脱敏、截断；写诊断失败一律吞掉。
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { sessionsDir } from "./paths.ts";
import { redactOutput } from "./redact.ts";
import { currentTrace } from "./trace.ts";

export type RingLevel = "log" | "info" | "warn" | "error";
export interface RingEntry {
  t: number;
  level: RingLevel;
  session?: string;
  trace?: string;
  msg: string;
}

export const RING_MAX_BYTES = 4 << 20;
const ENTRY_MAX = 4000;
const CRASH_KEEP = 10;

let ring: RingEntry[] = [];
let ringBytes = 0;
let installed = false;
let dumped = false;

export function ringPush(level: RingLevel, args: unknown[], at = Date.now()): void {
  try {
    let msg = format(...args).replace(/\x1b\[[0-9;]*m/g, "");
    if (msg.length > ENTRY_MAX * 2) msg = msg.slice(0, ENTRY_MAX * 2); // 先截再脱敏：超长输出不整段进正则
    msg = redactOutput(msg);
    if (msg.length > ENTRY_MAX) msg = `${msg.slice(0, ENTRY_MAX)}…(truncated)`;
    const t = currentTrace();
    const entry: RingEntry = { t: at, level, ...(t ? { session: t.sessionId, trace: t.traceId } : {}), msg };
    ring.push(entry);
    ringBytes += msg.length + 64;
    while (ringBytes > RING_MAX_BYTES && ring.length > 1) ringBytes -= ring.shift()!.msg.length + 64;
  } catch {
    /* 诊断永不影响主链路 */
  }
}

// console.* 照常打印，同时进环（幂等：装一次）
export function installConsoleRing(): void {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      ringPush(level, args);
      original(...args);
    };
  }
  // 任何非零退出（包括 fatal-guard 主动退出）之前把整环落一次盘；fatal-guard 带着错误先落过的不重复
  process.on("exit", (code) => {
    if (code !== 0) dumpRingSync(`process exit ${code}`);
  });
}

// 某个会话的切片；不给会话 = 没有会话标签的条目（代理探测、启动这类进程级输出）
export function ringSlice(sessionId?: string, limit = 2000): RingEntry[] {
  const hit = ring.filter((e) => (sessionId ? e.session === sessionId : !e.session));
  return hit.slice(-limit);
}

export function diagnosticsDir(): string {
  return path.join(sessionsDir(), "diagnostics");
}

// 崩溃留痕：同步写（退出路径上等不了异步），只留最近 CRASH_KEEP 份。返回写下的文件，写不成返回 null。
export function dumpRingSync(reason: string, error?: unknown): string | null {
  if (dumped) return null;
  dumped = true;
  try {
    const dir = diagnosticsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `crash-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`);
    const err = error instanceof Error
      ? { name: error.name, message: redactOutput(error.message), stack: redactOutput(String(error.stack ?? "")) }
      : error === undefined ? undefined : { message: redactOutput(String(error)) };
    fs.writeFileSync(file, JSON.stringify({ reason, at: new Date().toISOString(), pid: process.pid, error: err, entries: ring }, null, 1));
    const crashes = fs.readdirSync(dir).filter((f) => /^crash-.*\.json$/.test(f)).sort();
    for (const old of crashes.slice(0, Math.max(0, crashes.length - CRASH_KEEP))) fs.rmSync(path.join(dir, old), { force: true });
    return file;
  } catch {
    return null;
  }
}

// 最近几次崩溃留痕（诊断包里列出来）
export function recentCrashes(limit = 5): Array<{ file: string; reason: string; at: string; error?: string }> {
  try {
    const dir = diagnosticsDir();
    return fs.readdirSync(dir)
      .filter((f) => /^crash-.*\.json$/.test(f))
      .sort()
      .slice(-limit)
      .map((f) => {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { reason: string; at: string; error?: { message?: string } };
        return { file: f, reason: rec.reason, at: rec.at, ...(rec.error?.message ? { error: rec.error.message } : {}) };
      });
  } catch {
    return [];
  }
}

// 测试用：清空环、允许再落一次盘
export function resetRingForTests(): void {
  ring = [];
  ringBytes = 0;
  dumped = false;
}
