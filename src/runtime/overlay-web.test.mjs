// 私有 overlay 网页层（runtime/overlay-web.mjs）：清单、文件、/app 补缺、HTML 壳注入、越界防护。
// overlay 目录与数据根都在临时目录；overlay-hooks.mjs 在导入时读环境变量，所以先设好再动态 import。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ovweb-'));
const dataRoot = path.join(tmp, 'data');
const ov = path.join(tmp, 'overlay');
mkdirSync(dataRoot, { recursive: true });
mkdirSync(path.join(ov, 'web', 'fonts'), { recursive: true });
mkdirSync(path.join(ov, 'web', 'glass'), { recursive: true });
mkdirSync(path.join(ov, 'web', 'modules'), { recursive: true });
mkdirSync(path.join(ov, 'web', '素材'), { recursive: true });
writeFileSync(path.join(ov, 'web', 'overlay.json'), JSON.stringify({
  name: 'test-overlay', css: ['overlay.css', 'missing.css'], varDirs: ['glass/'],
  vars: { '--ov-extra': 'fonts/a.woff2', 'bad name': 'fonts/a.woff2' },
  modules: { tex: 'modules/tex.js', gone: 'modules/nope.js' }, data: { marks: { frames: 7 } },
}));
writeFileSync(path.join(ov, 'web', 'overlay.css'), '@font-face{font-family:"X";src:url(fonts/a.woff2)}.a{background:url("data:image/png;base64,AA")}.b{background:url(/abs.png)}');
writeFileSync(path.join(ov, 'web', 'fonts', 'a.woff2'), Buffer.from('wOF2fake'));
writeFileSync(path.join(ov, 'web', 'glass', 'orb-dark.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(path.join(ov, 'web', 'modules', 'tex.js'), 'export const x = 1;\n');
writeFileSync(path.join(ov, 'web', '素材', '小人.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
writeFileSync(path.join(ov, 'web', 'only-in-overlay-zz9.txt'), 'hello');
writeFileSync(path.join(ov, 'web', '.secret'), 'no');
writeFileSync(path.join(ov, 'secret.txt'), 'outside web/');

const saved = Object.fromEntries(['BRIDGE_DATA_ROOT', 'BRIDGE_OVERLAY_DIR'].map((k) => [k, process.env[k]]));
process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_OVERLAY_DIR = ov;

const { createRouter } = await import('./router.mjs');
const W = await import('./overlay-web.mjs');
const { distroHeadTag } = await import('../config/distro.mjs');

const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>';
const router = createRouter();
W.registerOverlayWeb(router);
router.on('GET', '/', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); });
router.use((req, res, url) => {   // 模拟 /w/<token> 分享页（中间件按前缀接管）
  if (!url.pathname.startsWith('/w/')) return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(HTML) });
  res.end(HTML);
  return false;
});
const BAKED_HTML = '<!doctype html><html><head><script>window.__OVERLAY__={"v":1,"files":[]};</script></head><body></body></html>';
router.use((req, res, url) => {   // 构建期已经写好清单的壳（apk 出包产物）
  if (url.pathname !== '/c/baked') return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(BAKED_HTML);
  return false;
});
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { r, body: Buffer.from(await r.arrayBuffer()) }; };

