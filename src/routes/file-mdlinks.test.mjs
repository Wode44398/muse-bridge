// md 双链/嵌入的名单与出链解析（walkNoteTree / mdNamesFor / mdLinksFor）：
// 按层遍历 + 跳过点目录（大点目录不再吃光预算）、![[附件]] 的定点探测（attachments/、Obsidian 附件目录）、
// 全库按名兜底、反链的出链目标缓存随文件改动失效。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mdLinksFor, mdNamesFor, walkNoteTree } from './file-derived.mjs';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
function vault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mdlinks-'));
  const w = (rel, data = '') => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  };
  w('.obsidian/app.json', JSON.stringify({ attachmentFolderPath: 'assets' }));
  // 笔记目录里排在 attachments/ 前面的点开头大目录：深度优先 + 2500 预算时会把预算吃光
  for (let i = 0; i < 3000; i++) w(`notes/.cache/c${String(i).padStart(4, '0')}.txt`, 'x');
  w('notes/attachments/Pasted image 1.png', PNG);
  w('notes/note.md', '![[Pasted image 1.png|305]]\n![[库图.png]]\n![[deep.png]]\n[[dup]]\n[[不存在的笔记]]\n');
  w('notes/sub/dup.md', '# 浅');
  w('notes/a/b/dup.md', '# 深');
  w('notes/other.md', '见 [[note]] 与 [[note#标题|别名]]');
  w('assets/库图.png', PNG);                     // Obsidian 设置的附件目录（库根下 assets/），在笔记子树之外
  w('misc/x/y/deep.png', PNG);                  // 被挪到别处的附件：全库按名兜底
  return root;
}
const clean = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };
const ctxOf = (root) => ({ kind: 'admin', cwd: root });

test('按层遍历、跳过点目录：大点目录不再挤掉同目录的 attachments/', async () => {
  const root = vault();
  try {
    const ctx = ctxOf(root);
    const { files, truncated } = await walkNoteTree(ctx, path.join(root, 'notes'));
    assert.equal(truncated, false);
    assert.ok(!files.some((f) => f.rel.includes('/.cache/')), '点目录不进名单');
    // 浅的在前：depth 非递减
    for (let i = 1; i < files.length; i++) assert.ok(files[i].depth >= files[i - 1].depth);
    const { names } = await mdNamesFor(ctx, path.join(root, 'notes'));
    assert.ok(names.some((n) => n.path === 'notes/attachments/Pasted image 1.png' && !n.md));
    assert.ok(names.some((n) => n.path === 'notes/note.md' && n.md && n.name === 'note'));
  } finally { clean(root); }
});

test('出链：子树里的嵌入、Obsidian 附件目录、全库兜底；同名取最浅；不存在的给 null', async () => {
  const root = vault();
  try {
    const ctx = ctxOf(root);
    const file = path.join(root, 'notes', 'note.md');
    const { outgoing } = await mdLinksFor(ctx, file, fs.readFileSync(file, 'utf8'));
    const by = Object.fromEntries(outgoing.map((o) => [o.name, o]));
    assert.equal(by['Pasted image 1.png'].path, 'notes/attachments/Pasted image 1.png');
    assert.equal(by['Pasted image 1.png'].embed, true);
    assert.equal(by['库图.png'].path, 'assets/库图.png');
    assert.equal(by['deep.png'].path, 'misc/x/y/deep.png');
    assert.equal(by.dup.path, 'notes/sub/dup.md');
    assert.equal(by['不存在的笔记'].path, null);
  } finally { clean(root); }
});

test('同层文件多到遍历预算耗尽时，attachments/ 的嵌入仍由定点探测解析', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mdlinks-'));
  try {
    // 3000 个普通（非点）文件铺满同层：遍历预算耗尽（truncated），attachments/ 没走到
    fs.mkdirSync(path.join(root, 'n', 'a-heavy'), { recursive: true });
    for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(root, 'n', 'a-heavy', `f${i}.txt`), '');
    fs.mkdirSync(path.join(root, 'n', 'attachments'));
    fs.writeFileSync(path.join(root, 'n', 'attachments', 'x.png'), PNG);
    fs.writeFileSync(path.join(root, 'n', 'n.md'), '![[x.png]]');
    const { outgoing, truncated } = await mdLinksFor(ctxOf(root), path.join(root, 'n', 'n.md'), '![[x.png]]');
    assert.equal(truncated, true);
    assert.equal(outgoing[0].path, 'n/attachments/x.png');
  } finally { clean(root); }
});

