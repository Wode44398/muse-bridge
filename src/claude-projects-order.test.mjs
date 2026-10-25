import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProjects, createProject, deleteProject, projectOrder, setProjectOrder } from './claude-projects.mjs';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cp-order-'));
  const cwd = path.join(root, 'ws');
  const a = path.join(root, 'alpha');
  const b = path.join(root, 'beta');
  for (const d of [cwd, a, b]) mkdirSync(d, { recursive: true });
  const ctx = { cwd, kind: 'admin', dataDir: root, configDir: path.join(root, '.claude') };
  const file = path.join(root, 'claude-projects.json');
  return { root, ctx, file, a, b };
}

test('setProjectOrder keeps only known ids once, and survives other writes', () => {
  const f = fixture();
  try {
    const pa = createProject(f.file, f.ctx, { path: f.a });
    const pb = createProject(f.file, f.ctx, { path: f.b });
    const def = listProjects(f.file, f.ctx)[0];
    assert.equal(def.def, true);
    const order = setProjectOrder(f.file, f.ctx, [pb.id, 'nope', def.id, pb.id, pa.id]);
    assert.deepEqual(order, [pb.id, def.id, pa.id]);
    assert.deepEqual(projectOrder(f.file), [pb.id, def.id, pa.id]);
    // listProjects 的返回顺序不受显示顺序影响：[0] 恒为默认项目
    assert.equal(listProjects(f.file, f.ctx)[0].id, def.id);
    // 其它写操作（新建/删除）不会把 order 冲掉；删掉的项目顺带从 order 里摘掉
    assert.equal(deleteProject(f.file, f.ctx, pa.id), true);
    assert.deepEqual(projectOrder(f.file), [pb.id, def.id]);
    const raw = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.deepEqual(raw.order, [pb.id, def.id]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('setProjectOrder rejects non-array input', () => {
  const f = fixture();
  try {
    assert.throws(() => setProjectOrder(f.file, f.ctx, 'x'), /数组/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('一轮的 ctx（cwd = worktree 目录、带 homeRoot）查项目表不再建幽灵「工作空间」项目；早先建出来的读表时清掉', async () => {
  const f = fixture();
  try {
    const { ensureDefaultProject, identityCtx } = await import('./claude-projects.mjs');
    const pa = createProject(f.file, f.ctx, { path: f.a });
    const def = listProjects(f.file, f.ctx)[0];
    const wt = path.join(f.a, '.claude', 'worktrees', 'todo-cli-de8c30');
    mkdirSync(wt, { recursive: true });
    const turnCtx = { ...f.ctx, cwd: wt, homeRoot: f.ctx.cwd, worktree: { cwd: wt, branch: 'claude/todo' } };
    assert.equal(ensureDefaultProject(f.file, turnCtx).id, def.id);
    assert.equal(listProjects(f.file, turnCtx)[0].id, def.id);
    const disk = () => JSON.parse(readFileSync(f.file, 'utf8')).projects;
    assert.ok(!disk().some((p) => p.path === path.resolve(wt)), '不该把 worktree 目录建成项目');
    assert.equal(identityCtx(turnCtx).cwd, f.ctx.cwd);
    assert.equal(identityCtx(turnCtx).worktree, undefined);
    // 普通项目目录的一轮 ctx 行为照旧（cwd 本身就是表里的项目）
    assert.equal(ensureDefaultProject(f.file, { ...f.ctx, cwd: f.a, homeRoot: f.ctx.cwd }).id, pa.id);
    // 早先误建的幽灵：名字「工作空间」、没改名、路径 <已有项目>/.claude/worktrees/<名> → 读表时清掉；改过名的 / 不在已有项目下的不动
    const { writeFileSync } = await import('node:fs');
    const store = JSON.parse(readFileSync(f.file, 'utf8'));
    const ghost = { id: 'g-1', name: '工作空间', path: path.resolve(wt), created: 1, updated: 1 };
    const named = { id: 'g-2', name: '工作空间', label: '我的 wt', path: path.join(f.a, '.claude', 'worktrees', 'kept'), created: 1, updated: 1 };
    const stray = { id: 'g-3', name: '工作空间', path: path.join(f.root, 'elsewhere', '.claude', 'worktrees', 'x'), created: 1, updated: 1 };
    store.projects.unshift(ghost, named, stray);
    store.order = ['g-1', def.id, pa.id];
    writeFileSync(f.file, JSON.stringify(store));
    assert.equal(listProjects(f.file, f.ctx)[0].id, def.id);
    const ids = disk().map((p) => p.id);
    assert.ok(!ids.includes('g-1'));
    assert.ok(ids.includes('g-2') && ids.includes('g-3'));
    assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).order, [def.id, pa.id]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
