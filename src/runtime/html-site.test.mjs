import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createRouter } from './router.mjs';
import { mountHtmlSite, registerHtmlSiteRoutes, SCROLLBAR_SHIM } from './html-site.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hv-'));
  mkdirSync(path.join(root, 'site', 'sub'), { recursive: true });
  writeFileSync(path.join(root, 'secret.txt'), 'nope');
  writeFileSync(path.join(root, 'site', 'app.js'), 'window.ok=1');
  writeFileSync(path.join(root, 'site', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body><script src="app.js"></script></body></html>');
  writeFileSync(path.join(root, 'site', 'sub', 'deep.html'), '<!doctype html><link rel="stylesheet" href="../app.css">');
  writeFileSync(path.join(root, 'site', 'app.css'), 'h1{}');
  return root;
}

async function withServer(fn) {
  const router = createRouter();
  registerHtmlSiteRoutes(router);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('挂载根=HTML 所在目录；相对资源可取、目录外不可取', async () => {
  const root = fixture();
  try {
    const url = mountHtmlSite(path.join(root, 'site', 'index.html'), [root]);
    assert.match(url, /^\/api\/hv\/[\w-]{22}\/index\.html$/);
    await withServer(async (base) => {
      const page = await fetch(base + url);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts/);
      assert.doesNotMatch(page.headers.get('content-security-policy'), /allow-same-origin/);
      const html = await page.text();
      // 垫片紧跟 <meta charset>，在页面脚本之前
      assert.ok(html.indexOf('localStorage') > html.indexOf('<meta charset="utf-8">'));
      assert.ok(html.indexOf('localStorage') < html.indexOf('src="app.js"'));
      const js = await fetch(base + url.replace('index.html', 'app.js'));
      assert.equal(js.status, 200);
      assert.match(js.headers.get('content-type'), /javascript/);
      const out = await fetch(base + url.replace('index.html', '%2E%2E/secret.txt'));
      assert.notEqual(out.status, 200);
      const post = await fetch(base + url, { method: 'POST' });
      assert.equal(post.status, 405);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('../ 引用按层数放宽挂载根，但不越过授权根', () => {
  const root = fixture();
  try {
    const deep = path.join(root, 'site', 'sub', 'deep.html');
    assert.match(mountHtmlSite(deep, [root]), /\/sub\/deep\.html$/);
    // 授权根就是 sub 本身：放宽不出去
    assert.match(mountHtmlSite(deep, [path.join(root, 'site', 'sub')]), /^\/api\/hv\/[\w-]+\/deep\.html$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('未知挂载 id 回 404', async () => {
  await withServer(async (base) => {
    const r = await fetch(base + '/api/hv/nope/index.html');
    assert.equal(r.status, 404);
  });
});

// 前端 HtmlView 的 srcdoc 回落路径有一份同样的滚动条垫片（写在 Svelte 的 <script> 里，结束标签得写成 <\/script>）。
// 两份不一致时 srcdoc 页的 </script> 可能关不上，把整页吞进脚本成白屏（2026-10-23 出过一次）。
test('HtmlView 的 SB_SHIM 与服务端 SCROLLBAR_SHIM 逐字节一致', () => {
  const svelte = readFileSync(new URL('../../web/src/components/preview/HtmlView.svelte', import.meta.url), 'utf8');
  const m = /const SB_SHIM = (".*");\r?\n/.exec(svelte);
  assert.ok(m, '找不到 SB_SHIM');
  assert.equal(JSON.parse(m[1]), SCROLLBAR_SHIM);   // JSON 认 \/ 转义；多转义一层（<\\/script>）就对不上
  assert.equal(SCROLLBAR_SHIM.match(/<\/script>/g).length, 1);
});
