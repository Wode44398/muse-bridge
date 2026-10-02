import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionWorktree, listWorktrees } from './claude-worktrees.mjs';
import * as claudeProjects from './claude-projects.mjs';
import { sessionsDir } from './runtime/paths.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, windowsHide: true }).toString().trim();

// 沙箱用户身份：工作空间根 = 一个带一次提交的仓库，项目 = 仓库里的 app/ 子目录。
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-sess-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(path.join(root, 'app'));
  writeFileSync(path.join(root, 'app', 'a.txt'), 'hi\n');
  writeFileSync(path.join(root, '.gitignore'), '.env\n');
  writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  writeFileSync(path.join(root, '.worktreeinclude'), '.env\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const ctx = { kind: 'user', key: 'u:t', cwd: root, dataDir: root, configDir: path.join(root, '.cfg') };
  const data = mkdtempSync(path.join(tmpdir(), 'wt-data-'));
  const file = path.join(data, 'claude-projects.json');
  return { root, ctx, file, data };
}

test('worktree 会话：切分支、落 .claude/worktrees、子目录映射、.worktreeinclude 拷贝', async () => {
  const { root, ctx, file, data } = fixture();
  try {
    const project = claudeProjects.createProject(file, ctx, { path: path.join(root, 'app') });
    const wt = await createSessionWorktree(file, project);
    assert.match(wt.name, /^[a-z]+-[a-z]+-[0-9a-f]{6}$/);
    assert.equal(wt.branch, 'claude/' + wt.name);
    assert.equal(wt.base, 'main');
    assert.ok(existsSync(path.join(wt.root, 'app', 'a.txt')));
    assert.equal(path.basename(wt.cwd), 'app');
    assert.equal(readFileSync(path.join(wt.root, '.env'), 'utf8'), 'SECRET=1\n');
    assert.equal(git(wt.root, 'rev-parse', '--abbrev-ref', 'HEAD'), wt.branch);
    // 主检出不被 worktree 目录弄脏
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(listWorktrees(file).length, 1);

    // 归属：worktree cwd 下的 transcript 归原项目，project.path 换成 worktree cwd
    const id = '0123abcd-0000-4000-8000-000000000001';
    const dir = sessionsDir(wt.cwd, ctx.configDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, id + '.jsonl'), '{}\n');
    const found = claudeProjects.locateSessionPaths(file, ctx, id);
    assert.equal(found.project.id, project.id);
    assert.equal(found.project.path, wt.cwd);
    assert.equal(found.project.worktree.branch, wt.branch);
    assert.equal(claudeProjects.locateSessionProject(file, ctx, id).path, wt.cwd);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test('非 git 目录拒绝创建 worktree', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-nogit-'));
  try {
    await assert.rejects(createSessionWorktree(path.join(root, 'p.json'), { id: 'x', path: root }), /不是 git 仓库/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
