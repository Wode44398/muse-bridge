import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { pickRecord, parentOf, isBtwChild, buildLineage, desktopLineage, desktopLineageSettled, resetDesktopLineage, desktopSessionsDirs } from './desktop-lineage.mjs';

const rec = (id, extra = {}) => ({ id, cli: 'c-' + id, at: 1, ...extra });

test('parentOf：照官方 q_ 的四种来源', () => {
  assert.equal(parentOf(rec('a')), undefined);
  assert.equal(parentOf(rec('b', { sf: { id: 'a', side: true } })), 'a');                 // side_session
  assert.equal(parentOf(rec('b', { sf: { id: 'a' } })), 'a');                             // 老数据无标志 = suggested_task
  assert.equal(parentOf(rec('b', { fork: 'f' })), 'f');                                   // fork
  assert.equal(parentOf(rec('b', { sf: { id: 'a', side: true, userFork: true }, fork: 'f' })), 'f');
  assert.equal(parentOf(rec('b', { sf: { id: 'a', side: true }, fork: 'a' })), 'a');
  assert.equal(parentOf(rec('b', { sf: { id: 'a' }, detached: true })), undefined);      // 移到顶层
  assert.equal(parentOf(rec('b', { sf: { id: 'b' } })), undefined);                      // 指向自己
});

test('buildLineage：后代一律上溯到根、只缩一级；环不死循环；缺 cli 的跳过', () => {
  const { rootOf, members } = buildLineage([
    rec('root'),
    rec('kid', { sf: { id: 'root', side: true }, cwd: 'W1' }),
    rec('grand', { sf: { id: 'kid' } }),
    rec('x', { sf: { id: 'y' } }), rec('y', { sf: { id: 'x' } }),
    rec('orphan', { sf: { id: 'gone' } }),
    { id: 'nocli', at: 1, sf: { id: 'root' } },
  ]);
  assert.equal(rootOf.get('c-kid'), 'c-root');
  assert.equal(rootOf.get('c-grand'), 'c-root');
  assert.ok(!rootOf.has('c-orphan'));
  assert.ok(!rootOf.has('c-root'));
  assert.ok(rootOf.has('c-x') || rootOf.has('c-y'));   // 环：认到一头即可，不挂死
  assert.equal(members.get('c-kid').cwd, 'W1');
  assert.ok(members.has('c-root'));
});

test('buildLineage：同一 local_ id 多份（多账号目录）取最新那份', () => {
  const { rootOf } = buildLineage([
    rec('root'), rec('p2'),
    rec('kid', { at: 5, sf: { id: 'p2' } }),
    rec('kid', { at: 1, sf: { id: 'root' } }),
  ]);
  assert.equal(rootOf.get('c-kid'), 'c-p2');
});

test('侧边对话（btw）：照官方 isBtwChild 不进血缘、单独收进 btw；移到顶层的照常', () => {
  const r = pickRecord({ sessionId: 'local_3b', cliSessionId: '3b', forkedFromSessionId: 'local_p', lastActivityAt: 2,
    spawnedFrom: { sessionId: 'local_p', sideSession: true, userFork: true, btw: true, name: 'x-fork' } });
  assert.deepEqual(r.sf, { id: 'local_p', side: true, userFork: true, btw: true });
  assert.ok(isBtwChild(r));
  assert.ok(!isBtwChild({ ...r, detached: true }));
  assert.ok(!isBtwChild(rec('k', { sf: { id: 'p', side: true, userFork: true } })));   // 普通分叉不是
  const snap = buildLineage([
    rec('p'),
    rec('side', { sf: { id: 'p', side: true, userFork: true, btw: true }, fork: 'p', alt: ['c-old'] }),
    rec('fork', { sf: { id: 'p', side: true, userFork: true }, fork: 'p' }),
    rec('loose', { sf: { id: 'p', side: true, userFork: true, btw: true }, fork: 'p', detached: true }),
  ]);
  assert.deepEqual([...snap.btw].sort(), ['c-old', 'c-side']);
  assert.ok(!snap.rootOf.has('c-side') && !snap.parentOf.has('c-side') && !snap.members.has('c-side'));
  assert.equal(snap.rootOf.get('c-fork'), 'c-p');
  assert.ok(!snap.rootOf.has('c-loose') && !snap.btw.has('c-loose'));
});

