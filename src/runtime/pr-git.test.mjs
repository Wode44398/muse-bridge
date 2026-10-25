// 同步基线分支 / 工作目录 git 概况（pr-git.mjs）：用临时的裸仓库当 origin，全程本地 git，不碰网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncBaseBranch, gitInfo } from './pr-git.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// origin（裸仓库）+ 两个克隆：work（会话的工作目录，在功能分支上）与 other（模拟别人往 main 推提交）
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pr-git-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = path.join(root, 'work');
  git(root, 'clone', '-q', origin, work);
  for (const d of [work]) { git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@t'); }
  writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'init'); git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  const other = path.join(root, 'other');
  git(root, 'clone', '-q', origin, other);
  git(other, 'config', 'user.name', 'o'); git(other, 'config', 'user.email', 'o@o');
  git(work, 'checkout', '-q', '-b', 'claude/feat');
  return { root, origin, work, other };
}
const pushMain = (other, file, text) => { writeFileSync(path.join(other, file), text); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'upstream ' + file); git(other, 'push', '-q', 'origin', 'main'); };

test('基线有新提交 → 主机侧 merge 进来；再同步 = 已是最新；工作区脏 → 拒绝', async () => {
  const { root, work, other } = fixture();
  try {
    pushMain(other, 'b.txt', 'b\n');
    writeFileSync(path.join(work, 'c.txt'), 'c\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'feat');
    const r = await syncBaseBranch(work, { base: 'main' });
    assert.equal(r.kind, 'merged');
    assert.equal(r.fastForward, false);
    assert.ok(existsSync(path.join(work, 'b.txt')));
    assert.equal(git(work, 'rev-parse', 'HEAD'), r.commit);
    assert.equal((await syncBaseBranch(work, { base: 'main' })).kind, 'up_to_date');
    writeFileSync(path.join(work, 'a.txt'), 'dirty\n');
    const d = await syncBaseBranch(work, { base: 'main' });
    assert.equal(d.kind, 'refused');
    assert.equal(d.reason, 'uncommitted_changes');
    assert.deepEqual(d.files, ['a.txt']);
    // 基线名校验：不许以 - 开头、不许 ..
    git(work, 'checkout', '-q', '--', 'a.txt');
    assert.equal((await syncBaseBranch(work, { base: '--upload-pack=x' })).reason, 'invalid_base');
    assert.equal((await syncBaseBranch(work, { base: 'claude/feat' })).reason, 'base_not_allowed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('冲突 → 停在合并进行中并列出冲突文件；再同步拒绝（合并进行中）；abort 放弃', async () => {
  const { root, work, other } = fixture();
  try {
    pushMain(other, 'a.txt', 'theirs\n');
    writeFileSync(path.join(work, 'a.txt'), 'mine\n'); git(work, 'commit', '-q', '-am', 'mine');
    const r = await syncBaseBranch(work, { base: 'main' });
    assert.equal(r.kind, 'conflicts');
    assert.deepEqual(r.files, ['a.txt']);
    assert.equal(r.total, 1);
    const again = await syncBaseBranch(work, { base: 'main' });
    assert.deepEqual([again.kind, again.reason, again.detail], ['refused', 'operation_in_progress', 'a merge']);
    assert.equal((await syncBaseBranch(work, { abort: true })).kind, 'aborted');
    assert.equal(git(work, 'status', '--porcelain'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('git 概况：远端仓库、默认分支、未推送提交与脏文件', async () => {
  const { root, work } = fixture();
  try {
    // 远端地址换成 GitHub 形状（只读 remote get-url，不会真的连）
    git(work, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    let i = await gitInfo(work, { fresh: true });
    assert.deepEqual([i.branch, i.defaultBranch, i.onBase, i.unpushed, i.pushed, i.dirty], ['claude/feat', 'main', false, 0, false, 0]);
    assert.deepEqual(i.remote, { host: 'github.com', repo: 'o/r' });
    writeFileSync(path.join(work, 'n.txt'), 'n\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'n');
    writeFileSync(path.join(work, 'u.txt'), 'u\n');
    i = await gitInfo(work, { fresh: true });
    assert.equal(i.unpushed, 1, '还没推过的分支按远端默认分支算');
    assert.equal(i.dirty, 1);
    git(work, 'checkout', '-q', '-b', 'tmp-main-check', 'main');
    assert.equal((await gitInfo(work, { fresh: true })).onBase, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('git 概况：基线 = worktree 切出时的分支（origin 上有才算）；整个分支都推过、还没开 PR 也算「有改动」', async () => {
  const { root, work, other } = fixture();
  try {
    // origin 上有 dev；功能分支从 dev 切出、提交并整体推送（有上游、ahead 0）
    git(other, 'checkout', '-q', '-b', 'dev'); writeFileSync(path.join(other, 'd.txt'), 'd\n'); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'dev'); git(other, 'push', '-q', 'origin', 'dev');
    git(work, 'fetch', '-q', 'origin');
    git(work, 'checkout', '-q', '-b', 'claude/from-dev', 'origin/dev');
    writeFileSync(path.join(work, 'f.txt'), 'f\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'f');
    git(work, 'push', '-q', '-u', 'origin', 'claude/from-dev');
    git(work, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    let i = await gitInfo(work, { fresh: true, base: 'dev' });
    assert.deepEqual([i.base, i.baseAhead, i.unpushed, i.pushed, i.onBase], ['dev', 1, 0, true, false]);
    // 不给候选 / 候选不在 origin 上 / 候选是提交号：退回远端默认分支（相对 main 多 2 个：dev 的 + 自己的）
    i = await gitInfo(work, { fresh: true, base: 'nope' });
    assert.deepEqual([i.base, i.baseAhead], ['main', 2]);
    assert.equal((await gitInfo(work, { fresh: true, base: 'abc1234' })).base, 'main');
    assert.equal((await gitInfo(work, { fresh: true })).base, 'main');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('同步基线：fetch 之后真要 merge 前再问一次，会话被人接着用了就收手（工作区不动）', async () => {
  const { root, work, other } = fixture();
  try {
    pushMain(other, 'a.txt', 'theirs\n');
    writeFileSync(path.join(work, 'a.txt'), 'mine\n'); git(work, 'commit', '-q', '-am', 'mine');
    const head = git(work, 'rev-parse', 'HEAD');
    const r = await syncBaseBranch(work, { base: 'main', beforeMerge: async () => 'session_running' });
    assert.deepEqual([r.kind, r.reason], ['refused', 'session_running']);
    assert.equal(git(work, 'rev-parse', 'HEAD'), head);
    assert.equal(git(work, 'status', '--porcelain'), '');
    const ok = await syncBaseBranch(work, { base: 'main', beforeMerge: () => '' });
    assert.equal(ok.kind, 'conflicts');
    await syncBaseBranch(work, { abort: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