test('反链：文件名带括号/空格的 md 链接（原样、%20、全编码）都算，预筛不漏', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mdlinks-'));
  try {
    const w = (rel, data) => { const abs = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, data); return abs; };
    const target = w('n/报告 (1).md', '# t');
    w('n/raw.md', '见 [这篇](报告 (1).md)');
    w('n/obs.md', '见 [这篇](报告%20(1).md)');                          // Obsidian 生成的写法：只编空格
    w('n/enc.md', '见 [这篇](' + encodeURIComponent('报告 (1).md') + ')');
    w('n/sub/up.md', '见 [这篇](../报告 (1).md) 与 [[报告 (1)|别名]]');
    w('n/other.md', '[a](x.md) 和 [b](报告 (2).md)、[c](dir (x)/报告 (1).md)');   // 不是本篇 / 目录带括号（老口径不认）
    const { backlinks } = await mdLinksFor(ctxOf(root), target, '# t');
    const by = Object.fromEntries(backlinks.map((b) => [b.path, b.count]));
    assert.deepEqual(by, { 'n/raw.md': 1, 'n/obs.md': 1, 'n/enc.md': 1, 'n/sub/up.md': 2 });
    const spaced = w('n/my note.md', 'x');
    w('n/ref.md', '[看](my note.md)');
    assert.deepEqual((await mdLinksFor(ctxOf(root), spaced, 'x')).backlinks.map((b) => b.path), ['n/ref.md']);
  } finally { clean(root); }
});

test('全库兜底的缓存分作用域根：同一个库经两个根访问，各拿各的相对路径', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mdlinks-'));
  try {
    fs.mkdirSync(path.join(root, 'proj', '.obsidian'), { recursive: true });
    fs.mkdirSync(path.join(root, 'proj', 'x', 'y', 'z'), { recursive: true });
    fs.mkdirSync(path.join(root, 'proj', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proj', 'x', 'y', 'z', 'moved.png'), PNG);
    const note = path.join(root, 'proj', 'notes', 'n.md');
    fs.writeFileSync(note, '![[moved.png]]');
    const a = await mdLinksFor(ctxOf(root), note, '![[moved.png]]');
    const b = await mdLinksFor(ctxOf(path.join(root, 'proj')), note, '![[moved.png]]');
    assert.equal(a.outgoing[0].path, 'proj/x/y/z/moved.png');
    assert.equal(b.outgoing[0].path, 'x/y/z/moved.png');
  } finally { clean(root); }
});

test('笔记嵌入 ![[笔记]]：与 [[笔记]] 同口径试「名字.md」；找不到给 null（不当附件扫全库）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mdlinks-'));
  try {
    fs.mkdirSync(path.join(root, '.obsidian'));
    fs.mkdirSync(path.join(root, 'notes'));
    fs.writeFileSync(path.join(root, '库根笔记.md'), '# x');
    const note = path.join(root, 'notes', 'n.md');
    const text = '![[库根笔记]]\n![[库根笔记#小节]]\n![[没有这篇]]';
    fs.writeFileSync(note, text);
    const { outgoing } = await mdLinksFor(ctxOf(root), note, text);
    const by = Object.fromEntries(outgoing.map((o) => [o.name, o.path]));
    assert.equal(by['库根笔记'], '库根笔记.md');
    assert.equal(by['没有这篇'], null);
  } finally { clean(root); }
});

test('反链：命中才读全文；被引用的笔记改掉链接后反链消失（缓存按 mtime/size 失效）', async () => {
  const root = vault();
  try {
    const ctx = ctxOf(root);
    const file = path.join(root, 'notes', 'note.md');
    const content = fs.readFileSync(file, 'utf8');
    let { backlinks } = await mdLinksFor(ctx, file, content);
    assert.deepEqual(backlinks.map((b) => [b.path, b.count]), [['notes/other.md', 2]]);
    assert.equal(backlinks[0].excerpts.length, 1);
    fs.writeFileSync(path.join(root, 'notes', 'other.md'), '已经不链了，只剩普通文字 note');
    ({ backlinks } = await mdLinksFor(ctx, file, content));
    assert.deepEqual(backlinks, []);
    fs.writeFileSync(path.join(root, 'notes', 'sub', 'dup.md'), '回链 [x](../note.md)');
    ({ backlinks } = await mdLinksFor(ctx, file, content));
    assert.deepEqual(backlinks.map((b) => b.path), ['notes/sub/dup.md']);
  } finally { clean(root); }
});
