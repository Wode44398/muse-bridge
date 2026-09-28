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
