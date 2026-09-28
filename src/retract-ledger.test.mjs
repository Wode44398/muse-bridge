// 安全栅门撤回记账 × 前端区间删除：按 CLI 2.1.25x 的真实帧序跑一遍，回退模型已流出的开头必须留下。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRetractLedger } from './runtime/retract-ledger.mjs';
import { retractSegments } from '../web/src/lib/retract.js';

// 服务端：把 claude.mjs 里对 ledger 的调用序列缩成几个动作，事件进 out[]
function server() {
  const L = makeRetractLedger();
  const out = [];
  const send = (o) => out.push(o);
  return {
    out, L,
    start: () => L.messageStart(),
    stop: () => L.messageStop(),
    text: (t) => { L.addText(t.length); send({ type: 'text', text: t }); },
    think: (t) => { L.addThink(t.length); send({ type: 'thinking', text: t }); },
    tool: (id) => { L.addTool(); send({ type: 'tool', id, name: 'Bash', index: 0 }); },
    // 帧到达：首帧可带 supersedes（先撤再记本帧）
    frame: (uuid, sup) => { if (sup && sup.length) { const ev = L.retract(sup); if (ev) send(ev); } L.frame(uuid); },
    notice: (retracted) => { const ev = L.retract(retracted); if (ev) send(ev); send({ type: 'model_notice' }); },
    taskStart: (id) => send({ type: 'task_start', toolUseId: id }),   // 前端会合成 synthetic 行
  };
}
// 前端：只复刻 text/thinking/tool/task_start/notice/retract 的段落效果
function replay(events) {
  const m = { segments: [], thinking: '' };
  const textSeg = () => { const l = m.segments[m.segments.length - 1]; if (l && l.kind === 'text') return l; const s = { kind: 'text', md: '' }; m.segments.push(s); return s; };
  const toolsSeg = () => { const l = m.segments[m.segments.length - 1]; if (l && l.kind === 'tools') return l; const s = { kind: 'tools', tools: [] }; m.segments.push(s); return s; };
  const forgotten = [];
  for (const ev of events) {
    if (ev.type === 'text') textSeg().md += ev.text;
    else if (ev.type === 'thinking') m.thinking += ev.text;
    else if (ev.type === 'tool') toolsSeg().tools.push({ id: ev.id, name: ev.name });
    else if (ev.type === 'task_start') toolsSeg().tools.push({ id: ev.toolUseId, name: 'Agent', synthetic: true });
    else if (ev.type === 'model_notice') m.segments.push({ kind: 'notice' });
    else if (ev.type === 'retract') retractSegments(m, ev, (t) => forgotten.push(t.id));
  }
  return { m, forgotten };
}
const texts = (m) => m.segments.filter((s) => s.kind === 'text').map((s) => s.md);
const tools = (m) => m.segments.filter((s) => s.kind === 'tools').flatMap((s) => s.tools.map((t) => t.id));
const retracts = (s) => s.out.filter((e) => e.type === 'retract');

test('A 通知先于重试（契约假设的顺序）', () => {
  const s = server();
  s.start(); s.think('T1'); s.frame('th1'); s.text('REFUSED-HALF'); s.frame('A1'); s.stop();
  s.notice(['th1', 'A1']);
  s.start(); s.think('T2'); s.frame('th2', ['th1', 'A1']); s.text('RETRY-FULL'); s.frame('B1'); s.stop();
  const { m } = replay(s.out);
  assert.deepEqual(texts(m), ['RETRY-FULL']);
  assert.equal(m.thinking, 'T2');
  assert.equal(retracts(s).length, 1);
});

test('B supersedes 晚于重试正文增量：回退模型的开头保留', () => {
  const s = server();
  s.start(); s.text('REFUSED-HALF'); s.frame('A1'); s.stop();
  s.start(); s.text('RETRY-'); s.frame('B1', ['A1']); s.text('FULL'); s.frame('B2'); s.stop();
  s.notice(['A1']);   // 幂等：同一份名单不再撤
  const { m } = replay(s.out);
  assert.deepEqual(texts(m), ['RETRY-FULL']);
  assert.equal(retracts(s).length, 1);
  assert.deepEqual(retracts(s)[0], { type: 'retract', textFrom: 0, textTo: 12, thinkFrom: 0, thinkTo: 0, toolsFrom: 0, toolsTo: 0 });
  // 记账前移：B1/B2 的区间落在 [0,6)/[6,10)
  const d = s.L._debug();
  assert.deepEqual(d.frames.map((f) => [f.uuid, f.text0, f.text1]), [['B1', 0, 6], ['B2', 6, 10]]);
});

