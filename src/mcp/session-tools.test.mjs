// 「Claude 发起新会话」三档（session-tools.mjs）：直接调 MCP 工具的处理函数，假的重放口代替真的 /api/chat。
//   ask：offer 卡阻塞等用户选（新会话 → 补任务说明再开 / 在这里做 / 不再询问 / 用户发了新消息）；own_initiative 落提议卡；
//   direct：不弹卡直接开，留「已开始」帧，每条用户消息之后最多 4 个、超了退回卡片；
//   onRequest：工具表里只有 user_asked；会话间 / 跨会话消息开的轮不能直接开；dismiss_task 各种结局；子会话开自己的 worktree。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = mkdtempSync(path.join(tmpdir(), 'stools-root-'));
process.env.BRIDGE_DATA_ROOT = ROOT;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
const { makeSessionsMcp, sessionsNudge, childNudge } = await import('./session-tools.mjs');
const F = await import('../runtime/session-family.mjs');
const P = await import('../runtime/session-proposals.mjs');
const { pendingQuestions } = await import('../runtime/questions.mjs');
const { setQueueReplayer } = await import('../runtime/claude-queue.mjs');
const { tryStartGen, findGenBySession } = await import('../runtime/gen.mjs');
const S = await import('../runtime/claude-settings.mjs');
const { listWorktrees } = await import('../claude-worktrees.mjs');

const PARENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const BG = '整体目标是把会话协作对齐官方桌面端：已经定下三档设置（先问我、直接开始、只在我要求时），卡片落在会话目录旁边的台账里。这一块只负责补测试，别动别的文件，做完在汇报开头写清改了哪些文件、跑了哪些命令、还缺什么。';

// 假的重放口：登记一个「在跑」的 gen，startTurn 就认为开起来了；记下每次重放的请求（家族标记里有 cwd / worktree）
let replays = [];
let n = 0;
let failNext = false;   // 下一次重放回 500（模拟没开起来）
setQueueReplayer(async (rq) => {
  if (failNext) { failNext = false; return { status: 500, detail: JSON.stringify({ error: '模拟失败' }) }; }
  replays.push(rq);
  const sid = rq.body.sessionId || rq.family.newSessionId;
  tryStartGen('k' + n, { sessionId: sid, done: false, events: [], subscribers: new Set(), family: rq.family });
  return { status: 200, res: { writableEnded: false, chunks: [] } };
});

let ctx, gen, events;
function setup(policy = 'ask', extra = {}) {
  n++;
  P._resetProposals(); F._resetFamily(); S._resetClaudeSettingsCache();
  replays = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'stools-'));
  ctx = { kind: 'admin', key: 'k' + n, shell: true, dataDir: dir, cwd: dir, claudeProjects: path.join(dir, 'claude-projects.json'), configDir: null, ...extra };
  if (policy !== 'ask') S.setClaudeSettings(ctx, { newSessionPolicy: policy });
  F.rememberReplay(ctx, { headers: { authorization: 'Bearer t' }, url: '/api/chat', body: {} });
  events = [];
  gen = { sessionId: PARENT, userText: '顺便把登录页的错别字修一下', events, subscribers: new Set(), done: false, abort: new AbortController(), family: null };
  return makeSessionsMcp({ getGen: () => gen, ctx, lastUserUuidFor: () => null });
}
const call = (srv, name, args, toolUseId = 'toolu_' + Math.random().toString(16).slice(2, 10)) =>
  srv.instance._registeredTools[name].handler(args, { _meta: { 'claudecode/toolUseId': toolUseId }, signal: gen.abort.signal });
const text = (r) => r.content[0].text;
const ev = (type) => events.filter((e) => e.type === type);
// offer 卡出现后替用户答（等 offer 帧落进 gen.events）
async function answerOffer(choice) {
  for (let i = 0; i < 100 && !ev('offer').length; i++) await new Promise((r) => setTimeout(r, 5));
  const o = ev('offer').at(-1);
  pendingQuestions.get(o.qid).settle({ answers: [], choice });
  return o;
}
beforeEach(() => { replays = []; });

