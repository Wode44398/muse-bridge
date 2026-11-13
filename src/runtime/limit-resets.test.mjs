// 重置卡（limit-resets.mjs）：
//   · 公开版（没有 overlay）：available:false、一个请求都不发，使用 / 登录动作回「不支持」；
//   · 配了 overlay 钩子 claudeLimitResets：核心把号池、登录凭据的读写、本机登录态、CLI 版本交给它；
//     使用成功后把清掉的额度桶按新读数记回按号分槽、撤掉智能路由给这个号记的冷却；
//   · 号的完整登录凭据（login 字段）落在 config.json、不出现在 listAccounts 里；换了推理令牌就清掉。
// 数据根在临时目录；钩子是测试里现写的假实现，不碰网络。两种形态各起一个子进程（overlay 目录在模块加载时定死）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = (rel) => JSON.stringify(pathToFileURL(path.join(HERE, rel)).href);

function run(script, { overlay = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'limit-resets-'));
  try {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      token: 'test-token-0123456789abcdef0123456789',
      claudeAccounts: [{ id: 'k', label: 'K', token: 'tokK' }, { id: 'p', label: 'P', token: 'tokP' }],
      claudeActiveAccount: 'k',
    }));
    const env = { ...process.env, BRIDGE_DATA_ROOT: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude-home') };
    for (const k of ['BRIDGE_OVERLAY_DIR', 'BRIDGE_NO_AUTH', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
    if (overlay) {
      const hooks = path.join(dir, 'ov', 'server', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(path.join(hooks, 'resets.mjs'), `
        export const hooks = { claudeLimitResets: (core) => ({
          overview: async ({ only }) => Object.fromEntries(core.listAccountsWithTokens().filter((a) => !only || a.id === only).map((a) => [a.id, { needLogin: !core.accountLogin(a.id), cli: core.cliVersion(), local: core.localLogin() }])),
          use: async (id, grantId) => grantId === 'g1' ? { ok: true, cleared: ['five_hour', 'seven_day'], left: 0, percentUsed: { five_hour: 0, seven_day: 3 } } : { error: '没有这张重置卡，刷新后再看' },
          loginStart: (id) => ({ ok: true, url: 'https://example.invalid/login?' + id }),
          loginFinish: (id, code) => { core.setAccountLogin(id, { accessToken: 'secret-access', refreshToken: 'secret-refresh', email: 'k@example.com' }); return { ok: true, email: 'k@example.com' }; },
          loginClear: (id) => core.setAccountLogin(id, null),
        }) };`);
      env.BRIDGE_OVERLAY_DIR = path.join(dir, 'ov');
    }
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

test('公开版：没有重置卡能力，动作回「不支持」', () => {
  const out = run(`
    const r = await import(${mod('limit-resets.mjs')});
    console.log(JSON.stringify({ avail: r.resetsAvailable(), over: await r.resetsOverview(), use: await r.useReset('k', 'g1'), start: await r.resetsLoginStart('k') }));
  `);
  assert.equal(out.avail, false);
  assert.deepEqual(out.over, { available: false, accounts: {} });
  assert.match(out.use.error, /不支持/);
  assert.match(out.start.error, /不支持/);
});

test('配了钩子：登录凭据落盘不外泄；使用成功后额度桶与冷却更新；换令牌清登录', () => {
  const out = run(`
    const r = await import(${mod('limit-resets.mjs')});
    const acc = await import(${mod('claude-account.mjs')});
    const st = await import(${mod('status.mjs')});
    const router = await import(${mod('account-router.mjs')});
    const { readFileSync } = await import('node:fs');
    const saved = () => JSON.parse(readFileSync(process.env.BRIDGE_DATA_ROOT + '/config.json', 'utf8')).claudeAccounts;
    const o = { avail: r.resetsAvailable() };
    o.before = (await r.resetsOverview()).accounts;
    o.start = await r.resetsLoginStart('k');
    o.finish = await r.resetsLoginFinish('k', 'code');
    o.savedLogin = saved().find((a) => a.id === 'k').login;
    o.listed = JSON.stringify(acc.listAccounts());
    o.after = (await r.resetsOverview({ only: 'k' })).accounts;
    st.applyProbedLimits({ five_hour: { status: 'rejected', pct: 100, resetsAt: Date.now() + 3600000 }, seven_day: { pct: 40, resetsAt: Date.now() + 86400000 }, seven_day_opus: { pct: 9, resetsAt: Date.now() + 86400000 } }, 'k');
    await router.noteLimitHit('k', { type: 'five_hour', resetsAt: Date.now() + 3600000 });
    o.blockedBefore = !!router.routerStatus().blocks.k;
    o.bad = await r.useReset('k', 'nope');
    o.limAfterBad = st.accountLimits('k').five_hour.pct;
    o.use = await r.useReset('k', 'g1');
    o.lim = st.accountLimits('k');
    o.blockedAfter = !!router.routerStatus().blocks.k;
    acc.updateAccount('k', { token: 'tokK' });
    o.keptOnSameToken = !!saved().find((a) => a.id === 'k').login;
    acc.updateAccount('k', { token: 'tokK-new' });
    o.clearedOnNewToken = saved().find((a) => a.id === 'k').login === undefined;
    console.log(JSON.stringify(o));
  `, { overlay: true });
  assert.equal(out.avail, true);
  assert.equal(out.before.k.needLogin, true);
  assert.match(out.before.k.cli, /^\d+\.\d+\.\d+$/, '核心把随 SDK 带的 CLI 版本交给钩子');
  assert.equal(out.before.k.local, null, '没有本机登录凭据');
  assert.equal(out.start.ok, true);
  assert.deepEqual(out.finish, { ok: true, email: 'k@example.com' });
  assert.equal(out.savedLogin.refreshToken, 'secret-refresh');
  assert.ok(!out.listed.includes('secret'), 'listAccounts 不外泄登录凭据');
  assert.deepEqual(Object.keys(out.after), ['k']);
  assert.equal(out.after.k.needLogin, false);
  assert.match(out.bad.error, /没有这张/);
  assert.equal(out.limAfterBad, 100, '没用成不动额度桶');
  assert.equal(out.use.ok, true);
  assert.equal(out.lim.five_hour.pct, 0);
  assert.equal(out.lim.five_hour.status, 'allowed');
  assert.equal(out.lim.seven_day.pct, 3);
  assert.equal(out.lim.seven_day_opus.pct, 9, '没被清的桶不动');
  assert.equal(out.blockedAfter, false, '撤掉智能路由的冷却');
  assert.equal(out.keptOnSameToken, true);
  assert.equal(out.clearedOnNewToken, true);
});
