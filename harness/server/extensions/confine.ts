// 项目级 / 用户级技能与命令文件的读取闸。这些目录里的链接（符号链接、junction）可能指到别处：克隆来的仓库里一个
// .claude/skills/x/SKILL.md → ../../../../app/.env 就能把凭据带进系统提示的技能清单；成员实例里一个指向别的用户目录的
// .claude/commands 能把别人的文件展开进自己的对话。所以读之前按真实落点判：
//   · 项目级（base = 工作区）：走 workspace 档的会话沙箱同款判定——真实落点必须在工作区的真实根之内，并过凭据与租户禁区判定；
//   · 用户级（base = ~/.claude 这类用户目录，只有主机管理员实例有）：允许链到别处（常见做法是把 ~/.claude/skills/x 链到自己的
//     dotfiles 仓库），但真实落点不在那个用户目录里时照样过凭据判定。
// 不满足返回 false，调用方当这个条目不存在。
import { realpathSync } from "node:fs";
import path from "node:path";
import type { ConfigScope } from "../agent-dirs.ts";
import { readVerdict, Sandbox } from "../sandbox.ts";

const warned = new Set<string>();
function skip(file: string, why: string): false {
  if (!warned.has(file)) {
    warned.add(file);
    console.warn(`[extensions] 跳过 ${file}：${why.slice(0, 200)}`);
  }
  return false;
}

function inside(root: string, abs: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(fold(root), fold(abs));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function confinedConfigFile(file: string, scope: ConfigScope, base: string): boolean {
  if (scope === "project") {
    try {
      new Sandbox(base, "workspace").resolve(file);
      return true;
    } catch (e) {
      return skip(file, (e as Error).message);
    }
  }
  let real: string;
  let realBase: string;
  try {
    real = realpathSync.native(file);
    realBase = realpathSync.native(base);
  } catch {
    return false; // 不存在：调用方照「没有」处理
  }
  if (inside(realBase, real)) return true;
  const verdict = readVerdict(real);
  return verdict ? skip(file, `${verdict}（链接指向 ${real}）`) : true;
}
