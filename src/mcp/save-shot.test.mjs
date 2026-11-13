import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { resolveSaveTo, saveTarget, saveShots } from './save-shot.mjs';

// 调试反馈 B4：截图只随结果回图，agent 要存文件只能去 tool-results 翻 blob 再拷。save_to 在 MCP 层把图落盘。

function png(w, h) {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x49484452, 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b.toString('base64');
}
const img = (w, h) => ({ type: 'image', data: png(w, h), mimeType: 'image/png' });
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'save-shot-'));
const say = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('saveTarget：相对路径按工作空间、补 .png、目录模式、拒非 PNG 扩展名', () => {
  const ws = tmp();
  const at = (p) => saveTarget(p, (x) => resolveSaveTo(x, ws));
  assert.deepEqual(at('shots/home'), { file: path.join(ws, 'shots', 'home.png') });
  assert.deepEqual(at('a.PNG'), { file: path.join(ws, 'a.PNG') });
  assert.deepEqual(at('v1.2'), { file: path.join(ws, 'v1.2.png') }, '不认识的「扩展名」当文件名的一部分');
  assert.deepEqual(at('out/'), { dir: path.join(ws, 'out') });
  mkdirSync(path.join(ws, 'existing'));
  assert.deepEqual(at('existing'), { dir: path.join(ws, 'existing') });
  assert.match(at('a.jpg').error, /只存 PNG/);
  assert.match(at('  ').error, /空的/);
});

test('resolveSaveTo：沙箱身份（roots）只准落在自己的目录里', () => {
  const ws = tmp();
  const roots = [ws];
  assert.equal(resolveSaveTo('sub/x.png', ws, roots).path, path.join(ws, 'sub', 'x.png'));
  assert.match(resolveSaveTo('../escape.png', ws, roots).error, /只能存进你的工作空间/);
  assert.match(resolveSaveTo(path.join(os.tmpdir(), 'elsewhere.png'), ws, roots).error, /解析到了外面/);
  assert.equal(resolveSaveTo(path.join(os.tmpdir(), 'elsewhere.png'), ws, null).path, path.join(os.tmpdir(), 'elsewhere.png'), 'roots=null 不限');
});

test('saveShots：单张存到给定文件名，回执写路径和尺寸；覆盖要说', async () => {
  const ws = tmp();
  const target = { file: path.join(ws, 'shots', 'home.png') };
  const r = await saveShots({ content: [img(1280, 900), { type: 'text', text: 'url: x' }] }, target);
  assert.equal(r.content[0].type, 'image', '图照样随结果返回');
  assert.ok(existsSync(target.file));
  assert.equal(readFileSync(target.file).readUInt32BE(16), 1280);
  assert.match(say(r), new RegExp(`截图已存到 ${target.file.replace(/\\/g, '\\\\')}（1280×900）$`));
  const again = await saveShots({ content: [img(375, 812), { type: 'text', text: 'url: x' }] }, target);
  assert.match(say(again), /（375×812，覆盖了原文件）/);
});

test('saveShots：batch 多张按 -1、-2 存，回执对上是第几步的图', async () => {
  const ws = tmp();
  const result = { content: [
    { type: 'text', text: '第 2 步（screenshot）的截图：' }, img(375, 812),
    { type: 'text', text: '第 4 步（click）的截图：' }, img(1280, 900),
    { type: 'text', text: '1. navigate：ok\n2. screenshot：ok' },
  ] };
  const r = await saveShots(result, { file: path.join(ws, 'flow.png') });
  const log = r.content.at(-1).text;
  assert.match(log, /第 2 步的截图已存到 .*flow-1\.png（375×812）/);
  assert.match(log, /第 4 步的截图已存到 .*flow-2\.png（1280×900）/);
  assert.deepEqual(readdirSync(ws).sort(), ['flow-1.png', 'flow-2.png']);
});

test('saveShots：目录模式自动起名不覆盖；没有图就说没存', async () => {
  const ws = tmp();
  const one = await saveShots({ content: [img(10, 10), { type: 'text', text: 'a' }] }, { dir: ws });
  const two = await saveShots({ content: [img(10, 10), { type: 'text', text: 'b' }] }, { dir: ws });
  const names = readdirSync(ws);
  assert.equal(names.length, 2, '同一秒再存一张也不覆盖');
  assert.ok(names.every((n) => /^shot-\d{8}-\d{6}(-\d+)?\.png$/.test(n)));
  assert.doesNotMatch(say(one) + say(two), /覆盖/);

  const none = await saveShots({ content: [{ type: 'text', text: '已点击' }] }, { dir: ws });
  assert.match(say(none), /save_to：这次结果里没有截图，什么也没存/);
  const failed = await saveShots({ content: [{ type: 'text', text: '坏了' }], isError: true }, { dir: ws });
  assert.equal(failed.isError, true);
  assert.match(say(failed), /动作没成功/);
});

test('saveShots：写不进去只在回执里报，不把动作结果变成失败', async () => {
  const ws = tmp();
  const blocker = path.join(ws, 'blocker');
  writeFileSync(blocker, 'x');   // 目录位置上是个文件 → mkdir 失败
  const r = await saveShots({ content: [img(10, 10), { type: 'text', text: 'ok' }] }, { file: path.join(blocker, 'a.png') });
  assert.equal(r.isError, undefined);
  assert.match(say(r), /⚠ save_to 没存成/);
});

test('saveShots：落盘前复核——动作期间目录被换成指向外面的联接点就不写', async () => {
  const ws = tmp();
  const outside = tmp();
  const place = (p) => resolveSaveTo(p, ws, [ws]);
  const target = saveTarget('sub/a.png', place);
  assert.equal(target.file, path.join(ws, 'sub', 'a.png'), '动作前 sub 还不存在，按字面放行');
  symlinkSync(outside, path.join(ws, 'sub'), 'junction');
  const r = await saveShots({ content: [img(10, 10), { type: 'text', text: 'ok' }] }, target, place);
  assert.match(say(r), /⚠ save_to 没存成：save_to 只能存进你的工作空间/);
  assert.deepEqual(readdirSync(outside), [], '外面什么也没写');
});
