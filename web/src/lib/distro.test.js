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
