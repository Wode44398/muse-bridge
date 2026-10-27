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

// —— 这台机器做不到的项（Muse 同步第 22 条）：按平台与 Desktop 数据目录算，前端据此隐藏 ——
const { unsupportedClaudeSettings, claudeSettingVisible } = await import('./config/claude-settings.mjs');

test('unsupportedClaudeSettings：保持唤醒做不到两项一起藏，找不到 Desktop 就没有跟随归档', () => {
  assert.deepEqual(unsupportedClaudeSettings({ keepAwake: true, desktop: true }), []);
  assert.deepEqual(unsupportedClaudeSettings({ keepAwake: true, desktop: false }), ['followDesktopArchive']);
  assert.deepEqual(unsupportedClaudeSettings({ keepAwake: false, desktop: false }), ['keepAwake', 'keepAwakeOnBattery', 'followDesktopArchive']);
  assert.deepEqual(unsupportedClaudeSettings({ keepAwake: false, desktop: true }), ['keepAwake', 'keepAwakeOnBattery']);
});

test('快照带 unsupported：保持唤醒插件没挂能力 = 做不到；挂了按它现算', () => {
  try {
    S._setClaudeHostProbe(() => ({ keepAwake: false, desktop: false }));   // Linux 服务器（Muse VM）
    assert.deepEqual(S.claudeSettingsSnapshot(admin).unsupported, ['keepAwake', 'keepAwakeOnBattery', 'followDesktopArchive']);
    assert.deepEqual(S.claudeSettingsSnapshot(user).unsupported, ['keepAwake', 'keepAwakeOnBattery', 'followDesktopArchive']);
    S._setClaudeHostProbe(() => ({ keepAwake: true, desktop: true }));     // 装了 Desktop 的 Windows 主机
    assert.deepEqual(S.claudeSettingsSnapshot(admin).unsupported, []);
    S._setClaudeHostProbe(() => { throw new Error('boom'); });             // 探针出错：保守按做不到算，不抛
    assert.ok(S.claudeSettingsSnapshot(admin).unsupported.includes('followDesktopArchive'));
    // 默认探针：保持唤醒能力由插件经 setKeepAwakeCapability 挂上
    S._setClaudeHostProbe(null);
    S.setKeepAwakeCapability(null);
    assert.ok(S.claudeSettingsSnapshot(admin).unsupported.includes('keepAwake'));
    S.setKeepAwakeCapability(() => true);
    assert.ok(!S.claudeSettingsSnapshot(admin).unsupported.includes('keepAwake'));
  } finally {
    S._setClaudeHostProbe(null);
    S.setKeepAwakeCapability(null);
  }
});

test('claudeSettingVisible（前端 visible() 的规则）：unsupported 里的不出，老服务端不给 unsupported = 照旧', () => {
  const base = { admin: true, shell: true, val: (k) => (k === 'keepAwake' ? true : undefined) };
  for (const k of ['keepAwake', 'keepAwakeOnBattery', 'followDesktopArchive', 'crossSessionInbound']) assert.equal(claudeSettingVisible(k, base), true, k);
  const linux = { ...base, unsupported: ['keepAwake', 'keepAwakeOnBattery', 'followDesktopArchive'] };
  assert.equal(claudeSettingVisible('keepAwake', linux), false);
  assert.equal(claudeSettingVisible('keepAwakeOnBattery', linux), false);
  assert.equal(claudeSettingVisible('followDesktopArchive', linux), false);
  assert.equal(claudeSettingVisible('crossSessionInbound', linux), true);
  // 原有门照旧：非管理员看不到主机项 / 管理员项，没 shell 看不到 shell 项，主项关着依赖项不出，不认识的键不出
  assert.equal(claudeSettingVisible('keepAwake', { ...base, admin: false }), false);
  assert.equal(claudeSettingVisible('branchPrefix', { ...base, shell: false }), false);
  assert.equal(claudeSettingVisible('keepAwakeOnBattery', { ...base, val: () => false }), false);
  assert.equal(claudeSettingVisible('nope', base), false);
});
