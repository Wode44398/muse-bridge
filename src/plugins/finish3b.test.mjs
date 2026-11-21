// 插件应用服务端的收尾与插槽：
//   · GET /api/plugins/grants 不带 plugin 的总览；
//   · _bridge/chat/watch 报到 + notices 收尾通知的抑制（提问照发）；
//   · 插件停用作废旧票、chat/sessions 滤掉转录没了的会话、三组接口要 X-Bridge-UI；
//   · handles 的 via: { fileHandler }；市场索引留 category / icon；POST /api/plugins/ui/view；
//   · page-events 与 ctx.http.user 的票据分支按账号库现状重解析身份。
// 插件内核是进程单例：本文件单独一个进程跑（node --test src/plugins/finish3b.test.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-finish3b-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
// 主机的转录目录（configDir=null 时读 CLAUDE_CONFIG_DIR）也指到临时目录，别去碰这台机器真的 ~/.claude
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'host-claude');
mkdirSync(process.env.VAULT_PATH, { recursive: true });

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { normUi, PERMISSIONS } = await import('./discover.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerPluginRoutes } = await import('../routes/plugins.mjs');
const { mintTicket } = await import('./tickets.mjs');
const { setInternalRouter } = await import('../agent-api/internal.mjs');
const PC = await import('./page-chat.mjs');
const { signHandles } = await import('./page-files.mjs');
const { normalizeIndex } = await import('./market.mjs');
const G = await import('../runtime/gen.mjs');
const N = await import('../runtime/notices.mjs');
const { sessionQuestions } = await import('../runtime/questions.mjs');
const { sessionsDir } = await import('../runtime/paths.mjs');
const users = await import('../users.mjs');
const { userIdentity, contextFor } = await import('../runtime/identity.mjs');

installMixins();
const router = createRouter();
let memberIdentity = null;
let goneIdentity = null;   // 会被停用的那个成员（停用账号的用例专用，别影响别的用例）
const identify = (req) => {
  const k = req.headers['x-test'];
  if (k === 'admin') return { kind: 'admin', user: null };
  if (k === 'member') return memberIdentity;
  if (k === 'gone') return goneIdentity;
  return { kind: 'none', user: null };
};
kernel.provide('router', router);
kernel.provide('auth', { identify, authOk: () => false });
registerPluginRoutes(router, { identify });
setInternalRouter(router);
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const OPEN = 'f3-open';       // 成员能用，声明 page.chat / page.files，有文件处理器（csv）和一个声明式应用
const HOSTONLY = 'f3-host';   // 只给主机，声明 page.files
const NOPERM = 'f3-noperm';   // 成员能用，但没声明页面权限
const OFF = 'f3-off';         // 成员能用、声明了 page.chat，但关着
const NOFILES = 'f3-nofiles'; // 成员能用，只声明 page.chat（没声明 page.files）
const perms = (...ids) => ids.map((id) => ({ id, label: PERMISSIONS[id] || id }));

async function addPlugin(id, name, apps, permissions, apply = () => {}) {
  const dir = path.join(tmp, 'src-' + id);
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  writeFileSync(path.join(dir, 'web', 'app.html'), '<!doctype html><p>app</p>');
  const manifest = { id, name, ui: { apps } };
  await kernel.register({
    id, name, source: 'local', dir, pluginApi: 3,
    extra: { ui: normUi(manifest, dir), permissions },
    load: async () => ({ apply }),
  });
  assert.ok(kernel.isActive(id), kernel.get(id)?.error || '');
}

test.before(async () => {
  await kernel.start();
  const r = await users.createUser('f3member', 'pw-f3member-123', 'user');
  assert.ok(r.ok, r.error);
  memberIdentity = userIdentity(r.id);
  const g = await users.createUser('f3gone', 'pw-f3gone-123', 'user');
  assert.ok(g.ok, g.error);
  goneIdentity = userIdentity(g.id);
  await addPlugin(OPEN, '乙 开放插件', [{ id: 'main', title: '主应用', page: 'web/app.html', who: 'members' }], perms('ui', 'page.chat', 'page.files'), (ctx) => {
    ctx.ui.fileHandler({ id: 'csv', title: '表格', exts: ['csv'], app: 'main', who: 'members' });
    ctx.ui.app({
      id: 'board', title: '看板', who: 'members', state: { n: 1 },
      view: (who, { state }) => [{ type: 'text', text: '第 ' + state.n + ' 次' }],
    });
    // 插件自己的接口：ctx.http.user 认票据（身份 = 开页面的人）
    ctx.route('GET', '/api/plugin/' + OPEN + '/whoami', (req, res) => {
      const c = ctx.http.user(req, res);
      if (!c) return;
      ctx.http.json(res, 200, { key: c.key });
    });
  });
  await addPlugin(HOSTONLY, '甲 主机插件', [{ id: 'main', title: '主机应用', page: 'web/app.html' }], perms('page.files'));
  await addPlugin(NOPERM, '丙 没声明', [{ id: 'main', title: '没声明', page: 'web/app.html', who: 'members' }], perms('ui'));
  await addPlugin(OFF, '丁 关着', [{ id: 'main', title: '关着的', page: 'web/app.html', who: 'members' }], perms('page.chat'));
  await kernel.setEnabled(OFF, false);
  await addPlugin(NOFILES, '戊 只聊天', [{ id: 'main', title: '只聊天', page: 'web/app.html', who: 'members' }], perms('page.chat'));
  // 成员与主机空间里各放几份文件（签句柄用）
  const memberRoot = contextFor(memberIdentity).cwd;
  for (const root of [process.env.VAULT_PATH, memberRoot]) {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'a.csv'), 'x,y\n1,2\n');
    writeFileSync(path.join(root, 'docs', 'b.txt'), 'hello');
  }
});
test.after(async () => { server.closeAllConnections?.(); server.close(); await kernel.stop(); });
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const MKEY = () => 'u:' + memberIdentity.user;
async function call(method, p, { as = '', ticket = '', body, ui = false } = {}) {
  const headers = {};
  if (as) headers['x-test'] = as;
  if (ui) headers['x-bridge-ui'] = '1';
  if (ticket) headers.authorization = 'Plugin ' + ticket;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const bridge = (id, op) => `/api/plugin/${id}/_bridge/${op}`;
const grant = (as, plugin, perm, allow = true) => call('POST', '/api/plugins/grants', { as, ui: true, body: { plugin, perm, allow } });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
// 替这个使用者「开」一个插件会话（真路由在 /api/chat 里打标；这里直接打）
const own = (plugin, owner, app = 'main', sid = randomUUID()) => { G.markPluginSession(sid, { plugin, app, label: '测试', owner }); return sid; };

// ── 3b.1 授权总览 ──────────────────────────────────────────────────────
test('grants 总览：主机 / 成员各只看到能用的插件；没声明页面权限、关着的不列；带 plugin 形状不变', async () => {
  assert.equal((await grant('member', OPEN, 'page.chat')).status, 200);
  const h = await call('GET', '/api/plugins/grants', { as: 'admin' });
  assert.equal(h.status, 200);
  const hp = h.json.plugins.filter((x) => x.plugin.startsWith('f3-'));
  assert.deepEqual(hp.map((x) => x.plugin), [HOSTONLY, NOFILES, OPEN], '按插件名的拼音排（甲 jiǎ、戊 wù、乙 yǐ）；丙没声明、丁关着');
  const open = hp.find((x) => x.plugin === OPEN);
  assert.equal(open.pluginName, '乙 开放插件');
  assert.deepEqual(open.declared.map((d) => d.id), ['page.chat', 'page.files']);
  assert.ok(open.declared.every((d) => typeof d.label === 'string' && d.label));
  assert.deepEqual(open.granted, {}, '主机自己没授过');

  const m = await call('GET', '/api/plugins/grants', { as: 'member' });
  const mp = m.json.plugins.filter((x) => x.plugin.startsWith('f3-'));
  assert.deepEqual(mp.map((x) => x.plugin), [NOFILES, OPEN], '成员看不到只给主机的');
  assert.deepEqual(Object.keys(mp[1].granted), ['page.chat']);
  assert.match(mp[1].granted['page.chat'], /^\d{4}-\d\d-\d\dT/);

  const one = await call('GET', '/api/plugins/grants?plugin=' + OPEN, { as: 'member' });
  assert.deepEqual(Object.keys(one.json).sort(), ['declared', 'granted'], '带 plugin 时还是 { declared, granted }');
  assert.equal((await call('GET', '/api/plugins/grants?plugin=nope', { as: 'member' })).status, 404);
  assert.equal((await call('GET', '/api/plugins/grants')).status, 401);
});

// ── 3b.3 正看着的会话 ─────────────────────────────────────────────────
test('chat/watch：报到、续期、过期、visible:false；别人的会话 404；没授权 403 needGrant', async () => {
  await grant('member', OPEN, 'page.chat');
  PC._setWatchTtl(150);
  try {
    const sid = own(OPEN, MKEY());
    const w = (body, as = 'member', plugin = OPEN) => call('POST', bridge(plugin, 'chat/watch'), { as, body });
    assert.equal(PC.watchedByPage(MKEY(), sid), false);
    const r = await w({ sessionId: sid, visible: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.watching, true);
    assert.equal(PC.watchedByPage(MKEY(), sid), true);
    assert.equal(PC.watchedByPage('admin', sid), false, '只算报到的那个人');
    // 续期：到期前再报一次，原到期时刻过了还看着
    await tick(100);
    await w({ sessionId: sid, visible: true });
    await tick(100);
    assert.equal(PC.watchedByPage(MKEY(), sid), true, '续上了');
    // 过期
    await tick(120);
    assert.equal(PC.watchedByPage(MKEY(), sid), false, '不续就过期');
    // visible:false 当场删
    await w({ sessionId: sid });   // 不给 visible = 报到
    assert.equal(PC.watchedByPage(MKEY(), sid), true);
    const off = await w({ sessionId: sid, visible: false });
    assert.equal(off.json.watching, false);
    assert.equal(PC.watchedByPage(MKEY(), sid), false);
    assert.equal((await w({ sessionId: sid, visible: 'yes' })).status, 400);

    // 别人的会话 / 别的插件的会话 / 没有的会话：一律 404
    const adminSid = own(OPEN, 'admin');
    assert.equal((await w({ sessionId: adminSid, visible: true })).status, 404, '主机的会话');
    const otherPlugin = own(NOFILES, MKEY());
    assert.equal((await w({ sessionId: otherPlugin, visible: true })).status, 404, '别的插件开的');
    assert.equal((await w({ sessionId: randomUUID(), visible: true })).status, 404);
    assert.equal(PC.watchedByPage(MKEY(), otherPlugin), false);

    // 没授权：403 needGrant；没声明：403 undeclared
    const nog = await w({ sessionId: adminSid, visible: true }, 'admin');
    assert.equal(nog.status, 403);
    assert.equal(nog.json.needGrant, 'page.chat');
    assert.equal((await w({ sessionId: sid, visible: true }, 'member', NOPERM)).json.undeclared, true);

    // 撤销 page.chat：报到当场作废
    await w({ sessionId: sid, visible: true });
    assert.equal(PC.watchedByPage(MKEY(), sid), true);
    await grant('member', OPEN, 'page.chat', false);
    assert.equal(PC.watchedByPage(MKEY(), sid), false, '撤了授权就不再压通知');
  } finally { PC._setWatchTtl(); await grant('member', OPEN, 'page.chat'); }
});

test('noticeRunEnd：被页面看着的会话不发完成 / 出错通知，提问与审批照发；钩子撤掉就什么都不挡', async () => {
  await grant('member', OPEN, 'page.chat');
  N._resetNotices();
  const key = MKEY();
  const ctx = { key };
  const sid = own(OPEN, key);
  const done = [{ type: 'done', result: '做完了' }];
  const ofSid = () => N.recentNotices(key).filter((n) => n.sessionId === sid).map((n) => n.kind);
  assert.equal((await call('POST', bridge(OPEN, 'chat/watch'), { as: 'member', body: { sessionId: sid, visible: true } })).status, 200);
  N.noticeRunEnd(ctx, { sessionId: sid, events: done });
  N.noticeRunEnd(ctx, { sessionId: sid, events: [{ type: 'error', kind: 'api', title: '出错了' }] });
  assert.deepEqual(ofSid(), [], '看着的时候完成 / 出错都不弹');
  // 提问 / 审批照发（页面不能代批，通知是去批的入口）
  sessionQuestions.set(sid, { qid: 'f3-q1', kind: 'question', ownerKey: key, questions: [{ question: '继续吗？' }], ts: 1 });
  sessionQuestions.set(sid, { qid: 'f3-q2', kind: 'permission', ownerKey: key, questions: [{ question: '允许运行命令？' }], ts: 2 });
  assert.deepEqual(ofSid().sort(), ['permission', 'question']);
  sessionQuestions.delete(sid);
  // 别的会话照常
  const other = own(OPEN, key);
  N.noticeRunEnd(ctx, { sessionId: other, events: done });
  assert.ok(N.recentNotices(key).some((n) => n.sessionId === other && n.kind === 'done'));
  // 不看了 → 照常弹
  await call('POST', bridge(OPEN, 'chat/watch'), { as: 'member', body: { sessionId: sid, visible: false } });
  N.noticeRunEnd(ctx, { sessionId: sid, events: done });
  assert.ok(ofSid().includes('done'));
  // 没有插件系统（没人挂钩子）：什么都不挡
  N._resetNotices();
  await call('POST', bridge(OPEN, 'chat/watch'), { as: 'member', body: { sessionId: sid, visible: true } });
  N.setNoticeSuppressor(null);
  try {
    N.noticeRunEnd(ctx, { sessionId: sid, events: done });
    assert.deepEqual(ofSid(), ['done']);
  } finally { N.setNoticeSuppressor(PC.watchedByPage); }
  // 钩子自己抛错也不影响发通知
  N._resetNotices();
  N.setNoticeSuppressor(() => { throw new Error('坏钩子'); });
  try {
    N.noticeRunEnd(ctx, { sessionId: sid, events: done });
    assert.deepEqual(ofSid(), ['done']);
  } finally { N.setNoticeSuppressor(PC.watchedByPage); }
  await call('POST', bridge(OPEN, 'chat/watch'), { as: 'member', body: { sessionId: sid, visible: false } });
});

// ── 3b.4 其它 ─────────────────────────────────────────────────────────
test('插件停用就作废旧票：重新启用后旧票 401，新票照常', async () => {
  const t = mintTicket(OPEN, memberIdentity, { app: 'main' }).ticket;
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: t })).status, 200);
  await kernel.setEnabled(OPEN, false);
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: t })).status, 404, '停用期间插件不在');
  await kernel.setEnabled(OPEN, true);
  assert.ok(kernel.isActive(OPEN));
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: t })).status, 401, '旧票没有复活');
  assert.equal((await call('GET', '/api/plugin/' + OPEN + '/whoami', { ticket: t })).status, 401, 'ctx.http.user 也不认');
  const t2 = mintTicket(OPEN, memberIdentity, { app: 'main' }).ticket;
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: t2 })).status, 200);
  // 别的插件的票不受牵连
  const tn = mintTicket(NOFILES, memberIdentity, { app: 'main' }).ticket;
  await kernel.setEnabled(OPEN, false);
  await kernel.setEnabled(OPEN, true);
  assert.equal((await call('GET', bridge(NOFILES, 'kv'), { ticket: tn })).status, 200);
});

