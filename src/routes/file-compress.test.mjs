// 工作空间「压缩…」（startCompress / compressStatus）：后台任务 + 轮询、临时文件落地改名、
// 重名按整段扩展名编号、守卫（越界 / 跨目录 / 根 / 别人的任务）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressFormats, compressStatus, startCompress } from './file-derived.mjs';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-zip-'));
  fs.mkdirSync(path.join(root, '项目 A', '子目录'), { recursive: true });
  fs.writeFileSync(path.join(root, '项目 A', '说明.md'), '# 你好');
  fs.writeFileSync(path.join(root, '项目 A', '子目录', '数据.txt'), 'x'.repeat(4000));
  fs.mkdirSync(path.join(root, 'v1.2'));
  fs.writeFileSync(path.join(root, 'v1.2', 'a.txt'), 'a');
  return root;
}
const clean = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };
async function finish(job, owner = 'admin') {
  for (let i = 0; i < 200; i++) {
    const st = compressStatus(job, owner);
    if (st.state !== 'running') return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('compress job did not finish');
}
const canZip = compressFormats().includes('zip');

test('zip：中文名、UTF-8 文件名标志、落地后没有临时文件', { skip: !canZip }, async () => {
  const root = workspace();
  try {
    const r = startCompress(root, ['项目 A'], { format: 'zip', level: 'max', owner: 'admin' });
    assert.equal(r.name, '项目 A.zip');
    const st = await finish(r.job);
    assert.equal(st.state, 'done', st.error);
    assert.equal(st.path, '项目 A.zip');
    const buf = fs.readFileSync(path.join(root, '项目 A.zip'));
    assert.equal(buf.readUInt16LE(6) & 0x0800, 0x0800, 'zip 通用标志 bit 11（UTF-8 文件名）');
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.bridge-zip-')), []);
    // 重名：第二次落成「项目 A (1).zip」
    const st2 = await finish(startCompress(root, ['项目 A'], { format: 'zip', owner: 'admin' }).job);
    assert.equal(st2.name, '项目 A (1).zip');
  } finally { clean(root); }
});

test('tar.gz 重名按整段扩展名编号；文件夹名里的点不当扩展名切', { skip: !compressFormats().includes('tar.gz') }, async () => {
  const root = workspace();
  try {
    const a = await finish(startCompress(root, ['v1.2'], { format: 'tar.gz', owner: 'admin' }).job);
    assert.equal(a.name, 'v1.2.tar.gz');
    const b = await finish(startCompress(root, ['v1.2'], { format: 'tar.gz', owner: 'admin' }).job);
    assert.equal(b.name, 'v1.2 (1).tar.gz');
  } finally { clean(root); }
});

test('多项一起压、自定义名（带不带扩展名都行），存档落在它们所在的文件夹', { skip: !canZip }, async () => {
  const root = workspace();
  try {
    const st = await finish(startCompress(root, ['项目 A/说明.md', '项目 A/子目录'], { format: 'zip', name: '打包.zip', owner: 'admin' }).job);
    assert.equal(st.state, 'done', st.error);
    assert.equal(st.path, '项目 A/打包.zip');
  } finally { clean(root); }
});

test('守卫：根、越界、跨文件夹、不支持的格式、别人的任务', { skip: !canZip }, async () => {
  const root = workspace();
  try {
    assert.equal(startCompress(root, [''], { owner: 'admin' }).code, 403);
    assert.equal(startCompress(root, ['../outside'], { owner: 'admin' }).code, 404);   // safeJoin 剥掉 .. 后在根内找不到
    assert.equal(startCompress(root, ['v1.2', '项目 A/说明.md'], { owner: 'admin' }).code, 400);
    assert.equal(startCompress(root, ['v1.2'], { format: 'exe', owner: 'admin' }).code, 400);
    const r = startCompress(root, ['v1.2'], { format: 'zip', owner: 'u:alice' });
    assert.equal(compressStatus(r.job, 'u:bob'), null);
    assert.equal((await finish(r.job, 'u:alice')).state, 'done');
  } finally { clean(root); }
});
