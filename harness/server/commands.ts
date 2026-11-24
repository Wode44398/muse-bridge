// E3（G7；kimi 修订「命令即技能」）：斜杠命令。
//
// 以前技能只能靠模型自己挑：点了名也得它先调一次 Skill 工具，手机上 70 多个技能常常挑不准、或干脆没载入就按自己的路子干。
// 现在消息以 /名字 开头、名字对得上扩展中心勾给 dimensio 的技能（或技能包）时，这条消息照原样进对话，技能正文紧跟一条
// harness 消息（kind slash-skill）——确定性，不用模型挑，也不多调一次工具。
//   · 解析：技能精确名（不分大小写，可带 skill: 前缀）→ 包名/技能名 → 包名（列出成员让模型挑）→ 都没命中就当普通消息发出
//     （手机上输入 `/api/...` 这类路径不会被吞）。
//   · 运行中发 /技能名 走插话，正文跟在插话后面（steerSession 解析、loop 在注入插话时一起追加）。
//   · 「自定义命令」= SKILL.md 里写了 disable-model-invocation: true 的技能：目录里不给模型看、Skill 工具也载入不了，只能这样点。
//   · 不做 `!shell` 展开；参数只认 $ARGUMENTS（见 extensions.ts 的 skillMessage）。
// /compact、/new 这类内置命令是界面动作，在前端处理（web/src/lib/slash.ts）。
//
// 自定义斜杠命令（commands/custom.ts：.claude/commands 等目录里的 .md）与技能同名时命令优先——命令只能由用户点，技能另有
// Skill 工具可载入；想点同名的技能就写 /skill:名字。命令展开后的正文同样作为一条 harness 消息（kind slash-command）跟在后面。
import { skillHeader } from "./agent/injections.ts";
import { findSkill, managedSkills, skillMessage, skillUsesArguments, type ManagedSkill, type SkillPackage } from "./extensions.ts";
import { commandHeader, type CustomCommand, customCommands, expandCommand, findCommand } from "./commands/custom.ts";

export const SLASH_SKILL_KIND = "slash-skill";
export const SLASH_COMMAND_KIND = "slash-command";

export type SlashHit =
  | { kind: "skill"; skill: ManagedSkill; command: string; args: string }
  | { kind: "pkg"; pkg: SkillPackage; command: string; args: string }
  | { kind: "command"; cmd: CustomCommand; command: string; args: string };

// /名字 或 /包名/名字，后面空白隔开的都是参数
const SLASH_RE = /^\/([^\s/]+(?:\/[^\s/]+)?)(?:\s+([\s\S]*))?$/;

