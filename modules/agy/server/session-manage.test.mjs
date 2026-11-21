// Antigravity 会话管理：收藏、彻底删除（路径守卫、延后清理、墓碑挡住各接口）、全文搜索（增量索引、落盘、后台建），
// 以及 bridge 的 agent 操作带 agent:'agy' 时的分发（缺省行为不变）。
// agy 的数据目录一律指到临时目录（AGY_HOME_DIR / AGY_APP_DATA_DIR），绝不碰真实的 ~/.gemini。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-manage-'));
const dataRoot = path.join(tmp, 'data');
const usersRoot = path.join(tmp, 'users');
const vaultDir = path.join(tmp, 'vault');
const agyHome = path.join(tmp, 'home');
const agyData = path.join(agyHome, '.gemini', 'antigravity-cli');
const agyDesktop = path.join(agyHome, '.gemini', 'antigravity');
const stateFile = path.join(tmp, 'fake-acp-state.json');
for (const d of [dataRoot, usersRoot, vaultDir, agyData, agyDesktop]) mkdirSync(d, { recursive: true });

process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = usersRoot;
process.env.VAULT_PATH = vaultDir;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';
process.env.AGY_BIN = FAKE_AGENT;
process.env.AGY_NO_WARMUP = '1';
process.env.AGY_HOME_DIR = agyHome;
process.env.AGY_APP_DATA_DIR = agyData;
process.env.FAKE_ACP_STATE_FILE = stateFile;

writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
  port: 18993,
  token: 'agy-manage-master-token-0123456789',
  vaultPath: vaultDir,
  usersRoot,
  features: { multiUser: true },
}, null, 2));

const { loadModules, registerModuleRoutes } = await import('@bridge/core/modules/registry.mjs');
await loadModules();
const { createRouter } = await import('@bridge/core/runtime/router.mjs');
const { registerAuthRoutes } = await import('@bridge/core/routes/auth.mjs');
const { registerChatRoutes } = await import('@bridge/core/routes/chat.mjs');
const { createAuth } = await import('@bridge/core/auth.mjs');
const { makeIdentify, contextFor } = await import('@bridge/core/runtime/identity.mjs');
const users = await import('@bridge/core/users.mjs');
const { setInternalRouter } = await import('@bridge/core/agent-api/internal.mjs');
const { callOp, getOp, validateArgs, whyNot, OpError } = await import('@bridge/core/agent-api/registry.mjs');
await import('@bridge/core/agent-api/ops/index.mjs');
const { AcpClient, setAcpClientForTest, shutdownAgy } = await import('./acp/index.mjs');
const { agyDataDir, agyDesktopDataDir } = await import('./acp/binary.mjs');
const purge = await import('./purge-files.mjs');
const search = await import('./transcript-search.mjs');
const { getSessionMeta } = await import('./sessions.mjs');
const { agyGenKey } = await import('./presence.mjs');
const { getLiveGens } = await import('@bridge/core/runtime/gen.mjs');

assert.equal(agyDataDir(), agyData, '测试必须指到临时目录');
assert.equal(agyDesktopDataDir(), agyDesktop, '测试必须指到临时目录');

const testClient = new AcpClient({
  daemonCwd: path.join(dataRoot, 'agy', 'daemon-cwd'),
  logFile: null,
  env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile },
});
setAcpClientForTest(testClient);

const MASTER = 'agy-manage-master-token-0123456789';
const auth = createAuth(MASTER, false, {
  isAdminSession: (t, g) => users.isAdminSession(t, g),
  isUserSession: (t) => !!users.getSession(t),
});
const identify = makeIdentify({ authOk: auth.authOk, getCookie: auth.getCookie, bearerToken: auth.bearerToken, queryToken: auth.queryToken });
const router = createRouter();
registerAuthRoutes(router, { ...auth, adminGen: auth.gen, identify });
registerChatRoutes(router, { authOk: auth.authOk, identify });
registerModuleRoutes(router, { authOk: auth.authOk, identify });
setInternalRouter(router);

