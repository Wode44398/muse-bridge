// 5 小时限额重置后自动继续（limit-resume.mjs，2026-10-20 对齐官方 Desktop 2.42304）。
// 数据根指到临时目录、重放口换成假的，验证：只认 five_hour、默认勾上、到点重放的请求形状、
// 人接手作废、默认勾选来自设置（勾选框只管这一次）、同一窗口最多 3 次、落盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'limit-resume-'));
process.env.BRIDGE_DATA_ROOT = dir;
const { setQueueReplayer } = await import('./claude-queue.mjs');
const LR = await import('./limit-resume.mjs');

const replays = [];
setQueueReplayer(async (rq) => { replays.push(rq); return { status: 200 }; });

const KEY = 'admin';
const replay = (msg = '原来那条') => ({ headers: { authorization: 'Bearer x' }, url: '/api/chat', body: { message: msg, attachments: ['C:/a.png'], model: 'claude-opus-5-5', effort: 'high', sessionId: 's', priority: 'later', worktree: true, outputStyle: 'Concise' } });

test('只认 5 小时限额：每周限额不排续跑', () => {
  assert.equal(LR.noteLimitTurn(KEY, 'w1', { type: 'seven_day', resetsAt: Date.now() + 3600_000, replay: replay() }), null);
  assert.equal(LR.getLimitResume(KEY, 'w1'), null);
});

test('默认勾上；到点按原请求重放、正文换成续跑句、清掉附件与 worktree/priority/输出风格', async () => {
  const resetsAt = Date.now() + 3600_000;
  const st = LR.noteLimitTurn(KEY, 'a1', { type: 'five_hour', resetsAt, replay: replay() });
  assert.equal(st.armed, true);
  assert.equal(st.optedIn, true);
  assert.ok(st.fireAt >= resetsAt + 90_000 + 2000 && st.fireAt <= resetsAt + 90_000 + 8000, '重置 + 90s + 2–8s 抖动');
  replays.length = 0;
  await LR._fireForTest(KEY, 'a1');
  assert.equal(replays.length, 1);
  const b = replays[0].body;
  assert.equal(b.message, LR.RESUME_TEXT);
  assert.equal(b.sessionId, 'a1');
  assert.deepEqual(b.attachments, []);
  assert.equal(b.limitResume, true);
  assert.equal(b.priority, undefined);
  assert.equal(b.worktree, undefined);
  assert.equal(b.outputStyle, undefined, '旧请求体随带的风格不重放（会盖掉用户等待期间改的会话覆盖）');
  assert.equal(b.model, 'claude-opus-5-5', '模型 / effort 沿用');
  assert.equal(replays[0].headers.authorization, 'Bearer x');
  const after = LR.getLimitResume(KEY, 'a1');
  assert.equal(after.attempt, 1);
  assert.equal(after.armed, false);
  assert.equal(after.firing, true);
  // 续跑轮自己开跑（auto）不作废；跑完正常收尾 → 翻篇
  LR.noteTurnStart(KEY, 'a1', { auto: true });
  assert.ok(LR.getLimitResume(KEY, 'a1'));
  LR.noteTurnSettled(KEY, 'a1');
  assert.equal(LR.getLimitResume(KEY, 'a1'), null);
});

test('人自己先发了消息 → 作废', () => {
  LR.noteLimitTurn(KEY, 'b1', { type: 'five_hour', resetsAt: Date.now() + 3600_000, replay: replay() });
  LR.noteTurnStart(KEY, 'b1', { auto: false });
  assert.equal(LR.getLimitResume(KEY, 'b1'), null);
});

test('续跑后同一窗口再撞墙：沿用次数，第 3 次后不再排', async () => {
  const resetsAt = Date.now() - 60_000;   // 已过重置时刻（限额其实没恢复）
  LR.noteLimitTurn(KEY, 'c1', { type: 'five_hour', resetsAt, replay: replay() });
  for (let n = 1; n <= 3; n++) {
    await LR._fireForTest(KEY, 'c1');
    const st = LR.noteLimitTurn(KEY, 'c1', { type: 'five_hour', resetsAt, replay: replay() });
    assert.equal(st.attempt, n);
    assert.equal(st.armed, n < 3, `第 ${n} 次之后 armed=${n < 3}`);
    if (n < 3) assert.ok(st.fireAt - Date.now() >= 45_000 - 50, '重置时刻已过的再次尝试至少隔 45s');
  }
  LR.noteTurnSettled(KEY, 'c1');
});

test('默认勾不勾由设置给（defaultOn）；勾选框只管这一次，不连带别的会话、不改默认', () => {
  // 设置关：新撞的墙默认不勾
  const off0 = LR.noteLimitTurn(KEY, 'd0', { type: 'five_hour', resetsAt: Date.now() + 3600_000, replay: replay(), defaultOn: false });
  assert.equal(off0.optedIn, false);
  assert.equal(off0.armed, false);
  // 卡片上勾上：只这一次排上
  const on0 = LR.setLimitAutoContinue(KEY, 'd0', true);
  assert.equal(on0.armed, true);
  // 设置开：默认勾上；卡片上取消只停这一个
  LR.noteLimitTurn(KEY, 'd1', { type: 'five_hour', resetsAt: Date.now() + 3600_000, replay: replay(), defaultOn: true });
  const off = LR.setLimitAutoContinue(KEY, 'd1', false);
  assert.equal(off.armed, false);
  assert.equal(off.optedIn, false);
  assert.equal(LR.getLimitResume(KEY, 'd0').armed, true, '别的会话不受这个勾选框影响');
  const d2 = LR.noteLimitTurn(KEY, 'd2', { type: 'five_hour', resetsAt: Date.now() + 3600_000, replay: replay(), defaultOn: true });
  assert.equal(d2.armed, true, '新撞的墙仍按设置默认勾上，不跟着上次卡片上的选择');
  // 落盘：三条都在；勾选框不再写 prefs
  const j = JSON.parse(readFileSync(path.join(dir, 'claude-limit-resume.json'), 'utf8'));
  assert.equal(j.prefs[KEY], undefined);
  assert.ok(j.entries[KEY + '|d0'] && j.entries[KEY + '|d1'] && j.entries[KEY + '|d2']);
  LR.noteTurnSettled(KEY, 'd0');
  LR.noteTurnSettled(KEY, 'd1');
  LR.noteTurnSettled(KEY, 'd2');
});

test('到点时卡片上已取消 → 不重放', async () => {
  LR.noteLimitTurn(KEY, 'f1', { type: 'five_hour', resetsAt: Date.now() + 1000, replay: replay(), defaultOn: true });
  LR.setLimitAutoContinue(KEY, 'f1', false);
  replays.length = 0;
  await LR._fireForTest(KEY, 'f1');
  assert.equal(replays.length, 0);
  LR.noteTurnSettled(KEY, 'f1');
});

test('重放失败：不再自动重试，回到可手动重试', async () => {
  setQueueReplayer(async () => ({ status: 409, detail: 'held_elsewhere' }));
  LR.noteLimitTurn(KEY, 'e1', { type: 'five_hour', resetsAt: Date.now() + 1000, replay: replay() });
  await LR._fireForTest(KEY, 'e1');
  const st = LR.getLimitResume(KEY, 'e1');
  assert.equal(st.firing, false);
  assert.equal(st.armed, false);
  LR.noteTurnSettled(KEY, 'e1');
  assert.ok(existsSync(path.join(dir, 'claude-limit-resume.json')));
});
