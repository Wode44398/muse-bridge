// 媒体进度卡的段（lib/agy/media.js）与事件流里的插话 / 后台子代理（logic.js applyAgyStreamEvent）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaToolInfo, mediaFilesInOutput, mediaJobOf, mediaSegOf, inlineMediaPaths, pathKey } from './media.js';
import { createEmptyAssistantTurn, applyAgyStreamEvent } from './logic.js';

const tool = (over = {}) => ({ toolCallId: 'c1', name: 'mcp_bridge_media_image', status: 'in_progress', startedAt: 1000, args: {}, output: '', ...over });

test('认媒体工具：bridge 的四样、取结果的 media_result、自带生图的子代理；别的工具不认', () => {
  assert.deepEqual(mediaToolInfo(tool()), { kind: 'image', native: false, result: false });
  assert.equal(mediaToolInfo(tool({ name: 'mcp_bridge_media_video' })).kind, 'video');
  assert.equal(mediaToolInfo(tool({ name: 'mcp_bridge_media_result' })).result, true);
  assert.deepEqual(mediaToolInfo({ name: 'invoke_subagent', args: { TypeName: 'image-generator' } }), { kind: 'image', native: true, result: false });
  assert.equal(mediaToolInfo({ name: 'invoke_subagent', args: { TypeName: 'research' } }), null);
  assert.equal(mediaToolInfo({ name: 'run_command', kind: 'execute', title: 'echo mcp_bridge_media_image' }), null, '命令标题里带这串字不算');
});

test('从工具返回里取成品：只认绝对路径的 Markdown 链接，百分号编码与 file:// 还原，重复的只留一个', () => {
  const out = '图片已生成并保存到当前会话工作目录：C:\\proj\\a b.png\n请在回复正文中原样附上此 Markdown 链接交付给用户：[a b.png](C:\\proj\\a%20b.png)\n作品 id：abc';
  assert.deepEqual(mediaFilesInOutput(out), [{ path: 'C:\\proj\\a b.png', name: 'a b.png', kind: 'image' }]);
  assert.deepEqual(mediaFilesInOutput('[v](file:///C:/p/v.mp4) [v](C:/p/v.mp4) [doc](C:/p/x.md) [web](https://x/y.png) [rel](y.png)').map((f) => f.kind), ['video']);
  assert.equal(mediaFilesInOutput('[s.mp3](/home/u/s.mp3)')[0].kind, 'audio');
  assert.equal(mediaJobOf('视频还在生成（已 150 秒）。任务 id：job_12345678\n过一会儿调用 media_result'), 'job_12345678');
  assert.equal(mediaJobOf('图片已生成'), '');
});

test('进度卡：在跑时读秒，跑完换成成品；失败、被拒、被停下的不出卡', () => {
  assert.equal(mediaSegOf(tool(), { live: true }).status, 'generating');
  assert.equal(mediaSegOf(tool(), { live: false }), null, '这一轮已经收尾就不再读秒');
  const done = mediaSegOf(tool({ status: 'completed', output: '[a.png](C:/p/a.png)' }), { live: false });
  assert.equal(done.status, 'ready');
  assert.equal(done.files[0].path, 'C:/p/a.png');
  assert.equal(done.id, 'media-c1');
  assert.equal(mediaSegOf(tool({ status: 'failed', output: 'media_image 调用失败' }), { live: true }), null);
  assert.equal(mediaSegOf(tool({ approvalState: 'denied' }), { live: true }), null);
  assert.equal(mediaSegOf(tool({ status: 'cancelled' }), { live: true }), null);
  assert.equal(mediaSegOf({ name: 'run_command', status: 'in_progress' }, { live: true }), null);
});

test('分段等待：发起的那张接着读秒，media_result 取到成品时由它出成品、发起的那张让位', () => {
  const start = tool({ name: 'mcp_bridge_media_video', status: 'completed', output: '视频还在生成（已 150 秒）。任务 id：job_abcdef12' });
  assert.equal(mediaSegOf(start, { tools: [start], live: true }).status, 'generating');
  assert.equal(mediaSegOf(start, { tools: [start], live: true }).mediaKind, 'video');

  const polling = tool({ toolCallId: 'c2', name: 'mcp_bridge_media_result', args: { job: 'job_abcdef12' } });
  assert.equal(mediaSegOf(polling, { tools: [start, polling], live: true }), null, '取结果的调用自己不出占位卡');
  assert.equal(mediaSegOf(start, { tools: [start, polling], live: true }).status, 'generating');

  const still = { ...polling, status: 'completed', output: '视频还在生成（已 300 秒）。任务 id：job_abcdef12' };
  assert.equal(mediaSegOf(start, { tools: [start, still], live: true }).status, 'generating', '还没好就接着读秒');

  const got = { ...polling, status: 'completed', output: '视频已生成并保存：\n  Markdown 链接：[v.mp4](C:/p/v.mp4)' };
  assert.equal(mediaSegOf(start, { tools: [start, got], live: true }), null);
  const seg = mediaSegOf(got, { tools: [start, got], live: true });
  assert.equal(seg.status, 'ready');
  assert.equal(seg.mediaKind, 'video');

  const bad = { ...polling, status: 'failed', output: '生成失败' };
  assert.equal(mediaSegOf(start, { tools: [start, bad], live: true }), null, '取结果失败了也收掉占位卡');
});

