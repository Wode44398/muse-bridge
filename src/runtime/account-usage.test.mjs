// 号池逐号用量（account-usage.mjs）——公开版（没有 overlay）：
//   · 一个请求都不往上游打：逐号用量 = 各号「上次使用时」的数据（status.mjs 按号分槽），带 source:'last-use'；
//   · 已过重置点的桶不显示；套餐名取 SDK usage 记下的（小写）；
//   · 智能路由的核实（refreshAccounts）什么都不做、用量来源结论（probedInfo）恒为 null；手机额度环的刷新回 false；
//   · 留空 token 的号（本机登录态）按 CLAUDE_CONFIG_DIR 找 .credentials.json（上游代理用）。
// 配了 overlay 用量来源时全交给它，见 overlay-hooks.test.mjs。数据根、登录目录都在临时目录，上游是本地假 Anthropic。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'account-usage-'));
const cfgDir = path.join(dir, 'claude-home');
mkdirSync(cfgDir, { recursive: true });
writeFileSync(path.join(cfgDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'login-tok' } }));
writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  token: 'test-token-0123456789abcdef0123456789',
  claudeAccounts: [{ id: 'login', label: '本机登录', token: '' }, { id: 'k', label: 'K', token: 'tokK' }],
  claudeActiveAccount: 'k',
}));
const saved = Object.fromEntries(['BRIDGE_DATA_ROOT', 'CLAUDE_CONFIG_DIR', 'BRIDGE_NO_AUTH', 'BRIDGE_USAGE_PROBE', 'BRIDGE_CLAUDE_UPSTREAM', 'BRIDGE_OVERLAY_DIR'].map((k) => [k, process.env[k]]));
process.env.BRIDGE_DATA_ROOT = dir;
process.env.CLAUDE_CONFIG_DIR = cfgDir;
process.env.BRIDGE_USAGE_PROBE = '1';   // 早已废弃的开关；公开版不该理它
delete process.env.BRIDGE_OVERLAY_DIR;
delete process.env.ANTHROPIC_BASE_URL;

const seen = [];
const fake = http.createServer(async (req, res) => {
  for await (const _ of req);
  seen.push(req.url);
  res.writeHead(200, { 'anthropic-ratelimit-unified-5h-utilization': '0.2' });
  res.end('{}');
});
await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
process.env.BRIDGE_CLAUDE_UPSTREAM = `http://127.0.0.1:${fake.address().port}`;

const { loginToken, poolUsage, probedInfo, refreshAccounts, overlayUsageProbe } = await import('./account-usage.mjs');
const { maybeRefreshLimits } = await import('./usage-probe.mjs');
const { applyProbedLimits, applySdkUsage } = await import('./status.mjs');
const { overlayStatus } = await import('./overlay-hooks.mjs');

test.after(() => {
  fake.close(); fake.closeAllConnections();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

test('没有 overlay：不加载任何钩子', () => {
  assert.equal(overlayStatus().dir, null);
  assert.equal(overlayUsageProbe(), null);
});

test('本机登录态按 CLAUDE_CONFIG_DIR 找凭据', () => {
  assert.equal(loginToken(), 'login-tok');
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'nowhere');
  try { assert.equal(loginToken(), ''); } finally { process.env.CLAUDE_CONFIG_DIR = cfgDir; }
});

test('逐号用量 = 上次使用时的数据，不打上游；过了重置点的桶不显示', async () => {
  const later = Date.now() + 3600_000;
  applyProbedLimits({ five_hour: { pct: 42, resetsAt: later }, seven_day: { pct: 7, resetsAt: Date.now() - 1000 }, seven_day_overage_included: { pct: 3, resetsAt: later } }, 'k');
  applySdkUsage({ subscription_type: 'max', rate_limits: {} }, 'k');
  seen.length = 0;
  const u = await poolUsage({ force: true });
  assert.equal(seen.length, 0);
  assert.deepEqual(Object.keys(u).sort(), ['k', 'login']);
  assert.equal(u.k.source, 'last-use');
  assert.equal(u.k.five_hour.pct, 42);
  assert.equal(u.k.seven_day, null);
  assert.equal(u.k.fable.pct, 3);
  assert.equal(u.k.plan, 'max');
  assert.equal(u.k.error, null);
  assert.ok(u.k.at > 0);
  // 还没用过的号：全空、没有错误（界面显示「—」，不是红字）
  assert.deepEqual({ ...u.login, at: 0 }, { five_hour: null, seven_day: null, fable: null, plan: null, error: null, at: 0, source: 'last-use' });
});

test('智能路由核实 / 探针结论 / 手机额度环：公开版都不发请求', async () => {
  seen.length = 0;
  await refreshAccounts(['k', 'login']);
  assert.equal(probedInfo('k'), null);
  assert.equal(await maybeRefreshLimits(), false);
  assert.equal(seen.length, 0);
});

// 2026-11：Ultra 订阅（原 Max 20x），部分 Ultra 没有 5 小时限额——权威来源只给周桶。
test('没有 5 小时限额的号：清掉残留 five_hour、标 no_five_hour、套餐推断为 Ultra；再见到 5 小时桶就复位', async () => {
  const { noteFiveHourPresence, accountNoFiveHour, accountPlan, applyRateLimit } = await import('./status.mjs');
  const later = Date.now() + 3600_000;
  applyProbedLimits({ five_hour: { pct: 10, resetsAt: later }, seven_day: { pct: 20, resetsAt: later } }, 'login');
  // 响应头只有 7d
  applyProbedLimits({ seven_day: { pct: 21, resetsAt: later } }, 'login');
  noteFiveHourPresence('login', false, true);
  let u = (await poolUsage()).login;
  assert.equal(u.five_hour, null);
  assert.equal(u.no_five_hour, true);
  assert.equal(u.seven_day.pct, 21);
  assert.equal(u.plan, 'ultra');
  // 一次什么都没拿到（失败）不冲掉标记
  noteFiveHourPresence('login', false, false);
  assert.equal(accountNoFiveHour('login'), true);
  // SDK 报 subscription_type 'ultra' 直接用；报 'max' 但没 5 小时桶也算 Ultra
  applySdkUsage({ subscription_type: 'max', rate_limits: { five_hour: null, seven_day: { utilization: 22, resets_at: new Date(later).toISOString() } } }, 'login');
  assert.equal(accountPlan('login'), 'ultra');
  // 事件帧带回 five_hour → 复位，套餐回到服务端给的 max（分不出 5x / 20x）
  applyRateLimit({ rateLimitType: 'seven_day', status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.05, resetsAt: later / 1000 }, seven_day: { utilization: 0.22, resetsAt: later / 1000 } } }, 'login');
  assert.equal(accountNoFiveHour('login'), false);
  assert.equal(accountPlan('login'), 'max');
  u = (await poolUsage()).login;
  assert.equal(u.five_hour.pct, 5);
  assert.equal(u.no_five_hour, undefined);
  // 事件帧只有周桶 → 再次置位
  applyRateLimit({ rateLimitType: 'seven_day', status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.23, resetsAt: later / 1000 } } }, 'login');
  assert.equal(accountNoFiveHour('login'), true);
  assert.equal(accountLimitsOf('login').five_hour, undefined);
  applySdkUsage({ subscription_type: 'ultra', rate_limits: {} }, 'login');
  assert.equal(accountPlan('login'), 'ultra');
});
async function accountLimitsOfImpl() { return (await import('./status.mjs')).accountLimits; }
const accountLimitsOf = await accountLimitsOfImpl();

