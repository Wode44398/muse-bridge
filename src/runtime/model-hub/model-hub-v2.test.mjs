// 模型中心 v2（2026-11-10，契约 §5）：v1 升级与备份、每个模型自己的去向、assign 的校验与原子性、识别（协议 / 修地址 / Key 无效 /
// 列不出 / OpenRouter 补充目录）、目录合并与手动添加、Media Studio 同步与回滚、三种收编、HTTP 路由。
// 修复轮：和 Studio 对账（待删 / 孤儿 / studioDirty 补推）、收编照抄启停与共享、老前端 update 的翻译、Claude 的上下文下限、
// 坏 Key（换行 / 空白 / 非 Latin-1）与请求头报错不回显、Key 存储读不出来时拒写、总览 v:2 与 studioErr。
// 上游是本机假服务，Studio 桥是假桥（_setStudioBridgeForTests），数据根是临时目录：不联网、不碰真实数据与 Key。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-model-hub-v2-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
delete process.env.VERTEX_PROJECT;

const S = await import('../model-services.mjs');
const R = await import('./registry.mjs');
const G = await import('./gateway.mjs');
const C = await import('./catalog.mjs');
const L = await import('./studio-link.mjs');
const D = await import('./detect.mjs');
const O = await import('./overview.mjs');
const P = await import('../claude-providers.mjs');
const PO = await import('./pool.mjs');
const PR = await import('./probe.mjs');
const { SECRETS_FILE } = await import('../../extension-secrets.mjs');
const { createRouter } = await import('../router.mjs');
const { registerModelHubRoutes } = await import('../../routes/model-hub.mjs');

// 测试里出现过的全部 Key：任何返回值、视图、响应里都不许出现（坏 Key 只列换行 / 空白前的那段：JSON 里换行是 \n）
const SECRETS = ['k-good', 'k-bad-777', 'k-empty', 'k-ant-x', 'k-ant-b', 'k-or-555', 'fal-key-123456', 'k-claude-123456', 'k-dim-123456', 'k-new-999',
  'fal-key-ffff66', 'fal-badkey-77', 'k-nl-aaaa', 'k-sp-aaaa', 'k-zh-aaaa'];
const noKey = (v, where) => { const t = JSON.stringify(v); for (const k of SECRETS) assert.ok(!t.includes(k), `${where} 里漏了 Key「${k}」`); };

// —— 假上游 ——
const hits = [];
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const xkey = req.headers['x-api-key'] || '';
  hits.push({ path: u.pathname, search: u.search, bearer, xkey });
  const send = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (u.pathname === '/v1/models') {
    if (bearer === 'k-good') return send(200, { data: [{ id: 'gpt-x' }, { id: 'deepseek-v4-pro' }, { id: 'gpt-image-1' }, { id: 'text-embedding-3-small' }, { id: 'bad?id' }, { id: 'suno-v4' }] });
    if (bearer === 'k-empty') return send(200, { data: [] });
    return send(401, { error: { message: 'invalid key ' + (bearer || xkey) } });   // 故意回显 Key：识别不能把它带出去
  }
  if (u.pathname === '/anthropic/v1/models') {
    if (xkey === 'k-ant-x') return send(200, { data: [{ id: 'claude-x-1', display_name: 'Claude X' }] });
    if (bearer === 'k-ant-b') return send(200, { data: [{ id: 'claude-x-2' }] });
    return send(401, {});
  }
  if (u.pathname === '/or/api/v1/models') {
    if (bearer !== 'k-or-555') return send(401, {});
    const mod = u.searchParams.get('output_modalities');
    if (!mod) return send(200, { data: [{ id: 'openai/gpt-x' }] });
    if (mod === 'image') return send(200, { data: [{ id: 'google/gemini-2.5-flash-image' }] });
    if (mod === 'audio') return send(200, { data: [{ id: 'openai/gpt-4o-mini-tts' }] });
    return send(500, {});
  }
  send(404, {});
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${upstream.address().port}`;
// 一个关着的端口：连不上
const closedPort = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// —— 假 Studio 桥 ——
const calls = [];
// store：hubRef → 托管服务 { id, dialect, name, baseUrl, enabled, shared, headers, apiKey, models }（同真桥：upsert 不带 apiKey 就沿用存着的）
// removeFail / listFail：让 remove / list 抛错
const studio = { fail: '', detectFail: false, removeFail: '', listFail: false, skip: [], store: new Map() };
const FAL = { id: 'p-aaaa1111', name: 'Fal', dialect: 'fal', preset: 'fal', baseUrl: 'https://fal.run', host: 'fal.run', enabled: true, shared: false, hasKey: true, keyTail: '3456', managed: false, hubRef: '', kinds: { image: 1, video: 1, speech: 0, music: 0 }, models: 2 };
const managedEntry = (id, over = {}) => ({ id, dialect: 'openai', name: '托管的', baseUrl: 'https://x.example', enabled: true, shared: false, headers: [], apiKey: '', models: [], ...over });
const fakeBridge = {
  list: () => {
    if (studio.listFail) throw new Error('providers.json 读不出来');
    return [
      FAL,
      { id: 'p-bbbb2222', name: 'Vertex', dialect: 'vertex', preset: 'vertex', baseUrl: '', host: '', enabled: true, shared: false, hasKey: true, keyTail: '', managed: false, hubRef: '', kinds: { image: 3, video: 0, speech: 1, music: 0 }, models: 4 },
      ...[...studio.store.entries()].map(([hubRef, v]) => ({
        id: v.id, name: v.name, dialect: v.dialect, preset: v.dialect, baseUrl: v.baseUrl, host: 'x', enabled: v.enabled !== false, shared: v.shared === true,
        hasKey: !!v.apiKey, keyTail: v.apiKey ? v.apiKey.slice(-4) : '', managed: true, hubRef, kinds: { image: v.models.length, video: 0, speech: 0, music: 0 }, models: v.models.length,
      })),
    ];
  },
  dialectFor: (u) => (/fal\.run/.test(String(u)) ? { dialect: 'fal', preset: 'fal', kinds: ['image', 'video', 'speech', 'music'] }
    : /generativelanguage/.test(String(u)) ? { dialect: 'gemini', preset: 'gemini', kinds: ['image', 'video', 'speech', 'music'] }
      : { dialect: 'openai', preset: 'openai-compat', kinds: ['image', 'video', 'speech'] }),
  async detect({ baseUrl, apiKey }) {
    calls.push(['detect', baseUrl]);
    if (studio.detectFail) throw new Error(`上游说 Key ${apiKey} 不对`);   // 故意回显 Key
    return { dialect: 'openai', kinds: ['image', 'video', 'speech'], models: apiKey === 'k-good' ? [{ id: 'dall-e-3', label: 'DALL·E 3', kind: 'image' }, { id: 'tts-1', kind: 'speech' }] : [] };
  },
  upsert(input) {
    calls.push(['upsert', structuredClone(input)]);
    if (studio.fail) throw new Error(studio.fail);
    const cur = studio.store.get(input.hubRef) || { id: 'p-' + randomBytes(4).toString('hex'), dialect: 'openai' };
    studio.store.set(input.hubRef, {
      ...cur, name: input.name, baseUrl: input.baseUrl, enabled: input.enabled, shared: input.shared, headers: input.headers, models: input.models,
      ...('apiKey' in input ? { apiKey: input.apiKey } : {}),
    });
    return { id: cur.id, dialect: cur.dialect, created: true, skipped: input.models.filter((m) => studio.skip.includes(m.id)).map((m) => ({ id: m.id, reason: '这个方言做不了' })) };
  },
  adopt(id, hubRef) {
    calls.push(['adopt', id, hubRef]);
    const base = { name: 'Fal', dialect: 'fal', preset: 'fal', baseUrl: 'https://fal.run', authStyle: '', headers: [], apiKey: 'fal-key-123456', enabled: true, shared: false, parked: [],
      models: [{ id: 'fal-ai/flux/dev', label: 'Flux', kind: 'image' }, { id: 'fal-ai/kling-video', label: 'Kling', kind: 'video' }] };
    if (id === 'p-aaaa1111') { studio.store.set(hubRef, managedEntry(id, { dialect: 'fal', name: 'Fal', baseUrl: base.baseUrl, apiKey: base.apiKey, models: base.models })); return { id, ...base }; }
    if (id === 'p-cccc3333') return { id, ...base, name: 'Gemini 媒体', dialect: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', authStyle: 'goog', models: [{ id: 'imagen-4', kind: 'image' }] };
    if (id === 'p-dddd4444') return { id, ...base, baseUrl: 'not a url' };   // 抄过来建不成：要取消托管
    if (id === 'p-ffff6666') {
      // 停用着、共享给成员、带自定义请求头（名字里有 _ 和 .）、还有停用 / 备选的模型（parked）
      const f = { id, ...base, name: '停用的 Fal', enabled: false, shared: true, apiKey: 'fal-key-ffff66',
        headers: [{ name: 'X_Tenant', value: 't-1' }, { name: 'x.trace', value: 'on' }, { name: 'bad name', value: 'x' }],
        models: [{ id: 'fal-ai/flux/dev', label: 'Flux', kind: 'image' }],
        parked: [{ id: 'fal-ai/old-video', label: '旧视频', kind: 'video' }, { id: 'fal-ai/beta-tts', kind: 'speech' }, { id: 'fal-ai/flux/dev', kind: 'image' }] };
      studio.store.set(hubRef, managedEntry(id, { dialect: 'fal', name: f.name, baseUrl: f.baseUrl, enabled: false, shared: true, headers: f.headers.slice(0, 2), apiKey: f.apiKey, models: f.models }));
      return f;
    }
    if (id === 'p-99990000') return { id, ...base, apiKey: 'fal-badkey-77\nzz' };   // Studio 那边存的 Key 带换行
    throw Object.assign(new Error('没有这个媒体服务'), { status: 404 });
  },
  release(hubRef) { calls.push(['release', hubRef]); studio.store.delete(hubRef); },   // 取消托管：变回普通服务（store 只放托管的）
  remove(hubRef) {
    calls.push(['remove', hubRef]);
    if (studio.removeFail) throw new Error(studio.removeFail);
    studio.store.delete(hubRef);
  },
};
L._setStudioBridgeForTests(fakeBridge);
D._setBrandOverrideForTests((u) => (String(u).includes('/or/') ? { key: 'openrouter', name: 'OpenRouter', logo: 'openrouter.svg', protocol: 'openai' } : undefined));

// —— HTTP 路由 ——
const router = createRouter();
registerModelHubRoutes(router, { identify: (req) => ({ kind: req.headers['x-who'] || 'admin' }) });
const web = http.createServer((q, s) => router.dispatch(q, s));
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${web.address().port}`;
const api = async (method, p, body, who = 'admin') => {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', 'x-who': who }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  noKey(text, `${method} ${p} 的响应`);
  return { status: r.status, j: JSON.parse(text) };
};