test('自带生图：工具调用秒完成也接着读秒，直到 background 事件带来成品；这一轮收尾还没回报就收掉', () => {
  const turn = createEmptyAssistantTurn();
  applyAgyStreamEvent(turn, { type: 'tool', tool: { toolCallId: 's1', name: 'invoke_subagent', status: 'in_progress', args: { TypeName: 'image-generator' } } });
  applyAgyStreamEvent(turn, { type: 'tool-update', tool: { toolCallId: 's1', status: 'completed' } });
  const t1 = turn.toolsById.s1;
  assert.equal(mediaSegOf(t1, { live: true }).status, 'generating');

  applyAgyStreamEvent(turn, { type: 'background', state: 'waiting', agents: [{ id: 'sub', kind: 'image', typeName: 'image-generator' }], at: 5 });
  assert.equal(turn.background.agents[0].kind, 'image');
  applyAgyStreamEvent(turn, { type: 'background', state: 'reported', from: { id: 'sub', kind: 'image' }, files: [{ path: 'C:/brain/x.jpg', name: 'x.jpg', kind: 'image' }] });
  const seg = mediaSegOf(t1, { live: true });
  assert.equal(seg.status, 'ready');
  assert.equal(seg.files[0].name, 'x.jpg');
  applyAgyStreamEvent(turn, { type: 'background', state: 'resumed' });
  assert.equal(turn.background, null);

  // 底部交付物按路径去重（盘符大小写、斜杠方向不同也算同一个）
  const shown = inlineMediaPaths([seg, null, { kind: 'text' }]);
  assert.ok(shown.has(pathKey('c:\\brain\\x.jpg')));

  // 没等到回报就收尾：不留一张永远读秒的卡
  const turn2 = createEmptyAssistantTurn();
  applyAgyStreamEvent(turn2, { type: 'tool', tool: { toolCallId: 's2', name: 'invoke_subagent', status: 'completed', args: { TypeName: 'image-generator' } } });
  applyAgyStreamEvent(turn2, { type: 'background', state: 'waiting', agents: [{ id: 'sub2', kind: 'image' }] });
  applyAgyStreamEvent(turn2, { type: 'interrupted' });
  assert.equal(turn2.background, null);
  assert.equal(mediaSegOf(turn2.toolsById.s2, { live: false }), null);
});

test('中途插话：摆成回答中间的一块，重放同一条不重复；前后的正文各成一段', () => {
  const turn = createEmptyAssistantTurn();
  applyAgyStreamEvent(turn, { type: 'text', text: '先说一半' });
  applyAgyStreamEvent(turn, { type: 'steer', id: 'st-1', text: '补充一句', atts: [{ path: 'C:/p/a.png', name: 'a.png' }] });
  applyAgyStreamEvent(turn, { type: 'steer', id: 'st-1', text: '补充一句' });
  applyAgyStreamEvent(turn, { type: 'text', text: '接着说' });
  assert.deepEqual(turn.blocks.map((b) => b.type), ['text', 'steer', 'text']);
  assert.equal(turn.blocks[1].text, '补充一句');
  assert.equal(turn.blocks[1].atts[0].name, 'a.png');
  assert.equal(turn.md, '先说一半接着说');

  // 断线重连：attach 清空后整段重放，插话照样回到原位
  applyAgyStreamEvent(turn, { type: 'attach' });
  assert.equal(turn.blocks.length, 0);
  applyAgyStreamEvent(turn, { type: 'text', text: '先说一半' });
  applyAgyStreamEvent(turn, { type: 'steer', id: 'st-1', text: '补充一句' });
  assert.deepEqual(turn.blocks.map((b) => b.type), ['text', 'steer']);
});