test.after(() => {
  server.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

test('清单：只列存在的样式表 / 模块，varDirs 生成 url 变量，跳过点开头文件', async () => {
  const { r, body } = await get('/app/_ov/manifest.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const m = JSON.parse(body.toString());
  assert.equal(m.name, 'test-overlay');
  assert.equal(m.base, '/app/_ov/');
  assert.deepEqual(m.css, ['overlay.css']);
  assert.deepEqual(m.modules, { tex: 'modules/tex.js' });
  assert.equal(m.vars['--ov-glass-orb-dark'], 'glass/orb-dark.png');
  assert.equal(m.vars['--ov-extra'], 'fonts/a.woff2');
  assert.ok(!('bad name' in m.vars));
  assert.deepEqual(m.data, { marks: { frames: 7 } });
  assert.ok(m.files.includes('素材/小人.svg'));
  assert.ok(!m.files.some((f) => f.includes('.secret')));
});

test('文件：/app/_ov/<路径> 带 CORS 与字体类型；中文路径；越界与点文件一律 404', async () => {
  let { r, body } = await get('/app/_ov/fonts/a.woff2');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'font/woff2');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(body.toString(), 'wOF2fake');
  ({ r } = await get('/app/_ov/' + encodeURIComponent('素材') + '/' + encodeURIComponent('小人.svg')));
  assert.equal(r.status, 200);
  for (const bad of ['/app/_ov/.secret', '/app/_ov/../secret.txt', '/app/_ov/%2e%2e/secret.txt', '/app/_ov/fonts/..%2f..%2fsecret.txt', '/app/_ov/nope.css']) {
    ({ r } = await get(bad));
    assert.equal(r.status, 404, bad);
  }
  const etag = (await get('/app/_ov/fonts/a.woff2')).r.headers.get('etag');
  ({ r } = await get('/app/_ov/fonts/a.woff2', { 'If-None-Match': etag }));
  assert.equal(r.status, 304);
});

test('缓存：带当前版本戳的地址长缓存、样式表里的相对 url() 补上版本戳；不带 / 过期的照旧 no-cache', async () => {
  const m = JSON.parse((await get('/app/_ov/manifest.json')).body.toString());
  assert.match(m.ver, /^[0-9a-f]{10}$/);
  let { r, body } = await get('/app/_ov/fonts/a.woff2?v=' + m.ver);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.equal(body.toString(), 'wOF2fake');
  ({ r, body } = await get('/app/_ov/overlay.css?v=' + m.ver));
  assert.match(r.headers.get('cache-control'), /immutable/);
  const css = body.toString();
  assert.ok(css.includes(`url(fonts/a.woff2?v=${m.ver})`), css);
  assert.ok(css.includes('url("data:image/png;base64,AA")'), '不改 data:');
  assert.ok(css.includes('url(/abs.png)'), '不改根路径');
  ({ r, body } = await get('/app/_ov/overlay.css'));
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.ok(body.toString().includes('url(fonts/a.woff2)'), '不带版本戳的原样发');
  ({ r } = await get('/app/_ov/fonts/a.woff2?v=0000000000'));
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  // 304 也带着长缓存头
  const etag = (await get('/app/_ov/fonts/a.woff2?v=' + m.ver)).r.headers.get('etag');
  ({ r } = await get('/app/_ov/fonts/a.woff2?v=' + m.ver, { 'If-None-Match': etag }));
  assert.equal(r.status, 304);
  assert.match(r.headers.get('cache-control'), /immutable/);
});

test('/app/<路径>：主构建没有、overlay 有 → 回落到 overlay', async () => {
  const { r, body } = await get('/app/only-in-overlay-zz9.txt');
  assert.equal(r.status, 200);
  assert.equal(body.toString(), 'hello');
});

test('HTML 壳：</head> 前注入清单、样式表与变量；带 Content-Length 的也改对', async () => {
  for (const p of ['/', '/w/abc']) {
    const { r, body } = await get(p);
    const html = body.toString();
    assert.equal(r.status, 200);
    assert.match(html, /<script>window\.__OVERLAY__=\{"v":1/);
    const ver = JSON.parse(html.match(/window\.__OVERLAY__=(\{.*?\});<\/script>/)[1]).ver;
    assert.match(ver, /^[0-9a-f]{10}$/);
    assert.ok(html.includes(`<link rel="stylesheet" href="/app/_ov/overlay.css?v=${ver}" data-ov>`));
    assert.ok(html.includes(`--ov-glass-orb-dark:url("/app/_ov/glass/orb-dark.png?v=${ver}")`));
    assert.match(html, /<style data-ov>:root:root\{/);
    assert.ok(html.indexOf('data-ov') < html.indexOf('</head>'));
    assert.ok(html.endsWith('</html>'));
  }
});

test('HTML 壳：构建期已经写好清单的（apk 出包产物）不再插第二份，只补发行版声明', async () => {
  const { body } = await get('/c/baked');
  assert.equal(body.toString(), BAKED_HTML.replace('</head>', distroHeadTag() + '</head>'));
});

test('没有 overlay：清单为 null，HTML 只多 window.__OVERLAY__=null 和发行版声明两行，/app/_ov/* 404', async () => {
  W._setOverlayWebDir('');
  try {
    let { body } = await get('/app/_ov/manifest.json');
    assert.equal(body.toString(), 'null');
    ({ body } = await get('/'));
    const html = body.toString();
    assert.ok(html.includes('<script>window.__OVERLAY__=null;</script>' + distroHeadTag() + '</head>'));
    assert.ok(!html.includes('data-ov'));
    const { r } = await get('/app/_ov/fonts/a.woff2');
    assert.equal(r.status, 404);
  } finally { W._setOverlayWebDir(path.join(ov, 'web')); }
});

test('varNameOf：路径 → 变量名', () => {
  assert.equal(W.varNameOf('figma-glass/tb-orb44-dark.png'), '--ov-figma-glass-tb-orb44-dark');
  assert.equal(W.varNameOf('ios27/nav44-light.png'), '--ov-ios27-nav44-light');
});

test('registerOverlayRoutes：没有钩子时什么都不挂', async () => {
  assert.equal(await W.registerOverlayRoutes(createRouter(), {}), false);
});
