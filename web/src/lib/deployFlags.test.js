import test from 'node:test';
import assert from 'node:assert/strict';
import { managedHint, proxyToggleShown, serverHosted } from './deployFlags.js';

test('managedHint：服务端声明了部署方接管才有话，其余（本体 / 老服务端 / 坏数据）一律空 = 照旧摆开关', () => {
  for (const st of [null, undefined, {}, { managed: null }, { managed: 'x' }, { managed: {} }, { managed: { hint: 1 } }, { managed: { hint: '  ' } }]) {
    assert.equal(managedHint(st), '');
  }
  assert.equal(managedHint({ multiUser: true, managed: { hint: ' 要切换，在 Muse 里说「改成多人用」。 ' } }), '要切换，在 Muse 里说「改成多人用」。');
});

test('proxyToggleShown：只有服务端明说 proxyForced:true 才藏「走出站代理」开关', () => {
  for (const cp of [null, undefined, {}, { proxyForced: false }, { proxyForced: 'true' }, { proxyForced: 1 }]) assert.equal(proxyToggleShown(cp), true);
  assert.equal(proxyToggleShown({ proxyForced: true }), false);
});

test('serverHosted：只有 /api/auth 说 hosting:server 才换「服务器」措辞；旧后端 / 没登录态 = 电脑', () => {
  for (const m of [null, undefined, {}, { hosting: 'host' }, { hosting: 'Server' }]) assert.equal(serverHosted(m), false);
  assert.equal(serverHosted({ kind: 'admin', hosting: 'server' }), true);
});
