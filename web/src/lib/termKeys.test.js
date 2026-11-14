import test from 'node:test';
import assert from 'node:assert/strict';
import { ctrlChar, applyMods, keySeq, findUrls, isLocalUrl, pushHistory } from './termKeys.js';

test('Ctrl+字符映射成 C0 控制码', () => {
  assert.equal(ctrlChar('c'), '\x03');
  assert.equal(ctrlChar('C'), '\x03');
  assert.equal(ctrlChar('d'), '\x04');
  assert.equal(ctrlChar('['), '\x1b');
  assert.equal(ctrlChar('\\'), '\x1c');
  assert.equal(ctrlChar(' '), '\x00');
  assert.equal(ctrlChar('?'), '\x7f');
  assert.equal(ctrlChar('é'), null);
  assert.equal(ctrlChar('ab'), null);
});

test('粘滞修饰键只作用于单个字符', () => {
  assert.equal(applyMods('c', { ctrl: true }), '\x03');
  assert.equal(applyMods('x', { alt: true }), '\x1bx');
  assert.equal(applyMods('c', { ctrl: true, alt: true }), '\x1b\x03');
  assert.equal(applyMods('ls', { ctrl: true }), 'ls');
  assert.equal(applyMods('-', { ctrl: true }), '-');
  assert.equal(applyMods('中', { alt: true }), '\x1b中');
  assert.equal(applyMods('a', {}), 'a');
});

test('功能键序列：普通 / 应用光标键模式 / 带修饰', () => {
  assert.equal(keySeq('up'), '\x1b[A');
  assert.equal(keySeq('up', { app: true }), '\x1bOA');
  assert.equal(keySeq('left', { ctrl: true }), '\x1b[1;5D');
  assert.equal(keySeq('right', { alt: true }), '\x1b[1;3C');
  assert.equal(keySeq('home', { app: true }), '\x1bOH');
  assert.equal(keySeq('end'), '\x1b[F');
  assert.equal(keySeq('pgup'), '\x1b[5~');
  assert.equal(keySeq('pgdn', { ctrl: true }), '\x1b[6;5~');
  assert.equal(keySeq('tab'), '\t');
  assert.equal(keySeq('tab', { shift: true }), '\x1b[Z');
  assert.equal(keySeq('esc', { alt: true }), '\x1b\x1b');
  assert.equal(keySeq('nope'), '');
});

test('从终端文本里找网址，去掉尾巴标点', () => {
  assert.deepEqual(findUrls('  Local:   http://localhost:5173/'), [{ start: 11, end: 33, url: 'http://localhost:5173/' }]);
  assert.equal(findUrls('see (https://example.com/a).')[0].url, 'https://example.com/a');
  assert.equal(findUrls('https://en.wikipedia.org/wiki/Foo_(bar),')[0].url, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(findUrls('打开 https://x.test/页面，然后')[0].url, 'https://x.test/页面');
  assert.equal(findUrls('no url here').length, 0);
  assert.equal(findUrls('a http://a.b c https://d.e/f').length, 2);
});

test('本机地址判定', () => {
  assert.ok(isLocalUrl('http://localhost:5173/'));
  assert.ok(isLocalUrl('http://127.0.0.1:8080'));
  assert.ok(isLocalUrl('http://0.0.0.0:3000/x'));
  assert.ok(isLocalUrl('http://[::1]:80/'));
  assert.ok(!isLocalUrl('https://localhost.example.com/'));
  assert.ok(!isLocalUrl('https://example.com'));
});

test('输入行历史去重限长', () => {
  assert.deepEqual(pushHistory(['a', 'b'], 'a'), ['b', 'a']);
  assert.deepEqual(pushHistory(['a'], '  '), ['a']);
  assert.deepEqual(pushHistory(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd']);
  assert.deepEqual(pushHistory(null, 'x'), ['x']);
});
