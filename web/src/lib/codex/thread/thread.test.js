import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, splitPath, bar5 } from './diff.js';
import { fmtDur, fmtSecs, clock, fmtUntil, summaryLine, exploreText, approvalTag, outLines, toolView, nsKey, mediaFromText, mediaKindOf, isWidgetRow, agentVerb, reviewOf, pickAccount, firstLine } from './words.js';
import { track, hitsIn } from './streamFade.js';

test('unified diff 拆成带行号的行，段与段之间一个分隔', () => {
  const d = [
    'diff --git a/src/math.js b/src/math.js',
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -12,3 +12,6 @@ export',
    ' export function divide(a, b) {',
    '-  return a / b',
    '+  if (b === 0) {',
    '+    throw new RangeError()',
    '+  }',
    '+  return a / b',
    ' }',
    '@@ -40,1 +43,1 @@',
    '-x',
    '+y',
    '\\ No newline at end of file',
  ].join('\n');
  const { lines, more } = diffLines(d);
  assert.equal(more, 0);
  assert.deepEqual(lines.slice(0, 3), [
    { n: 12, s: ' ', t: 'export function divide(a, b) {' },
    { n: 13, s: '-', t: '  return a / b' },
    { n: 13, s: '+', t: '  if (b === 0) {' },
  ]);
  assert.deepEqual(lines[6], { n: 17, s: ' ', t: '}' });
  assert.deepEqual(lines[7], { n: null, s: '@', t: '' });
  assert.deepEqual(lines.slice(8), [{ n: 40, s: '-', t: 'x' }, { n: 43, s: '+', t: 'y' }]);
});

test('新建 / 删除文件给的是整份内容：全是加或全是减；超出上限只计数', () => {
  assert.deepEqual(diffLines('a\nb\n', 'add').lines, [{ n: 1, s: '+', t: 'a' }, { n: 2, s: '+', t: 'b' }]);
  assert.deepEqual(diffLines('a', 'delete').lines, [{ n: 1, s: '-', t: 'a' }]);
  const big = diffLines(Array.from({ length: 10 }, (_, i) => 'l' + i).join('\n'), 'add', 4);
  assert.equal(big.lines.length, 4);
  assert.equal(big.more, 6);
  assert.deepEqual(diffLines('').lines, []);
});

test('路径拆目录与文件名、增删五格', () => {
  assert.deepEqual(splitPath('C:\\work\\proj\\src\\math.js'), { dir: 'proj/src/', name: 'math.js' });
  assert.deepEqual(splitPath('math.js'), { dir: '', name: 'math.js' });
  assert.deepEqual(bar5(4, 1), ['a', 'a', 'a', 'a', 'd']);
  assert.deepEqual(bar5(10, 2), ['a', 'a', 'a', 'a', 'd']);
  assert.deepEqual(bar5(3, 5), ['a', 'a', 'd', 'd', 'd']);
  assert.deepEqual(bar5(7, 0), ['a', 'a', 'a', 'a', 'a']);
  assert.deepEqual(bar5(0, 0), ['', '', '', '', '']);
});

test('时长与计时', () => {
  assert.equal(fmtDur(72_000), '1 分 12 秒');
  assert.equal(fmtDur(300), '1 秒');
  assert.equal(fmtSecs(800), '0.8s');
  assert.equal(fmtSecs(125_000), '2m 5s');
  assert.equal(fmtSecs(null), '');
  assert.equal(clock(12_500), '0:12');
  assert.equal(clock(3_723_000), '1:02:03');
  const now = new Date(2026, 10, 25, 14, 0).getTime();
  assert.equal(fmtUntil(new Date(2026, 10, 25, 16, 20).getTime(), now), '16:20');
  assert.equal(fmtUntil(Math.floor(new Date(2026, 10, 25, 16, 20).getTime() / 1000), now), '16:20');
  assert.equal(fmtUntil(new Date(2026, 10, 26, 9, 5).toISOString(), now), '11/26 09:05');
  assert.equal(fmtUntil(null, now), '');
});

