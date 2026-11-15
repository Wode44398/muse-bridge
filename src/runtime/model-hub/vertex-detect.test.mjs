// Vertex 检测（2026-11-15）的纯函数：目录筛对话模型、preview 让位正式版、探针结论、显示名。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVertexChatCatalog, isVertexChatId, vertexProbeVerdict, prettyVertexId } from './vertex.mjs';

const pm = (id, stage = 'GA') => ({ name: `publishers/google/models/${id}`, launchStage: stage });

test('目录只收对话模型：媒体、向量、实时、电脑操作、老款都不收', () => {
  const ids = parseVertexChatCatalog([
    pm('gemini-4-hydrogen'), pm('gemini-3.8-flash'), pm('gemini-3.8-flash-tts'), pm('gemini-nano-banana-2.1'), pm('gemini-3.1-flash-image'),
    pm('gemini-omni-1.2-flash'), pm('gemini-embedding-001'), pm('gemini-live-2.5-flash'), pm('gemini-2.5-computer-use-preview'),
    pm('gemini-2.0-flash'), pm('gemini-1.5-pro'), pm('veo-3.1-generate-001'), pm('gemma-3'), pm('gemini-3.8-flash-cyber'), pm('gemini-3.8-flash'),
  ]).map((m) => m.id);
  assert.deepEqual(ids, ['gemini-4-hydrogen', 'gemini-3.8-flash']);
});

test('同一个模型有正式版就不收它的 preview 版；没有正式版的 preview 照收', () => {
  const ids = parseVertexChatCatalog([pm('gemini-3-flash'), pm('gemini-3-flash-preview', 'PUBLIC_PREVIEW'), pm('gemini-3.1-pro-preview', 'PUBLIC_PREVIEW'),
    pm('gemini-3.5-flash-lite-preview-09-2026', 'PUBLIC_PREVIEW'), pm('gemini-3.5-flash-lite')]).map((m) => m.id);
  assert.deepEqual(ids, ['gemini-3-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite']);
});

test('坏输入不炸', () => {
  assert.deepEqual(parseVertexChatCatalog(null), []);
  assert.deepEqual(parseVertexChatCatalog([null, {}, { name: 5 }]), []);
  assert.equal(isVertexChatId(''), false);
});

test('探针结论：200 / 400 / 429 能调，404 / 403 调不通，其余说不准', () => {
  for (const s of [200, 400, 429]) assert.equal(vertexProbeVerdict(s), true);
  for (const s of [404, 403]) assert.equal(vertexProbeVerdict(s), false);
  for (const s of [500, 503, 0, undefined]) assert.equal(vertexProbeVerdict(s), null);
});

test('显示名', () => {
  assert.equal(prettyVertexId('gemini-4-hydrogen'), 'Gemini 4 Hydrogen');
  assert.equal(prettyVertexId('gemini-3.5-flash-lite-preview-09-2026'), 'Gemini 3.5 Flash Lite');
  assert.equal(prettyVertexId('gemini-2.5-flash-001'), 'Gemini 2.5 Flash');
});
