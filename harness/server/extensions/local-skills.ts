// 项目级与用户级技能目录（Claude Code 同格式）：<目录>/skills/<名>/SKILL.md，目录见 agent-dirs.ts——项目级是工作区的
// .dimensio 与 .claude，用户级是 ~/.dimensio 与 ~/.claude（成员实例没有用户级）。按目录优先级排好、同名前面的优先。
// frontmatter 按 SKILL.md 的 mtime + 大小缓存：技能目录每轮都要对一遍（World State 的 skills 节）。
// 目录里的链接按真实落点判（confine.ts）：项目级的不许指出工作区、不许指到凭据文件；判不过的条目当不存在。
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { configDirs, type ConfigScope, userScopeDirs } from "../agent-dirs.ts";
import { confinedConfigFile } from "./confine.ts";
import { frontmatterText, frontmatterValue, oneLine, splitFrontmatter } from "./frontmatter.ts";

export interface LocalSkill {
  name: string;
  description: string;
  skillMd: string;
  source: ConfigScope;
  // 读这个技能的文件时真实落点要落在的根（项目级 = 工作区，用户级 = 那个用户目录），见 confine.ts
  confineBase: string;
  userOnly?: boolean;
  hidden?: boolean;
  argumentHint?: string;
}

// 一个目录里最多认这么多个技能（误把大目录指成技能目录时不至于每轮扫几千个）
const MAX_PER_DIR = 200;

type Parsed = Omit<LocalSkill, "skillMd" | "source" | "confineBase">;
const cache = new Map<string, { key: string; parsed: Parsed | null }>();

function parseSkill(skillMd: string, dirName: string): Parsed | null {
  let key: string;
  try {
    const st = statSync(skillMd);
    if (!st.isFile()) return null;
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const hit = cache.get(skillMd);
  if (hit?.key === key) return hit.parsed;
  let parsed: Parsed | null = null;
  try {
    const { head, body } = splitFrontmatter(readFileSync(skillMd, "utf8"));
    const name = oneLine(frontmatterValue(head, "name") || dirName, 80);
    const description = oneLine(frontmatterText(head, "description") || body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) || "", 600);
    const hint = oneLine(frontmatterValue(head, "argument-hint"), 80);
    if (name) {
      parsed = {
        name,
        description,
        ...(/^(?:true|yes)$/i.test(frontmatterValue(head, "disable-model-invocation") ?? "") ? { userOnly: true } : {}),
        ...(/^(?:false|no)$/i.test(frontmatterValue(head, "user-invocable") ?? "") ? { hidden: true } : {}),
        ...(hint ? { argumentHint: hint } : {}),
      };
    }
  } catch {
    parsed = null;
  }
  cache.set(skillMd, { key, parsed });
  return parsed;
}

function skillsIn(root: string, source: ConfigScope, confineBase: string): LocalSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: LocalSkill[] = [];
  for (const dirName of entries.slice(0, MAX_PER_DIR)) {
    const skillMd = path.join(root, dirName, "SKILL.md");
    if (!confinedConfigFile(skillMd, source, confineBase)) continue;
    const parsed = parseSkill(skillMd, dirName);
    if (parsed) out.push({ ...parsed, skillMd, source, confineBase });
  }
  return out;
}

// 这个工作区此刻看得到的项目级 + 用户级技能（优先级排好、按名去重）
export function localSkills(workspace?: string): LocalSkill[] {
  const seen = new Set<string>();
  const out: LocalSkill[] = [];
  for (const { scope, dir } of configDirs(workspace)) {
    for (const s of skillsIn(path.join(dir, "skills"), scope, scope === "project" ? path.dirname(dir) : dir)) {
      const k = s.name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

// 用户级技能根目录（工作区之外）：技能正文里引用的脚本与参考文件要能只读访问
export function userSkillRoots(): string[] {
  return userScopeDirs().map((d) => path.join(d.dir, "skills"));
}
