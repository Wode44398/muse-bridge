// 项目级 / 用户级技能目录与自定义斜杠命令（Claude Code 同格式）：
//   · 技能：<工作区>/.claude/skills、.dimensio/skills 与用户级 ~/.claude/skills 等；同名 项目级 > 用户级 > 扩展中心；目录里标来源；
//     载入时给出技能目录的绝对路径；用户级技能根只读放行；成员实例只认自己工作区里的。
//   · 命令：commands/**/*.md；$ARGUMENTS、$1 $2、@路径（按沙箱读）、frontmatter；命令优先于同名技能（/skill:名字 仍点技能）；
//     `!命令` 不执行；/ 面板的清单里有它们。
// 全是临时目录与假注册表，不读真实的 ~/.claude 与扩展中心。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { messageKind } from "./agent/injections.ts";
import type { Block, Msg } from "./agent/turn.ts";
import { commandList, resolveSlash, slashInjection } from "./commands.ts";
import { findSkill, grantedSkillDirs, managedSkillsSection, skillMessage } from "./extensions.ts";
import { Sandbox } from "./sandbox.ts";
import { startRun } from "./session.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { sanctionedToolDirs } from "./tools/bash/env.ts";
import { commandScopeViolation } from "./tools/bash/policy.ts";
import { skillTool } from "./tools/skill.ts";

let tmp = "";
let ws = "";
let userDir = "";
let extRoot = "";
const saved = { dirs: process.env.DIMENSIO_USER_CONFIG_DIRS, tenant: process.env.DIMENSIO_TENANT, ext: process.env.BRIDGE_EXTENSIONS_FILE };

function skill(root: string, name: string, front: string, body = `BODY-${name} see scripts/run.sh`): string {
  const dir = path.join(root, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${front}\n---\n\n${body}\n`);
  return dir;
}

function command(root: string, rel: string, text: string): string {
  const file = path.join(root, "commands", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-local-skills-"));
  ws = path.join(tmp, "ws");
  userDir = path.join(tmp, "home", ".claude");
  extRoot = path.join(tmp, "extensions");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(extRoot, { recursive: true });
  process.env.DIMENSIO_USER_CONFIG_DIRS = userDir;
  process.env.BRIDGE_EXTENSIONS_FILE = path.join(extRoot, "registry.json");
  // 扩展中心里也有一个叫 deploy 的（被项目级的盖住）和一个只在这里有的 house
  const items = ["deploy", "house"].map((name, i) => {
    skill(extRoot, name, `name: ${name}\ndescription: ext ${name}`);
    return { id: `x${i}`, type: "skill", name, description: `ext ${name}.`, enabled: true, agents: { dimensio: true }, dir: `skills/${name}`, entry: "SKILL.md" };
  });
  fs.writeFileSync(path.join(extRoot, "registry.json"), JSON.stringify({ items }));
});

afterEach(() => {
  const restore = (name: string, v: string | undefined) => {
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  };
  restore("DIMENSIO_USER_CONFIG_DIRS", saved.dirs);
  restore("DIMENSIO_TENANT", saved.tenant);
  restore("BRIDGE_EXTENSIONS_FILE", saved.ext);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

const textOf = (blocks: Block[]): string => blocks.map((b) => (b.t === "text" ? b.text : "")).join("");

test("技能目录：项目级 > 用户级 > 扩展中心；目录里标出来源；只有扩展中心的技能时开头那句不变", () => {
  const before = managedSkillsSection({ contextWindow: 131_072, workspace: ws }) ?? "";
  assert.ok(before.startsWith("The user installed these skills via the Bridge extension center."), "没有本地技能：与以前一字不差");
  assert.ok(!/\((?:project|user)\)/.test(before));

  skill(path.join(ws, ".claude"), "deploy", "name: deploy\ndescription: Deploy this repo to staging. Then verify.");
  skill(path.join(ws, ".dimensio"), "lint", `name: lint\ndescription: |\n  Run the project's linters.\n  Second line.`);
  skill(userDir, "notes", "name: notes\ndescription: Keep my notes tidy.");
  skill(userDir, "lint", "name: lint\ndescription: user lint (shadowed)");
  const section = managedSkillsSection({ contextWindow: 131_072, workspace: ws }) ?? "";
  assert.ok(section.startsWith("These skills are available: ones marked (project)"), section.slice(0, 200));
  assert.ok(section.includes("- lint (project) — Run the project's linters."), section);
  assert.ok(section.includes("- deploy (project) — Deploy this repo to staging."), "一句描述");
  assert.ok(section.includes("- notes (user) — Keep my notes tidy."));
  assert.ok(section.includes("- house — ext house."), "扩展中心的不标来源");
  assert.ok(!section.includes("user lint") && !section.includes("ext deploy"), "同名的只留优先的那个");

  const hit = findSkill("deploy", ws);
  assert.ok(hit.kind === "skill" && hit.skill.source === "project");
  const msg = skillMessage(hit.kind === "skill" ? hit.skill : (null as never)) ?? "";
  assert.ok(msg.includes(`Skill directory: ${path.join(ws, ".claude", "skills", "deploy")}`), msg.slice(0, 300));
  assert.ok(msg.includes("relative paths in the instructions below") && msg.includes("BODY-deploy"));
  assert.equal(findSkill("deploy").kind === "skill" && (findSkill("deploy") as { skill: { source?: string } }).skill.source, undefined, "不给工作区就只有用户级与扩展中心");
});

