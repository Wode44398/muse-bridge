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
