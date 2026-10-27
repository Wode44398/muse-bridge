// apk 出包时把私有 overlay 打进离线壳（overlay-bundle.mjs）：什么时候打、打进去什么、壳里写的标签与服务端一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apkOverlayWeb, bundleOverlay, bundleSkip } from './overlay-bundle.mjs';
import { buildManifest, headTags } from '../../src/runtime/overlay-manifest.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ov-bundle-'));
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

function makeOverlay(root) {
  const web = path.join(root, 'web');
  for (const d of ['fonts', 'modules', 'chatgpt', 'lg-ref', 'glass', '素材']) mkdirSync(path.join(web, d), { recursive: true });
  writeFileSync(path.join(web, 'overlay.json'), JSON.stringify({ name: 't', css: ['overlay.css'], varDirs: ['glass/'], modules: { m: 'modules/m.js' }, data: { k: 1 } }));
  writeFileSync(path.join(web, 'overlay.css'), '@font-face{src:url(fonts/a.woff2)}');
  writeFileSync(path.join(web, 'fonts', 'a.woff2'), 'wOF2');
  writeFileSync(path.join(web, 'modules', 'm.js'), 'export const x = 1;\n');
  writeFileSync(path.join(web, 'glass', 'orb.png'), 'png');
  writeFileSync(path.join(web, '素材', '小人.svg'), '<svg/>');
  writeFileSync(path.join(web, 'chatgpt', 'index.html'), HTML);
  writeFileSync(path.join(web, 'lg-ref', 'index.html'), HTML);
  writeFileSync(path.join(web, '.secret'), 'no');
  return web;
}

test('只在 apk 出包、找得到 overlay、且不是公开版出包时生效', () => {
  const root = tmp();
  try {
    const web = makeOverlay(root);
    assert.equal(apkOverlayWeb({ BRIDGE_OVERLAY_DIR: root }), null, '生产构建（没设 BRIDGE_APK_OUT）不打');
    assert.equal(apkOverlayWeb({ BRIDGE_APK_OUT: 'x', BRIDGE_OVERLAY_DIR: root }), web);
    assert.equal(apkOverlayWeb({ BRIDGE_APK_OUT: 'x', BRIDGE_OVERLAY_DIR: root, BRIDGE_EDITION: 'public' }), null, '公开版出包不打');
    assert.equal(apkOverlayWeb({ BRIDGE_APK_OUT: 'x', BRIDGE_DATA_ROOT: path.join(root, 'nope') }), null, '没有 overlay');
    assert.equal(apkOverlayWeb({ BRIDGE_APK_OUT: 'x', BRIDGE_OVERLAY_DIR: path.join(root, 'web') }), null, 'overlay 里没有 web/');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('打进 _ov/：chatgpt/、lg-ref/、点文件不进；三个壳写入与服务端相同的标签；重复跑不重复插', () => {
  const root = tmp();
  const out = tmp();
  try {
    const web = makeOverlay(root);
    for (const f of ['index.html', 'quick.html', 'solo.html']) writeFileSync(path.join(out, f), HTML);
    const m = bundleOverlay(web, out);
    assert.ok(existsSync(path.join(out, '_ov', 'fonts', 'a.woff2')));
    assert.ok(existsSync(path.join(out, '_ov', '素材', '小人.svg')));
    assert.ok(existsSync(path.join(out, '_ov', 'modules', 'm.js')));
    assert.ok(!existsSync(path.join(out, '_ov', 'chatgpt')));
    assert.ok(!existsSync(path.join(out, '_ov', 'lg-ref')));
    assert.ok(!existsSync(path.join(out, '_ov', '.secret')));
    assert.ok(!m.files.some((f) => f.startsWith('chatgpt/') || f.startsWith('lg-ref/')));
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, '_ov', 'manifest.json'), 'utf8')), m);
    assert.equal(m.base, '/app/_ov/');
    assert.deepEqual(m.modules, { m: 'modules/m.js' });
    const want = headTags(buildManifest(web, { skip: bundleSkip }).manifest);
    for (const f of ['index.html', 'quick.html', 'solo.html']) {
      const html = readFileSync(path.join(out, f), 'utf8');
      assert.ok(html.includes(want + '</head>'), f);
      assert.ok(html.includes(`href="/app/_ov/overlay.css?v=${m.ver}"`), f);
    }
    bundleOverlay(web, out);
    assert.equal(readFileSync(path.join(out, 'index.html'), 'utf8').split('window.__OVERLAY__=').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});
