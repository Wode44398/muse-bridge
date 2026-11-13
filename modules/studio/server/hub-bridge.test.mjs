// 模型中心 ⇄ Media Studio 的桥（方案 §3.8、契约 §6）：认方言、建 / 改托管服务（id 不变、Key 不传不动、同 id 留卡、全量覆盖、
// 方言做不了的跳过、清单只管主列表、shared）、收编 / 取消托管 / 删除（收编回 enabled / shared / parked，原样推回不改 Studio 侧）、
// Studio 自己的接口拒改托管服务、list 只数主列表里的模型、detect 的人话报错（先抹 Key 再截断）。
// 数据根改道到临时目录；上游一律假 fetch，schema 后台刷新换成记账的假函数——不连任何真服务、不碰真实 Key。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-hub-'));
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
  port: 18995, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'),
}, null, 2));

await (await import('@bridge/core/modules/registry.mjs')).loadModules();
const P = await import('./providers.mjs');
const H = await import('./hub-bridge.mjs');
const { hub } = await import('./index.mjs');
const { DIALECT_KINDS } = await import('./presets.mjs');

// schema 后台刷新：记下被叫的服务 id，不真去连上游
const kicked = [];
H._setSchemaRefreshForTests((id) => { kicked.push(id); });

const REF = { a: 'h-0000000a', b: 'h-0000000b', c: 'h-0000000c', d: 'h-0000000d', e: 'h-0000000e', f: 'h-0000000f', g: 'h-0000001a', h: 'h-0000001b' };
const get = (id) => P.getProvider(id, 'admin');
const keyOf = (id) => P.providerSecret(get(id)).key;
const ids = (p) => p.models.map((m) => m.id);

// 假上游：按 URL 回固定响应；记下请求，用后还原
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), headers: init.headers || {} }); return handler(String(url), init); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('桥接对象从扩展入口命名导出，九个方法齐全', () => {
  assert.equal(hub, H.hub);
  assert.deepEqual(Object.keys(hub).sort(), ['adopt', 'builtins', 'detect', 'dialectFor', 'list', 'release', 'remove', 'setBuiltin', 'upsert']);
  assert.ok(Object.isFrozen(hub));
});

