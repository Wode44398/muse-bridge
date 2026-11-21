import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenReturn, createNativeReturn, NATIVE_PAGE, ARRIVE_MS } from './screenReturn.js';

const APP = 'app:e2e-host:h';
function make() {
  let t = 1000;
  const sr = createScreenReturn({ now: () => t });
  return { sr, tick: (ms) => { t += ms; } };
}

test('应用页跳去 Claude 页：到了之后返回回到应用页，而不是回主页', () => {
  const { sr } = make();
  assert.equal(sr.set(APP, 'claude'), true);
  sr.screen(APP);                 // 接线挂上时第一次喂：还在来处
  sr.screen('claude');            // 转场第一拍换了屏
  assert.equal(sr.take('claude'), APP);
  assert.equal(sr.take('claude'), null, '只认一次');
});

test('到了以后又去了别处（主页 / 别的分页）：作废，返回照常', () => {
  const { sr } = make();
  sr.set(APP, 'claude');
  sr.screen('claude');
  sr.screen('home');
  assert.equal(sr.peek(), null);
  sr.screen('claude');            // 又从主页点进 Claude 页：不是那次跳转带过来的
  assert.equal(sr.take('claude'), null);
});

test('到了以后又回到来处：作废（再从应用页按返回该回主页）', () => {
  const { sr } = make();
  sr.set(APP, 'claude');
  sr.screen('claude');
  sr.screen(APP);
  assert.equal(sr.take(APP), null);
});

test('一直没到（跳转被拒 / 没开放 / 没登录）：过了期限作废，之后再到也不认', () => {
  const { sr, tick } = make();
  sr.set(APP, 'claude');
  sr.screen(APP);
  tick(ARRIVE_MS + 1);
  sr.screen('claude');
  assert.equal(sr.take('claude'), null);
  // 还停在来处时过期：下一次屏变化就清掉
  sr.set(APP, 'claude');
  tick(ARRIVE_MS + 1);
  sr.screen(APP);
  assert.equal(sr.peek(), null);
});

test('期限内到了，之后停多久都认（人在 Claude 页里聊了很久再按返回）', () => {
  const { sr, tick } = make();
  sr.set(APP, 'claude');
  tick(300);
  sr.screen('claude');
  tick(10 * 60_000);
  assert.equal(sr.take('claude'), APP);
});

test('还没到就按返回：这次不回、记录留着等到达；当前屏不是目标：不回', () => {
  const { sr } = make();
  sr.set(APP, 'claude');
  assert.equal(sr.take(APP), null);
  sr.screen('claude');
  assert.equal(sr.take('claude'), APP);
  sr.set(APP, 'claude');
  sr.screen('claude');
  assert.equal(sr.take('files'), null);
});

test('来处不可用了（应用被撤 / 分页被关）：不回去；valid 抛错同样不回', () => {
  const { sr } = make();
  sr.set(APP, 'claude', { valid: () => false });
  sr.screen('claude');
  assert.equal(sr.take('claude'), null);
  sr.set(APP, 'claude', { valid: () => { throw new Error('x'); } });
  sr.screen('claude');
  assert.equal(sr.take('claude'), null);
  sr.set(APP, 'app:other:main', { valid: () => true });
  sr.screen('app:other:main');
  assert.equal(sr.take('app:other:main'), APP, '应用跳应用同样回得去');
});

test('来处与去处相同 / 缺一个：不记，并清掉旧记录', () => {
  const { sr } = make();
  sr.set(APP, 'claude');
  assert.equal(sr.set('claude', 'claude'), false);
  assert.equal(sr.peek(), null);
  assert.equal(sr.set('', 'claude'), false);
  assert.equal(sr.set(APP, ''), false);
});

test('新的一次跳转顶掉旧记录', () => {
  const { sr } = make();
  sr.set(APP, 'claude');
  sr.screen('claude');
  sr.set('claude', 'app:other:main');
  sr.screen('app:other:main');
  assert.equal(sr.take('app:other:main'), 'claude');
});


