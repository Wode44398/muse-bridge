// studio_config.* 操作（ops/studio-config.mjs）：模型中心的开关关着时整组 forbidden；开着时看 / 写 / 预演 / 试跑走真的 /api/studio/* 路由；
// 托管服务还没有的模型先在模型中心加好再写配置。上游一律 mock 全局 fetch。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-cfg-ops-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'codex,dimensio';
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 18995, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'), features: { multiUser: true } }, null, 2));

await (await import('../modules/registry.mjs')).loadModules();
const { INTERNAL_IDENTITY, contextFor } = await import('../runtime/identity.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { setInternalRouter } = await import('./internal.mjs');
const { callOp, getOp, catalog, OpError } = await import('./registry.mjs');
await import('./ops/index.mjs');
const S = await import('./ops/studio.mjs');
const { registerStudioApi } = await import('../../modules/studio/server/routes/api.mjs');
const P = await import('../../modules/studio/server/providers.mjs');
const H = await import('../runtime/model-hub/registry.mjs');
const { RECIPE_EXAMPLES } = await import('../../modules/studio/server/recipe/examples.mjs');

const identify = (req) => req[INTERNAL_IDENTITY] || { kind: 'none' };
const router = createRouter();
registerStudioApi(router, { identify });
setInternalRouter(router);
H._resetHubForTests(path.join(tmp, 'model-hub'));

const adminId = { kind: 'admin', user: null };
const admin = contextFor(adminId);
const env = { via: 'http', identity: adminId, origin: 'https://bridge.test' };
const run = (op, args = {}) => callOp(admin, op, args, env);
const code = async (p) => { try { await p; return 'ok'; } catch (e) { assert.ok(e instanceof OpError, String(e && e.stack)); return e.code + ':' + e.message; } };
S.studioPoll.ms = 10;

const KEY = 'sk-relay-ops-0123456789';
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(String(url), init);
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const prov = P.createProvider({ name: '中转', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://relay.example/v1', apiKey: KEY, autoSync: false, models: [{ id: 'gpt-image-2', kind: 'image' }] }, 'admin');
const NAMES = ['studio_config.get', 'studio_config.set', 'studio_config.preview', 'studio_config.trial'];

test('登记：四个操作在、都要 agent:studio；写入与试跑是 danger，看与预演只读', () => {
  for (const n of NAMES) assert.ok(getOp(n)?.need.includes('agent:studio'), n);
  assert.deepEqual(NAMES.map((n) => getOp(n).access), ['read', 'danger', 'read', 'danger']);
  assert.equal(getOp('studio_config.trial').slow, true);
});

test('开关关着（默认）：整组 forbidden，并告诉 agent 请用户去模型中心打开；目录里标不可用', async () => {
  assert.equal(H.hubPrefs().agentMediaConfig, false);
  for (const n of NAMES) assert.match(await code(run(n, { model: `${prov.id}/gpt-image-2`, over: null })), /^forbidden:.*模型中心/);
  assert.ok(catalog(admin).filter((o) => o.group === 'studio_config').every((o) => !o.available));
  assert.throws(() => H.setHubPrefs({ nope: true }), /没有这个开关/);
});

test('开着：看配置（没配方时带示例）→ 预演 → 写覆盖与配方 → 试跑带 trace，记录里没有 Key', async () => {
  H.setHubPrefs({ agentMediaConfig: true });
  const key = `${prov.id}/gpt-image-2`;
  const g = await run('studio_config.get', { model: key });
  assert.equal(g.config.exists, true);
  assert.ok(g.config.examples.length >= 3);
  assert.match(await code(run('studio_config.set', { model: key })), /^bad_args/);
  const recipe = RECIPE_EXAMPLES.find((x) => x.id === 'sync-image').recipe;
  const pv = await run('studio_config.preview', { model: key, recipe, prompt: '猫', params: { quality: 'low' } });
  assert.equal(pv.request.submit.url, 'https://relay.example/v1/images/generations');
  assert.equal(pv.params.quality, 'low');
  assert.ok(!JSON.stringify(pv).includes(KEY));
  const s = await run('studio_config.set', { model: key, recipe, over: { defaults: { quality: 'medium' } } });
  assert.equal(s.config.effective.paramSource, 'recipe');
  assert.equal(s.config.examples, undefined, '写入的回执不带示例');
  await withFetch(() => jsonRes({ data: [{ b64_json: PNG.toString('base64') }], echo: KEY }), async () => {
    const t = await run('studio_config.trial', { model: key, prompt: '猫' });
    assert.equal(t.state, 'done', t.error);
    assert.equal(t.trace[0].step, '提交');
    assert.equal(JSON.parse(t.trace[0].request.body).quality, 'medium');
    assert.equal(t.results.length, 1);
    assert.ok(!JSON.stringify(t).includes(KEY));
  });
});

test('托管服务还没有这个模型：set 走模型中心去加，不绕过它直接往 Studio 里加', async () => {
  H.setHubPrefs({ agentMediaConfig: true });
  // 直接在 Studio 注册表里打托管标（真的托管要整套模型中心同步）
  const hubbed = P.createProvider({ name: '托管', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://hub.example/v1', models: [] }, 'admin');
  const rec = P.getProvider(hubbed.id, 'admin');
  rec.managedBy = 'hub'; rec.hubRef = 'h-0000beef';
  const r = await code(run('studio_config.set', { model: `${hubbed.id}/vid-x`, kind: 'video', recipe: RECIPE_EXAMPLES[0].recipe }));
  // 模型中心里没有 h-0000beef 这个服务：照实报「在模型中心添加没成」，不会绕过去直接在 Studio 加
  assert.match(r, /^failed:在模型中心添加这个模型没成/);
  assert.equal(P.getProvider(hubbed.id, 'admin').models.length, 0);
});