test("用户级技能根只读放行（技能正文里的脚本读得到）；成员实例不认用户级，只认自己工作区里的", () => {
  skill(userDir, "notes", "name: notes\ndescription: mine");
  skill(path.join(ws, ".claude"), "proj", "name: proj\ndescription: project one");
  assert.ok(grantedSkillDirs().includes(path.join(userDir, "skills")));
  const sb = new Sandbox(ws);
  const notesMd = path.join(userDir, "skills", "notes", "SKILL.md");
  assert.doesNotThrow(() => sb.resolve(notesMd));
  assert.throws(() => sb.resolve(notesMd, { forWrite: true }), "Write 工具写不进去");
  // Bash：读、跑里面的脚本可以；写（重定向）照工作区越界拒——用户级技能根不在 Bash 的可写白名单里
  const fwd = notesMd.replace(/\\/g, "/");
  assert.equal(commandScopeViolation(`cat "${fwd}"`, ws, "workspace"), null);
  assert.match(commandScopeViolation(`echo x > "${fwd}"`, ws, "workspace") ?? "", /escapes the workspace/);
  assert.ok(!sanctionedToolDirs().includes(path.join(userDir, "skills")));

  process.env.DIMENSIO_TENANT = "1";
  const names = commandList(ws).skills.map((s) => s.name);
  assert.ok(names.includes("proj") && !names.includes("notes"), names.join(","));
  assert.ok(!grantedSkillDirs().includes(path.join(userDir, "skills")));
});

test("自定义命令：$ARGUMENTS 与 $1 $2（引号算一段）、@路径按沙箱读进来、工作区外的不读、!命令不执行；frontmatter 进清单", () => {
  fs.writeFileSync(path.join(ws, "notes.md"), "NOTES-CONTENT");
  fs.writeFileSync(path.join(tmp, "outside.txt"), "OUTSIDE");
  command(
    path.join(ws, ".claude"),
    "review.md",
    `---\ndescription: Review a change\nargument-hint: <pr> <focus>\nallowed-tools: Bash(git diff:*), Read\nmodel: some-model\n---\n` +
      `Review PR $1 with focus on $2. Full args: $ARGUMENTS\nContext: @notes.md and @${path.join(tmp, "outside.txt").replace(/\\/g, "/")}\nCurrent state: !\`git status\`\n`,
  );
  const hit = resolveSlash(`/review 42 "error handling"`, ws);
  assert.equal(hit?.kind, "command");
  const inj = slashInjection(hit!, () => false, ws)!;
  assert.equal(inj.kind, "slash-command");
  assert.ok(inj.text.startsWith("[Command: /review]"));
  assert.ok(inj.text.includes(`Review PR 42 with focus on error handling. Full args: 42 "error handling"`), inj.text);
  assert.ok(inj.text.includes(`<file path="notes.md">\nNOTES-CONTENT\n</file>`), "@路径的文件附上");
  assert.ok(!inj.text.includes("OUTSIDE"), "工作区外的不附");
  assert.ok(inj.text.includes("!`git status`") && inj.text.includes("not run automatically"), "!命令原样留着并说明不执行");
  assert.ok(inj.text.includes("Bash(git diff:*), Read"), "allowed-tools 随命令带着");

  const entry = commandList(ws).skills.find((s) => s.name === "review")!;
  assert.equal(entry.userOnly, true);
  assert.equal(entry.source, "project");
  assert.equal(entry.argumentHint, "<pr> <focus>");
  assert.ok(entry.description.startsWith("Review a change (project)"));
});

