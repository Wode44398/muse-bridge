// Claude 分页设置（注册表 + 按身份存储 + 主机级）的契约：缺省取注册表默认、只存显式值、
// 设回默认即删键、rev 单调、admin/shell 门、权限模式按身份与主机安全开关裁剪、分支前缀校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-csettings-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const S = await import('./runtime/claude-settings.mjs');
const { CONFIG_PATH } = await import('./config/index.mjs');
const { branchPrefixError } = await import('./config/claude-settings.mjs');

const admin = { kind: 'admin', key: 'admin', dataDir: path.join(tmp, 'admin'), shell: true };
const user = { kind: 'user', key: 'u:dora', dataDir: path.join(tmp, 'dora'), shell: false, sandbox: true };

test('缺省 = 注册表默认值', () => {
  const v = S.getClaudeSettings(admin);
  assert.equal(v.permissionMode, 'auto');
  assert.equal(v.switchModelsOnFlag, false);
  assert.equal(v.allowBypass, false);
  assert.equal(v.branchPrefix, 'claude');
});

test('只存显式值，设回默认即删键，rev 递增', () => {
  const r1 = S.setClaudeSettings(admin, { outputStyle: 'Concise', switchModelsOnFlag: true });
  assert.equal(r1.changed, true);
  const file = path.join(admin.dataDir, 'claude-settings.json');
  let disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(disk.values, { outputStyle: 'Concise', switchModelsOnFlag: true });
  const rev1 = disk.rev;
  S.setClaudeSettings(admin, { switchModelsOnFlag: false });
  disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(disk.values, { outputStyle: 'Concise' });
  assert.ok(disk.rev > rev1);
  const r3 = S.setClaudeSettings(admin, { outputStyle: 'Concise' });
  assert.equal(r3.changed, false);
});

test('非法值整批不写', () => {
  assert.throws(() => S.setClaudeSettings(admin, { outputStyle: 'Default', autoArchiveDays: 3 }), (e) => e.status === 400);
  assert.equal(S.getClaudeSettings(admin).autoArchiveDays, 0);
  assert.throws(() => S.setClaudeSettings(admin, { nope: 1 }), (e) => e.status === 400);
});

test('主机级与 admin 门', () => {
  assert.throws(() => S.setClaudeSettings(user, { allowBypass: true }), (e) => e.status === 403);
  assert.throws(() => S.setClaudeSettings(user, { followDesktopArchive: false }), (e) => e.status === 403);
  assert.throws(() => S.setClaudeSettings(user, { branchPrefix: 'x' }), (e) => e.status === 403);   // shell 项
  const r = S.setClaudeSettings(admin, { allowBypass: true });
  assert.equal(r.hostChanged, true);
  assert.equal(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).claudeHost.allowBypass, true);
  assert.equal(S.getClaudeSettings(user).allowBypass, true);   // 主机级对所有身份生效
});

test('权限模式裁剪', () => {
  assert.deepEqual(S.permissionModesFor(user), ['default', 'acceptEdits', 'plan']);
  assert.ok(S.permissionModesFor(admin).includes('bypassPermissions'));
  S.setClaudeSettings(admin, { allowBypass: false, allowAutoMode: false });
  assert.deepEqual(S.permissionModesFor(admin), ['default', 'acceptEdits', 'plan']);
  assert.equal(S.defaultPermissionModeFor(admin), 'acceptEdits');   // 默认 auto 不可用 → acceptEdits
  assert.equal(S.defaultPermissionModeFor(user), 'acceptEdits');
  assert.throws(() => S.setClaudeSettings(user, { permissionMode: 'bypassPermissions' }), (e) => e.status === 400);
  S.setClaudeSettings(admin, { allowAutoMode: true });
});

test('分支前缀校验', () => {
  assert.equal(branchPrefixError('claude'), null);
  assert.ok(branchPrefixError('main'));
  assert.ok(branchPrefixError('release-x'));
  assert.ok(branchPrefixError('-bad'));
  assert.ok(branchPrefixError('a'.repeat(41)));
  assert.throws(() => S.setClaudeSettings(admin, { branchPrefix: 'master' }), (e) => e.status === 400);
  S.setClaudeSettings(admin, { branchPrefix: 'wode' });
  assert.equal(S.getClaudeSettings(admin).branchPrefix, 'wode');
});

test('快照访客只读默认', () => {
  const snap = { ...admin, snap: true };
  assert.throws(() => S.setClaudeSettings(snap, { outputStyle: 'Concise' }), (e) => e.status === 403);
  assert.equal(S.getClaudeSettings(snap).outputStyle, 'default');
  assert.ok(!existsSync(path.join(tmp, 'nothing')));
});

test('重启后主机级改动的快照 rev 仍大于重启前（前端缓存的大 rev 不会把它当旧快照丢掉）', async () => {
  S.setClaudeSettings(admin, { keepAwake: false });
  S.setClaudeSettings(admin, { keepAwake: true });
  const before = S.claudeSettingsSnapshot(admin).rev;
  await new Promise((r) => setTimeout(r, 20));
  S._resetClaudeSettingsCache();   // 模拟服务端重启：内存清空，用户 rev 从盘上读回
  const afterBoot = S.claudeSettingsSnapshot(admin).rev;
  assert.ok(afterBoot >= before, `重启后快照 rev ${afterBoot} 不应小于重启前 ${before}`);
  S.setClaudeSettings(admin, { keepAwake: false });
  const afterChange = S.claudeSettingsSnapshot(admin).rev;
  assert.ok(afterChange > before && afterChange > afterBoot);
  // 用户级改动照样让 rev 前进；连续多次主机级改动也不会撞进用户位之外倒退
  S.setClaudeSettings(admin, { outputStyle: 'Explanatory' });
  const u = S.claudeSettingsSnapshot(admin).rev;
  assert.ok(u > afterChange);
  let last = u;
  for (let i = 0; i < 1100; i++) { S.setClaudeSettings(admin, { keepAwake: i % 2 === 0 }); const r = S.claudeSettingsSnapshot(admin).rev; assert.ok(r > last); last = r; }
  S.setClaudeSettings(admin, { keepAwake: null, outputStyle: 'Concise' });
});

test('快照：非管理员拿到的主机级键恒为默认值（服务端判定仍用真实值）', () => {
  S.setClaudeSettings(admin, { keepAwake: false, allowBypass: true });
  const snapU = S.claudeSettingsSnapshot(user);
  assert.equal(snapU.values.keepAwake, true);
  assert.equal(snapU.values.allowBypass, false);
  assert.equal(S.getClaudeSettings(user).allowBypass, true);
  assert.equal(S.claudeSettingsSnapshot(admin).values.keepAwake, false);
  assert.equal(S.claudeSettingsSnapshot(admin).values.allowBypass, true);
  S.setClaudeSettings(admin, { keepAwake: null, allowBypass: null });
});
