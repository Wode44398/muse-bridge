// 指令文件里的 `@路径` 导入（Claude Code 的规则）：独占一行或行内的 @path 都算，代码块与行内代码里的不算；相对路径按写它的那个
// 文件所在目录解析，`~/` 是用户主目录；最多 5 层；同一个文件只收一次（已经收过的再被导入就跳过）。
// 只许导入仓库内（或工作区内）的文本文件（仓库外的、dimensio 自己的数据都不收，见 allowed）；凭据类路径按沙箱的判定拒；
// 成员实例只许导入自己根目录里的。这几条对字面路径和经符号链接 / junction 的真实落点各判一次（linkEscapes）。
// 读不到、不许读的导入静默跳过（指令文件里的 @ 不一定是导入，@types/node 这种写法很常见）。
import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFile, hookTrustFile, knowledgeRoot, memoryRoot, projectMemoryRoot, projectModeFile, sessionFamilyFile, sessionsDir, worktreesRoot } from "../paths.ts";
import { readVerdict } from "../sandbox.ts";
import { insideTenant, tenantMode, tenantRoot } from "../tenant.ts";

export const MAX_IMPORT_DEPTH = 5;
const MAX_IMPORT_BYTES = 256 * 1024;

export interface ImportedFile {
  abs: string;
  text: string;
  by: string; // 导入它的那个文件（绝对路径）
}

const fold = (p: string): string => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
function inside(dir: string, abs: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(abs));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

// 去掉代码块与行内代码后，文本里的 @path 引用（按出现顺序）
export function importRefs(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw.replace(/`[^`]*`/g, " ");
    for (const m of line.matchAll(/(?:^|[\s(])@((?:~[\\/]|\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])?[^\s`'"<>()[\]{},;]+)/g)) {
      const ref = m[1].replace(/[.:!?]+$/, "");
      if (ref && !ref.includes("@")) out.push(ref);
    }
  }
  return out;
}

// dimensio 自己的数据（记忆、会话、知识、运行配置、hooks 信任记录……）：仓库就是 harness 所在的仓库时它们也在仓库里，
// 但导入它们等于绕过沙箱的记忆围栏（别的工作区的笔记）与写保护，一律不收
function harnessData(abs: string): boolean {
  const dirs = [memoryRoot, sessionsDir, knowledgeRoot, projectMemoryRoot, worktreesRoot];
  const files = [configFile, hookTrustFile, sessionFamilyFile, projectModeFile];
  const key = fold(abs);
  const at = (f: () => string): string | null => {
    try {
      return f();
    } catch {
      return null; // 测试进程里解析到临时目录之外会抛：这一项就不比
    }
  };
  return dirs.some((d) => {
    const dir = at(d);
    return Boolean(dir) && inside(dir!, abs);
  }) || files.some((f) => {
    const file = at(f);
    return Boolean(file) && fold(file!) === key;
  });
}

// 只收仓库（或工作区）之内的：指令文件都在仓库里、可能来自克隆下来的陌生仓库，仓库外的导入（主目录下别的项目、别的工作区
// 的记忆、运行配置）会不经任何确认进 system——Claude Code 对外部导入要先征得同意，这里没有那一步，所以不收
function allowed(abs: string, top: string): boolean {
  if (harnessData(abs)) return false;
  if (tenantMode()) return insideTenant(abs) && inside(top, abs);
  return inside(top, abs);
}

const realOf = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

// 字面路径判过了，真实落点（经符号链接 / junction）却出了许可范围或撞上凭据：true = 不能读。
// 仓库顶、主目录、租户根本身在链接后面时，按它们的真实落点也算在内
export function linkEscapes(abs: string, top: string): boolean {
  const real = realOf(abs);
  if (!real || fold(real) === fold(abs)) return false;
  const within = (dirs: (string | null)[]) => dirs.find((d): d is string => Boolean(d) && inside(d!, real));
  const inTop = within([top, realOf(top)]);
  if (!inTop || harnessData(real)) return true;
  if (tenantMode()) {
    const t = tenantRoot();
    if (!(insideTenant(real) || (t && within([realOf(t)])))) return true;
  }
  return readVerdict(real, inTop) !== null;
}

function readText(abs: string): string | undefined {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_IMPORT_BYTES) return undefined;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return undefined; // 不是文本
    let text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text.trim();
  } catch {
    return undefined;
  }
}

// 从一个指令文件出发，按出现顺序（深度优先）收它导入的文件。seen：已经收进来的文件（fold 过的绝对路径），会被补上。
// cache：被导入文件的快照（会话给一份）——第一次读到的内容一直沿用，被导入的 README、package.json 在会话里改了不算「指令文件
// 变了」（Claude Code 也是会话开始读一次）；指令文件本身照旧现读，新加的导入第一次读到时进快照。没给就每次现读
export function collectImports(file: string, text: string, top: string, seen: Set<string>, depth = 1, cache?: Map<string, string>): ImportedFile[] {
  if (depth > MAX_IMPORT_DEPTH) return [];
  const out: ImportedFile[] = [];
  for (const ref of importRefs(text)) {
    const expanded = ref.startsWith("~/") || ref.startsWith("~\\") ? path.join(os.homedir(), ref.slice(2)) : ref;
    const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(path.dirname(file), expanded);
    const key = fold(abs);
    if (seen.has(key) || !allowed(abs, top) || readVerdict(abs, top) || linkEscapes(abs, top)) continue;
    const body = cache?.get(key) ?? readText(abs);
    if (body === undefined) continue;
    cache?.set(key, body);
    seen.add(key);
    out.push({ abs, text: body, by: file });
    out.push(...collectImports(abs, body, top, seen, depth + 1, cache));
  }
  return out;
}
