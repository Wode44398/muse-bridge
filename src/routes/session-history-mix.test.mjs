// 历史重建的跨路接缝（2026-10-21 整合）：同一份 transcript 里同时有提问卡（ask）、计划卡（plan）、内嵌图表（widget）、
// 拉取请求信封（<ci-monitor-event> / <create-pr-command> 叫醒与命令的用户消息）、跨会话信封（官方 Desktop / 终端会话
// 发来的 peer 记录，开轮的与插进正在跑那一轮的）、会话家族信封（<session-message>）——各自落成与直播同形的段，互相不吞。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据根不在测试里删：删掉后进程里别的模块会反复重建它，测试进程退不出（与 permissions.test.mjs 同样留给系统临时目录）
const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-hist-mix-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const { readSessionMessages } = await import('./sessions.mjs');
const V = await import('../mcp/visualize.mjs');
const { formatAnswer } = await import('../runtime/questions.mjs');

test('ask / plan / widget / PR 信封 / 跨会话信封 / 家族信封同处一份 transcript：段序与直播同形，互不吞', async () => {
  const file = path.join(tmp, 'mix.jsonl');
  const lines = [];
  let n = 0, prev = null;
  const ts = (k) => new Date(Date.UTC(2026, 9, 21, 9, 0, k)).toISOString();
  const push = (o) => { o.uuid = o.uuid || 'r' + (++n); o.parentUuid = prev; prev = o.uuid; o.timestamp = o.timestamp || ts(n); lines.push(JSON.stringify(o)); return o.uuid; };
  const user = (content, extra = {}) => push({ type: 'user', message: { role: 'user', content }, ...extra });
  const asst = (content) => push({ type: 'assistant', message: { role: 'assistant', content } });
  const result = (id, text, isError = false) => [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) }];

  // 第 1 轮：用户 → 提问卡 → 计划卡（批准）→ 图表 → 正文
  user('帮我规划一下');
  const questions = [{ header: '范围', question: '先做哪部分？', multiSelect: false, options: [{ label: '前端', description: '' }, { label: '后端', description: '' }] }];
  asst([{ type: 'text', text: '先确认一下：' }, { type: 'tool_use', id: 'ask1', name: 'AskUserQuestion', input: { questions } }]);
  user(result('ask1', formatAnswer(questions, { answers: [{ selected: ['前端'] }] }), true));
  asst([{ type: 'tool_use', id: 'plan1', name: 'ExitPlanMode', input: { plan: '1. 改前端', planFilePath: 'C:/x/.claude/plans/p.md' } }]);
  user(result('plan1', 'User has approved your plan. You can now start coding.\n\n## Approved Plan:\n1. 改前端'));
  const code = '<svg viewBox="0 0 680 80"><rect x="1" y="1" width="9" height="9"/></svg>';
  asst([{ type: 'tool_use', id: 'rm1', name: V.VIZ_README, input: { modules: ['diagram'] } }]);
  user(result('rm1', '# Inline visuals'));
  asst([{ type: 'tool_use', id: 'w1', name: V.VIZ_SHOW, input: { loading_messages: ['画'], title: 'plan_overview', widget_code: code } }]);
  user(result('w1', 'Rendered and shown to the user inline.'));
  // 插话：官方 Desktop 会话的消息插进了正在跑的这一轮（queued_command + origin peer）
  push({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'Another Claude session sent a message:\n<cross-session-message from="uds:a" from-name="终端会话">\n顺便看下 CI\n</cross-session-message>', source_uuid: 'peer-steer-1', origin: { kind: 'peer', from: 'uds:a', name: '终端会话', body: '顺便看下 CI' } } });
  asst([{ type: 'text', text: '计划已批准，开始改前端。' }]);

  // 第 2 轮：Auto-fix 叫醒（PR 信封）
  user('<ci-monitor-event>\nCI failed on o/r#7: "build"\n</ci-monitor-event>');
  asst([{ type: 'text', text: '修好了 build。' }]);

  // 第 3 轮：「创建拉取请求」命令信封
  user('<create-pr-command>\nOpen a pull request: gh pr create --draft …\n</create-pr-command>');
  asst([{ type: 'text', text: 'PR 已建好。' }]);

  // 第 4 轮：跨会话消息开的轮（isMeta + turnOrigin peer）
  user('Another Claude session sent a message:\n<cross-session-message from="uds:b" from-name="Desktop">\n帮我看看日志\n</cross-session-message>', {
    isMeta: true, turnOrigin: 'peer', origin: { kind: 'peer', from: 'uds:b', name: 'Desktop', body: '帮我看看日志' },
  });
  asst([{ type: 'text', text: '日志看完了。' }]);

  // 第 5 轮：会话家族信封（子会话汇报）
  user('<session-message from="c1" name="子会话" title="t" relation="child">\n做完了\n</session-message>');
  asst([{ type: 'text', text: '收到汇报。' }]);

  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  try {
    const msgs = await readSessionMessages(file);
    const roles = msgs.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    const a1 = msgs[1];
    assert.deepEqual(a1.segments.map((s) => s.kind), ['text', 'ask', 'plan', 'widget', 'steer', 'text']);
    const ask = a1.segments[1];
    assert.equal(ask.qid, 'ask1');
    assert.equal(ask.answered, true);
    const plan = a1.segments[2];
    assert.equal(plan.qid, 'plan1');
    assert.equal(plan.decision, 'accept');
    assert.equal(plan.plan, '1. 改前端');
    const w = a1.segments[3];
    assert.equal(w.id, 'w1');
    assert.equal(w.status, 'ready');
    assert.equal(w.code, code);
    const st = a1.segments[4];
    assert.match(st.text, /<cross-session-message from="uds:a"/);
    assert.match(st.text, /顺便看下 CI/);
    assert.equal(st.uuid, 'peer-steer-1');
    assert.ok(!a1.segments.some((s) => s.kind === 'tools'), 'AskUserQuestion / ExitPlanMode / visualize 都不露成工具行');
    // PR 信封：用户气泡原文保留（前端 prEnvelope → PrMsgCard），不被当注入丢掉
    assert.match(msgs[2].text, /^<ci-monitor-event>/);
    assert.match(msgs[4].text, /^<create-pr-command>/);
    // 跨会话开的轮：用户位置是显示信封（与直播 warmTake 推的 peerDisplay 同形）
    assert.match(msgs[6].text, /^<cross-session-message from="uds:b" from-name="Desktop"/);
    assert.match(msgs[6].text, /帮我看看日志/);
    assert.match(msgs[8].text, /^<session-message from="c1"/);
    assert.equal(msgs[9].segments[0].md, '收到汇报。');
  } finally {
    try { rmSync(file, { force: true }); } catch {}
  }
});
