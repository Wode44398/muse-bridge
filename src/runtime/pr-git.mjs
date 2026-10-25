// PR 闭环要的本地 git 两件事：会话工作目录的分支 / 远端 / 推送状态（PR 卡「创建拉取请求」可不可点），
// 和「同步基线分支」——官方 Desktop 3.1623 的 ccd_host.sync_with_base_branch（主进程 syncSessionWithBaseBranch）。
//
// 官方在主机侧、沙箱之外执行（沙箱写不了 .claude/hooks 这类受保护路径），还要校验锁定的 origin、fork、
// 受保护文件只从默认分支引入……bridge 没有那层沙箱，简化成：工作区干净 → fetch origin <base> → merge，
// 冲突时停在合并进行中、列出冲突文件交给会话去解；什么都不推送。返回的 kind 与官方同构：
//   merged{fastForward, commit} / up_to_date / conflicts{files,total} / failed{stage,error} / refused{reason,…} / aborted
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseRemoteUrl } from './github.mjs';
import { gitInvocation } from './member-boundary.mjs';

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
const BRANCH_RE = /^(?!-)[\w./-]{1,200}$/;

// 成员目录里的仓库配置不可信：经 member-boundary 的 gitInvocation 加覆盖、剔凭据环境（主机自己的目录原样）
export function git(cwd, args, { timeout = 15_000 } = {}) {
  const inv = gitInvocation(cwd, ['-c', 'core.quotepath=false', ...args], GIT_ENV);
  return new Promise((resolve) => {
    execFile('git', inv.args, { cwd, env: inv.env, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err
        ? { ok: false, out: String(stdout ?? ''), err: String(stderr || err.message || err).trim(), code: typeof err.code === 'number' ? err.code : 1 }
        : { ok: true, out: String(stdout ?? ''), err: '', code: 0 });
    });
  });
}
const line = (r) => (r.ok ? r.out.trim() : '');
const lastLine = (s) => String(s || '').split(/\r?\n/).filter(Boolean).pop() || '';

