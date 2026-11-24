// 配方引擎单测：校验、模板、取值路径、跑一遍（mock 全局 fetch，不联网）、试跑记录不漏 Key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecipe } from './normalize.mjs';
import { renderValue, renderString, DROP, parseExpr } from './template.mjs';
import { getPath } from './path.mjs';
import { recipeCard } from './card.mjs';
import { runRecipe, previewRecipe, recipeAdapter } from './run.mjs';
import { RECIPE_EXAMPLES } from './examples.mjs';
import { withTrace } from '../adapters/http.mjs';
import { applySpecs } from '../cards/spec.mjs';

const BASE = 'https://relay.test.example/v1';
const KEY = 'sk-secret-abcdef123456';
const PROVIDER = (over = {}) => ({ id: 'p-test0001', owner: 'admin', dialect: 'openai', name: '中转', baseUrl: BASE, authStyle: 'bearer', headers: {}, timeoutSec: 60, models: [], ...over });
const CTX = (over = {}) => ({ secret: { key: KEY }, signal: new AbortController().signal, progress() {}, submitted() {}, pollMs: 1, ...over });

async function withFetch(handler, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET', init }); return handler(String(url), init, calls); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const binRes = (bytes, type) => new Response(bytes, { status: 200, headers: { 'content-type': type } });

test('示例配方都能通过校验，生成的卡参数合法', () => {
  for (const ex of RECIPE_EXAMPLES) {
    const r = normalizeRecipe(ex.recipe);
    const card = recipeCard(r, { id: 'm', kind: ex.kind });
    assert.equal(card.paramSource, 'recipe');
    assert.equal(card.async, !!r.poll, ex.id);
    for (const s of card.params.filter((x) => x.type === 'enum')) assert.ok(s.options.some((o) => o.value === s.default), `${ex.id} 的 ${s.key}`);
  }
});

test('校验：常见写错都给人话', () => {
  const ok = { submit: { path: '/x', body: {} }, result: { url: '$.u' } };
  assert.equal(normalizeRecipe(null), null);
  assert.throws(() => normalizeRecipe({ result: { url: '$.u' } }), /缺 submit/);
  assert.throws(() => normalizeRecipe({ ...ok, submit: { path: 'https://evil.example/x' } }), /要以 \/ 开头/);
  assert.throws(() => normalizeRecipe({ ...ok, submit: { path: '/a/../b' } }), /不能写别的地址/);
  assert.throws(() => normalizeRecipe({ ...ok, submit: { path: '/x', headers: { Authorization: 'Bearer x' } } }), /鉴权/);
  assert.throws(() => normalizeRecipe({ ...ok, submit: { path: '/x', body: { a: '{{secret}}' } } }), /不认识的占位符/);
  assert.throws(() => normalizeRecipe({ ...ok, submit: { path: '/{{prompt}}' } }), /这里不能用/);
  assert.throws(() => normalizeRecipe({ ...ok, result: { url: '$.u', b64: '$.b' } }), /恰好写一个/);
  assert.throws(() => normalizeRecipe({ ...ok, result: { url: 'data.url' } }), /以 \$ 开头/);
  assert.throws(() => normalizeRecipe({ ...ok, poll: { path: '/q', status: '$.s' } }), /done/);
  assert.throws(() => normalizeRecipe({ ...ok, params: [{ key: 'a', type: 'enum', options: [1], default: 2 }] }), /不在 options/);
  assert.throws(() => normalizeRecipe({ ...ok, weird: 1 }), /不认识「weird」/);
  assert.throws(() => normalizeRecipe({ ...ok, submit: { path: '/x', body: { __proto__x: 1, ['__proto__']: 1 } } }), /不允许/);
  const r = normalizeRecipe(ok);
  assert.equal(r.submit.method, 'POST');
  assert.equal(r.result.from, 'submit');
});

test('模板：整串占位符保留类型、取不到就不发；混排拼字符串；缺省值与过滤器', () => {
  const ctx = { prompt: '猫', model: 'm1', params: { n: 2, size: '', o: { a: 1 } }, inputs: [{ role: 'ref', data: Buffer.from('ab'), mime: 'image/png' }, { role: 'ref', data: Buffer.from('cd'), mime: 'image/png' }] };
  const out = renderValue({
    n: '{{params.n}}', size: '{{params.size}}', d: '{{params.size ?? "1024x1024"}}', s: 'x-{{params.n}}-{{params.miss}}', o: '{{params.o}}',
    imgs: '{{inputs.ref[*].b64}}', first: '{{inputs.ref.b64}}', second: '{{inputs.ref[1].mime}}', cnt: '{{inputs.ref.count}}', none: '{{inputs.edit.dataUrl}}',
    arr: ['{{params.miss}}', '{{prompt}}'], str: '{{params.n | string}}',
  }, ctx);
  assert.deepEqual(out, { n: 2, d: '1024x1024', s: 'x-2-', o: { a: 1 }, imgs: ['YWI=', 'Y2Q='], first: 'YWI=', second: 'image/png', cnt: 2, arr: ['猫'], str: '2' });
  assert.equal(renderString('{{params.miss}}', ctx), DROP);
  assert.equal(renderString('/v/{{prompt}}', ctx, { enc: encodeURIComponent }), '/v/%E7%8C%AB');
  assert.throws(() => parseExpr('params.a | nope'), /不认识的过滤器/);
  assert.throws(() => parseExpr('inputs.foo.b64'), /角色/);
});

test('取值路径：键、下标、负下标、展开、带引号的键；原型链上的键当没有', () => {
  const j = { data: [{ url: 'a' }, { url: 'b' }], 'x y': { z: 1 } };
  assert.equal(getPath(j, '$.data[0].url'), 'a');
  assert.equal(getPath(j, '$.data[-1].url'), 'b');
  assert.deepEqual(getPath(j, '$.data[*].url'), ['a', 'b']);
  assert.equal(getPath(j, "$['x y'].z"), 1);
  assert.equal(getPath(j, '$.constructor'), undefined);
  assert.throws(() => getPath(j, 'data'), /\$ 开头/);
});

test('异步视频：提交 → 轮询到完成 → 下载结果地址；CDN 地址不带 Key', async () => {
  const r = normalizeRecipe(RECIPE_EXAMPLES.find((x) => x.id === 'async-video').recipe);
  const card = recipeCard(r, { id: 'vid-1', kind: 'video' });
  const params = applySpecs(card.params, { duration: 10 });
  let polls = 0;
  await withFetch((url) => {
    if (url.endsWith('/video/create')) return jsonRes({ id: 't1' });
    if (url.includes('/video/query')) { polls++; return jsonRes(polls < 2 ? { status: 'running', progress: 40 } : { status: 'completed', video_url: 'https://cdn.example/v.mp4' }); }
    if (url === 'https://cdn.example/v.mp4') return binRes(Buffer.from('MP4'), 'video/mp4');
    return jsonRes({ error: 'no' }, 404);
  }, async (calls) => {
    const ticks = [];
    const out = await runRecipe(r, { kind: 'video', model: 'vid-1', prompt: '海浪', params, inputs: [{ role: 'first', data: Buffer.from('img'), mime: 'image/png' }] }, PROVIDER(), CTX({ progress: (x) => ticks.push(x) }));
    assert.equal(out.assets.length, 1);
    assert.equal(out.assets[0].mime, 'video/mp4');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { model: 'vid-1', prompt: '海浪', image: 'data:image/png;base64,aW1n', duration: 10, aspect_ratio: '16:9' });
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(calls[1].url, `${BASE}/video/query?id=t1`);
    assert.equal(calls.at(-1).init.headers.Authorization, undefined, 'CDN 不带 Key');
    assert.ok(ticks.some((t) => t.progress === 0.4));
  });
});

