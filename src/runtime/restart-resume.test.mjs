// 服务意外重启后自动继续（restart-resume.mjs + inflight.mjs 台账，2026-10-28）。
// 数据根指到临时目录、重放口换成假的，验证：台账记下精简的重放请求与续跑次数；下一条命把孤儿排上续跑、
// attach 换成「马上自动继续」；到点重放的请求形状；连续 3 次封顶、超过 12 小时 / 没有身份 / 没有 transcript / 设置关不续；
// 忙就重试、发不出去交还给人；没来得及发的条目跨命续上，连着几条命都没发出就放弃。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'restart-resume-'));
process.env.BRIDGE_DATA_ROOT = root;
const { setQueueReplayer } = await import('./claude-queue.mjs');
const { initInflight, beginInflight, interruptedRun } = await import('./inflight.mjs');
const RR = await import('./restart-resume.mjs');

const KEY = 'admin';
let reply = async () => ({ status: 200, res: { writableEnded: true, chunks: [] } });
const replays = [];
setQueueReplayer(async (rq) => { replays.push(rq); return reply(rq); });

let n = 0;
// 一个会话的 transcript（位置与 SDK 的 projects 布局一致）+ 它在台账里的那条记录
function world({ resume = 0, replay = true, transcript = true, startedAt = Date.now(), dataDir = '' } = {}) {
  n += 1;
  const sid = `${String(n).padStart(8, '0')}-2222-3333-4444-555555555555`;
  const base = path.join(root, 'w' + n);
  const configDir = path.join(base, 'cfg');
  const cwd = path.join(base, 'ws');
  mkdirSync(cwd, { recursive: true });
  const proj = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(proj, { recursive: true });
  if (transcript) {
    writeFileSync(path.join(proj, sid + '.jsonl'), JSON.stringify({ type: 'user', uuid: 'u-1', sessionId: sid, cwd, message: { role: 'user', content: '干活' } }) + '\n');
  }
  const rec = {
    key: KEY, sessionId: sid, userText: '干活', startedAt, cwd, configDir, dataDir,
    replay: replay ? { headers: { authorization: 'Bearer x' }, url: '/api/chat', body: { message: '很长的原话', attachments: ['C:/a.png'], model: 'claude-opus-5-5', effort: 'high', priority: 'later', worktree: true, outputStyle: 'Concise', limitResume: true, ...(resume ? { restartResume: resume } : {}) } } : null,
    resume,
  };
  return { sid, rec };
}
// 一条命开跑这些轮后死掉，下一条命启动收尸
function crashWith(...recs) {
  initInflight(root);
  for (const r of recs) beginInflight(r);
  return initInflight(root);
}
const on = () => true;

test.beforeEach(() => { RR._resetForTest(); replays.length = 0; reply = async () => ({ status: 200, res: { writableEnded: true, chunks: [] } }); });

test('台账记下精简的重放请求（不带正文与附件）、数据目录与续跑次数', () => {
  const { rec } = world({ resume: 2, dataDir: 'D:/u' });
  initInflight(root);
  beginInflight(rec);
  const [r] = JSON.parse(readFileSync(path.join(root, 'inflight-runs.json'), 'utf8'));
  assert.equal(r.resume, 2);
  assert.equal(r.dataDir, 'D:/u');
  assert.equal(r.replay.headers.authorization, 'Bearer x');
  assert.equal(r.replay.body.message, undefined);
  assert.equal(r.replay.body.attachments, undefined);
  assert.equal(r.replay.body.model, 'claude-opus-5-5');
  assert.ok(r.beat > 0);
  initInflight(root);   // 收掉，别留给下一个用例
});

test('孤儿排上续跑：attach 改说「马上自动继续」；到点重放的请求形状', async () => {
  const { sid, rec } = world();
  const orphans = crashWith(rec);
  assert.equal(RR.initRestartResume(orphans, { enabledFor: on, delayMs: 1e9 }), 1);
  assert.equal(interruptedRun(KEY, sid).resuming, true);
  assert.deepEqual(RR._pendingForTest().map((e) => [e.sid, e.attempt]), [[sid, 1]]);

  await RR._fireForTest(KEY, sid);
  assert.equal(replays.length, 1);
  const { body, headers } = replays[0];
  assert.equal(body.message, RR.RESTART_TEXT);
  assert.equal(body.sessionId, sid);
  assert.equal(body.restartResume, 1);
  assert.deepEqual(body.attachments, []);
  assert.equal(body.priority, undefined);
  assert.equal(body.worktree, undefined);
  assert.equal(body.outputStyle, undefined);
  assert.equal(body.limitResume, undefined, '不冒充限额续跑');
  assert.equal(body.model, 'claude-opus-5-5', '模型 / effort 沿用');
  assert.equal(headers.authorization, 'Bearer x');
  assert.deepEqual(RR._pendingForTest(), [], '发出去就功成身退');
});

