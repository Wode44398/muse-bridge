import test from 'node:test';
import assert from 'node:assert/strict';
import { readDistro, brandText, brandWords, BRIDGE_BRAND } from './distro.js';

test('readDistro：没注入 / 注入坏了 = bridge 本体', () => {
  for (const raw of [undefined, null, 'x', {}]) {
    assert.deepEqual({ ...readDistro(raw) }, { id: 'bridge', brand: BRIDGE_BRAND, langDefault: 'zh' });
  }
  assert.deepEqual({ ...readDistro({ id: 'muse', brand: 'Muse Bridge', langDefault: 'browser' }) },
    { id: 'muse', brand: 'Muse Bridge', langDefault: 'browser' });
});

test('brandText：本体原样；别的发行版把每处 The Bridge 都换掉，别的字不动', () => {
  assert.equal(brandText('登录 The Bridge'), '登录 The Bridge');
  assert.equal(brandText('Open The Bridge on your phone. The Bridge app', 'Muse Bridge'), 'Open Muse Bridge on your phone. Muse Bridge app');
  assert.equal(brandText('bridge 服务端', 'Muse Bridge'), 'bridge 服务端');
  assert.equal(brandText(null, 'Muse Bridge'), null);
});

test('brandWords：两行大字标', () => {
  assert.deepEqual(brandWords('The Bridge'), ['THE', 'BRIDGE']);
  assert.deepEqual(brandWords('Muse Bridge'), ['MUSE', 'BRIDGE']);
  assert.deepEqual(brandWords('Bridge'), ['', 'BRIDGE']);
});

test('stripBrand：版本行去掉开头的品牌，本体与发行版都认', async () => {
  const { stripBrand } = await import('./distro.js');
  assert.equal(stripBrand('The Bridge · v6.70（483）'), 'v6.70（483）');
  assert.equal(stripBrand('Muse Bridge · v6.70（483）', 'Muse Bridge'), 'v6.70（483）');
  assert.equal(stripBrand('bridge-client · 2026.10.27'), 'bridge-client · 2026.10.27');
  assert.equal(stripBrand('The Bridge'), '');
});

test('反馈去向：没声明 = 本体默认且 readDistro 形状不变；声明了才带 feedback', async () => {
  const { feedbackDest, readFeedbackDest, FEEDBACK_DEFAULT } = await import('./distro.js');
  assert.equal('feedback' in readDistro({}), false);
  assert.deepEqual(feedbackDest(null, 'zh', readDistro({})), { to: 'bridge 开发者', public: false });
  assert.deepEqual(feedbackDest(undefined, 'en', readDistro({})), { to: 'the Bridge developer', public: false });
  const muse = readDistro({ id: 'muse', feedback: { to: 'Muse Bridge 的公开 GitHub Issue', toEn: 'Muse Bridge’s public GitHub issues', public: true } });
  assert.deepEqual(feedbackDest(null, 'zh', muse), { to: 'Muse Bridge 的公开 GitHub Issue', public: true });
  assert.deepEqual(feedbackDest(null, 'en', muse), { to: 'Muse Bridge’s public GitHub issues', public: true });
  // 服务端回的 dest 优先（离线 apk 壳没有注入也能拿到）
  assert.equal(feedbackDest({ to: 'X', public: true }, 'en', readDistro({})).to, 'X');
  assert.equal(readFeedbackDest({ to: 5 }), null);
  assert.equal(readFeedbackDest({ public: true }).to, FEEDBACK_DEFAULT.to);
});
