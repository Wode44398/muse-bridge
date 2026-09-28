// 会话标题不许漏内部提示词与服务器绝对路径。
//
// 标题取的是第一条用户消息原文；带附件发送时 claude.mjs 会把「[用户上传了以下附件…
// 绝对路径如下]」整段注进 prompt 并写入 transcript。气泡那条通道早就用
// splitAttachments() 剥掉了，标题这条没有——体检时在线上 /api/sessions 实测到
// 「…教我看懂这些数据 [用户上传了以下附件，绝对路径如下，请按需用 Read 工具读取
// （图片也用 Read）] - C:\Users\alice\…」。该接口对普通 user 与公开快照访客同样开放。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimTitle } from './sessions.mjs';

const withAtt = (text, ...paths) =>
  `${text}\n\n[用户上传了以下附件，绝对路径如下。图片已经直接附在本条消息里]\n`
  + paths.map((p) => '- ' + p).join('\n');

test('标题剥掉附件注入段，只留用户真正说的话', () => {
  const t = trimTitle(withAtt('这些都是什么意思，教我看懂这些数据',
    'C:\\Users\\alice\\muse-bridge\\uploads\\1755000000000-截图.png'));
  assert.equal(t, '这些都是什么意思，教我看懂这些数据');
});

test('标题里绝不出现服务器绝对路径或提示词脚手架', () => {
  const t = trimTitle(withAtt('看看这个', 'C:\\Users\\alice\\muse-bridge\\uploads\\1755000000000-a.png'));
  assert.doesNotMatch(t, /用户上传了以下附件/);
  assert.doesNotMatch(t, /C:\\/);
  assert.doesNotMatch(t, /uploads/);
});

test('只传附件、一个字没写时用附件名兜底——不能剥成空标题（空标题会被列表整条丢掉）', () => {
  const t = trimTitle(withAtt('', 'C:\\Users\\alice\\muse-bridge\\uploads\\1755000000000-年报.pdf'));
  assert.equal(t, '年报.pdf');
  assert.notEqual(t.trim(), '');
});

test('多个附件时名字都留下，仍然不带路径', () => {
  const t = trimTitle(withAtt('',
    'C:\\Users\\alice\\muse-bridge\\uploads\\1-a.png',
    'C:\\Users\\alice\\muse-bridge\\uploads\\2-b.png'));
  assert.equal(t, 'a.png、b.png');
  assert.doesNotMatch(t, /C:\\/);
});

test('没有附件的普通标题一字不动，超长照旧截断', () => {
  assert.equal(trimTitle('  帮我看一下  这个  '), '帮我看一下 这个');
  const long = '啊'.repeat(200);
  const t = trimTitle(long);
  assert.equal(t.length, 81);
  assert.ok(t.endsWith('…'));
});
