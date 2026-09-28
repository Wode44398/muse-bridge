// 额度与注册策略（三端拆分 P4）的契约：默认不限；默认额度 + 个人覆盖（0 = 不限）；轮数开跑即记、
// 花费收轮再记；「今天」按策略时区换日、「最近 7 天」滚动；注册开关落盘；改密码的自助接口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-quota-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');

const users = await import('./users.mjs');
const { getPolicy, setPolicy, registrationOpen, dayKey } = await import('./runtime/policy.mjs');
const { quotaBlock, limitsFor, quotaState } = await import('./runtime/quota.mjs');
const { registerMeRoutes } = await import('./routes/me.mjs');
const { CONFIG_PATH, FEATURES } = await import('./config/index.mjs');

await users.createUser('dora', 'password123', 'user');
await users.createUser('eve', 'password123', 'user');

test('默认不限；设了每天轮数，开跑即记、到数就拦，文案说清楚何时恢复', () => {
  setPolicy({ quota: {} });
  assert.equal(quotaBlock('dora'), null);
  setPolicy({ quota: { dayTurns: 2 } });
  users.noteTurnStart('dora');
  assert.equal(quotaBlock('dora'), null);
  users.noteTurnStart('dora');
  const b = quotaBlock('dora');
  assert.equal(b.title, '今天的额度用完了');
  assert.match(b.message, /2 轮/);
  assert.match(b.message, /明天 0 点/);
  assert.equal(quotaBlock('eve'), null, '额度按人算');
});

test('个人覆盖：写了的键覆盖默认，0 = 对他不限，null = 全跟默认', () => {
  setPolicy({ quota: { dayTurns: 2 } });
  users.setQuota('dora', { dayTurns: 0 });
  assert.equal(limitsFor('dora').dayTurns, undefined);
  assert.equal(quotaBlock('dora'), null);
  users.setQuota('dora', { dayTurns: 5, weekCostUsd: '' });
  assert.equal(limitsFor('dora').dayTurns, 5);
  assert.equal(users.getUser('dora').quota.weekCostUsd, undefined, '空串 = 没写，跟默认');
  users.setQuota('dora', null);
  assert.equal(users.getUser('dora').quota, undefined);
  assert.equal(limitsFor('dora').dayTurns, 2);
});

test('花费：收轮时记，按美元上限拦', () => {
  setPolicy({ quota: { dayCostUsd: 1 } });
  users.addUsage('eve', { tokens: 1000, costUsd: 0.6 });
  assert.equal(quotaBlock('eve'), null);
  users.addUsage('eve', { tokens: 1000, costUsd: 0.5 });
  assert.match(quotaBlock('eve').message, /\$1\.10/);
  const st = quotaState('eve');
  assert.equal(st.today.tokens, 2000);
  assert.equal(users.getUsage('eve').days, undefined, '累计总账不带分天明细');
});

test('最近 7 天滚动：6 天前的还算、8 天前的不算', (t) => {
  setPolicy({ quota: { weekTurns: 3 } });
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: now - 8 * 86400000 });
  users.noteTurnStart('eve'); users.noteTurnStart('eve');
  t.mock.timers.setTime(now - 6 * 86400000);
  users.noteTurnStart('eve');
  t.mock.timers.setTime(now);
  assert.equal(quotaState('eve').week.turns, 1);
  users.noteTurnStart('eve'); users.noteTurnStart('eve');
  assert.equal(quotaBlock('eve').title, '这 7 天的额度用完了');
});

test('换日看策略时区（默认北京时间）', () => {
  assert.equal(getPolicy().timezone, 'Asia/Shanghai');
  // UTC 2026-09-27 17:00 = 北京 09-28 01:00
  assert.equal(dayKey(Date.UTC(2026, 8, 27, 17, 0)), '2026-09-28');
  assert.equal(setPolicy({ timezone: 'Not/AZone' }).error !== undefined, true);
  setPolicy({ timezone: 'UTC' });
  assert.equal(dayKey(Date.UTC(2026, 8, 27, 17, 0)), '2026-09-27');
  setPolicy({ timezone: 'Asia/Shanghai' });
});

test('注册开关与全服并发上限落盘到 config.json 的 policy 键，其它键不动', () => {
  const before = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  setPolicy({ register: false, maxUserTurns: 6 });
  const after = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(after.policy.register, false);
  assert.equal(after.policy.maxUserTurns, 6);
  assert.equal(after.token, before.token);
  assert.equal(registrationOpen(), false);
  setPolicy({ register: true, maxUserTurns: 0 });
  assert.equal(registrationOpen(), FEATURES.multiUser);
});

function meRoutes(who) {
  const h = {};
  registerMeRoutes({ on: (m, p, fn) => { h[m + ' ' + p] = fn; } }, {
    identify: () => who,
    getCookie: () => '',
    bearerToken: (r) => r.headers.authorization?.slice(7) || '',
  });
  return async (m, p, body, headers = {}) => {
    let code = 0, out = '';
    const listeners = {};
    const req = { headers, on: (ev, fn) => { listeners[ev] = fn; return req; } };
    const res = { writeHead(c) { code = c; }, end(b) { out = b || ''; } };
    const done = h[m + ' ' + p](req, res);
    queueMicrotask(() => { listeners.data?.(Buffer.from(JSON.stringify(body || {}))); listeners.end?.(); });
    await done;
    return { code, json: out ? JSON.parse(out) : null };
  };
}

test('自助：看自己的额度；改密码要原密码，改完别的设备下线、这台保留', async () => {
  const call = meRoutes({ kind: 'user', user: 'dora' });
  const u = await call('GET', '/api/me/usage');
  assert.equal(u.code, 200);
  assert.equal(u.json.unlimited, false);
  assert.ok(u.json.today && u.json.week && u.json.limits);
  assert.equal((await meRoutes({ kind: 'admin' })('GET', '/api/me/usage')).json.unlimited, true);

  const keep = users.createSession('dora');
  const other = users.createSession('dora');
  assert.equal((await call('POST', '/api/me/password', { old: 'wrong-pass', password: 'newpassword1' })).code, 400);
  const ok = await call('POST', '/api/me/password', { old: 'password123', password: 'newpassword1' }, { authorization: 'Bearer ' + keep });
  assert.equal(ok.code, 200);
  assert.equal((await users.checkLogin('dora', 'newpassword1')).ok, true);
  assert.equal(users.getSession(keep)?.user, 'dora');
  assert.equal(users.getSession(other), null);
});
