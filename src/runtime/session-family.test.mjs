import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// session-family 经 claude-settings / questions 间接加载 config/index.mjs（首次加载会在数据根生成 config.json）：数据根指到临时目录
process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'family-root-'));
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
const {
  addLink, familyLink, familyMaps, rootOfFamily, childrenOf, resolveTarget, forgetSession,
  familyTurnEnded, familyTurnStart, sendToSession, _resetFamily, _inbox, _limits,
} = await import('./session-family.mjs');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004';
const X = 'eeeeeeee-0000-4000-8000-000000000005';

let dir, ctx;
beforeEach(() => {
  _resetFamily();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(tmpdir(), 'family-test-'));
  ctx = { key: 'admin', dataDir: dir, claudeProjects: path.join(dir, 'projects.json'), cwd: dir };
});

const gen = (sessionId, { origin = null, events = [], touched = null } = {}) => ({
  sessionId, events, family: origin ? { origin } : null, ...(touched ? { familyTouched: new Set(touched) } : {}),
});

test('父子关系：多层树的顶层祖先、直接父、名字去重、落盘', () => {
  addLink(ctx, B, { parent: A, title: '写测试', name: 'tests' });
  addLink(ctx, C, { parent: B, title: '修 lint', name: 'tests' });   // 重名自动加后缀
  addLink(ctx, D, { parent: A, title: '整理文档' });                 // 没给 name：中文标题派生不出 → s-<id 前 6 位>
  assert.equal(rootOfFamily(ctx, C), A);
  assert.equal(rootOfFamily(ctx, A), A);
  const m = familyMaps(ctx);
  assert.equal(m.rootOf.get(C), A);
  assert.equal(m.parentOf.get(C), B);
  assert.equal(m.rootOf.has(A), false);
  assert.equal(familyLink(ctx, C).name, 'tests-2');
  assert.equal(familyLink(ctx, D).name, 's-dddddd');
  assert.deepEqual(childrenOf(ctx, A).map((c) => c.id), [B, D]);
  const disk = JSON.parse(readFileSync(path.join(dir, 'claude-session-family.json'), 'utf8'));
  assert.equal(Object.keys(disk.links).length, 3);
});

test('发消息的对象：只认同一棵树里的会话（id / name / id 前缀），树外的找不到', () => {
  addLink(ctx, B, { parent: A, title: 'b', name: 'bee' });
  addLink(ctx, C, { parent: A, title: 'c', name: 'sea' });
  addLink(ctx, X, { parent: D, title: 'x', name: 'ex' });   // 另一棵树
  assert.equal(resolveTarget(ctx, B, 'sea'), C);            // 兄弟按 name
  assert.equal(resolveTarget(ctx, B, A), A);                // 父按 id
  assert.equal(resolveTarget(ctx, A, 'bbbbbbbb'), B);       // id 前缀（≥8 位）
  assert.equal(resolveTarget(ctx, B, 'ex'), null);
  assert.equal(resolveTarget(ctx, B, X), null);
  assert.equal(resolveTarget(ctx, B, B), null);             // 不给自己发
});

test('删会话：它的父子关系一并清掉，它派生的子会话升为顶层', () => {
  addLink(ctx, B, { parent: A, title: 'b' });
  addLink(ctx, C, { parent: B, title: 'c' });
  forgetSession(ctx, B);
  assert.equal(familyLink(ctx, B), null);
  assert.equal(familyLink(ctx, C), null);
  assert.equal(rootOfFamily(ctx, C), C);
});

test('子会话做完父会话派的活：汇报进父会话收件箱（前 400 字）；用户下一次在父会话发话时附上', () => {
  addLink(ctx, B, { parent: A, title: '跑测试', name: 'runner' });
  familyTurnEnded(ctx, gen(B, { origin: { kind: 'spawn', from: [A] }, events: [{ type: 'done', result: '全部通过。' + 'x'.repeat(600) }] }));
  const box = _inbox('admin', A);
  assert.equal(box.length, 1);
  assert.equal(box[0].kind, 'note');
  assert.equal(box[0].status, 'done');
  assert.equal(box[0].text.length, 400);
  const extra = familyTurnStart(ctx, A, null, null);   // 用户在父会话发话
  assert.match(extra, /<side-sessions-event>/);
  assert.match(extra, new RegExp(`<note from="${B}" name="runner" title="跑测试" status="done">`));
  assert.equal(_inbox('admin', A).length, 0);
  assert.equal(familyTurnStart(ctx, A, null, null), null);
});

test('汇报的状态：报错 = failed；用户按了停止 = stopped 且不唤醒（quiet）', () => {
  addLink(ctx, B, { parent: A, title: 'b' });
  familyTurnEnded(ctx, gen(B, { origin: { kind: 'spawn', from: [A] }, events: [{ type: 'error', title: '额度用完', message: '本周额度已用完' }] }));
  familyTurnEnded(ctx, gen(B, { origin: { kind: 'inbox', from: [A] }, events: [{ type: 'interrupted' }] }));
  const box = _inbox('admin', A);
  assert.deepEqual(box.map((n) => n.status), ['failed', 'stopped']);
  assert.equal(box[0].text, '本周额度已用完');
  assert.equal(box[1].quiet, true);
});

test('防止两个会话无限互相唤醒：连续自动续到上限就不再唤醒，消息攒着；用户一发话就清零并附上', async () => {
  addLink(ctx, B, { parent: A, title: 'b', name: 'bee' });
  for (let i = 0; i < _limits.MAX_STREAK; i++) familyTurnStart(ctx, B, { origin: { kind: 'inbox', from: [A] } }, null);
  const r = await sendToSession(ctx, A, 'bee', '再改一版');
  assert.deepEqual([r.ok, r.how], [true, 'held']);
  assert.equal(_inbox('admin', B).length, 1);
  const extra = familyTurnStart(ctx, B, null, null);   // 用户在子会话里发话
  assert.match(extra, /<session-message from="aaaaaaaa[^"]*" name="" title="[^"]*" relation="parent">\n再改一版\n<\/session-message>/);
  assert.match(extra, /<session-hint>/);
  assert.equal(_inbox('admin', B).length, 0);
});

test('只有父会话发起的轮才汇报：用户自己在子会话里聊、兄弟发来的消息触发的轮都不汇报', () => {
  addLink(ctx, B, { parent: A, title: 'b' });
  addLink(ctx, C, { parent: A, title: 'c' });
  familyTurnEnded(ctx, gen(B, { events: [{ type: 'done', result: 'hi' }] }));                                 // 用户驱动
  familyTurnEnded(ctx, gen(B, { origin: { kind: 'inbox', from: [C] }, events: [{ type: 'done', result: 'x' }] }));  // 兄弟的消息
  assert.equal(_inbox('admin', A).length, 0);
  // 父会话的消息插进了用户正在跑的那一轮（steer）→ 这一轮结束也要汇报
  familyTurnEnded(ctx, gen(B, { touched: [A], events: [{ type: 'done', result: '改好了' }] }));
  assert.equal(_inbox('admin', A).length, 1);
});