after(async () => {
  upstream.close(); web.close();
  await G._stopGatewayForTests();
  L._setStudioBridgeForTests(undefined);
  D._setBrandOverrideForTests(null);
});

const HUB = path.join(tmp, 'hub');
R._resetHubForTests(HUB);
await R.initModelHub();

const pubOf = (sid, agent) => S.modelServices(agent).find((x) => x.sid === sid);
const draft = (key, over = {}) => ({ draft: { baseUrl: UP + '/v1/chat/completions', key, useProxy: false, ...over } });
const lastUpsert = () => [...calls].reverse().find((c) => c[0] === 'upsert')?.[1];
const diskFile = (d = HUB) => JSON.parse(readFileSync(path.join(d, 'services.json'), 'utf8'));
const diskOf = (sid) => diskFile().services.find((s) => s.id === sid);
const pendingOnDisk = (d = HUB) => diskFile(d).pendingStudioRemovals || [];

test('v1 → v2：内存升级、只备份一次原件；原来的型号一律按文本、去向 = 原服务级 agents（发布出去的集合不变）', () => {
  const dir = path.join(tmp, 'hub-v1');
  mkdirSync(dir, { recursive: true });
  const v1 = {
    v: 1, vertex: { enabled: false },
    services: [
      { id: 'h-0000aaaa', name: '老中转', kind: 'openai', baseUrl: UP + '/v1', agents: ['claude', 'dimensio'], useProxy: false,
        models: [{ id: 'gpt-x', label: 'GPT X', contextWindow: 400000 }, 'gpt-image-1', 'whisper-1', { id: 'tiny-ctx', contextWindow: 2048 }],
        lines: [{ id: 'l-0000aaaa', label: '甲', enabled: true }], createdAt: 1 },
      { id: 'h-0000bbbb', name: '老 Gemini', kind: 'gemini', baseUrl: UP + '/v1beta', agents: ['claude', 'dimensio'], models: ['gemini-4-argon'], lines: [{ id: 'l-0000bbbb' }] },
      { id: 'h-0000cccc', name: '只给 Claude', kind: 'anthropic', baseUrl: UP + '/anthropic', agents: ['claude'], models: ['claude-x-1'], lines: [{ id: 'l-0000cccc' }] },
    ],
  };
  const original = JSON.stringify(v1, null, 2);
  writeFileSync(path.join(dir, 'services.json'), original);
  R._resetHubForTests(dir);
  const list = R.listHubServices();
  assert.equal(list.length, 3);
  const bak = path.join(dir, 'services.v1.bak.json');
  assert.equal(readFileSync(bak, 'utf8'), original);
  const [a, b, c] = list;
  // 名字像生图（gpt-image-1）/ 识别（whisper-1）的也照旧按文本：v1 只有文本这一条路，老会话还记着它们；
  // 上下文不够 Claude 用的（tiny-ctx）静默去掉 claude（v1 时 Claude 那边本来也收不下它）
  const both = ['claude', 'dimensio'];
  assert.deepEqual(a.models.map((m) => [m.id, m.kind, m.agents]),
    [['gpt-x', 'text', both], ['gpt-image-1', 'text', both], ['whisper-1', 'text', both], ['tiny-ctx', 'text', ['dimensio']]]);
  assert.equal(a.models[0].contextWindow, 400000);
  assert.equal(a.models[0].label, 'GPT X');
  assert.deepEqual(a.counts, { text: 4, image: 0, video: 0, voice: 0, music: 0 });
  const cat = R.catalogView('h-0000aaaa').models;
  assert.deepEqual(cat.map((m) => [m.id, m.kind, m.source]),
    [['gpt-x', 'text', 'manual'], ['gpt-image-1', 'text', 'manual'], ['whisper-1', 'text', 'manual'], ['tiny-ctx', 'text', 'manual']]);
  assert.deepEqual(b.models[0].agents, ['dimensio']);   // Gemini 协议去掉 claude
  assert.deepEqual(c.models[0].agents, ['claude']);
  assert.ok('agents' in JSON.parse(readFileSync(path.join(dir, 'services.json'), 'utf8')).services[0], '只读不写：升级只在内存里，下次保存才落 v2');
  // 发布：每个 agent 只看到给它的服务；老中转发布出去的型号和 v1 时一样
  R.refreshHub();
  assert.ok(pubOf('h-0000aaaa', 'claude') && pubOf('h-0000cccc', 'claude') && !pubOf('h-0000bbbb', 'claude'));
  assert.ok(pubOf('h-0000aaaa', 'dimensio') && pubOf('h-0000bbbb', 'dimensio') && !pubOf('h-0000cccc', 'dimensio'));
  assert.deepEqual(pubOf('h-0000aaaa', 'claude').models.map((m) => m.id), ['gpt-x', 'gpt-image-1', 'whisper-1']);
  assert.deepEqual(pubOf('h-0000aaaa', 'dimensio').models.map((m) => m.id), ['gpt-x', 'gpt-image-1', 'whisper-1', 'tiny-ctx']);
  // 下次保存写 v:2，服务级 agents 不再存
  R.updateHubService('h-0000aaaa', { name: '老中转 2' });
  const disk = JSON.parse(readFileSync(path.join(dir, 'services.json'), 'utf8'));
  assert.equal(disk.v, 2);
  assert.ok(disk.services.every((s) => !('agents' in s)));
  assert.deepEqual(disk.services[0].models[0].agents, ['claude', 'dimensio']);
  // 再读到一份 v1（比如从备份手动还原过）：备份不被覆盖；目录已经有了的只补没有的（不重复）
  writeFileSync(path.join(dir, 'services.json'), JSON.stringify({ ...v1, services: v1.services.slice(0, 1) }));
  R._resetHubForTests(dir);
  assert.equal(R.listHubServices().length, 1);
  assert.equal(readFileSync(bak, 'utf8'), original);
  assert.deepEqual(R.catalogView('h-0000aaaa').models.map((m) => m.id), ['gpt-x', 'gpt-image-1', 'whisper-1', 'tiny-ctx']);
  R._resetHubForTests(HUB);
  R.refreshHub();
});

test('识别：OpenAI 兼容——贴完整请求地址也认、Studio 的媒体模型并进目录、种类分好', async () => {
  calls.length = 0;
  const r = await R.detectHub(draft('k-good'));
  noKey(r, '识别结果');
  assert.deepEqual(r.conn, { kind: 'openai', baseUrl: UP + '/v1', authStyle: 'bearer', name: new URL(UP).host, brand: null });
  const kinds = Object.fromEntries(r.models.map((m) => [m.id, m.kind]));
  assert.equal(kinds['gpt-x'], 'text');
  assert.equal(kinds['gpt-image-1'], 'image');
  assert.equal(kinds['text-embedding-3-small'], 'other');
  assert.equal(kinds['suno-v4'], 'music');
  assert.equal(kinds['dall-e-3'], 'image');   // Studio 给的
  assert.equal(kinds['tts-1'], 'voice');      // speech → voice
  assert.equal(r.models.find((m) => m.id === 'dall-e-3').source, 'catalog');
  assert.equal(r.models.find((m) => m.id === 'gpt-x').source, 'api');
  assert.deepEqual(r.media, { dialect: 'openai', kinds: ['image', 'video', 'voice'] });
  assert.deepEqual(r.warnings, []);
  assert.ok(calls.some((c) => c[0] === 'detect' && c[1] === UP + '/v1'));
});

test('识别：Anthropic——x-api-key 与只认 Bearer 的中转都能认出来', async () => {
  const a = await R.detectHub({ draft: { baseUrl: UP + '/anthropic', key: 'k-ant-x', useProxy: false } });
  assert.equal(a.conn.kind, 'anthropic');
  assert.equal(a.conn.baseUrl, UP + '/anthropic');
  assert.equal(a.conn.authStyle, 'x-api-key');
  assert.deepEqual(a.models.map((m) => [m.id, m.label]), [['claude-x-1', 'Claude X']]);
  const b = await R.detectHub({ draft: { baseUrl: UP + '/anthropic/v1/messages', key: 'k-ant-b', useProxy: false } });
  assert.equal(b.conn.kind, 'anthropic');
  assert.equal(b.conn.authStyle, 'bearer');
  assert.equal(b.conn.baseUrl, UP + '/anthropic');
  noKey([a, b], '识别结果');
});

