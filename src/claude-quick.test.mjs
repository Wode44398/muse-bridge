// 临时对话（原「快照」）：一条对话一只桶、全部列出、按时间回收进回收站、可恢复（S1-6，2026-10-22）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  newQuickProject, quickProject, quickProjects, pruneQuick, keepQuick, quickExpiries,
  listRecycledQuick, recycledQuickCount, restoreQuick, legacyQuickSlot, schedulePruneQuick, quickOrphans,
  QUICK_NAME, QUICK_TTL_DAYS,
} from './claude-quick.mjs';
import { sessionsDir } from './runtime/paths.mjs';

// 沙箱用户身份：桶落 <dataDir>/quickchat（admin 会落真实主目录，测试别碰）。
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'quick-prune-'));
  const ctx = { kind: 'user', key: 'u:t', cwd: root, dataDir: root, configDir: path.join(root, 'claude'), claudeProjects: path.join(root, 'claude-projects.json') };
  return { root, ctx };
}
const DAY = 24 * 3600e3;
const HOUR = 3600e3;
function record(ctx, bucketPath, id, ageMs, now) {
  const dir = sessionsDir(bucketPath, ctx.configDir);
  mkdirSync(path.join(dir, id), { recursive: true });   // 子 agent 子目录
  const file = path.join(dir, id + '.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: '问个问题 ' + id.slice(0, 4) } }) + '\n');
  const t = new Date(now - ageMs);
  utimesSync(file, t, t);
  return file;
}
const age = (p, ms, now) => { const t = new Date(now - ms); utimesSync(p, t, t); };
const sid = (n) => `${String(n).padStart(8, '0')}-aaaa-bbbb-cccc-000000000000`;

test('当前桶永远是没用过的空桶：用过就换一只，用过的照常列出', () => {
  const { root, ctx } = fixture();
  try {
    const a = quickProject(ctx);
    assert.equal(a.name, QUICK_NAME);
    assert.ok(a.current && a.quick);
    assert.equal(newQuickProject(ctx).id, a.id, '没用过：新建临时对话还是这一只，不多铸');
    record(ctx, a.path, sid(1), 0, Date.now());
    const b = quickProject(ctx);
    assert.notEqual(b.id, a.id, '用过了：换上一只新的空桶');
    const list = quickProjects(ctx);
    assert.equal(list[0].id, b.id, '当前桶排最前');
    assert.ok(list.some((p) => p.id === a.id && !p.current && p.path === a.path), '用过的旧桶仍在列表里');
    // 只放了文件、还没对话记录的【不算】用过：空白临时对话里先传的文件要和随后的第一条留在同一只桶
    writeFileSync(path.join(b.path, 'notes.md'), 'x');
    assert.equal(quickProject(ctx).id, b.id, '传了文件，当前桶不换');
    assert.equal(newQuickProject(ctx).id, b.id, '新建临时对话也还落进它（文件在里面）');
    record(ctx, b.path, sid(2), 0, Date.now());
    assert.notEqual(quickProject(ctx).id, b.id, '发出第一条之后才换');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('只有文件、没有对话记录的桶：回收扫描报成 orphans（不进回收站、不删），过期照样进回收站', async () => {
  const { root, ctx } = fixture();
  try {
    const now = Date.now();
    const a = quickProject(ctx);
    const f = record(ctx, a.path, sid(3), DAY, now);
    const b = quickProject(ctx);   // a 有了对话记录，当前桶换成 b
    assert.notEqual(b.id, a.id);
    writeFileSync(path.join(a.path, 'data.csv'), '1,2');
    rmSync(f);   // 删光了对话，文件还在
    age(a.path, 5 * DAY, now);
    writeFileSync(path.join(b.path, 'draft.md'), 'x');   // 当前桶里只有文件：当前桶不算 orphan
    const r = await pruneQuick(ctx, { now });
    assert.equal(r.recycled, 0);
    assert.equal(r.empty, 0, '有文件的不当空桶删');
    assert.deepEqual(r.orphans.map((o) => [o.id, o.items]), [[a.id, 1]]);
    assert.ok(Math.abs(r.orphans[0].expiresAt - (now + 25 * DAY)) < 2000, '到期时刻按桶目录的最后修改算');

    // 节流版跑完记下名单，会话列表接口经 quickOrphans 取；「继续保留」之后到期时刻按桶目录现在的修改时间重算
    const sctx = { ...ctx, key: 'u:orphans' };
    schedulePruneQuick(sctx, { now });
    for (let i = 0; i < 200 && !quickOrphans(sctx).length; i++) await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(quickOrphans(sctx).map((o) => o.id), [a.id]);
    keepQuick(ctx, a.id, { now });
    assert.ok(Math.abs(quickOrphans(sctx)[0].expiresAt - (now + 30 * DAY)) < 2000);
    age(a.path, 5 * DAY, now);

    const r2 = await pruneQuick(ctx, { now: now + 26 * DAY });
    assert.equal(r2.recycled, 1, '过期照样进回收站（可恢复）');
    const [item] = await listRecycledQuick(ctx);
    assert.equal(item.id, a.id);
    assert.equal(item.files.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacyQuickSlot：老前端只认一只——最近活动的用过的桶；刚明确开过新的就是当前空桶', () => {
  const { root, ctx } = fixture();
  try {
    const now = Date.now();
    const a = quickProject(ctx);
    assert.equal(legacyQuickSlot(ctx, []), a.id, '一条临时对话都没有：当前空桶');
    record(ctx, a.path, sid(1), HOUR, now);
    const cur = quickProject(ctx);   // a 用过了，自动换了一只空桶（没人明确要）
    const rows = [{ projectId: a.id, mtime: now - HOUR }];
    assert.equal(legacyQuickSlot(ctx, rows), a.id, '自动换上的空桶不顶掉正在用的那条');
    assert.equal(newQuickProject(ctx).id, cur.id);
    assert.equal(legacyQuickSlot(ctx, rows), cur.id, '「新建快照」之后：当前空桶');
    assert.equal(legacyQuickSlot(ctx, [{ projectId: a.id, mtime: now + 1000 }]), a.id, '之后又在旧的那条里聊了：回到它');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pruneQuick 按最后活动回收：30 天内的不动，过期的整只进回收站（对话记录留原处），空桶过宽限直接删', async () => {
  const { root, ctx } = fixture();
  try {
    const now = Date.now();
    const fresh = quickProject(ctx);
    record(ctx, fresh.path, sid(1), 29 * DAY, now);   // 29 天前聊过：还剩 1 天，不动
    age(fresh.path, 29 * DAY, now);
    const old = quickProject(ctx);
    const oldRec = record(ctx, old.path, sid(2), 31 * DAY, now);
    writeFileSync(path.join(old.path, 'report.md'), '产物');
    age(old.path, 31 * DAY, now);
    const kept = quickProject(ctx);   // 记录很老、但桶目录最近动过（「继续保留」/ 新写了产物）
    record(ctx, kept.path, sid(3), 40 * DAY, now);
    writeFileSync(path.join(kept.path, 'x.txt'), '1');
    const empty = quickProject(ctx).path;   // 被下面这只顶掉的空桶（多台设备同时换桶多铸的那种）
    age(empty, HOUR, now);
    writeFileSync(path.join(root, 'claude-quick.json'), JSON.stringify({ id: 'x', path: path.join(root, 'nope') }));   // 当前桶记录坏了：现铸
    const cur = quickProject(ctx);

    const r = await pruneQuick(ctx, { now });
    assert.deepEqual(r, { recycled: 1, purged: 0, empty: 1, orphans: [] });
    assert.ok(existsSync(fresh.path), '29 天的还在');
    assert.ok(existsSync(kept.path), '桶目录最近动过的还在');
    assert.ok(!existsSync(old.path), '31 天没动的挪走了');
    assert.ok(existsSync(oldRec), '对话记录留在原处（恢复时原样接上）');
    assert.ok(!existsSync(empty), '没用过的空桶过了宽限直接删');
    assert.ok(existsSync(cur.path), '当前桶不动');
    assert.equal(recycledQuickCount(ctx), 1);
    assert.ok(!quickProjects(ctx).some((p) => p.id === old.id), '进了回收站就不在列表里了');

    const [item] = await listRecycledQuick(ctx);
    assert.equal(item.id, old.id);
    assert.equal(item.items, 1, '看得出桶里有产物');
    assert.deepEqual(item.files.map((f) => f.id), [sid(2)]);
    assert.equal(item.purgeAt - item.recycledAt, 30 * DAY);

    // 恢复：桶回到列表、产物和对话记录都接上，并重新计时
    const p = restoreQuick(ctx, old.id, { now });
    assert.equal(p.path, old.path);
    assert.equal(readFileSync(path.join(old.path, 'report.md'), 'utf8'), '产物');
    assert.ok(quickProjects(ctx).some((q) => q.id === old.id));
    assert.equal(recycledQuickCount(ctx), 0);
    const r2 = await pruneQuick(ctx, { now });
    assert.equal(r2.recycled, 0, '刚恢复的不会马上又被收走');
    assert.throws(() => restoreQuick(ctx, old.id), /没有/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('回收站放满期限才永久删除（桶 + 对话记录），并通知调用方清掉偏好', async () => {
  const { root, ctx } = fixture();
  try {
    const now = Date.now();
    const b = quickProject(ctx);
    const f = record(ctx, b.path, sid(7), 31 * DAY, now);
    age(b.path, 31 * DAY, now);
    quickProject(ctx);
    assert.equal((await pruneQuick(ctx, { now })).recycled, 1);
    const dropped = [];
    const later = now + 31 * DAY;
    const r = await pruneQuick(ctx, { now: later, onDrop: (id) => dropped.push(id) });
    assert.equal(r.purged, 1);
    assert.ok(!existsSync(f) && !existsSync(sessionsDir(b.path, ctx.configDir)), '对话记录一起删');
    assert.deepEqual(dropped, [sid(7)]);
    assert.equal(recycledQuickCount(ctx), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pruneQuick 不动在跑的会话、已存为工作空间的桶；继续保留会重置时钟', async () => {
  const { root, ctx } = fixture();
  try {
    const now = Date.now();
    const a = quickProject(ctx);
    record(ctx, a.path, sid(4), 60 * DAY, now);
    age(a.path, 60 * DAY, now);
    const b = quickProject(ctx);
    record(ctx, b.path, sid(5), 60 * DAY, now);
    age(b.path, 60 * DAY, now);
    const c = quickProject(ctx);
    record(ctx, c.path, sid(6), 60 * DAY, now);
    age(c.path, 60 * DAY, now);
    writeFileSync(ctx.claudeProjects, JSON.stringify({ projects: [{ id: c.id, name: 'x', path: c.path }] }));
    const k = keepQuick(ctx, b.id, { now });
    assert.equal(k.expiresAt, now + QUICK_TTL_DAYS * DAY);
    const r = await pruneQuick(ctx, { now, busy: new Set([sid(4)]) });
    assert.equal(r.recycled, 0);
    assert.ok(existsSync(a.path) && existsSync(b.path) && existsSync(c.path));
    assert.ok(!quickProjects(ctx).some((p) => p.id === c.id), '存走的桶不再算临时对话');
    assert.throws(() => keepQuick(ctx, c.id), /不在/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('quickExpiries 与回收同一算法：对话记录与桶目录取最晚', async () => {
  const { root, ctx } = fixture();
  try {
    const now = Date.now();
    const a = quickProject(ctx);
    record(ctx, a.path, sid(8), 10 * DAY, now);
    age(a.path, 20 * DAY, now);
    const exp = await quickExpiries(ctx, [{ projectId: a.id, mtime: now - 10 * DAY }]);
    assert.ok(Math.abs(exp[a.id] - (now + 20 * DAY)) < 2000);
    keepQuick(ctx, a.id, { now });
    const exp2 = await quickExpiries(ctx, [{ projectId: a.id, mtime: now - 10 * DAY }]);
    assert.ok(Math.abs(exp2[a.id] - (now + 30 * DAY)) < 2000);
    assert.deepEqual(await quickExpiries(ctx, [{ projectId: 'not-a-bucket', mtime: now }]), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});