test('收起后那一行', () => {
  const sum = { commands: 4, explored: 3, files: [{ a: 20, d: 2 }, { a: 4, d: 4 }, { a: 0, d: 0 }], a: 24, d: 6, ms: 72_000 };
  assert.deepEqual(summaryLine('done', sum), { text: '工作了 1 分 12 秒 · 4 条命令 · 改了 3 个文件', a: 24, d: 6 });
  assert.equal(summaryLine('stopped', { ...sum, files: [], commands: 0, explored: 0 }).text, '已停止 · 用时 1 分 12 秒');
  assert.equal(summaryLine('done', { commands: 0, explored: 2, files: [], a: 0, d: 0, ms: null }).text, '查看了 2 个文件');
  assert.equal(summaryLine('done', { commands: 0, explored: 0, files: [], a: 0, d: 0, ms: null }).text, '工作记录');
  assert.equal(summaryLine('error', { commands: 1, explored: 0, files: [], a: 0, d: 0, ms: 2000 }).text, '出错了 · 用时 2 秒 · 1 条命令');
});

test('同类合并的「查看了」：同一文件只算一次', () => {
  const items = [
    { type: 'read', name: 'a.js', path: 'src/a.js' },
    { type: 'read', name: 'a.js', path: 'src/a.js' },
    { type: 'read', name: 'b.js', path: 'src/b.js' },
    { type: 'search', query: 'divide(', path: 'src' },
  ];
  assert.equal(exploreText(items), '2 个文件，1 次搜索');
  assert.equal(exploreText([{ type: 'list', path: 'src' }]), '1 个目录');
});

test('审批后缀、命令输出只留尾巴', () => {
  assert.equal(approvalTag('once'), '你允许了一次');
  assert.equal(approvalTag('always'), '这个对话里都允许了');
  assert.equal(approvalTag(undefined), '');
  const o = outLines('a\nb\nc\nd\n', 2);
  assert.deepEqual(o, { lines: ['c', 'd'], cut: 2 });
  assert.deepEqual(outLines(''), { lines: [], cut: 0 });
});

test('bridge 工具写成人话', () => {
  assert.equal(nsKey('bridge_browser'), 'browser');
  assert.equal(nsKey('bridge'), 'bridge');
  const b = toolView({ kind: 'tool', ns: 'bridge_browser', tool: 'browser', args: { action: 'navigate', url: 'http://localhost:5173/calc' }, status: 'ok', images: 1 });
  assert.equal(b.verb, '用了浏览器');
  assert.equal(b.pre, '打开了');
  assert.equal(b.obj, 'localhost:5173/calc');
  assert.equal(b.post, '截了 1 张图');
  assert.deepEqual(b.link, { label: '在工作区看', view: 'browser' });
  const term = toolView({ kind: 'tool', ns: 'bridge_terminal', tool: 'terminal', args: { command: 'npm test' }, status: 'ok' });
  assert.equal(term.verb, '用了终端');
  assert.equal(term.obj, 'npm test');
  assert.equal(term.link.view, 'term');
  const legacy = toolView({ kind: 'mcp', server: 'bridge_browser', tool: 'screenshot', status: 'ok' });
  assert.equal(legacy.pre, '截了一张图');
  const other = toolView({ kind: 'mcp', server: 'github', tool: 'create_issue', status: 'ok' });
  assert.equal(other.verb, '调用了');
  assert.equal(other.obj, 'github.create_issue');
  const chart = { kind: 'tool', ns: 'bridge_visualize', tool: 'show_widget', args: { title: '覆盖率', widget_code: '<svg/>' }, status: 'ok' };
  assert.equal(toolView(chart).verb, '画了一张图表');
  assert.equal(isWidgetRow(chart), true);
  assert.equal(isWidgetRow({ ...chart, args: { title: 'x' } }), false);
});

