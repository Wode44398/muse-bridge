// 手机整页形态顶栏的标签密度：净宽够就全显，不够只留选中那项的字，再不够纯图标。
import test from 'node:test';
import assert from 'node:assert/strict';
import { tabMode } from './tabs.js';

test('三档标签密度：按净宽与工具数落档', () => {
  assert.equal(tabMode(420, 5), 'all');
  assert.equal(tabMode(409, 5), 'active');
  assert.equal(tabMode(270, 5), 'active');
  assert.equal(tabMode(146, 5), 'icon');
  // 工具多一张，同样的宽度要降一档
  assert.equal(tabMode(420, 6), 'active');
  assert.equal(tabMode(0, 4), 'icon');
});
