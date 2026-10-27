import test from 'node:test';
import assert from 'node:assert/strict';
import { tabsList, resolveTab, tabTag, focusTab, watchPopups } from './browser-tabs.mjs';

// 只模拟 browser-tabs 用到的那几样：tabs 数组、activateTab、eval、refreshTabs。
function fakeBrowser(n = 1) {
  const b = {
    tabs: Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, url: `http://x/${i + 1}`, title: '', active: i === 0 })),
    switched: [],
    async activateTab(id) { this.switched.push(id); for (const t of this.tabs) t.active = t.id === id; },
    async eval() { return 'complete'; },
    async refreshTabs() { for (const t of this.tabs) t.title = t.title || `Page ${t.id}`; },
  };
  return b;
}

test('resolveTab takes 1-based indexes (number or digit string) and ids', () => {
  const b = fakeBrowser(3);
  assert.equal(resolveTab(b, 2).id, 't2');
  assert.equal(resolveTab(b, '3').id, 't3');
  assert.equal(resolveTab(b, 't1').id, 't1');
  assert.equal(resolveTab(b, 9), null);
  assert.equal(resolveTab(b, ''), null);
});

test('tabTag only shows up once there is more than one tab', () => {
  const b = fakeBrowser(1);
  assert.equal(tabTag(b), '');
  b.tabs.push({ id: 't2', url: '', title: '', active: false });
  assert.equal(tabTag(b), ' [tab 1/2]');
});

test('tabsList refreshes titles before listing', async () => {
  const b = fakeBrowser(2);
  assert.equal(await tabsList(b), '1. ▶ Page t1 — http://x/1\n2. Page t2 — http://x/2');
});

test('focusTab switches for normal actions but leaves tab_* targets alone', async () => {
  const b = fakeBrowser(2);
  assert.equal(await focusTab(b, 'tab_close', 2), null);
  assert.deepEqual(b.switched, []);
  assert.equal(await focusTab(b, 'screenshot', 2), null);
  assert.deepEqual(b.switched, ['t2']);
  assert.equal(await focusTab(b, 'screenshot', 2), null);   // 已在前台不重复切
  assert.deepEqual(b.switched, ['t2']);
  assert.match(await focusTab(b, 'click', 7), /找不到标签 7/);
});

test('watchPopups switches to a tab the page opened and says where the opener is', async () => {
  const b = fakeBrowser(1);
  const popped = watchPopups(b, 'click');
  b.tabs.push({ id: 't2', url: 'http://x/new', title: '', active: false });   // 页面 window.open
  const note = await popped();
  assert.deepEqual(b.switched, ['t2']);
  assert.match(note, /标签 2 Page t2 — http:\/\/x\/new/);
  assert.match(note, /原页面还在标签 1/);
});

test('watchPopups is silent when nothing opened, and ignores non-gesture actions', async () => {
  const b = fakeBrowser(1);
  assert.equal(await watchPopups(b, 'click')(), '');
  const popped = watchPopups(b, 'screenshot');
  b.tabs.push({ id: 't2', url: '', title: '', active: false });
  assert.equal(await popped(), '');
  assert.deepEqual(b.switched, []);
});
