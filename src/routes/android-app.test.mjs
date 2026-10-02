// 安卓 app 下载：安装包里带了 apk 就由服务器自己提供，没带就告诉前端退回 GitHub 链接。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-android-'));
process.env.BRIDGE_DATA_ROOT = tmp;
const { createRouter } = await import('../runtime/router.mjs');
const { registerAndroidAppRoutes, androidInfo, APK_PATH, GITHUB_APK } = await import('./android-app.mjs');

async function serve(dir) {
  const router = createRouter();
  registerAndroidAppRoutes(router, { dir });
  const srv = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise((r) => srv.close(r)) };
}

test('没有 downloads/：available=false，下载地址 404 并指向 GitHub', async () => {
  const dir = path.join(tmp, 'none');
  assert.deepEqual(androidInfo(dir), { available: false, versionName: '', versionCode: 0, size: 0, url: '', github: GITHUB_APK });
  const s = await serve(dir);
  try {
    const r = await fetch(s.base + APK_PATH);
    assert.equal(r.status, 404);
    assert.match(await r.text(), /github\.com/);
  } finally { await s.close(); }
});

test('带了 apk 与 android.json：报版本，apk 以附件下载、MIME 对', async () => {
  const dir = mkdtempSync(path.join(tmp, 'dl-'));
  const apk = Buffer.from('PK\x03\x04 fake apk body');
  writeFileSync(path.join(dir, 'MuseBridge.apk'), apk);
  writeFileSync(path.join(dir, 'android.json'), JSON.stringify({ versionName: '0.1.0-beta.10', versionCode: 57, sha256: 'x' }));
  const s = await serve(dir);
  try {
    const info = await (await fetch(s.base + '/api/app/android')).json();
    assert.deepEqual(info, { available: true, versionName: '0.1.0-beta.10', versionCode: 57, size: apk.length, url: APK_PATH, github: GITHUB_APK });
    const r = await fetch(s.base + APK_PATH);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(r.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''MuseBridge\.apk$/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), apk);
  } finally { await s.close(); }
});

test('android.json 坏了 / 缺字段：照样能下载，版本留空', () => {
  const dir = mkdtempSync(path.join(tmp, 'bad-'));
  writeFileSync(path.join(dir, 'MuseBridge.apk'), 'x');
  writeFileSync(path.join(dir, 'android.json'), '{not json');
  const info = androidInfo(dir);
  assert.equal(info.available, true);
  assert.equal(info.versionName, '');
  assert.equal(info.versionCode, 0);
});