const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const BASE = `http://127.0.0.1:${server.address().port}`;
const H = { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json', connection: 'close' };

const adminId = { kind: 'admin', user: null };
const admin = contextFor(adminId);
const env = { via: 'mcp', identity: adminId };
const run = (op, args = {}) => callOp(admin, op, args, env);
const codeOf = async (p) => { try { await p; return 'ok'; } catch (e) { assert.ok(e instanceof OpError, String(e?.stack || e)); return e.code; } };

after(async () => {
  shutdownAgy();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  // users.mjs 对 usersRoot/_system 挂了 fs.watch：只清内容、留空壳（同 routes.test.mjs 的原因）
  for (const top of readdirSync(tmp)) {
    if (top === 'users') continue;
    try { rmSync(path.join(tmp, top), { recursive: true, force: true }); } catch {}
  }
});

const getJson = async (url) => (await fetch(BASE + url, { headers: H })).json();
const postJson = async (url, body) => {
  const r = await fetch(BASE + url, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('waitFor timed out');
}

// 开一个新会话跑完一轮，返回会话 id
async function newSession(message = 'hello') {
  const text = await (await fetch(`${BASE}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ agent: 'agy', message }) })).text();
  const m = /"type":"session","sessionId":"([0-9a-f-]{36})"/.exec(text);
  assert.ok(m, '应拿到会话 id：' + text.slice(0, 300));
  return m[1];
}

function writeTranscript(dir, sid, lines, append = false) {
  const f = path.join(dir, 'brain', sid, '.system_generated', 'logs', 'transcript.jsonl');
  mkdirSync(path.dirname(f), { recursive: true });
  const body = lines.map((o) => JSON.stringify(o)).join('\n') + '\n';
  if (append) appendFileSync(f, body); else writeFileSync(f, body);
  return f;
}
const userLine = (text, at = '2026-11-20T10:00:00Z') => ({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: at, content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>` });
const asstLine = (text, at = '2026-11-20T10:00:05Z') => ({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at, content: text });

function seedAgyFiles(dir, sid) {
  const conv = path.join(dir, 'conversations');
  mkdirSync(conv, { recursive: true });
  for (const ext of ['.db', '.db-wal', '.db-shm', '.pb']) writeFileSync(path.join(conv, sid + ext), 'x');
  mkdirSync(path.join(dir, 'brain', sid, 'sub'), { recursive: true });
  writeFileSync(path.join(dir, 'brain', sid, 'sub', 'note.md'), 'x');
}

// ── 删除的路径守卫与待清理清单 ────────────────────────────────────────────────
test('purge-files：只认 uuid、只删固定位置；占用的进清单，spawn 前再清；清单被改也删不到别处', () => {
  const dir = path.join(tmp, 'purge-unit');
  const sid = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(purge.sessionFileTargets(dir, '../../etc'), []);
  assert.deepEqual(purge.sessionFileTargets(dir, 'abc'), []);
  assert.deepEqual(purge.sessionFileTargets(dir, sid + '/..'), []);
  const targets = purge.sessionFileTargets(dir, sid);
  assert.equal(targets.length, 6);
  assert.ok(targets.every((p) => p.startsWith(path.resolve(dir) + path.sep)));

  seedAgyFiles(dir, sid);
  const pendingFile = path.join(tmp, 'pending-unit.json');
  const busyRm = (p, o) => {
    if (p.endsWith('.db')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return rmSync(p, o);
  };
  const r = purge.purgeSessionFiles(sid, [dir], { file: pendingFile, rm: busyRm });
  assert.equal(r.pending.length, 1);
  assert.ok(r.pending[0].endsWith(sid + '.db'));
  assert.ok(existsSync(path.join(dir, 'conversations', sid + '.db')));
  assert.ok(!existsSync(path.join(dir, 'brain', sid)));
  assert.ok(!existsSync(path.join(dir, 'conversations', sid + '.db-wal')));
  assert.equal(purge.listPendingPurge(pendingFile).length, 1);

  // 清单里混进一条指向别处的路径：不删
  const outside = path.join(tmp, 'outside.txt');
  writeFileSync(outside, 'keep');
  const items = JSON.parse(readFileSync(pendingFile, 'utf8')).items;
  items[0].paths.push(outside);
  writeFileSync(pendingFile, JSON.stringify({ items }));

  // 别的数据目录（桌面版存储）spawn：不动这个目录的条目
  assert.deepEqual(purge.purgePendingDeletions(path.join(tmp, 'other-dir'), { file: pendingFile }), []);
  assert.ok(existsSync(path.join(dir, 'conversations', sid + '.db')));

  purge.purgePendingDeletions(dir, { file: pendingFile });
  assert.ok(!existsSync(path.join(dir, 'conversations', sid + '.db')), 'spawn 前清掉');
  assert.ok(existsSync(outside), '清单里指向别处的路径绝不删');
});

// ── 全文搜索 ─────────────────────────────────────────────────────────────────
test('全文搜索：只收用户话与助手回答、剥系统块；标题 / 正文分层；增量读追加部分；已隐藏默认不出', async () => {
  search._resetAgySearch();
  const ctx = { agyDir: path.join(tmp, 'search-agydir') };
  const a = 'aaaaaaaa-0000-4000-8000-000000000001';
  const b = 'aaaaaaaa-0000-4000-8000-000000000002';
  const c = 'aaaaaaaa-0000-4000-8000-000000000003';
  writeTranscript(agyData, a, [
    userLine('帮我查一下 Zebra 迁移脚本'),
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T10:00:01Z', thinking: '想想 zebra 的事', tool_calls: [{ name: 'read_file' }] },
    { step_index: 2, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-11-20T10:00:02Z', content: 'zebra system noise' },
    asstLine('迁移脚本在 scripts/migrate.mjs，已经检查完毕'),
  ]);
  writeTranscript(agyData, b, [userLine('和斑马无关的对话')]);
  writeTranscript(agyDesktop, c, [userLine('桌面版里提到 zebra')]);
  const sessions = [
    { sessionId: a, title: '迁移', updatedMs: 3, updatedAt: '2026-11-20T10:00:00Z' },
    { sessionId: b, title: 'Zebra 标题', updatedMs: 2 },
    { sessionId: c, title: '桌面', updatedMs: 1, hidden: true },
  ];
  let r = await search.searchAgySessions(ctx, 'zebra', { sessions });
  assert.deepEqual(r.hits.map((h) => [h.sessionId, h.match]), [[b, 'title'], [a, 'text']]);
  const ha = r.hits[1];
  assert.equal(ha.role, 'user');
  assert.match(ha.snippet, /Zebra 迁移脚本/);
  assert.doesNotMatch(ha.snippet, /ADDITIONAL_METADATA|local time/);
  assert.ok(ha.at);

  r = await search.searchAgySessions(ctx, 'migrate', { sessions });
  assert.equal(r.hits[0].role, 'assistant');
  r = await search.searchAgySessions(ctx, 'system noise', { sessions });
  assert.equal(r.hits.length, 0, 'SYSTEM_MESSAGE 不收');
  r = await search.searchAgySessions(ctx, '想想', { sessions });
  assert.equal(r.hits.length, 0, '只有 thinking 的步骤不收');

  r = await search.searchAgySessions(ctx, 'zebra', { sessions, includeHidden: true });
  assert.ok(r.hits.some((h) => h.sessionId === c && h.hidden), '带上已隐藏时才出，桌面版数据目录也认');

  // 增量：追加一行只读新增部分，同一条索引接着长
  const e1 = search._agySearchEntry(a);
  const off1 = e1.off;
  writeTranscript(agyData, a, [asstLine('补充：giraffe 也处理了', '2026-11-20T11:00:00Z')], true);
  r = await search.searchAgySessions(ctx, 'giraffe', { sessions });
  assert.equal(r.hits[0]?.sessionId, a);
  assert.equal(search._agySearchEntry(a), e1, '没有整条重建');
  assert.ok(e1.off > off1);
  assert.match(e1.text, /Zebra 迁移脚本[\s\S]*giraffe/);

  // 文件变短（被改写）：整条重建
  writeTranscript(agyData, a, [userLine('重写之后只剩 okapi')]);
  r = await search.searchAgySessions(ctx, 'zebra', { sessions });
  assert.ok(!r.hits.some((h) => h.sessionId === a && h.match === 'text'));
  assert.notEqual(search._agySearchEntry(a), e1);
});

test('全文搜索：预算用完先返回已有的并标 indexing，后台建完再搜就全了；索引落盘、重启后不必重读', async () => {
  search._resetAgySearch();
  const ctx = { agyDir: path.join(tmp, 'search-agydir2') };
  const ids = Array.from({ length: 6 }, (_, i) => `bbbbbbbb-0000-4000-8000-00000000000${i}`);
  ids.forEach((id, i) => writeTranscript(agyData, id, [userLine(`第 ${i} 个会话 kiwi`)]));
  const sessions = ids.map((id, i) => ({ sessionId: id, title: 't' + i, updatedMs: 10 - i }));
  let r = await search.searchAgySessions(ctx, 'kiwi', { sessions, budgetMs: 0 });
  assert.equal(r.indexing, true);
  assert.equal(r.hits.length, 0);
  await search.indexWarming();
  r = await search.searchAgySessions(ctx, 'kiwi', { sessions, budgetMs: 0 });
  assert.equal(r.hits.length, 6);
  assert.equal(r.indexing, false);

  await search.saveAgySearchStore();
  assert.ok(existsSync(path.join(ctx.agyDir, 'search-index.json')));
  search._resetAgySearch();
  r = await search.searchAgySessions(ctx, 'kiwi', { sessions, budgetMs: 0 });
  assert.equal(r.hits.length, 6, '落盘的索引直接可用，不用现建');

  search.forgetAgySearchEntry(ctx, ids[0]);
  assert.equal(search._agySearchEntry(ids[0]), undefined);
});

// ── 收藏 / 彻底删除（路由端到端，假 agy） ─────────────────────────────────────
test('收藏：不改动最近活动时间；列表带 favorite，取消后去掉', async () => {
  const sid = await newSession('收藏测试');
  const before = (await getJson('/api/agy/sessions?refresh=1')).sessions.find((s) => s.sessionId === sid);
  assert.ok(before);
  const fav = await postJson('/api/agy/session/favorite', { id: sid, favorite: true });
  assert.equal(fav.status, 200);
  assert.equal(fav.body.favorite, true);
  const after1 = (await getJson('/api/agy/sessions')).sessions.find((s) => s.sessionId === sid);
  assert.equal(after1.favorite, true);
  assert.equal(after1.updatedMs, before.updatedMs, '收藏不把会话顶到最前');
  await postJson('/api/agy/session/favorite', { id: sid, favorite: false });
  const after2 = (await getJson('/api/agy/sessions')).sessions.find((s) => s.sessionId === sid);
  assert.equal(after2.favorite, undefined);
});

test('彻底删除：文件与侧车清干净，墓碑挡住列表 / 详情 / 续聊 / 搜索 / 恢复；坏 id 拒', async () => {
  const sid = await newSession('删除测试 walrus');
  seedAgyFiles(agyData, sid);
  seedAgyFiles(agyDesktop, sid);
  writeTranscript(agyData, sid, [userLine('删除测试 walrus')]);
  const toolOut = path.join(admin.agyDir, 'tool-outputs', sid + '.json');
  mkdirSync(path.dirname(toolOut), { recursive: true });
  writeFileSync(toolOut, '{}');
  await postJson('/api/agy/session/favorite', { id: sid, favorite: true });
  const s0 = await getJson('/api/agy/search?q=walrus');
  assert.ok(s0.hits.some((h) => h.sessionId === sid));

  assert.equal((await postJson('/api/agy/session/purge', { id: '../../etc' })).status, 400);
  assert.equal((await postJson('/api/agy/session/purge', { id: 'phantom' })).status, 400);

  const del = await postJson('/api/agy/session/purge', { id: sid });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  for (const dir of [agyData, agyDesktop]) {
    for (const ext of ['.db', '.db-wal', '.db-shm', '.pb']) assert.ok(!existsSync(path.join(dir, 'conversations', sid + ext)), ext);
    assert.ok(!existsSync(path.join(dir, 'brain', sid)));
  }
  assert.ok(!existsSync(toolOut));
  assert.deepEqual(getSessionMeta(admin.agyDir, sid).deleted, true);

  // 假 agy 的 session/list 仍列着它（同真 agy 的摘要库）：靠墓碑挡掉
  const list = await getJson('/api/agy/sessions?refresh=1&includeHidden=1');
  assert.ok(!list.sessions.some((s) => s.sessionId === sid));
  const detail = await fetch(`${BASE}/api/agy/session/${sid}`, { headers: H });
  await detail.text();
  assert.equal(detail.status, 404);
  const chat = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ agent: 'agy', sessionId: sid, message: 'again' }) });
  await chat.text();
  assert.equal(chat.status, 404, '已删除的会话不许续聊');
  const s1 = await getJson('/api/agy/search?q=walrus&includeHidden=1');
  assert.ok(!s1.hits.some((h) => h.sessionId === sid));
  await postJson('/api/agy/session/restore', { id: sid });
  await postJson('/api/agy/session/rename', { id: sid, title: '复活?' });
  await postJson('/api/agy/session/favorite', { id: sid, favorite: true });
  assert.deepEqual(Object.keys(getSessionMeta(admin.agyDir, sid)).sort(), ['deleted', 'deletedAt'], '恢复 / 改名 / 收藏都写不活它');
  assert.ok(!(await getJson('/api/agy/sessions?refresh=1')).sessions.some((s) => s.sessionId === sid));
});

test('彻底删除在跑的会话：先停掉这一轮；文件被占着就进清单', async () => {
  const sid = await newSession('先建一个');
  const key = agyGenKey(admin.key);
  fetch(`${BASE}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ agent: 'agy', sessionId: sid, message: '慢慢跑 [SLOW] [SLOW_LONG]' }) }).then((r) => r.text()).catch(() => {});
  await waitFor(() => getLiveGens(key).some((g) => g.sessionId === sid));
  seedAgyFiles(agyData, sid);
  const { deleteAgySession } = await import('./session-purge.mjs');
  const pendingFile = path.join(tmp, 'pending-live.json');
  const r = await deleteAgySession(admin, sid, {
    pendingFile,
    rm: (p, o) => { if (p.endsWith('.db')) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return rmSync(p, o); },
  });
  assert.equal(r.stopped, true);
  assert.ok(!getLiveGens(key).some((g) => g.sessionId === sid), '这一轮已停');
  assert.equal(r.pending.length, 1);
  assert.equal(purge.listPendingPurge(pendingFile)[0].id, sid);
  assert.deepEqual(purge.purgePendingDeletions(agyData, { file: pendingFile }), [sid]);
  assert.ok(!existsSync(path.join(agyData, 'conversations', sid + '.db')));
});

// ── agent 操作分发 ───────────────────────────────────────────────────────────
test('agent 操作：不带 agent 时参数与要求不变；agent:agy 要 agy 能力，未知 agent 拒', async () => {
  assert.deepEqual(validateArgs(getOp('sessions.list'), { limit: '5', archived: 'true' }), { limit: 5, archived: true });
  assert.deepEqual(validateArgs(getOp('chat.send'), { message: 'x' }), { message: 'x', whenBusy: 'queue', wait: 0 });
  const op = getOp('sessions.list');
  assert.deepEqual(op.need, ['agent:claude']);
  const noAgy = { ...admin, agents: ['claude'] };
  assert.equal(whyNot(noAgy, op), null);
  assert.match(whyNot(noAgy, op, { agent: 'agy' }) || '', /agy/);
  assert.equal(await codeOf(callOp(noAgy, 'sessions.list', { agent: 'agy' }, env)), 'forbidden');
  assert.equal(await codeOf(run('sessions.list', { agent: 'nope' })), 'forbidden');
  const noClaude = { ...admin, agents: ['agy'] };
  assert.equal(await codeOf(callOp(noClaude, 'sessions.list', { limit: 'abc' }, env)), 'forbidden', '参数错且无权限：照旧先报权限');
  assert.equal(await codeOf(callOp(noAgy, 'sessions.list', { limit: 'abc' }, env)), 'bad_args');
  assert.equal(await codeOf(callOp(noClaude, 'sessions.list', { agent: 'agy', limit: 'abc' }, env)), 'bad_args');
});

test('agent 操作 agent:agy：发消息等结果、列表 / 搜索 / 读取、排队、overview、审批应答、停止', async () => {
  const sent = await run('chat.send', { agent: 'agy', message: '你好 narwhal', wait: 30 });
  assert.equal(sent.status, 'done');
  assert.match(sent.reply, /model=/);
  const sid = sent.sessionId;

  const list = await run('sessions.list', { agent: 'agy', limit: 50 });
  assert.equal(list.agent, 'agy');
  assert.ok(list.sessions.some((s) => s.id === sid));

  const read = await run('sessions.read', { agent: 'agy', sessionId: sid });
  assert.deepEqual(read.messages.map((m) => m.role), ['user', 'assistant']);
  assert.match(read.messages[0].text, /narwhal/);

  writeTranscript(agyData, sid, [userLine('你好 narwhal'), asstLine('正文里才有 quokka')]);
  const found = await run('sessions.search', { agent: 'agy', q: 'quokka' });
  assert.ok(found.results.some((h) => h.id === sid && h.matchedIn === 'text' && h.role === 'assistant'));

  const idle = await run('chat.wait', { agent: 'agy', sessionId: sid, timeout: 0 });
  assert.equal(idle.status, 'done', '刚跑完的那一轮还在缓存里');

  // 在跑：再发一条走排队；overview 里能看到；停掉
  const running = await run('chat.send', { agent: 'agy', sessionId: sid, message: '长任务 [SLOW] [SLOW_LONG]' });
  assert.equal(running.status, 'running');
  const queued = await run('chat.send', { agent: 'agy', sessionId: sid, message: '排队这条' });
  assert.equal(queued.status, 'queued');
  assert.equal(await codeOf(run('chat.send', { agent: 'agy', sessionId: sid, message: 'x', whenBusy: 'steer' })), 'bad_args');
  const ov = await run('overview');
  const agyOv = ov.agents?.find((x) => x.agent === 'agy');
  assert.ok(agyOv && agyOv.running.some((r) => r.sessionId === sid));
  const st = await run('chat.stop', { agent: 'agy', sessionId: sid });
  assert.equal(st.stopped, true);
  const w = await run('chat.wait', { agent: 'agy', sessionId: sid, timeout: 10 });
  assert.equal(w.status, 'stopped');
  assert.equal((await run('overview')).agents, undefined, '没东西时不出 agents');

  // 审批：needs_input → answer → done
  const perm = await run('chat.send', { agent: 'agy', sessionId: sid, message: '要批准 [PERM]', wait: 10 });
  assert.equal(perm.status, 'needs_input');
  const p = perm.pending[0];
  assert.equal(p.kind, 'approval');
  const pend = await run('chat.pending', { agent: 'agy' });
  assert.ok(pend.pending.some((x) => x.id === p.id));
  const ans = await run('chat.answer', { agent: 'agy', id: p.id, decision: 'once' });
  assert.equal(ans.answered, true);
  const fin = await run('chat.wait', { agent: 'agy', sessionId: sid, timeout: 15 });
  assert.equal(fin.status, 'done');
  assert.match(fin.reply, /perm=/);

  // 删除后各操作都挡住
  await postJson('/api/agy/session/purge', { id: sid });
  assert.equal(await codeOf(run('sessions.read', { agent: 'agy', sessionId: sid })), 'not_found');
  assert.equal(await codeOf(run('chat.send', { agent: 'agy', sessionId: sid, message: 'x' })), 'not_found');
  assert.ok(!(await run('sessions.list', { agent: 'agy', limit: 200 })).sessions.some((s) => s.id === sid));
});
