// /api/overview 的 pendingDetail：桌面壳的系统通知靠它把「在等你回答」连问题原文一起弹出来。
// 关键不变量：qid（作答凭据）绝不出现在响应里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOverviewRoutes } from './overview.mjs';
import { sessionQuestions } from '../runtime/questions.mjs';

function captureOverview() {
  let handler = null;
  const router = { on: (method, path, fn) => { if (method === 'GET' && path === '/api/overview') handler = fn; } };
  registerOverviewRoutes(router, { authOk: () => true, identify: () => ({ kind: 'admin' }) });
  assert.ok(handler, '没注册 /api/overview');
  let body = '';
  const res = { writeHead() {}, end(chunk) { body = chunk; } };
  handler({ headers: {}, url: '/api/overview' }, res, new URL('http://x/api/overview'));
  return JSON.parse(body);
}

test('pendingDetail 带出问题原文与 ts，且不泄漏 qid', () => {
  sessionQuestions.clear();
  sessionQuestions.set('sess-1', {
    qid: 'qid-secret-must-not-leak',
    questions: [{ header: '覆盖', question: '目标目录已有同名文件，要覆盖吗？', options: [] }],
    ts: 1700000000000,
  });
  try {
    const out = captureOverview();
    assert.deepEqual(out.pending, ['sess-1'], '旧字段 pending 必须保持不变（手机端在吃它）');
    assert.equal(out.pendingDetail.length, 1);
    assert.deepEqual(out.pendingDetail[0], {
      sessionId: 'sess-1',
      ts: 1700000000000,
      header: '覆盖',
      question: '目标目录已有同名文件，要覆盖吗？',
    });
    assert.doesNotMatch(JSON.stringify(out), /qid/i, 'qid 是作答凭据，绝不能出现在 overview 里');
  } finally { sessionQuestions.clear(); }
});

test('没有待答问题时 pendingDetail 是空数组', () => {
  sessionQuestions.clear();
  const out = captureOverview();
  assert.deepEqual(out.pending, []);
  assert.deepEqual(out.pendingDetail, []);
});

test('问题超长会被截断，通知不会被塞爆', () => {
  sessionQuestions.clear();
  sessionQuestions.set('sess-2', { qid: 'q', questions: [{ header: 'h'.repeat(80), question: 'x'.repeat(500) }], ts: 1 });
  try {
    const detail = captureOverview().pendingDetail[0];
    assert.equal(detail.header.length, 40);
    assert.equal(detail.question.length, 200);
  } finally { sessionQuestions.clear(); }
});
