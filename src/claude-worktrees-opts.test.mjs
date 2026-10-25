// createSessionWorktree 的可选参数（会话派生用，session-family.mjs）：名字提示、起点、分支前缀；不给时与原行为一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionWorktree } from './claude-worktrees.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, windowsHide: true }).toString().trim();

test('起点 / 名字提示 / 前缀：从基线分支切（不是当前 HEAD），名字 <slug>-<6hex>，空前缀不加斜杠', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-opts-'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), '1\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'one');
  git(root, 'checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(root, 'a.txt'), '2\n');
  git(root, 'commit', '-q', '-am', 'two');
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'wt-opts-data-')), 'claude-projects.json');
  const project = { id: 'p1', path: root };

  const a = await createSessionWorktree(file, project, { hint: 'feat/Split Parser!', startPoint: 'main', prefix: 'bot' });
  assert.match(a.name, /^split-parser-[0-9a-f]{6}$/);
  assert.equal(a.branch, 'bot/' + a.name);
  assert.equal(a.base, 'main');
  assert.equal(git(a.root, 'log', '-1', '--format=%s'), 'one');   // 从 main 切，不带 feature 上的提交

  const b = await createSessionWorktree(file, project, { prefix: '' });
  assert.match(b.name, /^[a-z]+-[a-z]+-[0-9a-f]{6}$/);
  assert.equal(b.branch, b.name);
  assert.equal(b.base, 'feature');
  assert.equal(git(b.root, 'log', '-1', '--format=%s'), 'two');

  await assert.rejects(createSessionWorktree(file, project, { startPoint: 'no-such-branch' }), /找不到/);
  await assert.rejects(createSessionWorktree(file, project, { startPoint: '--help' }), /找不到/);
});