test('轮询失败：报上游给的原因；同步 b64 多张；响应本身是文件', async () => {
  const v = normalizeRecipe(RECIPE_EXAMPLES.find((x) => x.id === 'async-video').recipe);
  await withFetch((url) => (url.endsWith('/video/create') ? jsonRes({ id: 't' }) : jsonRes({ status: 'failed', error: '内容违规' })), async () => {
    await assert.rejects(runRecipe(v, { kind: 'video', model: 'm', prompt: 'x', params: {}, inputs: [] }, PROVIDER(), CTX()), /内容违规/);
  });
  const img = normalizeRecipe(RECIPE_EXAMPLES.find((x) => x.id === 'sync-image').recipe);
  await withFetch(() => jsonRes({ data: [{ b64_json: Buffer.from('A').toString('base64') }, { b64_json: Buffer.from('B').toString('base64') }] }), async () => {
    const out = await runRecipe(img, { kind: 'image', model: 'm', prompt: 'x', params: { n: 2 }, inputs: [] }, PROVIDER(), CTX());
    assert.deepEqual(out.assets.map((a) => a.bytes.toString()), ['A', 'B']);
  });
  const sp = normalizeRecipe(RECIPE_EXAMPLES.find((x) => x.id === 'binary-speech').recipe);
  await withFetch(() => binRes(Buffer.from('ID3'), 'audio/mpeg'), async () => {
    const out = await runRecipe(sp, { kind: 'speech', model: 'tts', prompt: '你好', params: {}, inputs: [] }, PROVIDER(), CTX());
    assert.equal(out.assets[0].mime, 'audio/mpeg');
  });
  await withFetch(() => jsonRes({ error: 'x' }), async () => {
    await assert.rejects(runRecipe(sp, { kind: 'speech', model: 'tts', prompt: '你好', params: {}, inputs: [] }, PROVIDER(), CTX()), /不是文件/);
  });
});