test('C 重试首块是 tool_use：已发的 tool 行不被截掉', () => {
  const s = server();
  s.start(); s.text('REFUSED-HALF'); s.frame('A1'); s.stop();
  s.start(); s.tool('toolu_retry1'); s.frame('B1', ['A1']); s.stop();
  s.notice(['A1']);
  const { m, forgotten } = replay(s.out);
  assert.deepEqual(texts(m), []);
  assert.deepEqual(tools(m), ['toolu_retry1']);
  assert.deepEqual(forgotten, []);
});

test('D 子 agent 的 refusal（名单里都是陌生 uuid，主线程正在写）：不动主线程', () => {
  const s = server();
  s.start(); s.text('MAIN-TEXT-SO-FAR'); s.frame('M0');
  s.notice(['subagent-frame-uuid']);
  s.text('-MORE'); s.frame('M1'); s.stop();
  const { m } = replay(s.out);
  assert.equal(retracts(s).length, 0);
  assert.deepEqual(texts(m), ['MAIN-TEXT-SO-FAR', '-MORE']);   // notice 卡夹在中间
});

test('E 工具循环里被拒（真实样本 3a9522e1 的形态）：只撤被拒那条 API 消息，前面的 tool 行留着', () => {
  const s = server();
  s.start(); s.think('T1'); s.frame('th1'); s.tool('toolu_1'); s.frame('A1'); s.stop();     // 第一条消息：思考 + Bash
  s.start(); s.think('T2'); s.frame('th2'); s.text('half'); s.stop();                          // 第二条被拒在正文半途，没凑成帧
  s.start(); s.think('T3'); s.frame('B0', ['th2', 'tomb-tool-result']); s.tool('toolu_2'); s.frame('B1'); s.stop();
  s.notice(['th2', 'tomb-tool-result']);
  const { m } = replay(s.out);
  assert.equal(m.thinking, 'T1T3');
  assert.deepEqual(texts(m), []);
  assert.deepEqual(tools(m), ['toolu_1', 'toolu_2']);
  assert.equal(retracts(s).length, 1);
  assert.deepEqual(retracts(s)[0], { type: 'retract', textFrom: 0, textTo: 4, thinkFrom: 2, thinkTo: 4, toolsFrom: 1, toolsTo: 1 });
});

test('F 被拒在首块半途（零帧消息）、通知晚到：按「最近一条零帧消息」撤', () => {
  const s = server();
  s.start(); s.text('REFUSED'); s.stop();
  s.start(); s.text('RETRY-'); s.frame('B1', ['partial-uuid']); s.text('OK'); s.frame('B2'); s.stop();
  s.notice(['partial-uuid']);
  const { m } = replay(s.out);
  assert.deepEqual(texts(m), ['RETRY-OK']);
});

test('G 通知先到、被拒消息还没 message_stop：撤到当前计数，之后的增量另起消息', () => {
  const s = server();
  s.start(); s.text('REFUSED');
  s.notice(['partial-uuid']);
  s.stop();
  s.start(); s.text('RETRY'); s.frame('B1', ['partial-uuid']); s.stop();
  const { m } = replay(s.out);
  assert.deepEqual(texts(m), ['RETRY']);
  assert.equal(retracts(s).length, 1);
});

test('H server lane 缝合：通知带墓碑 uuid、正文连续 → 不撤', () => {
  const s = server();
  s.start(); s.think('T'); s.frame('fb'); s.text('retained+continued'); s.frame('B1'); s.tool('toolu_x'); s.frame('B2'); s.stop();
  s.notice(['tombstone-uuid']);
  const { m } = replay(s.out);
  assert.equal(retracts(s).length, 0);
  assert.deepEqual(texts(m), ['retained+continued']);
});

test('I synthetic 行不计入序号、不被删', () => {
  const s = server();
  s.start(); s.taskStart('toolu_bg'); s.text('half'); s.tool('toolu_a'); s.frame('A1'); s.stop();
  s.start(); s.tool('toolu_b'); s.frame('B1', ['A1']); s.stop();
  const { m, forgotten } = replay(s.out);
  assert.deepEqual(tools(m), ['toolu_bg', 'toolu_b']);
  assert.deepEqual(forgotten, ['toolu_a']);
  assert.deepEqual(texts(m), []);
});

test('J 旧协议保留长度：synthetic 行同样不计', () => {
  const m = { segments: [{ kind: 'tools', tools: [{ id: 'syn', synthetic: true }, { id: 'a' }, { id: 'b' }] }, { kind: 'text', md: 'abcdef' }], thinking: 'xyz' };
  retractSegments(m, { text: 3, thinking: 1, tools: 1 });
  assert.deepEqual(tools(m), ['syn', 'a']);
  assert.deepEqual(texts(m), ['abc']);
  assert.equal(m.thinking, 'x');
});
