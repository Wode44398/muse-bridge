// 状态行缩略图条（官方 4.4212 TurnStatus）的服务端一半：工具结果里的图片落盘 / 历史按需现取。
// 直播 saveToolImages 只落 base64 图、只回张数；历史 countToolImages 只数不存；
// toolImageFile 缓存没有时回到 transcript 找那条 tool_result；tool_use_id 走白名单，拼不出目录外的路径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageParts, countToolImages, saveToolImages, toolImageFile } from './tool-images.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');
const sdkImg = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
const mcpImg = { type: 'image', data: PNG, mimeType: 'image/jpeg' };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tool-img-')); }

test('imageParts：认 SDK 与 MCP 两种形态，跳过 url 图和文字', () => {
  const blk = { type: 'tool_result', content: [{ type: 'text', text: 'x' }, sdkImg, { type: 'image', source: { type: 'url', url: 'https://x/y.png' } }, mcpImg] };
  const parts = imageParts(blk);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.mime), ['image/png', 'image/jpeg']);
  assert.equal(countToolImages({ content: 'plain text' }), 0);
});

test('saveToolImages：落盘、回张数；非法 id 不落', () => {
  const media = tmp();
  assert.equal(saveToolImages(media, 'toolu_01ABCdef', { content: [sdkImg, mcpImg] }), 2);
  const dir = path.join(media, 'tool-images');
  assert.ok(fs.existsSync(path.join(dir, 'toolu_01ABCdef-0.png')));
  assert.ok(fs.existsSync(path.join(dir, 'toolu_01ABCdef-1.jpg')));
  assert.equal(saveToolImages(media, '../../evil', { content: [sdkImg] }), 0);
  assert.equal(saveToolImages(media, 'toolu_01ABCdef', { content: [] }), 0);
});

test('toolImageFile：缓存缺失时从 transcript 现取；越界 / 非法 id 回 null', async () => {
  const media = tmp();
  const file = path.join(tmp(), 's.jsonl');
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01XYZ', name: 'Read', input: { file_path: 'a.png' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01XYZ', content: [sdkImg] }] } },
  ];
  fs.writeFileSync(file, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const got = await toolImageFile(media, 'toolu_01XYZ', 0, file);
  assert.ok(got && got.endsWith('toolu_01XYZ-0.png'));
  assert.equal(await toolImageFile(media, 'toolu_01XYZ', 1, file), null);
  assert.equal(await toolImageFile(media, 'toolu_01NOPE', 0, file), null);
  assert.equal(await toolImageFile(media, '..', 0, file), null);
  // 第二次直接命中缓存（transcript 删了也能取）
  fs.rmSync(file);
  assert.ok(await toolImageFile(media, 'toolu_01XYZ', 0, null));
});
