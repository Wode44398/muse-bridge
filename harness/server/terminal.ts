// 右侧 dock 的终端服务：一个工作空间一个 PTY（Windows 用 PowerShell，cwd=工作
// 空间），断开重连不丢现场（滚回缓冲 + SSE 快照重放）。node-pty 经 createRequire
// 惰性加载——原生模块没装上或 ABI 不匹配时只有终端路由报错，harness 其余功能
// 照常启动。子进程 env 走 childEnv() 凭据白名单，provider key 绝不进终端。
// 移植自 bridge 的 src/runtime/claude-term.mjs。

import path from "node:path";
import { createRequire } from "node:module";
import { childEnv } from "./tools/bash.ts";

// node-pty 原生模块的最小类型面（createRequire 加载拿不到包内 typings）。
interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}
interface PtyLib {
  spawn(
    file: string,
    args: string[],
    opts: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ): PtyProcess;
}

const require = createRequire(import.meta.url);
let ptyLib: PtyLib | null = null;
function loadPty(): PtyLib {
  if (!ptyLib) ptyLib = require("node-pty") as PtyLib;
  return ptyLib;
}

const MAX_TERMS = 6;
const BUF_CAP = 400 * 1024; // 滚回缓冲上限（字节）
const IDLE_MS = 60 * 60 * 1000; // 无人观看 1 小时后回收

export interface TermEvent {
  kind: "data" | "exit";
  d?: string;
  code?: number;
}

export interface Term {
  ws: string;
  key: string;
  pty: PtyProcess;
  chunks: string[];
  bytes: number;
  subs: Set<(ev: TermEvent) => void>;
  lastUsed: number;
  cols: number;
  rows: number;
  exited: boolean;
}

const fold = (p: string): string =>
  process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
const clampC = (n: unknown): number => Math.max(20, Math.min(320, Math.floor(Number(n) || 100)));
const clampR = (n: unknown): number => Math.max(5, Math.min(120, Math.floor(Number(n) || 30)));

const terms = new Map<string, Term>(); // key(folded ws) -> term

function shellSpec(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  return { file: process.env.SHELL || "bash", args: [] };
}

function emit(t: Term, ev: TermEvent): void {
  for (const sub of [...t.subs]) {
    try {
      sub(ev);
    } catch {
      /* 订阅者自己的锅 */
    }
  }
}

// 取或创建该工作空间的终端。已退出的旧壳原地重生（保留同一个入口语义）。
export function ensureTerm(ws: string, cols?: unknown, rows?: unknown): Term {
  const key = fold(ws);
  const existing = terms.get(key);
  if (existing && !existing.exited) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing) terms.delete(key);
  // 上限保护：先踢无人观看里最久没动静的。
  if (terms.size >= MAX_TERMS) {
    let oldest: Term | null = null;
    for (const x of terms.values()) {
      if (!x.subs.size && (!oldest || x.lastUsed < oldest.lastUsed)) oldest = x;
    }
    if (!oldest) throw Object.assign(new Error("终端数量已达上限"), { status: 429 });
    killTerm(oldest.ws);
  }
  const { file, args } = shellSpec();
  const c = clampC(cols);
  const r = clampR(rows);
  const pty = loadPty().spawn(file, args, {
    name: "xterm-256color",
    cols: c,
    rows: r,
    cwd: ws,
    env: childEnv(),
  });
  const t: Term = {
    ws,
    key,
    pty,
    chunks: [],
    bytes: 0,
    subs: new Set(),
    lastUsed: Date.now(),
    cols: c,
    rows: r,
    exited: false,
  };
  pty.onData((d) => {
    t.chunks.push(d);
    t.bytes += Buffer.byteLength(d);
    // 整块丢弃可能把 ANSI 序列拦腰截断——xterm 对快照开头的少量乱码有容忍，可接受。
    while (t.bytes > BUF_CAP && t.chunks.length > 1) {
      t.bytes -= Buffer.byteLength(t.chunks.shift() as string);
    }
    emit(t, { kind: "data", d });
  });
  pty.onExit(({ exitCode }) => {
    t.exited = true;
    emit(t, { kind: "exit", code: exitCode });
  });
  terms.set(key, t);
  return t;
}

export function writeTerm(ws: string, data: string): boolean {
  const t = terms.get(fold(ws));
  if (!t || t.exited) return false;
  t.lastUsed = Date.now();
  t.pty.write(String(data));
  return true;
}

// 返回 clamp 后的实际尺寸；终端不存在/已退出返回 null。
export function resizeTerm(ws: string, cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  const t = terms.get(fold(ws));
  if (!t || t.exited) return null;
  t.cols = clampC(cols);
  t.rows = clampR(rows);
  t.lastUsed = Date.now();
  try {
    t.pty.resize(t.cols, t.rows);
  } catch {
    /* 竞态：刚退出 */
  }
  return { cols: t.cols, rows: t.rows };
}

export function killTerm(ws: string): boolean {
  const t = terms.get(fold(ws));
  if (!t) return false;
  terms.delete(t.key);
  try {
    t.pty.kill();
  } catch {
    /* already gone */
  }
  emit(t, { kind: "exit", code: -1 });
  return true;
}

export function snapshotTerm(t: Term): string {
  return t.chunks.join("");
}

// 订阅 data/exit 事件，返回退订函数（SSE 路由在 res close 时调用）。
export function subscribeTerm(t: Term, cb: (ev: TermEvent) => void): () => void {
  t.subs.add(cb);
  t.lastUsed = Date.now();
  return () => {
    t.subs.delete(cb);
    t.lastUsed = Date.now();
  };
}

// 服务器退出钩子（index.ts 统一注册）：杀光所有壳，不留孤儿进程。
export function killAllTerminals(): void {
  for (const t of [...terms.values()]) killTerm(t.ws);
}

// 闲置回收：没观众且很久没输入输出活动的壳，杀掉省资源。
const reaper = setInterval(
  () => {
    const now = Date.now();
    for (const t of [...terms.values()]) {
      if (t.exited || (!t.subs.size && now - t.lastUsed > IDLE_MS)) killTerm(t.ws);
    }
  },
  5 * 60 * 1000,
);
reaper.unref();
