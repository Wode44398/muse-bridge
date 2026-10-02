import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newQuickProject, pruneQuick } from './claude-quick.mjs';
import { sessionsDir } from './runtime/paths.mjs';

// 沙箱用户身份：桶落 <dataDir>/quickchat（admin 会落真实主目录，测试别碰）。
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'quick-prune-'));
  const ctx = { kind: 'user', key: 'u:t', cwd: root, dataDir: root, configDir: path.join(root, 'claude') };
  return { root, ctx };
}
const HOUR = 3600e3;
function record(ctx, bucketPath, id, ageMs, now) {
  const dir = sessionsDir(bucketPath, ctx.configDir);
  mkdirSync(path.join(dir, id), { recursive: true });   // 子 agent 子目录
  const file = path.join(dir, id + '.jsonl');
  writeFileSync(file, '{}\n');
  const t = new Date(now - ageMs);
  utimesSync(file, t, t);
  return file;
}
const age = (p, ms, now) => { const t = new Date(now - ms); utimesSync(p, t, t); };

test('pruneQuick keeps the newest N records, drops older ones with their buckets', async () => {
  const { root, ctx } = fixture();
  try {
    const now = Date.now();
    const olds = [];
    for (let i = 0; i < 5; i++) {
      const b = newQuickProject(ctx);
      const f = record(ctx, b.path, `0000000${i}-aaaa-bbbb-cccc-000000000000`, (10 - i) * HOUR, now);
      writeFileSync(path.join(b.path, 'report.md'), 'x');
      age(b.path, (10 - i) * HOUR, now);
      olds.push({ b, f });
    }
    const cur = newQuickProject(ctx);   // 当前桶：两条，旧的那条比所有旧桶都老
    const curOld = record(ctx, cur.path, '11111111-aaaa-bbbb-cccc-000000000000', 20 * HOUR, now);
    const curNew = record(ctx, cur.path, '22222222-aaaa-bbbb-cccc-000000000000', 1 * HOUR, now);
    age(cur.path, 20 * HOUR, now);
    const empty = newQuickProject(ctx).path;   // 铸了没聊的空桶……
    age(empty, 5 * HOUR, now);
    // ……但它顶掉了「当前」，这里把当前改回 cur
    writeFileSync(path.join(root, 'claude-quick.json'), JSON.stringify({ id: cur.id, path: cur.path, created: now }));

    const dropped = [];
    const r = await pruneQuick(ctx, { keep: 3, now, onDrop: (id) => dropped.push(id) });
    // 保留：curNew（置顶）、olds[4]、olds[3]；其余全删
    assert.ok(existsSync(curNew));
    assert.ok(existsSync(olds[4].f) && existsSync(olds[3].f));
    assert.ok(!existsSync(olds[2].f) && !existsSync(olds[0].f));
    assert.ok(!existsSync(curOld), '当前桶里更老的一条也回收');
    assert.ok(existsSync(cur.path), '当前桶本身永不删');
    assert.ok(!existsSync(olds[0].b.path) && !existsSync(sessionsDir(olds[0].b.path, ctx.configDir)), '旧桶连产物与 transcript 目录一起删');
    assert.ok(existsSync(path.join(olds[4].b.path, 'report.md')));
    assert.ok(!existsSync(empty), '没有记录的旧空桶删掉');
    assert.equal(r.records, 4);
    assert.equal(r.buckets, 4);
    assert.equal(dropped.length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pruneQuick spares busy sessions and anything touched within the grace window', async () => {
  const { root, ctx } = fixture();
  try {
    const now = Date.now();
    const a = newQuickProject(ctx);
    const busyFile = record(ctx, a.path, 'aaaaaaaa-aaaa-bbbb-cccc-000000000000', 30 * HOUR, now);
    age(a.path, 30 * HOUR, now);
    const fresh = newQuickProject(ctx).path;   // 刚铸、还没落 transcript（且已不是当前）
    const b = newQuickProject(ctx);
    record(ctx, b.path, 'bbbbbbbb-aaaa-bbbb-cccc-000000000000', HOUR, now);
    const r = await pruneQuick(ctx, { keep: 1, now, busy: new Set(['aaaaaaaa-aaaa-bbbb-cccc-000000000000']) });
    assert.ok(existsSync(busyFile) && existsSync(a.path), '在跑的会话与它的桶不动');
    assert.ok(existsSync(fresh), '宽限窗口内的空桶不动');
    assert.deepEqual(r, { records: 0, buckets: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