test('只发到服务自己的域名：拼出别的域名的轮询地址直接报错，Key 不出门', async () => {
  const r = normalizeRecipe({ submit: { path: '/gen', body: { p: '{{prompt}}' } }, poll: { url: '{{submit.$.status_url}}', status: '$.s', done: ['ok'] }, result: { url: '$.u' } });
  await withFetch(() => jsonRes({ status_url: 'https://evil.example/steal' }), async (calls) => {
    await assert.rejects(runRecipe(r, { kind: 'image', model: 'm', prompt: 'x', params: {}, inputs: [] }, PROVIDER(), CTX()), /不在服务的域名下/);
    assert.ok(calls.every((c) => !c.url.startsWith('https://evil.example')));
  });
});

test('auth 覆盖：自定义请求头 / 查询参数；multipart 带文件；extra 并进 JSON 体', async () => {
  const h = normalizeRecipe({ submit: { path: '/gen', body: { p: '{{prompt}}' } }, result: { b64: '$.b' }, auth: { header: 'X-Token', prefix: 'T ' } });
  const q = normalizeRecipe({ submit: { path: '/gen', body: { p: '{{prompt}}' } }, result: { b64: '$.b' }, auth: { query: 'key' } });
  const mp = normalizeRecipe(RECIPE_EXAMPLES.find((x) => x.id === 'openai-video').recipe);
  await withFetch((url) => (url.endsWith('/content') ? binRes(Buffer.from('V'), 'video/mp4') : url.includes('/videos/') ? jsonRes({ status: 'completed' }) : jsonRes({ id: 'v9', b: 'QQ==' })), async (calls) => {
    await runRecipe(h, { kind: 'image', model: 'm', prompt: 'x', params: { extra: { seed: 3 } }, inputs: [] }, PROVIDER(), CTX());
    assert.equal(calls[0].init.headers['X-Token'], `T ${KEY}`);
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(calls[0].init.body), { p: 'x', seed: 3 });
    await runRecipe(q, { kind: 'image', model: 'm', prompt: 'x', params: {}, inputs: [] }, PROVIDER(), CTX());
    assert.equal(new URL(calls[1].url).searchParams.get('key'), KEY);
    const out = await runRecipe(mp, { kind: 'video', model: 'sora', prompt: 'x', params: { seconds: '8' }, inputs: [{ role: 'first', data: Buffer.from('img'), mime: 'image/png', name: 'a.png' }] }, PROVIDER(), CTX());
    const fd = calls[2].init.body;
    assert.ok(fd instanceof FormData);
    assert.equal(fd.get('seconds'), '8');
    assert.equal(fd.get('input_reference').type, 'image/png');
    assert.equal(calls[3].url, `${BASE}/videos/v9`);
    assert.equal(calls[4].url, `${BASE}/videos/v9/content`);
    assert.equal(calls[4].init.headers.Authorization, `Bearer ${KEY}`, '同源的下载接口带 Key');
    assert.equal(out.assets[0].bytes.toString(), 'V');
  });
});

test('预演只拼不发、Key 抹掉；试跑记录里没有 Key、素材 base64 只留大小', async () => {
  const r = normalizeRecipe(RECIPE_EXAMPLES.find((x) => x.id === 'async-video').recipe);
  const big = Buffer.alloc(30_000, 7);
  const req = { kind: 'video', model: 'm', prompt: 'p', params: { duration: 5 }, inputs: [{ role: 'first', data: big, mime: 'image/png' }] };
  await withFetch(() => { throw new Error('预演不该发请求'); }, async () => {
    const pv = previewRecipe(r, req, PROVIDER(), KEY);
    assert.equal(pv.submit.url, `${BASE}/video/create`);
    assert.ok(!JSON.stringify(pv).includes(KEY));
    assert.match(pv.submit.body, /base64 约/);
    assert.equal(pv.poll.status, '$.status');
  });
  const sink = { entries: [], secrets: [KEY] };
  await withFetch((url) => (url.endsWith('/video/create') ? jsonRes({ id: 't', echo: KEY }) : url.includes('query') ? jsonRes({ status: 'completed', video_url: `${BASE}/files/v.mp4` }) : binRes(Buffer.from('M'), 'video/mp4')), async () => {
    await withTrace(sink, () => recipeAdapter.run({ ...req, card: { recipe: r } }, PROVIDER(), CTX()));
  });
  assert.equal(sink.entries.length, 3);
  assert.deepEqual(sink.entries.map((e) => e.step), ['提交', '查询进度', '下载结果']);
  assert.ok(!JSON.stringify(sink.entries).includes(KEY), '记录里不许出现 Key');
  assert.match(sink.entries[0].request.body, /base64 约/);
  assert.equal(sink.entries[0].response.status, 200);
  assert.match(sink.entries[2].response.body, /文件 video\/mp4/);
});