test('识别：Key 无效报 400、列不出不算失败、连不上报 502；Studio 的报错抹掉 Key', async () => {
  await assert.rejects(R.detectHub(draft('k-bad-777')), (e) => e.status === 400 && /Key 无效/.test(e.message) && !e.message.includes('k-bad-777'));
  const empty = await R.detectHub(draft('k-empty'));
  assert.deepEqual(empty.models, []);
  assert.ok(empty.warnings.some((w) => /列不出模型清单/.test(w)));
  assert.equal(empty.conn.kind, 'openai');
  await assert.rejects(R.detectHub({ draft: { baseUrl: `http://127.0.0.1:${closedPort}/v1`, key: 'k-good', useProxy: false } }), (e) => e.status === 502 && /连不上/.test(e.message));
  // Studio 识别报错（原文里带着 Key）：主列表照常、报错进 warnings 且抹掉 Key
  studio.detectFail = true;
  let r;
  try { r = await R.detectHub(draft('k-good')); } finally { studio.detectFail = false; }
  noKey(r, 'Studio 报错时的识别结果');
  assert.ok(r.models.some((m) => m.id === 'gpt-x'));
  assert.ok(!r.models.some((m) => m.id === 'dall-e-3'));
  assert.ok(r.warnings.some((w) => /Media Studio 识别媒体模型失败/.test(w)));
  // 草稿里没有地址
  await assert.rejects(R.detectHub({ draft: { key: 'k-good' } }), (e) => e.status === 400);
  await assert.rejects(R.detectHub({}), (e) => e.status === 400);
});

test('识别：地址规范化', () => {
  assert.equal(D.cleanBaseUrl('api.example.com/v1/chat/completions'), 'https://api.example.com/v1');
  assert.equal(D.cleanBaseUrl('https://x.com/v1beta/models/gemini-x:generateContent'), 'https://x.com/v1beta');
  assert.equal(D.cleanBaseUrl('https://x.com/anthropic/v1/messages/'), 'https://x.com/anthropic');
  assert.equal(D.cleanBaseUrl('https://u:p@x.com/v1/models?x=1'), 'https://x.com/v1');
  assert.throws(() => D.cleanBaseUrl('ftp://x.com'), /http/);
  assert.throws(() => D.cleanBaseUrl(''), /地址/);
});

test('识别：OpenRouter 再按出图 / 出视频 / 出音频各拉一次补充目录；拉不到的给提示', async () => {
  const r = await R.detectHub({ draft: { baseUrl: UP + '/or/api/v1', key: 'k-or-555', useProxy: false } });
  noKey(r, '识别结果');
  assert.equal(r.conn.name, 'OpenRouter');
  assert.equal(r.conn.brand.key, 'openrouter');
  const by = Object.fromEntries(r.models.map((m) => [m.id, m]));
  assert.equal(by['openai/gpt-x'].kind, 'text');
  assert.equal(by['google/gemini-2.5-flash-image'].kind, 'image');
  assert.equal(by['google/gemini-2.5-flash-image'].source, 'catalog');
  assert.equal(by['openai/gpt-4o-mini-tts'].kind, 'voice');
  assert.ok(r.warnings.some((w) => /视频模型目录没拉到/.test(w)));
  assert.ok(hits.some((h) => h.path === '/or/api/v1/models' && h.search === '?output_modalities=image'));
});

let X;   // 主测服务：OpenAI 兼容、k-good
let det;
test('按识别结果建服务：每个模型自己的去向，发布时各 agent 只看到给它的模型', async () => {
  det = await R.detectHub(draft('k-good'));
  calls.length = 0;
  const r = R.createHubFromDetect({
    baseUrl: det.conn.baseUrl, kind: det.conn.kind, authStyle: det.conn.authStyle, useProxy: false, key: 'k-good',
    catalog: det.models, media: det.media,
    assign: [{ id: 'gpt-x', agents: ['claude', 'dimensio'] }, { id: 'deepseek-v4-pro', agents: ['dimensio'] }],
  });
  noKey(r, '建服务的返回');
  X = r.service;
  assert.match(X.id, /^h-[0-9a-f]{8}$/);
  assert.equal(X.name, new URL(UP).host);   // 认不出提供商：用主机名
  assert.deepEqual(X.agents, ['claude', 'dimensio']);
  assert.deepEqual(X.counts, { text: 2, image: 0, video: 0, voice: 0, music: 0 });
  assert.equal(X.catalogSize, det.models.length);
  assert.ok(X.detectedAt > 0);
  assert.equal(X.lines.length, 1);
  assert.equal(X.lines[0].label, 'Key 1');
  assert.ok(X.lines[0].hasKey);
  assert.deepEqual(X.media, { dialect: 'openai', kinds: ['image', 'video', 'voice'], providerId: null });
  assert.equal(X.published, true);
  assert.ok(!calls.some((c) => c[0] === 'upsert'), '没有媒体模型不碰 Studio');
  const pub = pubOf(X.id);
  assert.deepEqual(pub.agents, ['claude', 'dimensio']);
  assert.deepEqual(pub.models.map((m) => [m.id, m.agents]), [['gpt-x', ['claude', 'dimensio']], ['deepseek-v4-pro', ['dimensio']]]);
  assert.ok(pub.models.every((m) => !('kind' in m)), 'spec 里不带 kind（Claude 的 normalizeModel 不认）');
  assert.deepEqual(pubOf(X.id, 'claude').models.map((m) => m.id), ['gpt-x']);
  assert.deepEqual(pubOf(X.id, 'dimensio').models.map((m) => m.id), ['gpt-x', 'deepseek-v4-pro']);
  // services.json 里没有 Key、目录在自己的文件里
  const disk = readFileSync(path.join(HUB, 'services.json'), 'utf8');
  assert.ok(!disk.includes('k-good'));
  assert.ok(existsSync(path.join(HUB, 'catalog', X.id + '.json')));
  // 一个模型都不加也能建（之后再 assign）
  const bare = R.createHubFromDetect({ baseUrl: UP + '/v1', kind: 'openai', key: '', catalog: [], assign: [] });
  assert.equal(bare.service.published, false);
  assert.equal(bare.service.lines[0].hasKey, false);
  R.deleteHubV2(bare.service.id);
  assert.throws(() => R.createHubFromDetect({ baseUrl: UP + '/v1', key: 'x', catalog: [] }), /协议/);
  assert.throws(() => R.createHubFromDetect({ baseUrl: UP + '/v1', kind: 'openai', key: 'x', catalog: [], assign: [{ id: 'nope', agents: ['claude'] }] }), /目录里没有/);
});

test('assign：交叉校验（400 + 人话），一条不对整批不生效', () => {
  const bad = (changes, re) => assert.throws(() => R.assignHubModels(X.id, changes), (e) => e.status === 400 && re.test(e.message));
  bad([{ id: 'gpt-x', agents: ['studio'] }], /文本模型不能添加到 Media Studio/);
  bad([{ id: 'bad?id', agents: ['claude'] }], /Claude 不认/);
  bad([{ id: 'gpt-image-1', agents: ['claude'] }], /图像模型只能添加到 Media Studio/);
  bad([{ id: 'text-embedding-3-small', agents: ['dimensio'] }], /不能添加/);
  bad([{ id: 'suno-v4', agents: ['studio'] }], /做不了音乐/);
  bad([{ id: 'gpt-x', agents: ['codex'] }], /不认识的去向/);
  bad([{ id: 'gpt-x', agents: 'claude' }], /去向要是数组/);
  bad([{ id: 'not-in-catalog', agents: ['dimensio'] }], /目录里没有/);
  bad({ id: 'gpt-x' }, /数组/);
  // 原子：前一条合法（移除 deepseek），后一条不合法 → 都不生效
  bad([{ id: 'deepseek-v4-pro', agents: [] }, { id: 'nope', agents: ['claude'] }], /目录里没有/);
  assert.ok(R.getHubService(X.id).models.some((m) => m.id === 'deepseek-v4-pro'));
  // 给 dimensio 没问题（Claude 的规则只管 Claude）
  const r = R.assignHubModels(X.id, [{ id: 'bad?id', agents: ['dimensio'] }]);
  assert.deepEqual(r.service.models.find((m) => m.id === 'bad?id').agents, ['dimensio']);
  // Gemini 协议的服务不能给 Claude
  const g = R.createHubFromDetect({ baseUrl: UP + '/v1beta', kind: 'gemini', key: 'g', catalog: [{ id: 'gemini-4-argon', kind: 'text' }], assign: [] }).service;
  assert.throws(() => R.assignHubModels(g.id, [{ id: 'gemini-4-argon', agents: ['claude', 'dimensio'] }]), /Gemini 协议的服务不能给 Claude/);
  assert.deepEqual(R.assignHubModels(g.id, [{ id: 'gemini-4-argon', agents: ['dimensio'] }]).service.agents, ['dimensio']);
  R.deleteHubV2(g.id);
  // 没有 Studio 桥：媒体去向不可用
  L._setStudioBridgeForTests(null);
  try { bad([{ id: 'gpt-image-1', agents: ['studio'] }], /没有启用 Media Studio/); }
  finally { L._setStudioBridgeForTests(fakeBridge); }
  assert.throws(() => R.assignHubModels('h-00000000', []), (e) => e.status === 404);
});

