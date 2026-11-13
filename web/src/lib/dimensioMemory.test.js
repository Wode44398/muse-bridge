// 记忆卡的 dimensio 适配（dimensioMemory.js）：四类分枝、按类型再分一层的门槛、替代关系成跨枝关联、桶的切换列表。
import test from 'node:test';
import assert from 'node:assert/strict';
import { dimensioGraph, dimensioRoots, bucketFor, laneOf } from './dimensioMemory.js';

const m = (id, extra = {}) => ({ id, title: 'T ' + id, description: 'd', type: 'project', topic: id, status: 'active', declaredStatus: 'active', confidence: 'verified', updated: '2026-10-01T00:00:00Z', issues: [], ...extra });

test('四类口径与 dimensio 记忆面板一致：被扣成待确认的算待确认，写着生效却失效的算被隔离', () => {
  assert.equal(laneOf(m('a', { status: 'proposed', declaredStatus: 'active' })), 'proposed');
  assert.equal(laneOf(m('a', { status: 'stale', declaredStatus: 'active' })), 'held');
  assert.equal(laneOf(m('a', { status: 'rejected', declaredStatus: 'rejected' })), 'retired');
  assert.equal(laneOf(m('a', { status: 'superseded', declaredStatus: 'superseded' })), 'retired');
  assert.equal(laneOf(m('a')), 'active');
});

test('图：根下按四类分枝（空类不出），叶子 ref = 记忆 id，文件元数据带标签与时间', () => {
  const g = dimensioGraph([m('a'), m('b', { status: 'proposed', declaredStatus: 'proposed' })], { root: 'proj', lane: { active: '生效', proposed: '待确认' } });
  assert.equal(g.tree.label, 'proj');
  assert.deepEqual(g.tree.children.map((c) => c.label), ['待确认', '生效']);
  assert.deepEqual(g.tree.children[0].children.map((c) => c.ref), ['b']);
  assert.equal(g.files.a.label, 'T a');
  assert.ok(g.files.a.mtime > 0);
  assert.equal(g.stats.files, 2);
  assert.deepEqual(g.files.a.dead, []);
});

test('一类里条目多且混着几种类型才按类型再分一层', () => {
  const few = dimensioGraph([m('a'), m('b', { type: 'user' })]);
  assert.equal(few.tree.children[0].children.every((c) => c.kind === 'file'), true);
  const many = dimensioGraph([...Array.from({ length: 5 }, (_, i) => m('p' + i)), m('u1', { type: 'user' }), m('u2', { type: 'user' })], { type: { user: '偏好', project: '项目' } });
  assert.deepEqual(many.tree.children[0].children.map((c) => c.label), ['偏好', '项目']);
});

test('替代关系成跨枝关联（去重、对方不在就不连）', () => {
  const g = dimensioGraph([m('new', { supersedes: 'old' }), m('old', { status: 'superseded', declaredStatus: 'superseded', supersededBy: 'new' }), m('x', { supersedes: 'gone' })]);
  assert.deepEqual(g.links, [{ from: 'new', to: 'old', kind: 'md' }]);
  assert.equal(g.files.old.in, 1);
});

test('切换列表只列有条目的桶；按工作区找桶不分大小写与斜杠', () => {
  const ov = { buckets: [
    { kind: 'global', ws: '@global', name: '', items: [m('g')] },
    { kind: 'project', ws: 'C:\\Proj\\A', name: 'A', current: true, items: [m('a')] },
    { kind: 'project', ws: 'C:\\Proj\\B', name: 'B', items: [] },
  ] };
  assert.deepEqual(dimensioRoots(ov).map((r) => r.dir), ['@global', 'C:\\Proj\\A']);
  assert.equal(bucketFor(ov, 'c:/proj/a/')?.name, 'A');
  assert.equal(bucketFor(ov, 'C:\\Proj\\Z'), null);
});
