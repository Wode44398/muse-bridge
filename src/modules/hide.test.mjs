// BRIDGE_MODULES_HIDE：发行版不提供的扩展（Muse Bridge 不带 Gemini / Codex）——扩展中心与 Agent 页都不列；没设时照旧。
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BRIDGE_MODULES_HIDE = 'vertex, Codex';
process.env.BRIDGE_MODULES_SKIP = 'vertex,codex';   // 当作没装（隐藏只管没装的；装上了的照常列出）
const { moduleOffered } = await import('./registry.mjs');

test('声明不提供的扩展：没装就不列', () => {
  assert.equal(moduleOffered('vertex'), false);
  assert.equal(moduleOffered('codex'), false);
  assert.equal(moduleOffered('dimensio'), true, '没点名的照旧');
});