test('assign：移除 = []；文本全移除就撤掉发布；移除的模型留在目录里（不在目录的补成手动项）', () => {
  let s = R.assignHubModels(X.id, [{ id: 'deepseek-v4-pro', agents: [] }, { id: 'bad?id', agents: [] }]).service;
  assert.deepEqual(s.models.map((m) => m.id), ['gpt-x']);
  assert.ok(R.catalogView(X.id).models.some((m) => m.id === 'deepseek-v4-pro'));
  s = R.assignHubModels(X.id, [{ id: 'gpt-x', agents: [] }]).service;
  assert.equal(s.models.length, 0);
  assert.equal(s.published, false);
  assert.ok(!pubOf(X.id));
  s = R.assignHubModels(X.id, [{ id: 'gpt-x', agents: ['claude', 'dimensio'] }]).service;
  assert.ok(pubOf(X.id, 'claude'));
  // 老接口建的服务：目录被清空后移除型号 → 补进目录当手动项
  const old = R.createHubService({ name: '老形状', kind: 'openai', baseUrl: UP + '/v1', useProxy: false, models: ['deepseek-v4-pro', 'gpt-x'], lines: [{ key: 'k-good' }] });
  assert.deepEqual(old.models.map((m) => m.agents), [['claude', 'dimensio'], ['claude', 'dimensio']]);
  C.writeCatalog(old.id, { models: [] });
  // 已添加但目录里没有的：目录视图补在后面
  assert.deepEqual(R.catalogView(old.id).models.map((m) => [m.id, m.source]), [['deepseek-v4-pro', 'manual'], ['gpt-x', 'manual']]);
  R.assignHubModels(old.id, [{ id: 'deepseek-v4-pro', agents: [] }]);
  assert.deepEqual(C.readCatalog(old.id).models.map((m) => [m.id, m.source]), [['deepseek-v4-pro', 'manual']]);
  R.deleteHubV2(old.id);
});

test('目录：手动加模型 ID；重识别时手动项留着、记 detectedAt', async () => {
  const m = R.catalogAddModel(X.id, { id: 'my-secret-model', kind: 'text', label: '我的模型' }).model;
  assert.deepEqual([m.id, m.kind, m.label, m.source], ['my-secret-model', 'text', '我的模型', 'manual']);
  assert.throws(() => R.catalogAddModel(X.id, { id: 'x', kind: 'other' }), /种类/);
  assert.throws(() => R.catalogAddModel(X.id, { id: 'a b', kind: 'text' }), /不合法/);
  assert.equal(R.catalogAddModel(X.id, { id: 'my-tts', kind: 'speech' }).model.kind, 'voice');
  const before = R.getHubService(X.id).detectedAt;
  await new Promise((r) => setTimeout(r, 5));
  const r = await R.detectHub({ id: X.id });
  noKey(r, '按 id 识别');
  assert.ok(r.models.some((x) => x.id === 'my-secret-model' && x.source === 'manual'));
  assert.ok(r.models.some((x) => x.id === 'gpt-x' && x.source === 'api'));
  const after = R.getHubService(X.id);
  assert.ok(after.detectedAt > before);
  assert.equal(after.catalogSize, r.models.length);
  // 手动加的能 assign
  R.assignHubModels(X.id, [{ id: 'my-secret-model', agents: ['dimensio'] }]);
  assert.ok(pubOf(X.id, 'dimensio').models.some((x) => x.id === 'my-secret-model' && x.label === '我的模型'));
  R.assignHubModels(X.id, [{ id: 'my-secret-model', agents: [] }]);
  await assert.rejects(R.detectHub({ id: 'h-00000000' }), (e) => e.status === 404);
});

test('Media Studio：加媒体模型 → 同步托管服务；Key 只在变了时推；跳过的去掉 studio 去向', () => {
  calls.length = 0;
  let r = R.assignHubModels(X.id, [{ id: 'gpt-image-1', agents: ['studio'] }, { id: 'tts-1', agents: ['studio'] }]);
  noKey(r, 'assign 的返回');
  assert.deepEqual(r.warnings, []);
  let up = lastUpsert();
  assert.equal(up.hubRef, X.id);
  assert.equal(up.baseUrl, UP + '/v1');
  assert.equal(up.authStyle, 'bearer');
  assert.equal(up.apiKey, 'k-good');   // 只推给 Studio（服务端内部）
  assert.deepEqual(up.models, [{ id: 'gpt-image-1', kind: 'image' }, { id: 'tts-1', kind: 'speech' }]);
  const pid = studio.store.get(X.id).id;
  assert.equal(r.service.media.providerId, pid);
  assert.deepEqual(r.service.agents, ['claude', 'dimensio', 'studio']);
  assert.deepEqual(r.service.counts, { text: 1, image: 1, video: 0, voice: 1, music: 0 });
  // 媒体模型不进 model-services
  assert.ok(!pubOf(X.id).models.some((m) => m.id === 'gpt-image-1'));
  // 再加一个：Key 没变不再推
  r = R.assignHubModels(X.id, [{ id: 'dall-e-3', agents: ['studio'] }]);
  up = lastUpsert();
  assert.ok(!('apiKey' in up));
  assert.equal(up.models.length, 3);
  // 只改文本：不碰 Studio
  const n = calls.length;
  R.assignHubModels(X.id, [{ id: 'deepseek-v4-pro', agents: ['dimensio'] }]);
  assert.equal(calls.length, n);
  // Studio 跳过的：这边也去掉
  studio.skip = ['dall-e-3'];
  try {
    r = R.assignHubModels(X.id, [{ id: 'dall-e-3', agents: [] }]);
    r = R.assignHubModels(X.id, [{ id: 'dall-e-3', agents: ['studio'] }]);
  } finally { studio.skip = []; }
  assert.ok(r.warnings.some((w) => /dall-e-3.*没有添加到 Media Studio/.test(w)));
  assert.ok(!r.service.models.some((m) => m.id === 'dall-e-3'));
});

test('Media Studio：推不过去 → 媒体部分撤回、文本部分照常；报错里抹掉 Key', () => {
  studio.fail = '上游炸了：k-good 不对';
  let r;
  try { r = R.assignHubModels(X.id, [{ id: 'gpt-x', agents: ['dimensio'] }, { id: 'dall-e-3', agents: ['studio'] }]); }
  finally { studio.fail = ''; }
  noKey(r, '回滚后的返回');
  assert.ok(r.warnings.some((w) => /同步到 Media Studio 失败/.test(w)));
  assert.ok(r.warnings.some((w) => /撤回/.test(w)));
  assert.deepEqual(r.service.models.find((m) => m.id === 'gpt-x').agents, ['dimensio']);
  assert.ok(!r.service.models.some((m) => m.id === 'dall-e-3'));
  assert.ok(r.service.models.some((m) => m.id === 'gpt-image-1'));   // 原来的媒体模型还在
  const disk = diskOf(X.id);
  assert.ok(!disk.models.some((m) => m.id === 'dall-e-3'), '落盘的也是撤回后的');
  assert.equal(disk.studioDirty, true, '推不过去记 studioDirty');
  // 下一次写操作前照现在的样子补推一次；推成了清掉 studioDirty
  calls.length = 0;
  R.assignHubModels(X.id, [{ id: 'gpt-x', agents: ['claude', 'dimensio'] }]);
  assert.deepEqual(calls.filter((c) => c[0] === 'upsert').map((c) => c[1].models.map((m) => m.id)), [['gpt-image-1', 'tts-1']]);
  assert.ok(!('studioDirty' in diskOf(X.id)));
});

test('update：改名 / 换 Key 同步给 Studio；协议不改；不带 models / agents 的不碰模型', () => {
  calls.length = 0;
  const before = JSON.stringify(R.getHubService(X.id).models);
  let r = R.updateHubV2(X.id, { name: '中转 X', kind: 'gemini' });
  assert.equal(r.service.name, '中转 X');
  assert.equal(r.service.kind, 'openai');
  assert.equal(JSON.stringify(r.service.models), before);
  let up = lastUpsert();
  assert.equal(up.name, '中转 X');
  assert.ok(!('apiKey' in up));
  assert.equal(up.shared, false);
  assert.equal(up.enabled, true);
  const lid = r.service.lines[0].id;
  r = R.updateHubV2(X.id, { lines: [{ id: lid, key: 'k-new-999' }] });
  noKey(r, 'update 的返回');
  up = lastUpsert();
  assert.equal(up.apiKey, 'k-new-999');
  assert.equal(R._hubKeyForTests(X.id, lid), 'k-new-999');
  // 只改策略：不碰 Studio
  const n = calls.length;
  R.updateHubV2(X.id, { strategy: 'round-robin' });
  assert.equal(calls.length, n);
  assert.throws(() => R.updateHubV2(X.id, { lines: [] }), /线路/);
  assert.throws(() => R.updateHubV2('h-00000000', { name: 'x' }), (e) => e.status === 404);
  R.updateHubV2(X.id, { lines: [{ id: lid, key: 'k-good' }], strategy: 'failover' });
});

test('共享给成员：members 一改就同步成 Studio 托管服务的 shared', () => {
  calls.length = 0;
  assert.equal(R.updateHubV2(X.id, { members: true }).service.members, true);
  assert.equal(lastUpsert().shared, true);
  assert.equal(studio.store.get(X.id).shared, true);
  R.updateHubV2(X.id, { members: false });
  assert.equal(lastUpsert().shared, false);
  assert.equal(calls.filter((c) => c[0] === 'upsert').length, 2);
});

