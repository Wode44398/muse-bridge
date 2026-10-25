// 内嵌交互图表（mcp/visualize.mjs）：read_me 拼装、show_widget 结果、直播参数增量 → widget_* 帧、
// 历史重建落 widget 段、设置开关。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-viz-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const V = await import('./visualize.mjs');
const { guideFor } = await import('./visualize-guide.mjs');
const { toolShown } = await import('../runtime/tool-summary.mjs');
const { readSessionMessages } = await import('../routes/sessions.mjs');

test('read_me：基础段 + 所选模块（去重）+ 结尾；平台决定宽度；未知模块忽略', () => {
  const base = guideFor([], 'desktop');
  assert.match(base, /^# Inline visuals/);
  assert.match(base, /about 680px/);
  assert.match(base, /phone app NEVER runs widget scripts/);
  assert.doesNotMatch(base, /## Color palette/);
  const chart = guideFor(['chart', 'data_viz', 'nope'], 'desktop');
  assert.equal(chart.split('## Color palette').length - 1, 1, '色板只出现一次');
  assert.equal(chart.split('## Charts').length - 1, 1);
  assert.match(chart, /`c-teal`/);
  const mobile = guideFor(['diagram'], 'mobile');
  assert.match(mobile, /viewBox="0 0 380 H"/);
  assert.match(mobile, /about 380px/);
  // 模型没传 / 传 unknown → 用本轮发起端的平台
  assert.match(V.readMeResult({ modules: ['diagram'] }, 'mobile').content[0].text, /viewBox="0 0 380 H"/);
  assert.match(V.readMeResult({ modules: ['diagram'], platform: 'unknown' }, 'mobile').content[0].text, /viewBox="0 0 380 H"/);
  assert.match(V.readMeResult({ modules: ['diagram'], platform: 'desktop' }, 'mobile').content[0].text, /viewBox="0 0 680 H"/);
});

test('show_widget：固定结果；空代码 / 超限报错', () => {
  assert.equal(V.showWidgetResult({ widget_code: '<svg></svg>' }).isError, undefined);
  assert.match(V.showWidgetResult({ widget_code: '<svg></svg>' }).content[0].text, /^Rendered and shown/);
  assert.equal(V.showWidgetResult({ widget_code: '  ' }).isError, true);
  assert.equal(V.showWidgetResult({ widget_code: 'x'.repeat(V.MAX_WIDGET_CODE + 1) }).isError, true);
});

test('MCP server 能建出来，工具不露成工具行', () => {
  const s = V.makeVisualizeMcp({ platform: 'mobile' });
  assert.equal(s.type, 'sdk');
  assert.equal(s.name, 'visualize');
  assert.equal(toolShown('mcp__visualize__show_widget'), false);
  assert.equal(toolShown('mcp__visualize__read_me'), false);
  assert.equal(toolShown('Bash'), true);
});

test('decodeJsonString：转义、代理对、末尾残缺的转义先不解', () => {
  const s = JSON.stringify('a"b\\c\né中😀/');
  const full = V.decodeJsonString(s, 1);
  assert.equal(full.closed, true);
  assert.equal(full.text, 'a"b\\c\né中😀/');
  // 逐字切开喂：任何切点拼回来都要一致
  for (let cut = 1; cut < s.length; cut++) {
    const a = V.decodeJsonString(s.slice(0, cut), 1);
    const b = V.decodeJsonString(s, a.next);
    assert.equal(a.text + b.text, full.text, 'cut at ' + cut);
  }
});

test('peekWidgetMeta：只取写完的 title 与加载语', () => {
  assert.deepEqual(V.peekWidgetMeta('{"loading_messages":["Lining up", "Draw'), { title: '', loading: ['Lining up'] });
  assert.deepEqual(V.peekWidgetMeta('{"loading_messages":["A","B"],"title":"q3_rev'), { title: '', loading: ['A', 'B'] });
  assert.deepEqual(V.peekWidgetMeta('{"loading_messages":["A"],"title":"q3_rev","widget_code":"<svg'), { title: 'q3_rev', loading: ['A'] });
});

test('直播：参数增量切成 widget_delta（只发追加片段、from 连续），定稿后剔掉重放缓冲里的增量，tool_result 收尾', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const input = {
      loading_messages: ['画柱子', '对齐坐标轴'],
      title: 'q3_revenue_by_region',
      widget_code: '<svg viewBox="0 0 680 200" role="img"><title>营收 "Q3"</title>\n<rect class="c-teal" x="40" y="40" width="80" height="120"/>\\ 😀 <script>alert(1)</script></svg>',
    };
    const json = JSON.stringify(input);
    const gen = { events: [] };
    const send = (f) => gen.events.push(f);
    const w = V.makeWidgetStream(send, () => gen);
    assert.equal(w.start(3, 'Bash', 'x'), false);
    assert.equal(w.start(2, V.VIZ_SHOW, 'tu1'), true);
    let acc = '';
    for (let i = 0; i < json.length; i += 7) {
      acc = json.slice(0, i + 7);
      w.delta(2, acc);
      if (i % 21 === 0) mock.timers.tick(100);
    }
    mock.timers.tick(100);
    const deltas = gen.events.filter((e) => e.type === 'widget_delta');
    assert.ok(deltas.length >= 3);
    let code = '';
    for (const d of deltas) { assert.equal(d.from, code.length); code += d.add; }
    assert.equal(code, input.widget_code);
    const meta = deltas.filter((d) => d.title !== undefined).pop();
    assert.equal(meta.title, 'q3_revenue_by_region');
    assert.deepEqual(meta.loading, ['画柱子', '对齐坐标轴']);

    w.stop(2, JSON.parse(json));
    assert.equal(gen.events.some((e) => e.type === 'widget_delta'), false, '定稿后增量帧被剔掉');
    const fin = gen.events.find((e) => e.type === 'widget');
    assert.deepEqual(fin, { type: 'widget', id: 'tu1', title: input.title, loading: input.loading_messages, code: input.widget_code });
    assert.equal(gen.events[0].type, 'widget_start');

    assert.equal(w.result({ type: 'tool_result', tool_use_id: 'other' }), false);
    assert.equal(w.result({ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'boom' }], is_error: true }), true);
    assert.deepEqual(gen.events.at(-1), { type: 'widget_done', id: 'tu1', isError: true, error: 'boom' });
    assert.equal(w.result({ type: 'tool_result', tool_use_id: 'tu1' }), false, '同一 id 只收一次');
  } finally {
    mock.timers.reset();
  }
});

