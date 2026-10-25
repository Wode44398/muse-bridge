// GitHub 读写（PR / CI 闭环用，2026-10-20 对齐官方 Claude Desktop 3.1623 的 GitHubPrManager）。
//
// 官方做法（主进程 index.chunk-DBbCcZ7x 的 gh 客户端 + C8dRKfaj 的 GitHubPrManager）：
//   · 令牌：`gh auth token --hostname <host>` 现取（子进程环境里删掉 GH_TOKEN 一类变量，免得拿到别的号），
//     gh 只用来出令牌；之后直接 HTTPS 调 REST / GraphQL，GET 带 ETag 条件请求（304 不扣额度）。
//   · gh 没装 / 没登录 / 限流 / 断网各有一句原因，界面照原因提示（见下方 REASONS）。
// bridge 照搬：令牌按 host 缓存 10 分钟（失败缓存 30 秒），限流时整体停到 reset 时刻，
// 读 PR 用一条 GraphQL 拿齐状态 + checks（官方是 REST 多条 + GraphQL 补字段，一条更省额度）。
//
// 只给主机本人用：令牌是这台电脑上 gh 登录的那个 GitHub 账号——沙箱用户、快照访客一律碰不到
//（门禁在 pr-monitor.mjs 的 prCapable 与路由里）。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { whichSync } from './which.mjs';

const TOKEN_TTL_MS = 10 * 60_000;
const TOKEN_FAIL_TTL_MS = 30_000;
const REQ_TIMEOUT_MS = 20_000;
const ETAG_MAX = 300;
const UA = 'claude-bridge';

// 不可用原因 → 给人看的中文（官方 bR/JEe 的五条）。前端按 reason 过 t()。
export const REASONS = {
  gh_not_installed: '未安装 GitHub CLI（gh）',
  gh_not_authenticated: '请运行 gh auth login 登录',
  rate_limited: '触发 GitHub 限流，正在自动重试',
  network: '无法连接 GitHub，请检查网络',
  unknown: '请确认 gh 已安装并已登录',
};

export class GhError extends Error {
  constructor(code, message, extra = {}) {
    super(message || REASONS[code] || code);
    this.code = code;
    Object.assign(this, extra);
  }
}

const apiBase = (host) => (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`);
const gqlUrl = (host) => (host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`);

// —— 可替换的底层（单测注入假的 gh 与 fetch）——
let runGh = defaultRunGh;
let doFetch = (...a) => fetch(...a);
export function _setGithubForTest({ gh, fetch: f } = {}) {
  if (gh) runGh = gh;
  if (f) doFetch = f;
  tokens.clear(); etags.clear(); blockedUntil = 0; budget.clear();
}

function ghPath() {
  const p = whichSync('gh');
  if (p) return p;
  const win = 'C:\\Program Files\\GitHub CLI\\gh.exe';   // 服务从计划任务拉起时 PATH 可能不全
  return process.platform === 'win32' && existsSync(win) ? win : null;
}

