import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendState, keyAction, placeholderKind, slashMatches, bangCommand, relPath, permOptions, ruleText,
  diffLines, questionAnswer, questionPayload, dropIndex, moveItem, fmtSize, petFrames, petLook, petMood, PET,
} from './logic.js';

test('发送键：空着让位，有字 ready，跑着停止，跑着又打字是插话', () => {
  assert.equal(sendState({}), 'none');
  assert.equal(sendState({ draft: true }), 'ready');
  assert.equal(sendState({ busy: true }), 'busy');
  assert.equal(sendState({ busy: true, draft: true }), 'steer');
});

test('按键：回车发送 / 跑着回车插话 / Ctrl+回车稍后发送 / Shift+Tab 计划', () => {
  const k = (o) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...o });
  assert.equal(keyAction(k({}), { draft: true }), 'send');
  assert.equal(keyAction(k({}), { draft: true, busy: true }), 'steer');
  assert.equal(keyAction(k({ ctrlKey: true }), { draft: true, busy: true }), 'queue');
  assert.equal(keyAction(k({ metaKey: true }), { draft: true, busy: true }), 'queue');
  assert.equal(keyAction(k({ shiftKey: true }), { draft: true }), null);
  assert.equal(keyAction(k({ isComposing: true }), { draft: true }), null);
  assert.equal(keyAction(k({}), { draft: false }), 'noop');
  // 触屏：回车换行，外接键盘 Ctrl+回车照样认
  assert.equal(keyAction(k({}), { draft: true, touch: true }), null);
  assert.equal(keyAction(k({ ctrlKey: true }), { draft: true, touch: true, busy: true }), 'queue');
  assert.equal(keyAction({ key: 'Tab', shiftKey: true }, {}), 'plan');
  assert.equal(keyAction({ key: 'Tab', shiftKey: false }, {}), null);
});

test('占位字', () => {
  assert.equal(placeholderKind({ home: true }), 'home');
  assert.equal(placeholderKind({ home: false }), 'thread');
  assert.equal(placeholderKind({ plan: true }), 'plan');
  assert.equal(placeholderKind({ busy: true, plan: true }), 'busy');
  assert.equal(placeholderKind({ busy: true, touch: true }), 'busyTouch');
});

test('斜杠命令：整段是 /xxx 才弹；首页没有要线程的命令；按名字也能搜', () => {
  assert.equal(slashMatches('hello'), null);
  assert.equal(slashMatches('/re view'), null);
  assert.deepEqual(slashMatches('/', { inThread: false }).map((x) => x.cmd), ['/plan', '/model', '/status']);
  assert.equal(slashMatches('/', { inThread: true }).length, 7);
  assert.deepEqual(slashMatches('/co', { inThread: true }).map((x) => x.cmd), ['/compact']);
  assert.deepEqual(slashMatches('/压缩', { inThread: true, names: { '/compact': '压缩上下文' } }).map((x) => x.cmd), ['/compact']);
  assert.deepEqual(slashMatches('/zzz', { inThread: true }), []);
});

test('!命令', () => {
  assert.equal(bangCommand('!npm test'), 'npm test');
  assert.equal(bangCommand('! git status  '), 'git status');
  assert.equal(bangCommand('!'), null);
  assert.equal(bangCommand('npm test'), null);
});

test('工作目录写成项目内相对路径', () => {
  assert.equal(relPath('C:\\Users\\a\\proj\\src', 'C:\\Users\\a\\proj'), 'src');
  assert.equal(relPath('c:/users/a/proj', 'C:\\Users\\a\\proj\\'), '.');
  assert.equal(relPath('/tmp/x', '/home/a/proj'), '/tmp/x');
  assert.equal(relPath('', '/home'), '');
});

test('审批选项：能「这个对话都允许」才有第二项；前缀规则只给管理员的命令审批', () => {
  const cmd = { preview: { kind: 'command' }, canAlways: true, codex: { canRule: true, proposedRule: ['npm', 'install'] } };
  assert.deepEqual(permOptions(cmd).map((o) => o.key), ['once', 'always', 'deny']);
  assert.deepEqual(permOptions(cmd, { admin: true }).map((o) => o.key), ['once', 'always', 'rule', 'deny']);
  assert.deepEqual(permOptions({ preview: { kind: 'edit' }, codex: { canRule: true } }, { admin: true }).map((o) => o.key), ['once', 'deny']);
  assert.equal(ruleText(cmd), 'npm install');
  assert.equal(ruleText({}), '');
});

test('diff 预览拆行', () => {
  const d = diffLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
  assert.deepEqual(d.lines.map((l) => l.k), ['hunk', 'ctx', 'del', 'add']);
  assert.equal(d.cut, false);
});

test('提问作答', () => {
  const q = { options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
  assert.deepEqual(questionAnswer(q, ['C', 'A']), { selected: ['A', 'C'] });
  assert.deepEqual(questionAnswer(q, [], '  自己写 '), { selected: [], custom: '自己写' });
  assert.equal(questionAnswer(q, [], ''), null);
  assert.equal(questionPayload([{ selected: ['A'] }], 2), null);
  assert.deepEqual(questionPayload([{ selected: ['A'] }, { selected: [], custom: 'x' }], 2), { answers: [{ selected: ['A'] }, { selected: [], custom: 'x' }] });
});

test('排队拖动的落点', () => {
  const mids = [10, 50, 90, 130];
  assert.equal(dropIndex(mids, 0, 5), 0);
  assert.equal(dropIndex(mids, 0, 60), 1);
  assert.equal(dropIndex(mids, 0, 200), 3);
  assert.equal(dropIndex(mids, 3, 40), 1);
  assert.equal(dropIndex(mids, 2, 90), 2);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
});

test('附件大小', () => {
  assert.equal(fmtSize(500), '500 B');
  assert.equal(fmtSize(248 * 1024), '248 KB');
  assert.equal(fmtSize(2.5 * 1024 * 1024), '2.5 MB');
});

test('吉祥物帧表', () => {
  const idle = petFrames('idle');
  assert.equal(idle.frames.length, 6);
  const loop = petFrames('running', true);
  assert.equal(loop.frames.length, PET.running.n);
  assert.equal(loop.frames.at(-1).d, PET.running.b);
  const once = petFrames('jumping', false);
  assert.equal(once.loopAt, PET.jumping.n * 3);
  assert.equal(once.frames.length, PET.jumping.n * 3 + 6);
  assert.equal(petLook(0, 0), null);
  assert.deepEqual(petLook(0, -100), { r: 9, c: 0, d: 0 });      // 正上方
  assert.deepEqual(petLook(0, 100), { r: 10, c: 0, d: 0 });      // 正下方
  assert.deepEqual(petMood({ ask: true, busy: true }), { name: 'waiting', loop: true });
  assert.deepEqual(petMood({ busy: true }), { name: 'running', loop: true });
});
