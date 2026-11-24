// 项目级 hook 命令里点名的工作区内文件（多半是 .claude/hooks/x.sh 这类脚本）：用户确认信任的是「这条命令 + 它要跑的脚本」，
// 所以这些文件的内容也进信任指纹（config.ts）；每次执行前再对一遍（session.ts），会话里被改过就不跑，下个会话按新指纹重新问。
//
// 只认命令里字面写出来的路径（含 $CLAUDE_PROJECT_DIR / $DIMENSIO_PROJECT_DIR 前缀的写法）；重定向的目标不算（那是 hook 自己写的
// 输出，内容每次都变）。命令间接调用的东西（npm run 的脚本、Makefile 里的步骤）认不出来——那些文件不在这道复核里。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAX_REFS = 16;
// 比这大的文件只记大小与修改时间（多半不是脚本；读进来算哈希不划算）
const MAX_HASH_BYTES = 4 * 1024 * 1024;
const PROJECT_VARS = /\$\{(?:CLAUDE|DIMENSIO)_PROJECT_DIR\}|\$(?:CLAUDE|DIMENSIO)_PROJECT_DIR\b|%(?:CLAUDE|DIMENSIO)_PROJECT_DIR%|\$env:(?:CLAUDE|DIMENSIO)_PROJECT_DIR\b/gi;
// 切词：空白与 shell 分隔符；重定向符单独成词，后面那个词是输出目标
const TOKEN_RE = /\d*>>?|<|[^\s;|&()<>]+/g;

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// 命令里点名的、此刻存在的工作区内文件（绝对路径，按出现顺序、去重）
export function commandRefs(command: string, workspace: string): string[] {
  const root = path.resolve(workspace);
  const text = command.replace(PROJECT_VARS, root.replace(/\\/g, "/"));
  const out = new Set<string>();
  let redirectTarget = false;
  for (const [raw] of text.matchAll(TOKEN_RE)) {
    if (/^\d*>>?$/.test(raw)) {
      redirectTarget = true;
      continue;
    }
    if (raw === "<") continue; // 输入重定向的源照常算（hook 读它）
    const skip = redirectTarget;
    redirectTarget = false;
    if (skip) continue;
    const token = raw.replace(/["']/g, "");
    if (!token || token.startsWith("-") || token.includes("://") || /[$`*?%]/.test(token)) continue;
    // 像路径的才看：带目录分隔符，或带扩展名（fmt.sh、check.py）
    if (!/[\\/]/.test(token) && !/\.[A-Za-z0-9]{1,8}$/.test(token)) continue;
    const abs = path.resolve(root, token);
    if (!inside(root, abs)) continue;
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    out.add(abs);
    if (out.size >= MAX_REFS) break;
  }
  return [...out];
}

// 这些文件此刻内容的摘要（没了也算一种状态）
export function refsDigest(files: string[]): string {
  const h = createHash("sha256");
  for (const file of files) {
    h.update(file);
    h.update("\0");
    try {
      const st = statSync(file);
      if (!st.isFile()) h.update("not-a-file");
      else if (st.size > MAX_HASH_BYTES) h.update(`large:${st.size}:${st.mtimeMs}`);
      else h.update(readFileSync(file));
    } catch {
      h.update("missing");
    }
    h.update("\0");
  }
  return h.digest("hex");
}
