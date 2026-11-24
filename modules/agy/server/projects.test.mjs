import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listProjects,
  listDismissedPaths,
  projectOrder,
  setProjectOrder,
  createProject,
  pinProject,
  renameProject,
  deleteProject,
} from './projects.mjs';
import { extractRecentSessionDirs } from './recent-dirs.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-projects-'));
const file = path.join(tmp, 'agy-projects.json');
const dirA = path.join(tmp, 'alpha');
const dirB = path.join(tmp, 'beta');
const dirC = path.join(tmp, 'gamma');
const dirDead = path.join(tmp, 'dead-dir');
mkdirSync(dirA, { recursive: true });
mkdirSync(dirB, { recursive: true });
mkdirSync(dirC, { recursive: true });
mkdirSync(dirDead, { recursive: true });

const adminCtx = { kind: 'admin', cwd: tmp };

after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('工作空间置顶、取消置顶、排序与移除（含抑制回流最近用过、已删目录照常移除）', async () => {
  const pA = createProject(file, adminCtx, { path: dirA });
  await new Promise((r) => setTimeout(r, 15));
  const pB = createProject(file, adminCtx, { path: dirB });

  // 默认按最近更新倒序：beta 在前
  assert.deepEqual(listProjects(file).map((p) => p.name), ['beta', 'alpha']);
  assert.equal(listProjects(file)[0].pinned, false);

  // 置顶 alpha → 排到最前
  const pinnedA = pinProject(file, adminCtx, { id: pA.id, pinned: true });
  assert.equal(pinnedA.pinned, true);
  assert.equal(typeof pinnedA.pinnedAt, 'number');
  assert.deepEqual(listProjects(file).map((p) => [p.name, p.pinned]), [['alpha', true], ['beta', false]]);

  // 直接按路径置顶尚未登记的「最近用过」目录 gamma → 自动登记并置顶到首位
  await new Promise((r) => setTimeout(r, 15));
  const pinnedC = pinProject(file, adminCtx, { path: dirC, pinned: true });
  assert.equal(pinnedC.name, 'gamma');
  assert.equal(pinnedC.pinned, true);
  assert.deepEqual(listProjects(file).map((p) => p.name), ['gamma', 'alpha', 'beta']);

  // 取消置顶 gamma → 落回未置顶区
  const unpinnedC = pinProject(file, adminCtx, { id: pinnedC.id, pinned: false });
  assert.equal(unpinnedC.pinned, false);
  assert.equal(listProjects(file)[0].name, 'alpha');

  // 删除 beta 后不再出现在项目列表，也不会回流进「最近用过」
  const delB = deleteProject(file, adminCtx, { id: pB.id });
  assert.equal(delB.deleted, true);
  assert.equal(delB.project.id, pB.id);
  assert.equal(listProjects(file).some((p) => p.id === pB.id), false);
  assert.equal(listDismissedPaths(file).size, 1);

  const recent1 = extractRecentSessionDirs([
    { cwd: dirB, updatedMs: Date.now() },
    { cwd: dirDead, updatedMs: Date.now() - 1000 },
  ], { ctx: adminCtx, projectsFile: file });
  assert.deepEqual(recent1.map((d) => d.name), ['dead-dir']);

  // 对「最近用过」目录直接按路径移除 → 写入 dismissedPaths，不再出现
  const delRecent = deleteProject(file, adminCtx, { path: dirDead });
  assert.equal(delRecent.deleted, true);
  const recent2 = extractRecentSessionDirs([
    { cwd: dirDead, updatedMs: Date.now() },
  ], { ctx: adminCtx, projectsFile: file });
  assert.deepEqual(recent2, []);

  // 重新显式添加 beta → 清除抑制记录，正常回归列表
  const pB2 = createProject(file, adminCtx, { path: dirB });
  assert.equal(pB2.name, 'beta');
  assert.equal(listProjects(file).some((p) => p.name === 'beta'), true);

  // 磁盘目录已删时仍能从工作空间列表移除
  const pDead = createProject(file, adminCtx, { path: dirDead });
  rmSync(dirDead, { recursive: true, force: true });
  const delDead = deleteProject(file, adminCtx, { id: pDead.id });
  assert.equal(delDead.deleted, true);
  assert.equal(listProjects(file).some((p) => p.id === pDead.id), false);
});

test('工作空间手动顺序持久化、置顶置前与删除清理', () => {
  const orderFile = path.join(tmp, 'agy-order.json');
  createProject(orderFile, adminCtx, { path: dirA });
  createProject(orderFile, adminCtx, { path: dirB });
  createProject(orderFile, adminCtx, { path: dirC });

  assert.deepEqual(projectOrder(orderFile), []);

  // 去重并过滤非绝对路径
  const saved = setProjectOrder(orderFile, adminCtx, [dirC, 'relative/bad', dirA, dirC, dirB]);
  assert.deepEqual(saved, [path.resolve(dirC), path.resolve(dirA), path.resolve(dirB)]);
  assert.deepEqual(projectOrder(orderFile), saved);

  // 置顶 beta 时，若已有手动顺序则把它提至首位
  pinProject(orderFile, adminCtx, { path: dirB, pinned: true });
  assert.deepEqual(projectOrder(orderFile), [path.resolve(dirB), path.resolve(dirC), path.resolve(dirA)]);

  // 删除 alpha 时同步从 order 移除
  deleteProject(orderFile, adminCtx, { path: dirA });
  assert.deepEqual(projectOrder(orderFile), [path.resolve(dirB), path.resolve(dirC)]);
});

test('重命名只改显示名：不动路径、不改排序时间，未登记的目录先登记，改回文件夹名即恢复', () => {
  const renFile = path.join(tmp, 'agy-rename.json');
  const pA = createProject(renFile, adminCtx, { path: dirA });
  assert.equal(pA.name, 'alpha');
  assert.equal(pA.renamed, false);
  const before = listProjects(renFile).find((p) => p.id === pA.id).updated;

  const r1 = renameProject(renFile, adminCtx, { id: pA.id, name: '  主项目  ' });
  assert.equal(r1.name, '主项目');
  assert.equal(r1.folderName, 'alpha');
  assert.equal(r1.renamed, true);
  assert.equal(r1.path, pA.path);
  assert.equal('label' in r1, false);
  const listed = listProjects(renFile).find((p) => p.id === pA.id);
  assert.equal(listed.name, '主项目');
  assert.equal(listed.updated, before);

  // 改回文件夹名 / 留空 = 恢复跟着文件夹名走
  assert.equal(renameProject(renFile, adminCtx, { id: pA.id, name: 'alpha' }).renamed, false);
  renameProject(renFile, adminCtx, { id: pA.id, name: 'x' });
  assert.equal(renameProject(renFile, adminCtx, { path: dirA, name: '' }).name, 'alpha');

  // 还没登记的目录（「最近用过」或只来自历史会话）：先登记成项目再记名字
  const rB = renameProject(renFile, adminCtx, { path: dirB, name: '第二个' });
  assert.equal(rB.name, '第二个');
  assert.equal(listProjects(renFile).filter((p) => p.path === rB.path).length, 1);

  assert.throws(() => renameProject(renFile, adminCtx, { name: 'x' }), /缺少项目 id 或路径/);
  assert.throws(() => renameProject(renFile, adminCtx, { id: 'nope', name: 'x' }), /项目不存在/);
});
