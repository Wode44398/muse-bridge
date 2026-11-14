import test from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, iconKindOf, canPreview, langOf, officeCat, extOf, sniffText, serverConvertsOffice } from './fileKinds.js';

test('扩展名与点文件', () => {
  assert.equal(extOf('a/b/Photo.JPG'), 'jpg');
  assert.equal(extOf('.gitignore'), '');
  assert.equal(extOf('Makefile'), '');
  assert.equal(extOf('x.tar.gz'), 'gz');
});

test('预览分类：老表能看的照旧', () => {
  for (const [n, k] of [['a.png', 'image'], ['a.mp4', 'video'], ['a.mp3', 'audio'], ['a.pdf', 'pdf'], ['a.md', 'markdown'],
    ['a.docx', 'office'], ['a.xlsx', 'office'], ['a.pptx', 'office'], ['a.csv', 'office'], ['a.html', 'html'], ['a.json', 'text'], ['a.ts', 'text'], ['a.log', 'text']]) {
    assert.equal(kindOf(n), k, n);
  }
});

test('补上本可预览的类型', () => {
  assert.equal(kindOf('data.tsv'), 'office');
  assert.equal(kindOf('icon.svg'), 'image');
  assert.equal(kindOf('Cargo.toml'), 'text');
  assert.equal(kindOf('a.ini'), 'text');
  assert.equal(kindOf('a.xml'), 'text');
  assert.equal(kindOf('Dockerfile'), 'text');
  assert.equal(kindOf('Makefile'), 'text');
  assert.equal(kindOf('LICENSE'), 'text');
  assert.equal(kindOf('.gitignore'), 'text');
  assert.equal(kindOf('.env.local'), 'text');
  assert.equal(kindOf('a.odt'), 'office');
  assert.equal(kindOf('a.ipynb'), 'text');
  assert.equal(kindOf('sub.srt'), 'text');
});

test('不支持的照样 other，且 mime 能兜底', () => {
  assert.equal(kindOf('a.zip'), 'other');
  assert.equal(kindOf('a.pages'), 'other');
  assert.equal(kindOf('a.tiff'), 'other');
  assert.equal(kindOf('noext'), 'other');
  assert.equal(kindOf('noext', 'image/png'), 'image');
  assert.equal(kindOf('noext', 'text/plain; charset=utf-8'), 'text');
  assert.equal(canPreview('a.exe'), false);
  assert.equal(canPreview('a.yaml'), true);
});

test('图标、语言、Office 子类', () => {
  assert.equal(iconKindOf('x', { isDir: true }), 'dir');
  assert.equal(iconKindOf('a.zip'), 'zip');
  assert.equal(iconKindOf('a.md'), 'md');
  assert.equal(iconKindOf('a.woff2'), 'font');
  assert.equal(iconKindOf('a.py'), 'code');
  assert.equal(langOf('a.tsx'), 'typescript');
  assert.equal(langOf('Dockerfile'), 'dockerfile');
  assert.equal(langOf('a.txt'), '');
  assert.equal(officeCat('a.csv'), 'sheet');
  assert.equal(officeCat('a.ppsx'), 'slides');
  assert.equal(officeCat('a.rtf'), 'word');
  assert.equal(officeCat('a.pdf'), null);
  assert.equal(serverConvertsOffice('a.docx'), true);
  assert.equal(serverConvertsOffice('a.csv'), false);
});

test('内容嗅探', () => {
  const enc = new TextEncoder();
  assert.deepEqual(sniffText(enc.encode('hello\n世界')), { text: true, encoding: 'utf-8' });
  assert.equal(sniffText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])).text, false);
  // 「中文」的 GBK 字节
  assert.deepEqual(sniffText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a])), { text: true, encoding: 'gbk' });
  // UTF-8 多字节字符截在 4KB 边界中间也算文本
  const s = enc.encode('a'.repeat(4094) + '中');
  assert.equal(sniffText(s.subarray(0, 4096)).text, true);
});