test("命令优先于同名技能（/skill:名字 仍点技能，清单里被盖住的技能不列）；子目录归类、也能写成 /子目录:名字；项目级 > 用户级", () => {
  skill(path.join(ws, ".claude"), "deploy", "name: deploy\ndescription: skill deploy");
  command(path.join(ws, ".claude"), "deploy.md", "Deploy command body");
  command(path.join(ws, ".claude"), "frontend/component.md", "Make a component named $ARGUMENTS");
  command(userDir, "component.md", "user component (shadowed)");
  command(userDir, "mine.md", "---\ndescription: my own\n---\nMine body");

  assert.equal(resolveSlash("/deploy now", ws)?.kind, "command");
  assert.equal(resolveSlash("/skill:deploy now", ws)?.kind, "skill");
  const a = resolveSlash("/component Button", ws);
  const b = resolveSlash("/frontend:component Button", ws);
  for (const h of [a, b]) {
    assert.ok(h?.kind === "command");
    assert.ok(slashInjection(h!, () => false)!.text.includes("Make a component named Button"));
  }
  assert.equal(resolveSlash("/mine", ws)?.kind, "command");
  assert.equal(resolveSlash("/mine")?.kind, "command", "不给工作区也认用户级");
  const bare = resolveSlash("/deploy now");
  assert.ok(bare?.kind === "skill" && !bare.skill.source, "不给工作区：项目级的命令与技能都没有，只剩扩展中心的 deploy");
  const list = commandList(ws).skills;
  const names = list.map((s) => s.name);
  assert.equal(names.filter((n) => n === "deploy").length, 1, "被盖住的技能不列");
  assert.equal(list.find((s) => s.name === "component")!.source, "project");
  assert.ok(list.find((s) => s.name === "component")!.description.includes("(project:frontend)"));
  assert.equal(list.find((s) => s.name === "mine")!.source, "user");
});

test("开跑：/命令 照原话留下，展开的正文作为 slash-command 消息紧跟其后，第一次请求就看得到；不发「载入技能」那一行", async (t) => {
  command(path.join(ws, ".dimensio"), "ship.md", "Ship it: bump the version to $1 and write the changelog.");
  const adapter = scripted(t).next(say("好"));
  const session = attachSession(adapter, ws, { tools: [skillTool] });
  await startRun(session, "/ship 1.2.3").done;
  const msgs: Msg[] = session.state!.messages;
  const at = msgs.findIndex((m) => m.role === "user" && !m.origin);
  assert.equal(textOf(msgs[at].content), "/ship 1.2.3");
  assert.equal(messageKind(msgs[at + 1]), "slash-command");
  assert.ok(textOf(msgs[at + 1].content).includes("bump the version to 1.2.3"));
  assert.ok(textOf(adapter.inputs[0].messages.flatMap((m) => m.content)).includes("bump the version to 1.2.3"));
  assert.equal(session.runLog.filter((ev) => ev.e === "skill_loaded").length, 0);
});