test('老前端的 update（服务级 agents + 型号清单）：翻译成只动文本模型的 assign；不合法整次 400、什么都不改', () => {
  const s0 = R.createHubFromDetect({
    name: '老编辑器', baseUrl: UP + '/v1', kind: 'openai', useProxy: false, key: 'k-good', catalog: det.models, media: det.media,
    assign: [{ id: 'gpt-x', agents: ['claude', 'dimensio'] }, { id: 'deepseek-v4-pro', agents: ['dimensio'] }, { id: 'gpt-image-1', agents: ['studio'] }],
  }).service;
  const ids = (s) => s.models.map((m) => [m.id, m.kind, m.agents]);
  calls.length = 0;
  // 去掉 dimensio：只给了 dimensio 的 deepseek 移除（还在目录里），媒体模型不动、不碰 Studio
  let s = R.updateHubV2(s0.id, { agents: ['claude'] }).service;
  assert.deepEqual(ids(s), [['gpt-x', 'text', ['claude']], ['gpt-image-1', 'image', ['studio']]]);
  assert.ok(C.readCatalog(s0.id).models.some((m) => m.id === 'deepseek-v4-pro'));
  assert.ok(pubOf(s0.id, 'claude') && !pubOf(s0.id, 'dimensio'));
  assert.ok(!calls.some((c) => c[0] === 'upsert'));
  // 加回 dimensio、清单里多一个目录里没有的（当手动项补进目录）、改显示名；清单里带着媒体模型的 id 也不碰它；协议照旧
  s = R.updateHubV2(s0.id, {
    agents: ['claude', 'dimensio', 'studio'], kind: 'gemini',
    models: [{ id: 'gpt-x', label: 'GPT X 改' }, { id: 'brand-new', label: '新来的', contextWindow: 64000 }, 'gpt-image-1'],
  }).service;
  assert.equal(s.kind, 'openai');
  assert.deepEqual(ids(s), [['gpt-x', 'text', ['claude', 'dimensio']], ['gpt-image-1', 'image', ['studio']], ['brand-new', 'text', ['claude', 'dimensio']]]);
  assert.equal(s.models[0].label, 'GPT X 改');
  assert.deepEqual([s.models[2].label, s.models[2].contextWindow], ['新来的', 64000]);
  assert.ok(C.readCatalog(s0.id).models.some((m) => m.id === 'brand-new' && m.source === 'manual'));
  assert.ok(pubOf(s0.id, 'dimensio').models.some((m) => m.id === 'brand-new'));
  // 清单里没有的文本模型 = 移除（留在目录里）；没给 agents = 去向不变
  s = R.updateHubV2(s0.id, { models: ['brand-new'] }).service;
  assert.deepEqual(ids(s), [['gpt-image-1', 'image', ['studio']], ['brand-new', 'text', ['claude', 'dimensio']]]);
  assert.equal(s.models[1].contextWindow, 64000);
  assert.equal(s.defaultModel, 'brand-new');
  assert.ok(C.readCatalog(s0.id).models.some((m) => m.id === 'gpt-x'));
  // 不合法：整次 400，名字也没改
  const before = JSON.stringify(R.getHubService(s0.id).models);
  assert.throws(() => R.updateHubV2(s0.id, { name: '不该改', models: ['bad id'] }), (e) => e.status === 400 && /不合法/.test(e.message));
  assert.throws(() => R.updateHubV2(s0.id, { name: '不该改', models: [{ id: 'tiny', contextWindow: 2048 }], agents: ['claude'] }),
    (e) => e.status === 400 && /上下文/.test(e.message));
  assert.equal(R.getHubService(s0.id).name, '老编辑器');
  assert.equal(JSON.stringify(R.getHubService(s0.id).models), before);
  assert.ok(!calls.some((c) => c[0] === 'upsert'), '只动文本模型：一次都没推 Studio');
  R.deleteHubV2(s0.id);
});

test('Claude 至少要 4096 上下文：明确给 Claude 报 400；默认去向（老接口）静默只给 dimensio', () => {
  const c = C.readCatalog(X.id);
  C.writeCatalog(X.id, { ...c, models: [...c.models, { id: 'tiny-ctx', kind: 'text', contextWindow: 4095, source: 'manual' }] });
  const ctxErr = (e) => e.status === 400 && /上下文窗口只有 4095/.test(e.message) && /4096/.test(e.message);
  assert.throws(() => R.assignHubModels(X.id, [{ id: 'tiny-ctx', agents: ['claude', 'dimensio'] }]), ctxErr);
  const s = R.assignHubModels(X.id, [{ id: 'tiny-ctx', agents: ['dimensio'] }]).service;
  assert.deepEqual(s.models.find((m) => m.id === 'tiny-ctx').agents, ['dimensio']);
  assert.equal(pubOf(X.id, 'dimensio').models.find((m) => m.id === 'tiny-ctx').contextWindow, 4095);
  assert.ok(!pubOf(X.id, 'claude').models.some((m) => m.id === 'tiny-ctx'));
  // 已添加的按它自己记的上下文查
  assert.throws(() => R.assignHubModels(X.id, [{ id: 'tiny-ctx', agents: ['claude'] }]), ctxErr);
  R.assignHubModels(X.id, [{ id: 'tiny-ctx', agents: [] }]);
  // 老接口：没带去向的默认两边，Claude 给不了的静默去掉；明确给了 claude 的报 400
  const old = R.createHubService({ name: '小窗口', kind: 'openai', baseUrl: UP + '/v1', useProxy: false, models: [{ id: 'small-a', contextWindow: 2048 }, { id: 'big-b', contextWindow: 8192 }], lines: [{ key: 'k-good' }] });
  assert.deepEqual(old.models.map((m) => [m.id, m.agents]), [['small-a', ['dimensio']], ['big-b', ['claude', 'dimensio']]]);
  assert.throws(() => R.createHubService({ name: '小窗口 2', kind: 'openai', baseUrl: UP + '/v1', models: [{ id: 'small-a', contextWindow: 2048, agents: ['claude'] }], lines: [{ key: 'k-good' }] }),
    (e) => e.status === 400 && /上下文/.test(e.message));
  R.deleteHubV2(old.id);
});

test('Key 里有换行 / 空白 / 非 Latin-1：建、改、识别、测试、拉模型一律 400，Key 不外露、存着的不变', async () => {
  const NL = 'k-nl-aaaa\nbbbb', SP = 'k-sp-aaaa bbbb', ZH = 'k-zh-aaaa密钥';
  const isBad = (e) => e.status === 400 && e.message === PO.BAD_KEY_MSG;
  const n = R.listHubServices().length;
  for (const k of [NL, SP, ZH]) {
    assert.throws(() => R.createHubFromDetect({ baseUrl: UP + '/v1', kind: 'openai', key: k, catalog: [], assign: [] }), isBad);
    assert.throws(() => R.createHubService({ name: '坏 Key', kind: 'openai', baseUrl: UP + '/v1', models: ['gpt-x'], lines: [{ key: k }] }), isBad);
    await assert.rejects(R.detectHub(draft(k)), isBad);
    assert.throws(() => R.lineContext({ draft: { kind: 'openai', baseUrl: UP + '/v1', line: { key: k } } }), isBad);
  }
  assert.equal(R.listHubServices().length, n);
  const lid = R.getHubService(X.id).lines[0].id;
  assert.throws(() => R.updateHubV2(X.id, { name: '不该改', lines: [{ id: lid, key: NL }] }), isBad);
  assert.equal(R._hubKeyForTests(X.id, lid), 'k-good');
  assert.notEqual(R.getHubService(X.id).name, '不该改');
  // 首尾的空白照常去掉，不算坏 Key
  const hits0 = hits.length;
  const ok = await R.detectHub(draft('  k-good\n'));
  assert.equal(ok.conn.kind, 'openai');
  assert.ok(hits.slice(hits0).some((h) => h.bearer === 'k-good'));
  // HTTP：识别 / 测试 / 拉模型
  const dr = (key) => ({ draft: { kind: 'openai', baseUrl: UP + '/v1', useProxy: false, line: { key } } });
  for (const [p, body] of [['/api/model-hub/detect', draft(ZH)], ['/api/model-hub/test', { ...dr(NL), model: 'gpt-x' }], ['/api/model-hub/models', dr(SP)]]) {
    const r = await api('POST', p, body);
    assert.equal(r.status, 400, p);
    assert.equal(r.j.error, PO.BAD_KEY_MSG, p);
  }
});

test('请求头不合法（Key 里有换行、请求头值里有中文）：测试 / 拉模型 / 网关给固定的话；上游回显 Key 的报错先抹后截', async () => {
  const NL = 'k-nl-aaaa\nbbbb';
  const svc = { id: 'h-0000beef', name: '假的', kind: 'openai', baseUrl: UP + '/v1', authStyle: 'bearer', headers: [], useProxy: false, strategy: 'failover', timeoutSec: 30,
    lines: [{ id: 'l-0000beef', label: 'Key 1', baseUrl: '', enabled: true }] };
  const line = svc.lines[0];
  const t = await PR.testLine(svc, line, NL, 'gpt-x');
  noKey(t, '测试线路的结果');
  assert.deepEqual([t.ok, t.error], [false, PO.BAD_HEADER_MSG]);
  await assert.rejects(PR.fetchLineModels(svc, line, NL), (e) => e.status === 400 && e.message === PO.BAD_HEADER_MSG);
  // 请求头的值里有中文（ByteString 报错）：同一句话
  const zh = await PR.testLine({ ...svc, headers: [{ name: 'X-Note', value: '中文' }] }, line, 'k-good', 'gpt-x');
  assert.equal(zh.error, PO.BAD_HEADER_MSG);
  // 网关的 API 池：线路冷却、原因是「Key 不合法」，报错不带 Key
  const pool = PO.makePoolHandler(() => NL);
  await assert.rejects(pool({ service: svc, proto: 'openai', rest: '/models', search: '', method: 'GET', headers: {}, body: null }),
    (e) => e.status === 502 && e.message.includes(PO.BAD_HEADER_MSG) && !e.message.includes('k-nl-aaaa'));
  const st = PO.lineState(svc.id, line.id);
  assert.deepEqual([st.coolWhy, st.lastError], ['Key 不合法', PO.BAD_HEADER_MSG]);
  PO.forgetService(svc.id);
  // 上游把 Key 原样回显、而且 Key 长到跨过截断点：先抹后截，半截 Key 也不漏
  const long = 'k-bad-777' + 'z'.repeat(300);
  await assert.rejects(PR.fetchLineModels(svc, line, long), (e) => e.status === 502 && /HTTP 401/.test(e.message) && !e.message.includes('k-bad-777'));
  assert.equal(PO.scrubKey('前 abcdef 后', 'abcdef'), '前 … 后');
});

