// 服务控制（三端拆分 P4）的契约：没有守护进程拒绝重启；有守护进程时排空后以 75 退出；
// 「空闲时重启」等在跑的轮都结束才动手，可以取消；日志环只留最近 N 行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-svc-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');

const sc = await import('./runtime/service-control.mjs');
const { tryStartGen, clearCurrentGenIfMatches } = await import('./runtime/gen.mjs');
const { installLogRing, recentLogs } = await import('./runtime/log-ring.mjs');

const withEnv = async (patch, fn) => {
  const old = {};
  for (const k of Object.keys(patch)) { old[k] = process.env[k]; if (patch[k] == null) delete process.env[k]; else process.env[k] = patch[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
};
const bare = { BRIDGE_SUPERVISED: null, INVOCATION_ID: null, JOURNAL_STREAM: null, pm_id: null, PM2_HOME: null, container: null };

test('没有守护进程：拒绝重启（退了就真停了）', async () => {
  await withEnv(bare, () => {
    if (sc.supervisor()) return;   // 在 Docker / systemd 里跑测试时这条不适用
    const r = sc.requestRestart('now', { exit: () => assert.fail('不该退出') });
    assert.match(r.error, /守护进程/);
  });
});

test('识别 systemd，显式声明优先', async () => {
  await withEnv({ ...bare, INVOCATION_ID: 'abc' }, () => assert.equal(sc.supervisor(), 'systemd'));
  await withEnv({ ...bare, BRIDGE_SUPERVISED: 'launchd', INVOCATION_ID: 'abc' }, () => assert.equal(sc.supervisor(), 'launchd'));
});

test('部署脚本声明了更新方式：控制台「更新」照原话挡住（比如 Muse 的 tar 包部署）', async () => {
  await withEnv({ ...bare, BRIDGE_SUPERVISED: 'systemd', BRIDGE_UPDATE_HINT: '在 Muse 里说「更新 bridge」' }, () => {
    assert.equal(sc.updateAvailability(), '在 Muse 里说「更新 bridge」');
    assert.equal(sc.startUpdate().error, '在 Muse 里说「更新 bridge」');
  });
});

test('空闲时重启：有轮在跑就挂着等、可取消；立即重启先排空再以 75 退出', async (t) => {
  await withEnv({ ...bare, BRIDGE_SUPERVISED: 'systemd' }, async () => {
    const g = { sessionId: 'svc-test', done: false, subscribers: new Set(), events: [] };
    assert.equal(tryStartGen('u:svc-test', g).ok, true);
    try {
      const r = sc.requestRestart('idle', { exit: () => assert.fail('有轮在跑，不该退出') });
      assert.equal(r.ok, true);
      assert.equal(r.restart.pending, true);
      assert.equal(sc.requestRestart('cancel').restart.pending, false);
    } finally { g.done = true; clearCurrentGenIfMatches('u:svc-test', g); }

    t.mock.timers.enable({ apis: ['setTimeout'] });
    let drained = false, code = null;
    const r = sc.requestRestart('now', { drain: async () => { drained = true; }, exit: (c) => { code = c; } });
    assert.equal(r.ok, true);
    t.mock.timers.tick(700);
    t.mock.timers.reset();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    assert.equal(drained, true);
    assert.equal(code, sc.RESTART_EXIT_CODE);
  });
});

test('日志环：装上后照录 console，只留最近的', () => {
  installLogRing();
  console.log('ring-probe-' + 42);
  const last = recentLogs(5).map((l) => l.text);
  assert.ok(last.includes('ring-probe-42'));
  assert.ok(recentLogs(100000).length <= 600);
});