test('pickRecord：只留血缘字段', () => {
  const r = pickRecord({ sessionId: 'local_1', cliSessionId: 'abc', cwd: 'C:/w', worktreeName: 'n', remoteMcpServersConfig: { huge: 1 },
    spawnedFrom: { sessionId: 'local_0', taskId: 't', sideSession: true }, lastActivityAt: 9 });
  assert.deepEqual(r, { id: 'local_1', cli: 'abc', cwd: 'C:/w', branch: undefined, wtName: 'n', title: undefined, at: 9, sf: { id: 'local_0', side: true, userFork: false } });
  assert.equal(pickRecord({}), null);
});

test('pickRecord / buildLineage：留下 Desktop 标题，同 local_ id 多份取最新，空标题不收', () => {
  assert.equal(pickRecord({ sessionId: 'local_1', cliSessionId: 'abc', title: '施工：1.9 成稿排版层' }).title, '施工：1.9 成稿排版层');
  assert.equal(pickRecord({ sessionId: 'local_1', title: '' }).title, undefined);
  const { titles } = buildLineage([
    rec('k', { at: 1, title: '旧名' }), rec('k', { at: 5, title: '新名' }),
    rec('t', { title: '施工：1.9 成稿排版层', sf: { id: 'k', side: true } }),
    rec('n'),                                   // 没标题
    { id: 'nocli', at: 1, title: '无 cli' },    // 没 cli id：对不上 bridge 会话
  ]);
  assert.equal(titles.get('c-k'), '新名');
  assert.equal(titles.get('c-t'), '施工：1.9 成稿排版层');
  assert.ok(!titles.has('c-n'));
  assert.equal(titles.size, 2);
});

test('desktopLineage：后台增量扫描 + 落盘缓存 + 只重读变了的文件', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  try {
    const dir = path.join(root, 'sessions');
    const org = path.join(dir, 'acct', 'org');
    mkdirSync(org, { recursive: true });
    const put = (id, d) => writeFileSync(path.join(org, `local_${id}.json`), JSON.stringify({ sessionId: 'local_' + id, ...d }));
    put('aaaa', { cliSessionId: 'P' });
    put('dddd', { cliSessionId: 'T', title: '施工：1.9 成稿排版层' });
    put('bbbb', { cliSessionId: 'K', spawnedFrom: { sessionId: 'local_aaaa', taskId: 't' } });
    writeFileSync(path.join(org, 'local_cccc.json'), '{"sessionId":"local_cc');   // 写到一半的文件：跳过不炸
    const cacheFile = path.join(root, 'cache.json');
    resetDesktopLineage();
    assert.equal(desktopLineage({ dir, cacheFile, now: 1e9 }).rootOf.size, 0);   // 首轮扫描还没回来
    await desktopLineageSettled();
    assert.equal(desktopLineage({ dir, cacheFile, now: 1e9 + 1 }).rootOf.get('K'), 'P');
    assert.equal(desktopLineage({ dir, cacheFile, now: 1e9 + 1 }).titles.get('T'), '施工：1.9 成稿排版层');
    assert.ok(existsSync(cacheFile));

    // 重启（清内存态）后直接从缓存出结果
    resetDesktopLineage();
    assert.equal(desktopLineage({ dir, cacheFile, now: 1 }).rootOf.get('K'), 'P');
    assert.equal(desktopLineage({ dir, cacheFile, now: 1 }).titles.get('T'), '施工：1.9 成稿排版层');
    await desktopLineageSettled();

    // 子会话被「移到顶层」：文件变了才重读
    put('bbbb', { cliSessionId: 'K', spawnedFrom: { sessionId: 'local_aaaa', taskId: 't' }, lineageDetached: true });
    const f = path.join(org, 'local_bbbb.json');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    desktopLineage({ dir, cacheFile, now: 1e12 });
    await desktopLineageSettled();
    assert.equal(desktopLineage({ dir, cacheFile, now: 1e12 + 1 }).rootOf.has('K'), false);
  } finally {
    resetDesktopLineage();
    rmSync(root, { recursive: true, force: true });
  }
});

