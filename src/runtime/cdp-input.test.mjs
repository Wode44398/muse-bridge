import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeySpec } from './cdp-input.mjs';

test('parses named keys and modifiers', () => {
  assert.deepEqual(parseKeySpec('ctrl+shift+tab'), {
    key: { key: 'Tab', code: 'Tab', keyCode: 9 },
    modifiers: 10,
  });
});

test('parses printable characters', () => {
  assert.deepEqual(parseKeySpec('shift+a'), {
    key: { key: 'A', code: 'KeyA', keyCode: 65, text: 'A' },
    modifiers: 8,
  });
  assert.equal(parseKeySpec('ctrl+a').key.text, undefined);
});

test('rejects unknown keys', () => {
  assert.throws(() => parseKeySpec('ctrl+not-a-key'), /unsupported key/);
});
