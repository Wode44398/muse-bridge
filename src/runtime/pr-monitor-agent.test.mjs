// 别的 agent（dimensio）的会话进 pr-monitor：会话键 'dimensio:<id>'、工作目录与偏好由实例带来、轮末报上来的 PR 要核对仓库、
// 自动修复走登记的 deliver（busy 不算失败、gone 清台账）、署名换成 dimensio、真人发话清零连续计数、成员实例拿不到；
// 以及内部路由 /api/internal/agent-pr 的凭据（同机实例凭据 + 本机直连）与身份隔离。
// GitHub 全是假的；git 用临时仓库（origin 只是个地址）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const data = mkdtempSync(path.join(tmpdir(), 'pr-agent-'));
process.env.BRIDGE_DATA_ROOT = data;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
const gh = await import('./github.mjs');
const PM = await import('./pr-monitor.mjs');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, windowsHide: true }).toString().trim();
const work = path.join(data, 'work');
mkdirSync(work);
git(work, 'init', '-q', '-b', 'main');
writeFileSync(path.join(work, 'a.txt'), 'a\n');
git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'init');
git(work, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
git(work, 'checkout', '-q', '-b', 'dimensio/feat');

const ctx = { kind: 'admin', sandbox: false, shell: true, key: 'admin', cwd: work, dataDir: data, configDir: path.join(data, '.cfg'), claudeProjects: path.join(data, 'claude-projects.json') };
const raw = (n) => `0000000${n}-0000-4000-8000-0000000000aa`;
const dsid = (n) => 'dimensio:' + raw(n);
const url = (n) => 'https://github.com/o/r/pull/' + n;

// —— 假 GitHub ——
const prs = {};
function setPr(n, o = {}) { prs[n] = { state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', head: 'dimensio/feat', base: 'main', sha: 'h1', checks: [], ...(prs[n] || {}), ...o }; }
const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
gh._setGithubForTest({
  gh: async () => ({ code: 0, out: 'FAKE_TOKEN', err: '' }),
  fetch: async (u, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.endsWith('/graphql')) {
      if (body.query.includes('reviewThreads')) return res(200, { data: { viewer: { login: 'me' }, repository: { pullRequest: { reviewThreads: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] } } } } });
      const n = body.variables.number;
      const p = prs[n];
      if (!p) return res(200, { errors: [{ type: 'NOT_FOUND', message: 'nope' }] });
      return res(200, { data: { repository: {
        nameWithOwner: 'o/r', autoMergeAllowed: false, squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, defaultBranchRef: { name: 'main' },
        pullRequest: {
          id: 'PR_' + n, number: n, url: url(n), title: 'PR ' + n, state: p.state, isDraft: false, merged: false,
          mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus, reviewDecision: null, headRefName: p.head, headRefOid: p.sha, baseRefName: p.base,
          additions: 1, deletions: 0, updatedAt: '', isInMergeQueue: false, isMergeQueueEnabled: false, autoMergeRequest: null,
          commits: { nodes: [{ commit: { oid: p.sha, statusCheckRollup: { state: 'X', contexts: { nodes: p.checks.map(([name, b]) => ({
            __typename: 'CheckRun', databaseId: 1, name, status: 'COMPLETED', conclusion: b === 'fail' ? 'FAILURE' : 'SUCCESS', detailsUrl: '',
            checkSuite: { app: { slug: 'github-actions' }, workflowRun: { databaseId: 5, workflow: { name: 'CI' } } },
          })) } } } }] },
        },
      } } });
    }
    return res(404, { message: 'nope' });
  },
});

// —— 假 dimensio 实例的叫醒口 ——
const woken = [];
let nextReply = { ok: true };
PM.registerPrAgent('dimensio', { deliver: async (c, sessionId, text) => { woken.push({ key: c.key, sessionId, text }); return nextReply; } });
const note = (id, prefs = { autoFix: true, attribution: true }) => PM.noteAgentSession(ctx, id, { cwd: work, prefs });
const wakeAgain = (id) => { PM._slot(ctx, id).fix.lastWakeAt = 0; };

