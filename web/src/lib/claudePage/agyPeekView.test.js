// Claude 页 Antigravity 对话预览栏的纯函数：历史 → 轮次、流事件并入、压缩条目、在跑那一行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { turnsFromHistory, applyEvent, compactItems, liveStep } from './agyPeekView.js';

test('历史：用户一句、回复里的工具与正文按 blocks 顺序；连着的工具压成一行', () => {
  const turns = turnsFromHistory([
    { role: 'user', text: ' 帮我收一下脚注 ' },
    { role: 'assistant', status: 'done', blocks: [
      { type: 'thinking', text: '想一想' },
      { type: 'tool', tool: { toolCallId: 'a', title: '读了 MEMORY.md' } },
      { type: 'tool', tool: { toolCallId: 'b', name: 'view_file' } },
      { type: 'text', text: '改好了。' },
      { type: 'tool', tool: { toolCallId: 'c', title: '改了 AgyTurnFoot.svelte' } },
    ] },
  ]);
  const items = compactItems(turns);
  assert.deepEqual(items.map((x) => [x.kind, x.text || x.label, x.more ?? null]), [
    ['user', '帮我收一下脚注', null],
    ['steps', '读了 MEMORY.md', 1],
    ['text', '改好了。', null],
    ['steps', '改了 AgyTurnFoot.svelte', 0],
  ]);
  assert.equal(items[1].first, true);
  assert.equal(items[2].first, false);
});

test('旧形状（没有 blocks）：先工具后正文', () => {
  const items = compactItems(turnsFromHistory([{ role: 'assistant', text: '好', tools: [{ toolCallId: 'x', title: 'grep' }] }]));
  assert.deepEqual(items.map((x) => x.kind), ['steps', 'text']);
});

test('挂上在跑的一轮：attach 补用户那句；重放的事件接在后面；结束返回 true', () => {
  const turns = turnsFromHistory([{ role: 'user', text: '上一轮' }, { role: 'assistant', text: '上一轮的回复' }]);
  assert.equal(applyEvent(turns, { type: 'attach', userText: '把脚注再收一收' }), false);
  applyEvent(turns, { type: 'tool', tool: { toolCallId: 't1', title: '读 Claude 的记忆', status: 'in_progress' } });
  assert.deepEqual(liveStep(turns), { kind: 'tool', label: '读 Claude 的记忆' });
  applyEvent(turns, { type: 'tool-update', tool: { toolCallId: 't1', status: 'completed' } });
  assert.equal(liveStep(turns).kind, 'think');
  applyEvent(turns, { type: 'text', text: '改' });
  applyEvent(turns, { type: 'text', text: '好了' });
  assert.equal(liveStep(turns).kind, 'write');
  // 断线重挂：同一轮再 attach 一次，内容清空等重放，不重复用户那句
  applyEvent(turns, { type: 'attach', userText: '把脚注再收一收' });
  assert.equal(turns.filter((x) => x.role === 'user').length, 2);
  applyEvent(turns, { type: 'text', text: '改好了' });
  assert.equal(applyEvent(turns, { type: 'done' }), true);
  const items = compactItems(turns);
  assert.deepEqual(items.slice(-2).map((x) => x.text), ['把脚注再收一收', '改好了']);
  assert.equal(turns.at(-1).status, 'done');
});

test('自己发出的一句：带 mine；没有在跑的一轮时 liveStep 是 think', () => {
  const turns = [{ role: 'user', text: '截一张图给我', mine: true }];
  assert.equal(compactItems(turns)[0].mine, true);
  assert.equal(liveStep(turns).kind, 'think');
});
