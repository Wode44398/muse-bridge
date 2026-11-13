// Nano Banana 出图：从回复里挑成品图（pickImagePart）。不联网——只喂假的 parts。
// imagen.mjs 经 @bridge/core 引核心，先装解析钩子、把数据根改道到临时目录（核心 config 导入时就读数据根），再动态 import。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCoreResolver } from '../../../../src/modules/core-resolve.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-imagen-'));
process.env.BRIDGE_DATA_ROOT = tmp;
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 1, token: 'test-token-not-real' }));
installCoreResolver();
const { pickImagePart } = await import('./imagen.mjs');

const img = (data, extra = {}) => ({ inlineData: { data, mimeType: 'image/png' }, ...extra });

test('思考草图 + 成品：跳过 thought 草图，取带签名的成品（2026-11-07 Pro 4K 实出 1K 草图的根因）', () => {
  const parts = [
    { text: '构思中…', thought: true },
    img('DRAFT_1K_A', { thought: true }),
    img('DRAFT_1K_B', { thought: true }),
    { text: '这是成品', thoughtSignature: 'sigA' },
    img('FINAL_4K', { thoughtSignature: 'sigB' }),
  ];
  const p = pickImagePart(parts);
  assert.equal(p.inlineData.data, 'FINAL_4K');
  assert.equal(p.thoughtSignature, 'sigB');
});

test('草图没标 thought 也认得出：取带签名的那张；都没签名取最后一张', () => {
  assert.equal(pickImagePart([img('DRAFT'), img('FINAL', { thoughtSignature: 's' })]).inlineData.data, 'FINAL');
  assert.equal(pickImagePart([img('DRAFT'), img('FINAL')]).inlineData.data, 'FINAL');
});

test('全是思考部分：退到最后一张（文档：思考里的最后一张就是成品）', () => {
  assert.equal(pickImagePart([img('D1', { thought: true }), img('D2', { thought: true })]).inlineData.data, 'D2');
});

test('不思考的模型：只有一张图照旧取它；没图返回 null', () => {
  assert.equal(pickImagePart([{ text: '好的' }, img('ONLY')]).inlineData.data, 'ONLY');
  assert.equal(pickImagePart([{ text: '只回了文字' }]), null);
  assert.equal(pickImagePart(undefined), null);
  assert.equal(pickImagePart([{ inlineData: { mimeType: 'image/png' } }]), null);   // 没有 data 的不算
});
