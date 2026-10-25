// 会话标题链 / 全文索引 / 归档读侧与自动归档（2026-10-20，对齐官方 Claude Desktop 的标题、归档与搜索）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-archsearch-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
delete process.env.CLAUDE_CONFIG_DIR;
const deskDir = path.join(tmp, 'desktop', 'claude-code-sessions');
process.env.BRIDGE_DESKTOP_SESSIONS_DIR = deskDir;

const T = await import('./runtime/session-titles.mjs');
const S = await import('./runtime/session-search.mjs');
const A = await import('./runtime/session-archive-auto.mjs');
const { setArchived, _resetArchiveCache, getArchiveState } = await import('./runtime/session-archive.mjs');
const { setClaudeSettings } = await import('./runtime/claude-settings.mjs');
const { applyLibraryOp } = await import('./runtime/session-library.mjs');
const { sessionQuestions } = await import('./runtime/questions.mjs');
const { desktopLineageSettled, resetDesktopLineage, lineageFor } = await import('./runtime/desktop-lineage.mjs');

const ID = (n) => `${String(n).repeat(8)}-1111-2222-3333-444444444444`;
const line = (o) => JSON.stringify(o) + '\n';
const user = (text, extra = {}) => line({ parentUuid: null, isSidechain: false, promptId: 'p', type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: '2026-10-01T00:00:00.000Z', ...extra });
const asst = (text) => line({ parentUuid: 'x', isSidechain: false, message: { model: 'm', id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text }] }, type: 'assistant', timestamp: '2026-10-01T00:01:00.000Z' });
const stOf = (file) => { const s = statSync(file); return { size: s.size, mtime: s.mtimeMs }; };

function writeSession(dir, id, body) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  writeFileSync(file, body);
  return file;
}

// —— 标题链 ——

test('parseTitleRecords：取最后一条 custom-title / ai-title，半截首行丢掉', () => {
  const text = 'tle","customTitle":"半截"}\n' + line({ type: 'ai-title', aiTitle: '旧短标题' }) + line({ type: 'custom-title', customTitle: '我起的名' }) + line({ type: 'ai-title', aiTitle: '新短标题' });
  assert.deepEqual(T.parseTitleRecords(text, { partialHead: true }), { custom: '我起的名', ai: '新短标题' });
  assert.deepEqual(T.parseTitleRecords(user('hi')), { custom: undefined, ai: undefined });
});

test('transcriptTitles：尾部找不到时看 sidecar / 文件头；文件变长后新尾部没有就沿用旧值', async () => {
  const dir = path.join(tmp, 'titles');
  const id = ID(1);
  const pad = asst('x'.repeat(70 * 1024));   // 把 ai-title 挤出尾部 64KB
  const file = writeSession(dir, id, user('第一句') + line({ type: 'ai-title', aiTitle: '会话短标题' }) + pad);
  let r = await T.transcriptTitles(file, stOf(file));
  assert.equal(r.ai, '会话短标题', '尾部没有 ai-title → 读文件头');
  assert.equal(r.custom, undefined);
  mkdirSync(path.join(dir, id), { recursive: true });
  writeFileSync(path.join(dir, id, 'custom-title.json'), JSON.stringify({ customTitle: '侧车里的名' }));
  appendFileSync(file, asst('more'));
  r = await T.transcriptTitles(file, stOf(file));
  assert.equal(r.custom, '侧车里的名');
  assert.equal(r.ai, '会话短标题', '变长后沿用');
  appendFileSync(file, line({ type: 'custom-title', customTitle: 'CLI 里改的名' }));
  r = await T.transcriptTitles(file, stOf(file));
  assert.equal(r.custom, 'CLI 里改的名');
});

