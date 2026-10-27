// 扩展中心的两个范围：管理员自用（admin）与全服统一（shared）。
//   · 两边各管各的同名与包，目录分开（shared 落 extensions/shared/），聚合插件分开（bridge / server）；
//   · 注入口径：主机管理员 = 自用 + 全服，注册用户 = 只有全服，快照访客 = 都没有；
//   · 沙箱用户对全服扩展目录只读：Read/Glob/Grep 放行、Write 照拦、管理员自用的目录照拦；Bash 里引用全服目录不算越界，
//     但借它做 .. 穿越照样拦。
// 临时数据根，不碰真实扩展中心。
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ext-scopes-')));
process.env.BRIDGE_DATA_ROOT = root;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
const ext = await import('./extensions.mjs');
const { installedKeys } = await import('./ext-market.mjs');
const extRoot = path.join(root, 'extensions');

beforeEach(() => rmSync(extRoot, { recursive: true, force: true }));
after(() => rmSync(root, { recursive: true, force: true }));

function skillDir(name, body = 'do things') {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ext-scopes-src-'));
  writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`);
  return d;
}
const install = (name, opts) => { const d = skillDir(name); try { return ext.installSkillFromDir(d, opts); } finally { rmSync(d, { recursive: true, force: true }); } };

test('shared items land in their own tree and aggregate; same name may exist in both scopes', () => {
  const mine = install('xlsx', { pkg: 'docs' });
  const shared = install('xlsx', { pkg: 'docs', scope: 'shared' });
  assert.equal(ext.extScope(mine), 'admin');
  assert.equal(shared.scope, 'shared');
  assert.equal(shared.dir, 'shared/skills/xlsx');
  assert.ok(existsSync(path.join(ext.SHARED_ROOT, 'skills', 'xlsx', 'SKILL.md')));
  assert.throws(() => install('xlsx', { scope: 'shared' }), /同名/, '同一范围里照样不许重名');

  const agg = JSON.parse(readFileSync(path.join(extRoot, 'runtime', 'claude-plugin-shared', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(agg.name, 'server');
  assert.ok(existsSync(path.join(extRoot, 'runtime', 'claude-plugin-shared', 'skills', 'xlsx', 'SKILL.md')));
  assert.ok(existsSync(path.join(extRoot, 'runtime', 'claude-plugin', 'skills', 'xlsx', 'SKILL.md')));

  // 替换沿用原范围（传了别的 scope 也不搬家）
  const d = skillDir('xlsx', 'v2');
  try { assert.equal(ext.installSkillFromDir(d, { replaceId: shared.id, scope: 'admin' }).scope, 'shared'); } finally { rmSync(d, { recursive: true, force: true }); }

  assert.deepEqual(ext.listExtensions({ scope: 'shared' }).map((x) => x.id), [shared.id]);
  assert.deepEqual(ext.listExtensions({ scope: 'admin' }).map((x) => x.id), [mine.id]);

  // 包级批量只动自己范围里的同名包
  ext.bulkByPkg('docs', { action: 'disable', scope: 'shared' });
  assert.equal(ext.getExtension(mine.id).enabled, true);
  assert.equal(ext.getExtension(shared.id).enabled, false);
  ext.bulkByPkg('docs', { action: 'delete', scope: 'shared' });
  assert.equal(ext.getExtension(shared.id), null);
  assert.ok(ext.getExtension(mine.id));
});

test('injection: admin gets both scopes, registered users only shared, snapshot visitors nothing', () => {
  install('mine-skill');
  install('team-skill', { scope: 'shared' });
  ext.saveConnector({ name: 'mine-mcp', transport: 'stdio', command: 'node', args: ['a.js'] });
  const sc = ext.saveConnector({ name: 'team-mcp', transport: 'http', url: 'https://example.invalid/mcp', scope: 'shared' });
  assert.equal(sc.scope, 'shared');
  assert.throws(() => ext.saveConnector({ name: 'team-mcp', transport: 'stdio', command: 'x', scope: 'shared' }), /同名/);
  const other = ext.saveConnector({ name: 'team-mcp', transport: 'stdio', command: 'x' });
  assert.notEqual(other.connector.key, sc.connector.key, 'MCP 键全局唯一：管理员会话两边一起注入，不能互相顶掉');

  const admin = ext.claudeExtensionsFor({ kind: 'admin', sandbox: false });
  assert.deepEqual(admin.plugins.map((p) => path.basename(p.path)).sort(), ['claude-plugin', 'claude-plugin-shared']);
  assert.ok(admin.mcpServers['mine-mcp'] && admin.mcpServers['team-mcp']);

  const user = ext.claudeExtensionsFor({ kind: 'user', sandbox: true });
  assert.deepEqual(user.plugins.map((p) => path.basename(p.path)), ['claude-plugin-shared']);
  assert.deepEqual(Object.keys(user.mcpServers), ['team-mcp']);

  for (const ctx of [{ kind: 'snap', sandbox: true }, { kind: 'share', sandbox: true }]) {
    assert.deepEqual(ext.claudeExtensionsFor(ctx), { plugins: [], mcpServers: {} });
  }
  assert.deepEqual(ext.claudeExtensionsFor({ kind: 'user', sandbox: true }, { snap: true }), { plugins: [], mcpServers: {} });
});

test('market "added" marks are per scope', () => {
  const d = skillDir('pdf');
  try { ext.installSkillFromDir(d, { source: { market: 'anthropics/skills', plugin: 'document-skills', path: 'skills/pdf' } }); }
  finally { rmSync(d, { recursive: true, force: true }); }
  assert.deepEqual(installedKeys({ scope: 'admin' }), ['skill:anthropics/skills::skills/pdf']);
  assert.deepEqual(installedKeys({ scope: 'shared' }), []);
});

test('sandbox fence: shared tree is read-only for members, admin-only tree stays closed', async () => {
  const { sharedExtRead, maskSharedRoot, sandboxViolation } = await import('./agents/claude.mjs');
  install('team-skill', { scope: 'shared' });
  install('mine-skill');
  const sharedMd = path.join(ext.SHARED_ROOT, 'skills', 'team-skill', 'SKILL.md');
  const mineMd = path.join(extRoot, 'skills', 'mine-skill', 'SKILL.md');

  assert.equal(sharedExtRead('Read', { file_path: sharedMd }), true);
  assert.equal(sharedExtRead('Grep', { path: path.dirname(sharedMd) }), true);
  assert.equal(sharedExtRead('Write', { file_path: sharedMd }), false, '写不放行');
  assert.equal(sharedExtRead('Edit', { file_path: sharedMd }), false);
  assert.equal(sharedExtRead('Read', { file_path: mineMd }), false, '管理员自用的不放行');
  assert.equal(sharedExtRead('Read', { file_path: path.join(ext.SHARED_ROOT, '..', 'registry.json') }), false, '穿越出去不放行');
  assert.equal(sharedExtRead('Read', { file_path: 'skills/team-skill/SKILL.md' }), false, '相对路径按 cwd 解析，与这棵树无关');

  const cwd = path.join(root, 'users', 'alice');
  mkdirSync(cwd, { recursive: true });
  const run = (cmd) => sandboxViolation('Bash', { command: maskSharedRoot(cmd) }, cwd);
  const dir = path.dirname(sharedMd);
  assert.equal(run(`cd "${dir}" && python scripts/run.py`), null, '去全服技能目录跑脚本');
  assert.equal(run(`cat ${dir.replace(/\\/g, '/')}/SKILL.md`), null, '正斜杠写法');
  assert.notEqual(run(`cat "${path.join(dir, '..', '..', '..', 'registry.json')}"`), null, '借全服目录做 .. 穿越照样拦');
  assert.notEqual(run(`cat "${mineMd}"`), null, '管理员自用的目录照样拦');
  if (process.platform === 'win32') {
    const gitBash = '/' + dir[0].toLowerCase() + dir.slice(2).replace(/\\/g, '/');
    assert.equal(run(`ls ${gitBash}`), null, 'Git Bash 的 /c/… 写法');
  }
});
