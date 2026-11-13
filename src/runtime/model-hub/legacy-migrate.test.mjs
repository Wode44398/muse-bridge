// 老配置统一并进模型中心（legacy-migrate.mjs + dimensio 扩展那半）的单测。
// Studio 桥是假桥，数据根是临时目录：不联网、不碰真实数据与 Key。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-hub-unify-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
delete process.env.VERTEX_PROJECT;

const R = await import('./registry.mjs');
const G = await import('./gateway.mjs');
const L = await import('./studio-link.mjs');
const O = await import('./overview.mjs');
const P = await import('../claude-providers.mjs');
const M = await import('./legacy-migrate.mjs');
const { installCoreResolver } = await import('../../modules/core-resolve.mjs');
installCoreResolver();
const DM = await import('../../../modules/dimensio/server/runtime/legacy-migrate.mjs');

// —— 假 Studio 桥 ——
const calls = [];
const store = new Map();   // hubRef → 托管条目
const studioRows = [
  { id: 'p-11112222', name: 'Gemini API', dialect: 'gemini', preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', enabled: true, shared: false, hasKey: true, keyTail: '1111' },
  { id: 'p-33334444', name: 'OpenRouter', dialect: 'openrouter', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, shared: true, hasKey: true, keyTail: '2222' },
  { id: 'p-55556666', name: 'Google Vertex AI', dialect: 'vertex', preset: 'vertex', baseUrl: '', enabled: true, shared: true, hasKey: true, keyTail: '' },
  { id: 'p-77778888', name: '本机图像模型', dialect: 'local', preset: 'local', baseUrl: '', enabled: true, shared: false, hasKey: true, keyTail: '' },
];
const ADOPT = {
  'p-11112222': { apiKey: 'k-gem-aaaa1111', models: [{ id: 'imagen-4', label: 'Imagen 4', kind: 'image' }, { id: 'tts-g', kind: 'speech' }], parked: [{ id: 'veo-old', kind: 'video' }] },
  'p-33334444': { apiKey: 'k-or-bbbb2222', models: [{ id: 'openai/gpt-image-2', kind: 'image' }], parked: [] },
};
const builtinModels = { 'p-55556666': [{ id: 'imagen-4', kind: 'image', enabled: true }, { id: 'veo-3', kind: 'video', enabled: false }], 'p-77778888': [{ id: 'qwen-image-local', kind: 'image', enabled: true }] };
const fakeBridge = {
  list: () => studioRows.map((r) => {
    const ref = [...store.entries()].find(([, v]) => v.id === r.id)?.[0];
    return { ...r, host: r.baseUrl ? new URL(r.baseUrl).host : '', managed: !!ref, hubRef: ref || '', kinds: {}, models: 1 };
  }),
  dialectFor: (u) => (/generativelanguage/.test(String(u)) ? { dialect: 'gemini', preset: 'gemini', kinds: ['image', 'video', 'speech', 'music'] }
    : /openrouter/.test(String(u)) ? { dialect: 'openrouter', preset: 'openrouter', kinds: ['image', 'video'] }
      : { dialect: 'openai', preset: 'openai-compat', kinds: ['image', 'video', 'speech'] }),
  detect: async () => ({ dialect: 'openai', kinds: [], models: [] }),
  upsert(input) {
    calls.push(['upsert', input.hubRef, 'apiKey' in input]);
    const cur = store.get(input.hubRef) || { id: 'p-' + Math.random().toString(16).slice(2, 10) };
    store.set(input.hubRef, { ...cur, ...input });
    return { id: cur.id, dialect: 'gemini', created: false, skipped: [] };
  },
  adopt(id, hubRef) {
    calls.push(['adopt', id, hubRef]);
    const r = studioRows.find((x) => x.id === id);
    const a = ADOPT[id];
    if (!r || !a) throw Object.assign(new Error('没有这个媒体服务'), { status: 404 });
    store.set(hubRef, { id });
    return { id, name: r.name, dialect: r.dialect, preset: r.preset, baseUrl: r.baseUrl, authStyle: '', headers: [], enabled: r.enabled, shared: r.shared, ...a };
  },
  release(hubRef) { calls.push(['release', hubRef]); store.delete(hubRef); },
  remove(hubRef) { store.delete(hubRef); },
  builtins: () => studioRows.filter((r) => r.dialect === 'vertex' || r.dialect === 'local')
    .map((r) => ({ id: r.id, name: r.name, dialect: r.dialect, enabled: r.enabled, shared: r.shared, models: builtinModels[r.id].map((m) => ({ ...m, label: m.id })) })),
  setBuiltin(id, patch) {
    calls.push(['setBuiltin', id, patch]);
    for (const m of builtinModels[id]) if (typeof patch.models?.[m.id] === 'boolean') m.enabled = patch.models[m.id];
    return fakeBridge.builtins().find((b) => b.id === id);
  },
};
L._setStudioBridgeForTests(fakeBridge);
after(async () => { await G._stopGatewayForTests(); L._setStudioBridgeForTests(undefined); });

const HUB = path.join(tmp, 'hub');
R._resetHubForTests(HUB);
await R.initModelHub();
const disk = () => JSON.parse(readFileSync(path.join(HUB, 'services.json'), 'utf8'));
const byName = (n) => R.listHubServices().find((s) => s.name === n);

// 模型中心里已经有的服务（维护者线上就是这样：Gemini、OpenRouter 早就为文本建过）
const gem = R.createHubService({ name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', lines: [{ key: 'k-gem-aaaa1111' }], models: [{ id: 'gemini-x' }] });
const orr = R.createHubService({ name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', lines: [{ key: 'k-or-bbbb2222' }], models: [{ id: 'openai/gpt-x' }] });
const relay = R.createHubService({ name: '中转', kind: 'openai', baseUrl: 'https://relay.example/v1', lines: [{ key: 'k-relay-123456' }], models: [{ id: 'gpt-a' }] });

test('Claude 与 Studio 的老服务：启动时自动并进来；同一个服务并进已有的，原件只藏不删；第二次什么都不做', () => {
  // Claude：一个和「中转」是同一个（同地址、同协议、同 Key），一个是别家，一个一个启用的型号都没有
  const twin = P.createProvider({ name: '中转（Claude）', protocol: 'openai', baseUrl: 'https://relay.example/v1', apiKey: 'k-relay-123456', models: [{ id: 'gpt-a' }, { id: 'gpt-b' }, { id: 'gpt-c', enabled: false }] });
  const other = P.createProvider({ name: '中转', protocol: 'anthropic', baseUrl: 'https://other.example/anthropic', apiKey: 'k-other-123456', models: [{ id: 'claude-y' }] });
  const empty = P.createProvider({ name: '空的', protocol: 'openai', baseUrl: 'https://empty.example/v1', apiKey: 'k-empty-123456', models: [{ id: 'm-off', enabled: false }] });
  const before = R.listHubServices().length;

  const r = M.migrateLegacyConfigs();
  assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
  assert.equal(r.claude.length, 3);
  assert.equal(r.studio.length, 2, 'Vertex / 本机不搬');

  // 并进「中转」：gpt-b 新加、两边都给；停用的 gpt-c 进目录
  const rel = R.getHubService(relay.id);
  assert.deepEqual(rel.models.map((m) => [m.id, m.agents]), [['gpt-a', ['claude', 'dimensio']], ['gpt-b', ['claude', 'dimensio']]]);
  assert.ok(R.catalogView(relay.id).models.some((m) => m.id === 'gpt-c'));
  // 别家：另建，名字撞了加来路
  const o = byName('中转 · Claude');
  assert.ok(o, '重名的加「· Claude」');
  assert.equal(o.kind, 'anthropic');
  assert.equal(R._hubKeyForTests(o.id, o.lines[0].id), 'k-other-123456');
  // 一个启用的型号都没有：照建，型号进目录
  const e = byName('空的');
  assert.ok(e && e.models.length === 0);
  assert.ok(R.catalogView(e.id).models.some((m) => m.id === 'm-off'));
  // 原件：从菜单里藏起来，不删不停用
  for (const p of [twin, other, empty]) {
    const now = P.getProvider(p.id, P.HOST_OWNER);
    assert.ok(now, '原件还在');
    assert.equal(now.showInPicker, false);
    assert.notEqual(now.enabled, false);
  }
  assert.deepEqual(Object.keys(disk().migrated.claude).sort(), [twin.id, other.id, empty.id].sort());

  // Studio：Gemini 与模型中心的「Gemini」同主机、同 Key、共享一致 → 并进去（Studio 那边托管到它名下，id 不变）
  const g = R.getHubService(gem.id);
  assert.deepEqual(g.models.map((m) => [m.id, m.kind, m.agents]),
    [['gemini-x', 'text', ['dimensio']], ['imagen-4', 'image', ['studio']], ['tts-g', 'voice', ['studio']]]);
  assert.equal(g.media.providerId, 'p-11112222');
  assert.ok(R.catalogView(gem.id).models.some((m) => m.id === 'veo-old'), '备选的进目录');
  assert.ok(calls.some((c) => c[0] === 'adopt' && c[1] === 'p-11112222' && c[2] === gem.id));
  // OpenRouter：Studio 那份共享给成员、模型中心这份没共享 → 不合并（免得悄悄改掉成员的权限），另建并标「· 媒体」
  assert.equal(R.getHubService(orr.id).models.length, 1);
  const om = byName('OpenRouter · 媒体');
  assert.ok(om);
  assert.equal(om.members, true);
  assert.deepEqual(om.models.map((m) => m.agents), [['studio']]);
  assert.deepEqual(disk().migrated.studio, { 'p-11112222': gem.id, 'p-33334444': om.id });
  assert.ok(R.listHubServices().length === before + 3);

  // 总览：并过的 Claude 服务不再单列；内置媒体服务带明细
  const ov = O.hubOverview();
  assert.deepEqual(ov.claude, []);
  assert.deepEqual(ov.builtins.map((b) => [b.id, b.dialect]), [['p-55556666', 'vertex'], ['p-77778888', 'local']]);
  assert.equal(ov.studio.find((s) => s.id === 'p-55556666').builtin, 'vertex');

  // 第二次：没有要并的，不动文件
  const n = R.listHubServices().length;
  const again = M.migrateLegacyConfigs();
  assert.deepEqual([again.claude.length, again.studio.length, again.skipped.length], [0, 0, 0]);
  assert.equal(R.listHubServices().length, n);
});

test('Studio 尾号对得上、Key 其实不一样：取消托管、改为另建', () => {
  const x = R.createHubService({ name: '某家', kind: 'openai', baseUrl: 'https://media.example/v1', lines: [{ key: 'k-real-xxxx9999' }], models: [{ id: 't-1' }] });
  studioRows.push({ id: 'p-9999aaaa', name: '某家', dialect: 'openai', preset: 'openai-compat', baseUrl: 'https://media.example/v1', enabled: true, shared: false, hasKey: true, keyTail: '9999' });
  ADOPT['p-9999aaaa'] = { apiKey: 'k-fake-zzzz9999', models: [{ id: 'img-1', kind: 'image' }], parked: [] };
  const r = M.migrateLegacyConfigs();
  assert.equal(r.studio.length, 1);
  assert.ok(calls.some((c) => c[0] === 'release' && c[1] === x.id), '并进去之前比出 Key 不同：先取消托管');
  assert.equal(R.getHubService(x.id).models.length, 1, '原服务不动');
  const made = byName('某家 · 媒体');
  assert.ok(made);
  assert.equal(R._hubKeyForTests(made.id, made.lines[0].id), 'k-fake-zzzz9999');
});

test('内置媒体服务：开关模型走 Studio 桥', () => {
  const b = L.setStudioBuiltin('p-55556666', { models: { 'veo-3': true } });
  assert.equal(b.models.find((m) => m.id === 'veo-3').enabled, true);
  L._setStudioBridgeForTests(null);
  try { assert.throws(() => L.setStudioBuiltin('p-55556666', {}), /Media Studio/); }
  finally { L._setStudioBridgeForTests(fakeBridge); }
});

test('dimensio 自建的服务：并进模型中心、原件记 hubRef（不删）、总览不再单列；再跑只补记', () => {
  const dir = path.join(tmp, 'dim');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'providers.json');
  writeFileSync(file, JSON.stringify({ v: 2, providers: [
    { id: 'custom-0a0a0a0a', name: 'D 中转', protocol: 'openai', baseUrl: 'https://dim.example/v1', authStyle: 'bearer', models: ['dm-1', 'dm-2'],
      modelSpecs: [{ id: 'dm-1', contextWindow: 64000 }, { id: 'dm-2', enabled: false }], extra: 'keep-me' },
  ] }));
  const r = DM.migrateDimensioServices(dir);
  assert.equal(r.done.length, 1, JSON.stringify(r));
  const s = byName('D 中转');
  assert.ok(s);
  assert.deepEqual(s.models.map((m) => [m.id, m.agents]), [['dm-1', ['claude', 'dimensio']]]);
  assert.ok(R.catalogView(s.id).models.some((m) => m.id === 'dm-2'), '停用的进目录');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.providers[0].hubRef, s.id);
  assert.equal(raw.providers[0].extra, 'keep-me', '别的字段原样');
  assert.equal(disk().migrated.dimensio['custom-0a0a0a0a'], s.id);
  // 总览的 dimensio 一栏：经注入的读取器读，并过的不列
  O.setDimensioProvidersReader(() => [{ id: 'custom-0a0a0a0a', name: 'D 中转', protocol: 'openai', host: 'dim.example', models: 2 }]);
  try { assert.deepEqual(O.hubOverview().dimensio, []); } finally { O.setDimensioProvidersReader(null); }
  // 文件被老版 harness 重写丢了 hubRef：再跑只补记，不重复建
  writeFileSync(file, JSON.stringify({ v: 2, providers: [{ ...raw.providers[0], hubRef: undefined }] }));
  const n = R.listHubServices().length;
  const again = DM.migrateDimensioServices(dir);
  assert.equal(again.done.length, 0);
  assert.equal(R.listHubServices().length, n);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).providers[0].hubRef, s.id);
});