test('resolveTitle：custom-title > 派生名 / Desktop 标题 > ai-title > 首条消息；其余进曾用名', async () => {
  const dir = path.join(tmp, 'chain');
  const trim = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const readFirst = async () => '帮我看看这个 bug';
  const f1 = writeSession(dir, ID(2), user('帮我看看这个 bug') + line({ type: 'ai-title', aiTitle: '排查 bug' }));
  let r = await T.resolveTitle({ id: ID(2), file: f1, ...stOf(f1) }, { desktop: 'Desktop 名', readFirst, trim });
  assert.equal(r.title, 'Desktop 名');
  assert.deepEqual(r.former, ['排查 bug'], '曾用名只算标题来源，首条消息归正文层');
  r = await T.resolveTitle({ id: ID(2), file: f1, ...stOf(f1) }, { readFirst, trim });
  assert.equal(r.title, '排查 bug', '没有 Desktop 名时用 ai-title');
  appendFileSync(f1, line({ type: 'custom-title', customTitle: '用户起的' }));
  r = await T.resolveTitle({ id: ID(2), file: f1, ...stOf(f1) }, { fam: '派生名', desktop: 'Desktop 名', readFirst, trim });
  assert.equal(r.title, '用户起的');
  const f2 = writeSession(dir, ID(3), user('只有首句'));
  r = await T.resolveTitle({ id: ID(3), file: f2, ...stOf(f2) }, { readFirst: async () => '只有首句', trim });
  assert.equal(r.title, '只有首句');
  // Desktop worktree 会话：首条消息开头整段 system-reminder 剥掉
  const f3 = writeSession(dir, ID(5), user('x'));
  r = await T.resolveTitle({ id: ID(5), file: f3, ...stOf(f3) }, { readFirst: async () => '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n修一下登录页', trim });
  assert.equal(r.title, '修一下登录页');
});

// —— 全文索引 ——

test('takeLine：只收用户 / 助手正文——工具结果、思考、注入、附件注入段、侧链都不进', () => {
  const e = { size: 0, mtime: 0, off: 0, text: '', marks: [], lower: null };
  const feed = (s) => S.takeLine(e, Buffer.from(s.replace(/\n$/, '')));
  feed(user('真正的问题 [用户上传了以下附件，绝对路径如下]\n- C:\\secret\\a.png'));
  feed(line({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 't', type: 'tool_result', content: '工具输出不该进索引' }] } }));
  feed(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '思考不该进' }] } }));
  feed(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'rm 不该进' } }] } }));
  feed(user('<system-reminder>注入不该进</system-reminder>'));
  feed(user('侧链不该进', { isSidechain: true }));
  feed(user('meta 不该进', { isMeta: true }));
  feed(asst('助手的   回答\n\n第二段'));
  feed(line({ type: 'custom-title', customTitle: '自定义' }));
  assert.equal(e.text, '真正的问题\n助手的 回答 第二段');
  assert.equal(e.marks.length, 6);
  assert.equal(e.ct, '自定义');
  assert.doesNotMatch(e.text, /secret|不该/);
});

test('索引增量：文件追加只读新增部分；片段不跨消息、前 20 后 80 带省略号；超长行跳过', async () => {
  S._resetSearchIndex();
  const dir = path.join(tmp, 'idx');
  const long = '甲'.repeat(30) + '关键词' + '乙'.repeat(100);
  const f = writeSession(dir, ID(4), user('上一条消息') + asst(long) + user('下一条消息'));
  const e = await S.ensureIndexed({ file: f, ...stOf(f) });
  const m = S.findInEntry(e, S.normQuery('关键词'));
  assert.equal(m.snippet, '…' + '甲'.repeat(20) + '关键词' + '乙'.repeat(80) + '…');
  assert.equal(m.role, 'assistant');
  assert.ok(m.matchAt > 0);
  const off = e.off;
  appendFileSync(f, line({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { data: 'A'.repeat(5 << 20) } }, { type: 'text', text: '图片里的字' }] } }) + user('Append Later'));
  const e2 = await S.ensureIndexed({ file: f, ...stOf(f) });
  assert.ok(e2.off > off);
  assert.ok(S.findInEntry(e2, S.normQuery('append later')), '大小写不敏感、追加的部分也搜得到');
  assert.equal(S.findInEntry(e2, S.normQuery('图片里的字')), null, '超长行（>4MB）跳过');
  assert.equal(S.findInEntry(e2, S.normQuery('消息 甲')), null, '不跨消息');
});

// —— 归档读侧与自动归档 ——

const ctxA = { kind: 'admin', key: 'admin', dataDir: path.join(tmp, 'admin'), shell: true, cwd: tmp, configDir: null };
mkdirSync(ctxA.dataDir, { recursive: true });

