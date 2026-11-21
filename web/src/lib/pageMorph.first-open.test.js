// 防回归断言：dimensio（及各懒加载扩展分页）首次打开时必须有完整的入口展开动画，不得第 0 帧直切。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const webSrc = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(webSrc, ...parts), 'utf8');

test('App：dimensio 分页外包同步就位的 .hx-stage，且空闲预热受 me.agents 门控', () => {
  const app = read('App.svelte');
  assert.match(app, /<div class="hx-stage" style:background=\{hxStageBg\}>[\s\S]{0,240}loadPage\.harness\(\)/);
  assert.match(app, /\.hx-stage\s*\{\s*position:\s*fixed;\s*inset:\s*0;\s*z-index:\s*30;\s*\}/);
  assert.match(app, /Array\.isArray\(me\.agents\)[\s\S]{0,200}loadPage\.harness\(\)/);
});

test('pageMorph：ROOTS.harness 优先取持久 .hx-stage，无根盒兜底分支为 new(root) 挂展开动画', () => {
  const morph = read('lib', 'pageMorph.js');
  assert.match(morph, /harness:\s*'\.hx-stage,\s*\.hxroot > \.shell,\s*\.hx-placeholder'/);
  assert.match(morph, /export function morphElapsed\(\)/);
  // !page 兜底不得让 new(root) 静止盖在 old(root) 之上（否则第 0 帧直切）
  assert.match(morph, /\} else \{[\s\S]{0,360}anim\('new\(root\)'[\s\S]{0,240}clipPath:/);
});

test('DesktopHome：Dock 打开 dimensio 等内置入口统一走 openPage 展开转场', () => {
  const dsk = read('desktop', 'home', 'DesktopHome.svelte');
  assert.match(dsk, /import \{ openPage \} from '\.\.\/\.\.\/lib\/pageMorph\.js';/);
  assert.match(dsk, /openPage\(key,\s*\{\s*from:\s*icon,\s*radius:\s*12\s*\}\)/);
  assert.doesNotMatch(dsk, /\n    ui\.screen = key;\r?\n  \}/);
});

test('modules/pages：缓存已解析模块供同帧挂载，失败清缓存允许重试', () => {
  const pages = read('modules', 'pages.js');
  assert.match(pages, /export const resolvedPage = \{\};/);
  assert.match(pages, /resolvedPage\[key\] = m/);
  assert.match(pages, /delete cache\[key\];\s*throw e;/);
});
