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

test('distroFromCaps：离线 apk 从 /api/app/caps 认发行版', async () => {
  const { distroFromCaps } = await import('./distro.js');
  const muse = { id: 'muse', brand: 'Muse Bridge', langDefault: 'browser' };
  assert.deepEqual(distroFromCaps({ app: 'bridge', distro: 'muse', distroInfo: muse }), muse);
  // 只带 id 的旧发行版服务端：至少认出 id，品牌回落本体
  assert.deepEqual(distroFromCaps({ app: 'bridge', distro: 'muse' }), { id: 'muse' });
  // 本体 / 没有这条路由的老服务端 = 本体（清缓存）
  assert.equal(distroFromCaps({ app: 'bridge', distro: 'bridge' }), null);
  assert.equal(distroFromCaps(null, true), null);
  // 认不出的回包（网关错误页等）= 别动缓存
  assert.equal(distroFromCaps({ error: 'x' }), undefined);
  assert.equal(distroFromCaps(null), undefined);
  assert.equal(distroFromCaps({ app: 'bridge', distroInfo: [] , distro: 'bridge' }), null);
});
