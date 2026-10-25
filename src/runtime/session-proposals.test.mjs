// 「Claude 发起新会话」卡片台账（session-proposals.mjs）：task_id 格式、每会话 20 张上限挤掉最老的、7 天过期、
// 进程重启后挂着的 offer 落到「未作答」、不再询问、删会话连卡一起清、用户发新消息让 offer 卡作废。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'proposals-root-'));
const P = await import('./session-proposals.mjs');
const { pendingQuestions, waitForAnswer } = await import('./questions.mjs');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
let ctx;
beforeEach(() => {
  P._resetProposals();
  ctx = { key: 'admin', dataDir: mkdtempSync(path.join(tmpdir(), 'proposals-')) };
});

test('新卡：task_xxxxxxxx、7 天后过期、落盘', () => {
  const { proposal: p } = P.addProposal(ctx, { parent: A, kind: 'own', title: '补测试', prompt: 'x', background: 'y'.repeat(90), toolUseId: 'toolu_1' });
  assert.match(p.id, P.TASK_ID_RE);
  assert.equal(p.status, 'pending');
  assert.ok(Math.abs(p.expiresAt - p.createdAt - P.PROPOSAL_TTL_MS) < 5);
  assert.equal(P.findByToolUse(ctx, 'toolu_1').id, p.id);
  const disk = JSON.parse(readFileSync(path.join(ctx.dataDir, 'claude-session-proposals.json'), 'utf8'));
  assert.equal(disk.proposals[p.id].title, '补测试');
});

test('每个会话最多挂 20 张：多出来的从最老的挤掉（dismissed / displaced），别的会话不受影响', () => {
  const ids = [];
  for (let i = 0; i < P.MAX_PENDING; i++) ids.push(P.addProposal(ctx, { parent: A, kind: 'own', title: 't' + i, prompt: 'p' }).proposal.id);
  P.addProposal(ctx, { parent: B, kind: 'own', title: 'other', prompt: 'p' });
  const r = P.addProposal(ctx, { parent: A, kind: 'own', title: 'newest', prompt: 'p' });
  assert.deepEqual(r.displaced.map((x) => x.id), [ids[0]]);
  assert.equal(P.getProposal(ctx, ids[0]).status, 'dismissed');
  assert.equal(P.getProposal(ctx, ids[0]).reason, 'displaced');
  assert.equal(P.pendingOf(ctx, A).length, P.MAX_PENDING);
  assert.equal(P.pendingOf(ctx, B).length, 1);
});

test('过期：读的时候扫，到点的提议卡置 expired', () => {
  const { proposal: p } = P.addProposal(ctx, { parent: A, kind: 'own', title: 'old', prompt: 'p' });
  P.updateProposal(ctx, p.id, { expiresAt: Date.now() - 1 });
  assert.equal(P.getProposal(ctx, p.id).status, 'expired');
  assert.equal(P.pendingOf(ctx, A).length, 0);
});

test('服务重启：挂着的 offer 卡落到「未作答」，正在开的落到「没能开始」', () => {
  const o = P.addProposal(ctx, { parent: A, kind: 'offer', title: 'offer', qid: 'of-1' }).proposal;
  const s = P.addProposal(ctx, { parent: A, kind: 'own', title: 'own', prompt: 'p', status: 'starting' }).proposal;
  assert.equal(o.expiresAt, 0);   // offer 卡不过期（它跟着那次工具调用走）
  P._resetProposals();            // = 进程重启后第一次读盘
  assert.equal(P.getProposal(ctx, o.id).status, 'unanswered');
  assert.equal(P.getProposal(ctx, o.id).qid, '');
  assert.equal(P.getProposal(ctx, s.id).status, 'start_failed');
});

test('不再询问 / 删会话连卡一起清', () => {
  P.muteOffers(ctx, A);
  assert.equal(P.offersMuted(ctx, A), true);
  assert.equal(P.offersMuted(ctx, B), false);
  P.addProposal(ctx, { parent: A, kind: 'own', title: 't', prompt: 'p' });
  P.forgetProposals(ctx, A);
  assert.equal(P.proposalsOf(ctx, A).length, 0);
  assert.equal(P.offersMuted(ctx, A), false);
});

test('「直接开始」计数：按会话记，清零后从头数', () => {
  P.noteAutoStart(ctx, A); P.noteAutoStart(ctx, A);
  assert.equal(P.autoStartCount(ctx, A), 2);
  assert.equal(P.autoStartCount(ctx, B), 0);
  P.resetAutoStarts(ctx, A);
  assert.equal(P.autoStartCount(ctx, A), 0);
});