test('chat/sessions：转录已经没了的会话不列；正在跑的（还没落转录）照列', async () => {
  await grant('member', OPEN, 'page.chat');
  const key = MKEY();
  const mctx = contextFor(memberIdentity);
  // 一个真有转录的（写在成员自己的会话目录里，走真定位器）、一个转录没了的、一个正在跑的新会话
  const kept = own(OPEN, key);
  const dir = sessionsDir(mctx.homeRoot || mctx.cwd, mctx.configDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, kept + '.jsonl'), '{"type":"user"}\n');
  const gone = own(OPEN, key);
  const live = own(OPEN, key);
  const g = { sessionId: live, userText: 'hi', events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
  G.tryStartGen(key, g);
  try {
    const list = (await call('GET', bridge(OPEN, 'chat/sessions'), { as: 'member' })).json;
    const ids = new Set(list.map((s) => s.sessionId));
    assert.ok(ids.has(kept), '转录在的列');
    assert.ok(ids.has(live), '正在跑的列');
    assert.ok(!ids.has(gone), '转录没了的不列');
    // 定位器换成假的：按它说的算（证明过滤走的是这一个口子，不是自己拼路径）
    PC._setTranscriptCheck((c, sid) => sid === gone);
    const list2 = (await call('GET', bridge(OPEN, 'chat/sessions'), { as: 'member' })).json.map((s) => s.sessionId);
    assert.ok(list2.includes(gone) && list2.includes(live) && !list2.includes(kept));
  } finally {
    PC._setTranscriptCheck(null);
    G.genFinish(g);
  }
});

