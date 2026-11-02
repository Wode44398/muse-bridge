import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { parseCron, nextCron, normalizeCron } from './cron.mjs';
import * as routines from './routines.mjs';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('cron：工作日 9 点', () => {
  // 2026-11-06 是周五
  assert.equal(nextCron('0 9 * * 1-5', at(2026, 11, 6, 8, 0)), at(2026, 11, 6, 9, 0));
  assert.equal(nextCron('0 9 * * 1-5', at(2026, 11, 6, 9, 0)), at(2026, 11, 9, 9, 0));   // 跳过周末
});

test('cron：步长、列表、月份', () => {
  assert.equal(nextCron('30 */6 * * *', at(2026, 1, 1, 7, 0)), at(2026, 1, 1, 12, 30));
  assert.equal(nextCron('15 8,20 1 * *', at(2026, 3, 1, 9, 0)), at(2026, 3, 1, 20, 15));
  assert.equal(nextCron('0 0 1 1 *', at(2026, 6, 1)), at(2027, 1, 1));
});

test('cron：日和周都受限时取并集', () => {
  // 每月 13 号或每周五：2026-11-01（周日）之后先到 11-06 周五
  assert.equal(nextCron('0 10 13 * 5', at(2026, 11, 1)), at(2026, 11, 6, 10, 0));
});

test('cron：不合法的写法', () => {
  assert.throws(() => parseCron('0 9 * *'), /5 段/);
  assert.throws(() => parseCron('*/5 * * * *'), /每小时/);
  assert.throws(() => parseCron('0 9 * * MON'), /数字/);
  assert.throws(() => parseCron('0 9 * * 7'), /0/);
  assert.throws(() => parseCron('0 25 * * *'), /范围/);
  assert.equal(nextCron('0 0 30 2 *', at(2026, 1, 1)), null);   // 2 月 30 日永远不来
  assert.equal(normalizeCron('  0   9 *  * 1-5 '), '0 9 * * 1-5');
});

test('频率：手动 / 一次性 / 每周多天 / 旧数据', () => {
  assert.equal(routines.computeNextRun({ type: 'manual' }, at(2026, 1, 1)), null);
  assert.equal(routines.computeNextRun({ type: 'once', at: at(2026, 1, 2, 8) }, at(2026, 1, 1)), at(2026, 1, 2, 8));
  assert.equal(routines.computeNextRun({ type: 'once', at: at(2026, 1, 2, 8) }, at(2026, 1, 3)), null);
  // 2026-11-01 周日 → 周二、周四 7:30
  assert.equal(routines.computeNextRun({ type: 'weekly', days: [2, 4], hour: 7, minute: 30 }, at(2026, 11, 1)), at(2026, 11, 3, 7, 30));
  assert.equal(routines.computeNextRun({ type: 'weekly', days: [2, 4], hour: 7, minute: 30 }, at(2026, 11, 3, 8)), at(2026, 11, 5, 7, 30));
  // 旧数据只有 weekday
  assert.deepEqual(routines.normSchedule({ type: 'weekly', weekday: 3, hour: 9, minute: 0 }).days, [3]);
  assert.throws(() => routines.normSchedule({ type: 'cron', cron: 'bad' }, { strict: true }));
  assert.deepEqual(routines.normSchedule({ type: 'cron', cron: 'bad' }), { type: 'manual' });
});

test('运行记录与复制', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'routines-'));
  try {
    const r = routines.create(dir, { name: '晨报', prompt: 'x', schedule: { type: 'daily', hour: 8, minute: 0 }, cwd: 'C:\\x', worktree: true, sessionMode: 'continue', notify: true });
    assert.equal(r.cwd, 'C:\\x');
    assert.equal(r.worktree, true);
    assert.equal(r.threadSessionId, null);
    const run = routines.startRun(dir, r.id, { trigger: 'manual' });
    assert.equal(routines.get(dir, r.id).lastStatus, 'running');
    routines.patchRun(dir, r.id, run.id, { status: 'ok', sessionId: 's1', preview: '好了' });
    let cur = routines.get(dir, r.id);
    assert.equal(cur.lastStatus, 'ok');
    assert.equal(cur.lastSessionId, 's1');
    assert.equal(cur.runs[0].preview, '好了');
    // 跳过的不算「上次运行」
    routines.startRun(dir, r.id, { trigger: 'schedule', status: 'skipped' });
    cur = routines.get(dir, r.id);
    assert.equal(cur.lastStatus, 'ok');
    assert.equal(cur.runs.length, 2);
    // 换工作文件夹：接着用的会话作废
    routines.update(dir, r.id, { threadSessionId: 's1' });
    assert.equal(routines.update(dir, r.id, { cwd: 'C:\\y' }).threadSessionId, null);
    const copy = routines.duplicate(dir, r.id);
    assert.equal(copy.name, '晨报 副本');
    assert.equal(copy.enabled, false);
    assert.equal(copy.cwd, 'C:\\y');
    assert.equal(copy.runs.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
