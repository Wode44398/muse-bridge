// gif / svg 作品（2026-11-15 参数补全）：落盘扩展名与宽高、续改链里的 svg、svg 素材、svg 直出的沙箱头、缩略图；额度按张数计。
// 数据根改道到临时目录；上游一律不打（OpenRouter 的 run 换成假的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-fmt-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_NO_AUTH = '';
process.env.BRIDGE_VERTEX_RELAY = '';
process.env.BRIDGE_MODULES_SKIP = 'codex,dimensio';
process.env.BRIDGE_STUDIO_AUTOSYNC = '0';
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 18995, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users') }, null, 2));

await (await import('@bridge/core/modules/registry.mjs')).loadModules();
const P = await import('./providers.mjs');
const jobs = await import('./jobs.mjs');
const { adapterFor } = await import('./adapters/index.mjs');
const media = await import('@bridge/core/vertex-media.mjs');
const { serveMediaFile, mediaSafetyHeaders } = await import('@bridge/core/routes/media-file.mjs');
const { contextFor } = await import('@bridge/core/runtime/identity.mjs');

const admin = contextFor({ kind: 'admin' });
const gif = (w, h) => { const b = Buffer.alloc(16); b.write('GIF89a', 0, 'ascii'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const SVG = (attrs) => Buffer.from(`<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="10" height="10" fill="red"/></svg>`, 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const or = P.createProvider({ preset: 'openrouter', dialect: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-secret-123456',
  models: [{ id: 'openai/gpt-image-2.6-sunburst', kind: 'image', source: 'builtin' }] }, 'admin');
const KEY = or.id + '/openai/gpt-image-2.6-sunburst';
const OR = adapterFor('openrouter');
const realRun = OR.run;
let nextAssets = [], lastReq = null;
OR.run = async (req) => { lastReq = req; return { assets: nextAssets }; };
test.after(() => { OR.run = realRun; });

test('作品宽高：GIF 读逻辑屏幕宽高；SVG 读 width / height（px 也认），没有就用 viewBox；读不出不记', () => {
  assert.deepEqual(jobs.outputDims(gif(320, 200), 'gif'), [320, 200]);
  assert.deepEqual(jobs.outputDims(SVG('width="1024" height="768"'), 'svg'), [1024, 768]);
  assert.deepEqual(jobs.outputDims(SVG('width="512px" height="256px" viewBox="0 0 10 10"'), 'svg'), [512, 256]);
  assert.deepEqual(jobs.outputDims(SVG('viewBox="0 0 1536 1024"'), 'svg'), [1536, 1024]);
  assert.deepEqual(jobs.outputDims(SVG('width="800" viewBox="0 0 400 200"'), 'svg'), [800, 400], '只给一边按 viewBox 比例补');
  assert.equal(jobs.outputDims(SVG('width="100%" height="100%"'), 'svg'), null);
  assert.equal(jobs.outputDims(Buffer.from('not svg'), 'svg'), null);
  assert.deepEqual(jobs.outputDims(PNG, 'png'), [1, 1]);
});

test('落盘：image/svg+xml 存成 .svg、image/gif 存成 .gif，侧车带宽高', async () => {
  nextAssets = [{ bytes: SVG('viewBox="0 0 640 480"'), mime: 'image/svg+xml' }, { bytes: gif(300, 150), mime: 'image/gif' }];
  const r = await jobs.startJob(admin, { kind: 'image', key: KEY, prompt: '图标', params: { size: 'auto' } }).done;
  assert.equal(r.state, 'done', r.error);
  const [s, g] = r.result.map((a) => media.get(a.id));
  assert.deepEqual([s.ext, s.width, s.height], ['svg', 640, 480]);
  assert.deepEqual([g.ext, g.width, g.height], ['gif', 300, 150]);
  assert.equal(r.result[0].mime, 'image/svg+xml');
});

test('续改链：上一张是 SVG 就整条不带（按文生图出、结果仍进链）；GIF 标对 mime；中间夹着的 SVG 跳过', async () => {
  nextAssets = [{ bytes: gif(64, 64), mime: 'image/gif' }];
  const first = await jobs.startJob(admin, { kind: 'image', key: KEY, prompt: '第一张' }).done;
  const thread = first.result[0].id;
  nextAssets = [{ bytes: SVG('viewBox="0 0 64 64"'), mime: 'image/svg+xml' }];
  await jobs.startJob(admin, { kind: 'image', key: KEY, prompt: '矢量版', thread }).done;
  assert.equal(lastReq.thread.turns.length, 1);
  assert.equal(lastReq.thread.turns[0].mime, 'image/gif');
  nextAssets = [{ bytes: PNG, mime: 'image/png' }];
  const third = await jobs.startJob(admin, { kind: 'image', key: KEY, prompt: '再改', thread }).done;
  assert.equal(lastReq.thread, null, '最近一张是 SVG：不拿更早的位图顶上');
  assert.equal(third.result[0].thread, thread);
  await jobs.startJob(admin, { kind: 'image', key: KEY, prompt: '接着改', thread }).done;
  assert.deepEqual(lastReq.thread.turns.map((t) => t.mime), ['image/gif', 'image/png'], '中间的 SVG 跳过');
});

test('SVG 素材：当改图对象 / 参考图直接拒（说清楚先导出 PNG）', () => {
  const id = media.newId();
  media.save(id, SVG('viewBox="0 0 8 8"'), 'svg', { kind: 'image', prompt: 'v' });
  assert.throws(() => jobs.startJob(admin, { kind: 'image', key: KEY, prompt: 'x', inputs: [{ role: 'edit', asset: id }] }), (e) => e.status === 400 && /SVG/.test(e.message));
});

test('额度按张数：卡上的张数参数（count / n / num_images…）规范化后的值；svg 隐藏了张数 = 1', () => {
  const card = { params: [{ key: 'count', type: 'number', format: 'count', min: 1, max: 10 }] };
  assert.equal(jobs.unitsOf(card, { count: 4 }), 4);
  assert.equal(jobs.unitsOf(card, {}), 1);
  assert.equal(jobs.unitsOf(card, { count: 99 }), 10);
  assert.equal(jobs.unitsOf({ params: [{ key: 'n', type: 'number', min: 1, max: 6 }] }, { n: 3 }), 3);
  assert.equal(jobs.unitsOf({ params: [{ key: 'num_images', type: 'enum', options: [] }] }, { num_images: '2' }), 2);
  assert.equal(jobs.unitsOf({ params: [] }, { count: 5 }), 1, '卡上没有张数参数：1');
  assert.equal(jobs.unitsOf(null, {}), 1);
});

// 假 res：收下 writeHead 的头，吞掉正文
function fakeRes() {
  const res = new Writable({ write(c, e, cb) { cb(); } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res; };
  return res;
}
test('SVG 直出：带沙箱 CSP 与 nosniff；别的格式不带', async () => {
  const dir = path.join(tmp, 'media-x');
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'a.svg');
  writeFileSync(f, SVG('viewBox="0 0 8 8"'));
  const res = fakeRes();
  serveMediaFile({ headers: {} }, res, f);
  assert.equal(res.headers['Content-Type'], 'image/svg+xml');
  assert.equal(res.headers['Content-Security-Policy'], "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  const p = path.join(dir, 'b.png');
  writeFileSync(p, PNG);
  const r2 = fakeRes();
  serveMediaFile({ headers: {} }, r2, p);
  assert.equal(r2.headers['Content-Security-Policy'], undefined);
  assert.deepEqual(mediaSafetyHeaders('X.SVG'), { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'X-Content-Type-Options': 'nosniff' });
});

test('缩略图：SVG 栅格化成 webp；GIF 不做（回退原图、保留动画）', async () => {
  const sid = media.newId();
  media.save(sid, SVG('width="400" height="200"'), 'svg', { kind: 'image' });
  const t = await media.derivedFor(sid, undefined, 'thumb');
  assert.ok(t && existsSync(t) && t.endsWith('.thumb.webp'));
  const gid = media.newId();
  media.save(gid, gif(10, 10), 'gif', { kind: 'image' });
  assert.equal(await media.derivedFor(gid, undefined, 'thumb'), null);
});