test('ask：offer 只带 title → 卡片阻塞等答；选「新会话」后带 proposal_id 补任务说明才开', async () => {
  const srv = setup('ask');
  const p = call(srv, 'start_session', { initiation: 'offer', title: '修登录页错别字' }, 'toolu_offer1');
  const o = await answerOffer('new_session');
  assert.equal(o.toolUseId, 'toolu_offer1');
  assert.equal(o.asked, '顺便把登录页的错别字修一下');
  const r = await p;
  assert.match(text(r), /用户选了「新会话」/);
  assert.equal(gen.pendingOffer, null);
  const card = P.getProposal(ctx, o.taskId);
  assert.equal(card.status, 'accepted');
  assert.equal(ev('offer_answer')[0].status, 'accepted');
  assert.equal(replays.length, 0);   // 还没开
  // 补任务说明：fresh 背景不够 80 字被拒
  assert.equal((await call(srv, 'start_session', { proposal_id: o.taskId, prompt: '修 `login.svelte` 里的错别字', background: '太短' })).isError, true);
  const r2 = await call(srv, 'start_session', { proposal_id: o.taskId, prompt: '修 `login.svelte` 里的错别字', background: BG });
  assert.match(text(r2), /已在自己的会话里开始/);
  assert.equal(replays.length, 1);
  assert.match(replays[0].body.message, /kind="brief"/);
  const done = P.getProposal(ctx, o.taskId);
  assert.equal(done.status, 'started');
  assert.ok(done.child);
  assert.equal(ev('family_link').at(-1).task, o.taskId);
  assert.equal(F.familyLink(ctx, done.child).task, o.taskId);
});