test('archiveView：bridge 记录 > 取消过 > 跟随 Desktop（可关）', async () => {
  const org = path.join(deskDir, 'acct', 'org');
  mkdirSync(org, { recursive: true });
  writeFileSync(path.join(org, 'local_aaaa.json'), JSON.stringify({ sessionId: 'local_aaaa', cliSessionId: ID(5), isArchived: true }));
  writeFileSync(path.join(org, 'local_bbbb.json'), JSON.stringify({ sessionId: 'local_bbbb', cliSessionId: ID(6), isArchived: true }));
  resetDesktopLineage();
  lineageFor(ctxA);
  await desktopLineageSettled();
  assert.ok(lineageFor(ctxA).archived.has(ID(5)));
  setArchived(ctxA, [ID(7)], true);
  setArchived(ctxA, [ID(6)], false);
  let v = A.archiveView(ctxA);
  assert.equal(v(ID(5)).reason, 'desktop');
  assert.equal(v(ID(6)), null, '在 bridge 里取消过 → 不再跟随 Desktop');
  assert.equal(v(ID(7)).reason, 'manual');
  assert.equal(v(ID(8)), null);
  setClaudeSettings(ctxA, { followDesktopArchive: false });
  v = A.archiveView(ctxA);
  assert.equal(v(ID(5)), null, '关掉跟随');
  assert.equal(v(ID(7)).reason, 'manual');
  setClaudeSettings(ctxA, { followDesktopArchive: null });
  // 非管理员不跟随 Desktop
  const u = { kind: 'user', key: 'u:x', dataDir: path.join(tmp, 'ux'), shell: false, sandbox: true };
  mkdirSync(u.dataDir, { recursive: true });
  assert.equal(A.archiveView(u)(ID(5)), null);
});

test('archiveSessions：在工作的会话不归档；取消归档后不再被自动归档', () => {
  sessionQuestions.set(ID(9), { qid: 'q', questions: [], ts: 1 });
  try {
    const r = A.archiveSessions(ctxA, [ID(9), ID(1)], true);
    assert.deepEqual(r.skipped, [ID(9)]);
    assert.ok(r.archive.archived[ID(1)]);
    A.archiveSessions(ctxA, [ID(1)], false);
    _resetArchiveCache();
    assert.ok(!A.archiveView(ctxA)(ID(1)));
  } finally { sessionQuestions.delete(ID(9)); }
});

test('autoArchiveCandidates：N 天无活动才归档；收藏 / 在工作 / 取消过 / 已归档 / 关掉设置都不动', async () => {
  const now = Date.UTC(2026, 9, 20);
  const day = 86_400_000;
  const files = [
    { id: ID(2), mtime: now - 10 * day },   // 候选
    { id: ID(3), mtime: now - 1 * day },    // 太新
    { id: ID(4), mtime: now - 10 * day },   // 收藏
    { id: ID(1), mtime: now - 10 * day },   // 取消归档过（上一个用例）
    { id: ID(7), mtime: now - 10 * day },   // 已归档
    { id: ID(9), mtime: now - 10 * day },   // 在等回答
    { id: ID(5), mtime: now - 10 * day },   // 扣着别的会话发来的消息等确认（session-peers hold 档）
  ];
  assert.deepEqual(A.autoArchiveCandidates(ctxA, { now, files }), [], '默认关');
  setClaudeSettings(ctxA, { autoArchiveDays: 7 });
  applyLibraryOp(ctxA, { op: 'star', id: ID(4), on: true });
  sessionQuestions.set(ID(9), { qid: 'q', questions: [], ts: 1 });
  const peers = await import('./runtime/session-peers.mjs');
  peers.notePeerHold(ctxA, ID(5), { state: 'held', message_uuid: 'm-auto', from: 'uds:x' }, async () => {});
  try {
    assert.deepEqual(A.autoArchiveCandidates(ctxA, { now, files }), [ID(2)]);
    assert.equal(A.sweepAutoArchive(ctxA, { now, files }), 1);
    assert.equal(A.archiveView(ctxA)(ID(2)).reason, 'inactive');
    assert.equal(A.sweepAutoArchive(ctxA, { now, files }), 0, '幂等');
  } finally {
    sessionQuestions.delete(ID(9));
    peers._resetPeers();
    setClaudeSettings(ctxA, { autoArchiveDays: null });
  }
});

// —— 全文搜索查询（三层 + 已归档筛选 + library 改名）——