/** origin 的默认分支名（refs/remotes/origin/HEAD 指向；没有就看本地有没有 main / master）。 */
export async function defaultBranchOf(cwd) {
  const sym = line(await git(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']));
  if (sym.startsWith('origin/')) return sym.slice(7);
  for (const b of ['main', 'master']) {
    if ((await git(cwd, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/' + b])).ok) return b;
  }
  return '';
}

// 这个检出配的全部 GitHub 远程（origin、fork 工作流里的 upstream……）→ [{host, repo}]，60 秒内同目录复用。
// 流里自动绑定 PR 前拿它核对「这个 PR 是不是本检出的仓库」——<pr-created> 标签与 CLI 报的链接都没经过核实。
const remotesCache = new Map();   // cwd → { at, list }
export async function remoteRepos(cwd) {
  if (!cwd) return [];
  const c = remotesCache.get(cwd);
  if (c && Date.now() - c.at < 60_000) return c.list;
  const r = await git(cwd, ['remote', '-v']);
  const seen = new Set();
  const list = [];
  for (const l of r.ok ? r.out.split(/\r?\n/) : []) {
    const u = parseRemoteUrl((l.split(/\s+/)[1]) || '');
    const k = u && (u.host + '/' + u.repo).toLowerCase();
    if (u && !seen.has(k)) { seen.add(k); list.push(u); }
  }
  remotesCache.set(cwd, { at: Date.now(), list });
  if (remotesCache.size > 100) remotesCache.delete(remotesCache.keys().next().value);
  return list;
}

const infoCache = new Map();   // cwd \n base → { at, v }
/**
 * 会话工作目录的 git 概况：{ git, branch, detached, upstream, ahead, behind, dirty, remote:{host,repo}|null,
 * defaultBranch, base, baseAhead, onBase, unpushed, pushed }。4 秒内同目录复用（PR 卡几秒拉一次也不会反复跑 git）。
 * opts.base：这个会话的基线候选（worktree 切出时的分支）。origin 上有它就以它为基线，否则用远端默认分支；
 * baseAhead = 相对 origin/<基线> 多出的提交数（「创建拉取请求」有没有可提交的改动看它，-1 = 算不出）。
 */
export async function gitInfo(cwd, { fresh = false, base = '' } = {}) {
  if (!cwd) return { git: false };
  const key = cwd + '\n' + (base || '');
  const c = infoCache.get(key);
  if (!fresh && c && Date.now() - c.at < 4000) return c.v;
  const v = await readInfo(cwd, base);
  infoCache.set(key, { at: Date.now(), v });
  if (infoCache.size > 100) infoCache.delete(infoCache.keys().next().value);
  return v;
}
export function forgetGitInfo(cwd) {
  if (!cwd) { infoCache.clear(); return; }
  for (const k of [...infoCache.keys()]) if (k === cwd || k.startsWith(cwd + '\n')) infoCache.delete(k);
}

async function readInfo(cwd, want = '') {
  const st = await git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
  if (!st.ok) return { git: false };
  let branch = '', upstream = '', ahead = 0, behind = 0, dirty = 0;
  for (const l of st.out.split(/\r?\n/)) {
    if (!l) continue;
    if (l.startsWith('# branch.head ')) branch = l.slice(14).trim();
    else if (l.startsWith('# branch.upstream ')) upstream = l.slice(18).trim();
    else if (l.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(l); if (m) { ahead = +m[1]; behind = +m[2]; } }
    else if (!l.startsWith('#')) dirty++;
  }
  const detached = !branch || branch === '(detached)';
  const remote = parseRemoteUrl(line(await git(cwd, ['remote', 'get-url', 'origin'])));
  const defaultBranch = remote ? await defaultBranchOf(cwd) : '';
  let unpushed = ahead, pushed = !!upstream;
  if (!upstream && !detached && remote) {
    // 没有上游：远端有同名分支就跟它比；没有就跟远端默认分支比（这个分支还没推过）
    if ((await git(cwd, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/' + branch])).ok) {
      pushed = true;
      unpushed = Number(line(await git(cwd, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`]))) || 0;
    } else if (defaultBranch) {
      unpushed = Number(line(await git(cwd, ['rev-list', '--count', `refs/remotes/origin/${defaultBranch}..HEAD`]))) || 0;
    }
  }
  // 基线：worktree 从哪个分支切的（origin 上有才算，PR 只能开到远端存在的分支上），否则远端默认分支
  let base = defaultBranch;
  if (remote && want && want !== 'HEAD' && BRANCH_RE.test(want) && !want.includes('..') && !/^[0-9a-f]{7,40}$/.test(want)
    && (await git(cwd, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/' + want])).ok) base = want;
  let baseAhead = -1;
  if (remote && base && !detached) {
    const n = await git(cwd, ['rev-list', '--count', `refs/remotes/origin/${base}..HEAD`]);
    if (n.ok) baseAhead = Number(n.out.trim()) || 0;
  }
  return {
    git: true, branch: detached ? '' : branch, detached, upstream, ahead, behind, dirty,
    remote, defaultBranch, base, baseAhead, onBase: !!branch && ((!!defaultBranch && branch === defaultBranch) || (!!base && branch === base)), unpushed, pushed,
  };
}

async function mergeInProgress(cwd) {
  return (await git(cwd, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'])).ok;
}
async function rebaseInProgress(cwd) {
  for (const p of ['rebase-merge', 'rebase-apply']) {
    const r = line(await git(cwd, ['rev-parse', '--git-path', p]));
    if (r && existsSync(path.resolve(cwd, r))) return true;
  }
  return false;
}

/**
 * 把 origin/<base> 合进 cwd 当前分支（主机侧，不推送）。
 * opts：base（必填，调用方已按「PR 的 base / worktree 切出时的分支 / 默认分支」选好）、abort（放弃进行中的合并）、
 * beforeMerge（fetch 完、真要 merge 之前再问一次：返回非空原因就不合，回 refused{reason}——后台 Auto-fix 用它在
 * fetch 那几十秒里会话被人接着用了的时候收手，别往正在干活的工作区里塞合并）。
 */
export async function syncBaseBranch(cwd, { base, abort = false, beforeMerge = null } = {}) {
  if (!(await git(cwd, ['rev-parse', '--is-inside-work-tree'])).ok) return { kind: 'refused', reason: 'no_worktree' };
  if (abort) {
    if (!(await mergeInProgress(cwd))) return { kind: 'refused', reason: 'no_merge_in_progress' };
    const r = await git(cwd, ['merge', '--abort']);
    return r.ok ? { kind: 'aborted' } : { kind: 'failed', stage: 'abort', error: lastLine(r.err) };
  }
  if (await mergeInProgress(cwd)) return { kind: 'refused', reason: 'operation_in_progress', detail: 'a merge' };
  if (await rebaseInProgress(cwd)) return { kind: 'refused', reason: 'operation_in_progress', detail: 'a rebase' };
  const branch = line(await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']));
  if (!branch) return { kind: 'refused', reason: 'detached_head' };
  if (!base) return { kind: 'refused', reason: 'no_base' };
  if (!BRANCH_RE.test(base) || base.includes('..')) return { kind: 'refused', reason: 'invalid_base' };
  if (base === branch) return { kind: 'refused', reason: 'base_not_allowed', detail: '当前就在基线分支上' };
  // porcelain 行首两列是状态（可能是空格），别 trim 整段
  const dirty = (await git(cwd, ['status', '--porcelain', '--untracked-files=no'])).out.split(/\r?\n/).filter((l) => l.trim());
  if (dirty.length) return { kind: 'refused', reason: 'uncommitted_changes', files: dirty.map((l) => l.slice(3)).slice(0, 20) };
  if (!(await git(cwd, ['remote', 'get-url', 'origin'])).ok) return { kind: 'refused', reason: 'origin_unavailable' };

  const f = await git(cwd, ['fetch', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { timeout: 120_000 });
  if (!f.ok) return { kind: 'failed', stage: 'fetch', error: lastLine(f.err) || 'git fetch 失败' };
  const target = `refs/remotes/origin/${base}`;
  if ((await git(cwd, ['merge-base', '--is-ancestor', target, 'HEAD'])).ok) return { kind: 'up_to_date', base };
  if (beforeMerge) { const why = await beforeMerge(); if (why) return { kind: 'refused', reason: String(why) }; }
  const fastForward = (await git(cwd, ['merge-base', '--is-ancestor', 'HEAD', target])).ok;
  const m = await git(cwd, ['merge', '--no-edit', '-m', `Merge origin/${base} into ${branch}`, target], { timeout: 120_000 });
  if (m.ok) return { kind: 'merged', base, fastForward, commit: line(await git(cwd, ['rev-parse', 'HEAD'])) };
  const u = line(await git(cwd, ['diff', '--name-only', '--diff-filter=U']));
  const files = u ? u.split(/\r?\n/).filter(Boolean) : [];
  if (files.length) return { kind: 'conflicts', base, files: files.slice(0, 50), total: files.length };
  // 不是冲突（未跟踪文件挡路、缺提交身份……）：撤回半截合并，原样报错
  if (await mergeInProgress(cwd)) await git(cwd, ['merge', '--abort']);
  return { kind: 'failed', stage: 'merge', error: lastLine(m.err || m.out) || 'git merge 失败' };
}