test('ask：在这里做 / 不再询问 / 用户发了新消息 / 超时之外的撤回', async () => {
  let srv = setup('ask');
  let p = call(srv, 'start_session', { initiation: 'offer', title: 'A' });
  await answerOffer('here');
  assert.match(text(await p), /用户选了「在这里做」/);
  // 不再询问：这一次在这里做，之后这个会话的 offer 不再出卡
  p = call(srv, 'start_session', { initiation: 'offer', title: 'B' });
  await answerOffer('mute');
  assert.match(text(await p), /不再询问/);
  const r = await call(srv, 'start_session', { initiation: 'offer', title: 'C' });
  assert.match(text(r), /没有弹卡：用户在这个会话里选过「不再询问」/);
  // 用户没点卡直接发了新消息（chat 路由调 supersedeOffer）
  srv = setup('ask');
  p = call(srv, 'start_session', { initiation: 'offer', title: 'D' });
  for (let i = 0; i < 100 && !gen.pendingOffer; i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(P.supersedeOffer(gen), true);
  assert.match(text(await p), /用户没点卡，而是发了一条新消息/);
  assert.equal(P.proposalsOf(ctx, PARENT)[0].status, 'superseded');
});

test('ask：卡片菜单「总是新建会话 / 总是在这里做」改 newSessionPolicy 设置', async () => {
  let srv = setup('ask');
  let p = call(srv, 'start_session', { initiation: 'offer', title: 'A' });
  await answerOffer('always_here');
  assert.match(text(await p), /用户选了「在这里做」/);
  assert.equal(S.claudeSetting(ctx, 'newSessionPolicy'), 'onRequest');
  srv = setup('ask');
  p = call(srv, 'start_session', { initiation: 'offer', title: 'B' });
  await answerOffer('always_new');
  assert.match(text(await p), /用户选了「新会话」/);
  assert.equal(S.claudeSetting(ctx, 'newSessionPolicy'), 'direct');
});

test('ask：own_initiative 落提议卡（每轮最多 3 张），用户口头说开 → proposal_id 原样开', async () => {
  const srv = setup('ask');
  assert.equal((await call(srv, 'start_session', { initiation: 'own_initiative', title: 'x' })).isError, true);   // 没有任务说明
  const r = await call(srv, 'start_session', { initiation: 'own_initiative', title: '补单测', prompt: '给 `foo.mjs` 补单测', background: BG, tldr: '刚才改了解析逻辑' });
  const id = text(r).match(/task_[0-9a-f]{8}/)[0];
  assert.equal(P.getProposal(ctx, id).status, 'pending');
  assert.equal(ev('proposal')[0].proposal.id, id);
  assert.equal(replays.length, 0);
  await call(srv, 'start_session', { initiation: 'own_initiative', title: '二', prompt: 'p', background: BG });
  await call(srv, 'start_session', { initiation: 'own_initiative', title: '三', prompt: 'p', background: BG });
  assert.match(text(await call(srv, 'start_session', { initiation: 'own_initiative', title: '四', prompt: 'p', background: BG })), /到上限了/);
  const s = await call(srv, 'start_session', { proposal_id: id });
  assert.match(text(s), /已在自己的会话里开始/);
  assert.equal(P.getProposal(ctx, id).status, 'started');
  assert.match(text(await call(srv, 'start_session', { proposal_id: id })), /已经在自己的会话里开始了/);
});

test('dismiss_task：撤回 / 已开始 / 早就不在 / 找不到', async () => {
  const srv = setup('ask');
  const id = text(await call(srv, 'start_session', { initiation: 'own_initiative', title: 't', prompt: 'p', background: BG })).match(/task_[0-9a-f]{8}/)[0];
  assert.match(text(await call(srv, 'dismiss_task', { task_id: id, reason: 'fixed here' })), /已撤回/);
  assert.equal(P.getProposal(ctx, id).status, 'dismissed');
  assert.match(text(await call(srv, 'dismiss_task', { task_id: id })), /早就不在了/);
  const id2 = text(await call(srv, 'start_session', { initiation: 'own_initiative', title: 't2', prompt: 'p', background: BG })).match(/task_[0-9a-f]{8}/)[0];
  await call(srv, 'start_session', { proposal_id: id2 });
  assert.match(text(await call(srv, 'dismiss_task', { task_id: id2 })), /已经不在等待中/);
  assert.match(text(await call(srv, 'dismiss_task', { task_id: 'task_deadbeef' })), /没有 task_id 为/);
});

test('direct：offer / own_initiative 不弹卡直接开，留「已开始」帧；每条用户消息之后最多 4 个，超了退回卡片', async () => {
  const srv = setup('direct');
  const r = await call(srv, 'start_session', { initiation: 'offer', title: '修错别字', prompt: '修 `login.svelte`', background: BG }, 'toolu_d1');
  assert.match(text(r), /已开出子会话/);
  const link = ev('family_link')[0];
  assert.equal(link.auto, true);
  assert.equal(link.toolUseId, 'toolu_d1');
  const card = P.findByToolUse(ctx, 'toolu_d1');
  assert.equal(card.status, 'started');
  assert.equal(card.auto, true);
  for (let i = 0; i < 3; i++) await call(srv, 'start_session', { initiation: 'own_initiative', title: 'auto' + i, prompt: 'p', background: BG });
  assert.equal(replays.length, 4);
  const over = await call(srv, 'start_session', { initiation: 'own_initiative', title: '第五个', prompt: 'p', background: BG });
  assert.match(text(over), /改成卡片等用户开/);
  assert.equal(replays.length, 4);
  // 用户发话：计数清零
  F.familyTurnStart(ctx, PARENT, null, null);
  assert.equal(P.autoStartCount(ctx, PARENT), 0);
  // direct 档的 offer 没带任务说明：两步走，先记成已选新会话
  const two = await call(srv, 'start_session', { initiation: 'offer', title: '没说明' });
  assert.match(text(two), /直接开始/);
  const tid = text(two).match(/task_[0-9a-f]{8}/)[0];
  assert.equal(P.getProposal(ctx, tid).status, 'accepted');
});

test('onRequest：工具表只有 user_asked，提示词不提 offer / own_initiative；模型硬调也不开', async () => {
  const srv = setup('onRequest');
  const shape = srv.instance._registeredTools.start_session.inputSchema;
  const keys = Object.keys(shape.def?.shape || shape.shape || {});
  assert.ok(!keys.includes('proposal_id'));
  assert.ok(!keys.includes('tldr'));
  const nudge = sessionsNudge(ctx);
  assert.match(nudge, /只在我要求时/);
  assert.doesNotMatch(nudge, /own_initiative/);
  assert.match(text(await call(srv, 'start_session', { initiation: 'offer', title: 'x' })), /没有弹卡/);
  assert.equal((await call(srv, 'start_session', { initiation: 'own_initiative', title: 'x', prompt: 'p', background: BG })).isError, true);
  assert.match(text(await call(srv, 'start_session', { initiation: 'user_asked', title: '并行跑测试', prompt: 'p', background: BG })), /已开出子会话/);
});

test('会话间 / 跨会话消息开的轮：不能直接开、offer 不出卡；子会话提示词说明共用目录的规矩', async () => {
  const srv = setup('direct');
  gen.family = { origin: { kind: 'peer', from: ['uds:x'] } };
  assert.equal((await call(srv, 'start_session', { initiation: 'user_asked', title: 't', prompt: 'p', background: BG })).isError, true);
  assert.match(text(await call(srv, 'start_session', { initiation: 'offer', title: 't', prompt: 'p', background: BG })), /没有弹卡：这一轮不是用户/);
  const r = await call(srv, 'start_session', { initiation: 'own_initiative', title: '提议', prompt: 'p', background: BG });
  assert.match(text(r), /已提议/);   // direct 档在没人在场的轮里也只能提议
  assert.equal(replays.length, 0);
  assert.match(childNudge({ parent: PARENT, name: 'n', shared: true }), /共用同一个目录/);
  assert.match(childNudge({ parent: PARENT, name: 'n', branch: 'claude/x-1a2b3c' }), /自己的 git worktree/);
});

// —— 审查后补：一次调用只一条卡片记录、没人在场的轮不能开卡、两步走也受自动名额约束 ——
const recordsOf = (toolUseId) => P.proposalsOf(ctx, PARENT).filter((p) => p.toolUseId === toolUseId);

test('direct：同时在跑的到上限 → 退回卡片，同一个 toolUseId 下只有一条 pending 记录', async () => {
  const srv = setup('direct');
  for (let i = 0; i < F._limits.MAX_LIVE; i++) await call(srv, 'start_session', { initiation: 'user_asked', title: 'u' + i, prompt: 'p', background: BG });
  assert.equal(replays.length, F._limits.MAX_LIVE);
  const r = await call(srv, 'start_session', { initiation: 'own_initiative', title: '后续', prompt: 'p', background: BG }, 'toolu_live');
  assert.match(text(r), /同时在跑的会话间任务已到上限.*改成卡片等用户开/);
  const recs = recordsOf('toolu_live');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, 'pending');
  assert.equal(recs[0].auto, false);
  assert.equal(P.findByToolUse(ctx, 'toolu_live').id, recs[0].id);
  assert.equal(P.autoStartCount(ctx, PARENT), 0);   // 没开成的不占名额
});

