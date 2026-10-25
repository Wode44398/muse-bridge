// 「Claude 发起新会话」的前端纯函数：工具行入段规则（直播 toolVerbs.toolJoins 与历史重建 tool-summary.toolJoins 必须同构）、
// start_session 按 initiation / 卡片结局选词。
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolJoins, toolVerb, START_SESSION_TOOL } from './toolVerbs.js';
import { toolJoins as serverJoins, STANDALONE_TOOLS as SERVER_STANDALONE } from '../../../src/runtime/tool-summary.mjs';
import { STANDALONE_TOOLS } from './toolVerbs.js';

test('入段：连续几次 start_session 并成一段，前后的普通工具各自另起；两端同构', () => {
  const names = ['', 'Bash', 'Read', 'Workflow', START_SESSION_TOOL, 'Artifact', 'mcp__sessions__send_message'];
  for (const a of names) for (const b of names.slice(1)) assert.equal(toolJoins(a, b), serverJoins(a, b), `${a} → ${b}`);
  assert.equal(toolJoins(START_SESSION_TOOL, START_SESSION_TOOL), true);
  assert.equal(toolJoins('Bash', START_SESSION_TOOL), false);
  assert.equal(toolJoins(START_SESSION_TOOL, 'Bash'), false);
  assert.equal(toolJoins('Bash', 'Read'), true);
  assert.deepEqual([...STANDALONE_TOOLS].sort(), [...SERVER_STANDALONE].sort());
});

test('start_session 工具行：按 initiation 选词，offer 的结局写进动词', () => {
  const t = (input, extra = {}) => ({ name: START_SESSION_TOOL, input, status: 'done', ...extra });
  assert.equal(toolVerb(t({ initiation: 'user_asked', title: 'A' })).verb, 'Started session');
  assert.equal(toolVerb(t({ initiation: 'offer', title: 'A' })).verb, 'Offered a new session');
  assert.equal(toolVerb(t({ initiation: 'offer', title: 'A' })).runningVerb, 'Offering a new session');
  assert.equal(toolVerb(t({ initiation: 'own_initiative', title: 'A' })).verb, 'Suggested task');
  assert.equal(toolVerb(t({ proposal_id: 'task_0123abcd', initiation: 'offer' })).verb, 'Started session');
  assert.equal(toolVerb(t({ initiation: 'offer', title: 'A' }, { outcome: 'kept_here' })).verb, 'Kept in this session');
  assert.equal(toolVerb(t({ initiation: 'offer', title: 'A' }, { outcome: 'unanswered' })).verb, 'Not answered');
  assert.equal(toolVerb(t({ initiation: 'offer', title: 'A' }, { outcome: 'dismissed' })).verb, 'Stopped before it started');
  assert.equal(toolVerb({ name: 'mcp__sessions__dismiss_task', input: { task_id: 'task_0123abcd' } }).verb, 'Withdrew suggestion');
});