test('dialectFor：按 host 认官方服务、换成媒体接口地址；认不出 = OpenAI 兼容、地址原样；永不抛', () => {
  const or = H.dialectFor('https://openrouter.ai/api/v1/');
  assert.equal(or.dialect, 'openrouter'); assert.equal(or.preset, 'openrouter'); assert.equal(or.baseUrl, 'https://openrouter.ai/api/v1');
  assert.deepEqual(or.kinds, DIALECT_KINDS.openrouter);
  assert.equal(H.dialectFor('https://openrouter.ai/api/v1/chat/completions').baseUrl, 'https://openrouter.ai/api/v1', '文本接口路径也换成媒体地址');
  assert.deepEqual(H.dialectFor('https://fal.run'), { dialect: 'fal', preset: 'fal', kinds: [...DIALECT_KINDS.fal], baseUrl: 'https://queue.fal.run' });
  assert.equal(H.dialectFor('https://api.openai.com/v1').preset, 'openai');
  assert.equal(H.dialectFor('https://generativelanguage.googleapis.com/v1beta/openai').dialect, 'gemini');
  assert.equal(H.dialectFor('https://api.replicate.com/v1').dialect, 'replicate');
  const mm = H.dialectFor('https://api.minimax.io/v1');
  assert.equal(mm.dialect, 'minimax'); assert.equal(mm.baseUrl, 'https://api.minimax.io/v1', 'MiniMax 海外站保留原 host（Key 不通用）');
  assert.equal(H.dialectFor('https://api.minimaxi.com/anthropic').baseUrl, 'https://api.minimaxi.com/v1');
  assert.equal(H.dialectFor('https://api.us.elevenlabs.io').baseUrl, 'https://api.us.elevenlabs.io/v1');
  assert.equal(H.dialectFor('https://ark.ap-southeast.bytepluses.com/api/v3').dialect, 'ark');
  assert.equal(H.dialectFor('https://ark.cn-beijing.volces.com/api/coding/v3').baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.deepEqual(H.dialectFor('https://relay.example.com/v1/'), { dialect: 'openai', preset: 'openai-compat', kinds: [...DIALECT_KINDS.openai], baseUrl: 'https://relay.example.com/v1' });
  assert.equal(H.dialectFor('https://evil-openrouter.ai.example.com/v1').dialect, 'openai', '只认真正的 host，不按子串');
  assert.equal(H.dialectFor('').preset, 'openai-compat');
  assert.equal(H.dialectFor('不是网址').baseUrl, '不是网址');
  assert.equal(H.dialectFor(undefined).baseUrl, '');
  const k = H.dialectFor('https://fal.run').kinds; k.push('x');
  assert.ok(!DIALECT_KINDS.fal.includes('x'), 'kinds 是副本');
});

test('upsert 新建：托管标记、autoSync 关、不共享、按地址取方言；Key 进加密存储；回 created', () => {
  kicked.length = 0;
  const r = H.upsert({
    hubRef: REF.a, name: '中转站', baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer', apiKey: 'sk-or-test-AAAA1111',
    headers: [{ name: 'HTTP-Referer', value: 'https://bridge.example' }, { name: 'Authorization', value: 'x' }, { name: 'anthropic-version', value: '1' }, { name: 'bad name', value: 'x' }],
    enabled: true,
    models: [{ id: 'google/gemini-3-pro-image', label: 'Nano Banana Pro', kind: 'image' }, { id: 'openai/sora-2', kind: 'video' }],
  });
  assert.equal(r.created, true); assert.equal(r.dialect, 'openrouter'); assert.deepEqual(r.skipped, []);
  assert.match(r.id, /^p-[0-9a-f]{8}$/);
  const p = get(r.id);
  assert.equal(p.managedBy, 'hub'); assert.equal(p.hubRef, REF.a);
  assert.equal(p.autoSync, false); assert.equal(p.shared, false); assert.equal(p.preset, 'openrouter');
  assert.equal(p.baseUrl, 'https://openrouter.ai/api/v1'); assert.equal(p.authStyle, 'bearer');
  assert.deepEqual(p.headers, { 'HTTP-Referer': 'https://bridge.example' }, '鉴权头、anthropic-*、不合法的头丢掉，不让整单失败');
  assert.deepEqual(ids(p), ['google/gemini-3-pro-image', 'openai/sora-2']);
  assert.ok(p.models.every((m) => m.enabled && m.source === 'remote'));
  assert.equal(p.models[1].label, 'openai/sora-2', '没给名字用 id');
  assert.equal(keyOf(r.id), 'sk-or-test-AAAA1111');
  assert.ok(!readFileSync(path.join(tmp, 'studio-providers', 'providers.json'), 'utf8').includes('sk-or-test'), 'Key 不落明文');
  assert.deepEqual(kicked, [r.id], '新建的 OpenRouter 服务后台补一次 schema');
  const pub = P.listProviders('admin').find((x) => x.id === r.id);
  assert.equal(pub.managed, true); assert.equal(pub.hubRef, REF.a); assert.equal(pub.keyTail, '1111');
  assert.ok(!JSON.stringify(pub).includes('sk-or-test'), '前端视图不带 Key');
});

test('upsert 更新：id 不变；apiKey 不传不动、空串清掉；同 id 留卡与默认参数；字段不传不动', () => {
  const id = H.list().find((x) => x.hubRef === REF.a).id;
  // 模拟巡检 / 设置页给某个模型配过卡和默认参数
  P.updateProvider(id, { models: get(id).models.map((m, i) => (i === 0 ? { ...m, card: 'openrouter:test-card', defaults: { quality: 'high' }, discoveredAt: 1700000000000, vendor: 'google' } : m)) }, 'admin');
  kicked.length = 0;
  const r = H.upsert({ hubRef: REF.a, name: '中转站（改名）', models: [{ id: 'google/gemini-3-pro-image', kind: 'image' }, { id: 'openai/sora-2', kind: 'video', label: 'Sora 2' }] });
  assert.equal(r.id, id); assert.equal(r.created, false);
  const p = get(id);
  assert.equal(p.name, '中转站（改名）');
  assert.equal(keyOf(id), 'sk-or-test-AAAA1111', 'apiKey 没传：Key 不动');
  assert.equal(H.list().find((x) => x.id === id).keyTail, '1111');
  assert.equal(p.baseUrl, 'https://openrouter.ai/api/v1', '地址没传：不动');
  assert.deepEqual(p.headers, { 'HTTP-Referer': 'https://bridge.example' }, '请求头没传：不动');
  const m0 = p.models[0];
  assert.equal(m0.card, 'openrouter:test-card'); assert.deepEqual(m0.defaults, { quality: 'high' });
  assert.equal(m0.discoveredAt, 1700000000000); assert.equal(m0.vendor, 'google');
  assert.equal(m0.label, 'Nano Banana Pro', '这次没给名字：留原来的');
  assert.equal(p.models[1].label, 'Sora 2');
  assert.deepEqual(kicked, [], '只改名、没有新模型：不补 schema');
  // 同 id 换了种类：卡不再适用
  H.upsert({ hubRef: REF.a, models: [{ id: 'google/gemini-3-pro-image', kind: 'video' }, { id: 'openai/sora-2', kind: 'video' }] });
  assert.equal(get(id).models[0].card, undefined); assert.deepEqual(get(id).models[0].defaults, {});
  // 换 Key、清 Key
  H.upsert({ hubRef: REF.a, apiKey: 'sk-or-test-BBBB2222' });
  assert.equal(keyOf(id), 'sk-or-test-BBBB2222');
  assert.deepEqual(kicked, [id], '换了 Key：补一次 schema');
  H.upsert({ hubRef: REF.a, apiKey: '' });
  assert.equal(keyOf(id), ''); assert.equal(H.list().find((x) => x.id === id).hasKey, false);
  H.upsert({ hubRef: REF.a, apiKey: 'sk-or-test-AAAA1111' });
  // 停用再启用
  H.upsert({ hubRef: REF.a, enabled: false });
  assert.equal(get(id).enabled, false);
  kicked.length = 0;
  H.upsert({ hubRef: REF.a, enabled: true });
  assert.equal(get(id).enabled, true); assert.deepEqual(kicked, [id], '重新启用：补一次 schema');
});

test('upsert 的 models 是全量：没列的移出；再加回来照常', () => {
  const id = H.list().find((x) => x.hubRef === REF.a).id;
  H.upsert({ hubRef: REF.a, models: [{ id: 'a/one', kind: 'image' }, { id: 'b/two', kind: 'image' }, { id: 'c/three', kind: 'video' }] });
  assert.deepEqual(ids(get(id)), ['a/one', 'b/two', 'c/three']);
  kicked.length = 0;
  H.upsert({ hubRef: REF.a, models: [{ id: 'b/two', kind: 'image' }] });
  assert.deepEqual(ids(get(id)), ['b/two']);
  assert.deepEqual(kicked, [], '只删不加：不补 schema');
  H.upsert({ hubRef: REF.a, models: [{ id: 'b/two', kind: 'image' }, { id: 'a/one', kind: 'image' }] });
  assert.deepEqual(ids(get(id)), ['b/two', 'a/one'], '按清单顺序');
  assert.deepEqual(kicked, [id], '加了新模型：补一次 schema');
  H.upsert({ hubRef: REF.a, models: [] });
  assert.deepEqual(ids(get(id)), [], '空清单 = 全部移出');
});

test('upsert 跳过方言做不了的种类、不是媒体的、id 不合 Studio 规则的；voice 收作 speech；重复的留第一个', () => {
  const r = H.upsert({
    hubRef: REF.a,
    models: [
      { id: 'x/img', kind: 'image' }, { id: 'x/song', kind: 'music' }, { id: 'x/tts', kind: 'voice' }, { id: 'x/chat', kind: 'text' },
      { id: 'has space', kind: 'image' }, { id: 'x/img', kind: 'video' },
    ],
  });
  assert.deepEqual(ids(get(r.id)), ['x/img']);
  assert.equal(get(r.id).models[0].kind, 'image', '重复 id 留第一个');
  const by = Object.fromEntries(r.skipped.map((s) => [s.id, s]));
  assert.match(by['x/song'].reason, /OpenRouter 做不了音乐/);
  assert.equal(by['x/tts'].kind, 'speech'); assert.match(by['x/tts'].reason, /做不了配音/);
  assert.equal(by['x/chat'].reason, '不是媒体模型');
  assert.match(by['has space'].reason, /模型 id/);
  // OpenAI 兼容：voice 收作 speech
  const c = H.upsert({ hubRef: REF.b, name: '自建网关', baseUrl: 'https://relay.example.com/v1', authStyle: 'x-api-key', apiKey: 'relay-test-key-CCCC',
    models: [{ id: 'tts-1', kind: 'voice' }, { id: 'gpt-image-2', kind: 'image' }, { id: 'suno', kind: 'music' }] });
  const p = get(c.id);
  assert.equal(p.dialect, 'openai'); assert.equal(p.preset, 'openai-compat'); assert.equal(p.authStyle, 'x-api-key', 'OpenAI 兼容听模型中心的鉴权方式');
  assert.deepEqual(p.models.map((m) => [m.id, m.kind]), [['tts-1', 'speech'], ['gpt-image-2', 'image']]);
  assert.match(c.skipped[0].reason, /OpenAI 兼容接口 做不了音乐/);
  assert.deepEqual(kicked.filter((x) => x === c.id), [], 'openai 方言没有 schema：不补');
});

test('upsert 的鉴权映射与连接变化：官方方言定死鉴权；换地址认不出沿用原方言；认得出换方言、卡清掉', () => {
  const fal = H.upsert({ hubRef: REF.c, name: 'fal', baseUrl: 'https://fal.run', authStyle: 'bearer', apiKey: 'fal-test-key-DDDD', models: [{ id: 'fal-ai/flux-pro', kind: 'image' }] });
  assert.equal(get(fal.id).authStyle, 'fal-key', 'fal 的鉴权定死');
  assert.equal(get(fal.id).baseUrl, 'https://queue.fal.run');
  const goog = H.upsert({ hubRef: REF.d, name: 'goog', baseUrl: 'https://gw.example.com/v1', authStyle: 'goog', models: [] });
  assert.equal(get(goog.id).authStyle, 'x-goog-api-key');

  // OpenRouter 服务换到认不出的中转地址：仍是 OpenRouter 方言（不换驱动），预设变自定义
  const id = H.list().find((x) => x.hubRef === REF.a).id;
  H.upsert({ hubRef: REF.a, models: [{ id: 'x/img', kind: 'image' }, { id: 'x/vid', kind: 'video' }] });
  P.updateProvider(id, { models: get(id).models.map((m) => ({ ...m, card: 'openrouter:test-card' })) }, 'admin');
  kicked.length = 0;
  const r1 = H.upsert({ hubRef: REF.a, baseUrl: 'https://or-relay.example.com/api/v1/' });
  assert.equal(r1.dialect, 'openrouter');
  assert.equal(get(id).preset, 'custom'); assert.equal(get(id).baseUrl, 'https://or-relay.example.com/api/v1');
  assert.equal(get(id).models[0].card, 'openrouter:test-card', '方言没变：卡留着');
  assert.deepEqual(kicked, [id], '换了地址：补一次 schema');
  // 换到 OpenAI 官方：方言变了、没给清单 → 留下新方言做得了的，卡与默认参数清掉
  const r2 = H.upsert({ hubRef: REF.a, baseUrl: 'https://api.openai.com/v1' });
  const p = get(id);
  assert.equal(r2.dialect, 'openai'); assert.equal(p.preset, 'openai'); assert.equal(p.id, id, 'id 不变');
  assert.deepEqual(ids(p), ['x/img', 'x/vid']);
  assert.ok(p.models.every((m) => !m.card && JSON.stringify(m.defaults) === '{}'));
  assert.equal(p.authStyle, 'bearer');
  // 调用方指名方言：地址认不出也按它
  const r3 = H.upsert({ hubRef: REF.a, baseUrl: 'https://or-relay.example.com/api/v1', dialect: 'openrouter' });
  assert.equal(r3.dialect, 'openrouter'); assert.equal(get(id).preset, 'custom');
  H.upsert({ hubRef: REF.a, baseUrl: 'https://openrouter.ai/api/v1' });
  assert.equal(get(id).preset, 'openrouter', '回到官方地址：官方预设');
});

test('upsert 的校验：hubRef 不合法、地址不合法回 400；新建不给地址回 400', () => {
  assert.throws(() => H.upsert({ hubRef: 'p-12345678', baseUrl: 'https://relay.example.com/v1' }), (e) => e.status === 400 && /id 不合法/.test(e.message));
  assert.throws(() => H.upsert({ hubRef: REF.e, name: 'x' }), (e) => e.status === 400 && /接口地址不能为空/.test(e.message));
  assert.throws(() => H.upsert({ hubRef: REF.e, baseUrl: 'https://relay.example.com/v1?key=1' }), (e) => e.status === 400 && /参数/.test(e.message));
  assert.equal(H.list().filter((x) => x.hubRef === REF.e).length, 0, '报错的不落盘');
});

test('list：只数启用、没下架、不是备选的模型；hasKey / keyTail；不带 Key', () => {
  const id = H.list().find((x) => x.hubRef === REF.b).id;
  H.upsert({ hubRef: REF.b, models: [{ id: 'gpt-image-2', kind: 'image' }, { id: 'gpt-image-1', kind: 'image' }, { id: 'sora-2', kind: 'video' }, { id: 'tts-1', kind: 'voice' }] });
  // 巡检 / 设置页可能留下的状态：一个下架、一个备选、一个关掉
  P.patchModels(id, 'admin', (ms) => ms.map((m) => (m.id === 'gpt-image-1' ? { ...m, gone: true } : m.id === 'sora-2' ? { ...m, shelf: true } : m.id === 'tts-1' ? { ...m, enabled: false } : m)));
  const row = H.list().find((x) => x.id === id);
  assert.equal(row.models, 1);
  assert.deepEqual(row.kinds, { image: 1, video: 0, speech: 0, music: 0 });
  assert.equal(row.managed, true); assert.equal(row.hubRef, REF.b); assert.equal(row.host, 'relay.example.com');
  assert.equal(row.hasKey, true); assert.equal(row.keyTail, 'CCCC');
  assert.ok(!JSON.stringify(H.list()).includes('relay-test-key'), 'list 不带 Key');
  assert.ok(H.list().every((x) => !('apiKey' in x) && !('key' in x)));
  // upsert 的全量清单把它们都拉回主列表
  H.upsert({ hubRef: REF.b, models: [{ id: 'gpt-image-2', kind: 'image' }, { id: 'gpt-image-1', kind: 'image' }, { id: 'sora-2', kind: 'video' }, { id: 'tts-1', kind: 'voice' }] });
  assert.equal(H.list().find((x) => x.id === id).models, 4);
});

test('adopt：原地收编（id 不变、幂等）、回连接信息与 Key（模型中心的格式）；vertex / local / 别人管的拒绝', () => {
  const plain = P.createProvider({ name: '我的 OpenAI', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://gw2.example.com/v1', authStyle: 'x-goog-api-key',
    apiKey: 'gw2-test-key-EEEE', headers: { 'X-Team': 'media' },
    models: [{ id: 'gpt-image-2', kind: 'image', enabled: true }, { id: 'tts-1', kind: 'speech', enabled: false }] }, 'admin');
  assert.equal(plain.managed, false); assert.equal(plain.hubRef, '');
  const a = H.adopt(plain.id, REF.e);
  assert.equal(a.id, plain.id);
  assert.equal(a.dialect, 'openai'); assert.equal(a.preset, 'openai-compat'); assert.equal(a.baseUrl, 'https://gw2.example.com/v1');
  assert.equal(a.authStyle, 'goog'); assert.deepEqual(a.headers, [{ name: 'X-Team', value: 'media' }]);
  assert.equal(a.apiKey, 'gw2-test-key-EEEE');
  assert.deepEqual(a.models, [{ id: 'gpt-image-2', label: 'gpt-image-2', kind: 'image' }], '只回主列表里的');
  assert.equal(a.enabled, true); assert.equal(a.shared, false);
  assert.deepEqual(a.parked, [{ id: 'tts-1', label: 'tts-1', kind: 'speech' }], '关掉的模型作 parked 回');
  const p = get(plain.id);
  assert.equal(p.managedBy, 'hub'); assert.equal(p.hubRef, REF.e);
  assert.equal(p.autoSync, true, 'adopt 不动 autoSync');
  assert.deepEqual(H.adopt(plain.id, REF.e), a, '重复调用幂等');
  assert.throws(() => H.adopt(plain.id, REF.f), (e) => e.status === 400 && /另一个服务/.test(e.message));
  const other = P.createProvider({ name: '另一个', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://gw3.example.com/v1', models: [] }, 'admin');
  assert.throws(() => H.adopt(other.id, REF.e), (e) => e.status === 400 && /我的 OpenAI/.test(e.message));
  assert.throws(() => H.adopt('p-ffffffff', REF.f), (e) => e.status === 404);
  assert.throws(() => H.adopt(other.id, 'bad'), (e) => e.status === 400);
  const vx = P.createProvider({ name: 'Vertex', preset: 'vertex', dialect: 'vertex', google: { project: 'demo-proj' }, models: [] }, 'admin');
  assert.throws(() => H.adopt(vx.id, REF.f), (e) => e.status === 400 && /Vertex/.test(e.message));
  assert.equal(get(vx.id).managedBy, undefined);
  const lc = P.createProvider({ name: '本机', preset: 'local', dialect: 'local', models: [] }, 'admin');
  assert.throws(() => H.adopt(lc.id, REF.f), (e) => e.status === 400 && /本机/.test(e.message));
  P.deleteProvider(lc.id, 'admin');
  // fal / ElevenLabs 的鉴权在模型中心没有对应：回空串
  const el = P.createProvider({ name: 'EL', preset: 'elevenlabs', dialect: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1', models: [] }, 'admin');
  assert.equal(H.adopt(el.id, REF.f).authStyle, '');
  assert.equal(H.release(REF.f).id, el.id);
  // 收编后 upsert 改的是同一个服务
  const u = H.upsert({ hubRef: REF.e, name: '我的 OpenAI（托管）' });
  assert.equal(u.id, plain.id); assert.equal(u.created, false);
  assert.equal(get(plain.id).name, '我的 OpenAI（托管）');
  P.deleteProvider(other.id, 'admin'); P.deleteProvider(vx.id, 'admin'); P.deleteProvider(el.id, 'admin');
});

// —— Studio 自己的接口 ——
const { registerStudioApi } = await import('./routes/api.mjs');
const routes = {};
registerStudioApi({ on: (m, p, fn) => { routes[m + ' ' + p] = fn; }, prefix() {} }, { identify: () => ({ kind: 'admin' }) });
const post = (p, body) => new Promise((resolve) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: 'POST', url: p, headers: {} });
  let status = 0, out = '';
  routes['POST ' + p](req, { headersSent: false, writableEnded: false, writeHead(s) { status = s; this.headersSent = true; }, setHeader() {}, write(c) { out += c; return true }, end(c) { if (c) out += c; this.writableEnded = true; resolve({ status, j: JSON.parse(out || '{}') }); }, on() {}, once() {} }, new URL(p, 'http://x'));
});
const MANAGED_MSG = '这个服务由模型中心管理，请到 设置 › 模型中心 里改';

test('接口：托管服务的 update / delete / 指名 sync 回 400「由模型中心管理」；不给 id 的 sync 跳过它；create / update 带的托管字段丢掉', async () => {
  const id = H.list().find((x) => x.hubRef === REF.e).id;
  const before = JSON.stringify(get(id));
  const up = await post('/api/studio/providers/update', { id, patch: { name: '偷改' } });
  assert.equal(up.status, 400); assert.equal(up.j.error, MANAGED_MSG);
  const del = await post('/api/studio/providers/delete', { id });
  assert.equal(del.status, 400); assert.equal(del.j.error, MANAGED_MSG);
  const sy = await post('/api/studio/providers/sync', { id });
  assert.equal(sy.status, 400); assert.equal(sy.j.error, MANAGED_MSG);
  assert.equal(JSON.stringify(get(id)), before, '被拒的请求没动它');

  // 前端 / 外部请求伪造托管标记：一律丢掉
  const cr = await post('/api/studio/providers/create', { name: '伪造', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://gw4.example.com/v1', managedBy: 'hub', hubRef: REF.f, models: [] });
  assert.equal(cr.status, 200); assert.equal(cr.j.provider.managed, false); assert.equal(cr.j.provider.hubRef, '');
  assert.equal(get(cr.j.provider.id).managedBy, undefined);
  const up2 = await post('/api/studio/providers/update', { id: cr.j.provider.id, patch: { managedBy: 'hub', hubRef: REF.f } });
  assert.equal(up2.status, 200); assert.equal(up2.j.provider.managed, false);
  // 普通服务照常能改、能删
  const up3 = await post('/api/studio/providers/update', { id: cr.j.provider.id, patch: { name: '普通服务' } });
  assert.equal(up3.status, 200); assert.equal(up3.j.provider.name, '普通服务');

  // 不给 id 的「立即检查」：托管服务不在结果里、也不去连它的上游
  await withFetch((url) => reply(200, { data: [] }), async (calls) => {
    const all = await post('/api/studio/providers/sync', {});
    assert.equal(all.status, 200);
    const managedIds = new Set(H.list().filter((x) => x.managed).map((x) => x.id));
    assert.ok(Object.keys(all.j.results).every((k) => !managedIds.has(k)), '结果里没有托管服务');
    assert.ok(!calls.some((c) => /relay\.example\.com|gw2\.example\.com|fal\.run|openrouter\.ai|gw\.example\.com/.test(c.url)), '没去连托管服务的上游');
    assert.ok(Array.isArray(all.j.providers));
  });
  const del2 = await post('/api/studio/providers/delete', { id: cr.j.provider.id });
  assert.equal(del2.status, 200);
  assert.equal(get(cr.j.provider.id), null);
});

test('release：去掉托管标记，服务与模型原样留下、Studio 接口又能改；没有这个托管服务回 null', async () => {
  const id = H.list().find((x) => x.hubRef === REF.e).id;
  const models = JSON.stringify(get(id).models);
  assert.deepEqual(H.release(REF.e), { id });
  const p = get(id);
  assert.equal(p.managedBy, undefined); assert.equal(p.hubRef, undefined);
  assert.equal(JSON.stringify(p.models), models); assert.equal(keyOf(id), 'gw2-test-key-EEEE');
  assert.equal(P.listProviders('admin').find((x) => x.id === id).managed, false);
  assert.equal(H.release(REF.e), null);
  const up = await post('/api/studio/providers/update', { id, patch: { name: '又归 Studio 管了' } });
  assert.equal(up.status, 200);
  assert.throws(() => H.release('nope'), (e) => e.status === 400);
  // 取消托管后同一个 hubRef 再 upsert：新建一个，不会抢回老服务
  const again = H.upsert({ hubRef: REF.e, name: '新的', baseUrl: 'https://gw5.example.com/v1', models: [] });
  assert.equal(again.created, true); assert.notEqual(again.id, id);
  H.remove(REF.e);
  P.deleteProvider(id, 'admin');
});

test('巡检：托管服务的清单不动（不加新模型、不标下架），只刷 schema；没有 schema 的方言托管后不巡检', async () => {
  const D = await import('./discovery/index.mjs');
  const S = await import('./discovery/store.mjs');
  const orId = H.list().find((x) => x.hubRef === REF.a).id;
  H.upsert({ hubRef: REF.a, models: [{ id: 'x/img', kind: 'image' }, { id: 'x/vid', kind: 'video' }] });
  const before = JSON.stringify(get(orId).models);
  const schema = { src: 'openrouter', kind: 'image', data: { type: 'object', properties: { size: { type: 'string' } } } };
  const st = await D.syncProvider('admin', orId, {
    sources: { openrouter: async () => ({ models: [{ id: 'x/img', kind: 'image' }, { id: 'brand/new', kind: 'image' }], complete: true, schemas: { 'x/img': schema }, schemasReplace: true }) },
    fetchEndpoints: async () => null,
  });
  assert.equal(st.ok, true);
  assert.equal(JSON.stringify(get(orId).models), before, '没加 brand/new，也没把 x/vid 标下架');
  assert.deepEqual(S.getSchema('admin', orId, 'x/img').data, schema.data, 'schema 照刷');

  // 托管的 fal：不拉清单（发现源不该被叫），主列表的模型逐个取 schema
  const fal = H.upsert({ hubRef: REF.c, models: [{ id: 'fal-ai/flux-pro', kind: 'image' }, { id: 'fal-ai/flux-dev', kind: 'image' }] });
  const asked = [];
  const st2 = await D.syncProvider('admin', fal.id, {
    sources: { fal: async () => { throw new Error('托管的 fal 不该去拉清单'); } },
    fetchSchema: async (p, m) => { asked.push(m.id); return { src: 'fal', kind: 'image', data: { type: 'object' } }; },
  });
  assert.equal(st2.ok, true);
  assert.deepEqual(asked.sort(), ['fal-ai/flux-dev', 'fal-ai/flux-pro']);
  assert.deepEqual(ids(get(fal.id)), ['fal-ai/flux-pro', 'fal-ai/flux-dev']);

  // 托管的 OpenAI 兼容：不巡检
  const oaId = H.list().find((x) => x.hubRef === REF.b).id;
  assert.equal(D.syncable(get(oaId)), false);
  assert.equal(await D.syncProvider('admin', oaId, { sources: { openai: async () => { throw new Error('不该被叫'); } } }), null);
  assert.equal(D.syncable(get(orId)), true);
  // 释放后又是普通服务：照常巡检
  const plain = P.createProvider({ name: '普通兼容', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://gw6.example.com/v1', models: [] }, 'admin');
  assert.equal(D.syncable(get(plain.id)), true);
  P.deleteProvider(plain.id, 'admin');
});

test('remove：删掉托管服务连 Key；没有回 null', () => {
  const id = H.list().find((x) => x.hubRef === REF.c).id;
  assert.equal(keyOf(id), 'fal-test-key-DDDD');
  assert.deepEqual(H.remove(REF.c), { id });
  assert.equal(get(id), null);
  assert.equal(P.providerSecret({ id, owner: 'admin' }).key, '', 'Key 一起清');
  assert.equal(H.remove(REF.c), null);
});

// —— detect ——
test('detect：OpenAI 兼容地址列上游模型（只回有种类的，不带 OpenAI 官方内置卡），带上 Key 与请求头；不落盘', async () => {
  const before = H.list().length;
  await withFetch((url) => (url === 'https://relay2.example.com/v1/models'
    ? reply(200, { data: [{ id: 'gpt-image-2' }, { id: 'tts-1-hd' }, { id: 'sora-2' }, { id: 'gpt-5' }, { id: 'gpt-image-2' }] })
    : reply(404, { error: 'nope' })), async (calls) => {
    const r = await H.detect({ baseUrl: 'https://relay2.example.com/v1/', apiKey: 'relay2-test-key', authStyle: 'bearer', headers: [{ name: 'X-Org', value: 'o1' }] });
    assert.equal(r.dialect, 'openai'); assert.equal(r.preset, 'openai-compat');
    assert.deepEqual(r.kinds, DIALECT_KINDS.openai);
    assert.deepEqual(r.models, [{ id: 'gpt-image-2', label: 'gpt-image-2', kind: 'image' }, { id: 'tts-1-hd', label: 'tts-1-hd', kind: 'speech' }, { id: 'sora-2', label: 'sora-2', kind: 'video' }]);
    assert.equal(calls.length, 1);
    const h = Object.fromEntries(Object.entries(calls[0].headers).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(h.authorization, 'Bearer relay2-test-key'); assert.equal(h['x-org'], 'o1');
  });
  assert.equal(H.list().length, before, 'detect 不落盘');
});

test('detect：OpenRouter 官方地址 = 预设内置模型在前 + 上游图像 / 视频目录，去重', async () => {
  await withFetch((url) => (/images\/models$/.test(url) ? reply(200, { data: [{ id: 'google/gemini-3-pro-image', name: 'Google: Nano Banana Pro' }, { id: 'openai/gpt-image-2.6-sunburst', name: 'dup' }] })
    : /videos\/models$/.test(url) ? reply(200, { data: [{ id: 'openai/sora-2', name: 'OpenAI: Sora 2' }] }) : reply(404, {})), async () => {
    const r = await H.detect({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test-detect' });
    assert.equal(r.dialect, 'openrouter');
    const byId = Object.fromEntries(r.models.map((m) => [m.id, m]));
    assert.equal(r.models[0].id, 'openai/gpt-image-2.6-sunburst', '内置在前');
    assert.notEqual(byId['openai/gpt-image-2.6-sunburst'].label, 'dup', '重复的留内置那条');
    assert.equal(byId['google/gemini-3-pro-image'].label, 'Nano Banana Pro');
    assert.equal(byId['openai/sora-2'].kind, 'video');
    assert.equal(new Set(r.models.map((m) => m.id)).size, r.models.length);
  });
});

test('detect：上游列表拉不到不算错（OpenAI 官方回内置卡、兼容地址回空）；Key 被拒 / 连不上抛人话，且抹掉 Key', async () => {
  await withFetch(() => reply(404, { error: { message: 'not found' } }), async () => {
    const off = await H.detect({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-official' });
    assert.equal(off.preset, 'openai');
    assert.ok(off.models.length > 0, 'OpenAI 官方：内置卡兜底');
    assert.ok(off.models.every((m) => DIALECT_KINDS.openai.includes(m.kind)));
    const compat = await H.detect({ baseUrl: 'https://relay3.example.com/v1', apiKey: 'k-test' });
    assert.deepEqual(compat.models, []);
  });
  // 没填 Key：OpenAI 兼容列不了模型，但不算错
  assert.deepEqual((await H.detect({ baseUrl: 'https://relay3.example.com/v1' })).models, []);

  const key = 'sk-test-SECRETKEY-123456';
  await withFetch(() => reply(401, { error: { message: `Incorrect API key provided: ${key}` } }), async () => {
    await assert.rejects(H.detect({ baseUrl: 'https://relay3.example.com/v1', apiKey: key }), (e) => {
      assert.equal(e.status, 400); assert.equal(e.code, 'auth');
      assert.match(e.message, /relay3\.example\.com 拒绝了这个 API Key/);
      assert.ok(!e.message.includes(key), '人话里不带 Key 原文');
      return true;
    });
  });
  await withFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, async () => {
    await assert.rejects(H.detect({ baseUrl: 'https://nowhere.example.com/v1', apiKey: 'k-test' }), (e) => {
      assert.equal(e.status, 502); assert.equal(e.code, 'network');
      assert.match(e.message, /连不上 nowhere\.example\.com/);
      return true;
    });
  });
  await assert.rejects(H.detect({ baseUrl: 'ftp://x.example.com' }), (e) => e.status === 400 && /http/.test(e.message));
});

test('detect / upsert 指名方言：地址认不出也按指名的方言；vertex / local 不收', async () => {
  await withFetch((url) => (/images\/models$/.test(url) ? reply(200, { data: [{ id: 'black-forest-labs/flux-2', name: 'FLUX.2' }] }) : reply(404, {})), async (calls) => {
    const r = await H.detect({ baseUrl: 'https://or-relay.example.com/api/v1', apiKey: 'k-test', dialect: 'openrouter' });
    assert.equal(r.dialect, 'openrouter'); assert.equal(r.preset, 'custom');
    assert.deepEqual(r.models, [{ id: 'black-forest-labs/flux-2', label: 'FLUX.2', kind: 'image' }], '自定义预设不带官方内置模型');
    assert.ok(calls.every((c) => c.url.startsWith('https://or-relay.example.com/api/v1/')));
  });
  await withFetch(() => reply(404, {}), async () => {
    const v = await H.detect({ baseUrl: 'https://relay4.example.com/v1', apiKey: 'k-test', dialect: 'vertex' });
    assert.equal(v.dialect, 'openai', 'vertex 不收：按地址认');
  });
});

test('detect 的报错先抹 Key 再截断：Key 落在第 300 字附近也抹得掉', async () => {
  // 网络层报错原文回显了请求头（undici 拒收非法头值时就是这样）：Key 从第 286 字开始，先截 300 再抹会漏出前 14 位
  const key = 'sk-test-LEAKY-0123456789abcdef';
  const pad = 'x'.repeat(280);
  await withFetch(() => { throw new TypeError(pad + key); }, async () => {
    await assert.rejects(H.detect({ baseUrl: 'https://relay3.example.com/v1', apiKey: key }), (e) => {
      assert.equal(e.code, 'network');
      assert.ok(!e.message.includes('LEAKY'), '半截 Key 也不出现');
      return true;
    });
  });
});

test('收编停用的、带停用与备选模型的服务：adopt 回 enabled / shared / parked；原样 upsert 后 Studio 侧的启用、模型清单、请求头不变', async () => {
  const S = await import('./discovery/store.mjs');
  const src = P.createProvider({
    name: '我的 fal', preset: 'fal', dialect: 'fal', baseUrl: 'https://queue.fal.run', apiKey: 'fal-test-key-GGGG',
    enabled: false, shared: true, headers: { X_Trace_Id: 'abc', 'X-Title': 'ok' },
    models: [
      { id: 'fal-ai/flux/dev', kind: 'image', enabled: true, card: 'fal:test-card', defaults: { steps: 30 } },
      { id: 'fal-ai/kling-video', kind: 'video', enabled: true, shelf: true, defaults: { duration: 5 } },
      { id: 'fal-ai/old-model', kind: 'image', enabled: false, card: 'fal:old-card', defaults: { seed: 1 } },
      { id: 'fal-ai/tts', kind: 'speech', enabled: true, shelf: true },
      { id: 'fal-ai/retired', kind: 'image', enabled: true, gone: true },
    ],
  }, 'admin');
  const snap = JSON.stringify(get(src.id).models);
  const a = H.adopt(src.id, REF.g);
  assert.equal(a.enabled, false, '停用的照实回');
  assert.equal(a.shared, true);
  assert.deepEqual(a.models.map((m) => m.id), ['fal-ai/flux/dev']);
  assert.deepEqual(a.parked, [
    { id: 'fal-ai/kling-video', label: 'fal-ai/kling-video', kind: 'video' },
    { id: 'fal-ai/old-model', label: 'fal-ai/old-model', kind: 'image' },
    { id: 'fal-ai/tts', label: 'fal-ai/tts', kind: 'speech' },
  ], '停用或备选、没下架的');
  assert.deepEqual(a.headers, [{ name: 'X_Trace_Id', value: 'abc' }, { name: 'X-Title', value: 'ok' }]);

  // 模型中心第一次同步：把收编时拿到的原样推回来（Key 也推一遍）
  kicked.length = 0;
  const r = H.upsert({ hubRef: REF.g, name: a.name, baseUrl: a.baseUrl, authStyle: a.authStyle, headers: a.headers, apiKey: a.apiKey,
    enabled: a.enabled, shared: a.shared, models: a.models });
  assert.equal(r.id, src.id); assert.equal(r.created, false); assert.deepEqual(r.skipped, []);
  let p = get(src.id);
  assert.equal(p.enabled, false, '没被悄悄重新启用');
  assert.equal(p.shared, true);
  assert.equal(p.authStyle, 'fal-key');
  assert.deepEqual(p.headers, { X_Trace_Id: 'abc', 'X-Title': 'ok' });
  assert.equal(JSON.stringify(p.models), snap, '模型清单原样：备选、停用、下架的都在，卡、默认参数、来源不变');
  assert.deepEqual(S.getSyncState('admin', src.id)?.dismissed || [], [], '没有记成「已删除」');
  assert.equal(keyOf(src.id), 'fal-test-key-GGGG');
  assert.deepEqual(kicked, [], '停用着：不补 schema');
  // 只改名再同步：照样不动
  H.upsert({ hubRef: REF.g, name: '我的 fal（托管）', enabled: false, models: a.models });
  assert.equal(JSON.stringify(get(src.id).models), snap);

  // 在模型中心把备选的勾进主列表：启用、不再是备选，默认参数留着；别的照留
  H.upsert({ hubRef: REF.g, models: [...a.models, { id: 'fal-ai/kling-video', kind: 'video' }] });
  p = get(src.id);
  const k = p.models.find((m) => m.id === 'fal-ai/kling-video');
  assert.equal(k.shelf, undefined); assert.equal(k.enabled, true); assert.deepEqual(k.defaults, { duration: 5 });
  assert.deepEqual(ids(p), ['fal-ai/flux/dev', 'fal-ai/kling-video', 'fal-ai/old-model', 'fal-ai/tts', 'fal-ai/retired']);
  // 再从主列表移出：它已经是启用的主列表条目，照常移出并记下
  H.upsert({ hubRef: REF.g, models: a.models });
  assert.deepEqual(ids(get(src.id)), ['fal-ai/flux/dev', 'fal-ai/old-model', 'fal-ai/tts', 'fal-ai/retired']);
  assert.deepEqual(S.getSyncState('admin', src.id).dismissed, ['fal-ai/kling-video']);

  // 换方言（fal → OpenRouter）：留着的条目去掉卡、清空默认参数；新方言做不了的种类（配音）不留
  const r2 = H.upsert({ hubRef: REF.g, baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'fal-ai/flux/dev', kind: 'image' }] });
  assert.equal(r2.dialect, 'openrouter');
  p = get(src.id);
  assert.deepEqual(ids(p), ['fal-ai/flux/dev', 'fal-ai/old-model', 'fal-ai/retired']);
  const old = p.models.find((m) => m.id === 'fal-ai/old-model');
  assert.equal(old.enabled, false); assert.equal(old.card, undefined); assert.deepEqual(old.defaults, {});
  assert.equal(p.models.find((m) => m.id === 'fal-ai/retired').gone, true);
  H.remove(REF.g);
});

test('upsert 带 shared：新建按给的（缺省不共享）；更新时给了布尔才改', () => {
  const r = H.upsert({ hubRef: REF.h, name: '共享给成员的', baseUrl: 'https://relay7.example.com/v1', shared: true, models: [] });
  assert.equal(r.created, true); assert.equal(get(r.id).shared, true);
  H.upsert({ hubRef: REF.h, name: '改名' });
  assert.equal(get(r.id).shared, true, '没给 shared：不动');
  H.upsert({ hubRef: REF.h, shared: false });
  assert.equal(get(r.id).shared, false);
  H.upsert({ hubRef: REF.h, shared: 'yes' });
  assert.equal(get(r.id).shared, false, '不是布尔：不动');
  H.upsert({ hubRef: REF.h, shared: true });
  assert.equal(get(r.id).shared, true);
  assert.equal(H.list().find((x) => x.id === r.id).shared, true);
  H.remove(REF.h);
});

test('收尾：托管服务的前端视图带 managed / hubRef，普通的是 false / 空串', () => {
  for (const p of P.listProviders('admin')) {
    assert.equal(typeof p.managed, 'boolean');
    if (p.managed) assert.match(p.hubRef, /^h-[0-9a-f]{8}$/); else assert.equal(p.hubRef, '');
    assert.equal(p.managedBy, p.managed ? 'hub' : undefined);
  }
  H._setSchemaRefreshForTests(null);
});

test('内置媒体服务（Vertex / 本机）：只列不托管的这两种；setBuiltin 改启停、共享、逐个模型开关（打开的移出备选），别的服务一律 404', () => {
  const vx = P.createProvider({ name: 'Vertex 内置', preset: 'vertex', dialect: 'vertex', google: { project: 'demo-proj' }, shared: false,
    models: [{ id: 'imagen-x', kind: 'image', enabled: true }, { id: 'veo-x', kind: 'video', enabled: false }, { id: 'lyria-x', kind: 'music', enabled: true, shelf: true }] }, 'admin');
  const lc = P.createProvider({ name: '本机内置', preset: 'local', dialect: 'local', models: [{ id: 'qwen-local-x', kind: 'image', enabled: true }] }, 'admin');
  const list = H.builtins();
  const mine = list.filter((b) => b.id === vx.id || b.id === lc.id);
  assert.equal(mine.length, 2);
  assert.ok(list.every((b) => b.dialect === 'vertex' || b.dialect === 'local'));
  const v = mine.find((b) => b.id === vx.id);
  assert.deepEqual(v.models.map((m) => [m.id, m.enabled]), [['imagen-x', true], ['veo-x', false], ['lyria-x', false]], '备选的算没打开');
  const after = H.setBuiltin(vx.id, { shared: true, models: { 'veo-x': true, 'lyria-x': true, 'imagen-x': false, nope: true } });
  assert.deepEqual(after.models.map((m) => [m.id, m.enabled]), [['imagen-x', false], ['veo-x', true], ['lyria-x', true]]);
  assert.equal(after.shared, true);
  assert.notEqual(get(vx.id).models.find((m) => m.id === 'lyria-x').shelf, true, '打开的移出备选');
  assert.equal(H.setBuiltin(lc.id, { enabled: false }).enabled, false);
  const plain = P.createProvider({ name: '普通', preset: 'openai-compat', dialect: 'openai', baseUrl: 'https://gw9.example.com/v1', models: [] }, 'admin');
  assert.throws(() => H.setBuiltin(plain.id, { enabled: false }), (e) => e.status === 404);
  assert.throws(() => H.setBuiltin('p-00000000', {}), (e) => e.status === 404);
  for (const id of [vx.id, lc.id, plain.id]) P.deleteProvider(id, 'admin');
});