test('direct：几次调用挤在一起撞上同时在跑的上限——每个 toolUseId 仍只有一条记录，没有卡停在「正在开始」', async () => {
  const srv = setup('direct');
  for (let i = 0; i < F._limits.MAX_LIVE - 1; i++) await call(srv, 'start_session', { initiation: 'user_asked', title: 'u' + i, prompt: 'p', background: BG });
  const ids = ['toolu_c1', 'toolu_c2', 'toolu_c3'];
  const rs = await Promise.all(ids.map((id, i) => call(srv, 'start_session', { initiation: 'own_initiative', title: '并发' + i, prompt: 'p', background: BG }, id)));
  for (const id of ids) {
    const recs = recordsOf(id);
    assert.equal(recs.length, 1, id);
    assert.ok(['started', 'pending'].includes(recs[0].status), recs[0].status);
  }
  assert.equal(rs.filter((r) => /已开出子会话/.test(text(r))).length, 1);   // 只剩一个并发位
  assert.equal(P.autoStartCount(ctx, PARENT), 1);
});

test('direct：子会话数到上限 → 不落卡、照实告诉模型（点卡也开不了）', async () => {
  const srv = setup('direct');
  for (let i = 0; i < F._limits.MAX_CHILDREN; i++) F.addLink(ctx, `cccccccc-0000-4000-8000-00000000000${i}`, { parent: PARENT, title: 'c' + i });
  const own = await call(srv, 'start_session', { initiation: 'own_initiative', title: '后续', prompt: 'p', background: BG }, 'toolu_kids1');
  assert.equal(own.isError, true);
  assert.match(text(own), /开不了新会话：这个会话已经派生了 8 个子会话/);
  const offer = await call(srv, 'start_session', { initiation: 'offer', title: '新任务' }, 'toolu_kids2');
  assert.match(text(offer), /开不了新会话/);
  assert.equal(recordsOf('toolu_kids1').length + recordsOf('toolu_kids2').length, 0);
  assert.equal(gen.pendingOffer, undefined);   // 没弹卡
  assert.equal(replays.length, 0);
});

