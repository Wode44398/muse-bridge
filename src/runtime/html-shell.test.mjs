// HTML 壳的发行版注入（runtime/html-shell.mjs）：</head> 前插 window.__DISTRO__、带 Content-Length 的也改对、已有的不重复插、
// /app/*.html 三个壳读文件插好再发、不再有原版视觉资源的清单与 /app/_ov/ 接口。
// 数据根与程序产物目录都在临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'html-shell-'));
const dataRoot = path.join(tmp, 'data');
const appDir = path.join(tmp, 'app');
mkdirSync(dataRoot, { recursive: true });
mkdirSync(appDir, { recursive: true });

const saved = Object.fromEntries(['BRIDGE_DATA_ROOT'].map((k) => [k, process.env[k]]));
process.env.BRIDGE_DATA_ROOT = dataRoot;

const { createRouter } = await import('./router.mjs');
const { registerHtmlShell, injectHead } = await import('./html-shell.mjs');
const { distroHeadTag } = await import('../config/distro.mjs');

const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>';
writeFileSync(path.join(appDir, 'quick.html'), HTML);
const router = createRouter();
registerHtmlShell(router, { appDir });
router.on('GET', '/', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); });
router.use((req, res, url) => {   // 模拟 /w/<token> 分享页（中间件按前缀接管）
  if (!url.pathname.startsWith('/w/')) return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(HTML) });
  res.end(HTML);
  return false;
});
const MARKED_HTML = '<!doctype html><html><head><script>window.__DISTRO__={"id":"x"};</script></head><body></body></html>';
router.use((req, res, url) => {   // 已经带着发行版声明的壳
  if (url.pathname !== '/c/marked') return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(MARKED_HTML);
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

test('HTML 壳：</head> 前插发行版声明；带 Content-Length 的也改对；不再插原版视觉资源的清单', async () => {
  for (const p of ['/', '/w/abc']) {
    const { r, body } = await get(p);
    const html = body.toString();
    assert.equal(r.status, 200);
    assert.ok(html.includes(distroHeadTag() + '</head>'));
    assert.ok(!html.includes('__OVERLAY__') && !html.includes('data-ov'));
    assert.ok(html.endsWith('</html>'));
  }
});

test('HTML 壳：已经带着发行版声明的不再插第二份', async () => {
  const { body } = await get('/c/marked');
  assert.equal(body.toString(), MARKED_HTML);
});

test('/app/*.html 三个壳：读文件插好声明再发（no-cache）；读不到交回后面的路由', async () => {
  const { r, body } = await get('/app/quick.html');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(body.toString(), injectHead(HTML, distroHeadTag()));
  assert.equal((await get('/app/solo.html')).r.status, 404);
});

test('原版视觉资源不经服务端：/app/_ov/ 没有专门的接口', async () => {
  assert.equal((await get('/app/_ov/manifest.json')).r.status, 404);
});

test('injectHead：没有 </head> 原样返回', () => {
  assert.equal(injectHead('<p>x</p>', '<i>'), '<p>x</p>');
  assert.equal(injectHead('<head></head>', '<i>'), '<head><i></head>');
});