test('会话键：dimensio:<id> 是合法会话，Claude 的门禁（主机本人）照样管；成员拿不到', async () => {
  assert.equal(PM.agentOfSid(dsid(1)), 'dimensio');
  assert.equal(PM.agentOfSid(raw(1)), '');
  assert.equal(PM.agentOfSid('dimensio:../x'), '');
  const member = { ...ctx, kind: 'user', key: 'u:bob', sandbox: false };
  assert.deepEqual(await PM.prView(member, dsid(1)), { available: false, reason: 'host_only' });
  await assert.rejects(PM.prOp(member, dsid(1), 'bind', { url: url(1) }), (e) => e.status === 403);
  assert.deepEqual(await PM.bindReported(member, dsid(1), url(1)), { outcome: 'failed' });
});

test('轮末报上来的 PR：仓库是工作区的远程才绑（own、source tag/gh）；别人仓库的链接不绑', async () => {
  const id = dsid(2);
  note(id);
  setPr(20);
  assert.deepEqual(await PM.bindReported(ctx, id, url(20), { source: 'gh' }), { outcome: 'bound' });
  assert.deepEqual(await PM.bindReported(ctx, id, 'https://github.com/evil/x/pull/1', { source: 'tag' }), { outcome: 'untrusted' });
  const b = PM.boundPrs(ctx, id);
  assert.equal(b.length, 1);
  assert.equal(b[0].own, true);
  assert.equal(b[0].source, 'gh');
  const s = PM._slot(ctx, id);
  assert.equal(s.agent, 'dimensio');
  assert.deepEqual(s.where, { path: work });
  assert.equal(s.replay, null, '别的 agent 的会话不存重放身份');
  // 视图：git 概况按实例带来的工作目录
  const v = await PM.prView(ctx, id);
  assert.equal(v.available, true);
  assert.equal(v.git.branch, 'dimensio/feat');
  assert.equal(v.git.github, true);
  assert.equal(v.prs[0].number, 20);
  assert.equal(v.monitor.autoFixDefault, true, '默认值按实例带来的偏好');
  assert.equal(v.prs[0].autoFix, true);
});

test('自动修复：CI 失败经登记的 deliver 推给 dimensio（会话 id 不带前缀、dimensio 署名）；busy 不算失败；连续 5 次后暂停、真人发话解除', async () => {
  const id = dsid(3);
  note(id);
  setPr(30, { checks: [['build', 'fail']] });
  await PM.bindReported(ctx, id, url(30), { source: 'tag' });
  woken.length = 0;
  nextReply = { ok: false, busy: true, reason: 'session is busy' };
  await PM._sweepForTest(ctx, id);
  assert.equal(woken.length, 1);
  assert.equal(PM._slot(ctx, id).fix.failN, 0, '撞上在跑的一轮不算失败');
  assert.equal(PM._slot(ctx, id).fix.wakes, 0);
  nextReply = { ok: true };
  wakeAgain(id);
  await PM._sweepForTest(ctx, id);
  assert.equal(woken.length, 2);
  assert.equal(woken[1].sessionId, raw(3));
  assert.match(woken[1].text, /^<ci-monitor-event>[\s\S]*<\/ci-monitor-event>$/);
  assert.match(woken[1].text, /> "build"/);
  assert.equal(PM._slot(ctx, id).fix.wakes, 1);
  for (let i = 2; i <= 6; i++) {
    setPr(30, { sha: 'h' + i });
    wakeAgain(id);
    await PM.prOp(ctx, id, 'refresh');
    await PM._sweepForTest(ctx, id);
  }
  assert.equal(PM._slot(ctx, id).fix.paused, 'streak');
  assert.equal(woken.length, 6);
  PM.notePrTurnStart(ctx, id);
  assert.equal(PM._slot(ctx, id).fix.paused, '');
});

test('自动修复：偏好关着、会话自己建的 PR 也不叫醒；PR 卡上单独打开就叫醒；评论署名换成 dimensio、不署名时不带', async () => {
  const id = dsid(4);
  note(id, { autoFix: false, attribution: false });
  setPr(40, { checks: [['lint', 'fail']] });
  await PM.bindReported(ctx, id, url(40), { source: 'tag' });
  woken.length = 0;
  await PM._sweepForTest(ctx, id);
  assert.equal(woken.length, 0);
  await PM.prOp(ctx, id, 'monitor', { autoFix: true });
  await PM._sweepForTest(ctx, id);
  assert.equal(woken.length, 1);
  const { composeCiEvent } = await import('./pr-messages.mjs');
  const pr = { repo: 'o/r', number: 1, headSha: 'h', base: 'main' };
  const c = [{ kind: 'issue', id: 1, author: { login: 'x' }, body: 'fix' }];
  assert.match(composeCiEvent({ pr, comments: c, agent: 'dimensio' }), /Addressed by dimensio/);
  assert.doesNotMatch(composeCiEvent({ pr, comments: c, agent: 'dimensio', attribution: false }), /Addressed by/);
  assert.match(composeCiEvent({ pr, comments: c }), /Claude Code/);
});

