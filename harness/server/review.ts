// 右侧 dock 的「审阅」后端：worktree 变更概览（git 变更清单 + 未跟踪文件统计）
// 与单文件 diff。git 一律 execFile 无壳调用、出错 resolve null——审阅是只读增强，
// 永远不让 git 自身的问题炸掉路由。移植自 bridge 的 src/routes/claude-dock.mjs
// 审阅段；子进程 env 走 childEnv + GIT_OPTIONAL_LOCKS=0（只读操作不碰 index.lock）。
// S7（#55）：工作区仓库的 .git/config 与 hooks 在 agent 手里——git 一律关掉 fsmonitor/hooks，
// diff 不走外部 diff 与 textconv，否则用户打开审阅面板就会执行仓库里配的命令。

import path from "node:path";
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { childEnv } from "./tools/bash.ts";
import { GIT_DIFF_NO_EXTERNAL, helperGitArgs } from "./helper-proc.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git 恒定空树 hash

function git(ws: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...helperGitArgs(), "-c", "core.quotepath=false", ...args],
      {
        cwd: ws,
        env: childEnv({ GIT_OPTIONAL_LOCKS: "0" }),
        timeout: 15_000,
        maxBuffer,
        windowsHide: true,
      },
      (err, stdout) => resolve(err ? null : String(stdout ?? "")),
    );
  });
}

// ws 可能是 repo 的子目录：git 各命令输出的路径永远是 repo-root 相对。先用
// `-- .` 把 diff/status 圈进 ws 子树，再剥掉 rev-parse --show-prefix 的前缀，
// 得到 ws 相对路径——概览里的 path 才能直接当 diff 端点的 pathspec 用（否则
// 点击展开会因路径基准不一致拿到空 diff，且清单会混入工作空间外的改动）。
async function repoPrefix(ws: string): Promise<string> {
  return ((await git(ws, ["rev-parse", "--show-prefix"])) ?? "").trim();
}

const stripPfx = (pfx: string, p: string): string =>
  pfx && p.startsWith(pfx) ? p.slice(pfx.length) : p;

interface ReviewBase {
  base: string;
  label: string;
  branch: string;
}

// 基线选择：在分支上且存在 main/master → merge-base（分支全部工作+未提交都算变更）；
// 否则 HEAD（只看未提交）；无任何提交的新仓库 → 空树。label 是「X → working tree」里的 X。
async function reviewBase(ws: string): Promise<ReviewBase> {
  const branch = ((await git(ws, ["rev-parse", "--abbrev-ref", "HEAD"])) || "").trim() || "HEAD";
  const hasHead = (await git(ws, ["rev-parse", "--verify", "-q", "HEAD"])) != null;
  if (!hasHead) return { base: EMPTY_TREE, label: branch, branch };
  for (const main of ["main", "master"]) {
    if (branch === main) break;
    if ((await git(ws, ["rev-parse", "--verify", "-q", "refs/heads/" + main])) == null) continue;
    const mb = await git(ws, ["merge-base", "HEAD", main]);
    if (mb) return { base: mb.trim(), label: main, branch };
    break;
  }
  return { base: "HEAD", label: branch, branch };
}

export interface ReviewFileEntry {
  path: string;
  from?: string;
  add: number;
  del: number;
  bin: boolean;
  st: string;
}

// 解析 `git diff --numstat -z -M`：常规记录 "add\tdel\tpath\0"，改名记录 "add\tdel\t\0old\0new\0"。
function parseNumstatZ(out: string): ReviewFileEntry[] {
  const files: ReviewFileEntry[] = [];
  const tok = String(out || "").split("\0");
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (!m) continue;
    const bin = m[1] === "-";
    const add = bin ? 0 : +m[1];
    const del = bin ? 0 : +m[2];
    if (m[3] === "") {
      const from = tok[++i] ?? "";
      const to = tok[++i] ?? "";
      files.push({ path: to, from, add, del, bin, st: "M" });
    } else {
      files.push({ path: m[3], add, del, bin, st: "M" });
    }
  }
  return files;
}

// 解析 `git diff --name-status -z -M`：R/C 后跟两个路径，其余一个。
function parseNameStatusZ(out: string): Map<string, string> {
  const map = new Map<string, string>();
  const tok = String(out || "").split("\0");
  for (let i = 0; i < tok.length; i++) {
    const st = tok[i];
    if (!st) continue;
    const letter = st[0];
    if (letter === "R" || letter === "C") {
      i += 2;
      map.set(tok[i] ?? "", letter);
    } else {
      i += 1;
      map.set(tok[i] ?? "", letter);
    }
  }
  return map;
}

const looksBinary = (buf: Buffer): boolean => buf.subarray(0, 8000).includes(0);

// 未跟踪文件行数（读上限 1MB 内数 \n；二进制不数）。
function untrackedStat(abs: string): { add: number; bin: boolean } | null {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size === 0) return { add: 0, bin: false };
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }
  if (looksBinary(buf)) return { add: 0, bin: true };
  const slice = buf.length > 1024 * 1024 ? buf.subarray(0, 1024 * 1024) : buf;
  let lines = 0;
  for (let i = 0; i < slice.length; i++) if (slice[i] === 10) lines++;
  if (slice.length && slice[slice.length - 1] !== 10) lines++;
  return { add: lines, bin: false };
}

