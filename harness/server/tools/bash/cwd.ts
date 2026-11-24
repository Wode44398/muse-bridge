// Bash 的当前目录：会话内跨调用保留 cd 的效果（只带目录，不带环境变量）。
//   · loop 在每一批开跑前把会话此刻的目录写进执行参数的 CWD_ARG（只在它不是工作区根时；模型自己写的同名键先被抹掉；
//     目录已经用不了就当场复位、改写 CWD_RESET_ARG 说明），权限判定、卡片、拒绝台账、改动记账与执行看到的是同一个目录；
//   · 前台命令前面挂一个 EXIT trap，把结束时的目录写进一个临时文件；跑完核一遍（还在不在、出没出工作区、是不是凭据目录），
//     过了才记成会话的新目录，没过就复位到原来的目录，并在结果里说一句；
//   · 后台 job 在当时的目录起，它里面的 cd 不带回来；并行批里的命令同样不带回来（ctx.parallel）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readVerdict, realOrNearest } from "../../sandbox.ts";
import { accessLock } from "../../tenant.ts";
import type { ToolContext } from "../types.ts";

/** 执行参数里携带派发时目录的键（不在 schema 里，转录里也没有）。 */
export const CWD_ARG = "__cwd";
/** 派发时发现记着的目录已经用不了、复位到了工作区根：执行参数里带上这句说明（同样只由 loop 写，模型写的被抹掉）。 */
export const CWD_RESET_ARG = "__cwdReset";

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

function inside(root: string, p: string): boolean {
  const rel = path.relative(fold(path.resolve(root)), fold(path.resolve(p)));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

export const sameDir = (a: string, b: string): boolean => fold(path.resolve(a)) === fold(path.resolve(b));

/** 这个目录能不能当 Bash 的当前目录：存在、是目录、不是凭据区；仅工作区档下必须在工作区里（真实落点也算）。 */
export function cwdProblem(ctx: Pick<ToolContext, "sandbox">, dir: string): string | null {
  const sb = ctx.sandbox;
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  if (!stat?.isDirectory()) return "it no longer exists";
  const verdict = readVerdict(dir, sb.root, { bypass: sb.bypassing });
  if (verdict) return `it is a protected location (${verdict})`;
  if (sb.bypassing || (accessLock() ?? sb.access) === "full") return null;
  const real = realOrNearest(dir) ?? dir;
  if (!inside(sb.root, dir) || !inside(sb.realRoot(), real)) return "it is outside the workspace (this project runs in workspace access mode)";
  return null;
}

/** 这次调用从哪个目录起跑。派发时带来的目录不能用了（删了、档位收紧了）就回到工作区根，并给一句说明。 */
export function startDir(args: Record<string, unknown>, ctx: Pick<ToolContext, "sandbox">): { dir: string; note?: string } {
  const root = ctx.sandbox.root;
  const reset = typeof args[CWD_RESET_ARG] === "string" ? (args[CWD_RESET_ARG] as string) : "";
  const asked = typeof args[CWD_ARG] === "string" ? (args[CWD_ARG] as string) : "";
  if (!asked && reset) return { dir: root, note: reset };
  if (!asked || sameDir(asked, root)) return { dir: root };
  const why = cwdProblem(ctx, asked);
  if (!why) return { dir: path.resolve(asked) };
  return { dir: root, note: unusableNote(asked, why) };
}

export const unusableNote = (dir: string, why: string): string =>
  `[The working directory ${dir} could not be used (${why}), so this ran in the workspace root.]`;

/** 显示用：工作区里写相对路径，外面写绝对路径。 */
export function showDir(ctx: Pick<ToolContext, "sandbox">, dir: string): string {
  return sameDir(dir, ctx.sandbox.root) ? "the workspace root" : ctx.sandbox.rel(dir);
}

// ── 跑完记下目录 ──────────────────────────────────────────────────────────────

const CWD_DIR = path.join(os.tmpdir(), "dimensio-cwd");

/** 前台命令的目录回执文件（每次调用一个）。 */
export function cwdFile(): string {
  fs.mkdirSync(CWD_DIR, { recursive: true });
  return path.join(CWD_DIR, `${randomUUID()}.txt`);
}

/** 挂在命令前面的 EXIT trap（POSIX sh / bash）。Windows 的 Git Bash 用 pwd -W 拿到盘符写法。 */
export function cwdTrap(file: string): string {
  const target = file.split(path.sep).join("/").replace(/'/g, "");
  const pwd = process.platform === "win32" ? "{ pwd -W 2>/dev/null || pwd -P; }" : "pwd -P";
  return `trap '${pwd} >| "${target}" 2>/dev/null' EXIT\n`;
}

// Git Bash 的 /c/x 写法换回盘符
function fromShellPath(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (process.platform !== "win32") return path.isAbsolute(t) ? t : null;
  if (/^[A-Za-z]:[\\/]/.test(t)) return path.win32.resolve(t);
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(t);
  return m ? path.win32.resolve(`${m[1]}:\\${(m[2] ?? "").replace(/\//g, "\\")}`) : null;
}

/** 读回执并删掉文件；没写成（命令 exec 走了、自己改了 trap）返回 null。 */
export function takeCwd(file: string): string | null {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
  return fromShellPath(text.split(/\r?\n/)[0] ?? "");
}

/** 删掉没人读的回执（转了后台的命令跑完才会写它）。 */
export function dropCwdFile(file: string): void {
  fs.rm(file, { force: true }, () => {});
}

/**
 * 命令跑完、目录从 from 变成 to：核过就记成会话的新目录，返回要附在结果里的一句；没变返回空串。
 * 核不过（出了工作区、凭据目录……）就留在 from，并说明复位了。
 */
export function commitCwd(ctx: Pick<ToolContext, "sandbox" | "shell">, from: string, to: string | null): string {
  if (!to || sameDir(from, to) || !ctx.shell) return "";
  const why = cwdProblem(ctx, to);
  if (why) {
    ctx.shell.cwd = sameDir(from, ctx.sandbox.root) ? undefined : from;
    return `[The command changed directory to ${to}, but ${why}; the working directory stays ${showDir(ctx, from)}.]`;
  }
  const dir = path.resolve(to);
  ctx.shell.cwd = sameDir(dir, ctx.sandbox.root) ? undefined : dir;
  return `[Working directory is now ${showDir(ctx, dir)} — later Bash calls start there.]`;
}
