// fileGrid.js：时长格式、视图偏好、相册类判定、打开序列、元数据轮询
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtDur, viewFor, withView, loadViewPrefs, saveViewPrefs, loadSortPref, saveSortPref, isAlbumDir, previewGroupOf, buildSequence, watchMeta, typeIconSvg, uiIconSvg, extBadge, cloudThumbable, nameHtml } from './fileGrid.js';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

test('fmtDur：分秒与时分秒，非法值当 0', () => {
  assert.equal(fmtDur(0), '0:00');
  assert.equal(fmtDur(5.4), '0:05');
  assert.equal(fmtDur(83), '1:23');
  assert.equal(fmtDur(3723), '1:02:03');
  assert.equal(fmtDur(-3), '0:00');
  assert.equal(fmtDur('abc'), '0:00');
});

test('视图偏好：相册类没记过时列表给图标、记过就用自己那份；切换只改对应那一份', () => {
  const p = { view: 'list', album: null };
  assert.equal(viewFor(p, false), 'list');
  assert.equal(viewFor(p, true), 'grid');
  assert.equal(viewFor({ view: 'large', album: null }, true), 'large');
  const q = withView(p, 'large', true);
  assert.deepEqual(q, { view: 'list', album: 'large' });
  assert.equal(viewFor(q, true), 'large');
  assert.equal(viewFor(q, false), 'list');
  assert.deepEqual(withView(q, 'grid', false), { view: 'grid', album: 'large' });
  assert.equal(withView(q, 'bogus', false), q);
});

test('视图与排序偏好落盘：坏值回落默认', () => {
  mem.clear();
  assert.deepEqual(loadViewPrefs(), { view: 'list', album: null });
  saveViewPrefs({ view: 'grid', album: 'large' });
  assert.deepEqual(loadViewPrefs(), { view: 'grid', album: 'large' });
  mem.set('bridge.files.view', '{"view":"huge","album":7}');
  assert.deepEqual(loadViewPrefs(), { view: 'list', album: null });
  mem.set('bridge.files.view', 'not json');
  assert.deepEqual(loadViewPrefs(), { view: 'list', album: null });
  saveSortPref({ key: 'mtime', dir: -1 });
  assert.deepEqual(loadSortPref({ key: 'name', dir: 1 }), { key: 'mtime', dir: -1 });
  mem.set('bridge.files.sort', '{"key":"color","dir":1}');
  assert.equal(loadSortPref({ key: 'name', dir: 1 }).key, 'name');
});

test('相册类文件夹：按名字或按内容（≥6 个且六成是图片视频）', () => {
  assert.equal(isAlbumDir('DCIM', []), true);
  assert.equal(isAlbumDir('Screenshots', []), true);
  assert.equal(isAlbumDir('截图', []), true);
  assert.equal(isAlbumDir('文档', []), false);
  const media = ['a.jpg', 'b.png', 'c.mp4', 'd.heic', 'e.webp', 'f.mov'].map((name) => ({ name }));
  assert.equal(isAlbumDir('杂物', media), true);
  assert.equal(isAlbumDir('杂物', media.slice(0, 5)), false);
  const mixed = [...media, ...['1.txt', '2.pdf', '3.zip', '4.doc', '5.md'].map((name) => ({ name }))];
  assert.equal(isAlbumDir('杂物', mixed), false); // 6/11 不到六成
  assert.equal(isAlbumDir('杂物', [...media, { name: 'sub', isDir: true }]), true); // 文件夹不计
});

test('预览分组：图片与视频同组，音频自成一组，没有查看器的不进序列', () => {
  assert.equal(previewGroupOf('a.jpg'), 'media');
  assert.equal(previewGroupOf('a.MP4'), 'media');
  assert.equal(previewGroupOf('a.mp3'), 'audio');
  assert.equal(previewGroupOf('a.pdf'), 'doc');
  assert.equal(previewGroupOf('a.md'), 'doc');
  assert.equal(previewGroupOf('a.zip'), '');
});

