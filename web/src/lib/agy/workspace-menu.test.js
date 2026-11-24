import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSidebarWorkspaceMenu } from './workspace-menu.js';

test('已保存项目组：包含置顶/取消置顶、隐藏全部对话、移除工作空间', () => {
  const calls = [];
  const items = buildSidebarWorkspaceMenu({
    pgrp: { key: 'p1', projectId: 'p1', name: 'bridge build', path: 'D:\\Notes\\bridge build', pinned: true },
    projects: [{ id: 'p1', name: 'bridge build', path: 'D:\\Notes\\bridge build', pinned: true }],
    recentDirs: [],
    defaultCwd: 'D:\\Notes',
    sessionIds: ['s1', 's2', 's1'],
    onPin: (arg) => calls.push(['pin', arg]),
    onHideAll: (ids, name) => calls.push(['hide', ids, name]),
    onRemove: (arg) => calls.push(['remove', arg]),
  });

  assert.deepEqual(items.map((x) => (x.sep ? '---' : x.id)), ['unpin', 'rename', '---', 'hide-all', 'delete']);
  assert.equal(items[3].label, '隐藏全部对话 (2)');
  items[0].onclick();
  items[3].onclick();
  items[4].onclick();
  assert.deepEqual(calls, [
    ['pin', { id: 'p1', path: 'D:\\Notes\\bridge build', name: 'bridge build', pinned: false }],
    ['hide', ['s1', 's2'], 'bridge build'],
    ['remove', { id: 'p1', path: 'D:\\Notes\\bridge build', name: 'bridge build' }],
  ]);
});

test('未保存但在「最近用过」里的工作空间：同样显示隐藏全部对话与移除工作空间', () => {
  const removed = [];
  const items = buildSidebarWorkspaceMenu({
    pgrp: { key: 'cwd:e:\\proj', projectId: null, name: 'proj', path: 'E:\\proj', pinned: false },
    projects: [],
    recentDirs: [{ path: 'e:/proj/', name: 'proj' }],
    defaultCwd: 'D:\\Notes',
    sessionIds: ['s1'],
    onRemove: (arg) => removed.push(arg),
  });

  assert.deepEqual(items.map((x) => (x.sep ? '---' : x.id)), ['pin', 'rename', '---', 'hide-all', 'delete']);
  items[4].onclick();
  assert.deepEqual(removed, [{ id: '', path: 'E:\\proj', name: 'proj' }]);
});

test('默认工作空间根目录或不在项目/最近列表中的旧目录：不显示无效的移除工作空间，但保留隐藏全部对话', () => {
  const defaultItems = buildSidebarWorkspaceMenu({
    pgrp: { key: 'cwd:D:\\Notes', projectId: null, name: 'Vault', path: 'D:\\Notes', pinned: false },
    projects: [],
    recentDirs: [{ path: 'D:\\Notes', name: 'Vault' }],
    defaultCwd: 'D:\\Notes',
    sessionIds: ['s1', 's2', 's3'],
  });
  assert.deepEqual(defaultItems.map((x) => (x.sep ? '---' : x.id)), ['pin', 'rename', '---', 'hide-all']);

  const oldItems = buildSidebarWorkspaceMenu({
    pgrp: { key: 'cwd:e:\\old', projectId: null, name: 'old', path: 'E:\\old', pinned: false },
    projects: [],
    recentDirs: [],
    defaultCwd: 'D:\\Notes',
    sessionIds: ['s9'],
  });
  assert.deepEqual(oldItems.map((x) => (x.sep ? '---' : x.id)), ['pin', 'rename', '---', 'hide-all']);
});

test('插件菜单项：插在置顶之后、隐藏 / 移除之前，各用分隔线隔开', () => {
  const ran = [];
  const items = buildSidebarWorkspaceMenu({
    pgrp: { key: 'p1', projectId: 'p1', name: 'bridge build', path: 'E:\\bb' },
    projects: [{ id: 'p1', name: 'bridge build', path: 'E:\\bb' }],
    sessionIds: ['s1'],
    pluginItems: [
      { id: 'plugin:demo:collab-edit', label: '协作设置', icon: '', svg: '<svg/>', onclick: () => ran.push('edit') },
      { id: 'plugin:demo:collab-off', label: '取消协作', icon: 'claude', danger: true, onclick: () => ran.push('off') },
      { sep: true },
      { id: 'plugin:demo:nolabel', label: '' },
    ],
  });
  assert.deepEqual(items.map((x) => (x.sep ? '---' : x.id)), ['pin', 'rename', '---', 'plugin:demo:collab-edit', 'plugin:demo:collab-off', '---', 'hide-all', 'delete']);
  items[4].onclick();
  assert.deepEqual(ran, ['off']);
});

test('插件菜单项：没有隐藏 / 移除时尾部不多出分隔线', () => {
  const items = buildSidebarWorkspaceMenu({
    pgrp: { key: 'cwd:x', name: 'x', path: 'E:\\x' },
    pluginItems: [{ id: 'plugin:demo:collab-on', label: '设为协作工作空间', onclick() {} }],
  });
  assert.deepEqual(items.map((x) => (x.sep ? '---' : x.id)), ['pin', 'rename', '---', 'plugin:demo:collab-on']);
});

test('重命名：已保存项目带 id 与路径，只来自历史会话的分组带路径；「其他」分组没有重命名', () => {
  const calls = [];
  const saved = buildSidebarWorkspaceMenu({
    pgrp: { key: 'p1', projectId: 'p1', name: '我的项目', path: 'E:\bb' },
    projects: [{ id: 'p1', name: '我的项目', path: 'e:/bb/' }],
    onRename: (arg) => calls.push(arg),
  });
  saved.find((x) => x.id === 'rename').onclick();
  const legacy = buildSidebarWorkspaceMenu({
    pgrp: { key: 'cwd:e:\old', projectId: null, name: 'old', path: 'E:\old' },
    onRename: (arg) => calls.push(arg),
  });
  legacy.find((x) => x.id === 'rename').onclick();
  assert.deepEqual(calls, [
    { id: 'p1', path: 'e:/bb/', name: '我的项目' },
    { id: '', path: 'E:\old', name: 'old' },
  ]);
  assert.deepEqual(buildSidebarWorkspaceMenu({ pgrp: { key: '__other__', unassigned: true, name: '其他' } }), []);
});