test('收编 Media Studio：原地托管、Key 抄过来不外露、媒体模型去向 = studio；建不成就取消托管', () => {
  calls.length = 0;
  const r = R.adoptStudioService('p-aaaa1111');
  noKey(r, '收编的返回');
  const s = r.service;
  assert.equal(s.kind, 'openai');
  assert.equal(s.baseUrl, 'https://fal.run');
  assert.equal(s.authStyle, 'bearer');
  assert.equal(s.lines[0].label, '原 Key');
  assert.ok(s.lines[0].hasKey);
  assert.equal(s.lines[0].keyTail, '…3456');
  assert.equal(R._hubKeyForTests(s.id, s.lines[0].id), 'fal-key-123456');
  assert.deepEqual(s.models.map((m) => [m.id, m.kind, m.agents]), [['fal-ai/flux/dev', 'image', ['studio']], ['fal-ai/kling-video', 'video', ['studio']]]);
  assert.deepEqual(s.media, { dialect: 'fal', kinds: ['image', 'video', 'voice', 'music'], providerId: 'p-aaaa1111' });
  assert.equal(s.published, false);   // 没有文本模型
  assert.deepEqual(R.catalogView(s.id).models.map((m) => m.source), ['catalog', 'catalog']);
  assert.ok(calls.some((c) => c[0] === 'adopt' && c[1] === 'p-aaaa1111' && c[2] === s.id));
  assert.deepEqual([s.enabled, s.members], [true, false]);
  assert.deepEqual(r.warnings, []);
  // Gemini 方言：地址补上 /v1beta、协议 gemini
  const g = R.adoptStudioService('p-cccc3333').service;
  assert.equal(g.kind, 'gemini');
  assert.equal(g.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(g.authStyle, 'goog');
  // 抄过来建不成：取消托管、这边不留半个服务
  const n = R.listHubServices().length;
  assert.throws(() => R.adoptStudioService('p-dddd4444'), /地址/);
  assert.equal(R.listHubServices().length, n);
  assert.ok(calls.some((c) => c[0] === 'release'));
  assert.throws(() => R.adoptStudioService('p-eeee5555'), (e) => e.status === 404);
  assert.throws(() => R.adoptStudioService('../x'), (e) => e.status === 404);
  // Studio 那边存的 Key 带换行：不收（给句能照着做的话、不回显 Key），取消托管
  calls.length = 0;
  assert.throws(() => R.adoptStudioService('p-99990000'), (e) => e.status === 400 && /Media Studio 里把 Key 重新填一遍/.test(e.message) && !e.message.includes('fal-badkey-77'));
  assert.equal(R.listHubServices().length, n);
  assert.ok(calls.some((c) => c[0] === 'release'));
  R.deleteHubV2(g.id);
});

test('收编停用 + 共享着的 Studio 服务：启停、共享、请求头照抄；停用 / 备选的模型只进目录；之后的同步不会把它重新启用', () => {
  const r = R.adoptStudioService('p-ffff6666');
  noKey(r, '收编的返回');
  const f = r.service;
  assert.deepEqual([f.enabled, f.members], [false, true]);
  assert.deepEqual(f.headers, [{ name: 'X_Tenant', value: 't-1' }, { name: 'x.trace', value: 'on' }]);   // 名字里的 _ 和 . 留着
  assert.ok(r.warnings.some((w) => /有 1 个自定义请求头模型中心收不下/.test(w)));
  assert.deepEqual(f.models.map((m) => [m.id, m.agents]), [['fal-ai/flux/dev', ['studio']]]);
  assert.deepEqual(R.catalogView(f.id).models.map((m) => [m.id, m.kind, m.source]),
    [['fal-ai/flux/dev', 'image', 'catalog'], ['fal-ai/old-video', 'video', 'catalog'], ['fal-ai/beta-tts', 'voice', 'catalog']]);
  // 改个不相干的也照常同步：enabled 还是 false、shared 还是 true、请求头还在；parked 不算已添加、不推
  calls.length = 0;
  R.updateHubV2(f.id, { name: f.name });
  const up = lastUpsert();
  assert.deepEqual([up.enabled, up.shared], [false, true]);
  assert.deepEqual(up.headers, f.headers);
  assert.deepEqual(up.models.map((m) => m.id), ['fal-ai/flux/dev']);
  // 启动对账：两边一致，不补推它
  assert.ok(!R.reconcileStudio().synced.includes(f.id));
  // 停用着的服务不发布（本来也没有文本模型），删掉时 Studio 那边一起删
  calls.length = 0;
  R.deleteHubV2(f.id);
  assert.ok(calls.some((c) => c[0] === 'remove' && c[1] === f.id));
});

test('删服务：发布、Key、目录、Studio 的托管服务一起清；没有桥时提醒', () => {
  const fal = R.listHubServices().find((s) => s.media?.providerId === 'p-aaaa1111');
  calls.length = 0;
  const lid = fal.lines[0].id;
  assert.deepEqual(R.deleteHubV2(fal.id).warnings, []);
  assert.ok(calls.some((c) => c[0] === 'remove' && c[1] === fal.id));
  assert.equal(R._hubKeyForTests(fal.id, lid), '');
  assert.ok(!existsSync(path.join(HUB, 'catalog', fal.id + '.json')));
  assert.throws(() => R.catalogView(fal.id), (e) => e.status === 404);
  assert.throws(() => R.deleteHubV2(fal.id), (e) => e.status === 404);
  assert.equal(R.deleteHubService(fal.id), false);
  // 没有桥但托管过：这边删得掉，给一句提醒；Studio 那边的托管服务记进待删（落盘），Studio 回来后启动对账时补删
  const y = R.createHubFromDetect({ baseUrl: UP + '/v1', kind: 'openai', key: 'k-good', useProxy: false, catalog: det.models, media: det.media, assign: [{ id: 'gpt-image-1', agents: ['studio'] }] }).service;
  assert.ok(y.media.providerId);
  assert.ok(studio.store.has(y.id));
  L._setStudioBridgeForTests(null);
  try {
    const w = R.deleteHubV2(y.id).warnings;
    assert.ok(w.some((x) => /没有启用 Media Studio/.test(x) && /启用后会自动删掉/.test(x)));
    assert.deepEqual(pendingOnDisk(), [y.id]);
    assert.equal(R.reconcileStudio().removed.length, 0, '还是没有桥：什么都不做');
  } finally { L._setStudioBridgeForTests(fakeBridge); }
  calls.length = 0;
  const r = R.reconcileStudio();
  assert.deepEqual([r.removed, r.released, r.synced], [[y.id], [], []], '其余的托管服务两边一致，不动');
  assert.ok(calls.some((c) => c[0] === 'remove' && c[1] === y.id));
  assert.ok(!studio.store.has(y.id));
  assert.ok(!('pendingStudioRemovals' in diskFile()));
  // 没托管过的服务：没有桥也算删完，不记待删
  const t = R.createHubFromDetect({ baseUrl: UP + '/v1', kind: 'openai', key: 'k-good', useProxy: false, catalog: det.models, assign: [{ id: 'gpt-x', agents: ['dimensio'] }] }).service;
  L._setStudioBridgeForTests(null);
  try { assert.deepEqual(R.deleteHubV2(t.id).warnings, []); } finally { L._setStudioBridgeForTests(fakeBridge); }
  assert.deepEqual(pendingOnDisk(), []);
});

test('对账：删的时候 Studio 报错 → 记进待删、报错抹掉 Key；还是删不掉就留着；下一次写操作前补删', () => {
  const z = R.createHubFromDetect({ baseUrl: UP + '/v1', kind: 'openai', key: 'k-good', useProxy: false, catalog: det.models, media: det.media, assign: [{ id: 'gpt-image-1', agents: ['studio'] }] }).service;
  assert.ok(studio.store.has(z.id));
  studio.removeFail = 'Studio 删不掉：Key k-good 不对';   // 故意回显 Key
  try {
    const r = R.deleteHubV2(z.id);
    noKey(r, '删服务的返回');
    assert.ok(r.warnings.some((w) => /没删掉.*下次启动或下次改动时会再试/.test(w)));
    assert.deepEqual(pendingOnDisk(), [z.id]);
    assert.ok(!R.listHubServices().some((s) => s.id === z.id), '这边照样删掉');
    // 对账时还是删不掉：留在待删里；它在 Studio 的托管清单里，但在待删里，不当孤儿取消托管
    const rr = R.reconcileStudio();
    assert.deepEqual([rr.removed, rr.released], [[], []]);
    assert.deepEqual(pendingOnDisk(), [z.id]);
    // 新服务的 id 不会撞上待删的
    assert.ok(studio.store.has(z.id));
  } finally { studio.removeFail = ''; }
  calls.length = 0;
  R.assignHubModels(X.id, [{ id: 'deepseek-v4-pro', agents: ['dimensio'] }]);
  assert.ok(calls.some((c) => c[0] === 'remove' && c[1] === z.id));
  assert.ok(!studio.store.has(z.id));
  assert.deepEqual(pendingOnDisk(), []);
});

test('启动对账：孤儿托管服务取消托管；名字 / Key 尾号 / 共享对不上的补推；Studio 那边没了的照本地重建（连 Key）', () => {
  const x0 = R.getHubService(X.id);
  studio.store.set('h-deadbeef', managedEntry('p-0e0e0e0e', { name: '孤儿', apiKey: 'zzzz' }));
  studio.store.set(X.id, { ...studio.store.get(X.id), name: 'Studio 里改的名', apiKey: 'other-key-0000', shared: true });
  calls.length = 0;
  let r = R.reconcileStudio();
  assert.deepEqual(r.released, ['h-deadbeef']);
  assert.ok(calls.some((c) => c[0] === 'release' && c[1] === 'h-deadbeef'));
  assert.deepEqual(r.synced, [X.id]);
  let up = lastUpsert();
  assert.deepEqual([up.name, up.apiKey, up.shared], [x0.name, 'k-good', false]);
  // 再对一次：都对上了，一个都不推
  calls.length = 0;
  r = R.reconcileStudio();
  assert.deepEqual([r.removed, r.released, r.synced], [[], [], []]);
  assert.equal(calls.length, 0);
  // Studio 那边的托管服务没了：照本地重建，Key 一起推（新建的那份没有 Key），providerId 换成新的
  studio.store.delete(X.id);
  calls.length = 0;
  r = R.reconcileStudio();
  assert.deepEqual(r.synced, [X.id]);
  up = lastUpsert();
  assert.equal(up.apiKey, 'k-good');
  const pid = studio.store.get(X.id).id;
  assert.notEqual(pid, x0.media.providerId);
  assert.equal(R.getHubService(X.id).media.providerId, pid);
});

test('对账：services.json 坏了 / 有服务没读出来时不取消托管；待删的服务又回来了就不删', () => {
  const saved = studio.store;
  try {
    const bad = path.join(tmp, 'hub-suspect');
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, 'services.json'), '{ 坏了');
    R._resetHubForTests(bad);
    studio.store = new Map([['h-deadbeef', managedEntry('p-11112222')]]);
    calls.length = 0;
    let r = R.reconcileStudio();
    assert.deepEqual(r.released, []);
    assert.ok(!calls.some((c) => c[0] === 'release'));
    assert.equal(readFileSync(path.join(bad, 'services.json'), 'utf8'), '{ 坏了', '对账不写盘');
    const part = path.join(tmp, 'hub-partial');
    mkdirSync(part, { recursive: true });
    writeFileSync(path.join(part, 'services.json'), JSON.stringify({
      v: 2, vertex: { enabled: false },
      services: [
        { id: 'h-0badf00d', name: '', kind: 'openai', baseUrl: UP + '/v1', lines: [] },   // 没名字：读不出来
        { id: 'h-00c0ffee', name: '回来了', kind: 'openai', baseUrl: UP + '/v1', lines: [{ id: 'l-00c0ffee' }], models: [] },
      ],
      pendingStudioRemovals: ['h-00c0ffee', 'h-0000dead', 'junk'],
    }));
    R._resetHubForTests(part);
    studio.store = new Map([
      ['h-0badf00d', managedEntry('p-22223333')], ['h-deadbeef', managedEntry('p-33334444')],
      ['h-00c0ffee', managedEntry('p-44445555')], ['h-0000dead', managedEntry('p-55556666')],
    ]);
    r = R.reconcileStudio();
    assert.deepEqual(r.removed, ['h-0000dead']);
    assert.deepEqual(r.released, ['h-deadbeef']);
    assert.deepEqual([...studio.store.keys()], ['h-0badf00d', 'h-00c0ffee']);
    assert.deepEqual(pendingOnDisk(part), []);
  } finally { studio.store = saved; R._resetHubForTests(HUB); R.refreshHub(); }
});