test('searchSessions：标题 / 曾用名 / 宽松 / 正文四层排序；已归档 include·exclude·only；空查询列最近的', async () => {
  S._resetSearchIndex();
  const { sessionsDir } = await import('./runtime/paths.mjs');
  const base = path.join(tmp, 'us');
  const ctxU = { kind: 'user', key: 'u:s', name: 's', dataDir: base, cwd: path.join(base, 'ws'), configDir: path.join(base, 'cfg'), claudeProjects: path.join(base, 'claude-projects.json'), sandbox: true, shell: false };
  mkdirSync(ctxU.cwd, { recursive: true });
  const dir = sessionsDir(ctxU.cwd, ctxU.configDir);
  const [a, b, c, d] = [ID('a'), ID('b'), ID('c'), ID('d')];
  writeSession(dir, a, user('帮我看下 build 脚本') + asst('脚本里少了 set -e') + line({ type: 'ai-title', aiTitle: '部署脚本修复' }));
  writeSession(dir, b, user('hello') + asst('关于归档的讨论') + line({ type: 'ai-title', aiTitle: '旧的自动标题' }) + line({ type: 'custom-title', customTitle: '我改的名' }));
  writeSession(dir, c, user('第一句话是关于火锅') + asst('好的'));
  writeSession(dir, d, user('xyz 开场') + asst('火锅店推荐：楼下那家'));
  setArchived(ctxU, [d], true);
  const readFirst = async (file) => {
    for (const l of (await import('node:fs')).readFileSync(file, 'utf8').split('\n')) {
      try { const o = JSON.parse(l); if (o.type === 'user') return o.message.content[0].text; } catch {}
    }
    return '';
  };
  const trim = (s) => String(s || '').trim();
  const q = (query, opts = {}) => S.searchSessions(ctxU, query, { readFirst, trim, ...opts });

  let r = await q('部署');
  assert.deepEqual(r.hits.map((h) => [h.sessionId, h.match]), [[a, 'title']]);
  assert.equal(r.hits[0].title, '部署脚本修复');
  r = await q('旧的自动');
  assert.deepEqual(r.hits.map((h) => [h.sessionId, h.match, h.former]), [[b, 'former', '旧的自动标题']]);
  assert.equal(r.hits[0].title, '我改的名', 'custom-title 压过 ai-title');
  r = await q('火锅');
  assert.deepEqual(r.hits.map((h) => [h.sessionId, h.match, h.archived]), [[c, 'title', false], [d, 'text', true]]);
  assert.match(r.hits[1].snippet, /火锅店推荐/);
  assert.equal(r.hits[1].archivedReason, 'manual');
  r = await q('set -e');
  assert.deepEqual(r.hits.map((h) => [h.sessionId, h.match]), [[a, 'text']], '正文里的助手回答也搜得到');
  r = await q('ws 部署');
  assert.deepEqual(r.hits.map((h) => [h.sessionId, h.match]), [[a, 'loose']], '宽松层：词分开命中标题与项目名');
  assert.deepEqual((await q('火锅', { archived: 'exclude' })).hits.map((h) => h.sessionId), [c]);
  assert.deepEqual((await q('火锅', { archived: 'only' })).hits.map((h) => h.sessionId), [d]);
  r = await q('');
  assert.equal(r.hits.length, 3, '空查询列最近的，不含已归档');
  assert.ok(r.hits.every((h) => h.match === 'recent' && !h.archived));
  assert.equal((await q('', { limit: 2 })).hits.length, 2);
  // bridge 里改的名（library）参与标题层，原标题退成曾用名
  applyLibraryOp(ctxU, { op: 'title', id: c, title: '我的火锅清单' });
  r = await q('清单');
  assert.deepEqual(r.hits.map((h) => [h.sessionId, h.match, h.title]), [[c, 'title', '我的火锅清单']]);
  r = await q('第一句话');
  assert.deepEqual(r.hits.map((h) => [h.sessionId, h.match, h.former]), [[c, 'former', '第一句话是关于火锅']], '改名前显示的标题（这里是首条消息）进曾用名（官方 previousTitles 同理）');
  assert.equal(r.partial, false);
});

// —— 审查修复（2026-10-20）——