test('设置「对话内交互图表」关掉 → 不挂；手机轮才加平台提示', async () => {
  const dir = path.join(tmp, 'u1');
  fs.mkdirSync(dir, { recursive: true });
  const ctx = { kind: 'user', key: 'u:viz', dataDir: dir, sandbox: true };
  assert.equal(V.vizEnabled(ctx), true);
  const dir2 = path.join(tmp, 'u2');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'claude-settings.json'), JSON.stringify({ rev: 1, values: { inlineVisualizations: false } }));
  assert.equal(V.vizEnabled({ kind: 'user', key: 'u:viz2', dataDir: dir2, sandbox: true }), false);
  assert.equal(V.vizEnabled({ kind: 'admin', key: 'snap', snap: { token: 't' } }), true, '快照访客按默认值');
  assert.equal(V.vizNudge(true, false), '');
  assert.equal(V.vizNudge(false, true), '');
  assert.match(V.vizNudge(true, true), /platform:"mobile"/);
  // 新写法：{ phone, narrow }——窄屏网页也按 mobile 出图，但不说「不运行脚本」
  assert.match(V.vizNudge(true, { phone: true }), /静态预览/);
  assert.match(V.vizNudge(true, { narrow: true }), /窄屏.*platform:"mobile"/);
  assert.doesNotMatch(V.vizNudge(true, { narrow: true }), /静态预览/);
  assert.equal(V.vizNudge(true, {}), '');
  assert.equal(V.vizPlatform({ phone: true }), 'mobile');
  assert.equal(V.vizPlatform({ narrow: true }), 'mobile');
  assert.equal(V.vizPlatform({}), 'desktop');
});

