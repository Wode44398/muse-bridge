// 「空闲时重启」也要等 gen 表外的轮（dimensio 的轮跑在 harness 子进程里，经 setExtraLiveProbe 接进来）：
// 以前只数 gen 表（Claude / Codex / agy），dimensio 在跑也照样重启、把那一轮腰斩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-svc-ext-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_APK_FEED = '';
process.env.BRIDGE_SUPERVISED = 'desktop';

const sc = await import('./runtime/service-control.mjs');
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test('gen 表空、dimensio 还有轮：挂起等它跑完；取消后探针回来也不动手', async () => {
  let busy = 2;
  sc.setExtraLiveProbe(async () => busy);
  try {
    const events = [];
    const r = sc.requestRestart('idle', { publish: (e) => events.push(e), exit: () => assert.fail('dimensio 在跑，不该退出') });
    assert.equal(r.ok, true);
    assert.equal(r.checking, true);
    await flush();
    assert.equal(sc.restartState().pending, true);
    assert.equal(sc.restartState().live, 2);
    assert.deepEqual(events.map((e) => [e.phase, e.live]), [['pending', 2]]);
    assert.equal(sc.serviceInfo().liveTurns, 2, '控制台 / 桌面客户端看到的在跑数也算上 dimensio');
    sc.requestRestart('cancel');
    assert.equal(sc.restartState().pending, false);

    // 现问期间被取消：探针回来后不再挂起、不动手
    busy = 0;
    sc.requestRestart('idle', { exit: () => assert.fail('已取消，不该退出') });
    sc.requestRestart('cancel');
    await flush();
    assert.equal(sc.restartState().pending, false);
    assert.equal(sc.restartState().going, false);
  } finally { sc.setExtraLiveProbe(null); }
});

test('挂着等 dimensio：它跑完后下一拍动手，以 75 退出', async (t) => {
  let busy = 1;
  sc.setExtraLiveProbe(async () => busy);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    let code = null;
    sc.requestRestart('idle', { exit: (c) => { code = c; } });
    await flush();
    assert.equal(sc.restartState().pending, true);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(sc.restartState().pending, true, '还在跑：接着等');
    busy = 0;
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(sc.restartState().going, true);
    t.mock.timers.tick(700);
    await flush();
    assert.equal(code, sc.RESTART_EXIT_CODE);
  } finally { t.mock.timers.reset(); sc.setExtraLiveProbe(null); }
});

test('live-runs.json 快照：按 agent 分开计数（codex: / agy: 前缀，其余算 Claude），dimensio 另算', async () => {
  const { liveRunsSnapshot, agentOfGenKey } = await import('./runtime/live-runs-file.mjs');
  const { tryStartGen, clearCurrentGenIfMatches } = await import('./runtime/gen.mjs');
  assert.equal(agentOfGenKey('codex:admin'), 'codex');
  assert.equal(agentOfGenKey('agy:u:bob'), 'agy');
  assert.equal(agentOfGenKey('u:bob'), 'claude');
  const gens = [['agy:admin', 'a1'], ['admin', 'c1'], ['codex:admin', 'x1']].map(([key, sid]) => {
    const g = { sessionId: sid, done: false, subscribers: new Set(), events: [] };
    assert.equal(tryStartGen(key, g).ok, true);
    return [key, g];
  });
  try {
    const s = liveRunsSnapshot(2, 123);
    assert.deepEqual(s.byAgent, { claude: 1, codex: 1, agy: 1, dimensio: 2 });
    assert.equal(s.total, 5);
    assert.equal(s.at, 123);
    assert.equal(s.pid, process.pid);
  } finally { for (const [key, g] of gens) { g.done = true; clearCurrentGenIfMatches(key, g); } }
});
