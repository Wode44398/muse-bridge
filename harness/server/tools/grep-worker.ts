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
  // 匹配行前 / 后各带几行上下文（content 模式）
  before: number;
  after: number;
  // 整个文件当一段文本匹配（. 匹配换行、能跨行）；命中按起止行报
  multiline: boolean;
  // 分页：跳过前 offset 条、最多交 limit 条（content 模式按匹配行计，files / count 按文件计）
  offset: number;
  limit: number;
  maxFileBytes: number;
}

export interface GrepBatchReply {
  lines: string[];
  matchCount: number; // 累计（交出去的）
  fileCount: number; // 累计（交出去的）
  stop: boolean; // 已到上限（或出错），主线程不必再发
  more: boolean; // 到上限时后面确实还有结果（据此提示翻页）
  error?: string; // 正则执行本身抛错（例如回溯栈溢出的 RangeError）
}

const job = workerData as GrepJob;
const re = new RegExp(job.source, job.flags);
const reAll = job.multiline ? new RegExp(job.source, `${job.flags.replace(/[gsm]/g, "")}gms`) : null;
let matchCount = 0;
let fileCount = 0;
let skipped = 0; // 翻页跳过的条数
let stopped = false;
let more = false;
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

// 一处命中：起止行（单行匹配两者相同）
type Hit = [number, number];

function lineHits(fileLines: string[]): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < fileLines.length; i++) if (re.test(fileLines[i])) hits.push([i, i]);
  return hits;
}

function multilineHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  reAll!.lastIndex = 0;
  for (let m = reAll!.exec(text); m; m = reAll!.exec(text)) {
    const s = lineOf(m.index);
    const e = lineOf(m.index + Math.max(0, m[0].length - 1));
    const last = hits[hits.length - 1];
    if (!last || s > last[1]) hits.push([s, e]);
    else last[1] = Math.max(last[1], e);
    if (m[0].length === 0) reAll!.lastIndex++;
  }
  return hits;
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
  let hits = job.multiline ? multilineHits(text) : lineHits(fileLines);
  if (hits.length === 0) return;

  if (job.mode !== "content") {
    // 按文件分页
    if (skipped < job.offset) {
      skipped++;
      return;
    }
    if (fileCount >= job.limit) {
      more = true;
      stopped = true;
      return;
    }
    fileCount++;
    matchCount += hits.length;
    lines.push(job.mode === "files" ? rel : `${rel}: ${hits.length}`);
    return;
  }

  // 按匹配分页：先跳过，再截到上限
  if (skipped < job.offset) {
    const drop = Math.min(job.offset - skipped, hits.length);
    skipped += drop;
    hits = hits.slice(drop);
    if (!hits.length) return;
  }
  const room = job.limit - matchCount;
  if (room <= 0) {
    more = true;
    stopped = true;
    return;
  }
  if (hits.length > room) {
    hits = hits.slice(0, room);
    more = true;
    stopped = true;
  }
  fileCount++;
  matchCount += hits.length;

  if (job.before === 0 && job.after === 0) {
    for (const [s, e] of hits) {
      for (let i = s; i <= e; i++) lines.push(`${rel}:${i + 1}${i === s ? ":" : "-"} ${clip(fileLines[i])}`);
    }
    return;
  }
  // Merge overlapping context windows; matches get ':', context gets '-'.
  const ranges: [number, number][] = [];
  const hitLines = new Set<number>();
  for (const [hs, he] of hits) {
    for (let i = hs; i <= he; i++) hitLines.add(i);
    const s = Math.max(0, hs - job.before);
    const e = Math.min(fileLines.length - 1, he + job.after);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  for (const [s, e] of ranges) {
    if (emittedBefore + lines.length) lines.push("--");
    for (let i = s; i <= e; i++) {
      lines.push(`${rel}:${i + 1}${hitLines.has(i) ? ":" : "-"} ${clip(fileLines[i])}`);
    }
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
  const reply: GrepBatchReply = { lines, matchCount, fileCount, stop: stopped, more, ...(error ? { error } : {}) };
  parentPort!.postMessage(reply);
});