test('打开序列：按列表顺序取同组，跳过文件夹，accept 筛不掉点中的那一个', () => {
  const list = [
    { name: 'dir', isDir: true }, { name: 'b.jpg' }, { name: 'c.mp4' }, { name: 'x.pdf' },
    { name: 'a.png' }, { name: 'song.mp3' }, { name: 'skip.gif' }, { name: 'y.md' },
  ];
  const r = buildSequence(list, list[4]);
  assert.deepEqual(r.seq.map((f) => f.name), ['b.jpg', 'c.mp4', 'a.png', 'skip.gif']);
  assert.equal(r.index, 2);
  const d = buildSequence(list, list[7]);
  assert.deepEqual(d.seq.map((f) => f.name), ['x.pdf', 'y.md']);
  assert.equal(d.index, 1);
  const a = buildSequence(list, list[1], { accept: (f) => f.name !== 'skip.gif' && f.name !== 'b.jpg' });
  assert.deepEqual(a.seq.map((f) => f.name), ['b.jpg', 'c.mp4', 'a.png']);
  assert.equal(a.index, 0);
  // 没有查看器的单独一项；目标不在列表里也只给它自己
  assert.deepEqual(buildSequence(list, { name: 'z.zip' }), { seq: [{ name: 'z.zip' }], index: 0 });
  const ghost = { name: 'ghost.jpg' };
  assert.deepEqual(buildSequence(list, ghost), { seq: [ghost], index: 0 });
  // same 按 rel 比较（列表重建后对象不是同一个）
  const s = buildSequence(list, { name: 'c.mp4' }, { same: (f, t) => f.name === t.name });
  assert.equal(s.index, 1);
});

test('元数据轮询：pending 时重试到 tries 为止，停了之后的结果丢弃', async () => {
  let calls = 0; const got = [];
  const stop = watchMeta(async () => { calls++; return { items: { [`f${calls}`]: { w: calls } }, pending: 1 }; }, (m) => got.push(Object.keys(m)[0]), { interval: 5, tries: 3 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 3);
  assert.deepEqual(got, ['f1', 'f2', 'f3']);
  stop();
  let late = 0;
  const stop2 = watchMeta(() => new Promise((r) => setTimeout(() => r({ items: { a: {} }, pending: 0 }), 20)), () => late++);
  stop2();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(late, 0);
  // fetcher 抛错不炸
  const stop3 = watchMeta(async () => { throw new Error('x'); }, () => {});
  stop3();
});

test('线稿图标：24 网格、只用 currentColor；扩展名角标限长', () => {
  for (const n of ['a.jpg', 'a.mp4', 'a.xlsx', 'a.zip', 'a.ttf', 'a.unknownext']) {
    const s = typeIconSvg(n);
    assert.match(s, /viewBox="0 0 24 24"/);
    assert.match(s, /stroke="currentColor"/);
    assert.doesNotMatch(s, /#[0-9a-f]{3,6}/i);
  }
  assert.match(typeIconSvg('x', { isDir: true }), /<svg/);
  for (const k of ['list', 'grid', 'large', 'sortUp', 'sortDown', 'preview', 'pane']) assert.match(uiIconSvg(k), /<svg/);
  assert.equal(uiIconSvg('nope'), '');
  assert.equal(extBadge('a.jpeg'), 'JPEG');
  assert.ok(extBadge('a.verylongextension').length <= 5);
  assert.equal(extBadge('noext'), '');
});

test('格子名字：先转义再在连接符后插 <wbr>，去掉 <wbr> 就是原名', () => {
  assert.equal(nameHtml('超高-1080x8000.jpg'), '超高-<wbr>1080x8000.<wbr>jpg');
  assert.equal(nameHtml(`<b>&"x'.txt`), '&lt;b&gt;&amp;&quot;x&#39;.<wbr>txt');
  assert.equal(nameHtml('a- b'), 'a- b');          // 空格本来就能断，不重复插
  assert.equal(nameHtml('.env'), '.<wbr>env');
  assert.equal(nameHtml(''), '');
  assert.equal(nameHtml(null), '');
  const raw = 'my_file-v2.final.tar.gz';
  assert.equal(nameHtml(raw).replace(/<wbr>/g, ''), raw);
});

test('云端缩略图：图片视频两档都有；文稿首页 / 音频封面只在图标视图要', () => {
  assert.equal(cloudThumbable('a.JPG'), true);
  assert.equal(cloudThumbable('a.mp4'), true);
  assert.equal(cloudThumbable('a.pdf'), false);
  assert.equal(cloudThumbable('a.pdf', true), true);
  assert.equal(cloudThumbable('a.DOCX', true), true);
  assert.equal(cloudThumbable('a.mp3', true), true);
  assert.equal(cloudThumbable('a.zip', true), false);
  assert.equal(cloudThumbable('pdf', true), false);
  assert.equal(cloudThumbable('', true), false);
});