function defaultRunGh(args, { timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    const bin = ghPath();
    if (!bin) { resolve({ code: 'ENOENT', out: '', err: 'gh not found' }); return; }
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[k];
    execFile(bin, args, { env, timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') resolve({ code: 'ENOENT', out: '', err: String(err.message) });
      else resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

// —— 令牌 ——
const tokens = new Map();   // host → { token, at } | { error, at }
export async function ghToken(host = 'github.com') {
  const c = tokens.get(host);
  if (c && c.token && Date.now() - c.at < TOKEN_TTL_MS) return c.token;
  if (c && c.error && Date.now() - c.at < TOKEN_FAIL_TTL_MS) throw c.error;
  const r = await runGh(['auth', 'token', '--hostname', host]);
  const token = r.code === 0 ? r.out.trim() : '';
  if (!token) {
    const error = new GhError(r.code === 'ENOENT' ? 'gh_not_installed' : 'gh_not_authenticated');
    tokens.set(host, { error, at: Date.now() });
    throw error;
  }
  tokens.set(host, { token, at: Date.now() });
  return token;
}
export function forgetGhToken(host) { if (host) tokens.delete(host); else tokens.clear(); }

/** gh 是否可用（界面的不可用原因）：{ ok, reason? } */
export async function ghStatus(host = 'github.com') {
  try { await ghToken(host); } catch (e) { return { ok: false, reason: e.code || 'unknown' }; }
  if (Date.now() < blockedUntil) return { ok: true, limited: true, resetAt: blockedUntil };
  return { ok: true };
}

// —— 限流记账（按 x-ratelimit-resource 分 core / graphql）——
let blockedUntil = 0;
const budget = new Map();   // resource → { remaining, limit, reset }
export function ghBudget() {
  const out = {};
  for (const [k, v] of budget) out[k] = { ...v };
  return { blockedUntil, ...out };
}
function noteBudget(res) {
  const h = (k) => res.headers.get(k);
  const rem = h('x-ratelimit-remaining');
  if (rem == null) return;
  budget.set(h('x-ratelimit-resource') || 'core', { remaining: Number(rem), limit: Number(h('x-ratelimit-limit') || 0), reset: Number(h('x-ratelimit-reset') || 0) * 1000 });
}
function limitedError() {
  return new GhError('rate_limited', REASONS.rate_limited, { resetAt: blockedUntil });
}

const etags = new Map();    // url → { etag, data }

// 一次 HTTPS 请求。GET 带 ETag；401 作废令牌；403/429 + 额度耗尽 / retry-after → 整体停到 reset。
async function request(method, url, { host = 'github.com', body, accept } = {}) {
  if (Date.now() < blockedUntil) throw limitedError();
  const token = await ghToken(host);
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  };
  const cached = method === 'GET' ? etags.get(url) : null;
  if (cached) headers['If-None-Match'] = cached.etag;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await doFetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  } catch (e) {
    throw new GhError('network', REASONS.network, { detail: String(e && e.message || e) });
  }
  noteBudget(res);
  if (res.status === 304 && cached) return { status: 200, data: cached.data, cached: true };
  let data = null;
  const text = await res.text().catch(() => '');
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status === 401) { tokens.delete(host); throw new GhError('gh_not_authenticated', REASONS.gh_not_authenticated, { status: 401 }); }
  if (res.status === 403 || res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || 0);
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
    const msg = (data && data.message) || '';
    if (retryAfter || remaining === '0' || /rate limit/i.test(msg)) {
      blockedUntil = Math.max(Date.now() + 60_000, retryAfter ? Date.now() + retryAfter * 1000 : reset || 0);
      throw limitedError();
    }
  }
  if (res.status >= 400) {
    throw new GhError('http', (data && data.message) || ('GitHub ' + res.status), { status: res.status, data });
  }
  const etag = res.headers.get('etag');
  if (method === 'GET' && etag) {
    etags.delete(url);
    etags.set(url, { etag, data });
    if (etags.size > ETAG_MAX) etags.delete(etags.keys().next().value);
  }
  return { status: res.status, data };
}

export function rest(method, path, { host = 'github.com', body } = {}) {
  return request(method, apiBase(host) + path, { host, body });
}

export async function graphql(query, variables = {}, { host = 'github.com' } = {}) {
  const { data } = await request('POST', gqlUrl(host), { host, body: { query, variables } });
  if (data && Array.isArray(data.errors) && data.errors.length) {
    const e0 = data.errors[0] || {};
    if (e0.type === 'RATE_LIMITED') { blockedUntil = Math.max(blockedUntil, Date.now() + 60_000); throw limitedError(); }
    // 仓库 / PR 不存在（或令牌看不到私有仓库）：GraphQL 回 200 + errors[].type NOT_FOUND，归成 not_found 给人看中文
    if (e0.type === 'NOT_FOUND') throw new GhError('not_found', '找不到这个拉取请求', { errors: data.errors });
    throw new GhError('graphql', e0.message || 'GraphQL error', { errors: data.errors, data: data.data });
  }
  return (data && data.data) || {};
}