test('chat/sessions：判定为转录没了的会话记一阵，再列时不再去定位；在的每次都查', async () => {
  await grant('member', OPEN, 'page.chat');
  const key = MKEY();
  const kept = own(OPEN, key);
  const gone = own(OPEN, key);
  const asked = new Map();
  PC._setTranscriptCheck((c, sid) => { asked.set(sid, (asked.get(sid) || 0) + 1); return sid !== gone; });
  try {
    for (let i = 0; i < 3; i++) {
      const ids = (await call('GET', bridge(OPEN, 'chat/sessions'), { as: 'member' })).json.map((s) => s.sessionId);
      assert.ok(ids.includes(kept) && !ids.includes(gone));
    }
    assert.equal(asked.get(gone), 1, '没了的只定位一次');
    assert.equal(asked.get(kept), 3, '在的会被随时删掉，不记');
    // 同一 id 又跑起来：正在跑的照列，不受「没了」的记录影响
    const g = { sessionId: gone, userText: 'hi', events: [], subscribers: new Set(), done: false, startedAt: Date.now() };
    G.tryStartGen(key, g);
    try {
      const ids = (await call('GET', bridge(OPEN, 'chat/sessions'), { as: 'member' })).json.map((s) => s.sessionId);
      assert.ok(ids.includes(gone));
    } finally { G.genFinish(g); }
  } finally {
    PC._setTranscriptCheck(null);
  }
});

