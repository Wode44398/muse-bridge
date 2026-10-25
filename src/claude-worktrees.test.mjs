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

test('分支前缀跟设置走（不合法回落 claude）；起点 fresh = fetch 后从 origin 默认分支切、不设上游', async () => {
  const { root, ctx, file, data } = fixture();
  const originDir = mkdtempSync(path.join(tmpdir(), 'wt-origin-'));
  const other = mkdtempSync(path.join(tmpdir(), 'wt-other-'));
  try {
    const project = claudeProjects.createProject(file, ctx, { path: root });
    const a = await createSessionWorktree(file, project, { prefix: 'bot' });
    assert.equal(a.branch, 'bot/' + a.name);
    assert.equal(a.from, 'head');
    const b = await createSessionWorktree(file, project, { prefix: 'main' });
    assert.equal(b.branch, 'claude/' + b.name, '保留前缀回落默认');

    // origin 比本地 HEAD 多一个提交；本地切到别的分支，fresh 仍从 origin/main 切
    git(originDir, 'init', '-q', '--bare', '-b', 'main');
    git(root, 'remote', 'add', 'origin', originDir);
    git(root, 'push', '-q', 'origin', 'main');
    git(other, 'clone', '-q', originDir, '.');
    writeFileSync(path.join(other, 'up.txt'), 'up\n');
    git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'upstream');
    git(other, 'push', '-q', 'origin', 'main');
    git(root, 'checkout', '-q', '-b', 'local-work');
    const c = await createSessionWorktree(file, project, { baseRef: 'fresh' });
    assert.equal(c.from, 'fresh');
    assert.equal(c.base, 'main');
    assert.equal(git(c.root, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
    assert.ok(existsSync(path.join(c.root, 'up.txt')));
    assert.throws(() => git(c.root, 'rev-parse', '--abbrev-ref', '@{upstream}'), '新分支没有上游');

    // 没有 origin：fresh 退回当前 HEAD
    git(root, 'remote', 'remove', 'origin');
    const d = await createSessionWorktree(file, project, { baseRef: 'fresh' });
    assert.equal(d.from, 'head');
    assert.equal(d.base, 'local-work');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