test('reopenProposal：正要自动开的那条原样退回成卡（offer 带上 qid），20 张上限照样挤最老的', async () => {
  setup('direct');
  for (let i = 0; i < P.MAX_PENDING; i++) P.addProposal(ctx, { parent: PARENT, kind: 'own', title: 'old' + i, prompt: 'p' });
  const { proposal: s } = P.addProposal(ctx, { parent: PARENT, kind: 'own', status: 'starting', auto: true, title: 'auto', prompt: 'p', toolUseId: 'toolu_re' });
  const { proposal: p, displaced } = P.reopenProposal(ctx, s.id);
  assert.equal(p.id, s.id);
  assert.equal(p.status, 'pending');
  assert.equal(p.auto, false);
  assert.ok(p.expiresAt > Date.now());
  assert.equal(displaced.length, 1);
  assert.equal(displaced[0].title, 'old0');
  assert.equal(P.pendingOf(ctx, PARENT).length, P.MAX_PENDING);
  const { proposal: o } = P.addProposal(ctx, { parent: PARENT, kind: 'offer', status: 'starting', auto: true, title: 'o', toolUseId: 'toolu_re2' });
  const r = P.reopenProposal(ctx, o.id, { qid: 'of-abc', asked: '原话' }).proposal;
  assert.equal(r.status, 'pending');
  assert.equal(r.qid, 'of-abc');
  assert.equal(r.expiresAt, 0);
});

test('没人在场的轮（会话间 / 跨会话消息、自动续跑）：带 proposal_id 也只开用户批准过的', async () => {
  const srv = setup('ask');
  const id = text(await call(srv, 'start_session', { initiation: 'own_initiative', title: '补单测', prompt: 'p', background: BG })).match(/task_[0-9a-f]{8}/)[0];
  gen.family = { origin: { kind: 'peer', from: ['uds:x'] } };
  const r = await call(srv, 'start_session', { proposal_id: id });
  assert.equal(r.isError, true);
  assert.match(text(r), /这一轮不是用户在这里发起的/);
  assert.equal(P.getProposal(ctx, id).status, 'pending');
  assert.equal(replays.length, 0);
  // offer 卡上用户点过「新会话」（accepted）：补说明那次即使落在自动续的轮里也照开
  gen.family = null;
  const p = call(srv, 'start_session', { initiation: 'offer', title: '修错别字' });
  const o = await answerOffer('new_session');
  await p;
  gen.family = { origin: { kind: 'inbox', from: ['x'] } };
  assert.match(text(await call(srv, 'start_session', { proposal_id: o.taskId, prompt: '修 `a`', background: BG })), /已在自己的会话里开始/);
  // 没作答 / 没开成的卡同样要等用户
  P.updateProposal(ctx, id, { status: 'start_failed', reason: 'x' });
  assert.equal((await call(srv, 'start_session', { proposal_id: id })).isError, true);
});

test('direct：offer 不带说明的两步走也算进「每条用户消息之后最多自动开 4 个」，超了退回问用户', async () => {
  const srv = setup('direct');
  for (let i = 0; i < P.AUTO_MAX; i++) {
    const tid = text(await call(srv, 'start_session', { initiation: 'offer', title: '任务' + i })).match(/task_[0-9a-f]{8}/)[0];
    assert.match(text(await call(srv, 'start_session', { proposal_id: tid, prompt: 'p', background: BG })), /已在自己的会话里开始/);
  }
  assert.equal(replays.length, P.AUTO_MAX);
  assert.equal(P.autoStartCount(ctx, PARENT), P.AUTO_MAX);
  // 第五个：不再记成「已选新会话」，而是出卡问用户
  const p = call(srv, 'start_session', { initiation: 'offer', title: '第五个' }, 'toolu_5th');
  const o = await answerOffer('here');
  assert.equal(o.toolUseId, 'toolu_5th');
  assert.match(text(await p), /用户选了「在这里做」/);
  assert.equal(recordsOf('toolu_5th').length, 1);
  assert.equal(replays.length, P.AUTO_MAX);
});

test('onRequest：dismiss_task 的说明里也不出现 offer / own_initiative', async () => {
  const srv = setup('onRequest');
  const d = srv.instance._registeredTools.dismiss_task.description;
  assert.doesNotMatch(d, /own_initiative|offer/);
  const srv2 = setup('ask');
  assert.match(srv2.instance._registeredTools.dismiss_task.description, /own_initiative/);
});