// 目录链接（junction 不要管理员权限）：项目级的技能 / 命令按真实落点判，链出工作区的当不存在；工作区内的链接照常
test("项目级技能与命令目录里的链接：真实落点在工作区外的不收、不展开；工作区内的照常；用户级允许链到别处", () => {
  skill(path.join(tmp, "outside-root"), "leak", "name: leak\ndescription: LEAK-SECRET-LINE");
  fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  fs.symlinkSync(path.join(tmp, "outside-root", "skills"), path.join(ws, ".claude", "skills"), "junction");
  const outCmds = path.join(tmp, "other-user", "cmds");
  fs.mkdirSync(outCmds, { recursive: true });
  fs.writeFileSync(path.join(outCmds, "steal.md"), "OTHER-USER-CONTENT");
  fs.symlinkSync(outCmds, path.join(ws, ".claude", "commands"), "junction");
  // 工作区里的链接（落点仍在工作区内）照常
  skill(path.join(ws, "shared"), "inner", "name: inner\ndescription: inner skill");
  fs.mkdirSync(path.join(ws, ".dimensio", "skills"), { recursive: true });
  fs.symlinkSync(path.join(ws, "shared", "skills", "inner"), path.join(ws, ".dimensio", "skills", "inner"), "junction");
  // 用户级：链到自己的 dotfiles 仓库可以
  skill(path.join(tmp, "dotfiles"), "dots", "name: dots\ndescription: from dotfiles");
  fs.mkdirSync(path.join(userDir, "skills"), { recursive: true });
  fs.symlinkSync(path.join(tmp, "dotfiles", "skills", "dots"), path.join(userDir, "skills", "dots"), "junction");

  const section = managedSkillsSection({ contextWindow: 131_072, workspace: ws }) ?? "";
  assert.ok(!section.includes("LEAK-SECRET-LINE") && !section.includes("leak"), section);
  assert.equal(findSkill("leak", ws).kind, "missing");
  assert.ok(section.includes("- inner (project)"), section);
  assert.ok(section.includes("- dots (user)"), section);
  assert.ok(!commandList(ws).skills.some((s) => s.name === "steal"));
  assert.notEqual(resolveSlash("/steal", ws)?.kind, "command");

  // 列清单之后才把技能目录换成指出去的链接：读正文前再判一次，不读
  skill(path.join(ws, ".dimensio"), "swap", "name: swap\ndescription: swap me");
  const hit = findSkill("swap", ws);
  assert.ok(hit.kind === "skill");
  fs.rmSync(path.join(ws, ".dimensio", "skills", "swap"), { recursive: true });
  skill(path.join(tmp, "outside-root"), "swap", "name: swap\ndescription: x", "SWAPPED-OUTSIDE-BODY");
  fs.symlinkSync(path.join(tmp, "outside-root", "skills", "swap"), path.join(ws, ".dimensio", "skills", "swap"), "junction");
  assert.equal(skillMessage(hit.kind === "skill" ? hit.skill : (null as never)), null);
});

test("命令的 @路径 固定按 workspace 档读：会话是 bypass 也不附工作区外的文件，工作区里的凭据文件也不附", async (t) => {
  fs.writeFileSync(path.join(tmp, "id_ed25519"), "PRIVATE-KEY-CONTENT");
  fs.writeFileSync(path.join(ws, ".env"), "API_KEY=FAKE-DUMMY");
  fs.writeFileSync(path.join(ws, "ok.txt"), "OK-CONTENT");
  command(path.join(ws, ".claude"), "build.md", `Build it. @${path.join(tmp, "id_ed25519").replace(/\\/g, "/")} @.env @ok.txt`);
  const adapter = scripted(t).next(say("好"));
  const session = attachSession(adapter, ws, { tools: [skillTool] });
  session.state!.ctx.sandbox.access = "bypass";
  await startRun(session, "/build").done;
  const all = textOf(session.state!.messages.flatMap((m) => m.content));
  assert.ok(all.includes("OK-CONTENT"), "工作区里的普通文件照常附上");
  assert.ok(!all.includes("PRIVATE-KEY-CONTENT"), "工作区外的不附");
  assert.ok(!all.includes("FAKE-DUMMY"), "凭据文件不附");
});
