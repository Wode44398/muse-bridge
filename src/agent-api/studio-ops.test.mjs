// studio.* 操作（ops/studio.mjs）：登记齐全、参数校验、studio.models 的紧凑化、studio.generate 的 source / 自动存储处理、
// 服务的密钥不外泄、同机实例与 设置 › Media Studio 的放行。经进程内请求走真的 /api/studio/* 路由；上游一律不打（适配器的 run 换成假的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-ops-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_NO_AUTH = '';
process.env.BRIDGE_VERTEX_RELAY = '';
process.env.BRIDGE_MODULES_SKIP = 'codex,dimensio';
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  port: 18996, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'), features: { multiUser: true },
}, null, 2));

await (await import('../modules/registry.mjs')).loadModules();
const { INTERNAL_IDENTITY, contextFor } = await import('../runtime/identity.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { setInternalRouter } = await import('./internal.mjs');
const { callOp, allOps, getOp, catalog, OpError } = await import('./registry.mjs');
await import('./ops/index.mjs');
const S = await import('./ops/studio.mjs');
const { registerStudioApi } = await import('../../modules/studio/server/routes/api.mjs');
const P = await import('../../modules/studio/server/providers.mjs');
const { adapterFor } = await import('../../modules/studio/server/adapters/index.mjs');
const media = await import('../vertex-media.mjs');
const settings = await import('../runtime/studio-settings.mjs');

// 进程内请求认 Symbol 上的身份；带 x-test-admin 头的假「网络请求」也当管理员（用来验证外面带 source:'api' 不起作用）
const identify = (req) => req[INTERNAL_IDENTITY] || (req.headers?.['x-test-admin'] ? { kind: 'admin', user: null } : { kind: 'none' });
const router = createRouter();
registerStudioApi(router, { identify });
setInternalRouter(router);

const adminId = { kind: 'admin', user: null };
const admin = contextFor(adminId);
const env = { via: 'http', identity: adminId, origin: 'https://bridge.test' };
const run = (op, args = {}, ctx = admin) => callOp(ctx, op, args, env);
const code = async (p) => { try { await p; return 'ok'; } catch (e) { assert.ok(e instanceof OpError, String(e && e.stack)); return e.code; } };

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const OR = adapterFor('openrouter');
const realRun = OR.run;
let runs = 0;
OR.run = async () => { runs++; return { assets: [{ bytes: PNG, mime: 'image/png' }] }; };
test.after(() => { OR.run = realRun; });
S.studioPoll.ms = 20;

const SECRET = 'sk-or-secret-abcdef-7788';
const HEADER_SECRET = 'tok-header-secret-999';
const prov = P.createProvider({
  preset: 'openrouter', dialect: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: SECRET, autoSync: false,
  headers: { 'X-Relay-Token': HEADER_SECRET }, params: { relay_secret: HEADER_SECRET },
  models: [{ id: 'openai/gpt-image-2.5-sunburst', kind: 'image', source: 'builtin' }],
}, 'admin');
const KEY = prov.id + '/openai/gpt-image-2.5-sunburst';

const NAMES = ['studio.models', 'studio.jobs', 'studio.job', 'studio.assets', 'studio.asset', 'studio.providers', 'studio.provider_log', 'studio.my_settings',
  'studio.generate', 'studio.job_cancel', 'studio.asset_save', 'studio.asset_delete', 'studio.my_settings_set',
  'studio.provider_create', 'studio.provider_update', 'studio.provider_delete', 'studio.provider_test', 'studio.provider_models', 'studio.provider_sync', 'studio.import_vertex'];

test('登记：全部操作都在、都要 agent:studio、权限档对、排在 media 组后面；参数类型都是注册表认的', () => {
  for (const n of NAMES) {
    const op = getOp(n);
    assert.ok(op, n);
    assert.equal(op.group, 'studio');
    assert.ok(op.need.includes('agent:studio'), n);
    for (const [k, s] of Object.entries(op.params)) assert.ok(['string', 'integer', 'number', 'boolean', 'object', 'array', 'any'].includes(s.type), `${n}.${k}`);
  }
  for (const n of ['studio.models', 'studio.jobs', 'studio.job', 'studio.assets', 'studio.asset', 'studio.providers', 'studio.provider_log', 'studio.my_settings']) assert.equal(getOp(n).access, 'read', n);
  for (const n of ['studio.provider_delete', 'studio.asset_delete']) assert.equal(getOp(n).access, 'danger', n);
  assert.equal(getOp('studio.generate').access, 'write');
  assert.equal(getOp('studio.generate').slow, true);
  assert.ok(getOp('studio.import_vertex').need.includes('server.manage'));
  const groups = allOps().map((o) => o.group);
  assert.ok(groups.lastIndexOf('media') < groups.indexOf('studio'));
  assert.equal(allOps().filter((o) => o.group === 'studio').length, NAMES.length);
  assert.ok(catalog(admin).filter((o) => o.group === 'studio').every((o) => o.available), '管理员全部可用');
});

test('参数校验：缺 kind、kind 不认识、不认识的参数、素材形状不对、id 不是 uuid 都报 bad_args', async () => {
  assert.equal(await code(run('studio.generate', { prompt: 'x' })), 'bad_args');
  assert.equal(await code(run('studio.generate', { kind: 'sound', prompt: 'x' })), 'bad_args');
  assert.equal(await code(run('studio.generate', { kind: 'image', prompt: 'x', size: '1K' })), 'bad_args');
  assert.equal(await code(run('studio.generate', { kind: 'image', prompt: 'x', inputs: ['a.png'] })), 'bad_args');
  assert.equal(await code(run('studio.generate', { kind: 'image', prompt: 'x', params: 'nope' })), 'bad_args');
  assert.equal(await code(run('studio.job', { id: '../../etc' })), 'bad_args');
  assert.equal(await code(run('studio.asset_delete', { id: 'abc' })), 'bad_args');
  assert.equal(await code(run('studio.provider_test', {})), 'bad_args');
  assert.equal(await code(run('studio.my_settings_set', { values: { claudeMedia: false } })), 'bad_args', '主机级项不从这里改');
  assert.equal(await code(run('studio.models', { kind: 'pic' })), 'bad_args');
  assert.equal(runs, 0, '参数不对的没发出去');
});

test('studio.models：紧凑目录（服务名、默认、素材角色、精简参数），q 过滤，给 key 返回完整条目', async () => {
  const r = await run('studio.models', { kind: 'image' });
  assert.deepEqual(Object.keys(r.kinds), ['image']);
  const c = r.kinds.image;
  assert.equal(c.default, KEY);
  const m = c.models.find((x) => x.key === KEY);
  assert.equal(m.provider, prov.name);
  assert.equal(m.default, true);
  assert.equal(m.label, 'GPT Image 2.5 Sunburst');
  assert.ok(m.inputs.images.roles.includes('edit'));
  assert.ok(m.inputs.images.max >= 1);
  const quality = m.params.find((s) => s.key === 'quality');
  assert.ok(quality && Array.isArray(quality.options) && quality.options.every((v) => typeof v !== 'object'), '选项只给取值');
  for (const s of m.params) for (const k of Object.keys(s)) assert.ok(['key', 'type', 'label', 'options', 'moreOptions', 'min', 'max', 'default', 'when', 'unit', 'custom'].includes(k), '多出字段 ' + k);
  assert.ok(JSON.stringify(r).length < JSON.stringify((await callOp(admin, 'studio.models', { key: KEY }, env)).model).length * 4);
  assert.equal((await run('studio.models', { kind: 'image', q: 'no-such-model' })).kinds.image.models.length, 0);
  assert.equal((await run('studio.models', { q: 'SUNBURST' })).kinds.image.models.length, 1, '不分大小写');
  const full = await run('studio.models', { key: KEY });
  assert.equal(full.model.key, KEY);
  assert.ok(full.model.params.some((s) => s.group), '完整条目原样');
  assert.equal(await code(run('studio.models', { key: 'p-00000000/x' })), 'not_found');
});

test('紧凑化：被上游拒收过的选项去掉、渲染字段去掉、when / 自定义尺寸留着；备选只给 key + label', () => {
  const p = S.compactParam({ key: 'format', label: '格式', type: 'enum', group: 'advanced', format: 'x', options: [{ value: 'png', label: 'PNG' }, { value: 'svg', label: 'SVG', rejected: true }], default: 'png', when: { $edit: false } });
  assert.deepEqual(p, { key: 'format', label: '格式', type: 'enum', options: ['png'], default: 'png', when: { $edit: false } });
  assert.equal(S.compactParam({ key: 'size', type: 'size', options: [{ value: '1K' }], custom: { min: 256 } }).custom, true);
  const cat = S.compactCatalog({ image: { defaults: null, groups: [{ provider: { name: 'OR' }, models: [], shelf: [{ key: 'p/a', id: 'a', label: 'A', vendor: 'v', kind: 'image', shelf: true }] }] } });
  assert.deepEqual(cat.image.shelf, [{ key: 'p/a', label: 'A' }]);
  assert.deepEqual(S.compactInputs({ text: true, images: { max: 3, roles: ['ref'] }, negative: true }), { images: { roles: ['ref'], max: 3 }, negative: true });
});

test('studio.generate：source 标 api、不自动存进工作空间；等到出结果返回作品与 serverPath；saveTo 复制', async () => {
  assert.equal(settings.effectiveStudioSettings('admin').autoSave, true, '自动存储开着（Studio 自己发起的会存）');
  const r = await run('studio.generate', { kind: 'image', model: KEY, prompt: '一只纸船', params: { quality: 'low' }, saveTo: 'out/' });
  assert.equal(r.job.state, 'done');
  assert.equal(r.job.source, 'api');
  assert.equal(r.job.params.quality, 'low');
  const a = r.results[0];
  assert.match(a.url, /^https:\/\/bridge\.test\/api\/vertex\/media\?id=/);
  assert.ok(existsSync(a.serverPath));
  assert.match(a.savedTo, /^out\/.+\.png$/);
  assert.equal(media.get(a.id).source, 'api');
  assert.equal(media.get(a.id).wsPath, undefined, 'agent 发起的不自动存');
  assert.equal(r.job.result[0].wsPath, undefined);
  // 续改：thread / parent 带进任务
  const w = await run('studio.generate', { kind: 'image', model: KEY, prompt: '改成蓝色', thread: a.id, parent: a.id, inputs: [{ role: 'edit', asset: a.id }], wait: false });
  assert.notEqual(w.job.state, 'done');
  assert.equal(w.job.thread, a.id); assert.equal(w.job.parent, a.id);
  let j;
  for (let i = 0; i < 100; i++) { j = (await run('studio.job', { id: w.job.id })).job; if (j.state === 'done') break; await new Promise((x) => setTimeout(x, 20)); }
  assert.equal(j.state, 'done');
  assert.ok((await run('studio.jobs')).jobs.some((x) => x.id === w.job.id));
  const asset = (await run('studio.asset', { id: j.result[0].id })).asset;
  assert.deepEqual(asset.parents, [a.id]);
  assert.ok(existsSync(asset.serverPath));
  assert.ok((await run('studio.assets', { thread: a.id })).items.length >= 1);
});

test('网络请求带 source:api 不起作用：照旧按 Studio 发起（自动存进工作空间）', async () => {
  const body = JSON.stringify({ kind: 'image', key: KEY, prompt: '外面来的', source: 'api' });
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { method: 'POST', url: '/api/studio/jobs', headers: { 'x-test-admin': '1', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
  const out = await new Promise((resolve) => {
    let s = '';
    router.dispatch(req, { headersSent: false, writableEnded: false, statusCode: 200, setHeader() {}, writeHead(c) { this.statusCode = c; this.headersSent = true; }, write(c) { s += c; return true }, end(c) { if (c) s += c; this.writableEnded = true; resolve(JSON.parse(s)); }, on() {}, once() {} });
  });
  assert.equal(out.job.source, 'studio');
  let j;
  for (let i = 0; i < 100; i++) { j = (await run('studio.job', { id: out.job.id })).job; if (j.state === 'done') break; await new Promise((x) => setTimeout(x, 20)); }
  assert.ok(j.result[0].wsPath, 'Studio 发起的照常自动存');
});

test('放行：外部 agent 被关、种类被关时拒；同机实例能查、不能管服务与设置', async () => {
  settings.setStudioHostSettings({ apiMedia: false });
  try {
    assert.equal(await code(run('studio.generate', { kind: 'image', prompt: 'x' })), 'forbidden');
    assert.equal(catalog(admin).find((o) => o.name === 'studio.generate').available, false);
    assert.equal(await code(run('studio.models', { kind: 'image' })), 'ok', '只读的不受影响');
  } finally { settings.setStudioHostSettings({ apiMedia: null }); }
  settings.setStudioHostSettings({ agentImage: false });
  try {
    assert.equal(await code(run('studio.generate', { kind: 'image', prompt: 'x' })), 'forbidden');
  } finally { settings.setStudioHostSettings({ agentImage: null }); }
  const inst = { ...contextFor(adminId), agentCaller: 'dimensio' };
  assert.equal(await code(run('studio.providers', {}, inst)), 'ok');
  assert.equal(await code(run('studio.provider_create', { preset: 'openrouter' }, inst)), 'forbidden');
  assert.equal(await code(run('studio.my_settings_set', { values: { autoSave: false } }, inst)), 'forbidden');
  assert.equal(await code(run('studio.generate', { kind: 'image', prompt: 'x' }, inst)), 'forbidden', 'dimensio 默认没放行');
});

test('服务：列表、单个、新建、修改的返回里都没有密钥（Key 只有末 4 位，请求头与额外请求体只给键名）', async () => {
  const list = await run('studio.providers');
  const p = list.providers.find((x) => x.id === prov.id);
  assert.equal(p.hasKey, true); assert.equal(p.keyTail, '7788');
  assert.deepEqual(p.headerNames, ['X-Relay-Token']);
  assert.deepEqual(p.extraBodyKeys, ['relay_secret']);
  assert.ok(list.presets.some((x) => x.id === 'openrouter'));
  const one = await run('studio.providers', { id: prov.id });
  assert.equal(one.provider.models[0].id, 'openai/gpt-image-2.5-sunburst');
  const created = await run('studio.provider_create', { preset: 'openai', apiKey: 'sk-new-secret-4321', headers: { 'X-A': HEADER_SECRET }, autoSync: false });
  assert.ok(created.provider.models.length > 0, '官方预设没给模型时用预设自带的');
  assert.equal(created.provider.baseUrl, 'https://api.openai.com/v1');
  const upd = await run('studio.provider_update', { id: created.provider.id, patch: { apiKey: 'sk-rotated-secret-0000', name: '改名了' } });
  assert.equal(upd.provider.name, '改名了'); assert.equal(upd.provider.keyTail, '0000');
  const all = JSON.stringify([list, one, created, upd, await run('studio.providers')]);
  for (const s of [SECRET, HEADER_SECRET, 'sk-new-secret', 'sk-rotated-secret']) assert.ok(!all.includes(s), '泄露了 ' + s);
  assert.equal(await code(run('studio.provider_delete', { id: created.provider.id })), 'ok');
  assert.equal(await code(run('studio.provider_update', { id: created.provider.id, patch: { name: 'x' } })), 'not_found');
});

test('个人设置：看、改、null 恢复', async () => {
  const s = await run('studio.my_settings');
  assert.equal(s.values.autoSave, true);
  assert.ok(s.items.some((x) => x.key === 'saveDir'));
  const r = await run('studio.my_settings_set', { values: { autoSave: false } });
  assert.deepEqual(r.changed, [{ key: 'autoSave', from: true, to: false }]);
  assert.equal((await run('studio.my_settings')).values.autoSave, false);
  await run('studio.my_settings_set', { values: { autoSave: null } });
  assert.equal((await run('studio.my_settings')).values.autoSave, true);
  assert.equal(await code(run('studio.my_settings_set', { values: { defaults: { image: { provider: 'p-00000000', model: 'x' } } } })), 'bad_args');
});
