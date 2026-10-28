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

test('反馈去向 distro.feedback：没声明 = 本体默认且结果里没有这一项；声明了只收字符串与布尔', async () => {
  const { feedbackDest, isFeedbackDeclared, FEEDBACK_DEFAULT } = await import('./distro.mjs');
  assert.equal('feedback' in resolveDistro({}), false);
  assert.equal('feedback' in resolveDistro({ id: 'muse', brand: 'Muse Bridge' }), false);
  assert.deepEqual({ ...feedbackDest(resolveDistro({})) }, { to: 'bridge 开发者', toEn: 'the Bridge developer', public: false });
  assert.equal(isFeedbackDeclared(feedbackDest(resolveDistro({}))), false);

  const muse = resolveDistro({ feedback: { to: ' Muse Bridge 的公开 GitHub Issue ', toEn: 'Muse Bridge’s public GitHub issues', public: true } });
  assert.deepEqual({ ...muse.feedback }, { to: 'Muse Bridge 的公开 GitHub Issue', toEn: 'Muse Bridge’s public GitHub issues', public: true });
  assert.equal(isFeedbackDeclared(feedbackDest(muse)), true);
  // toEn 缺省 = to；public 只认严格的 true
  assert.deepEqual({ ...resolveDistro({ feedback: { to: 'X 团队', public: 'true' } }).feedback }, { to: 'X 团队', toEn: 'X 团队', public: false });
  // 不合规的 to（非字符串 / 空 / 太长 / 含换行）回落默认；全无有效内容时整项当没声明
  for (const to of [5, '', '  ', 'x'.repeat(61), 'a\nb', null]) {
    assert.equal('feedback' in resolveDistro({ feedback: { to } }), false, String(to));
  }
  for (const raw of ['x', 1, [], [{ to: 'a' }], null, true]) assert.equal('feedback' in resolveDistro({ feedback: raw }), false);
  // public:true 配了坏 to：宁可多提醒，去向用默认、公开标记保留
  assert.deepEqual({ ...resolveDistro({ feedback: { to: 'a\nb', public: true } }).feedback }, { to: 'bridge 开发者', toEn: 'the Bridge developer', public: true });
  // 太长的 toEn 丢掉（回落成 to），不是截断
  assert.equal(resolveDistro({ feedback: { to: '甲', toEn: 'e'.repeat(81) } }).feedback.toEn, '甲');
  // 注入标签里带得出 feedback，且仍跳不出 <script>
  const tag = distroHeadTag(resolveDistro({ feedback: { to: '</script>x', public: true } }));
  assert.equal((tag.match(/<\/script>/g) || []).length, 1);
  assert.ok(tag.includes('"feedback":{'));
  assert.ok(FEEDBACK_DEFAULT.to);
});