// 未跟踪清单：status -z --untracked-files=all 里的 "?? path" 记录（-- . 圈进
// ws 子树，返回路径仍是 repo-root 相对，剥掉 pfx 前缀）。
async function untrackedFiles(ws: string, pfx: string): Promise<string[]> {
  const out = await git(ws, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (out == null) return [];
  const files: string[] = [];
  const tok = out.split("\0");
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t || t.length < 4) continue;
    const st = t.slice(0, 2);
    if (st[0] === "R" || st[0] === "C") i += 1; // rename 的第二段路径跳过
    if (st !== "??") continue;
    files.push(stripPfx(pfx, t.slice(3)));
    if (files.length >= 500) break;
  }
  return files;
}

// 相对路径护栏：rel 必须落在 ws 内（拒绝绝对路径与 .. 穿越）。
function insideWs(ws: string, rel: string): string | null {
  const raw = String(rel || "");
  if (!raw || path.isAbsolute(raw)) return null;
  const abs = path.resolve(ws, raw);
  const root = path.resolve(ws);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

export interface ReviewOverview {
  git: boolean;
  branch?: string;
  base?: string;
  files?: ReviewFileEntry[];
  total?: { add: number; del: number };
  truncated?: boolean;
}

// 变更概览：git 仓库 → { git:true, branch, base, files, total, truncated }；
// 非 git 目录 → { git:false }。files 上限 800，超出 truncated:true。
export async function reviewOverview(ws: string): Promise<ReviewOverview> {
  if ((await git(ws, ["rev-parse", "--is-inside-work-tree"])) == null) return { git: false };
  const { base, label, branch } = await reviewBase(ws);
  const [numstat, nameStatus, pfx] = await Promise.all([
    git(ws, ["diff", ...GIT_DIFF_NO_EXTERNAL, "--numstat", "-z", "-M", base, "--", "."]),
    git(ws, ["diff", ...GIT_DIFF_NO_EXTERNAL, "--name-status", "-z", "-M", base, "--", "."]),
    repoPrefix(ws),
  ]);
  const stRaw = parseNameStatusZ(nameStatus ?? "");
  const stMap = new Map<string, string>();
  for (const [k, v] of stRaw) stMap.set(stripPfx(pfx, k), v);
  const files = parseNumstatZ(numstat ?? "")
    .map((f) => ({
      ...f,
      path: stripPfx(pfx, f.path),
      from: f.from ? stripPfx(pfx, f.from) : undefined,
    }))
    .filter((f) => f.path)
    .map((f) => ({ ...f, st: stMap.get(f.path) || "M" }));
  const seen = new Set(files.map((f) => f.path));
  let truncated = false;
  for (const rel of await untrackedFiles(ws, pfx)) {
    if (seen.has(rel)) continue;
    const abs = insideWs(ws, rel);
    if (!abs) continue;
    const stat = untrackedStat(abs);
    if (!stat) continue;
    files.push({ path: rel, from: undefined, add: stat.add, del: 0, bin: stat.bin, st: "U" });
    if (files.length >= 800) {
      truncated = true;
      break;
    }
  }
  const total = files.reduce(
    (a, f) => ({ add: a.add + (f.add || 0), del: a.del + (f.del || 0) }),
    { add: 0, del: 0 },
  );
  return { git: true, branch, base: label, files, total, truncated };
}

export type ReviewDiffResult =
  | { ok: true; diff: string; truncated: boolean; bin: boolean }
  | { ok: false; status: number; error: string };

// 单文件 diff（懒加载展开）。untracked=true 时合成整篇新增的伪 diff
// （git diff 本身不含未跟踪文件）；from 是 rename 前的旧路径。
export async function reviewDiff(
  ws: string,
  file: string,
  from: string,
  untracked: boolean,
): Promise<ReviewDiffResult> {
  const abs = insideWs(ws, file);
  if (!abs) return { ok: false, status: 400, error: "bad file path" };
  if (untracked) {
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return { ok: false, status: 404, error: "文件不存在" };
    }
    if (looksBinary(buf)) return { ok: true, diff: "", truncated: false, bin: true };
    let text = buf.toString("utf8");
    let truncated = false;
    if (text.length > 400 * 1024) {
      text = text.slice(0, 400 * 1024);
      truncated = true;
    }
    let lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length > 4000) {
      lines = lines.slice(0, 4000);
      truncated = true;
    }
    const body = `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => "+" + l).join("\n");
    return { ok: true, diff: body, truncated, bin: false };
  }
  const { base } = await reviewBase(ws);
  const spec = from && from !== file ? [from, file] : [file];
  let out = await git(ws, ["diff", ...GIT_DIFF_NO_EXTERNAL, "--unified=3", "-M", base, "--", ...spec]);
  if (out == null) return { ok: false, status: 500, error: "git diff 失败" };
  let truncated = false;
  if (out.length > 1024 * 1024) {
    out = out.slice(0, 1024 * 1024);
    const cut = out.lastIndexOf("\n");
    if (cut > 0) out = out.slice(0, cut);
    truncated = true;
  }
  return { ok: true, diff: out, truncated, bin: /^Binary files /m.test(out) };
}