test('use_worktree：子会话开自己的 worktree（分支前缀读设置、名字用 branch_name），fresh 背景里写清', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'stools-repo-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, windowsHide: true }).toString().trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src', 'a.txt'), 'a\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  const srv = setup('ask', { cwd: repo });
  S.setClaudeSettings(ctx, { branchPrefix: 'bot' });
  assert.equal((await call(srv, 'start_session', { initiation: 'user_asked', title: 't', prompt: 'p', context: 'fork', use_worktree: true })).isError, true);   // fork 不收 use_worktree
  const r = await call(srv, 'start_session', { initiation: 'user_asked', title: '拆分解析器', prompt: '把 `parse` 拆出去', background: BG, use_worktree: true, branch_name: 'split-parser' });
  assert.match(text(r), /自己的 worktree 里干活（分支 bot\/split-parser-[0-9a-f]{6}，从 main 切出/);
  const fam = replays[0].family;
  assert.match(fam.worktree.branch, /^bot\/split-parser-[0-9a-f]{6}$/);
  assert.ok(existsSync(path.join(fam.cwd, 'src', 'a.txt')));
  assert.equal(path.basename(path.dirname(fam.cwd)), 'worktrees');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');   // 父会话的检出没动
  // 不开 worktree（默认：父会话不在 worktree 里）→ 共用目录，子会话的链接记 shared
  const r2 = await call(srv, 'start_session', { initiation: 'user_asked', title: '只读调查', prompt: 'p', background: BG });
  assert.match(text(r2), /同一个目录/);
  assert.equal(replays[1].family.cwd, repo);
  const kid = replays[1].family.newSessionId;
  assert.equal(F.familyLink(ctx, kid).shared, true);
  assert.ok(findGenBySession(ctx.key, kid));
  // 切好 worktree 后没开起来：worktree、分支、<claude-projects>-worktrees.json 里那条登记一并收掉
  const before = listWorktrees(ctx.claudeProjects).length;
  failNext = true;
  const bad = await call(srv, 'start_session', { initiation: 'user_asked', title: '开不起来', prompt: 'p', background: BG, use_worktree: true, branch_name: 'doomed' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /模拟失败/);
  assert.equal(listWorktrees(ctx.claudeProjects).length, before);
  assert.doesNotMatch(git('branch', '--list', 'bot/doomed-*'), /doomed/);
});

// —— 审查修复（10-21）——
test('offer 选了新会话、这一轮没补说明就收工：收尾落成「未作答」（不再一直闪「正在写任务说明」），之后还能带 proposal_id 开', async () => {
  const srv = setup('ask');
  const p = call(srv, 'start_session', { initiation: 'offer', title: '修错别字' });
  const o = await answerOffer('new_session');
  await p;
  assert.equal(P.getProposal(ctx, o.taskId).status, 'accepted');
  assert.ok(gen.acceptedOffers.has(o.taskId));
  F.familyTurnEnded(ctx, gen);   // 这一轮收尾（用户点了停止 / 说明被打回后放弃 / 撞额度…）
  const n = P.getProposal(ctx, o.taskId);
  assert.equal(n.status, 'unanswered');
  assert.equal(n.reason, 'brief_never_came');
  // 下一轮用户说「开吧」：照样能补说明开起来
  gen = { ...gen, acceptedOffers: undefined, events };
  assert.match(text(await call(srv, 'start_session', { proposal_id: o.taskId, prompt: '修 `a`', background: BG })), /已在自己的会话里开始/);
  // 「直接开始」档两步走没补说明：先占的自动名额还回去
  const srv2 = setup('direct');
  const tid = text(await call(srv2, 'start_session', { initiation: 'offer', title: '没说明' })).match(/task_[0-9a-f]{8}/)[0];
  assert.equal(P.autoStartCount(ctx, PARENT), 1);
  F.familyTurnEnded(ctx, gen);
  assert.equal(P.getProposal(ctx, tid).status, 'unanswered');
  assert.equal(P.autoStartCount(ctx, PARENT), 0);
});

