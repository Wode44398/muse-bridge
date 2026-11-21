// 防回归断言：在 agy 等分页切明暗（尤其暗 → 明）时，后台隐藏的主页与 agy 页自身不得触发
// 同步 WebGL2/WebGPU 管线重建、后台流光每帧拷帧、空转 RAF 或重复拉会话/双次 WCO 刷新。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const webSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => readFileSync(join(webSrc, ...parts), 'utf8');

test('DesktopHome：隐藏时锁定壁纸槽位、流光降帧且停拷 WebGPU Dock 玻璃、忽略 0×0 测量', () => {
  const src = read('desktop', 'home', 'DesktopHome.svelte');
  assert.match(src, /const homeVisible = \$derived\(/);
  assert.match(src, /let renderedSlot = \$state\(/);
  assert.match(src, /const homeSlot = \$derived\(renderedSlot\)/);
  assert.match(src, /if \(!homeVisible\) return;[\s\S]{0,120}renderedSlot !== s/);
  assert.match(src, /homeVisible \? \(WP_FPS\[lv\] \?\? Infinity\) : 1/);
  assert.match(src, /w\.__fluxFrame = \(\) => \{ if \(homeVisible && fgdLive && wpEl\)/);
  assert.match(src, /if \(r\.width < 2 \|\| r\.height < 2\) return;/);
});

test('Home：隐藏时锁定壁纸槽位且不启动后台玻璃鼓包 RAF', () => {
  const src = read('components', 'Home.svelte');
  assert.match(src, /const homeVisible = \$derived\(/);
  assert.match(src, /let renderedSlot = \$state\(/);
  assert.match(src, /const homeSlot = \$derived\(renderedSlot\)/);
  assert.match(src, /if \(!homeVisible \|\| renderedSlot !== 'light'\) return;/);
});

test('GlassScene：画布隐藏（0×0）时停止空转 RAF，恢复尺寸再重启', () => {
  const src = read('desktop', 'glass', 'GlassScene.svelte');
  assert.match(src, /if \(!cssW \|\| !cssH\) \{ stopLoop\(\); return; \}/);
  assert.match(src, /startLoop\(\);/);
});

test('AgyPage：agyTheme 同步 pageChrome 与进页刷新会话分属独立 $effect', () => {
  const src = read('components', 'agy', 'AgyPage.svelte');
  const effects = [...src.matchAll(/\$effect\(\(\) => \{[\s\S]*?\n  \}\);/g)].map((m) => m[0]);
  const bootEffect = effects.find((e) => e.includes('refreshAgySessions'));
  const themeEffect = effects.find((e) => e.includes('agyTheme === \'dark\''));
  assert.ok(bootEffect, '应存在进页刷新 effect');
  assert.ok(themeEffect, '应存在主题同步 pageChrome effect');
  assert.notEqual(bootEffect, themeEffect, '刷新会话与主题同步不得合在同一个 $effect 中');
  assert.ok(!bootEffect.includes('agyTheme'), '进页刷新 effect 不得追踪 agyTheme');
  assert.ok(!themeEffect.includes('refreshAgySessions'), '主题同步 effect 不得重拉会话');
  assert.ok(!themeEffect.includes('ui.pageChrome = null'), '主题同步 effect 不得在每次切主题时先把 pageChrome 清 null');
});
