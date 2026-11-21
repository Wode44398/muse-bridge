// node --test web/src/lib/pickerCore.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extOfName, mimeOfName, parseAccept, acceptMatcher, fmtBytes, crumbsOf, joinRel, parentRel } from './pickerCore.js';

test('extOfName：小写、点开头的整名不算扩展名', () => {
  assert.equal(extOfName('A.MD'), 'md');
  assert.equal(extOfName('.gitignore'), '');
  assert.equal(extOfName('noext'), '');
  assert.equal(extOfName('a.'), '');
  assert.equal(extOfName('x.tar.gz'), 'gz');
});

test('mimeOfName：常见类型与代码文本', () => {
  assert.equal(mimeOfName('a.png'), 'image/png');
  assert.equal(mimeOfName('a.md'), 'text/markdown');
  assert.equal(mimeOfName('a.yml'), 'text/plain');
  assert.equal(mimeOfName('a.bin'), 'application/octet-stream');
});

test('parseAccept：空串 / * 全放行；扩展名、精确类型、前缀分开收', () => {
  assert.equal(parseAccept('').any, true);
  assert.equal(parseAccept('  ').any, true);
  assert.equal(parseAccept('*/*').any, true);
  const a = parseAccept('.MD, txt ,image/*, application/json');
  assert.equal(a.any, false);
  assert.deepEqual([...a.exts].sort(), ['md', 'txt']);
  assert.deepEqual([...a.prefixes], ['image/']);
  assert.deepEqual([...a.types], ['application/json']);
  // 认不出的项全丢掉时等于没限制
  assert.equal(parseAccept('???,/x/').any, true);
});

test('acceptMatcher：扩展名、MIME 前缀、精确类型', () => {
  const m = acceptMatcher('.md,image/*,application/json');
  assert.equal(m('Note.MD'), true);
  assert.equal(m('a.png'), true);
  assert.equal(m('a.json'), true);
  assert.equal(m('a.txt'), false);
  assert.equal(m('noext'), false);
  const text = acceptMatcher('text/*');
  assert.equal(text('a.js'), true);
  assert.equal(text('a.py'), true);
  assert.equal(text('a.pdf'), false);
  assert.equal(acceptMatcher('')('anything.bin'), true);
});

test('fmtBytes', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1023), '1023 B');
  assert.equal(fmtBytes(1024), '1 KB');
  assert.equal(fmtBytes(1536 * 1024), '1.5 MB');
  assert.equal(fmtBytes(undefined), '');
  assert.equal(fmtBytes(-1), '');
});

test('crumbsOf / joinRel / parentRel', () => {
  assert.deepEqual(crumbsOf(''), []);
  assert.deepEqual(crumbsOf('a/b'), [{ name: 'a', rel: 'a' }, { name: 'b', rel: 'a/b' }]);
  assert.deepEqual(crumbsOf('a\\b//c/'), [{ name: 'a', rel: 'a' }, { name: 'b', rel: 'a/b' }, { name: 'c', rel: 'a/b/c' }]);
  assert.equal(joinRel('', 'x'), 'x');
  assert.equal(joinRel('a/b', 'x'), 'a/b/x');
  assert.equal(parentRel('a/b/c'), 'a/b');
  assert.equal(parentRel('a'), '');
  assert.equal(parentRel(''), '');
});