test('用户没点卡直接发了新消息：挂着的 offer 等待以 superseded 结束', async () => {
  const gen = { pendingOffer: { qid: 'of-test', taskId: 'task_00000000' } };
  const wait = waitForAnswer('of-test', null, 5000, 'admin');
  assert.ok(pendingQuestions.has('of-test'));
  assert.equal(P.supersedeOffer(gen), true);
  assert.deepEqual(await wait, { choice: 'superseded' });
  assert.equal(P.supersedeOffer({ pendingOffer: null }), false);
});

test('publicView：挂着的 offer 才带 qid；任务说明截到 4000 字', () => {
  const { proposal: p } = P.addProposal(ctx, { parent: A, kind: 'offer', title: 'o', qid: 'of-9' });
  assert.equal(P.publicView(p).qid, 'of-9');
  const n = P.updateProposal(ctx, p.id, { status: 'kept_here' });
  assert.equal(P.publicView(n).qid, undefined);
  const q = P.addProposal(ctx, { parent: A, kind: 'own', title: 'long', prompt: 'x'.repeat(9000) }).proposal;
  assert.equal(P.publicView(q).prompt.length, 4000);
});

// —— 审查修复（10-21）——
test('选了新会话、这一轮却没补任务说明：收尾时落成「未作答」，「直接开始」档先占的名额还回去；已经开了的不动', () => {
  const a = P.addProposal(ctx, { parent: A, kind: 'offer', title: '两步走', status: 'accepted', auto: true }).proposal;
  const b = P.addProposal(ctx, { parent: A, kind: 'offer', title: '补上了', status: 'accepted' }).proposal;
  P.noteAutoStart(ctx, A);
  P.updateProposal(ctx, b.id, { status: 'started', child: 'cccccccc-0000-4000-8000-000000000003' });
  const gen = { acceptedOffers: new Set([a.id, b.id]) };
  assert.equal(P.settleAcceptedOffers(ctx, gen), 1);
  const n = P.getProposal(ctx, a.id);
  assert.equal(n.status, 'unanswered');
  assert.equal(n.reason, 'brief_never_came');
  assert.ok(n.resolvedAt > 0);
  assert.equal(P.getProposal(ctx, b.id).status, 'started');
  assert.equal(P.autoStartCount(ctx, A), 0);
  assert.equal(gen.acceptedOffers.size, 0);
  assert.equal(P.settleAcceptedOffers(ctx, gen), 0);
  assert.equal(P.settleAcceptedOffers(ctx, {}), 0);
});

test('台账不只增不减：有了结局满 30 天的落盘时裁掉，还在走流程的不裁', () => {
  const old = Date.now() - P.KEEP_RESOLVED_MS - 60_000;
  const d = P.addProposal(ctx, { parent: A, kind: 'own', title: 'done', prompt: 'p' }).proposal;
  P.updateProposal(ctx, d.id, { status: 'dismissed' });
  const k = P.addProposal(ctx, { parent: A, kind: 'own', title: 'keep', prompt: 'p' }).proposal;
  const fresh = P.addProposal(ctx, { parent: A, kind: 'own', title: 'fresh-dismissed', prompt: 'p' }).proposal;
  P.updateProposal(ctx, fresh.id, { status: 'dismissed' });
  P.updateProposal(ctx, d.id, { resolvedAt: old });   // 状态没变：resolvedAt 照写，随即裁掉
  assert.equal(P.getProposal(ctx, d.id), null);
  assert.equal(P.getProposal(ctx, k.id).status, 'pending');
  assert.equal(P.getProposal(ctx, fresh.id).status, 'dismissed');
  const disk = JSON.parse(readFileSync(path.join(ctx.dataDir, 'claude-session-proposals.json'), 'utf8'));
  assert.deepEqual(Object.keys(disk.proposals).sort(), [k.id, fresh.id].sort());
});

test('过期扫描：没到最早的到期时刻不扫全表，到点照样置 expired；卡一变就重算', () => {
  const now = Date.now();
  const p = P.addProposal(ctx, { parent: A, kind: 'own', title: 'x', prompt: 'p' }).proposal;
  P.updateProposal(ctx, p.id, { expiresAt: now + 1000 });
  assert.equal(P.sweepExpired(ctx, now), 0);
  assert.equal(P.sweepExpired(ctx, now + 500), 0);
  assert.equal(P.sweepExpired(ctx, now + 1001), 1);
  assert.equal(P.getProposal(ctx, p.id).status, 'expired');
  const q = P.addProposal(ctx, { parent: A, kind: 'own', title: 'y', prompt: 'p' }).proposal;
  assert.equal(P.sweepExpired(ctx, now), 0);   // 记下 q 的到期时刻（7 天后）
  P.updateProposal(ctx, q.id, { expiresAt: now - 1 });   // 改了：下次读重算，不被旧的到期时刻挡住
  assert.equal(P.getProposal(ctx, q.id).status, 'expired');
});
