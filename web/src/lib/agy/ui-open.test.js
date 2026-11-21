import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agyUiTargetOf } from './workspace-logic.js';

test('agy 的 ui_open 落到工作区文件卡：文件 = 定位到所在目录并卡内预览，文件夹 = 定位到那个目录', () => {
  const ws = 'C:\\proj';
  assert.deepEqual(agyUiTargetOf({ kind: 'file', rel: 'src/a.js', ws }), { ws, rel: 'src', open: 'a.js' });
  assert.deepEqual(agyUiTargetOf({ kind: 'file', rel: './a.js', ws }), { ws, rel: '', open: 'a.js' });
  assert.deepEqual(agyUiTargetOf({ kind: 'folder', rel: '.', ws }), { ws, rel: '', open: '' });
  assert.deepEqual(agyUiTargetOf({ kind: 'folder', rel: 'src\\sub\\', ws }), { ws, rel: 'src/sub', open: '' });
  assert.deepEqual(agyUiTargetOf({ kind: 'file', rel: 'docs/a b.md', ws: '/home/u/p' }), { ws: '/home/u/p', rel: 'docs', open: 'a b.md' });
});

test('agy 的 ui_open：缺目录或文件名时不定位', () => {
  assert.equal(agyUiTargetOf({ kind: 'file', rel: 'a.js', ws: '' }), null);
  assert.equal(agyUiTargetOf({ kind: 'file', rel: '.', ws: 'C:\\proj' }), null);
  assert.equal(agyUiTargetOf({}), null);
});
