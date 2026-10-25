// GitHub 读写层（github.mjs）：解析、checks 归桶与汇总、令牌不可用原因、ETag 304、限流整体停摆、PR 状态归一。
// gh 与 fetch 全部换成假的，不碰真实 GitHub。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as gh from './github.mjs';

const res = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('解析 PR 链接 / origin 地址', () => {
  assert.deepEqual(gh.parsePrUrl('见 https://github.com/Wode44398/muse-bridge/pull/3#issuecomment-1'), { host: 'github.com', repo: 'Wode44398/muse-bridge', number: 3, url: 'https://github.com/Wode44398/muse-bridge/pull/3' });
  assert.equal(gh.parsePrUrl('https://github.com/o/r/issues/3'), null);
  assert.deepEqual(gh.findPrUrls('a https://github.com/o/r/pull/1 b https://github.com/o/r/pull/2 c https://github.com/o/r/pull/1').map((p) => p.number), [1, 2]);
  assert.deepEqual(gh.parseRemoteUrl('https://github.com/Wode44398/claude-bridge.git'), { host: 'github.com', repo: 'Wode44398/claude-bridge' });
  assert.deepEqual(gh.parseRemoteUrl('git@github.com:o/r.git'), { host: 'github.com', repo: 'o/r' });
  assert.deepEqual(gh.parseRemoteUrl('ssh://git@github.example.com:22/o/r'), { host: 'github.example.com', repo: 'o/r' });
  assert.equal(gh.parseRemoteUrl('https://gitlab.com/o/r.git'), null);
});

test('checks 归桶与 gh pr checks 同口径；汇总 skipped = skipping + cancel', () => {
  const cr = (status, conclusion) => ({ __typename: 'CheckRun', status, conclusion });
  assert.equal(gh.bucketOf(cr('IN_PROGRESS', null)), 'pending');
  assert.equal(gh.bucketOf(cr('COMPLETED', 'SUCCESS')), 'pass');
  assert.equal(gh.bucketOf(cr('COMPLETED', 'FAILURE')), 'fail');
  assert.equal(gh.bucketOf(cr('COMPLETED', 'TIMED_OUT')), 'fail');
  assert.equal(gh.bucketOf(cr('COMPLETED', 'CANCELLED')), 'cancel');
  assert.equal(gh.bucketOf(cr('COMPLETED', 'SKIPPED')), 'skipping');
  assert.equal(gh.bucketOf({ __typename: 'StatusContext', state: 'ERROR' }), 'fail');
  assert.equal(gh.bucketOf({ __typename: 'StatusContext', state: 'PENDING' }), 'pending');
  const s = gh.summarizeChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'fail' }, { name: 'c', bucket: 'cancel' }, { name: 'd', bucket: 'skipping' }, { name: 'e', bucket: 'pending' }]);
  assert.deepEqual({ total: s.total, passing: s.passing, failing: s.failing, pending: s.pending, skipped: s.skipped, ci: s.ci, failingChecks: s.failingChecks }, { total: 5, passing: 1, failing: 1, pending: 1, skipped: 2, ci: 'fail', failingChecks: ['b'] });
  assert.equal(gh.summarizeChecks([]).ci, 'none');
});

