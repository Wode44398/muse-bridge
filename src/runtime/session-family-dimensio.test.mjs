// 会话协作的跨 agent 部分（Claude ⇄ dimensio，11-03）：经 dimensio 扩展的 familyCall 往 dimensio 会话开会话、发消息、汇报、报状态，
// 以及 dimensio 那边经 /agent/family/* 进来的四个入口。familyCall 这一层用 _setDimCall 顶替（真的要拉起 harness 实例）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(tmpdir(), 'family-dim-root-'));
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
const {
  addLink, familyLink, familyTurnEnded, familyTurnStart, sendToSession, spawnChild, linkedSessions, reportOf,
  deliverFromForeign, foreignState, foreignInfo, spawnFromForeign, dimensioAvailable, familyMaps, _setDimCall, _resetFamily, _inbox,
} = await import('./session-family.mjs');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';   // Claude 会话
const B = 'bbbbbbbb-0000-4000-8000-000000000002';   // Claude 会话
const D = 'dddddddd-0000-4000-8000-00000000000d';   // dimensio 会话
const E = 'eeeeeeee-0000-4000-8000-00000000000e';   // dimensio 会话

let dir, ctx, calls;
beforeEach(() => {
  _resetFamily();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(path.join(tmpdir(), 'family-dim-'));
  ctx = { key: 'admin', dataDir: dir, claudeProjects: path.join(dir, 'projects.json'), cwd: dir, allowDimensio: true };
  calls = [];
  _setDimCall(async (c, op, body) => {
    calls.push({ key: c.key, op, body });
    if (op === 'spawn') return { ok: true, id: D, name: 'dim-kid', title: body.title };
    if (op === 'info') return { ok: true, sessions: { [D]: { title: 'Dim kid (live)', state: 'working', report: 'DIM REPORT' } } };
    if (op === 'deliver') return { ok: true, how: 'woke' };
    return { ok: true };
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Claude 开 dimensio 子会话：经 familyCall spawn，父子表记 agent:dimensio；相关会话里标出来、标题 / 状态 / 回答问 dimensio', async () => {
  const r = await spawnChild(ctx, A, { title: 'Ask dimensio', prompt: 'do it', background: 'bg', agent: 'dimensio', project: 'Dim Proj' });
  assert.equal(r.ok, true);
  assert.equal(r.id, D);
  assert.equal(r.agent, 'dimensio');
  assert.deepEqual(calls[0], { key: 'admin', op: 'spawn', body: { parent: A, parentTitle: '', parentName: '', title: 'Ask dimensio', prompt: 'do it', background: 'bg', project: 'Dim Proj' } });
  assert.equal(familyLink(ctx, D).agent, 'dimensio');
  const f = await linkedSessions(ctx, A, { reports: true });
  assert.equal(f.children.length, 1);
  assert.deepEqual([f.children[0].agent, f.children[0].title, f.children[0].state, f.children[0].report], ['dimensio', 'Dim kid (live)', 'working', 'DIM REPORT']);
  assert.equal(await reportOf(ctx, D), 'DIM REPORT');
});

test('Claude 给 dimensio 会话发消息：交给 dimensio（它判插话 / 唤醒）；没开 dimensio 的身份送不到', async () => {
  addLink(ctx, D, { parent: A, title: 'dim', name: 'dimmy', agent: 'dimensio' });
  const r = await sendToSession(ctx, A, 'dimmy', 'one more thing');
  assert.deepEqual(r, { ok: true, target: D, how: 'woke' });
  const sent = calls.find((c) => c.op === 'deliver');
  assert.deepEqual([sent.body.from, sent.body.to, sent.body.kind, sent.body.text], [A, D, 'message', 'one more thing']);
  const no = await sendToSession({ ...ctx, allowDimensio: false }, A, 'dimmy', 'x');
  assert.equal(no.ok, false);
  assert.equal(dimensioAvailable({ ...ctx, allowDimensio: false }), false);
});

test('父会话是 dimensio 的 Claude 子会话：开工 / 收工报状态，父会话派的那轮收工把汇报送回 dimensio（不进本地收件箱）', async () => {
  addLink(ctx, B, { parent: E, title: 'claude kid', name: 'ck', parentAgent: 'dimensio' });
  familyTurnStart(ctx, B, { origin: { kind: 'spawn', from: [E] } }, null);
  familyTurnEnded(ctx, { sessionId: B, events: [{ type: 'done', result: 'CLAUDE DONE' }], family: { origin: { kind: 'spawn', from: [E] } } });
  await wait(20);
  const states = calls.filter((c) => c.op === 'state').map((c) => c.body);
  assert.deepEqual(states, [{ sid: B, working: true }, { sid: B, working: false }]);
  const note = calls.find((c) => c.op === 'deliver');
  assert.deepEqual([note.body.from, note.body.to, note.body.kind, note.body.status, note.body.text], [B, E, 'note', 'done', 'CLAUDE DONE']);
  assert.equal(_inbox('admin', E).length, 0);
});

test('dimensio 发进来：子会话的汇报进 Claude 父会话收件箱（信封标 agent），状态跟着走；树外的会话一律不认', async () => {
  addLink(ctx, D, { parent: A, title: 'dim', name: 'dimmy', agent: 'dimensio' });
  assert.equal(foreignState(ctx, { sid: D, working: true }), true);
  assert.equal(foreignState(ctx, { sid: E, working: true }), false, '没登记的不认');
  const r = await deliverFromForeign(ctx, { kind: 'admin', user: null }, { from: D, to: A, kind: 'note', text: 'dim done', status: 'done', fromTitle: 'dim' });
  assert.equal(r.ok, true);
  const box = _inbox('admin', A);
  assert.deepEqual([box[0].kind, box[0].fromAgent, box[0].text], ['note', 'dimensio', 'dim done']);
  const extra = familyTurnStart(ctx, A, null, null);   // 用户在父会话发话：汇报附上
  assert.match(extra, new RegExp(`<note from="${D}" name="dimmy" title="dim" status="done" agent="dimensio" nonce="[0-9a-f]{12}">`));
  const stranger = await deliverFromForeign(ctx, { kind: 'admin', user: null }, { from: E, to: A, kind: 'message', text: 'hi' });
  assert.equal(stranger.ok, false);
  // 问 Claude 会话的情况：只答跟 dimensio 会话有关系的
  const info = await foreignInfo(ctx, [A, B]);
  assert.deepEqual(Object.keys(info), [A]);
});

test('dimensio 开 Claude 子会话：父子表记 parentAgent；起不来（没有重放口）就把登记撤掉', async () => {
  const r = await spawnFromForeign(ctx, { kind: 'admin', user: null }, { parent: E, parentTitle: 'dim parent', title: 'Claude please', prompt: 'review' });
  assert.equal(r.ok, false, '测试里没有 chat 路由，开不起来');
  assert.deepEqual([...familyMaps(ctx).parentOf.values()].filter((p) => p === E), [], '没开成的子会话不留登记');
  const bad = await spawnFromForeign(ctx, null, { parent: 'nope', title: 'x', prompt: 'y' });
  assert.equal(bad.ok, false);
});