// —— 解析 ——
const PR_URL_RE = /https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s#?]+)\/pull\/(\d+)/;
/** https://github.com/o/r/pull/12 → { host, repo:'o/r', number, url }；认不出 → null */
export function parsePrUrl(s) {
  const m = PR_URL_RE.exec(String(s || ''));
  if (!m) return null;
  const repo = `${m[2]}/${m[3].replace(/\.git$/, '')}`;
  return { host: m[1].toLowerCase(), repo, number: Number(m[4]), url: `https://${m[1].toLowerCase()}/${repo}/pull/${m[4]}` };
}
/** 一段文字里出现的全部 PR 链接（去重、按出现顺序） */
export function findPrUrls(text) {
  const out = [], seen = new Set();
  const re = new RegExp(PR_URL_RE.source, 'g');
  for (const m of String(text || '').matchAll(re)) {
    const p = parsePrUrl(m[0]);
    if (p && !seen.has(p.url)) { seen.add(p.url); out.push(p); }
  }
  return out;
}
/** origin 地址 → { host, repo }（https / ssh / scp 式三种写法）；不是 GitHub 系 → null */
export function parseRemoteUrl(url) {
  const s = String(url || '').trim();
  let m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s)
    || /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s)
    || /^(?:[^@/]+@)?([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?$/.exec(s);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (!/github/.test(host)) return null;   // gitlab / bitbucket 等不在范围
  return { host, repo: `${m[2]}/${m[3]}` };
}

// —— PR 状态（一条 GraphQL 拿齐）——
const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    nameWithOwner autoMergeAllowed squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
    defaultBranchRef{ name }
    pullRequest(number:$number){
      id number url title state isDraft merged mergeable mergeStateStatus reviewDecision
      headRefName headRefOid baseRefName additions deletions updatedAt isInMergeQueue isMergeQueueEnabled
      autoMergeRequest{ enabledAt mergeMethod }
      commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state contexts(first:100){ nodes{
        __typename
        ... on CheckRun{ databaseId name status conclusion detailsUrl checkSuite{ app{ slug } workflowRun{ databaseId workflow{ name } } } }
        ... on StatusContext{ context state targetUrl }
      } } } } } }
    }
  }
}`;

// 单条 check 归桶（与 `gh pr checks` 的 bucket 同口径：pass / fail / pending / skipping / cancel）
export function bucketOf(node) {
  if (!node) return 'pending';
  if (node.__typename === 'StatusContext') {
    const s = String(node.state || '').toUpperCase();
    return s === 'SUCCESS' ? 'pass' : s === 'FAILURE' || s === 'ERROR' ? 'fail' : 'pending';
  }
  if (String(node.status || '').toUpperCase() !== 'COMPLETED') return 'pending';
  switch (String(node.conclusion || '').toUpperCase()) {
    case 'SUCCESS': return 'pass';
    case 'NEUTRAL': case 'SKIPPED': case 'STALE': return 'skipping';
    case 'CANCELLED': return 'cancel';
    case 'FAILURE': case 'TIMED_OUT': case 'ACTION_REQUIRED': case 'STARTUP_FAILURE': return 'fail';
    default: return 'pending';
  }
}

// checks 汇总（官方 $p()：skipped = skipping + cancel；failingChecks 最多 15 个名字）
export function summarizeChecks(list) {
  const n = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
  for (const c of list) n[c.bucket] = (n[c.bucket] || 0) + 1;
  const total = list.length;
  const ci = !total ? 'none' : n.fail ? 'fail' : n.pending ? 'pending' : n.pass ? 'pass' : 'skipped';
  return {
    available: true, total, passing: n.pass, failing: n.fail, pending: n.pending, skipped: n.skipping + n.cancel, ci,
    failingChecks: list.filter((c) => c.bucket === 'fail').map((c) => c.name).slice(0, 15),
  };
}

// GraphQL 回包 → 前端 / 总线 / 工具共用的 PrView
export function normalizePr(ref, repoNode) {
  const p = repoNode && repoNode.pullRequest;
  if (!p) return null;
  const commit = p.commits && p.commits.nodes && p.commits.nodes[0] && p.commits.nodes[0].commit;
  const nodes = (commit && commit.statusCheckRollup && commit.statusCheckRollup.contexts && commit.statusCheckRollup.contexts.nodes) || [];
  const list = nodes.map((c) => c.__typename === 'StatusContext'
    ? { name: String(c.context || ''), bucket: bucketOf(c), url: c.targetUrl || '', workflow: '', kind: 'status' }
    : {
      name: String(c.name || ''), bucket: bucketOf(c), url: c.detailsUrl || '',
      workflow: (c.checkSuite && c.checkSuite.workflowRun && c.checkSuite.workflowRun.workflow && c.checkSuite.workflowRun.workflow.name) || '',
      runId: (c.checkSuite && c.checkSuite.workflowRun && c.checkSuite.workflowRun.databaseId) || null,
      checkRunId: c.databaseId || null,
      app: (c.checkSuite && c.checkSuite.app && c.checkSuite.app.slug) || '',
      kind: 'check',
    });
  const raw = String(p.state || '').toUpperCase();
  const state = p.merged || raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : p.isInMergeQueue ? 'queued' : p.isDraft ? 'draft' : 'open';
  return {
    host: ref.host, repo: repoNode.nameWithOwner || ref.repo, number: p.number, url: p.url, title: p.title || '',
    state, isDraft: !!p.isDraft, head: p.headRefName || '', base: p.baseRefName || '', headSha: p.headRefOid || '',
    additions: p.additions || 0, deletions: p.deletions || 0,
    mergeable: p.mergeable || 'UNKNOWN', mergeStateStatus: p.mergeStateStatus || 'UNKNOWN', reviewDecision: p.reviewDecision || '',
    autoMerge: p.autoMergeRequest ? { enabled: true, method: String(p.autoMergeRequest.mergeMethod || 'SQUASH').toLowerCase(), by: 'github' } : null,
    mergeQueue: { enabled: !!p.isMergeQueueEnabled, queued: !!p.isInMergeQueue },
    checks: summarizeChecks(list), checkList: list,
    repoInfo: {
      autoMergeAllowed: !!repoNode.autoMergeAllowed, squash: repoNode.squashMergeAllowed !== false, merge: repoNode.mergeCommitAllowed !== false,
      rebase: repoNode.rebaseMergeAllowed !== false, defaultBranch: (repoNode.defaultBranchRef && repoNode.defaultBranchRef.name) || '',
    },
    nodeId: p.id, updatedAt: p.updatedAt || '', readAt: Date.now(),
  };
}

const splitRepo = (repo) => { const [owner, name] = String(repo).split('/'); return { owner, name }; };

/** 读一个 PR 的完整状态（不缓存；缓存在 pr-monitor）。PR 不存在 → GhError('not_found') */
export async function fetchPr(ref) {
  const d = await graphql(PR_QUERY, { ...splitRepo(ref.repo), number: Number(ref.number) }, { host: ref.host });
  const v = normalizePr(ref, d.repository);
  if (!v) throw new GhError('not_found', '找不到这个拉取请求');
  return v;
}

/** 分支上开着的 PR（会话 cwd 在功能分支上、还没绑定时反查用）。没有 → null */
export async function findOpenPrForBranch({ host, repo }, branch) {
  const q = `query($owner:String!,$name:String!,$head:String!){ repository(owner:$owner,name:$name){ pullRequests(headRefName:$head, states:[OPEN], first:1, orderBy:{field:CREATED_AT,direction:DESC}){ nodes{ number url } } } }`;
  const d = await graphql(q, { ...splitRepo(repo), head: branch }, { host });
  const n = d.repository && d.repository.pullRequests && d.repository.pullRequests.nodes && d.repository.pullRequests.nodes[0];
  return n ? { host, repo, number: n.number, url: n.url } : null;
}

// —— 写操作 ——
const METHODS = new Set(['squash', 'merge', 'rebase']);
export const normMethod = (m) => (METHODS.has(String(m || '').toLowerCase()) ? String(m).toLowerCase() : 'squash');

/** 合并（REST PUT …/merge，带 sha 防止合进没见过的提交）。分支走合并队列（405 + 队列开着）→ 改为入队。 */
export async function mergePr(pr, { method = 'squash', sha } = {}) {
  try {
    const { data } = await rest('PUT', `/repos/${pr.repo}/pulls/${pr.number}/merge`, { host: pr.host, body: { merge_method: normMethod(method), ...(sha ? { sha } : {}) } });
    return { merged: true, sha: data && data.sha };
  } catch (e) {
    if (e.code === 'http' && e.status === 405 && pr.mergeQueue && pr.mergeQueue.enabled && pr.nodeId) {
      await graphql('mutation($id:ID!,$oid:GitObjectID){ enqueuePullRequest(input:{pullRequestId:$id, expectedHeadOid:$oid}){ clientMutationId } }', { id: pr.nodeId, oid: sha || null }, { host: pr.host });
      return { merged: false, queued: true };
    }
    throw e;
  }
}
export function markReady(pr) {
  return graphql('mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest{ isDraft } } }', { id: pr.nodeId }, { host: pr.host });
}
export function convertToDraft(pr) {
  return graphql('mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ pullRequest{ isDraft } } }', { id: pr.nodeId }, { host: pr.host });
}
export function enableAutoMerge(pr, method = 'squash') {
  return graphql('mutation($id:ID!,$m:PullRequestMergeMethod!){ enablePullRequestAutoMerge(input:{pullRequestId:$id, mergeMethod:$m}){ clientMutationId } }', { id: pr.nodeId, m: normMethod(method).toUpperCase() }, { host: pr.host });
}
export function disableAutoMerge(pr) {
  return graphql('mutation($id:ID!){ disablePullRequestAutoMerge(input:{pullRequestId:$id}){ clientMutationId } }', { id: pr.nodeId }, { host: pr.host });
}

/** 重跑失败的 checks：GitHub Actions 的按 workflow run 重跑失败的 job；别的 app 出的 check 从这里重跑不了。 */
export async function rerunFailedChecks(pr) {
  const failed = (pr.checkList || []).filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  const runs = [...new Set(failed.map((c) => c.runId).filter(Boolean))];
  let rerun = 0;
  const errors = [];
  for (const id of runs) {
    try { await rest('POST', `/repos/${pr.repo}/actions/runs/${id}/rerun-failed-jobs`, { host: pr.host, body: {} }); rerun++; }
    catch (e) { errors.push(e.message); }
  }
  return { rerun, skipped: failed.filter((c) => !c.runId).length, errors };
}

// —— Auto-fix 要的评论（未解决的行内评审线程 + 评审摘要 + 普通评论）与当前 gh 登录名 ——
const COMMENTS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(last:50){ nodes{ isResolved comments(last:20){ nodes{ databaseId body path line originalLine createdAt authorAssociation author{ login __typename } } } } }
    reviews(last:30){ nodes{ databaseId state body createdAt authorAssociation author{ login __typename } } }
    comments(last:50){ nodes{ databaseId body createdAt authorAssociation author{ login __typename } } }
  } }
  viewer{ login }
}`;
export async function fetchPrComments(ref) {
  const d = await graphql(COMMENTS_QUERY, { ...splitRepo(ref.repo), number: Number(ref.number) }, { host: ref.host });
  const p = d.repository && d.repository.pullRequest;
  const viewer = (d.viewer && d.viewer.login) || '';
  const out = [];
  const who = (a) => ({ login: (a && a.login) || 'ghost', bot: !!(a && a.__typename === 'Bot') });
  if (p) {
    for (const t of (p.reviewThreads && p.reviewThreads.nodes) || []) {
      if (t.isResolved) continue;
      for (const c of (t.comments && t.comments.nodes) || []) {
        out.push({ kind: 'inline', id: c.databaseId, dedup: String(c.databaseId), author: who(c.author), assoc: c.authorAssociation || '', path: c.path || '', line: c.line || c.originalLine || 0, body: c.body || '', at: c.createdAt });
      }
    }
    for (const r of (p.reviews && p.reviews.nodes) || []) {
      if (!r.body || !/^(CHANGES_REQUESTED|COMMENTED)$/.test(r.state || '')) continue;
      out.push({ kind: 'review', id: r.databaseId, dedup: 'r' + r.databaseId, state: r.state, author: who(r.author), assoc: r.authorAssociation || '', body: r.body, at: r.createdAt });
    }
    for (const c of (p.comments && p.comments.nodes) || []) {
      out.push({ kind: 'issue', id: c.databaseId, dedup: 'i' + c.databaseId, author: who(c.author), assoc: c.authorAssociation || '', body: c.body || '', at: c.createdAt });
    }
  }
  return { viewer, comments: out };
}