test('额度重置后的自动续跑（gen.autoTurn）当没人在场：不能直接开、offer 不出卡，也不清「每条用户消息之后」的计数', async () => {
  const srv = setup('direct');
  await call(srv, 'start_session', { initiation: 'own_initiative', title: '一', prompt: 'p', background: BG });
  assert.equal(P.autoStartCount(ctx, PARENT), 1);
  gen.autoTurn = true;
  F.familyTurnStart(ctx, PARENT, null, null, { auto: true });
  assert.equal(P.autoStartCount(ctx, PARENT), 1);   // 自动续跑不算用户发话
  assert.equal((await call(srv, 'start_session', { initiation: 'user_asked', title: 't', prompt: 'p', background: BG })).isError, true);
  assert.match(text(await call(srv, 'start_session', { initiation: 'offer', title: 't', prompt: 'p', background: BG })), /没有弹卡：这一轮不是用户/);
  assert.match(text(await call(srv, 'start_session', { initiation: 'own_initiative', title: '提议', prompt: 'p', background: BG })), /已提议/);
  assert.equal(replays.length, 1);
  F.familyTurnStart(ctx, PARENT, null, null);   // 用户真的发话了
  assert.equal(P.autoStartCount(ctx, PARENT), 0);
});

test('子会话提示词随档位：「只在我要求时」不叫它用 own_initiative 提议', () => {
  const link = { parent: PARENT, name: 'n', shared: true };
  assert.match(childNudge(link, 'ask'), /own_initiative/);
  assert.match(childNudge(link, 'direct'), /own_initiative/);
  assert.doesNotMatch(childNudge(link, 'onRequest'), /own_initiative/);
  assert.match(childNudge(link, 'onRequest'), /不要主动另开会话/);
});

test('提议卡落卡时就定下 use_worktree：省略 = 这个会话在 worktree 里就开自己的；fork 留空', async () => {
  let srv = setup('ask', { worktree: { cwd: 'C:/x/.claude/worktrees/a-123456', branch: 'claude/a-123456' } });
  let id = text(await call(srv, 'start_session', { initiation: 'own_initiative', title: 'wt', prompt: 'p', background: BG })).match(/task_[0-9a-f]{8}/)[0];
  assert.equal(P.getProposal(ctx, id).useWorktree, true);
  id = text(await call(srv, 'start_session', { initiation: 'own_initiative', title: 'shared', prompt: 'p', background: BG, use_worktree: false })).match(/task_[0-9a-f]{8}/)[0];
  assert.equal(P.getProposal(ctx, id).useWorktree, false);
  id = text(await call(srv, 'start_session', { initiation: 'own_initiative', title: 'fork', prompt: 'p', context: 'fork' })).match(/task_[0-9a-f]{8}/)[0];
  assert.equal(P.getProposal(ctx, id).useWorktree, null);
  srv = setup('ask');
  id = text(await call(srv, 'start_session', { initiation: 'own_initiative', title: 'plain', prompt: 'p', background: BG })).match(/task_[0-9a-f]{8}/)[0];
  assert.equal(P.getProposal(ctx, id).useWorktree, false);
});

test('start_session 常驻（不藏在 ToolSearch 后面）：先问我 / 直接开始档常驻，「只在我要求时」档照旧延迟加载', () => {
  // 10-21 真模型抽查（sonnet-5-5 / effort low）：工具藏在 ToolSearch 后面时，用户提了无关的大活也不 offer，常驻后照规矩弹卡
  const meta = (srv) => (srv.instance._registeredTools.start_session._meta || {})['anthropic/alwaysLoad'];
  assert.equal(meta(setup('ask')), true);
  assert.equal(meta(setup('direct')), true);
  assert.notEqual(meta(setup('onRequest')), true);
  // 直接开始档的说明：无关新任务不在这里做、直接开到新会话
  const d = setup('direct').instance._registeredTools.start_session.description;
  assert.match(d, /do NOT do it here/);
});

