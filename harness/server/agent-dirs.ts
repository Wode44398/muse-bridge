// 与 Claude Code 同格式的 agent 配置目录：hooks（settings.json / settings.local.json）、技能（skills/<名>/SKILL.md）、
// 自定义斜杠命令（commands/**/*.md）。项目级在工作区的 .dimensio/ 与 .claude/ 下，用户级在 paths.ts 的 userConfigDirs()。
//
// 实例规则：成员（租户）实例只认自己工作区里的项目级目录，用户级一个都不认（那是主机管理员的家目录）。
// 优先级：项目级 > 用户级；同一级里 .dimensio 先于 .claude（列表顺序即优先顺序）。
//
// 这些文件会改变 agent 的行为（hooks 还会在本机执行命令），agentConfigKind 给权限判定认出它们。
import path from "node:path";
import { userConfigDirs } from "./paths.ts";
import { tenantMode } from "./tenant.ts";

export type ConfigScope = "project" | "user";

export interface ConfigDir {
  scope: ConfigScope;
  dir: string; // 绝对路径：<工作区>/.dimensio、~/.claude ……
}

export function projectConfigDirs(workspace: string): ConfigDir[] {
  const root = path.resolve(workspace);
  return [path.join(root, ".dimensio"), path.join(root, ".claude")].map((dir) => ({ scope: "project" as const, dir }));
}

export function userScopeDirs(): ConfigDir[] {
  if (tenantMode()) return [];
  return userConfigDirs().map((dir) => ({ scope: "user" as const, dir }));
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

// 按优先级排好的全部目录（没有工作区就只有用户级）。工作区就是家目录时，项目级那两个目录其实是用户级的，按用户级算
export function configDirs(workspace?: string): ConfigDir[] {
  const user = userScopeDirs();
  const userKeys = new Set(user.map((d) => fold(d.dir)));
  const project = workspace ? projectConfigDirs(workspace).filter((d) => !userKeys.has(fold(d.dir))) : [];
  return [...project, ...user];
}

// key 是归一过的绝对路径（正斜杠；Windows 上已小写）。
//   hooks      = .claude / .dimensio 下的 settings.json、settings.local.json（里面能配在本机执行的命令），以及同处的
//                hooks/ 目录（Claude Code 惯例把 hook 脚本放这儿：改脚本等于改了已信任的 hook 要跑的命令）
//   extensions = .claude / .dimensio 下的 skills/、commands/ 目录里的任何文件
// 不限定在工作区或家目录：克隆下来的子项目、别的工作区里的同名配置一样会被 dimensio 读到。
const HOOK_SETTINGS_RE = /(?:^|\/)\.(?:claude|dimensio)\/settings(?:\.local)?\.json$/i;
const HOOK_SCRIPT_DIR_RE = /(?:^|\/)\.(?:claude|dimensio)\/hooks(?:\/|$)/i;
const EXTENSION_DIR_RE = /(?:^|\/)\.(?:claude|dimensio)\/(?:skills|commands)(?:\/|$)/i;

export function agentConfigKind(key: string): "hooks" | "extensions" | null {
  if (HOOK_SETTINGS_RE.test(key) || HOOK_SCRIPT_DIR_RE.test(key)) return "hooks";
  if (EXTENSION_DIR_RE.test(key)) return "extensions";
  return null;
}
