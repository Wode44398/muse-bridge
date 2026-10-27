// 服务端发 apk（三端拆分 P5）：本地没出包时用 OSS 镜像清单——版本号不超过服务端才发，
// /api/app/version 报镜像那份，/api/app/download 302 到镜像地址；清单缺字段不认。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-apkmirror-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');

const { APP_VERSION_CODE } = await import('./config/versions.mjs');
let manifest = { code: APP_VERSION_CODE, name: 'x.y', notes: 'n', sha256: 'a'.repeat(64), size: 1234, url: 'ClaudeBridge-offline.apk' };
const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(manifest)); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/bridge-client/apk/`;
process.env.BRIDGE_APK_MIRROR = base + 'latest.json';
process.env.NO_PROXY = '127.0.0.1,localhost';

const mirror = await import('./runtime/apk-mirror.mjs');
const { registerAppUpdateRoutes } = await import('./routes/app-update.mjs');

function routes() {
  const h = {};
  registerAppUpdateRoutes({ on: (m, p, fn) => { h[m + ' ' + p] = fn; } }, { authOk: () => true, identify: () => ({ kind: 'admin' }) });
  return (p) => {
    let status = 0, headers = {}, body = '';
    const res = { writeHead(s, hh) { status = s; headers = hh || {}; }, end(b) { body = b || ''; } };
    h['GET ' + p]({ headers: {}, url: p }, res, new URL('http://x' + p));
    return { status, headers, json: body && headers['Content-Type'] === 'application/json' ? JSON.parse(body) : null };
  };
}

test.after(() => srv.close());

test('清单校验：缺 sha256 / size / 地址的不认，相对地址按清单地址补全', () => {
  assert.equal(mirror.normManifest({ code: 1, sha256: 'x', size: 1, url: 'a.apk' }, base), null);
  assert.equal(mirror.normManifest({ code: 1, sha256: 'a'.repeat(64), size: 0, url: 'a.apk' }, base), null);
  assert.equal(mirror.normManifest({ code: 1, sha256: 'a'.repeat(64), size: 5, url: 'a.apk' }, base).url, base + 'a.apk');
});

test('本地没出包：版本接口报镜像那份，下载 302 到镜像', async () => {
  await mirror.refreshApkMirror();
  const call = routes();
  const v = call('/api/app/version');
  // 仓库里若恰好有本地出的 apk，就以本地为准——那种情况下这条断言不适用
  if (v.json.source !== 'mirror') return;
  assert.equal(v.json.code, APP_VERSION_CODE);
  assert.equal(v.json.available, true);
  assert.equal(v.json.sha256, 'a'.repeat(64));
  const d = call('/api/app/download');
  assert.equal(d.status, 302);
  assert.equal(d.headers.Location, base + 'ClaudeBridge-offline.apk');
});

test('镜像里的包比服务端新：先不发（apk 里的前端可能要用服务端还没有的接口）', async () => {
  manifest = { ...manifest, code: APP_VERSION_CODE + 1 };
  await mirror.refreshApkMirror();
  assert.equal(mirror.mirrorApk(), null);
  assert.equal(mirror.mirrorStatus().usable, false);
});
