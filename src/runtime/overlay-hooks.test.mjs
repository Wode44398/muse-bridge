// 私有 overlay 钩子（overlay-hooks.mjs）与号池用量的转交（account-usage.mjs / usage-probe.mjs）：
//   · 按 BRIDGE_OVERLAY_DIR 加载 <overlay>/server/hooks/*.mjs（按文件名顺序；.test.mjs 与非 .mjs 不加载）；
//   · 同名钩子先加载的算数；坏掉的钩子文件只记错误，不拖垮核心；
//   · 有 claudeUsageProbe 时 poolUsage / refreshAccounts / probedInfo / maybeRefreshLimits 全交给它，
//     核心交过去的 core 函数可用（号池带 token 的列表、激活号、写按号分槽、读响应头的 bucket）。
// 钩子是测试里现写的假实现，不碰网络；数据根、overlay 目录都在临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'overlay-hooks-'));
writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  token: 'test-token-0123456789abcdef0123456789',
  claudeAccounts: [{ id: 'a', label: 'A', token: 'tokA' }, { id: 'k', label: 'K', token: 'tokK' }],
  claudeActiveAccount: 'k',
}));
const overlay = path.join(dir, 'private');
const hooksDir = path.join(overlay, 'server', 'hooks');
mkdirSync(hooksDir, { recursive: true });
writeFileSync(path.join(hooksDir, 'a-probe.mjs'), `
export const calls = [];
export const hooks = {
  claudeUsageProbe(core) {
    calls.push(['make', Object.keys(core).sort()]);
    globalThis.__overlayCore = core;
    return {
      async poolUsage(o) { calls.push(['poolUsage', o]); return { k: { five_hour: { pct: 9 }, plan: 'max', error: null, at: 1 } }; },
      async refreshAccounts(ids, maxAge) { calls.push(['refreshAccounts', ids, maxAge]); },
      probedInfo(id) { calls.push(['probedInfo', id]); return { plan: 'pro', error: null, at: 2 }; },
      async maybeRefreshLimits() { calls.push(['maybeRefreshLimits']); return true; },
    };
  },
};
globalThis.__overlayCalls = calls;
`);
writeFileSync(path.join(hooksDir, 'b-broken.mjs'), 'throw new Error("坏掉的钩子");\n');
writeFileSync(path.join(hooksDir, 'c-dup.mjs'), 'export const hooks = { claudeUsageProbe: () => { throw new Error("不该用到"); }, other: 1 };\n');
writeFileSync(path.join(hooksDir, 'd.test.mjs'), 'throw new Error("测试文件不该被加载");\n');
writeFileSync(path.join(hooksDir, 'notes.txt'), 'not code');

const saved = Object.fromEntries(['BRIDGE_DATA_ROOT', 'BRIDGE_OVERLAY_DIR'].map((k) => [k, process.env[k]]));
process.env.BRIDGE_DATA_ROOT = dir;
process.env.BRIDGE_OVERLAY_DIR = overlay;

const { overlayHook, overlayStatus } = await import('./overlay-hooks.mjs');
const { poolUsage, refreshAccounts, probedInfo } = await import('./account-usage.mjs');
const { maybeRefreshLimits } = await import('./usage-probe.mjs');
const { accountLimits } = await import('./status.mjs');

test.after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

test('按文件名顺序加载钩子；同名先到先得；坏文件只记错误；测试文件与非 .mjs 不加载', () => {
  const st = overlayStatus();
  assert.equal(st.dir, overlay);
  assert.deepEqual(st.loaded.map((x) => [path.basename(x.file), x.names]), [['a-probe.mjs', ['claudeUsageProbe']], ['c-dup.mjs', ['other']]]);
  assert.deepEqual(st.errors.map((x) => path.basename(x.file)), ['b-broken.mjs']);
  assert.equal(typeof overlayHook('claudeUsageProbe'), 'function');
  assert.equal(overlayHook('nope'), null);
});

test('号池用量与手机额度环全交给 overlay 用量来源，参数原样转交', async () => {
  const calls = globalThis.__overlayCalls;
  assert.deepEqual(await poolUsage({ force: true }), { k: { five_hour: { pct: 9 }, plan: 'max', error: null, at: 1 } });
  await refreshAccounts(['a'], 1234);
  assert.deepEqual(probedInfo('a'), { plan: 'pro', error: null, at: 2 });
  assert.equal(await maybeRefreshLimits(), true);
  assert.deepEqual(calls.map((c) => c[0]), ['make', 'poolUsage', 'refreshAccounts', 'probedInfo', 'maybeRefreshLimits']);   // 只造一次
  assert.deepEqual(calls[0][1], ['activeAccountId', 'activeToken', 'applyProbedLimits', 'bucket', 'listAccountsWithTokens', 'loginToken', 'oauthToken']);
  assert.deepEqual(calls[1][1], { force: true });
  assert.deepEqual(calls[2].slice(1), [['a'], 1234]);
});

test('交给用量来源的 core 函数可用', () => {
  const core = globalThis.__overlayCore;
  assert.deepEqual(core.listAccountsWithTokens(), [{ id: 'a', token: 'tokA' }, { id: 'k', token: 'tokK' }]);
  assert.equal(core.activeAccountId(), 'k');
  assert.equal(core.activeToken(), 'tokK');
  const h = (k) => ({ '5h-utilization': '0.25', '5h-reset': '2000000000', '5h-status': 'allowed' })[k] ?? null;
  assert.deepEqual(core.bucket(h, '5h'), { status: 'allowed', pct: 25, resetsAt: 2000000000000 });
  core.applyProbedLimits({ five_hour: core.bucket(h, '5h') }, 'a');
  assert.equal(accountLimits('a').five_hour.pct, 25);
});
