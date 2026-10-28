// 成员实例的技能（2026-10-28 用户反馈：成员在 dimensio 里打「/」检索不到技能）。
//
// 修前：租户模式一概不认 bridge 的扩展注册表（里面有连接器凭据），成员实例的技能目录恒为空——/ 面板只有内置命令。
// 修后：bridge 给两份只含技能的清单（DIMENSIO_SKILL_REGISTRIES：他自己添加的在前、全服的在后），按顺序合并、同名前面的优先；
// 这些技能目录在 bridge 数据根（禁区）里，只读放行：Read 读得到、命令行能引用它的脚本、写照样拦；别人的技能目录照旧拦。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { commandList } from "./commands.ts";
import { findSkill, insideGrantedSkillDir, managedSkills } from "./extensions.ts";
import { readVerdict } from "./sandbox.ts";
import { commandPolicyViolation } from "./tools/bash.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-tenant-skills-"));
const users = path.join(tmp, "users");
const alice = path.join(users, "alice");
const host = path.join(tmp, "bridge-data");
const ext = path.join(host, "extensions");
const mine = path.join(ext, "members", "aaaa");
const other = path.join(ext, "members", "bbbb");
fs.mkdirSync(alice, { recursive: true });

function skill(root: string, rel: string, name: string): void {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBODY-${name}\n`);
  fs.writeFileSync(path.join(dir, "scripts", "run.py"), "print(1)\n");
}
const item = (name: string, dir: string, extra: Record<string, unknown> = {}) => ({
  id: name, type: "skill", name, description: `${name} skill`, enabled: true, agents: { dimensio: true }, dir, entry: "SKILL.md", ...extra,
});

// 全服清单：root 指扩展根，dir 相对它；带一个同名技能（xlsx）——成员自己的那个应当优先
skill(ext, "shared/skills/xlsx", "xlsx");
skill(ext, "shared/skills/pdf", "pdf");
skill(ext, "shared/skills/off", "off");
const sharedView = path.join(ext, "runtime", "shared-skills.json");
fs.mkdirSync(path.dirname(sharedView), { recursive: true });
fs.writeFileSync(sharedView, JSON.stringify({
  root: ext,
  items: [
    item("xlsx", "shared/skills/xlsx"),
    item("pdf", "shared/skills/pdf", { pkg: "docs" }),
    item("off", "shared/skills/off", { agents: { dimensio: false } }),
  ],
}));
// 他自己的：dir 相对清单所在目录
skill(mine, "skills/xlsx", "xlsx");
skill(mine, "skills/my-notes", "my-notes");
fs.writeFileSync(path.join(mine, "registry.json"), JSON.stringify({ items: [item("xlsx", "skills/xlsx"), item("my-notes", "skills/my-notes")] }));
// 别的成员的（不在他的清单里）
skill(other, "skills/secret", "secret");
fs.writeFileSync(path.join(other, "registry.json"), JSON.stringify({ items: [item("secret", "skills/secret")] }));

const KEYS = ["DIMENSIO_TENANT", "DIMENSIO_TENANT_SHELL", "DIMENSIO_ACCESS_LOCK", "DIMENSIO_DENY_PATHS", "WORKSPACE_DIR", "DIMENSIO_SKILL_REGISTRIES", "BRIDGE_EXTENSIONS_FILE"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function tenantEnv(registries: string[]): void {
  process.env.DIMENSIO_TENANT = "1";
  process.env.DIMENSIO_TENANT_SHELL = "1";
  delete process.env.DIMENSIO_ACCESS_LOCK;
  delete process.env.BRIDGE_EXTENSIONS_FILE;
  process.env.DIMENSIO_DENY_PATHS = [users, host].join(path.delimiter);
  process.env.WORKSPACE_DIR = alice;
  process.env.DIMENSIO_SKILL_REGISTRIES = registries.join(path.delimiter);
}
function restore(): void {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
after(() => {
  restore();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

test("成员实例：合并自己的 + 全服的技能，同名自己的优先，没勾 dimensio 的不出现", () => {
  tenantEnv([path.join(mine, "registry.json"), sharedView]);
  try {
    const skills = managedSkills();
    assert.deepEqual(skills.map((s) => s.name).sort(), ["my-notes", "pdf", "xlsx"]);
    const xlsx = skills.find((s) => s.name === "xlsx")!;
    assert.equal(path.dirname(xlsx.skillMd), path.join(mine, "skills", "xlsx"), "同名时成员自己的优先");
    // / 面板与按名查找
    assert.deepEqual(commandList().skills.map((s) => s.name).sort(), ["my-notes", "pdf", "xlsx"]);
    const hit = findSkill("/pdf");
    assert.equal(hit.kind, "skill");
  } finally { restore(); }
});

test("成员实例：自己的清单还不存在时照样拿到全服技能", () => {
  tenantEnv([path.join(tmp, "nope", "registry.json"), sharedView]);
  try {
    assert.deepEqual(managedSkills().map((s) => s.name).sort(), ["pdf", "xlsx"]);
  } finally { restore(); }
});

test("成员实例：技能目录在禁区里也只读放行，别人的技能目录照旧拦", () => {
  tenantEnv([path.join(mine, "registry.json"), sharedView]);
  try {
    const myScript = path.join(mine, "skills", "my-notes", "scripts", "run.py");
    const sharedMd = path.join(ext, "shared", "skills", "pdf", "SKILL.md");
    const theirs = path.join(other, "skills", "secret", "SKILL.md");
    assert.ok(insideGrantedSkillDir(myScript));
    assert.equal(readVerdict(myScript), null);
    assert.equal(readVerdict(sharedMd), null);
    assert.match(readVerdict(theirs) ?? "", /belongs to the host or to another user/);
    assert.match(readVerdict(path.join(host, "extensions", "registry.json")) ?? "", /Blocked/);
    // 命令行：引用技能脚本放行；引用别人的技能 / 数据根其它位置照旧拦
    assert.equal(commandPolicyViolation(`python "${myScript}"`, alice, "workspace"), null);
    assert.match(commandPolicyViolation(`cat "${theirs}"`, alice, "workspace") ?? "", /belongs to the host or to another user/);
    assert.match(commandPolicyViolation(`cat "${path.join(host, "config.json")}"`, alice, "workspace") ?? "", /belongs to the host/);
  } finally { restore(); }
});

test("成员实例：技能目录不可写", () => {
  tenantEnv([path.join(mine, "registry.json"), sharedView]);
  try {
    const target = path.join(mine, "skills", "my-notes", "SKILL.md");
    assert.ok(commandPolicyViolation(`echo x > "${target}"`, alice, "workspace"), "写技能目录应当被拦");
  } finally { restore(); }
});
