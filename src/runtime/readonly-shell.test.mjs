import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readonlyCommandVerdict as v, shellWords, makeCoordinatorShellHook } from './readonly-shell.mjs';

const ok = (c) => { const r = v(c); assert.equal(r.ok, true, `${c} 应放行：${r.reason}`); return r.command; };
const no = (c, re) => { const r = v(c); assert.equal(r.ok, false, `${c} 应拦下`); if (re) assert.match(r.reason, re); };

test('拆词：成对引号、引号里的空格；引号外的控制符和通配一律拒', () => {
  assert.deepEqual(shellWords(`git log --grep="fix(api) x" -- 'src/*.mjs'`).words, ['git', 'log', '--grep=fix(api) x', '--', 'src/*.mjs']);
  assert.match(shellWords('git log "a').error, /双引号/);
  assert.match(shellWords('git log "$HOME"').error, /双引号里/);
  assert.match(shellWords('git status\nrm -rf x').error, /换行/);
});

test('git 只读查询放行，并补上 --no-optional-locks', () => {
  assert.equal(ok('git status'), 'git --no-optional-locks status');
  assert.equal(ok('git --no-optional-locks status -s'), 'git --no-optional-locks status -s');
  ok('git log --oneline -20 main..claude/foo-1a2b');
  ok('git diff main...claude/foo-1a2b --stat');
  ok('git -C C:/Users/x/repo/.claude/worktrees/foo diff');
  ok("git -C 'C:\\Users\\x\\repo' status");
  ok('git show HEAD~1 --stat');
  ok('git branch -a -vv');
  ok('git branch --merged main');
  ok("git branch --list 'claude/*'");
  ok('git tag -l');
  ok('git stash list');
  ok('git worktree list');
  ok('git remote -v');
  ok('git rev-parse --abbrev-ref HEAD');
  ok('git log --format=%h%x09%s -5');
});

test('git 有写副作用的一律拦', () => {
  no('git commit -m x', /不是只读/);
  no('git push origin main', /不是只读/);
  no('git checkout main', /不是只读/);
  no('git branch new-feature', /新建/);
  no('git branch -D old', /改动分支/);
  no('git tag v1.0', /新建/);
  no('git stash', /stash 只放行/);
  no('git stash pop', /stash 只放行/);
  no('git worktree add ../x', /worktree 只放行/);
  no('git remote add up https://x', /remote 只放行/);
  no('git reflog expire --all', /reflog/);
  no('git diff --output=x.patch', /写文件/);
  no('git grep -O foo', /拉起/);
  no('git -c core.pager=evil log', /全局选项/);
  no('git --exec-path=/x log', /全局选项/);
});

test('串联、管道、重定向、替换、通配、别的程序都拦', () => {
  no('git status; rm -rf .', /「;」/);
  no('git status && npm test', /「&」/);
  no('git log | head', /「\|」/);
  no('git diff > out.patch', /「>」/);
  no('git log $(whoami)', /「\$」/);
  no('git log `whoami`', /「`」/);
  no('git diff *', /「\*」/);
  no('npm test', /只放行 git \/ gh/);
  no('GIT_DIR=x git status', /只放行/);
  no('ls -la', /只放行/);
  no('git status # 注释', /「#」/);
});

test('gh 只认查看类', () => {
  ok('gh pr view 12 --json state,mergeable');
  ok('gh pr checks 12');
  ok('gh pr diff 12');
  ok('gh run view 123 --log-failed');
  ok('gh pr list --state open');
  no('gh pr merge 12', /不是查看类/);
  no('gh pr create --fill', /不是查看类/);
  no('gh api repos/x/y/pulls -X POST', /不放行/);
  no('gh pr view 12 --web', /浏览器/);
  no('gh pr checks 12 --watch', /挂着/);
  no('gh auth token', /不放行/);
});

test('钩子：只管协调者自己的 Bash，worker 照常；放行时直接允许并改写命令、不许挂后台，拦下时给原因', async () => {
  const h = makeCoordinatorShellHook();
  assert.deepEqual(await h({ tool_name: 'Bash', agent_id: 'w1', tool_input: { command: 'npm test' } }), { continue: true });
  assert.deepEqual(await h({ tool_name: 'Read', tool_input: { file_path: 'x' } }), { continue: true });
  const d = (await h({ tool_name: 'Bash', tool_input: { command: 'npm test' } })).hookSpecificOutput;
  assert.equal(d.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /没跑.*只能跑只读的 git \/ gh 查询/);
  const a = (await h({ tool_name: 'Bash', tool_input: { command: 'git status', description: '看状态', run_in_background: true } })).hookSpecificOutput;
  assert.equal(a.permissionDecision, 'allow');
  assert.deepEqual(a.updatedInput, { command: 'git --no-optional-locks status', description: '看状态', run_in_background: false });
});