test('生成的媒体从回执里认出作品 id', () => {
  const row = {
    kind: 'tool', ns: 'bridge_media', tool: 'generate_image', status: 'ok', args: { prompt: '一只猫' },
    text: '已生成 · 实际 2048×2048\nC:\\Users\\x\\media\\3f2a1b4c-1111-4222-8333-944445555666.png\n同一次另外生成的 1 件：\nC:\\Users\\x\\media\\aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.JPG\n3f2a1b4c-1111-4222-8333-944445555666.png',
  };
  assert.equal(mediaKindOf(row), 'image');
  const segs = mediaFromText('image', row.text, '一只猫');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].id, '3f2a1b4c-1111-4222-8333-944445555666');
  assert.equal(segs[1].ext, 'jpg');
  assert.equal(segs[0].prompt, '一只猫');
  assert.equal(toolView(row).verb, '生成了 2 张图');
  assert.equal(toolView({ ...row, status: 'run', text: '' }).verb, '正在生成图片');
});

test('子智能体、自动审查、换号、原文第一行', () => {
  assert.equal(agentVerb('spawnAgent'), '派出子智能体');
  assert.equal(agentVerb('wait'), '等子智能体回报');
  assert.deepEqual(reviewOf({ review: { status: 'approved', rationale: '只装开发依赖' } }), { verdict: 'allow', reason: '只装开发依赖' });
  assert.deepEqual(reviewOf({ decision: 'denied', reason: '要删项目外的文件' }), { verdict: 'deny', reason: '要删项目外的文件' });
  assert.deepEqual(reviewOf(null), { verdict: '', reason: '' });
  const now = Date.now();
  const pool = { accounts: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B', disabled: true },
    { id: 'c', label: 'C', cooling: { until: now + 60_000 } },
    { id: 'd', label: 'D', loggedIn: false },
    { id: 'e', label: 'E', cooling: { until: now - 1000 } },
  ] };
  assert.equal(pickAccount(pool, 'a', now).id, 'e');
  assert.equal(pickAccount({ accounts: [{ id: 'a' }] }, 'a', now), null);
  assert.equal(pickAccount(null, 'a'), null);
  assert.equal(firstLine('error[E0063]: missing\n  --> v2.rs'), 'error[E0063]: missing');
});

test('新字渐显：只记新长出来的那一截，过时的丢掉，变短时收回', () => {
  const st = { len: 0, chunks: [] };
  track(st, 5, 0);
  track(st, 9, 100);
  assert.deepEqual(st.chunks, [{ start: 0, end: 5, born: 0 }, { start: 5, end: 9, born: 100 }]);
  track(st, 9, 300);
  assert.deepEqual(st.chunks, [{ start: 5, end: 9, born: 100 }]);
  track(st, 7, 320);
  assert.deepEqual(st.chunks, [{ start: 5, end: 7, born: 100 }]);
  track(st, 7, 400);
  assert.deepEqual(st.chunks, []);
  assert.deepEqual(hitsIn([{ start: 5, end: 9, born: 100 }, { start: 2, end: 4, born: 150 }], 3, 8, 200), [
    { a: 0, b: 1, age: 50 },
    { a: 2, b: 5, age: 100 },
  ]);
});

test('占位拆段、文件大小', async () => {
  const { fillParts, fmtSize } = await import('./words.js');
  assert.deepEqual(fillParts('{from} 暂不可用，这一轮用了 {to}', { from: 'A', to: 'B' }), [
    { text: 'A', key: 'from' }, { text: ' 暂不可用，这一轮用了 ' }, { text: 'B', key: 'to' },
  ]);
  assert.deepEqual(fillParts('{x} y', {}), [{ text: '{x}' }, { text: ' y' }]);
  assert.equal(fmtSize(2048), '2 KB');
  assert.equal(fmtSize(3.4 * 1024 * 1024), '3.4 MB');
  assert.equal(fmtSize(0), '');
});

test('回执里的媒体文件路径', async () => {
  const { mediaPaths } = await import('./words.js');
  assert.deepEqual(
    mediaPaths('已保存到 D:\\proj\\assets\\hero.png ，另存 /tmp/out/x.mp4 和 D:\\proj\\assets\\hero.png、C:/x/y.JPG'),
    ['D:\\proj\\assets\\hero.png', '/tmp/out/x.mp4', 'C:/x/y.JPG'],
  );
  assert.deepEqual(mediaPaths('没有文件'), []);
});