test('父会话名称：不拿首条提问原文当标题（里面的指令会被子会话当约束）；有 ai-title 用它，没有就用中性写法', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'stools-cfg-'));
  const srv = setup('ask', { configDir: cfg });
  const { sessionsDir } = await import('../runtime/paths.mjs');
  const dir = sessionsDir(ctx.cwd, cfg);
  mkdirSync(dir, { recursive: true });
  const ask = '审查一下 calc.py 里每个函数有没有 bug，只告诉我结论，这一轮别改任何文件。';
  const line = (o) => JSON.stringify(o) + '\n';
  writeFileSync(path.join(dir, PARENT + '.jsonl'), line({ type: 'user', sessionId: PARENT, uuid: 'u1', message: { role: 'user', content: ask } }) + line({ type: 'assistant', sessionId: PARENT, uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }));
  await call(srv, 'start_session', { initiation: 'user_asked', title: '补测试', prompt: '给 calc.py 补测试', background: BG });
  const kid = replays.at(-1).family.newSessionId;
  const link = F.familyLink(ctx, kid);
  assert.ok(!String(link.parentTitle).includes('别改任何文件'), `parentTitle 不该是首条提问原文：${link.parentTitle}`);
  assert.doesNotMatch(replays.at(-1).body.message, /title="[^"]*别改任何文件/);
  assert.match(childNudge(link), new RegExp(`「${PARENT.slice(0, 8)}」`));
  assert.match(childNudge(link), /不是给你的要求/);
  // 有 ai-title（侧栏显示的那个）就用它
  writeFileSync(path.join(dir, PARENT + '.jsonl'), line({ type: 'ai-title', aiTitle: 'calc.py 函数缺陷审查', sessionId: PARENT }), { flag: 'a' });
  await call(srv, 'start_session', { initiation: 'user_asked', title: '补类型标注', prompt: '补类型标注', background: BG });
  const kid2 = replays.at(-1).family.newSessionId;
  assert.equal(F.familyLink(ctx, kid2).parentTitle, 'calc.py 函数缺陷审查');
  const { rmSync } = await import('node:fs');
  rmSync(cfg, { recursive: true, force: true });
});
test('project：子会话开到别的项目（cwd / 项目 id 进重放），父子关系照常登记，收工照样把汇报放进父会话收件箱', async () => {
  const srv = setup('ask');
  const CP = await import('../claude-projects.mjs');
  const other = mkdtempSync(path.join(tmpdir(), 'stools-other-'));
  const proj = CP.createProject(ctx.claudeProjects, ctx, { path: other });
  const label = path.basename(other);
  // 认不出的项目：报错并列出能用的
  const bad = await call(srv, 'start_session', { initiation: 'user_asked', title: 't', prompt: 'p', background: BG, project: '没有这个项目' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), new RegExp('能用的项目：.*' + label));
  // fork 不收 project
  assert.equal((await call(srv, 'start_session', { initiation: 'user_asked', title: 't', prompt: 'p', context: 'fork', project: proj.id })).isError, true);
  assert.equal(replays.length, 0);
  // 按名字（不分大小写）开
  const r = await call(srv, 'start_session', { initiation: 'user_asked', title: '去别的项目跑测试', prompt: '跑 `npm test`', background: BG, project: label.toUpperCase() });
  assert.match(text(r), new RegExp('项目「' + label + '」'));
  const fam = replays[0].family;
  assert.equal(fam.cwd, CP.authorizeProjectPath(ctx, other));
  assert.equal(fam.projectId, proj.id);
  assert.equal(fam.worktree, null);
  const kid = fam.newSessionId;
  const link = F.familyLink(ctx, kid);
  assert.equal(link.parent, PARENT);
  assert.equal(link.projectId, proj.id);
  assert.notEqual(link.shared, true);
  assert.match(childNudge(link), /父会话在别的项目里/);
  // list_sessions 列出子会话和能用的项目
  const ls = text(await call(srv, 'list_sessions', {}));
  assert.match(ls, /\[child\] 去别的项目跑测试/);
  assert.match(ls, new RegExp('- ' + label + ' — id: ' + proj.id));
  // 子会话这一轮收工 → 父会话收件箱里有汇报
  const kg = findGenBySession(ctx.key, kid);
  kg.events.push({ type: 'done', result: '测试全过了' });
  kg.done = true;
  F.familyTurnEnded(ctx, kg);
  const box = F._inbox(ctx.key, PARENT);
  assert.equal(box.length, 1);
  assert.equal(box[0].kind, 'note');
  assert.equal(box[0].from, kid);
  assert.equal(box[0].text, '测试全过了');
  // 提议卡记下项目，点卡开的时候照样开到那里
  const own = await call(srv, 'start_session', { initiation: 'own_initiative', title: '顺手修 lint', prompt: 'p', background: BG, project: proj.id });
  const tid = text(own).match(/task_[0-9a-f]{8}/)[0];
  assert.equal(P.getProposal(ctx, tid).project, proj.id);
  assert.match(text(await call(srv, 'start_session', { proposal_id: tid })), /已在自己的会话里开始/);
  assert.equal(replays.at(-1).family.projectId, proj.id);
});