test('archiveView：自动归档后 transcript 又有活动 → 视为未归档；dropStaleInactive 清记录、不记「取消过」', () => {
  const ctx = { kind: 'user', key: 'u:stale', dataDir: path.join(tmp, 'stale'), shell: false, sandbox: true };
  mkdirSync(ctx.dataDir, { recursive: true });
  const at = Date.UTC(2026, 9, 10);
  setArchived(ctx, [ID(1)], true, { reason: 'inactive', at });
  setArchived(ctx, [ID(2)], true, { reason: 'manual', at });
  const v = A.archiveView(ctx);
  assert.equal(v(ID(1), at - 5000).reason, 'inactive', '归档前的活动不算');
  assert.equal(v(ID(1), at + 30_000).reason, 'inactive', '一分钟余量内（CLI 收尾补写）不算');
  assert.equal(v(ID(1), at + 3_600_000), null, '之后又聊过 → 不再算归档');
  assert.equal(v(ID(2), at + 3_600_000).reason, 'manual', '手动归档不受影响');
  assert.deepEqual(A.dropStaleInactive(ctx, [{ id: ID(1), mtime: at + 3_600_000 }, { id: ID(2), mtime: at + 3_600_000 }]), [ID(1)]);
  _resetArchiveCache();
  const raw = JSON.parse((readFileSync(path.join(ctx.dataDir, 'claude-session-archive.json'), 'utf8')));
  assert.ok(!raw.archived[ID(1)] && !raw.unarchived[ID(1)], '记录清掉，也不记取消过（以后闲够了还能再自动归档）');
  assert.ok(raw.archived[ID(2)]);
});

test('unarchiveOnTurn：自动归档的只清记录；手动归档的记成取消归档', () => {
  const ctx = { kind: 'user', key: 'u:turn', dataDir: path.join(tmp, 'turn'), shell: false, sandbox: true };
  mkdirSync(ctx.dataDir, { recursive: true });
  setArchived(ctx, [ID(1)], true, { reason: 'inactive' });
  setArchived(ctx, [ID(2)], true);
  A.unarchiveOnTurn(ctx, ID(1));
  A.unarchiveOnTurn(ctx, ID(2));
  const raw = JSON.parse(readFileSync(path.join(ctx.dataDir, 'claude-session-archive.json'), 'utf8'));
  assert.deepEqual([!!raw.archived[ID(1)], !!raw.unarchived[ID(1)]], [false, false]);
  assert.deepEqual([!!raw.archived[ID(2)], !!raw.unarchived[ID(2)]], [false, true]);
});

test('archiveView：bridge 取消过归档后，只有 Desktop 那边之后又被碰过（活动 / 聚焦）且仍是已归档才重新跟随', async () => {
  const org = path.join(deskDir, 'acct', 'org');
  const t0 = Date.UTC(2026, 9, 1);
  writeFileSync(path.join(org, 'local_cccc.json'), JSON.stringify({ sessionId: 'local_cccc', cliSessionId: ID('c'), isArchived: true, lastActivityAt: t0, lastFocusedAt: t0 }));
  resetDesktopLineage(); lineageFor(ctxA); await desktopLineageSettled();
  setArchived(ctxA, [ID('c')], false, { at: t0 + 1000 });   // bridge 里取消归档（晚于 Desktop 那边最后一次碰它）
  assert.equal(A.archiveView(ctxA)(ID('c')), null, 'Desktop 整批重写元数据（mtime 变、时间字段不变）不会让它重新归档');
  // 之后在 Desktop 里取消归档、聊完又归档：lastFocusedAt 晚于 bridge 的取消归档
  writeFileSync(path.join(org, 'local_cccc.json'), JSON.stringify({ sessionId: 'local_cccc', cliSessionId: ID('c'), isArchived: true, lastActivityAt: t0, lastFocusedAt: t0 + 5000 }));
  resetDesktopLineage(); lineageFor(ctxA); await desktopLineageSettled();
  assert.equal(A.archiveView(ctxA)(ID('c')).reason, 'desktop');
});

test('autoArchiveCandidates：有设备正开着的会话不自动归档（官方 on_screen）', async () => {
  const { noteUiState } = await import('./runtime/ui-state.mjs');
  const now = Date.UTC(2026, 9, 20);
  const files = [{ id: ID('e'), mtime: now - 30 * 86_400_000 }, { id: ID('f'), mtime: now - 30 * 86_400_000 }];
  setClaudeSettings(ctxA, { autoArchiveDays: 7 });
  try {
    noteUiState(ctxA.key, 'client-1', 'web', { page: 'claude', claudeOpen: [ID('e')] });
    assert.deepEqual(A.autoArchiveCandidates(ctxA, { now, files }), [ID('f')]);
  } finally { setClaudeSettings(ctxA, { autoArchiveDays: null }); }
});