test('续跑轮自己又被打断：次数累加，连续 3 次后不再续', () => {
  const a = world({ resume: 2 });
  const b = world({ resume: 3 });
  RR.initRestartResume(crashWith(a.rec, b.rec), { enabledFor: on, delayMs: 1e9 });
  assert.deepEqual(RR._pendingForTest().map((e) => [e.sid, e.attempt]), [[a.sid, 3]]);
  assert.equal(interruptedRun(KEY, b.sid).resuming, undefined, '不续的照旧让人自己说「继续」');
});

test('超过 12 小时、没有请求身份、没有 transcript：都不续', () => {
  const old = world({ startedAt: Date.now() - 13 * 3600_000 });
  const noId = world({ replay: false });
  const noFile = world({ transcript: false });
  const orphans = crashWith(old.rec, noId.rec, noFile.rec);
  // 台账心跳是开跑时写的「现在」；把老的那条改回 13 小时前，模拟上一条命早就死了
  orphans[0].beat = Date.now() - 13 * 3600_000;
  assert.equal(RR.initRestartResume(orphans, { enabledFor: on, delayMs: 1e9 }), 0);
});

test('设置关了不续（按开跑时记下的身份数据目录读）', () => {
  const dataDir = path.join(root, 'user-off');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'claude-settings.json'), JSON.stringify({ rev: 1, values: { autoResumeOnRestart: false } }));
  const off = world({ dataDir });
  const dflt = world({ dataDir: path.join(root, 'user-default') });
  RR.initRestartResume(crashWith(off.rec, dflt.rec), { delayMs: 1e9 });
  assert.deepEqual(RR._pendingForTest().map((e) => e.sid), [dflt.sid], '没改过设置 = 默认开');
});

test('等的这几秒里设置关了：发之前再读一次', async () => {
  const { sid, rec } = world();
  let enabled = true;
  RR.initRestartResume(crashWith(rec), { enabledFor: () => enabled, delayMs: 1e9 });
  enabled = false;
  await RR._fireForTest(KEY, sid);
  assert.equal(replays.length, 0);
  assert.deepEqual(RR._pendingForTest(), []);
  assert.equal(interruptedRun(KEY, sid).resuming, undefined);
});

test('服务器正忙就留着下次再试；发不出去（会话被别处占着）交还给人', async () => {
  const { sid, rec } = world();
  RR.initRestartResume(crashWith(rec), { enabledFor: on, delayMs: 1e9 });
  reply = async () => ({ status: 200, res: { writableEnded: true, chunks: ['data: {"type":"error","kind":"busy","message":"服务器正忙"}\n\n'] } });
  await RR._fireForTest(KEY, sid);
  assert.equal(RR._pendingForTest().length, 1, '忙：留着重试');
  reply = async () => ({ status: 409, detail: JSON.stringify({ code: 'held_elsewhere', error: '这个会话在 Claude Desktop 里正开着' }) });
  await RR._fireForTest(KEY, sid);
  assert.deepEqual(RR._pendingForTest(), []);
  assert.equal(interruptedRun(KEY, sid).resuming, undefined, 'attach 改回「说一句继续」');
});

test('没来得及发的条目跨命续上；连着 3 条命都没发出就放弃', () => {
  const { sid, rec } = world();
  RR.initRestartResume(crashWith(rec), { enabledFor: on, delayMs: 1e9 });
  initInflight(root);                      // 又死了一次：台账已空，只剩待续清单
  RR.initRestartResume([], { enabledFor: on, delayMs: 1e9 });
  assert.deepEqual(RR._pendingForTest().map((e) => [e.sid, e.boots]), [[sid, 1]]);
  RR.initRestartResume([], { enabledFor: on, delayMs: 1e9 });
  assert.equal(RR._pendingForTest().length, 1);
  RR.initRestartResume([], { enabledFor: on, delayMs: 1e9 });
  assert.deepEqual(RR._pendingForTest(), []);
});