test('令牌：gh 没装 / 没登录各给原因；成功的令牌缓存复用', async () => {
  gh._setGithubForTest({ gh: async () => ({ code: 'ENOENT', out: '', err: '' }) });
  assert.deepEqual(await gh.ghStatus(), { ok: false, reason: 'gh_not_installed' });
  gh._setGithubForTest({ gh: async () => ({ code: 1, out: '', err: 'not logged in' }) });
  assert.deepEqual(await gh.ghStatus(), { ok: false, reason: 'gh_not_authenticated' });
  let calls = 0;
  gh._setGithubForTest({ gh: async (args) => { calls++; assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']); return { code: 0, out: 'gho_x\n', err: '' }; } });
  assert.equal(await gh.ghToken(), 'gho_x');
  assert.equal(await gh.ghToken(), 'gho_x');
  assert.equal(calls, 1);
});

test('REST GET 带 ETag：304 回缓存；限流后整体停摆、ghStatus 报 limited', async () => {
  const seen = [];
  let n = 0;
  gh._setGithubForTest({
    gh: async () => ({ code: 0, out: 'tok', err: '' }),
    fetch: async (url, opts) => {
      seen.push(opts.headers);
      n++;
      if (n === 1) return res(200, { a: 1 }, { etag: 'W/"1"', 'x-ratelimit-remaining': '4999', 'x-ratelimit-resource': 'core' });
      if (n === 2) return new Response(null, { status: 304 });
      return res(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) });
    },
  });
  assert.deepEqual((await gh.rest('GET', '/repos/o/r')).data, { a: 1 });
  assert.equal(seen[0].Authorization, 'Bearer tok');
  const r2 = await gh.rest('GET', '/repos/o/r');
  assert.equal(seen[1]['If-None-Match'], 'W/"1"');
  assert.deepEqual(r2.data, { a: 1 });
  await assert.rejects(gh.rest('GET', '/repos/o/r/pulls'), (e) => e.code === 'rate_limited');
  // 停摆期间不再发请求
  await assert.rejects(gh.rest('GET', '/x'), (e) => e.code === 'rate_limited');
  assert.equal(n, 3);
  const st = await gh.ghStatus();
  assert.equal(st.ok, true);
  assert.equal(st.limited, true);
});

test('PR 状态一条 GraphQL 归一：草稿 / 已合并 / checks 列表与仓库合并设置', async () => {
  const repoNode = {
    nameWithOwner: 'o/r', autoMergeAllowed: false, squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true, defaultBranchRef: { name: 'main' },
    pullRequest: {
      id: 'PR_1', number: 7, url: 'https://github.com/o/r/pull/7', title: 't', state: 'OPEN', isDraft: true, merged: false, mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT',
      reviewDecision: null, headRefName: 'claude/x', headRefOid: 'abc', baseRefName: 'main', additions: 3, deletions: 1, updatedAt: 'z', isInMergeQueue: false, isMergeQueueEnabled: false,
      autoMergeRequest: null,
      commits: { nodes: [{ commit: { oid: 'abc', statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
        { __typename: 'CheckRun', databaseId: 11, name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u', checkSuite: { app: { slug: 'github-actions' }, workflowRun: { databaseId: 99, workflow: { name: 'CI' } } } },
        { __typename: 'StatusContext', context: 'deploy', state: 'SUCCESS', targetUrl: 'v' },
      ] } } } }] },
    },
  };
  const v = gh.normalizePr({ host: 'github.com', repo: 'o/r', number: 7 }, repoNode);
  assert.equal(v.state, 'draft');
  assert.equal(v.checks.failing, 1);
  assert.equal(v.checks.passing, 1);
  assert.deepEqual(v.checkList.map((c) => [c.name, c.bucket, c.runId || null]), [['build', 'fail', 99], ['deploy', 'pass', null]]);
  assert.deepEqual(v.repoInfo, { autoMergeAllowed: false, squash: true, merge: false, rebase: true, defaultBranch: 'main' });
  repoNode.pullRequest.state = 'MERGED'; repoNode.pullRequest.merged = true;
  assert.equal(gh.normalizePr({ host: 'github.com', repo: 'o/r', number: 7 }, repoNode).state, 'merged');
  assert.equal(gh.normalizePr({ host: 'github.com', repo: 'o/r', number: 7 }, { pullRequest: null }), null);
});

test('合并：PUT …/merge 带 sha 与方式；405 + 合并队列 → 入队', async () => {
  const calls = [];
  gh._setGithubForTest({
    gh: async () => ({ code: 0, out: 'tok', err: '' }),
    fetch: async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body && JSON.parse(opts.body) });
      if (url.endsWith('/merge')) return calls.length === 1 ? res(200, { sha: 'm1', merged: true }) : res(405, { message: 'Pull request is in a merge queue' });
      return res(200, { data: { enqueuePullRequest: { clientMutationId: null } } });
    },
  });
  const pr = { host: 'github.com', repo: 'o/r', number: 7, nodeId: 'PR_1', mergeQueue: { enabled: true } };
  assert.deepEqual(await gh.mergePr(pr, { method: 'REBASE', sha: 'abc' }), { merged: true, sha: 'm1' });
  assert.deepEqual(calls[0], { url: 'https://api.github.com/repos/o/r/pulls/7/merge', method: 'PUT', body: { merge_method: 'rebase', sha: 'abc' } });
  assert.deepEqual(await gh.mergePr(pr, { sha: 'abc' }), { merged: false, queued: true });
  assert.equal(calls[1].body.merge_method, 'squash', '默认 squash');
  assert.match(calls[2].body.query, /enqueuePullRequest/);
  assert.equal(calls[2].url, 'https://api.github.com/graphql');
});

test('GraphQL 的 NOT_FOUND（PR 号不存在 / 看不到的私有仓库）归成 not_found', async () => {
  gh._setGithubForTest({
    gh: async () => ({ code: 0, out: 'tok', err: '' }),
    fetch: async () => res(200, { data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'Could not resolve to a PullRequest with the number of 99999.' }] }),
  });
  await assert.rejects(gh.fetchPr({ host: 'github.com', repo: 'o/r', number: 99999 }), (e) => e.code === 'not_found' && e.message === '找不到这个拉取请求');
});
