import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePageKey, parseWindowPage, pageWindowUrl } from './windowPageCore.js';

test('normalizePageKey handles builtins, aliases and plugin apps', () => {
  assert.equal(normalizePageKey('claude'), 'claude');
  assert.equal(normalizePageKey('AGY'), 'agy');
  assert.equal(normalizePageKey('vertex'), 'studio');
  assert.equal(normalizePageKey('dimensio'), 'harness');
  assert.equal(normalizePageKey('codex'), 'chatgpt');
  assert.equal(normalizePageKey('files'), 'files');
  assert.equal(normalizePageKey('app:notes:pad'), 'app:notes:pad');
  assert.equal(normalizePageKey('home'), '');
  assert.equal(normalizePageKey('settings'), '');
  assert.equal(normalizePageKey('app:bad/id:x'), '');
});

test('parseWindowPage prefers desktop bridge key over query string', () => {
  assert.equal(parseWindowPage({ bridgePageKey: 'agy', search: '?page=claude' }), 'agy');
  assert.equal(parseWindowPage({ bridgePageKey: '', search: '?page=files' }), 'files');
  assert.equal(parseWindowPage({ bridgePageKey: '', search: '?page=app%3Ademo%3Aboard' }), 'app:demo:board');
  assert.equal(parseWindowPage({ bridgePageKey: '', search: '' }), '');
});

test('pageWindowUrl builds clean same-origin page URL', () => {
  assert.equal(
    pageWindowUrl('claude', 'http://127.0.0.1:8787/?pair=abc#top'),
    'http://127.0.0.1:8787/?page=claude',
  );
  assert.equal(
    pageWindowUrl('app:demo:board', 'https://bridge.example.com/app/'),
    'https://bridge.example.com/app/?page=app%3Ademo%3Aboard',
  );
  assert.equal(pageWindowUrl('home', 'http://127.0.0.1:8787/'), '');
});
