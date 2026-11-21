// node --test web/src/lib/selfMount.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { clipText, bidiIsolate } from './selfMount.js';

test('clipText：去掉双向控制符（RLO 之类倒不了 bridge 写的权限说明）', () => {
  assert.equal(clipText('evil\u202eelif.exe', 40), 'evilelif.exe');
  for (const c of ['\u200e', '\u200f', '\u061c', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']) {
    assert.equal(clipText('a' + c + 'b', 40), 'ab', 'U+' + c.charCodeAt(0).toString(16));
  }
  // 名字本身的从右往左文字照常保留
  assert.equal(clipText('עברית', 40), 'עברית');
  // emoji 的零宽连接符不动
  assert.equal(clipText('👩\u200d💻', 40), '👩\u200d💻');
});

test('clipText：换行一类的控制符换成空格、去首尾空白', () => {
  assert.equal(clipText(' a\nb\r\n\tc\u2028d\u0085e ', 40), 'a b c d e');
  assert.equal(clipText(null, 10), '');
  assert.equal(clipText(undefined, 10), '');
});

test('clipText：超长截断加省略号，不劈开代理对', () => {
  assert.equal(clipText('abcdef', 4), 'abc…');
  assert.equal(clipText('ab😀cd', 4), 'ab…');
  assert.equal(clipText('abc', 3), 'abc');
});

test('bidiIsolate：前后包上 FSI / PDI', () => {
  assert.equal(bidiIsolate('x'), '\u2068x\u2069');
  assert.equal(bidiIsolate(null), '\u2068\u2069');
});

test('onAbort：abort 时调一次；摘除后不再调；没给 signal 回 null', async () => {
  const { onAbort } = await import('./selfMount.js');
  assert.equal(onAbort(undefined, () => {}), null);
  assert.equal(onAbort({}, () => {}), null);
  let n = 0;
  const a = new AbortController();
  const off = onAbort(a.signal, () => { n += 1; });
  assert.equal(typeof off, 'function');
  a.abort();
  a.abort();
  assert.equal(n, 1);
  const b = new AbortController();
  let m = 0;
  const offB = onAbort(b.signal, () => { m += 1; });
  offB();
  b.abort();
  assert.equal(m, 0);
});
