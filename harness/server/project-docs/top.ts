// 指令文件的「仓库顶」：git 根；不在仓库里就是工作区本身。来源路径相对它写，@导入只许落在它里面。
// 另外放着指令文件认的名字（没有别的依赖：权限判定的控制面名单也从这里取，不会和 project-docs 绕成循环）。
import { existsSync } from "node:fs";
import path from "node:path";

export const PROJECT_DOC_NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];

export function gitRootOf(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

export const docsTopOf = (root: string): string => gitRootOf(path.resolve(root)) ?? path.resolve(root);