test('Key 存储读不出来：要写 Key 的改动一律 500（不拿空表把已存的 Key 覆盖掉）；不动 Key 的照常', () => {
  const dir = path.join(tmp, 'hub-badkeys');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'services.json'), JSON.stringify({ v: 2, vertex: { enabled: false }, services: [
    { id: 'h-00badbad', name: '有 Key 的', kind: 'openai', baseUrl: UP + '/v1', lines: [{ id: 'l-00badbad', label: 'Key 1' }], models: [{ id: 'gpt-x', kind: 'text', agents: ['dimensio'] }] },
  ] }));
  const garbage = '{"alg":"aes-256-gcm","iv":"x","tag":"y","data":"z"}';   // 没有数据密钥文件：解不开
  writeFileSync(path.join(dir, SECRETS_FILE), garbage);
  R._resetHubForTests(dir);
  try {
    const is500 = (e) => e.status === 500 && /Key 存储读不出来/.test(e.message);
    assert.throws(() => R.updateHubV2('h-00badbad', { lines: [{ id: 'l-00badbad', key: 'k-new-999' }] }), is500);
    assert.throws(() => R.createHubService({ name: '新的', kind: 'openai', baseUrl: UP + '/v1', models: ['gpt-x'], lines: [{ key: 'k-good' }] }), is500);
    assert.throws(() => R.deleteHubV2('h-00badbad'), is500);
    assert.equal(readFileSync(path.join(dir, SECRETS_FILE), 'utf8'), garbage);
    assert.deepEqual(R.listHubServices().map((s) => s.id), ['h-00badbad']);
    assert.equal(R.getHubService('h-00badbad').lines[0].hasKey, false);   // 读的地方当作没有 Key
    assert.equal(R.updateHubV2('h-00badbad', { name: '改名照常' }).service.name, '改名照常');
  } finally { R._resetHubForTests(HUB); R.refreshHub(); }
});

