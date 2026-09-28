// C5（G1、K57、X51）：按名加载扩展中心的技能。目录里不再列 SKILL.md 路径、包折成一行——模型点名或任务对得上时
// 调它：技能 → 正文作为紧随其后的 harness 消息（kind "skill"）送达，tool_result 只说「载入了」；包 → 列出成员与各自的
// 用途；名字不对 → 列出全部名字。按名现读注册表：会话里的清单是冻结的，但新装的技能点名时也能用。
import { skillHeader } from "../agent/injections.ts";
import { findSkill, skillMessage } from "../extensions.ts";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

export const skillTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: {
    name: "Skill",
    description:
      "Load a skill from the Managed skills section (installed by the user in the Bridge extension center). " +
      "For a skill, its instructions arrive as the next message — follow them before doing the work your own way. " +
      "For a package, you get the list of its skills and what each does; then load the one you need by its name. " +
      "Load skills yourself — never ask a sub-agent to read or follow one.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill or package name exactly as listed (e.g. \"stock-analysis\" or \"gildata-aifinmarket\")." },
        args: { type: "string", description: "Optional: the user's request details the skill should apply to." },
      },
      required: ["name"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const name = String(args.name ?? "").trim();
    if (!name) return fail("skill", "Give the skill or package name exactly as listed in the Managed skills section.");
    const hit = findSkill(name);
    if (hit.kind === "missing") {
      if (!hit.names.length) return fail(`no skill ${name}`, "No skills are installed for dimensio right now (Bridge extension center).");
      return fail(
        `no skill ${name}`,
        `No skill or package named "${name}".` +
          (hit.packages.length ? `\nPackages: ${hit.packages.join(", ")}` : "") +
          `\nSkills: ${hit.names.join(", ")}`,
      );
    }
    if (hit.kind === "pkg") {
      const { pkg, description } = hit.pkg;
      // E3：只能用户点名的成员不列（模型载入不了）
      const members = hit.pkg.members.filter((m) => !m.userOnly);
      const rows = members.map((m) => `- ${m.name} — ${clip(m.short || m.description, 160)}`);
      return ok(
        `package ${pkg} (${members.length})`,
        `Package "${pkg}" — ${members.length} skills. ${clip(description, 300)}\nLoad the one you need with Skill({name: "<skill>"}):\n${rows.join("\n")}`,
      );
    }
    const { skill } = hit;
    // E3：SKILL.md 写了 disable-model-invocation: true——只能用户在输入框里 /名字 点，模型不许自己载入
    if (skill.userOnly) {
      return fail(
        `skill ${skill.name} (user-only)`,
        `Skill "${skill.name}" can only be started by the user (they type /${skill.name} in the message box). Don't load it yourself; if it fits, tell the user they can run /${skill.name}.`,
      );
    }
    if (ctx.skillLoaded?.(skill.name)) {
      return ok(
        `skill ${skill.name} (already loaded)`,
        `Skill "${skill.name}" is already loaded earlier in this conversation (the message starting "${skillHeader(skill.name)}"). Follow it — no need to load it again.`,
      );
    }
    const text = skillMessage(skill, { args: String(args.args ?? "") });
    if (!text) return fail(`skill ${skill.name}`, `Could not read ${skill.skillMd} right now — try again, or tell the user the skill's files are missing.`);
    return {
      ok: true,
      summary: `skill ${skill.name}`,
      content: [{ t: "text", text: `Skill "${skill.name}" loaded — its instructions follow in the next message. Follow them.` }],
      skill: { name: skill.name, text },
    };
  },
};
