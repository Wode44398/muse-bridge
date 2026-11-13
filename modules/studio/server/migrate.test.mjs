// 一键导入 Vertex 与首次启动迁移（方案 §3.6）：主机一个服务都没有时自动导一次；重复导入就地更新（幂等）、
// 用户改过的模型开关与名字照留；导入的服务标 shared（成员保持升级前的使用权）；Key 进加密存储；
// 已收编进模型中心的导入服务整项跳过（Key 与清单归模型中心管）。
// 旧视频接口：SSE 的 start.id 就是最终作品 id（旧前端断线后按它去历史里找）。数据根改道到临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-mig-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_NO_AUTH = '';
process.env.BRIDGE_VERTEX_RELAY = '';
process.env.BRIDGE_GEMINI_RELAY = '';
process.env.BRIDGE_MODULES_SKIP = 'codex,dimensio';
for (const k of ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'VERTEX_PROJECT']) delete process.env[k];
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  port: 18996, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'),
  geminiApiKey: 'AIzaTEST-not-a-real-key-000000', openrouterApiKey: 'sk-or-test-000000',
}, null, 2));

await (await import('@bridge/core/modules/registry.mjs')).loadModules();
const P = await import('./providers.mjs');
const M = await import('./migrate.mjs');
const { adapterFor } = await import('./adapters/index.mjs');
const { contextFor } = await import('@bridge/core/runtime/identity.mjs');

test('首次启动：主机没有服务时自动导入能导的（Gemini Key、OpenRouter Key），没配的写原因；有服务了就不再自动导', async () => {
  const r = await M.autoImportIfEmpty();
  const by = Object.fromEntries(r.items.map((x) => [x.id, x]));
  assert.equal(by.gemini.status, 'created');
  assert.equal(by.openrouter.status, 'created');
  assert.equal(by.google.status, 'missing'); assert.match(by.google.reason, /项目/);
  const list = P.listProviders('admin');
  assert.equal(list.length, 2);
  assert.ok(list.every((p) => p.shared && p.importedFrom === 'vertex' && p.hasKey));
  assert.ok(!readFileSync(path.join(tmp, 'studio-providers', 'providers.json'), 'utf8').includes('sk-or-test'), 'Key 不落明文');
  assert.equal(await M.autoImportIfEmpty(), null);
  assert.equal(M.lastImport().items.length, 4);
});

test('重复导入：就地更新、不重复建；用户关掉的模型与改的名字照留', async () => {
  const g = P.listProviders('admin').find((p) => p.preset === 'gemini');
  P.updateProvider(g.id, { name: '我的 Gemini', models: g.models.map((m) => (m.id === 'lyria-3.5' ? { ...m, enabled: false } : m)) }, 'admin');
  const r = await M.importVertex();
  assert.equal(r.items.find((x) => x.id === 'gemini').status, 'updated');
  const after = P.listProviders('admin');
  assert.equal(after.length, 2);
  const g2 = after.find((p) => p.id === g.id);
  assert.equal(g2.name, '我的 Gemini');
  assert.equal(g2.models.find((m) => m.id === 'lyria-3.5').enabled, false);
});

test('收编进模型中心的导入服务：重新导入整项跳过，Key 与模型清单不变、不另建；地址改成中转站后照样认得', async () => {
  const H = await import('./hub-bridge.mjs');
  H._setSchemaRefreshForTests(() => {});   // 不真去刷 schema
  const REF = 'h-000000aa';
  const or = P.listProviders('admin').find((p) => p.preset === 'openrouter' && p.importedFrom === 'vertex');
  H.adopt(or.id, REF);
  // 在模型中心换了 Key、改了清单
  H.upsert({ hubRef: REF, apiKey: 'sk-or-test-111111', models: [{ id: 'some/image-model', kind: 'image' }] });
  const keyNow = () => P.providerSecret(P.getProvider(or.id, 'admin')).key;
  const before = JSON.stringify(P.getProvider(or.id, 'admin').models);
  const count = P.listProviders('admin').length;

  const r = await M.importVertex();
  const it = r.items.find((x) => x.id === 'openrouter');
  assert.equal(it.status, 'skipped'); assert.equal(it.ok, true); assert.equal(it.provider, or.id);
  assert.equal(keyNow(), 'sk-or-test-111111', 'Key 没被改回 config 里的');
  assert.equal(JSON.stringify(P.getProvider(or.id, 'admin').models), before, '内置模型没被合并回来');
  assert.equal(P.getProvider(or.id, 'admin').managedBy, 'hub');
  assert.equal(r.items.find((x) => x.id === 'gemini').status, 'updated', '没收编的照常就地更新');
  assert.equal(P.listProviders('admin').length, count);

  // 模型中心把地址改成中转站（预设变 custom）：按方言认出来，照样跳过，不再建一个 OpenRouter
  H.upsert({ hubRef: REF, baseUrl: 'https://or-relay.example.com/api/v1' });
  assert.equal(P.getProvider(or.id, 'admin').preset, 'custom');
  const r2 = await M.importVertex();
  assert.equal(r2.items.find((x) => x.id === 'openrouter').status, 'skipped');
  assert.equal(P.listProviders('admin').length, count);
  assert.equal(keyNow(), 'sk-or-test-111111');
  H._setSchemaRefreshForTests(null);
});

test('旧视频接口：SSE 的 start.id 就是最终作品 id', async () => {
  const OR = adapterFor('gemini');
  const real = OR.run;
  OR.run = async (req, provider, ctx) => { ctx.submitted(); return { assets: [{ bytes: Buffer.from('00000020667479706d703432', 'hex'), mime: 'video/mp4' }] }; };
  try {
    const { registerMediaRoutes } = await import('./routes/legacy.mjs');
    const h = {};
    registerMediaRoutes({ on: (m, p, fn) => { h[m + ' ' + p] = fn; }, prefix() {} }, { identify: () => ({ kind: 'admin' }) });
    const out = await new Promise((resolve) => {
      const req = Readable.from([Buffer.from(JSON.stringify({ prompt: '纸船', model: 'gemini-omni-1.1-flash', resolution: '360p', durationSeconds: 3 }))]);
      Object.assign(req, { method: 'POST', url: '/api/vertex/video', headers: {} });
      let s = '';
      h['POST /api/vertex/video'](req, { headersSent: false, writableEnded: false, writeHead() { this.headersSent = true; }, setHeader() {}, flushHeaders() {}, write(c) { s += c; return true; }, end(c) { if (c) s += c; this.writableEnded = true; resolve(s); }, on() {}, once() {} }, new URL('http://x/api/vertex/video'));
    });
    const evs = [...out.matchAll(/data: (.*)/g)].map((m) => JSON.parse(m[1]));
    const start = evs.find((e) => e.type === 'start'), done = evs.find((e) => e.type === 'video');
    assert.ok(start && done, out);
    assert.equal(start.model, 'gemini-omni-1.1-flash');
    assert.equal(done.id, start.id);
    assert.equal(done.url, '/api/vertex/media?id=' + start.id);
  } finally { OR.run = real; }
  assert.ok(contextFor({ kind: 'admin' }).allowStudio);
});
