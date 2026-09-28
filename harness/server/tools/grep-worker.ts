// #70：Grep 的读文件与正则匹配跑在这个 worker 线程里。主线程只负责遍历目录与凭据判定（判定函数传不过来），
// 按批把候选文件发过来；一批超时，主线程直接 terminate() 掉本线程——失控的正则（反向引用、前瞻这类 V8
// 线性回退接不住的写法）再也冻不住 harness 主线程，所有会话、SSE、探活照常。
// 只依赖 node 内置模块，起得快。
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

export interface GrepJob {
  source: string;
  flags: string;
  mode: "content" | "files" | "count";
  context: number;
  maxMatches: number;
  maxFilesListed: number;
  maxFileBytes: number;
}

export interface GrepBatchReply {
  lines: string[];
  matchCount: number; // 累计
  fileCount: number; // 累计
  stop: boolean; // 已到上限（或出错），主线程不必再发
  error?: string; // 正则执行本身抛错（例如回溯栈溢出的 RangeError）
}

const job = workerData as GrepJob;
const re = new RegExp(job.source, job.flags);
let matchCount = 0;
let fileCount = 0;
let stopped = false;
let emittedBefore = 0; // 之前各批已经交出去的行数：上下文窗口之间的 `--` 只在整个输出里已有行时才加（与原来逐字一致）

// Treat a file as binary if it contains a NUL byte in its first stretch.
function isBinary(s: string): boolean {
  const n = Math.min(s.length, 8000);
  for (let i = 0; i < n; i++) {
    if (s.charCodeAt(i) === 0) return true;
  }
  return false;
}

function clip(line: string): string {
  return line.length > 300 ? line.slice(0, 300) + "…" : line;
}

function searchFile(abs: string, rel: string, lines: string[]): void {
  let text: string;
  try {
    if (fs.statSync(abs).size > job.maxFileBytes) return;
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return;
  }
  if (isBinary(text)) return;

  const fileLines = text.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (re.test(fileLines[i])) {
      hits.push(i);
      if (job.mode === "content" && matchCount + hits.length >= job.maxMatches) break;
    }
  }
  if (hits.length === 0) return;
  fileCount++;
  matchCount += hits.length;

  if (job.mode === "files") {
    lines.push(rel);
  } else if (job.mode === "count") {
    lines.push(`${rel}: ${hits.length}`);
  } else if (job.context === 0) {
    for (const i of hits) lines.push(`${rel}:${i + 1}: ${clip(fileLines[i])}`);
  } else {
    // Merge overlapping context windows; matches get ':', context gets '-'.
    const ranges: [number, number][] = [];
    for (const i of hits) {
      const s = Math.max(0, i - job.context);
      const e = Math.min(fileLines.length - 1, i + job.context);
      const last = ranges[ranges.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else ranges.push([s, e]);
    }
    const hitSet = new Set(hits);
    for (const [s, e] of ranges) {
      if (emittedBefore + lines.length) lines.push("--");
      for (let i = s; i <= e; i++) {
        lines.push(`${rel}:${i + 1}${hitSet.has(i) ? ":" : "-"} ${clip(fileLines[i])}`);
      }
    }
  }

  if (job.mode === "content" && matchCount >= job.maxMatches) {
    stopped = true;
    lines.push(`…[stopped at ${job.maxMatches} matches — narrow the pattern/path/glob]`);
  } else if (job.mode !== "content" && fileCount >= job.maxFilesListed) {
    stopped = true;
    lines.push(`…[stopped at ${job.maxFilesListed} files — narrow the pattern/path/glob]`);
  }
}

parentPort!.on("message", (files: { abs: string; rel: string }[]) => {
  const lines: string[] = [];
  let error: string | undefined;
  try {
    for (const { abs, rel } of files) {
      if (stopped) break;
      searchFile(abs, rel, lines);
    }
  } catch (e) {
    // 正则执行本身抛错（回溯栈溢出之类）：结构化回报，别让它变成线程的未捕获异常。
    error = (e as Error)?.message ?? String(e);
    stopped = true;
  }
  emittedBefore += lines.length;
  const reply: GrepBatchReply = { lines, matchCount, fileCount, stop: stopped, ...(error ? { error } : {}) };
  parentPort!.postMessage(reply);
});
