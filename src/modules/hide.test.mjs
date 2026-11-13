// BRIDGE_MODULES_HIDE：发行版不提供的扩展（Muse Bridge 不带媒体 / Codex）——扩展中心与 Agent 页都不列；没设时照旧。
// 老写法 vertex（2026-11-04 退役）等于它的接替者 studio。
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BRIDGE_MODULES_HIDE = 'vertex, Codex';
process.env.BRIDGE_MODULES_SKIP = 'vertex,codex';   // 当作没装（隐藏只管没装的；装上了的照常列出）
const { moduleOffered } = await import('./registry.mjs');

test('声明不提供的扩展：没装就不列', () => {
  assert.equal(moduleOffered('studio'), false);   // HIDE 里写的是老 id vertex
  assert.equal(moduleOffered('codex'), false);
  assert.equal(moduleOffered('dimensio'), true, '没点名的照旧');
});