test('X-Bridge-UI：授权 / 签句柄 / 中转三组没带这个头 403，带了照常；只带插件票的照旧 401', async () => {
  const no = '只能从 bridge 自己的界面调用';
  const g1 = await call('POST', '/api/plugins/grants', { as: 'member', body: { plugin: OPEN, perm: 'page.files', allow: true } });
  assert.equal(g1.status, 403);
  assert.equal(g1.json.error, no);
  const h1 = await call('POST', '/api/plugins/handles', { as: 'member', body: { plugin: OPEN, items: [{ rel: 'docs/a.csv' }] } });
  assert.equal(h1.status, 403);
  assert.equal(h1.json.error, no);
  const fakeReq = 'A'.repeat(24);
  const r1 = await call('GET', '/api/plugins/host-requests/' + fakeReq, { as: 'member' });
  assert.equal(r1.status, 403);
  assert.equal(r1.json.error, no);
  assert.equal((await call('POST', '/api/plugins/host-requests/' + fakeReq + '/complete', { as: 'member', body: {} })).status, 403);

  assert.equal((await call('POST', '/api/plugins/grants', { as: 'member', ui: true, body: { plugin: OPEN, perm: 'page.files', allow: true } })).status, 200);
  assert.equal((await call('POST', '/api/plugins/handles', { as: 'member', ui: true, body: { plugin: OPEN, items: [{ rel: 'docs/b.txt' }] } })).status, 200);
  assert.equal((await call('GET', '/api/plugins/host-requests/' + fakeReq, { as: 'member', ui: true })).status, 404, '过了这道检查，按请求不存在处理');

  // 没登录 / 只带插件票：先 401（不暴露有这道检查）
  const t = mintTicket(OPEN, memberIdentity).ticket;
  assert.equal((await call('POST', '/api/plugins/grants', { ticket: t, ui: true, body: { plugin: OPEN, perm: 'page.files', allow: true } })).status, 401);
  assert.equal((await call('POST', '/api/plugins/handles', { body: {} })).status, 401);
  // 只读的 GET 授权不要这个头（插件详情、设置页直接读）
  assert.equal((await call('GET', '/api/plugins/grants?plugin=' + OPEN, { as: 'member' })).status, 200);
  await grant('member', OPEN, 'page.files', false);
});

