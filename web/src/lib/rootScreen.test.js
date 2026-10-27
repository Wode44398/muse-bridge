import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRootScreen, ROOT_SCREENS } from './rootScreen.js';

test('名单未知（旧后端没登录）= 主页', () => {
  for (const raw of [undefined, null, 'claude', {}]) assert.equal(pickRootScreen(raw), 'home');
});

test('只开 Claude = Claude 页当根页（与原先一致）', () => {
  assert.equal(pickRootScreen(['claude']), 'claude');
});

test('只开 dimensio = dimensio 页当根页', () => {
  assert.equal(pickRootScreen(['dimensio']), 'harness');
});

test('开了两个及以上 = 主页（Claude + dimensio 同开时与原先一致）', () => {
  assert.equal(pickRootScreen(['claude', 'dimensio']), 'home');
  assert.equal(pickRootScreen(['claude', 'gemini']), 'home');
  assert.equal(pickRootScreen(['dimensio', 'codex']), 'home');
  assert.equal(pickRootScreen(['claude', 'gemini', 'codex', 'dimensio']), 'home');
});

test('只剩没做根页外壳的分页（Gemini / Codex）= 仍走主页', () => {
  assert.equal(pickRootScreen(['gemini']), 'home');
  assert.equal(pickRootScreen(['codex']), 'home');
});

test('一个都没开 / 只有不认识的 id = 主页；不认识的 id 不影响判定', () => {
  assert.equal(pickRootScreen([]), 'home');
  assert.equal(pickRootScreen(['antigravity', '__proto__', 'toString']), 'home');
  assert.equal(pickRootScreen(['dimensio', 'antigravity', 'constructor']), 'harness');
  assert.equal(pickRootScreen(['dimensio', 'dimensio']), 'harness');
});

test('根页集合', () => {
  assert.deepEqual([...ROOT_SCREENS], ['claude', 'harness']);
});