test('vizOnFor：快照访客 / 悬浮胶囊 / 只认文本的代聊不挂，其余看设置', () => {
  const dir = path.join(tmp, 'u3');
  fs.mkdirSync(dir, { recursive: true });
  const ctx = { kind: 'user', key: 'u:viz3', dataDir: dir, sandbox: true };
  assert.equal(V.vizOnFor(ctx), true);
  assert.equal(V.vizOnFor(ctx, { source: 'capsule' }), false, '胶囊的原生流不渲染 widget 帧');
  assert.equal(V.vizOnFor(ctx, { plain: true }), false, '管理台代聊只渲染文本');
  assert.equal(V.vizOnFor({ kind: 'admin', key: 'snap', snap: { token: 't' } }), false, '快照访客：分享时不显示交互图表');
  assert.equal(V.vizOnFor(null), false);
  const dir2 = path.join(tmp, 'u4');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'claude-settings.json'), JSON.stringify({ rev: 1, values: { inlineVisualizations: false } }));
  assert.equal(V.vizOnFor({ kind: 'user', key: 'u:viz4', dataDir: dir2, sandbox: true }), false);
});

test('直播：上一条消息没收尾的 show_widget 不会被同 index 的别的工具续上、也不会被它的 stop 定稿', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const out = [];
    const w = V.makeWidgetStream((f) => out.push(f), () => null);
    // 第一条消息：index 0 上的 show_widget 流到一半断了（没有 content_block_stop）
    w.start(0, V.VIZ_SHOW, 'tuA');
    w.delta(0, '{"loading_messages":["a"],"title":"t","widget_code":"<svg><rect');
    mock.timers.tick(100);
    // ① 同一 index 上来了别的工具：旧记录作废，Bash 的参数增量 / stop 不进图表
    assert.equal(w.start(0, 'Bash', 'tuB'), false);
    w.delta(0, '{"command":"ls"}');
    mock.timers.tick(100);
    w.stop(0, { command: 'ls' });
    assert.equal(out.some((e) => e.type === 'widget'), false, '没有拼坏的定稿帧');
    assert.equal(out.filter((e) => e.type === 'widget_delta').map((e) => e.add).join(''), '<svg><rect');
    // ② message_start → reset：哪怕下一条消息的第一个块不是工具（文本块没有 start 调用），旧记录也清掉
    w.start(1, V.VIZ_SHOW, 'tuC');
    w.delta(1, '{"title":"x","widget_code":"<svg');
    w.reset();
    mock.timers.tick(200);
    w.stop(1, {});
    assert.equal(out.some((e) => e.type === 'widget'), false);
    assert.equal(out.filter((e) => e.type === 'widget_delta' && e.id === 'tuC').length, 0, 'reset 时节流里的增量也作废');
  } finally {
    mock.timers.reset();
  }
});

