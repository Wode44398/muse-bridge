// 开源路线 S1-5「更新不把自己踢下线」：服务端要停一下（空闲时重启 / 为装更新重启）时，挂起、动手、取消、超时放弃
// 都推给所有在线设备（总线 {type:'server.restart'}），server-info 里也能看到；退出码照旧是 75。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-svc-ev-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_APK_FEED = '';
process.env.BRIDGE_SUPERVISED = 'desktop';

const sc = await import('./runtime/service-control.mjs');
const { tryStartGen, clearCurrentGenIfMatches } = await import('./runtime/gen.mjs');
const { publicRestart, registerAppUpdateRoutes } = await import('./routes/app-update.mjs');
const { APP_VERSION_NAME } = await import('./config/versions.mjs');

function liveTurn(id) {
  const g = { sessionId: id, done: false, subscribers: new Set(), events: [] };
  assert.equal(tryStartGen('u:' + id, g).ok, true);
  return () => { g.done = true; clearCurrentGenIfMatches('u:' + id, g); };
}

function serverInfo(kind = 'user') {
  const h = {};
  registerAppUpdateRoutes({ on: (m, p, fn) => { h[m + ' ' + p] = fn; } }, { authOk: () => kind === 'admin', identify: () => ({ kind }) });
  let body = '';
  h['GET /api/app/server-info']({ headers: {}, url: '/api/app/server-info' }, { writeHead() {}, end(b) { body = b; } });
  return JSON.parse(body);
}

test('没有挂起时：restart 为 null，server-info 带服务端版本', () => {
  assert.equal(publicRestart(), null);
  const info = serverInfo();
  assert.equal(info.restart, null);
  assert.equal(info.server.version, APP_VERSION_NAME);
});

test('为装更新等空闲：推 pending（原因 / 版本 / 剩几轮），server-info 同口径；取消推 cancelled', () => {
  const events = [];
  const done = liveTurn('svc-ev-a');
  try {
    const r = sc.requestRestart('idle', { reason: 'update', version: '0.9.7 <x>', publish: (e) => events.push(e), exit: () => assert.fail('有轮在跑，不该退出') });
    assert.equal(r.ok, true);
    assert.equal(r.live, 1);
    const st = sc.restartState();
    assert.equal(st.pending, true);
    assert.equal(st.reason, 'update');
    assert.equal(st.version, '0.9.7x');           // 只留版本号能用的字符
    assert.equal(st.live, 1);
    assert.ok(st.deadline - st.since === sc.IDLE_WAIT_MAX);
    assert.deepEqual(events.map((e) => [e.type, e.phase, e.reason, e.live]), [['server.restart', 'pending', 'update', 1]]);
    assert.equal(events[0].current, APP_VERSION_NAME);
    assert.doesNotMatch(JSON.stringify(events[0]), /token|secret|password/i);
    assert.deepEqual(publicRestart(), { phase: 'pending', reason: 'update', version: '0.9.7x', live: 1, since: st.since, deadline: st.deadline });
    assert.equal(serverInfo('user').restart.phase, 'pending');

    // 已在等「更新」时再来一个普通「空闲时重启」：不降级成重启
    sc.requestRestart('idle', { reason: 'restart' });
    assert.equal(sc.restartState().reason, 'update');

    sc.requestRestart('cancel');
    assert.equal(sc.restartState().pending, false);
    assert.equal(sc.restartState().reason, '');
    assert.equal(events.at(-1).phase, 'cancelled');
    assert.equal(events.at(-1).reason, 'update');
    assert.equal(publicRestart(), null);
    // 没挂着时再取消：不重复推
    const n = events.length;
    sc.requestRestart('cancel');
    assert.equal(events.length, n);
  } finally { done(); }
});

test('挂着「空闲时重启」再来更新：原因升级成更新；轮数变了再推一次；超过 30 分钟放弃并推 expired', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const events = [];
  const doneA = liveTurn('svc-ev-b');
  const doneB = liveTurn('svc-ev-c');
  try {
    sc.requestRestart('idle', { publish: (e) => events.push(e), exit: () => assert.fail('不该退出') });
    assert.equal(sc.restartState().reason, 'restart');
    sc.requestRestart('idle', { reason: 'update', version: '1.2.3' });
    assert.equal(sc.restartState().reason, 'update');
    assert.equal(sc.restartState().version, '1.2.3');
    doneA();
    t.mock.timers.tick(5000);
    assert.deepEqual(events.at(-1) && [events.at(-1).phase, events.at(-1).live], ['pending', 1]);
    t.mock.timers.tick(sc.IDLE_WAIT_MAX);
    assert.equal(sc.restartState().pending, false);
    assert.equal(events.at(-1).phase, 'expired');
    assert.equal(events.at(-1).reason, 'update');
  } finally { doneA(); doneB(); t.mock.timers.reset(); }
});

test('没有在跑的轮：先推 going（带原因），排空后以 75 退出', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  let code = null, drained = false;
  const r = sc.requestRestart('idle', { reason: 'update', version: '2.0.0', publish: (e) => events.push(e), drain: async () => { drained = true; }, exit: (c) => { code = c; } });
  assert.equal(r.ok, true);
  assert.equal(sc.restartState().going, true);
  assert.deepEqual(events.map((e) => [e.phase, e.reason, e.version]), [['going', 'update', '2.0.0']]);
  assert.equal(publicRestart().phase, 'going');
  t.mock.timers.tick(700);
  t.mock.timers.reset();
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.equal(drained, true);
  assert.equal(code, sc.RESTART_EXIT_CODE);
  // 已经在走了：再请求不重复推、不重复退出
  sc.requestRestart('now', { exit: () => assert.fail('不该再退一次') });
  assert.equal(events.length, 1);
});
