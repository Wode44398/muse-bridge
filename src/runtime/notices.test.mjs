import test from 'node:test';
import assert from 'node:assert/strict';
import { postNotice, recentNotices, turnOutcome, plainSummary, noticeRunEnd, noticeRunStart, _resetNotices } from './notices.mjs';
import { sessionQuestions } from './questions.mjs';

test('postNotice 按身份隔离、带 ageMs、最多 40 条', () => {
  _resetNotices();
  postNotice('admin', { kind: 'done', sessionId: 's1', title: '修登录页', body: '好了' });
  postNotice('u:bob', { kind: 'error', sessionId: 's2', body: '炸了' });
  const a = recentNotices('admin');
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'done');
  assert.equal(a[0].title, '修登录页');
  assert.equal(typeof a[0].ageMs, 'number');
  assert.equal(a[0].at, undefined);
  for (let i = 0; i < 50; i++) postNotice('admin', { kind: 'done', sessionId: 's' + i });
  assert.equal(recentNotices('admin').length, 40);
  assert.equal(recentNotices('nobody').length, 0);
});

test('提问登记（sessionQuestions.set）→ 一条 question / permission 通知，同一张卡只报一次', () => {
  _resetNotices();
  sessionQuestions.set('sq1', { qid: 'q-1', kind: 'question', ownerKey: 'admin', questions: [{ header: '覆盖', question: '要覆盖旧文件吗？' }], ts: 1 });
  sessionQuestions.set('sq1', { qid: 'q-1', kind: 'question', ownerKey: 'admin', questions: [{ header: '覆盖', question: '要覆盖旧文件吗？' }], ts: 1 });
  sessionQuestions.set('sq1', { qid: 'q-2', kind: 'plan', ownerKey: 'admin', questions: [{ header: '计划', question: '批准这个计划？' }], ts: 2 });
  sessionQuestions.set('sq1', { qid: 'q-3', kind: 'question', questions: [{ question: '没有 ownerKey 的老条目' }], ts: 3 });
  const list = recentNotices('admin');
  assert.deepEqual(list.map((n) => [n.kind, n.sub, n.body]), [['question', 'question', '要覆盖旧文件吗？'], ['permission', 'plan', '批准这个计划？']]);
  sessionQuestions.delete('sq1');
});

test('turnOutcome：完成 / 出错 / 人为停止 / busy', () => {
  assert.deepEqual(turnOutcome({ events: [{ type: 'text', text: 'x' }, { type: 'done', result: '## 好了\n已经**修好**了', isError: false }] }), { kind: 'done', body: '好了 已经修好了' });
  assert.equal(turnOutcome({ events: [{ type: 'done', result: 'boom', isError: true }] }).kind, 'error');
  const e = turnOutcome({ events: [{ type: 'error', kind: 'rate_limit', title: '额度用完', hint: '3 点重置' }] });
  assert.equal(e.kind, 'error');
  assert.equal(e.body, '额度用完 — 3 点重置');
  assert.equal(turnOutcome({ events: [{ type: 'interrupted' }] }).kind, 'stopped');
  assert.equal(turnOutcome({ events: [{ type: 'error', kind: 'busy', title: 'x' }] }).kind, 'skip');
  assert.equal(turnOutcome({ events: [] }).kind, 'skip');
});

test('noticeRunEnd：胶囊 / 定时任务 / 停止不出；正常完成带上开跑时记下的标题', () => {
  _resetNotices();
  const ctx = { key: 'admin' };
  const done = [{ type: 'done', result: 'ok' }];
  noticeRunEnd(ctx, { sessionId: 'c1', source: 'capsule', events: done });
  noticeRunEnd(ctx, { sessionId: 'r1', family: { origin: { kind: 'routine' } }, events: done });
  noticeRunEnd(ctx, { sessionId: 'x1', events: [{ type: 'interrupted' }] });
  noticeRunEnd({ key: 'admin', snap: true }, { sessionId: 'p1', events: done });
  assert.equal(recentNotices('admin').length, 0);
  noticeRunStart({ key: 'admin', snap: true }, { sessionId: 'n1', userText: '不该记' });
  noticeRunStart(ctx, { sessionId: 'n1', userText: '把导航栏改成玻璃的' });
  noticeRunEnd(ctx, { sessionId: 'n1', events: done });
  const [n] = recentNotices('admin');
  assert.equal(n.kind, 'done');
  assert.equal(n.title, '把导航栏改成玻璃的');
  assert.equal(n.sessionId, 'n1');
});

test('plainSummary 去掉代码块与 Markdown 记号', () => {
  assert.equal(plainSummary('看这里：\n```js\nconst a = 1\n```\n- 第一条\n- [链接](http://x)'), '看这里： [代码] 第一条 链接');
  assert.ok(plainSummary('啊'.repeat(400)).length <= 161);
});
