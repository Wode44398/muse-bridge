// 设备文件夹引用：编码往返、附件守卫按设备归属放行、提示词标注与历史还原同一套写法。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceRef, formatDeviceRef, isDeviceRef, deviceRefNote, parseDeviceRefNote, basenameOf } from './device-refs.mjs';
import { filterAttachmentPaths } from './attachment-guard.mjs';
import { composeTurnPrompt } from '../agents/claude.mjs';

const WIN = 'D:\\项目\\my app (v2)';

test('编码往返：Windows / UNC / POSIX 绝对路径都认，相对路径与坏编码拒', () => {
  for (const p of [WIN, '\\\\nas\\share\\docs', '/home/me/proj', 'C:/x']) {
    const ref = formatDeviceRef('d-0123456789ab', p);
    assert.deepEqual(parseDeviceRef(ref), { deviceId: 'd-0123456789ab', path: p });
    assert.equal(isDeviceRef(ref), true);
  }
  assert.equal(parseDeviceRef('device://d-1/' + encodeURIComponent('relative\\dir')), null);
  assert.equal(parseDeviceRef('device://d-1/%E0%A4%A'), null);
  assert.equal(parseDeviceRef('device://bad id/' + encodeURIComponent(WIN)), null);
  assert.equal(parseDeviceRef('device://d-1/' + encodeURIComponent('C:\\a\nb')), null);
  assert.equal(parseDeviceRef('C:\\x'), null);
  assert.equal(parseDeviceRef(null), null);
});

test('标注往返：设备名里的「」换掉，不会截断标注', () => {
  assert.deepEqual(parseDeviceRefNote(deviceRefNote('MOON「LIGHT」', 'd-1')), { deviceName: 'MOON LIGHT', deviceId: 'd-1' });
  assert.deepEqual(parseDeviceRefNote(deviceRefNote('', 'd-2')), { deviceName: 'd-2', deviceId: 'd-2' });
  assert.equal(parseDeviceRefNote('文件夹'), null);
  assert.equal(basenameOf(WIN), 'my app (v2)');
  assert.equal(basenameOf('/home/me/proj/'), 'proj');
});

test('附件守卫：设备引用只在 deviceRefOk 认可时放行、归一编码；形似引用的坏串与不给 deviceRefOk 的入口一律拒', () => {
  const good = formatDeviceRef('d-mine', WIN);
  const other = formatDeviceRef('d-other', WIN);
  const ok = (id) => id === 'd-mine';
  assert.deepEqual(filterAttachmentPaths([good, other, 'device://d-mine/relative'], { deviceRefOk: ok }), [good]);
  assert.deepEqual(filterAttachmentPaths([good]), []);   // 扩展 agent 等不给 deviceRefOk
  // 未编码的写法（前端老版本 / 手写）也归一成编码形式
  assert.deepEqual(filterAttachmentPaths(['device://d-mine/' + WIN.replace(/\\/g, '/')], { deviceRefOk: ok }), [formatDeviceRef('d-mine', WIN.replace(/\\/g, '/'))]);
  const many = Array.from({ length: 25 }, (_, i) => formatDeviceRef('d-mine', 'C:\\f' + i));
  assert.equal(filterAttachmentPaths(many, { deviceRefOk: ok }).length, 20);
});

test('提示词：设备引用写成电脑上的原路径 + 标注，说清只能经 mcp__device__files 读；不进原生图片块', () => {
  const { prompt, imageBlocks } = composeTurnPrompt('看看这个项目', [formatDeviceRef('d-none-such', WIN)]);
  assert.match(prompt, /\[用户上传了以下附件/);
  assert.match(prompt, /mcp__device__files/);
  assert.ok(prompt.includes(`- \`${WIN}\`  ← ${deviceRefNote('', 'd-none-such')}`), prompt);   // 以括号结尾的名字也完整包在反引号里
  assert.doesNotMatch(prompt, /标注「文件夹」的是整个目录已挂载在这里/);
  assert.equal(imageBlocks.length, 0);
  // 没有设备引用时不多出这段说明
  assert.doesNotMatch(composeTurnPrompt('x', []).prompt, /mcp__device__files/);
});

test('重开历史：提示词里的设备引用行还原成文件夹卡（带哪台电脑），不剥数字前缀、不当成服务器路径', async () => {
  const { splitAttachments } = await import('../routes/sessions.mjs');
  const p = 'D:\\2024-报告';
  const { prompt } = composeTurnPrompt('看一下', [formatDeviceRef('d-x1', p), formatDeviceRef('d-x1', '/srv/1755000000000-a.png')]);
  const sp = splitAttachments(prompt);
  assert.equal(sp.text, '看一下');
  assert.deepEqual(sp.attachments[0], { file: '2024-报告', name: '2024-报告', raw: p, kind: 'folder', device: { id: 'd-x1', name: 'd-x1' } });
  assert.equal(sp.attachments[1].name, '1755000000000-a.png');
});
