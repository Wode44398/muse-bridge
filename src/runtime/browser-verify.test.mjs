import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession, pngSize } from './cdp.mjs';
import { runBatch, hasExpect, waitExpect, BATCH_IMAGES } from './browser-verify.mjs';

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

// 11-07 会话 6e9c6c42：4 个 screenshot 只回 3 张、日志照样全写成功，agent 把剩下的图对到了错的步骤上。
test('batch 附图：最多附最后 BATCH_IMAGES 张，每张前标第几步；没附的在那一步和末尾都写明', async () => {
  const img = (n) => ({ type: 'image', data: `png${n}`, mimeType: 'image/png' });
  const runOne = async (s) => (s.action === 'screenshot'
    ? { content: [img(s.n), { type: 'text', text: `截图 ${s.n}` }] }
    : { content: [{ type: 'text', text: 'ok' }] });
  const shots = Array.from({ length: BATCH_IMAGES + 1 }, (_, i) => ({ action: 'screenshot', n: i + 1 }));
  const r = await runBatch([{ action: 'navigate' }, ...shots], runOne);
  assert.equal(r.isError, undefined);
  const imgs = r.content.filter((c) => c.type === 'image');
  assert.equal(imgs.length, BATCH_IMAGES);
  assert.deepEqual(imgs.map((c) => c.data), shots.slice(1).map((s) => `png${s.n}`), '丢的是最早那张');
  // 每张图前面紧挨着一行「第 N 步」：步骤号 = batch 里的序号（第 1 步是 navigate）
  r.content.forEach((c, i) => { if (c.type === 'image') assert.equal(r.content[i - 1].text, `第 ${Number(c.data.slice(3)) + 1} 步（screenshot）的截图：`); });
  const log = r.content.at(-1).text;
  assert.match(log, /2\. screenshot：截图 1\n {3}（这张图没有附上：一次 batch 最多附最后 \d 张/);
  assert.doesNotMatch(log.split('\n3. ')[1], /没有附上/, '附上了的步骤不带说明');
  assert.match(log, new RegExp(`共 ${BATCH_IMAGES + 1} 张图，只附了最后 ${BATCH_IMAGES} 张（第 2 步的没附）`));

  // 出错分支同样标注，失败说明留在最后
  const bad = await runBatch([...shots, { action: 'boom' }, { action: 'navigate' }], async (s) => (s.action === 'boom'
    ? { content: [{ type: 'text', text: '坏了' }], isError: true } : runOne(s)));
  assert.equal(bad.isError, true);
  assert.equal(bad.content.filter((c) => c.type === 'image').length, BATCH_IMAGES);
  assert.equal(bad.content[0].text, '第 2 步（screenshot）的截图：');
  assert.match(bad.content.at(-1).text, new RegExp(`第 1 步的没附）。\\n第 ${BATCH_IMAGES + 2} 步失败，后面 1 步没有执行。$`));

  // 没超上限：全附，不多一句说明
  const few = await runBatch(shots.slice(0, 2), runOne);
  assert.equal(few.content.filter((c) => c.type === 'image').length, 2);
  assert.doesNotMatch(few.content.at(-1).text, /没有附上|只附了/);
});

test('expect：只给 changed 时直接按动作后的结论判，不进页面', async () => {
  assert.equal(hasExpect({}), false);
  assert.equal(hasExpect({ changed: false }), true);
  const b = { send: async () => { throw new Error('不该进页面'); } };
  assert.equal(await waitExpect(b, { changed: true }, { changedNow: true }), null);
  assert.match((await waitExpect(b, { changed: true }, { changedNow: false })).join(), /实际什么都没变/);
});
