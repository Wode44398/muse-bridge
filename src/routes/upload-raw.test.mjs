// /api/upload/raw：聊天里上传的附件回读。统一查看器要拿它播视频 / 音频、按需取 PDF 块、下载，
// 所以原文件走 streamFile：Range 206、dl=1 下载名（去掉存盘时间戳前缀）、类型按扩展名 safe 映射（html 不当网页回）。
// 起一个只监听 127.0.0.1 的临时 http 服务直接打路由（快照身份，uploads 落在临时目录），测完关掉、删目录。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { registerUploadRoutes } from './upload.mjs';

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upraw-'));
  const uploads = path.join(dir, '.bridge', 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const routes = new Map();
  const router = { on: (method, p, handler) => routes.set(method + ' ' + p, handler) };
  registerUploadRoutes(router, {
    authOk: () => true,
    identify: (req) => (req.headers['x-test-anon'] ? { kind: 'none' } : { kind: 'snap', dir, token: 'upraw-test' }),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const h = routes.get(req.method + ' ' + url.pathname);
    if (!h) { res.writeHead(404); res.end(); return; }
    Promise.resolve(h(req, res, url)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await fn({ uploads, base });
  } finally {
    server.closeAllConnections?.();   // fetch 的长连接别拖着 close 等超时
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const raw = (base, name, extra = '') => base + '/api/upload/raw?name=' + encodeURIComponent(name) + extra;

test('原文件：200 带长度与 Accept-Ranges；Range 返回 206 与正确的块', () => withServer(async ({ uploads, base }) => {
  const body = Buffer.from('0123456789abcdefghij');
  fs.writeFileSync(path.join(uploads, '1763000000000-clip.mp4'), body);

  const full = await fetch(raw(base, '1763000000000-clip.mp4'));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('content-length'), String(body.length));
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.match(full.headers.get('content-disposition') || '', /^inline;/);
  assert.equal(Buffer.from(await full.arrayBuffer()).toString(), body.toString());

  const part = await fetch(raw(base, '1763000000000-clip.mp4'), { headers: { Range: 'bytes=5-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 5-9/20');
  assert.equal(part.headers.get('content-length'), '5');
  assert.equal(await part.text(), '56789');

  const tail = await fetch(raw(base, '1763000000000-clip.mp4'), { headers: { Range: 'bytes=-4' } });
  assert.equal(tail.status, 206);
  assert.equal(await tail.text(), 'ghij');

  const bad = await fetch(raw(base, '1763000000000-clip.mp4'), { headers: { Range: 'bytes=50-60' } });
  assert.equal(bad.status, 416);
  await bad.arrayBuffer();
}));

test('dl=1：attachment，下载名去掉时间戳前缀（中文名按 RFC 5987 编码）', () => withServer(async ({ uploads, base }) => {
  fs.writeFileSync(path.join(uploads, '1763000000001-季度报告.pdf'), '%PDF-1.4 test');
  const r = await fetch(raw(base, '1763000000001-季度报告.pdf', '&dl=1'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), "attachment; filename*=UTF-8''" + encodeURIComponent('季度报告.pdf'));
  await r.arrayBuffer();

  const inline = await fetch(raw(base, '1763000000001-季度报告.pdf'));
  assert.equal(inline.headers.get('content-disposition'), "inline; filename*=UTF-8''" + encodeURIComponent('季度报告.pdf'));
  await inline.arrayBuffer();
}));

test('会执行的类型不当活动内容回；音频按扩展名给类型', () => withServer(async ({ uploads, base }) => {
  fs.writeFileSync(path.join(uploads, '1763000000002-page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(uploads, '1763000000003-voice.mp3'), 'ID3');
  const h = await fetch(raw(base, '1763000000002-page.html'));
  assert.equal(h.status, 200);
  assert.doesNotMatch(h.headers.get('content-type') || '', /text\/html/);
  await h.arrayBuffer();
  const a = await fetch(raw(base, '1763000000003-voice.mp3'));
  assert.equal(a.headers.get('content-type'), 'audio/mpeg');
  await a.arrayBuffer();
}));

test('守卫：不存在 / 目录穿越 → 404；未登录 → 401', () => withServer(async ({ uploads, base }) => {
  fs.writeFileSync(path.join(path.dirname(uploads), 'secret.txt'), 'nope');
  const miss = await fetch(raw(base, 'nothing.png'));
  assert.equal(miss.status, 404);
  await miss.arrayBuffer();
  const up = await fetch(raw(base, '../secret.txt'));
  assert.equal(up.status, 404);
  await up.arrayBuffer();
  const anon = await fetch(raw(base, 'nothing.png'), { headers: { 'x-test-anon': '1' } });
  assert.equal(anon.status, 401);
  await anon.arrayBuffer();
}));
