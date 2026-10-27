import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession, pngSize } from './cdp.mjs';
import { runBatch, hasExpect, waitExpect } from './browser-verify.mjs';

// 2026-10-21 浏览器升级：坐标 = 最近一张截图的像素，越界/过期报错；batch 遇错即停。
// 真浏览器上的端到端（落点、遮挡、结果比对、expect、缩放截图）见 bridge build/.scratch/browser-e2e.mjs。

function session({ vp = [1280, 900], frame = null, target = 't1' } = {}) {
  const s = new CdpSession();
  s.viewport = { width: vp[0], height: vp[1] };
  s.activeTargetId = target;
  s.frame = frame;
  return s;
}

test('没截过图：坐标按 CSS 像素，越界报错', () => {
  const s = session();
  assert.deepEqual(s.frameToCss(10, 20), { x: 10, y: 20, k: 1 });
  assert.throws(() => s.frameToCss(1280, 5), /超出视口（1280×900）/);
  assert.throws(() => s.frameToCss(-1, 5), /超出/);
});

test('缩放过的截图：按图像素换算回 CSS，越界按图尺寸判', () => {
  const s = session({ vp: [3000, 1000], frame: { imgW: 1568, imgH: 523, k: 3000 / 1568, vpW: 3000, vpH: 1000, targetId: 't1' } });
  const p = s.frameToCss(784, 100);
  assert.equal(Math.round(p.x), 1500);
  assert.throws(() => s.frameToCss(1600, 10), /最近那张截图（1568×523）/);
});

test('缩放截图之后视口或标签变了 → 要求重截；1:1 的旧图不拦', () => {
  const scaled = { imgW: 1568, imgH: 523, k: 3000 / 1568, vpW: 3000, vpH: 1000, targetId: 't1' };
  const s = session({ vp: [1280, 900], frame: scaled });
  assert.throws(() => s.frameToCss(10, 10), /重新 screenshot/);
  const t = session({ vp: [3000, 1000], frame: scaled, target: 't2' });
  assert.throws(() => t.frameToCss(10, 10), /重新 screenshot/);
  const u = session({ vp: [1280, 900], frame: { imgW: 375, imgH: 812, k: 1, vpW: 375, vpH: 812, targetId: 't1' } });
  assert.deepEqual(u.frameToCss(500, 10), { x: 500, y: 10, k: 1 });
});

test('pngSize 读 IHDR', () => {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x49484452, 12); b.writeUInt32BE(1568, 16); b.writeUInt32BE(523, 20);
  assert.deepEqual(pngSize(b), { width: 1568, height: 523 });
  assert.deepEqual(pngSize(Buffer.alloc(4)), { width: 0, height: 0 });
});

test('batch：逐步执行、遇错即停、报出没执行的步数；不能嵌套、有上限', async () => {
  const ran = [];
  const runOne = async (s) => { ran.push(s.action); return s.action === 'bad' ? { content: [{ type: 'text', text: '坏了' }], isError: true } : { content: [{ type: 'text', text: 'ok' }] }; };
  const r = await runBatch([{ action: 'a' }, { action: 'bad' }, { action: 'c' }], runOne);
  assert.equal(r.isError, true);
  assert.deepEqual(ran, ['a', 'bad']);
  assert.match(r.content.at(-1).text, /后面 1 步没有执行/);
  assert.equal((await runBatch([{ action: 'batch' }], runOne)).isError, true);
  assert.equal((await runBatch(Array(21).fill({ action: 'a' }), runOne)).isError, true);
});

test('expect：只给 changed 时直接按动作后的结论判，不进页面', async () => {
  assert.equal(hasExpect({}), false);
  assert.equal(hasExpect({ changed: false }), true);
  const b = { send: async () => { throw new Error('不该进页面'); } };
  assert.equal(await waitExpect(b, { changed: true }, { changedNow: true }), null);
  assert.match((await waitExpect(b, { changed: true }, { changedNow: false })).join(), /实际什么都没变/);
});
