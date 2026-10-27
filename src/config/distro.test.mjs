// 发行版声明：没配是本体；配了逐项覆盖、不合规的项回落默认；注入标签跳不出 <script>；品牌只换写死的那几处
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDistro, distroHeadTag, brandHtml, brandManifest, DISTRO } from './distro.mjs';

test('没配 / 配坏了：bridge 本体', () => {
  for (const raw of [undefined, null, 'muse', [], {}]) {
    assert.deepEqual({ ...resolveDistro(raw) }, { id: 'bridge', brand: 'The Bridge', langDefault: 'zh' });
  }
  assert.equal(typeof DISTRO.id, 'string');
});

test('逐项覆盖，不合规的项回落默认', () => {
  assert.deepEqual({ ...resolveDistro({ id: 'muse', brand: ' Muse Bridge ', langDefault: 'browser' }) },
    { id: 'muse', brand: 'Muse Bridge', langDefault: 'browser' });
  const bad = resolveDistro({ id: 'Muse!', brand: 'x'.repeat(41), langDefault: 'fr' });
  assert.deepEqual({ ...bad }, { id: 'bridge', brand: 'The Bridge', langDefault: 'zh' });
});

test('注入标签：品牌名里写 </script> 也跳不出去', () => {
  const tag = distroHeadTag(resolveDistro({ id: 'muse', brand: '</script><b>' }));
  assert.equal((tag.match(/<\/script>/g) || []).length, 1);
  assert.ok(tag.startsWith('<script>window.__DISTRO__={'));
});

test('品牌：本体原样；别的发行版换 <title> 与 iOS 主屏名、清单名字', () => {
  const html = '<head><title>The Bridge</title><meta name="apple-mobile-web-app-title" content="Bridge" /></head>';
  assert.equal(brandHtml(html), html);
  const muse = resolveDistro({ id: 'muse', brand: 'Muse & Bridge' });
  const out = brandHtml(html, muse);
  assert.ok(out.includes('<title>Muse &amp; Bridge</title>'));
  assert.ok(out.includes('content="Muse &amp; Bridge"'));
  const mf = JSON.parse(brandManifest(JSON.stringify({ name: 'The Bridge', short_name: 'Bridge', description: '远程' }), muse));
  assert.equal(mf.name, 'Muse & Bridge');
  assert.equal(mf.short_name, 'Muse & Bridge');
  assert.equal(brandManifest('not json', muse), 'not json');
});