test('knownUntitled：解析过、没有任何标题来源的文件才算；文件变了 / 有派生名或 Desktop 标题就不算', async () => {
  T._resetTitleCache();
  const dir = path.join(tmp, 'blank');
  const f = writeSession(dir, ID(1), asst('只有助手说话'));
  const st = { id: ID(1), file: f, ...stOf(f) };
  assert.equal(T.knownUntitled(st), false, '没解析过的先算有');
  await T.resolveTitle(st, { readFirst: async () => '', trim: (s) => String(s || '').trim() });
  assert.equal(T.knownUntitled(st), true);
  assert.equal(T.knownUntitled(st, { fam: '派生名' }), false);
  appendFileSync(f, user('后来有人说话了'));
  assert.equal(T.knownUntitled({ ...st, ...stOf(f) }), false, '文件变了：重新算');
});

test('searchSessions：单个词不按项目名宽松匹配（不再被常用项目名占满）；宽松层有上限；正文也命中的归正文层', async () => {
  S._resetSearchIndex();
  const { sessionsDir } = await import('./runtime/paths.mjs');
  const base = path.join(tmp, 'flood');
  const ctxU = { kind: 'user', key: 'u:flood', name: 'flood', dataDir: base, cwd: path.join(base, 'bridge'), configDir: path.join(base, 'cfg'), claudeProjects: path.join(base, 'claude-projects.json'), sandbox: true, shell: false };
  mkdirSync(ctxU.cwd, { recursive: true });
  const dir = sessionsDir(ctxU.cwd, ctxU.configDir);
  for (let i = 0; i < 15; i++) writeSession(dir, `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`, user('闲聊 ' + i) + asst('好的'));
  writeSession(dir, ID('e'), user('讲讲 bridge 的架构') + asst('bridge 分三端'));
  const readFirst = async (file) => {
    for (const l of (await import('node:fs')).readFileSync(file, 'utf8').split('\n')) {
      try { const o = JSON.parse(l); if (o.type === 'user') return o.message.content[0].text; } catch {}
    }
    return '';
  };
  const trim = (s) => String(s || '').trim();
  let r = await S.searchSessions(ctxU, 'bridge', { readFirst, trim });
  assert.deepEqual(r.hits.map((h) => [h.sessionId, h.match]), [[ID('e'), 'title']], '项目名叫 bridge，但单个词不把整个项目拖进来');
  r = await S.searchSessions(ctxU, '分三端', { readFirst, trim });
  assert.deepEqual(r.hits.map((h) => h.match), ['text']);
  r = await S.searchSessions(ctxU, 'bridge 闲聊', { readFirst, trim });
  assert.equal(r.hits.filter((h) => h.match === 'loose').length, 10, '多个词：标题 + 项目名命中进宽松层，最多 10 条');
});

test('sessionLineage：「移到顶层」的会话自己成根，名下后代改挂到它身上；directChildren 只取直接子', async () => {
  const L = await import('./runtime/session-lineage.mjs');
  const ctx = { kind: 'user', key: 'u:lin', dataDir: path.join(tmp, 'lin'), shell: false, sandbox: true };
  mkdirSync(ctx.dataDir, { recursive: true });
  const P = ID(1), K = ID(2), G = ID(3), K2 = ID(4);
  const fam = { parentOf: new Map([[K, P], [G, K], [K2, P]]) };
  const desktop = { parentOf: new Map(), rootOf: new Map() };
  let lin = L.sessionLineage(ctx, { desktop, fam });
  assert.deepEqual([lin.rootOf.get(K), lin.rootOf.get(G), lin.rootOf.get(K2)], [P, P, P]);
  assert.deepEqual(L.directChildren(ctx, [P], lin).sort(), [K, K2].sort());
  assert.ok(L.detachSessions(ctx, [K]));
  L._resetDetachCache();
  lin = L.sessionLineage(ctx, { desktop, fam });
  assert.equal(lin.rootOf.has(K), false, 'K 成了顶层');
  assert.equal(lin.rootOf.get(G), K, 'G 改挂到 K 下');
  assert.equal(lin.rootOf.get(K2), P);
  L.forgetDetached(ctx, K);
  assert.equal(L.sessionLineage(ctx, { desktop, fam }).rootOf.get(K), P);
});

// —— 审查修复第二轮（2026-10-21）——

