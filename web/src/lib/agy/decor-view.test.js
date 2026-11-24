import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtElapsed, duoPeers, decorKey, pluginMenuEntries } from './decor-view.js';

test('走秒：m:ss，过一小时 h:mm:ss，坏值当 0', () => {
  assert.equal(fmtElapsed(0), '0:00');
  assert.equal(fmtElapsed(42), '0:42');
  assert.equal(fmtElapsed(605), '10:05');
  assert.equal(fmtElapsed(3725), '1:02:05');
  assert.equal(fmtElapsed(-3), '0:00');
  assert.equal(fmtElapsed('x'), '0:00');
});

test('头像组：agy 在下、claude 在上；没给 peers 画两个', () => {
  assert.deepEqual(duoPeers({ peers: ['claude', 'agy'] }), ['agy', 'claude']);
  assert.deepEqual(duoPeers({ peers: ['claude'] }), ['claude']);
  assert.deepEqual(duoPeers({}), ['agy', 'claude']);
});

test('文件夹键：反斜杠、尾斜杠、盘符大小写都规整', () => {
  assert.equal(decorKey('D:\\Notes\\BB\\'), 'D:/Notes/bb');
  assert.equal(decorKey('/home/a/'), '/home/a');
});

test('插件菜单条目：claude / agy 图标留给菜单画标志，其余走 iconSvg；点了带原项回调', () => {
  const got = [];
  const out = pluginMenuEntries([
    { plugin: 'demo', id: 'on', label: '设为协作', icon: 'claude' },
    { plugin: 'demo', id: 'off', label: '取消协作', icon: 'users', danger: true },
  ], { onRun: (it) => got.push(it.id), iconSvg: (n) => `<svg data-n="${n}"/>`, label: (s) => s + '!' });
  assert.equal(out[0].id, 'plugin:demo:on');
  assert.equal(out[0].icon, 'claude');
  assert.equal(out[0].svg, '');
  assert.equal(out[1].svg, '<svg data-n="users"/>');
  assert.equal(out[1].danger, true);
  assert.equal(out[1].label, '取消协作!');
  out[1].onclick();
  assert.deepEqual(got, ['off']);
});