test('失败判据：CLI 合成的中断 / 跳过标记不算失败；工具自己报错、参数校验没过、代码为空才算', () => {
  const r = (text, isError = true) => ({ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) });
  const code = '<svg viewBox="0 0 680 10"></svg>';
  assert.equal(V.widgetResultError(r('[Request interrupted by user for tool use]'), code), '');
  assert.equal(V.widgetResultError(r('[Tool call skipped: the turn ended to deliver the message that follows before this call ran.]'), code), '');
  assert.equal(V.widgetResultError(r("[Tool call interrupted: the session ended before this call's result was recorded]"), code), '');
  assert.equal(V.widgetResultError(r('Rendered and shown to the user inline.', false), code), '');
  assert.match(V.widgetResultError(r('widget_code is too large (600000 characters, limit 524288)'), code), /too large/);
  assert.match(V.widgetResultError(r('MCP error -32602: Input validation error'), code), /validation/);
  assert.ok(V.widgetResultError(r('[Request interrupted by user for tool use]'), '  '), '代码为空：哪怕是中断也算没画出来');
  // 直播与历史同一判据
  const out = [];
  const w = V.makeWidgetStream((f) => out.push(f), () => null);
  w.start(0, V.VIZ_SHOW, 'tuS');
  w.stop(0, { title: 't', loading_messages: ['a'], widget_code: code });
  assert.equal(w.result({ ...r('[Request interrupted by user for tool use]'), tool_use_id: 'tuS' }), true);
  assert.deepEqual(out.at(-1), { type: 'widget_done', id: 'tuS', isError: false });
  const seg = V.widgetSegFromToolUse({ type: 'tool_use', id: 'h1', name: V.VIZ_SHOW, input: { title: 't', loading_messages: ['a'], widget_code: code } });
  V.applyWidgetResult(seg, r('[Request interrupted by user for tool use]'));
  assert.equal(seg.status, 'ready');
  V.applyWidgetResult(seg, r('boom'));
  assert.equal(seg.status, 'error');
});

const ts = (n) => new Date(Date.UTC(2026, 9, 20, 10, 0, n)).toISOString();
const user = (uuid, parentUuid, content) => ({ type: 'user', uuid, parentUuid, timestamp: ts(0), message: { role: 'user', content } });
const asst = (uuid, parentUuid, content) => ({ type: 'assistant', uuid, parentUuid, timestamp: ts(1), message: { role: 'assistant', content } });
const result = (id, text, isError = false) => [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) }];

test('历史重建：show_widget 原位落 widget 段（含完整代码），read_me 不落段，报错的标 error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-viz-hist-'));
  const file = path.join(dir, 's.jsonl');
  const code = '<svg viewBox="0 0 680 120" role="img"><title>t</title><rect x="1" y="1" width="9" height="9"/></svg>';
  const recs = [
    user('u1', null, '画个图'),
    asst('a1', 'u1', [{ type: 'tool_use', id: 'r1', name: V.VIZ_README, input: { modules: ['chart'] } }]),
    user('x1', 'a1', result('r1', '# Inline visuals …')),
    asst('a2', 'x1', [{ type: 'text', text: '先看总览：' }, { type: 'tool_use', id: 'w1', name: V.VIZ_SHOW, input: { loading_messages: ['画'], title: 'overview', widget_code: code } }]),
    user('x2', 'a2', result('w1', 'Rendered and shown to the user inline.')),
    asst('a3', 'x2', [{ type: 'tool_use', id: 'w2', name: V.VIZ_SHOW, input: { loading_messages: ['画'], title: 'broken', widget_code: ' ' } }]),
    user('x3', 'a3', result('w2', 'widget_code is empty', true)),
    asst('a4', 'x3', [{ type: 'text', text: '如上。' }]),
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  try {
    const msgs = await readSessionMessages(file);
    const a = msgs.filter((m) => m.role === 'assistant');
    assert.equal(a.length, 1);
    const kinds = a[0].segments.map((s) => s.kind);
    assert.deepEqual(kinds, ['text', 'widget', 'widget', 'text']);
    const [w1, w2] = a[0].segments.filter((s) => s.kind === 'widget');
    assert.deepEqual(w1, { kind: 'widget', id: 'w1', title: 'overview', loading: ['画'], code, status: 'ready', error: '' });
    assert.equal(w2.status, 'error');
    assert.equal(w2.error, 'widget_code is empty');
    assert.equal(a[0].segments.some((s) => s.kind === 'tools'), false, 'read_me 不露成工具行');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