// workspace = 会话的工作区（项目级技能与命令目录跟着它）
export function resolveSlash(message: string, workspace?: string): SlashHit | null {
  const m = SLASH_RE.exec(String(message ?? "").trim());
  if (!m) return null;
  const command = m[1];
  const args = (m[2] ?? "").trim();
  if (!/^skill:/i.test(command)) {
    const cmd = findCommand(command, workspace);
    if (cmd) return { kind: "command", cmd, command, args };
  }
  const name = command.replace(/^skill:/i, "");
  if (!name) return null;
  const hit = findSkill(name, workspace);
  if (hit.kind === "skill") return { kind: "skill", skill: hit.skill, command, args };
  if (hit.kind === "pkg") return { kind: "pkg", pkg: hit.pkg, command, args };
  return null;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

export interface SlashInjection {
  name: string; // 技能名、包名或命令名（界面上那一行提示用）
  text: string;
  kind: string; // injections 的类别：slash-skill / slash-command
  pkg?: boolean;
  command?: boolean; // 自定义命令（不发「载入技能」那一行）
}

// 这次点名要追加的 harness 消息。loaded = 这个技能的正文此刻还在转录里（加载过、没被压缩掉）。
// workspace = 会话的工作区：命令正文里 @路径 引用的文件只认它里面的（不给就不附文件）
export function slashInjection(hit: SlashHit, loaded: (name: string) => boolean, workspace?: string): SlashInjection | null {
  if (hit.kind === "command") {
    const text = expandCommand(hit.cmd, hit.args, hit.command, workspace);
    return {
      name: hit.cmd.name,
      kind: SLASH_COMMAND_KIND,
      command: true,
      text:
        text ??
        `${commandHeader(hit.cmd.name)}\nThe user ran /${hit.command}, but its file (${hit.cmd.file}) could not be read right now — tell the user the command file seems to be missing.`,
    };
  }
  if (hit.kind === "pkg") {
    const members = hit.pkg.members.filter((m) => !m.userOnly);
    if (!members.length) return null;
    const rows = members.map((m) => `- ${m.name} — ${clip(m.short || m.description, 160)}`);
    return {
      name: hit.pkg.pkg,
      kind: SLASH_SKILL_KIND,
      pkg: true,
      text:
        `[Skill package: ${hit.pkg.pkg}]\n` +
        `The user pointed at this skill package with /${hit.command}: pick the member that fits their request in the message above and load it with Skill({name: "<skill>"}) before doing the work.\n` +
        rows.join("\n"),
    };
  }
  const { skill } = hit;
  // 正文还在、又没用 $ARGUMENTS（换了参数就得重新注入）：只提醒一句，不再整段塞一遍
  if (loaded(skill.name) && !skillUsesArguments(skill)) {
    return {
      name: skill.name,
      kind: SLASH_SKILL_KIND,
      text:
        `[Skill again: ${skill.name}]\n` +
        `The user invoked /${hit.command} again — its instructions are already loaded earlier in this conversation (the message starting "${skillHeader(skill.name)}"). Follow them for the request in their message above.`,
    };
  }
  const text = skillMessage(skill, {
    args: hit.args,
    argsBlock: false,
    lead: `The user invoked this skill directly with /${hit.command} — follow its instructions for the request in their message above.`,
  });
  return {
    name: skill.name,
    kind: SLASH_SKILL_KIND,
    text:
      text ??
      `${skillHeader(skill.name)}\nThe user invoked /${hit.command}, but its SKILL.md (${skill.skillMd}) could not be read right now — tell the user the skill's files seem to be missing.`,
  };
}

// ── 输入框 / 面板的清单（GET /api/commands）────────────────────────────────────
export interface CommandSkill {
  name: string;
  description: string;
  pkg?: string;
  argumentHint?: string;
  userOnly?: boolean;
  source?: "project" | "user"; // 项目级 / 用户级目录里的（没有 = 扩展中心的）
}
export interface CommandPackage {
  name: string;
  count: number;
}
export interface CommandList {
  skills: CommandSkill[];
  packages: CommandPackage[];
}

// user-invocable: false 的不进面板（模型照常可用）；包只列成员 ≥2 的（1 个成员的包点包名没意义）。
// 自定义命令排在技能前面、按「只能用户点」标（面板上显示为命令），同名的只列优先的那条；被同名命令盖住的技能不列
export function commandList(workspace?: string): CommandList {
  const seen = new Set<string>();
  const commands = customCommands(workspace).filter((c) => {
    const k = c.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const skills = managedSkills(workspace).filter((s) => !s.hidden && !seen.has(s.name.toLowerCase()));
  const counts = new Map<string, number>();
  for (const s of skills) if (s.pkg) counts.set(s.pkg, (counts.get(s.pkg) ?? 0) + 1);
  return {
    skills: [
      ...commands.map((c) => ({
        name: c.name,
        description: clip(`${c.description} (${c.namespace ? `${c.scope}:${c.namespace}` : c.scope})`, 140),
        ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
        userOnly: true,
        source: c.scope,
      })),
      ...skills.map((s) => ({
        name: s.name,
        description: clip(s.short || s.description, 140),
        ...(s.pkg ? { pkg: s.pkg } : {}),
        ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
        ...(s.userOnly ? { userOnly: true } : {}),
        ...(s.source ? { source: s.source } : {}),
      })),
    ],
    packages: [...counts].filter(([, n]) => n >= 2).map(([name, count]) => ({ name, count })),
  };
}