// —— 原生返回（来处是手机 App 里压在后面的插件页面，3b.2）——
function makeNative() {
  let t = 1000;
  const nr = createNativeReturn({ now: () => t });
  return { nr, tick: (ms) => { t += ms; } };
}
const none = () => false;

test('原生返回：nav 去会话，到了 Claude 页按返回 → 切回插件页（只认一次）', () => {
  const { nr } = makeNative();
  assert.equal(nr.set('claude', { valid: () => true, current: 'home' }), true);
  assert.equal(nr.take('home', none), null, '还没到：不归它管');
  nr.screen('claude');
  assert.deepEqual(nr.take('claude', none), { layer: null });
  assert.equal(nr.take('claude', none), null, '只认一次');
});

test('原生返回：已经在目标屏上（主页跳主页、Claude 页里跳会话）当场算到', () => {
  const { nr } = makeNative();
  nr.set('claude', { valid: () => true, current: 'claude' });
  assert.equal(nr.peek().arrived, true);
  assert.equal(nr.peek().from, NATIVE_PAGE);
  assert.deepEqual(nr.take('claude', none), { layer: null });
});

test('原生返回：4 秒内没到作废；到了以后去了别处作废；主界面切后台作废', () => {
  const { nr, tick } = makeNative();
  nr.set('claude', { valid: () => true, current: 'home' });
  tick(ARRIVE_MS + 1);
  nr.screen('claude');
  assert.equal(nr.take('claude', none), null);

  nr.set('claude', { valid: () => true, current: 'home' });
  nr.screen('claude');
  nr.screen('files');
  assert.equal(nr.peek(), null);

  nr.set('claude', { valid: () => true, current: 'home' });
  nr.hidden();                     // 还没到时的切后台（原生切前台的过程）不作数
  assert.ok(nr.peek());
  nr.screen('claude');
  nr.hidden();
  assert.equal(nr.take('claude', none), null);
});

test('原生返回：插件页已经不在了（hasPluginPage 为假 / 旧版 apk）→ 不切，记录消费掉', () => {
  const { nr } = makeNative();
  nr.set('claude', { valid: () => false, current: 'claude' });
  assert.equal(nr.take('claude', none), null);
  assert.equal(nr.peek(), null);
});

test('原生返回：目标是层（文件预览）—— 层开着就连层收；人自己关了层就作废', () => {
  const { nr } = makeNative();
  const open = new Set(['preview']);
  nr.set('home', { layer: 'preview', valid: () => true, current: 'home' });
  assert.deepEqual(nr.take('home', (n) => open.has(n)), { layer: 'preview' });

  nr.set('home', { layer: 'preview', valid: () => true, current: 'home' });
  open.clear();
  assert.equal(nr.take('home', (n) => open.has(n)), null);
  assert.equal(nr.peek(), null, '目标层被人关掉 = 去了别处');
});

test('原生返回：落地后人又开了别的层 → 这次先照常关那一层，记录留着', () => {
  const { nr } = makeNative();
  const open = new Set();
  nr.set('claude', { valid: () => true, current: 'claude' });
  open.add('drawer');
  assert.equal(nr.take('claude', (n) => open.has(n)), null);
  assert.ok(nr.peek(), '留着');
  open.delete('drawer');
  assert.deepEqual(nr.take('claude', (n) => open.has(n)), { layer: null });

  // 目标层是设置，上面又盖了文件预览：先关预览；设置之下的层（抽屉）不算「上面」
  nr.set('claude', { layer: 'settings', valid: () => true, current: 'claude' });
  open.add('preview'); open.add('settings'); open.add('drawer');
  assert.equal(nr.take('claude', (n) => open.has(n)), null);
  open.delete('preview');
  assert.deepEqual(nr.take('claude', (n) => open.has(n)), { layer: 'settings' });
});

test('原生返回：isOpen 抛错按「没开」；不认识的层名不记层', () => {
  const { nr } = makeNative();
  nr.set('claude', { layer: 'bogus', valid: () => true, current: 'claude' });
  assert.equal(nr.peek().layer, null);
  assert.deepEqual(nr.take('claude', () => { throw new Error('x'); }), { layer: null });
});