test('archiveView：bridge 里在 Desktop 最后一次碰它之后还聊过 → 不跟随 Desktop 的归档（Desktop 看不见 bridge 的续聊）', async () => {
  const Act = await import('./runtime/session-activity.mjs');
  const org = path.join(deskDir, 'acct', 'org');
  const t0 = Date.UTC(2026, 9, 5);
  writeFileSync(path.join(org, 'local_dddd.json'), JSON.stringify({ sessionId: 'local_dddd', cliSessionId: ID('d'), isArchived: true, lastActivityAt: t0, lastFocusedAt: t0 }));
  resetDesktopLineage(); lineageFor(ctxA); await desktopLineageSettled();
  assert.equal(A.archiveView(ctxA)(ID('d')).reason, 'desktop');
  Act.noteBridgeTurn(ctxA, ID('d'), t0 - 1000);
  assert.equal(A.archiveView(ctxA)(ID('d')).reason, 'desktop', '早于 Desktop 最后一次碰它的 bridge 轮次不算');
  Act.noteBridgeTurn(ctxA, ID('d'), t0 + 14 * 86_400_000);
  assert.equal(A.archiveView(ctxA)(ID('d')), null, 'Desktop 按它自己看到的活动（14 天前）自动归档：bridge 昨天还在聊，不跟随');
  // 之后有人在 Desktop 里打开它再归档（lastFocusedAt 更晚）→ 重新跟随
  writeFileSync(path.join(org, 'local_dddd.json'), JSON.stringify({ sessionId: 'local_dddd', cliSessionId: ID('d'), isArchived: true, lastActivityAt: t0, lastFocusedAt: t0 + 20 * 86_400_000 }));
  resetDesktopLineage(); lineageFor(ctxA); await desktopLineageSettled();
  assert.equal(A.archiveView(ctxA)(ID('d')).reason, 'desktop');
  // 轮次落盘、换进程照样认；非管理员不记（跟随 Desktop 只对管理员开）
  Act._resetActivityCache();
  assert.ok(Act.getActivity(ctxA).turns[ID('d')] > t0);
  const u = { kind: 'user', key: 'u:act', dataDir: path.join(tmp, 'uact'), shell: false, sandbox: true };
  mkdirSync(u.dataDir, { recursive: true });
  Act.noteBridgeTurn(u, ID('d'));
  assert.deepEqual(Act.getActivity(u).turns, {});
});

test('unarchiveOnTurn：每个真人轮都记下 bridge 轮次（管理员），没归档的会话也记', async () => {
  const Act = await import('./runtime/session-activity.mjs');
  const before = Date.now();
  A.unarchiveOnTurn(ctxA, ID('f'));
  assert.ok(Act.getActivity(ctxA).turns[ID('f')] >= before);
});

test('自动归档的记录：只有 mtime 变了（整批 touch）不算又有活动，文件变长才算；sweep 记下归档时的大小', async () => {
  const Act = await import('./runtime/session-activity.mjs');
  const ctx = { kind: 'user', key: 'u:size', dataDir: path.join(tmp, 'size'), shell: false, sandbox: true };
  mkdirSync(ctx.dataDir, { recursive: true });
  const now = Date.UTC(2026, 9, 20);
  const day = 86_400_000;
  setClaudeSettings(ctx, { autoArchiveDays: 7 });
  try {
    const files = [{ id: ID(1), mtime: now - 10 * day, size: 4096 }];
    assert.equal(A.sweepAutoArchive(ctx, { now, files }), 1);
    assert.equal(Act.getActivity(ctx).sizes[ID(1)], 4096);
    const at = getArchiveState(ctx).archived[ID(1)].at;
    const v = A.archiveView(ctx);
    assert.equal(v(ID(1), at + 3_600_000, 4096).reason, 'inactive', '大小没变：备份 / 同步工具整批 touch，不算活动');
    assert.equal(v(ID(1), at + 3_600_000, 5000), null, '变长了：Desktop / CLI 里接着聊过');
    assert.equal(v(ID(1), at + 3_600_000), null, '调用方不知道大小：退回只看 mtime');
    assert.deepEqual(A.dropStaleInactive(ctx, [{ id: ID(1), mtime: at + 3_600_000, size: 4096 }]), []);
    assert.deepEqual(A.dropStaleInactive(ctx, [{ id: ID(1), mtime: at + 3_600_000, size: 5000 }]), [ID(1)]);
    assert.equal(Act.getActivity(ctx).sizes[ID(1)], undefined, '记录作废时大小一起清');
  } finally { setClaudeSettings(ctx, { autoArchiveDays: null }); }
});
