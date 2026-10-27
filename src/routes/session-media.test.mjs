// 重开会话 / 对账后聊天里的生成图「丢失」（2026-10-20 维护者报：图片在聊天中经常丢失）。
//
// 病根之一：transcript 重建刻意不还原 media 段（mcp__media__generate_* 被当成不显示的工具），
// 直播落的图只活在前端内存里——重开对话、或对账时这条消息任何一处与服务端版对不上被整条替换，
// 图就整张没了。子 agent 出的图更是只记在 subagents/agent-<id>.jsonl 里。
// 现在：主对话的媒体工具按 tool_result 里的文件名（= 媒体 id）还原成与直播同形的 media 段；
// 失败还原成错误卡；子 agent 的按 agentId 读子转录展开。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionMessages } from './sessions.mjs';

const ID1 = '0552ae00-f930-44ab-9486-3a739d3c71bb';
const ID2 = 'a50f909e-821d-4525-8b61-c01ca8910069';
const ts = (n) => new Date(Date.UTC(2026, 9, 20, 10, 0, n)).toISOString();
const user = (uuid, parentUuid, content, extra = {}) => ({ type: 'user', uuid, parentUuid, timestamp: ts(0), message: { role: 'user', content }, ...extra });
const asst = (uuid, parentUuid, content) => ({ type: 'assistant', uuid, parentUuid, timestamp: ts(1), message: { role: 'assistant', content } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, text, isError = false) => [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) }];

function withSession(main, sub, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-media-'));
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, main.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  for (const [agentId, recs] of Object.entries(sub)) {
    const subDir = path.join(dir, 'sess', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-' + agentId + '.jsonl'), recs.map((r) => JSON.stringify({ ...r, isSidechain: true })).join('\n') + '\n', 'utf8');
  }
  return fn(file).finally(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
}
const mediaSegs = (msgs) => msgs.flatMap((m) => m.segments || []).filter((s) => s.kind === 'media');

test('主对话生成的图与失败卡还原成 media 段，子 agent 的图从子转录展开', () => withSession([
  user('u1', null, '给课件配图'),
  asst('a1', 'u1', [{ type: 'text', text: '先出一张。' }, toolUse('m1', 'mcp__media__generate_image', { prompt: 'charcoal bench' })]),
  user('r1', 'a1', result('m1', '已生成图片并展示给用户（gemini-3.1-flash-image · 2K · 16:9）。绝对文件路径：C:\\Users\\x\\claude-bridge\\media\\' + ID1 + '.png')),
  asst('a2', 'r1', [toolUse('m2', 'mcp__media__generate_image', { prompt: 'beaker' })]),
  user('r2', 'a2', result('m2', '图像生成失败：{"error":{"code":429}}', true)),
  asst('a3', 'r2', [toolUse('ag1', 'Agent', { description: '配图', prompt: 'make textures', subagent_type: 'general-purpose' })]),
  user('r3', 'a3', result('ag1', 'done'), { toolUseResult: { agentId: 'abc123', status: 'completed' } }),
  asst('a4', 'r3', [{ type: 'text', text: '都好了。' }]),
], {
  abc123: [
    asst('s1', null, [toolUse('sm1', 'mcp__media__generate_image', { prompt: 'brushed steel' })]),
    user('s2', 's1', result('sm1', '已生成图片并展示给用户。绝对文件路径：C:\\m\\' + ID2 + '.png')),
  ],
}, async (file) => {
  const msgs = await readSessionMessages(file);
  const segs = mediaSegs(msgs);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => [s.mediaKind, s.status, s.id, s.prompt]), [
    ['image', 'ready', ID1, 'charcoal bench'],
    ['image', 'error', '', 'beaker'],
    ['image', 'ready', ID2, 'brushed steel'],
  ]);
  assert.equal(segs[1].error, '{"error":{"code":429}}');
  // 媒体工具不该再冒成工具行
  const toolNames = msgs.flatMap((m) => m.segments || []).filter((s) => s.kind === 'tools').flatMap((s) => s.tools.map((t) => t.name));
  assert.ok(!toolNames.some((n) => n.startsWith('mcp__media__')));
}));

test('子 agent 没出媒体：不插任何段（正文分段与直播一致）', () => withSession([
  user('u1', null, 'hi'),
  asst('a1', 'u1', [{ type: 'text', text: '派个子 agent。' }, toolUse('ag1', 'Agent', { description: 'x', prompt: 'y' })]),
  user('r1', 'a1', result('ag1', 'done'), { toolUseResult: { agentId: 'zzz', status: 'completed' } }),
  asst('a2', 'r1', [{ type: 'text', text: '好了。' }]),
], { zzz: [asst('s1', null, [{ type: 'text', text: 'nothing' }])] }, async (file) => {
  const msgs = await readSessionMessages(file);
  assert.equal(mediaSegs(msgs).length, 0);
  const kinds = msgs.filter((m) => m.role === 'assistant').flatMap((m) => m.segments.map((s) => s.kind));
  assert.deepEqual(kinds, ['text', 'tools', 'text']);
}));