test('handles via fileHandler：扩展名对上免授权（用时也不要）；对不上照常要授权；没声明 page.files 拒', async () => {
  await grant('member', OPEN, 'page.files', false);
  const sign = (body) => call('POST', '/api/plugins/handles', { as: 'member', ui: true, body: { plugin: OPEN, ...body } });
  const ok = await sign({ items: [{ rel: 'docs/a.csv' }], via: { fileHandler: 'csv' } });
  assert.equal(ok.status, 200, ok.text);
  const h = ok.json.files[0];
  assert.equal(h.name, 'a.csv');
  // 句柄拿去用：没授权 page.files 也能读（用户点「用 X 打开」就是同意了这一个文件）
  const rd = await call('GET', bridge(OPEN, 'files/read?h=' + h.handle), { as: 'member' });
  assert.equal(rd.status, 200, rd.text);
  assert.equal(rd.text, 'x,y\n1,2\n');
  assert.equal((await call('GET', bridge(OPEN, 'files/stat?h=' + h.handle), { as: 'member' })).status, 200);

  // 扩展名对不上 → 照常要授权
  const bad = await sign({ items: [{ rel: 'docs/b.txt' }], via: { fileHandler: 'csv' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.json.needGrant, 'page.files');
  const mixed = await sign({ items: [{ rel: 'docs/a.csv' }, { rel: 'docs/b.txt' }], via: { fileHandler: 'csv' } });
  assert.equal(mixed.json.needGrant, 'page.files', '一批里有一个对不上就整批照常要授权');
  // 不带 via：照常要授权
  assert.equal((await sign({ items: [{ rel: 'docs/a.csv' }] })).json.needGrant, 'page.files');
  // 没有的处理器 / via 写错
  assert.equal((await sign({ items: [{ rel: 'docs/a.csv' }], via: { fileHandler: 'nope' } })).status, 404);
  assert.equal((await sign({ items: [{ rel: 'docs/a.csv' }], via: 'csv' })).status, 400);
  // 没声明 page.files 的插件：处理器都登记不了，签句柄层也拒（即便调用方塞了一个看似匹配的处理器）
  const nf = await call('POST', '/api/plugins/handles', { as: 'member', ui: true, body: { plugin: NOFILES, items: [{ rel: 'docs/a.csv' }], via: { fileHandler: 'csv' } } });
  assert.equal(nf.status, 404);
  assert.throws(() => signHandles(contextFor(memberIdentity), NOFILES, [{ rel: 'docs/a.csv' }], 'rw', { via: { id: 'csv', exts: ['csv'] } }),
    (e) => e.status === 403 && e.undeclared === true && e.perm === 'page.files');
  // 撤销 page.files（哪怕没授过）：经处理器签的句柄也跟着作废
  await grant('member', OPEN, 'page.files', false);
  assert.equal((await call('GET', bridge(OPEN, 'files/stat?h=' + h.handle), { as: 'member' })).status, 404);
});

test('市场索引：留 category（含 app）与 https 图标，非 https 图标丢掉', () => {
  const v = { version: '1.0.0', url: 'https://x.example/a.zip', sha256: 'a'.repeat(64), size: 10 };
  const idx = normalizeIndex({ format: 1, seq: 1, plugins: [
    { id: 'p-app', name: '应用', category: 'app', icon: 'https://cdn.example/i.svg', versions: [v] },
    { id: 'p-http', name: '明文图标', icon: 'http://cdn.example/i.svg', versions: [v] },
    { id: 'p-js', name: '脚本图标', category: 'tool', icon: 'javascript:alert(1)', versions: [v] },
  ] });
  const by = Object.fromEntries(idx.plugins.map((p) => [p.id, p]));
  assert.equal(by['p-app'].category, 'app');
  assert.equal(by['p-app'].icon, 'https://cdn.example/i.svg');
  assert.equal(by['p-http'].icon, '');
  assert.equal(by['p-http'].category, 'third-party');
  assert.equal(by['p-js'].icon, '');
  assert.equal(by['p-js'].category, 'tool');
});

test('POST /api/plugins/ui/view：200 / 404 / 413；要登录', async () => {
  const v = (body, as = 'member') => call('POST', '/api/plugins/ui/view', { as, body });
  const ok = await v({ plugin: OPEN, id: 'board' });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.state, { n: 1 });
  assert.ok(Array.isArray(ok.json.tree) && ok.json.tree.length);
  const st = await v({ plugin: OPEN, id: 'board', state: { n: 5 } });
  assert.deepEqual(st.json.state, { n: 5 });
  assert.equal((await v({ plugin: OPEN, id: 'nope' })).status, 404);
  assert.equal((await v({ plugin: 'nope', id: 'board' })).status, 404);
  assert.equal((await v({ plugin: OPEN, id: 'board', state: { big: 'x'.repeat(300 * 1024) } })).status, 413);
  assert.equal((await v({ plugin: OPEN, id: 'board' }, '')).status, 401);
});

test('账号停用后：page-events 与 ctx.http.user 的票据都 401 并作废票（恢复账号旧票也不复活）', async () => {
  const t = mintTicket(OPEN, goneIdentity, { app: 'main' }).ticket;
  const who = await call('GET', '/api/plugin/' + OPEN + '/whoami', { ticket: t });
  assert.equal(who.status, 200, who.text);
  assert.equal(who.json.key, 'u:' + goneIdentity.user);
  // page-events 连得上（SSE，读到响应头就断开）
  const ac = new AbortController();
  const ev = await fetch(base + '/api/plugins/page-events?id=' + OPEN, { headers: { authorization: 'Plugin ' + t }, signal: ac.signal });
  assert.equal(ev.status, 200);
  ac.abort();
  const t2 = mintTicket(OPEN, goneIdentity, { app: 'main' }).ticket;

  assert.ok(users.setDisabled(goneIdentity.user, true).ok);
  try {
    assert.equal((await call('GET', '/api/plugin/' + OPEN + '/whoami', { ticket: t })).status, 401, 'ctx.http.user 不再认');
    assert.equal((await call('GET', '/api/plugins/page-events?id=' + OPEN, { ticket: t2 })).status, 401, 'page-events 不再认');
  } finally { users.setDisabled(goneIdentity.user, false); }
  // 账号恢复了，两张旧票也已经作废
  assert.equal((await call('GET', '/api/plugin/' + OPEN + '/whoami', { ticket: t })).status, 401);
  assert.equal((await call('GET', '/api/plugins/page-events?id=' + OPEN, { ticket: t2 })).status, 401);
  const t3 = mintTicket(OPEN, goneIdentity, { app: 'main' }).ticket;
  assert.equal((await call('GET', '/api/plugin/' + OPEN + '/whoami', { ticket: t3 })).status, 200, '新票照常');
});
