// chat.answer 的字符串答案按选项文字判「选中 / 自定义」：它比对的 qs[i].options 来自 pendingOf，
// 那里已把官方的 { label, description } 选项对象摊成 label 字符串——这条钉住，免得以后改 pendingOf 让选项退回对象、
// 字符串答案全被当成自定义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-chat-answer-'));
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const { pendingOf } = await import('./ops/chat.mjs');
const { sessionQuestions } = await import('../runtime/questions.mjs');

test('pendingOf：提问卡的选项摊成 label 字符串（chat.answer 拿字符串答案 includes 比对靠它）', () => {
  const ctx = { kind: 'user', key: 'u:chatans' };
  const sid = 'sess-chat-answer';
  sessionQuestions.set(sid, {
    qid: 'q1', kind: 'question', ownerKey: ctx.key, ts: Date.now(),
    questions: [{ header: '浏览器', question: '用哪个？', multiSelect: false, options: [{ label: '改用 Edge', description: '推荐' }, { label: 'Chrome', description: '' }] }],
  });
  try {
    const [p] = pendingOf(ctx, sid);
    assert.equal(p.kind, 'question');
    assert.deepEqual(p.questions[0].options, ['改用 Edge', 'Chrome']);
    assert.ok(p.questions[0].options.includes('改用 Edge'));
    assert.deepEqual(pendingOf({ kind: 'user', key: 'u:other' }, sid), [], '别人的提问看不到');
  } finally {
    sessionQuestions.delete(sid, 'q1');
  }
});
