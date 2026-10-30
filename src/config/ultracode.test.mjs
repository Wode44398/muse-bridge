// Ultracode 与 effort 档位独立（2026-10-30）：归一、SDK 选项、旧写法兼容、会话偏好。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CAPABILITIES, CLAUDE_EFFORTS, splitUltracode, claudeEffortOptions } from './capabilities.mjs';
import { recordChatPrefs, chatPrefsFor, lastChatPrefs } from '../runtime/chat-prefs.mjs';

test('档位表不再含 Ultracode，白名单仍收旧写法', () => {
  assert.ok(!CAPABILITIES.claude.efforts.some((e) => e.id === 'ultracode'));
  assert.equal(CAPABILITIES.claude.ultracode.name, 'Ultracode');
  assert.ok(CLAUDE_EFFORTS.has('ultracode') && CLAUDE_EFFORTS.has('max'));
});

test('splitUltracode：旧写法拆成 xhigh + Ultracode，其余原样', () => {
  assert.deepEqual(splitUltracode('ultracode'), { effort: 'xhigh', ultracode: true });
  assert.deepEqual(splitUltracode('low', true), { effort: 'low', ultracode: true });
  assert.deepEqual(splitUltracode('max', 'yes'), { effort: 'max', ultracode: false });
  assert.deepEqual(splitUltracode(null, true), { effort: undefined, ultracode: true });
});

test('claudeEffortOptions：任意档位 + Ultracode 合成 settings', () => {
  const wf = { ultracode: true, enableWorkflows: true };
  assert.deepEqual(claudeEffortOptions('high', true), { effort: 'high', settings: wf });
  assert.deepEqual(claudeEffortOptions('max', true), { effort: 'max', settings: wf });
  assert.deepEqual(claudeEffortOptions('ultracode'), { effort: 'xhigh', settings: wf });
  assert.deepEqual(claudeEffortOptions(null, true), { settings: wf });
  assert.deepEqual(claudeEffortOptions('low', false), { effort: 'low' });
  assert.deepEqual(claudeEffortOptions(null), {});
});

test('会话偏好记 Ultracode，新对话默认（last）不带', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uc-prefs-'));
  try {
    const ctx = { dataDir: dir };
    recordChatPrefs(ctx, 's-new', { model: 'claude-opus-5-5', effort: 'high', ultracode: true, fast: false });
    assert.equal(chatPrefsFor(ctx, 's-new').ultracode, true);
    assert.equal(chatPrefsFor(ctx, 's-new').effort, 'high');
    assert.equal(lastChatPrefs(ctx).ultracode, undefined);
    recordChatPrefs(ctx, 's-old', { effort: 'ultracode' });
    assert.equal(chatPrefsFor(ctx, 's-old').effort, 'xhigh');
    assert.equal(chatPrefsFor(ctx, 's-old').ultracode, true);
    recordChatPrefs(ctx, 's-off', { effort: 'max', ultracode: false });
    assert.equal(chatPrefsFor(ctx, 's-off').ultracode, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
