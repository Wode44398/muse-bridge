// 号池不被一个人吃光（开源路线 S2-6）的契约：
//   · 策略默认值：新部署补推荐值，老部署（升级前已有账号）补成升级前的行为，并写回 config.json；
//   · 成员的高消耗功能（fast / Ultracode / 1M / 媒体 / 视频）与每人并发、每人定时任务数按策略管，管理员 / 服务账号不受限；
//   · 媒体 / 视频 / 全局助手按次计、按天限额；快照访客的轮记到铸造者头上；服务账号不吃默认额度。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-poolshare-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const users = await import('./users.mjs');
const policy = await import('./runtime/policy.mjs');
const quota = await import('./runtime/quota.mjs');
const { contextFor, userIdentity } = await import('./runtime/identity.mjs');
const { CONFIG_PATH } = await import('./config/index.mjs');

await users.createUser('mona', 'password123', 'user');
await users.createUser('qqbot', 'password123', 'user');
users.setService('qqbot', true);
const ctxOf = (name, extra = {}) => contextFor({ ...userIdentity(name), ...extra });

test('新部署（启动时没有账号）补推荐值，并写回 config.json', () => {
  const p = policy.getPolicy();
  const rec = policy.recommendedPolicy();
  assert.deepEqual(p.quota, rec.quota);
  assert.equal(p.maxParallelPerUser, 2);
  assert.equal(p.maxRoutinesPerUser, 10);
  assert.deepEqual(p.member, { fast: false, ultracode: false, ctx1m: false, media: false, video: false });
  const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).policy;
  assert.deepEqual(saved.member, p.member, '落盘了，以后改代码默认值不会改到这台');
});

test('老部署补齐：升级前的行为（不限、成员全开）；已经写过的项不动', () => {
  const { raw, changed } = policy.fillPolicyDefaults(undefined, { legacy: true });
  assert.equal(changed, true);
  assert.deepEqual(raw.quota, {});
  assert.equal(raw.maxParallelPerUser, 0);
  assert.equal(raw.maxRoutinesPerUser, 0);
  assert.deepEqual(raw.member, { fast: true, ultracode: true, ctx1m: true, media: true, video: true });
  const kept = policy.fillPolicyDefaults({ quota: { dayTurns: 5 }, maxUserTurns: 3, maxParallelPerUser: 1, maxRoutinesPerUser: 4, member: { fast: false, ultracode: true, ctx1m: true, media: true, video: true } }, { legacy: true });
  assert.equal(kept.changed, false);
  assert.deepEqual(kept.raw.quota, { dayTurns: 5 });
  const partial = policy.fillPolicyDefaults({ member: { fast: true } }, { legacy: false, totalMem: 16 * 2 ** 30 });
  assert.equal(partial.raw.member.fast, true, '已有的开关不被推荐值覆盖');
  assert.equal(partial.raw.member.video, false);
  assert.equal(partial.raw.maxUserTurns, 8, '16GB → 8 轮');
  assert.equal(policy.recommendedPolicy(2 * 2 ** 30).maxUserTurns, 2, '小机器至少 2');
});

test('成员规则：没开放的功能关掉；管理员、服务账号、管理员代发不受限（快照见「算谁的账」）', () => {
  policy.setPolicy({ preset: 'recommended' });
  const m = quota.memberRules(ctxOf('mona'));
  assert.equal(m.fast, false); assert.equal(m.ultracode, false); assert.equal(m.ctx1m, false);
  assert.equal(m.maxParallel, 2);
  for (const c of [contextFor({ kind: 'admin' }), ctxOf('qqbot'), ctxOf('mona', { actor: 'admin' })]) {
    const r = quota.memberRules(c);
    assert.equal(r.fast && r.ultracode && r.ctx1m && r.media && r.video, true);
    assert.equal(r.maxParallel, Infinity);
  }
  policy.setPolicy({ member: { fast: true }, maxParallelPerUser: 0 });
  assert.equal(quota.memberRules(ctxOf('mona')).fast, true);
  assert.equal(quota.memberRules(ctxOf('mona')).maxParallel, Infinity, '0 = 不限');
  assert.equal(quota.memberRules(ctxOf('mona')).video, false, '只改了 fast，别的不动');
});