test('自动修复：dimensio 说会话没了（gone）→ 台账清掉，不再读 GitHub', async () => {
  const id = dsid(5);
  note(id);
  setPr(50, { checks: [['build', 'fail']] });
  await PM.bindReported(ctx, id, url(50), { source: 'tag' });
  nextReply = { ok: false, gone: true, reason: '会话已不存在' };
  await PM._sweepForTest(ctx, id);
  nextReply = { ok: true };
  assert.equal(PM._slot(ctx, id), null);
});

test('没登记叫醒口的 agent：不叫醒（no_agent），也不算失败', async () => {
  const id = 'codex:' + raw(6);
  PM.noteAgentSession(ctx, id, { cwd: work, prefs: { autoFix: true } });
  setPr(60, { checks: [['build', 'fail']] });
  await PM.bindReported(ctx, id, url(60), { source: 'tag' });
  await PM._sweepForTest(ctx, id);
  assert.equal(PM._slot(ctx, id).fix.failN, 0);
  assert.equal(PM._slot(ctx, id).fix.wakes, 0);
});

test('落盘：台账条目带 agent / where / prefs，重读后照常认（重启后扫描要用）', async () => {
  const id = dsid(2);
  const before = PM._slot(ctx, id);
  PM._resetPrMonitor();
  const after = PM._slot(ctx, id);
  assert.equal(after.agent, 'dimensio');
  assert.deepEqual(after.where, before.where);
  assert.deepEqual(after.prefs, { autoFix: true, attribution: true });
  assert.equal(after.prs[0].number, 20);
});

// —— 内部路由 ——
test('路由 /api/internal/agent-pr：只认同机实例凭据 + 本机直连；会话键加 dimensio: 前缀；合并不开放', async () => {
  const { ensureHostSecret } = await import('./host-secret.mjs');
  const { registerAgentPrRoutes } = await import('../routes/agent-pr.mjs');
  const routes = {};
  registerAgentPrRoutes({ on: (m, p, fn) => { routes[m + ' ' + p] = fn; } });
  const h = routes['POST /api/internal/agent-pr'];
  const call = (body, { tok = ensureHostSecret(), addr = '127.0.0.1', headers = {} } = {}) => new Promise((resolve) => {
    const chunks = [Buffer.from(JSON.stringify(body))];
    const req = {
      headers: { authorization: 'Bearer ' + tok, 'x-bridge-agent': 'dimensio', ...headers }, socket: { remoteAddress: addr },
      on(ev, fn) { if (ev === 'data') { for (const c of chunks) fn(c); } if (ev === 'end') fn(); return this; },
      [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; },
    };
    let status = 0;
    const resp = { headersSent: false, writeHead(s) { status = s; this.headersSent = true; }, end(t) { resolve({ status, body: JSON.parse(t) }); } };
    h(req, resp);
  });
  assert.equal((await call({ session: raw(7), op: 'view' }, { tok: 'FAKE_TOKEN_NOT_A_SECRET_123' })).status, 404, '别的凭据当不存在');
  assert.equal((await call({ session: raw(7), op: 'view' }, { addr: '10.0.0.5' })).status, 404, '不是本机直连');
  assert.equal((await call({ session: raw(7), op: 'view' }, { headers: { 'x-bridge-agent': 'codex' } })).status, 403, '只给 dimensio');
  assert.equal((await call({ session: '../x', op: 'view' })).status, 400);
  assert.equal((await call({ session: raw(7), op: 'merge' })).status, 400, '合并不开放');
  setPr(70);
  const r = await call({ session: raw(7), op: 'reported', url: url(70), source: 'tag', cwd: work, prefs: { autoFix: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.outcome, 'bound');
  assert.equal(PM.boundPrs(ctx, dsid(7)).length, 1, '台账里是 dimensio:<id>');
  const st = await call({ session: raw(7), op: 'status', cwd: work });
  assert.equal(st.body.result.bound, true);
  assert.equal(st.body.result.pr.number, 70);
});