// 两个 agent 看到的地址都是本机网关：发布时带上请求实际发到的上游主机，官方 Anthropic 才有提示缓存，OpenRouter 的型号才按它的写法给档位
test('发布带上游主机：官方 Anthropic 开提示缓存；OpenRouter 的型号按线路给档位；线路混挂不认', () => {
  const official = R.createHubService({ name: '官方 API', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5'], lines: [{ key: 'k-good' }] });
  const pa = pubOf(official.id, 'claude');
  assert.equal(pa.upstream, 'api.anthropic.com');
  assert.deepEqual(pa.compat, { promptCaching: true, slimBody: false, stripBetas: false });

  const or = R.createHubService({
    name: 'OpenRouter 线', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-v4.1-flash', 'openai/gpt-6.1-sol', 'qwen/qwen3.8-max-0902', { id: 'google/gemini-4-argon', contextWindow: 1048576, maxOutput: 943718 }, { id: 'x-ai/grok-4.7', contextWindow: 2000000, maxOutput: 30000 }],
    lines: [{ key: 'k-good' }],
  });
  const po = pubOf(or.id, 'dimensio');
  assert.equal(po.upstream, 'openrouter.ai');
  assert.deepEqual(po.compat, {});
  const m = (id) => po.models.find((x) => x.id === id);
  assert.deepEqual(m('deepseek/deepseek-v4.1-flash').efforts.map((t) => [t.id, t.value]), [['off', 'none'], ['low', 'low'], ['high', 'high'], ['max', 'max']]);
  assert.deepEqual(m('openai/gpt-6.1-sol').efforts.map((t) => t.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(m('openai/gpt-6.1-sol').effortDefault, 'medium');
  assert.equal(m('openai/gpt-6.1-sol').alwaysThinks, false, '不标恒思考：那会开始回传 reasoning_content');
  assert.deepEqual(m('qwen/qwen3.8-max-0902').efforts.map((t) => t.id), ['low', 'medium', 'xhigh']);
  assert.equal(m('google/gemini-4-argon').maxOutput, 32768, 'OpenRouter 报的「窗口九成」不是真实输出上限，表里有真值用表里的');
  assert.equal(m('x-ai/grok-4.7').maxOutput, 30000, '表里没有真值、或不是九成窗口的，照登记值');
  assert.deepEqual(m('x-ai/grok-4.7').efforts.map((t) => t.id), ['low', 'medium', 'high', 'xhigh']);

  // 同一个型号走厂商直连的服务：还是厂商自己的写法
  const direct = R.createHubService({ name: 'DS 直连', kind: 'openai', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash'], lines: [{ key: 'k-good' }] });
  assert.deepEqual(pubOf(direct.id, 'dimensio').models[0].efforts[0].value, { thinking: { type: 'disabled' } });

  // 线路混挂（一条官方、一条中转）：认不出唯一上游，按第三方处理
  const mixed = R.createHubService({ name: '混挂', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5'], lines: [{ key: 'k-good' }, { key: 'k-good', baseUrl: 'https://relay.example.com' }] });
  const pm = pubOf(mixed.id, 'claude');
  assert.equal(pm.upstream, undefined);
  assert.deepEqual(pm.compat, {});

  // 已登记的服务后来改了地址 / 加了别的主机的线路：官方那套待遇要跟着撤掉（发布是把新规格合并到旧规格上，不能留旧值）
  R.updateHubV2(official.id, { baseUrl: 'https://relay.example.com' });
  const moved = pubOf(official.id, 'claude');
  assert.equal(moved.upstream, 'relay.example.com');
  assert.deepEqual(moved.compat, {});
  const off2 = R.createHubService({ name: '官方 API 2', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5'], lines: [{ key: 'k-good' }] });
  assert.equal(pubOf(off2.id, 'claude').upstream, 'api.anthropic.com');
  const lid = R.getHubService(off2.id).lines[0].id;
  R.updateHubV2(off2.id, { lines: [{ id: lid }, { key: 'k-good', baseUrl: 'https://relay.example.com' }] });
  const mixed2 = pubOf(off2.id, 'claude');
  assert.equal(mixed2.upstream, undefined);
  assert.deepEqual(mixed2.compat, {});

  for (const x of [official, or, direct, mixed, off2]) R.deleteHubV2(x.id);
});

test('HTTP：只给管理员、坏 JSON、总览（studio 一栏与 kinds）、识别 / 目录 / 建 / 改 / 删', async () => {
  assert.equal((await api('GET', '/api/model-hub', undefined, 'member')).status, 403);
  assert.equal((await api('GET', '/api/model-hub', undefined, 'none')).status, 401);
  assert.equal((await api('POST', '/api/model-hub/assign', {}, 'member')).status, 403);
  const badJson = await api('POST', '/api/model-hub/assign', '{oops');
  assert.equal(badJson.status, 400);
  assert.match(badJson.j.error, /JSON/);
  O.setDimensioProvidersReader(() => [{ id: 'dp1', name: 'D', protocol: 'openai', host: 'd.example.com', models: 3, shared: false }]);
  try {
    const { status, j } = await api('GET', '/api/model-hub');
    assert.equal(status, 200);
    assert.ok(j.ok && Array.isArray(j.services) && j.vertex);
    assert.equal(j.v, 2);
    assert.ok(!('studioErr' in j));
    assert.deepEqual(j.dimensio[0].kinds, { text: 3 });
    const fal = j.studio.find((x) => x.id === 'p-aaaa1111');
    assert.deepEqual(fal.kinds, { image: 1, video: 1, voice: 0, music: 0 });
    assert.equal(fal.adoptable, true);
    assert.ok(!('keyTail' in fal));
    assert.equal(j.studio.find((x) => x.id === 'p-bbbb2222').adoptable, false);   // vertex 不行
    const managed = j.studio.find((x) => x.managed);
    assert.ok(managed && managed.adoptable === false && /^h-/.test(managed.hubRef));
    const x = j.services.find((s) => s.id === X.id);
    assert.ok(x.brand === null && x.host && typeof x.catalogSize === 'number');
  } finally { O.setDimensioProvidersReader(null); }
  // Studio 的列表读不出来：[] + studioErr（不冒充「一个服务都没有」）；没有 Studio：null、没有 studioErr
  studio.listFail = true;
  try {
    const { status, j } = await api('GET', '/api/model-hub');
    assert.equal(status, 200);
    assert.deepEqual(j.studio, []);
    assert.match(j.studioErr, /读不出 Media Studio 的服务列表/);
    assert.ok(!j.studioErr.includes('providers.json'), '报错原文只进日志');
  } finally { studio.listFail = false; }
  L._setStudioBridgeForTests(null);
  try {
    const { j } = await api('GET', '/api/model-hub');
    assert.equal(j.studio, null);
    assert.ok(!('studioErr' in j));
  } finally { L._setStudioBridgeForTests(fakeBridge); }
  // 识别、建、目录、assign、update、delete
  const d = await api('POST', '/api/model-hub/detect', draft('k-good'));
  assert.equal(d.status, 200);
  assert.equal(d.j.conn.kind, 'openai');
  assert.equal((await api('POST', '/api/model-hub/detect', draft('k-bad-777'))).status, 400);
  const c = await api('POST', '/api/model-hub/create', { name: '路由建的', baseUrl: d.j.conn.baseUrl, kind: 'openai', useProxy: false, key: 'k-good', catalog: d.j.models, media: d.j.media, assign: [{ id: 'gpt-x', agents: ['claude'] }] });
  assert.equal(c.status, 200);
  const sid = c.j.service.id;
  assert.equal(c.j.service.name, '路由建的');
  assert.ok(Array.isArray(c.j.warnings));
  const cat = await api('GET', '/api/model-hub/catalog?id=' + sid);
  assert.equal(cat.status, 200);
  assert.ok(cat.j.at > 0 && cat.j.models.some((m) => m.id === 'gpt-x'));
  assert.equal((await api('GET', '/api/model-hub/catalog')).status, 400);
  assert.equal((await api('GET', '/api/model-hub/catalog?id=h-00000000')).status, 404);
  const add = await api('POST', '/api/model-hub/catalog/add', { id: sid, model: { id: 'route-model', kind: 'text' } });
  assert.equal(add.j.model.source, 'manual');
  assert.equal((await api('POST', '/api/model-hub/catalog/add', { id: sid, model: { id: 'x', kind: 'other' } })).status, 400);
  const as = await api('POST', '/api/model-hub/assign', { id: sid, changes: [{ id: 'route-model', agents: ['dimensio'] }] });
  assert.equal(as.status, 200);
  assert.deepEqual(as.j.service.agents, ['claude', 'dimensio']);
  const asBad = await api('POST', '/api/model-hub/assign', { id: sid, changes: [{ id: 'gpt-x', agents: ['studio'] }] });
  assert.equal(asBad.status, 400);
  assert.match(asBad.j.error, /文本模型不能添加到 Media Studio/);
  const up = await api('POST', '/api/model-hub/update', { id: sid, patch: { name: '改了名' } });
  assert.equal(up.j.service.name, '改了名');
  // 老形状的 create 照常
  const legacy = await api('POST', '/api/model-hub/create', { name: '老', kind: 'openai', baseUrl: UP + '/v1', models: ['gpt-x'], lines: [{ key: 'k-good' }] });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.j.service.models[0].agents, ['claude', 'dimensio']);
  assert.equal((await api('POST', '/api/model-hub/delete', { id: legacy.j.service.id })).status, 200);
  assert.equal((await api('POST', '/api/model-hub/delete', { id: sid })).status, 200);
  assert.equal((await api('POST', '/api/model-hub/delete', { id: sid })).status, 404);
  assert.equal((await api('POST', '/api/model-hub/line/reset', { id: sid, lineId: 'l-00000000' })).status, 404);
});

test('HTTP 收编：Claude / dimensio 的服务照抄、去向 = 两边能给的；Studio 原地收编', async () => {
  // Claude：启用的型号算已添加（改为共用 = 两边都给），停用的放进目录；原服务从菜单里藏起来
  const both = ['claude', 'dimensio'];
  const p = P.createProvider({ name: 'C 中转', protocol: 'openai', baseUrl: UP + '/v1', apiKey: 'k-claude-123456', models: [{ id: 'gpt-x' }, { id: 'old-1', enabled: false }] });
  const a = await api('POST', '/api/model-hub/adopt', { from: 'claude', id: p.id });
  assert.equal(a.status, 200);
  assert.deepEqual(a.j.service.models.map((m) => [m.id, m.kind, m.agents]), [['gpt-x', 'text', both]]);
  assert.deepEqual(a.j.service.agents, both);
  assert.ok(R.catalogView(a.j.service.id).models.some((m) => m.id === 'old-1'));
  assert.equal(R._hubKeyForTests(a.j.service.id, a.j.service.lines[0].id), 'k-claude-123456');
  assert.equal(P.getProvider(p.id, P.HOST_OWNER).showInPicker, false);
  assert.ok(pubOf(a.j.service.id, 'claude') && pubOf(a.j.service.id, 'dimensio'));
  // dimensio：两边能给的都给；id 有 Claude 不认的字符、上下文不够 Claude 用的只给 dimensio；它自己带的 agents 不作数
  O.setDimensioProviderExporter((id) => (id === 'dp1' ? {
    name: 'D 中转', protocol: 'openai', baseUrl: UP + '/v1', authStyle: 'bearer', headers: [], defaultModel: 'deepseek-v4-pro', key: 'k-dim-123456',
    models: [{ id: 'deepseek-v4-pro', contextWindow: 128000, agents: ['dimensio'] }, { id: 'odd?id' }, { id: 'tiny-d', contextWindow: 2048 }],
  } : null));
  try {
    const b = await api('POST', '/api/model-hub/adopt', { from: 'dimensio', id: 'dp1' });
    assert.equal(b.status, 200);
    assert.deepEqual(b.j.service.models.map((m) => [m.id, m.kind, m.agents, m.contextWindow]),
      [['deepseek-v4-pro', 'text', both, 128000], ['odd?id', 'text', ['dimensio'], undefined], ['tiny-d', 'text', ['dimensio'], 2048]]);
    assert.ok(pubOf(b.j.service.id, 'dimensio') && pubOf(b.j.service.id, 'claude'));
    assert.deepEqual(pubOf(b.j.service.id, 'claude').models.map((m) => m.id), ['deepseek-v4-pro']);
    assert.equal((await api('POST', '/api/model-hub/adopt', { from: 'dimensio', id: 'nope' })).status, 404);
  } finally { O.setDimensioProviderExporter(null); }
  // Studio
  const s = await api('POST', '/api/model-hub/adopt', { from: 'studio', id: 'p-aaaa1111' });
  assert.equal(s.status, 200);
  assert.deepEqual(s.j.service.agents, ['studio']);
  assert.equal((await api('POST', '/api/model-hub/adopt', { from: 'studio', id: 'p-eeee5555' })).status, 404);
  assert.equal((await api('POST', '/api/model-hub/adopt', { from: 'codex', id: 'x' })).status, 400);
});
