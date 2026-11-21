import test from 'node:test';
import assert from 'node:assert/strict';
import { agyDeviceView, agyDeviceText } from './device-view.js';

const t = (s) => s;
const A = { id: 'a', name: '书房', online: true };
const B = { id: 'b', name: '笔记本', online: false };

test('明确选了不连 / 选的那台已不在', () => {
  assert.deepEqual(agyDeviceView([A], 'none', ''), { kind: 'none', name: '', tone: 'idle' });
  assert.equal(agyDeviceView([A], 'gone', '').kind, 'missing');
  assert.equal(agyDeviceText(agyDeviceView([A], 'none', ''), t), '不连电脑');
  assert.equal(agyDeviceText(agyDeviceView([A], 'gone', ''), t), '设备已不在');
});

test('选了某一台：名字与在线状态', () => {
  assert.deepEqual(agyDeviceView([A, B], 'b', ''), { kind: 'named', name: '笔记本', tone: 'off' });
  assert.equal(agyDeviceText(agyDeviceView([A, B], 'b', ''), t), '笔记本');
  assert.equal(agyDeviceText(agyDeviceView([A, B], 'a', 'a'), t), '这台电脑');
});

test('自动：先认发起端这台，再认唯一在线的那台，否则待选', () => {
  assert.equal(agyDeviceView([A, B], '', 'b').kind, 'mine');
  assert.deepEqual(agyDeviceView([A, B], '', ''), { kind: 'named', name: '书房', tone: 'on' });
  const two = [A, { ...B, online: true }];
  assert.equal(agyDeviceView(two, '', '').kind, 'unset');
  assert.equal(agyDeviceText(agyDeviceView(two, '', ''), t), '选电脑');
  assert.equal(agyDeviceView([], '', '').kind, 'unset');
  assert.equal(agyDeviceView(null, '', 'x').kind, 'unset');
});

test('没名字的设备落回「电脑」', () => {
  assert.equal(agyDeviceText(agyDeviceView([{ id: 'c', online: true }], 'c', ''), t), '电脑');
});
