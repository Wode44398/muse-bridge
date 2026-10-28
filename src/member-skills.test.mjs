// 成员自己添加的技能（2026-10-28 用户反馈：成员在 dimensio 里打「/」检索不到技能；并要求成员也能自己添加）。
//   · 每人一份独立注册表，不进管理员的 registry.json：管理员侧的注入与列表都看不到；别的成员也看不到；
//   · 只收技能、生效 agent 只有 claude / dimensio；
//   · Claude：成员会话多注入他自己的聚合插件（mine），沙箱只读放行他自己的那棵目录、别人的照旧拦；
//   · dimensio：成员实例拿到「自己的清单 + 全服技能清单」，全服清单只含全服的技能、不含连接器与管理员自用的。
// 临时数据根，不碰真实扩展中心。
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'member-skills-')));
process.env.BRIDGE_DATA_ROOT = root;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
const ext = await import('./extensions.mjs');
const ms = await import('./member-skills.mjs');
const extRoot = path.join(root, 'extensions');

beforeEach(() => rmSync(extRoot, { recursive: true, force: true }));
after(() => rmSync(root, { recursive: true, force: true }));

function skillDir(name) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'member-skills-src-'));
  mkdirSync(path.join(d, 'scripts'));
  writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\nbody\n`);
  writeFileSync(path.join(d, 'scripts', 'run.py'), 'print(1)\n');
  return d;
}
const withDir = (name, fn) => { const d = skillDir(name); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
const addMine = (user, name, opts) => withDir(name, (d) => ms.installMemberSkillFromDir(user, d, opts));
const addAdmin = (name, opts) => withDir(name, (d) => ext.installSkillFromDir(d, opts));

test('成员的技能落在自己的注册表里，管理员与别的成员都看不到', () => {
  const a = addMine('alice', 'notes', { pkg: 'mine-pkg' });
  assert.equal(a.scope, 'member');
  assert.deepEqual(a.agents, { claude: true, dimensio: true });
  assert.ok(existsSync(path.join(ms.memberRoot('alice'), 'skills', 'notes', 'SKILL.md')));
  assert.throws(() => addMine('alice', 'notes'), /同名/);
  addMine('bob', 'notes');   // 别人可以有同名的

  assert.deepEqual(ms.listMemberSkills('alice').map((x) => x.name), ['notes']);
  assert.equal(ms.listMemberSkills('carol').length, 0);
  assert.deepEqual(ext.listExtensions(), [], '管理员的扩展列表里没有成员的技能');
  assert.equal(ext.claudeExtensionsFor({ kind: 'admin', sandbox: false }).plugins.length, 0);
  assert.equal(ext.codexExtensionParams().instructions, '');
});

test('开关、生效 agent、包级操作、卸载；不许勾 Codex', () => {
  const a = addMine('alice', 'notes', { pkg: 'p' });
  addMine('alice', 'todo', { pkg: 'p' });
  assert.equal(ms.updateMemberSkill('alice', a.id, { agents: { dimensio: false } }).agents.dimensio, false);
  assert.throws(() => ms.updateMemberSkill('alice', a.id, { agents: { codex: true } }), /Codex/);
  assert.throws(() => ms.updateMemberSkill('bob', a.id, { enabled: false }), /不存在/, '改不到别人的');
  ms.bulkMemberSkills('alice', 'p', { action: 'disable' });
  assert.ok(ms.listMemberSkills('alice').every((x) => !x.enabled));
  assert.equal(ms.deleteMemberSkill('bob', a.id), false, '删不到别人的');
  assert.equal(ms.deleteMemberSkill('alice', a.id), true);
  assert.ok(!existsSync(path.join(ms.memberRoot('alice'), 'skills', 'notes')));
  ms.bulkMemberSkills('alice', 'p', { action: 'delete' });
  assert.equal(ms.listMemberSkills('alice').length, 0);
});

test('文件预览锁在技能目录里', () => {
  const a = addMine('alice', 'notes');
  assert.deepEqual(ms.listMemberSkillFiles('alice', a.id).map((f) => f.path), ['SKILL.md', 'scripts/run.py']);
  assert.match(ms.readMemberSkillFile('alice', a.id, 'SKILL.md'), /name: notes/);
  assert.throws(() => ms.readMemberSkillFile('alice', a.id, '../../registry.json'), /越界/);
  assert.throws(() => ms.readMemberSkillFile('bob', a.id, 'SKILL.md'), /不存在/);
});

test('Claude：成员会话注入自己的聚合插件；沙箱只读放行自己的目录，别人的照旧拦', async () => {
  const { sandboxFence } = await import('./agents/claude.mjs');
  addMine('alice', 'notes');
  addMine('bob', 'secret');
  const plugins = ms.memberClaudePlugins('alice');
  assert.equal(plugins.length, 1);
  const agg = plugins[0].path;
  assert.equal(JSON.parse(readFileSync(path.join(agg, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'mine');
  assert.ok(existsSync(path.join(agg, 'skills', 'notes', 'SKILL.md')));
  ms.updateMemberSkill('alice', ms.listMemberSkills('alice')[0].id, { agents: { claude: false } });
  assert.deepEqual(ms.memberClaudePlugins('alice'), [], '没有勾给 Claude 的就不注入');
  assert.ok(!existsSync(path.join(agg, 'skills', 'notes')));

  const cwd = path.join(root, 'users', 'alice');
  mkdirSync(cwd, { recursive: true });
  const ctx = { kind: 'user', user: 'alice', sandbox: true, cwd };
  const mineMd = path.join(ms.memberRoot('alice'), 'skills', 'notes', 'SKILL.md');
  const theirsMd = path.join(ms.memberRoot('bob'), 'skills', 'secret', 'SKILL.md');
  assert.equal(sandboxFence(ctx, 'Read', { file_path: mineMd }), null);
  assert.notEqual(sandboxFence(ctx, 'Write', { file_path: mineMd, content: 'x' }), null, '写不放行');
  assert.notEqual(sandboxFence(ctx, 'Read', { file_path: theirsMd }), null, '别人的不放行');
  assert.equal(sandboxFence(ctx, 'Bash', { command: `python "${path.join(path.dirname(mineMd), 'scripts', 'run.py')}"` }), null);
  assert.notEqual(sandboxFence(ctx, 'Bash', { command: `cat "${theirsMd}"` }), null);
});

test('dimensio：全服技能清单只含全服的技能，成员实例拿到自己的 + 全服的两份', () => {
  addAdmin('admin-only');
  addAdmin('team', { scope: 'shared' });
  ext.saveConnector({ name: 'team-mcp', transport: 'http', url: 'https://example.invalid/mcp', scope: 'shared' });
  const view = JSON.parse(readFileSync(ext.SHARED_SKILLS_VIEW, 'utf8'));
  assert.equal(view.root, extRoot);
  assert.deepEqual(view.items.map((x) => x.name), ['team']);
  assert.equal(view.items[0].dir, 'shared/skills/team');
  assert.ok(!JSON.stringify(view).includes('connector'), '不含连接器');

  const [own, shared] = ms.memberDimensioRegistries('alice');
  assert.equal(own, path.join(ms.memberRoot('alice'), 'registry.json'));
  assert.equal(shared, ext.SHARED_SKILLS_VIEW);
});