// 2026-11-09：Pro 体验 Fable 会带 Fable 周桶，不能再当 Max 的证据；Max 5x 与 Ultra（原 Max 20x）要分开。
test('套餐定档：手动标的 > 本机登录凭据 > 权威 tier > SDK；upgrade-paths 到顶 = Ultra；Fable 桶不定档', async () => {
  const S = await import('./status.mjs');
  const A = await import('./claude-account.mjs');
  assert.equal(S.planFromTier('max', 'default_claude_max_5x'), 'max5x');
  assert.equal(S.planFromTier('max', 'default_claude_max_20x'), 'ultra');
  assert.equal(S.planFromTier('claude_max', 'default_claude_max_20x'), 'ultra');
  assert.equal(S.planFromTier('pro', 'default_claude_ai'), 'pro');
  assert.equal(S.planFromTier('max', ''), null);
  const later = Date.now() + 3600_000;
  // k：有 Fable 桶、有 5 小时桶、SDK 没报套餐 → 不定档（以前会被当成 Max）
  applySdkUsage({ subscription_type: null, rate_limits: {} }, 'k');
  applyProbedLimits({ five_hour: { pct: 1, resetsAt: later }, seven_day: { pct: 1, resetsAt: later }, seven_day_overage_included: { pct: 1, resetsAt: later } }, 'k');
  assert.equal(S.accountPlan('k'), null);
  // upgrade-paths 只有 overage（不能再升档）= Ultra；看到 upgrade_plan 复位
  S.noteUpgradePaths('k', 'overage');
  assert.equal(S.accountPlan('k'), 'ultra');
  S.noteUpgradePaths('k', ['upgrade_plan', 'overage']);
  assert.equal(S.accountPlan('k'), null);
  // 权威 tier
  S.notePlanTier('k', 'max5x');
  assert.equal(S.accountPlan('k'), 'max5x');
  assert.equal((await poolUsage()).k.plan, 'max5x');
  // 手动标的最优先；'' 改回自动
  assert.equal(A.updateAccount('k', { plan: 'pro' }).ok, true);
  assert.equal(S.accountPlan('k'), 'pro');
  assert.equal(A.listAccounts().find((a) => a.id === 'k').plan, 'pro');
  A.updateAccount('k', { label: '只改名' });
  assert.equal(S.accountPlan('k'), 'pro');   // 不带 plan 不动
  A.updateAccount('k', { plan: '' });
  assert.equal(S.accountPlan('k'), 'max5x');
  // 本机登录态的号看凭据的 rateLimitTier（有 5 小时限额的 20x 也叫 Ultra）
  writeFileSync(path.join(cfgDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'login-tok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }));
  assert.equal(S.accountPlan('login'), 'max5x');
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(path.join(cfgDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'login-tok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
  assert.equal(S.accountPlan('login'), 'ultra');
  A.setActive('login');
  assert.equal(S.statusState.plan, 'Ultra');
  A.setActive('k');
  assert.equal(S.statusState.plan, 'Max 5x');
});