test('每人定时任务上限：成员按策略；管理员不限；0 = 不限', () => {
  policy.setPolicy({ maxRoutinesPerUser: 3 });
  assert.equal(quota.routineCapFor(ctxOf('mona')), 3);
  assert.equal(quota.routineCapFor(contextFor({ kind: 'admin' })), Infinity);
  assert.equal(quota.routineCapFor(ctxOf('qqbot')), Infinity);
  policy.setPolicy({ maxRoutinesPerUser: 0 });
  assert.equal(quota.routineCapFor(ctxOf('mona')), Infinity);
});

test('媒体：成员没开放就拦；开放后按每天次数限；视频单独算；管理员放行不记', () => {
  policy.setPolicy({ member: { media: false, video: false }, quota: { dayMedia: 2, dayVideo: 1 } });
  const mona = ctxOf('mona');
  assert.match(quota.admitUsage(mona, 'media').title, /没有开放/);
  policy.setPolicy({ member: { media: true, video: true } });
  assert.equal(quota.admitUsage(mona, 'media'), null);
  assert.equal(quota.admitUsage(mona, 'media'), null);
  const b = quota.admitUsage(mona, 'media');
  assert.equal(b.title, '今天的额度用完了');
  assert.match(b.message, /2 次图片、语音和音乐/);
  assert.equal(quota.admitUsage(mona, 'video'), null);
  assert.match(quota.admitUsage(mona, 'video').message, /1 条视频/);
  assert.equal(quota.quotaState('mona').today.media, 2, '拦下的不记');
  assert.equal(quota.admitUsage(contextFor({ kind: 'admin' }), 'video'), null);
  assert.equal(quota.admitUsage(ctxOf('mona', { actor: 'admin' }), 'video'), null, '管理员代操作不拦不记');
});

test('服务账号不吃默认额度，单独设了才算；已下线的 dayAssist 老键读时忽略、不再拦', () => {
  policy.setPolicy({ quota: { dayAssist: 1, dayTurns: 1 } });
  assert.deepEqual(policy.getPolicy().quota, { dayTurns: 1 });
  assert.equal(quota.admitUsage(ctxOf('mona'), 'assist'), null);
  assert.equal(quota.admitUsage(ctxOf('mona'), 'assist'), null);
  assert.deepEqual(quota.limitsFor('qqbot'), {}, '服务账号没有默认额度');
  users.setQuota('qqbot', { dayTurns: 7 });
  assert.equal(quota.limitsFor('qqbot').dayTurns, 7);
  users.setQuota('qqbot', null);
});

test('算谁的账：成员本人（含管理员代发）、快照记到铸造者、管理员不记', () => {
  const monaCtx = ctxOf('mona');
  assert.equal(quota.billingUser(monaCtx), monaCtx.user);
  assert.equal(quota.billingUser(ctxOf('mona', { actor: 'admin' })), monaCtx.user);
  assert.equal(quota.billingUser(contextFor({ kind: 'admin' })), null);
  const owners = { tokA: 'u:' + monaCtx.user, tokB: 'admin' };
  quota.setSnapOwnerResolver((t) => owners[t] || '');
  assert.equal(quota.billingUser({ kind: 'snap', snap: { token: 'tokA' } }), monaCtx.user);
  assert.equal(quota.billingUser({ kind: 'snap', snap: { token: 'tokB' } }), null);
  assert.equal(quota.billingUser({ kind: 'snap', snap: { token: 'nope' } }), null);
  assert.equal(quota.userFromOwnerKey('u:nobody'), null);
  // 快照的高消耗功能跟铸造者走：成员铸的按成员开关（不能经快照链接绕开），服务账号与管理员铸的照旧全开
  policy.setPolicy({ member: { fast: false, ultracode: false, ctx1m: false } });
  owners.tokC = 'u:' + ctxOf('qqbot').user;
  const viaMona = quota.memberRules({ kind: 'snap', snap: { token: 'tokA' } });
  assert.equal(viaMona.fast || viaMona.ultracode || viaMona.ctx1m, false);
  assert.equal(viaMona.maxParallel, Infinity, '快照的并发另有通道上限，不按人');
  for (const tok of ['tokB', 'tokC', 'nope']) {
    const r = quota.memberRules({ kind: 'snap', snap: { token: tok } });
    assert.equal(r.fast && r.ultracode && r.ctx1m, true, tok);
  }
});

test('用量窗口带上媒体 / 视频次数；轮数与花费照旧', () => {
  policy.setPolicy({ quota: {} });
  const st = quota.quotaState('mona');
  for (const k of ['turns', 'costUsd', 'tokens', 'media', 'video']) assert.equal(typeof st.today[k], 'number', k);
  assert.equal(typeof st.features.media, 'boolean');
});
