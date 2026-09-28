// 上下文压缩后重开会话的历史重建（回归：压缩之后聊天记录只看得见压缩摘要和之后的内容）。
//
// 病根：compact_boundary 记录的 parentUuid 是 null，压缩前的对话挂在它的 logicalParentUuid 上；
// 主链过滤只认 parentUuid，链在边界处就「到根」了，压缩前的全部轮被当成回滚孤儿滤掉，
// 而 CLI 注入的压缩摘要（isCompactSummary）又漏成了一条用户气泡。
// 现在：链顺着 logicalParentUuid 接回去；边界落成 tools 段里一条压缩条目（id=边界 uuid），
// 摘要收进它的 compact.summary；手动 /compact 与直播同形（「/compact」气泡 + 新一轮挂压缩行）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionMessages } from './sessions.mjs';
import { COMPACT_TOOL } from '../runtime/tool-summary.mjs';

function withTranscript(records, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-compact-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return fn(file).finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
}
const ts = (n) => new Date(Date.UTC(2026, 8, 23, 10, 0, n)).toISOString();
const user = (uuid, parentUuid, content, extra = {}) => ({ type: 'user', uuid, parentUuid, timestamp: ts(0), message: { role: 'user', content }, ...extra });
const asst = (uuid, parentUuid, content) => ({ type: 'assistant', uuid, parentUuid, timestamp: ts(1), message: { role: 'assistant', content } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id) => [{ type: 'tool_result', tool_use_id: id, content: 'ok' }];
const boundary = (uuid, logicalParentUuid, trigger, preTokens, postTokens) => ({
  type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid, timestamp: ts(2),
  content: 'Conversation compacted', compactMetadata: { trigger, preTokens, postTokens, durationMs: 90000 },
});
const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. **Primary Request**: fix the bug';
const compactEntries = (msgs) => msgs.flatMap((m) => (m.segments || []).flatMap((s) => (s.kind === 'tools' ? s.tools : []))).filter((t) => t.name === COMPACT_TOOL);

test('轮中自动压缩：压缩前的轮都在、摘要不成气泡、压缩行并进同一个工具循环组', () => withTranscript([
  user('u1', null, '帮我修个 bug'),
  asst('a1', 'u1', [toolUse('tu1', 'Bash', { command: 'ls', description: 'List files' })]),
  asst('x1', 'u1', [{ type: 'text', text: 'ORPHAN-被回滚掉的分支' }]),   // 回滚孤儿：必须仍被滤掉
  user('r1', 'a1', toolResult('tu1')),
  asst('a2', 'r1', [toolUse('tu2', 'Read', { file_path: 'C:/x/a.js' })]),
  user('r2', 'a2', toolResult('tu2')),
  boundary('B', 'r2', 'auto', 970452, 15624),
  user('S', 'B', SUMMARY, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  asst('a3', 'S', [toolUse('tu3', 'Edit', { file_path: 'C:/x/a.js' })]),
  user('r3', 'a3', toolResult('tu3')),
  asst('a4', 'r3', [{ type: 'text', text: '修好了' }]),
], async (file) => {
  const msgs = await readSessionMessages(file);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant'], '一问一答：压缩不该切出新的轮');
  assert.equal(msgs[0].text, '帮我修个 bug', '压缩前的第一条用户消息必须还在（原 bug：整段被当孤儿滤掉）');
  assert.ok(!msgs.some((m) => m.role === 'user' && /continued from a previous conversation/.test(m.text)), '压缩摘要不能渲染成用户气泡');
  assert.ok(!JSON.stringify(msgs).includes('ORPHAN'), '回滚孤儿照样过滤');
  const segs = msgs[1].segments;
  assert.deepEqual(segs.map((s) => s.kind), ['tools', 'text']);
  assert.deepEqual(segs[0].tools.map((t) => t.name), ['Bash', 'Read', COMPACT_TOOL, 'Edit'], '压缩行夹在循环里（官方 rolls-up）');
  const c = segs[0].tools[2];
  assert.equal(c.id, 'B', 'id = 边界 uuid（直播 compact_boundary 帧同一个，前端指纹靠它对上）');
  assert.equal(c.status, 'done');
  assert.deepEqual({ ...c.compact, summary: undefined }, { trigger: 'auto', preTokens: 970452, postTokens: 15624, summary: undefined });
  assert.equal(c.compact.summary, SUMMARY, '摘要收进压缩行的展开详情');
}));

test('多次压缩：逻辑链一路接回会话开头，每次各一条压缩行', () => withTranscript([
  user('u1', null, '第一问'),
  asst('a1', 'u1', [{ type: 'text', text: '答一' }]),
  boundary('B1', 'a1', 'auto', 900000, 20000),
  user('S1', 'B1', SUMMARY, { isCompactSummary: true }),
  user('u2', 'S1', '第二问'),
  asst('a2', 'u2', [{ type: 'text', text: '答二' }]),
  boundary('B2', 'a2', 'auto', 910000, 21000),
  user('S2', 'B2', SUMMARY, { isCompactSummary: true }),
  user('u3', 'S2', '第三问'),
  asst('a3', 'u3', [{ type: 'text', text: '答三' }]),
], async (file) => {
  const msgs = await readSessionMessages(file);
  assert.deepEqual(msgs.filter((m) => m.role === 'user').map((m) => m.text), ['第一问', '第二问', '第三问']);
  assert.deepEqual(compactEntries(msgs).map((t) => t.id), ['B1', 'B2']);
}));

test('手动 /compact：「/compact」气泡 + 新一轮只有压缩行（与直播同形），之后的轮照常', () => withTranscript([
  user('u1', null, 'hi'),
  asst('a1', 'u1', [{ type: 'text', text: 'hello' }]),
  boundary('B', 'a1', 'manual', 29803, 1875),
  user('S', 'B', SUMMARY, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  user('M', 'S', '<local-command-caveat>Caveat: …</local-command-caveat>', { isMeta: true }),
  user('C', 'M', '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>keep it short</command-args>'),
  user('O', 'C', '<local-command-stdout>Compacted </local-command-stdout>'),
  user('u2', 'O', 'next?'),
  asst('a2', 'u2', [{ type: 'text', text: 'yes' }]),
], async (file) => {
  const msgs = await readSessionMessages(file);
  assert.deepEqual(msgs.map((m) => (m.role === 'user' ? 'U:' + m.text : 'A:' + m.segments.map((s) => s.kind).join('+'))),
    ['U:hi', 'A:text', 'U:/compact keep it short', 'A:tools', 'U:next?', 'A:text']);
  const [c] = compactEntries(msgs);
  assert.equal(c.compact.trigger, 'manual');
  assert.equal(c.compact.summary, SUMMARY);
  assert.equal(msgs[1].segments.length, 1, '压缩行不能挂回上一轮');
}));