test('desktopSessionsDirs：Desktop 3.x 的 Claude-Data/claude_* 优先，旧 %APPDATA% 兜底，只留存在的；环境变量覆盖', () => {
  const env = { LOCALAPPDATA: 'L', APPDATA: 'R' };
  const have = new Set([
    path.join('L', 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude-code-sessions'),
    path.join('R', 'Claude', 'claude-code-sessions'),
  ]);
  const readdir = (p) => (p === path.join('L', 'Claude-Data') ? ['claude_pzs8sxrjxfjjc', 'README.txt'] : []);
  assert.deepEqual(desktopSessionsDirs(env, 'win32', { exists: (p) => have.has(p), readdir }), [...have]);
  // 包名后缀不写死：换一个后缀照样找到
  const readdir2 = () => ['claude_other1234'];
  const want2 = path.join('L', 'Claude-Data', 'claude_other1234', 'claude-code-sessions');
  assert.deepEqual(desktopSessionsDirs(env, 'win32', { exists: (p) => p === want2, readdir: readdir2 }), [want2]);
  assert.deepEqual(desktopSessionsDirs(env, 'win32', { exists: () => false, readdir }), []);
  assert.deepEqual(desktopSessionsDirs({ BRIDGE_DESKTOP_SESSIONS_DIR: ['A', 'B'].join(path.delimiter) }, 'win32'), ['A', 'B']);
});

test('pickRecord：抽 isArchived / titleSource / 派生任务名 / 旧 cli id', () => {
  const r = pickRecord({ sessionId: 'local_1', cliSessionId: 'abc', isArchived: true, titleSource: 'tool',
    spawnedFrom: { sessionId: 'local_0', title: '施工：分享页' }, priorCliSessionIds: ['old1', 'abc'], preClearCliSessionId: 'old2' });
  assert.equal(r.arch, true);
  assert.equal(r.ts, 'tool');
  assert.equal(r.title, '施工：分享页');           // 没有 title 时用 spawnedFrom.title
  assert.deepEqual(r.alt, ['old1', 'old2']);       // 去掉与主 id 相同的
  assert.equal(pickRecord({ sessionId: 'local_2', isArchived: false }).arch, undefined);
});

test('buildLineage：多账号副本平局（归档不改 lastActivityAt）按文件 mtime 取最新；归档集合含旧 cli id', () => {
  const snap = buildLineage([
    { ...rec('s', { at: 7 }), fm: 200, arch: true, alt: ['s-old'], title: '新' },
    { ...rec('s', { at: 7 }), fm: 100, title: '旧' },
    { ...rec('t', { at: 7 }), fm: 100, arch: true },
    { ...rec('t', { at: 7 }), fm: 300 },                 // 后来取消归档的那份更新
  ]);
  assert.ok(snap.archived.has('c-s'));
  assert.ok(snap.archived.has('s-old'));
  assert.ok(!snap.archived.has('c-t'));
  assert.equal(snap.titles.get('c-s'), '新');
  assert.equal(snap.titles.get('s-old'), '新');
  // 顺序反过来也一样（以前平局取最后遍历到的那份）
  const snap2 = buildLineage([{ ...rec('s', { at: 7 }), fm: 100 }, { ...rec('s', { at: 7 }), fm: 200, arch: true }]);
  assert.ok(snap2.archived.has('c-s'));
  const snap3 = buildLineage([{ ...rec('s', { at: 7 }), fm: 200, arch: true }, { ...rec('s', { at: 7 }), fm: 100 }]);
  assert.ok(snap3.archived.has('c-s'));
});

test('desktopLineage：多个根目录合并扫描，缓存带文件 mtime', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dl2-'));
  try {
    const d1 = path.join(root, 'Claude-Data', 'claude_x', 'claude-code-sessions');
    const d2 = path.join(root, 'Claude', 'claude-code-sessions');
    for (const d of [d1, d2]) mkdirSync(path.join(d, 'acct', 'org'), { recursive: true });
    writeFileSync(path.join(d1, 'acct', 'org', 'local_aaaa.json'), JSON.stringify({ sessionId: 'local_aaaa', cliSessionId: 'P', isArchived: true, title: '父' }));
    writeFileSync(path.join(d2, 'acct', 'org', 'local_bbbb.json'), JSON.stringify({ sessionId: 'local_bbbb', cliSessionId: 'K', spawnedFrom: { sessionId: 'local_aaaa' } }));
    const cacheFile = path.join(root, 'cache.json');
    resetDesktopLineage();
    desktopLineage({ dirs: [d1, d2], cacheFile, now: 1e9 });
    await desktopLineageSettled();
    const s = desktopLineage({ dirs: [d1, d2], cacheFile, now: 1e9 + 1 });
    assert.equal(s.rootOf.get('K'), 'P');
    assert.ok(s.archived.has('P'));
    assert.equal(s.titles.get('P'), '父');
    // 重启后从缓存直接出（含归档态）
    resetDesktopLineage();
    assert.ok(desktopLineage({ dirs: [d1, d2], cacheFile, now: 1 }).archived.has('P'));
    await desktopLineageSettled();
    // 根目录集合变了：仍在的根下的条目保留
    resetDesktopLineage();
    const only1 = desktopLineage({ dirs: [d1], cacheFile, now: 1 });
    assert.ok(only1.titles.has('P'));
    assert.ok(!only1.rootOf.has('K'));
    await desktopLineageSettled();
  } finally {
    resetDesktopLineage();
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildLineage：归档集合带 Desktop 最后碰它的时刻（max(lastActivityAt, lastFocusedAt)）；parentOf 给直接父、跳过没有 cli 的中间层', () => {
  assert.equal(pickRecord({ sessionId: 'local_1', cliSessionId: 'abc', lastFocusedAt: 42 }).lf, 42);
  assert.equal(pickRecord({ sessionId: 'local_1', cliSessionId: 'abc' }).lf, undefined);
  const snap = buildLineage([
    rec('root'),
    { id: 'mid', at: 1, sf: { id: 'root', side: true } },          // 中间一层没有 cli
    rec('kid', { sf: { id: 'mid', side: true } }),
    rec('kid2', { sf: { id: 'kid', side: true } }),
    rec('arch', { at: 10, lf: 30, arch: true }),
  ]);
  assert.equal(snap.parentOf.get('c-kid'), 'c-root', '中间层没有 cli：接到再往上最近的那个');
  assert.equal(snap.parentOf.get('c-kid2'), 'c-kid');
  assert.equal(snap.rootOf.get('c-kid2'), 'c-root');
  assert.equal(snap.archived.get('c-arch'), 30);
  assert.ok(!snap.parentOf.has('c-root'));
});

test('后台扫完通知：冷启动首轮（没有缓存）、Desktop 里归档变了各通知一次；别的变化（新子会话）不通知', async () => {
  const { onDesktopLineageChange, lineageFor } = await import('./desktop-lineage.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'dl3-'));
  const dir = path.join(root, 'sessions');
  const org = path.join(dir, 'acct', 'org');
  mkdirSync(org, { recursive: true });
  const put = (id, d) => { const f = path.join(org, `local_${id}.json`); writeFileSync(f, JSON.stringify({ sessionId: 'local_' + id, ...d })); utimesSync(f, new Date(), new Date(Date.now() + Math.random() * 1e6)); };
  put('aaaa', { cliSessionId: 'P' });
  put('bbbb', { cliSessionId: 'K', spawnedFrom: { sessionId: 'local_aaaa', taskId: 't' } });
  const prevEnv = process.env.BRIDGE_DESKTOP_SESSIONS_DIR, prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.BRIDGE_DESKTOP_SESSIONS_DIR = dir;
  delete process.env.CLAUDE_CONFIG_DIR;
  const got = [];
  const off = onDesktopLineageChange((ctx, info) => got.push([ctx.key, info.cold, info.archivedChanged]));
  try {
    resetDesktopLineage();
    const ctx = { kind: 'admin', key: 'admin', dataDir: root };
    assert.equal(lineageFor(ctx).rootOf.size, 0);   // 首轮还没回来
    await desktopLineageSettled();
    assert.deepEqual(got, [['admin', true, false]]);
    // 新子会话：不通知
    put('cccc', { cliSessionId: 'C', spawnedFrom: { sessionId: 'local_aaaa', taskId: 't2' } });
    desktopLineage({ dirs: [dir], cacheFile: path.join(root, 'desktop-lineage-cache.json'), now: Date.now() + 1e7 });
    await desktopLineageSettled();
    assert.equal(got.length, 1);
    // Desktop 里归档了一条：通知
    put('aaaa', { cliSessionId: 'P', isArchived: true });
    desktopLineage({ dirs: [dir], cacheFile: path.join(root, 'desktop-lineage-cache.json'), now: Date.now() + 2e7 });
    await desktopLineageSettled();
    assert.deepEqual(got[1], ['admin', false, true]);
    // 有缓存的重启：不算冷启动
    resetDesktopLineage();
    lineageFor(ctx);
    await desktopLineageSettled();
    assert.equal(got.length, 2);
  } finally {
    off();
    if (prevEnv === undefined) delete process.env.BRIDGE_DESKTOP_SESSIONS_DIR; else process.env.BRIDGE_DESKTOP_SESSIONS_DIR = prevEnv;
    if (prevCfg !== undefined) process.env.CLAUDE_CONFIG_DIR = prevCfg;
    resetDesktopLineage();
    rmSync(root, { recursive: true, force: true });
  }
});
