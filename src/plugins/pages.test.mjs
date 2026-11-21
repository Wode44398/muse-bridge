// 插件页面宿主能力（服务端）：_bridge 路由按操作分两类判权（设置与动作只给主机；kv / grants / files / host
// 给能用这个插件页面的人）、页面 KV（读写删列、键规则、单值与总量上限、成员互相看不见）、页面权限的授权（声明校验、允许、
// 撤销、撤销连带作废文件句柄、页面自己够不着授权接口）、宿主请求中转（request → 主界面 GET → complete → wait 拿结果；
// 别人的 404；过期；每人 20 个上限）、文件句柄（越界、junction 指到根外、只读、写入原子、选完之后换成链接、停用插件作废）。
// 起一个真 HTTP 服务；测试账号与数据都在临时目录，不碰真账号库。页面对话见 page-chat.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-pages-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
const VAULT = process.env.VAULT_PATH;
mkdirSync(VAULT, { recursive: true });

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { normUi, PERMISSIONS } = await import('./discover.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerPluginRoutes } = await import('../routes/plugins.mjs');
const { mintTicket, validTicketRequest } = await import('./tickets.mjs');
const { kvSet, kvList, KV_VALUE_MAX, KV_TOTAL_MAX } = await import('./page-kv.mjs');
const { _handleCount, useHandle, streamHandle } = await import('./page-files.mjs');
const { HOST_TTL_MS, HOST_OPEN_MAX, waitHostRequest, createHostRequest } = await import('./page-host.mjs');
const { canUsePluginPages } = await import('./ui.mjs');
const { busSubscribe } = await import('../runtime/bus.mjs');
const users = await import('../users.mjs');
const { userIdentity, contextFor } = await import('../runtime/identity.mjs');

installMixins();
const router = createRouter();
let memberIdentity = null;
const identify = (req) => {
  const k = req.headers['x-test'];
  if (k === 'admin') return { kind: 'admin', user: null };
  if (k === 'member') return memberIdentity;
  return { kind: 'none', user: null };
};
kernel.provide('router', router);
kernel.provide('auth', { identify, authOk: () => false });
registerPluginRoutes(router, { identify });
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const OPEN = 'pg-open';      // 有对成员开放的应用，声明了 page.chat / page.files
const HOSTONLY = 'pg-host';  // 只有主机能开的应用
const NODECL = 'pg-nodecl';  // 对成员开放，但没声明页面权限
const perms = (...ids) => ids.map((id) => ({ id, label: PERMISSIONS[id] || id }));

async function addPlugin(id, apps, permissions) {
  const dir = path.join(tmp, 'src-' + id);
  mkdirSync(path.join(dir, 'web'), { recursive: true });
  writeFileSync(path.join(dir, 'web', 'app.html'), '<!doctype html><p>app</p>');
  const manifest = { id, name: '插件 ' + id, ui: { apps } };
  await kernel.register({
    id, name: manifest.name, source: 'local', dir, pluginApi: 3,
    extra: { ui: normUi(manifest, dir), permissions },
    load: async () => ({ apply() {} }),
  });
  assert.ok(kernel.isActive(id), kernel.get(id)?.error || '');
}

test.before(async () => {
  await kernel.start();
  const r = await users.createUser('pgmember', 'pw-pgmember-123', 'user');
  assert.ok(r.ok, r.error);
  memberIdentity = userIdentity(r.id);
  assert.ok(memberIdentity);
  await addPlugin(OPEN, [{ id: 'main', title: '主应用', page: 'web/app.html', who: 'members' }], perms('ui', 'page.chat', 'page.files'));
  await addPlugin(HOSTONLY, [{ id: 'main', title: '主机应用', page: 'web/app.html' }], perms('page.chat', 'page.files'));
  await addPlugin(NODECL, [{ id: 'main', title: '没声明', page: 'web/app.html', who: 'members' }], perms('ui'));
});
test.after(async () => { server.closeAllConnections?.(); server.close(); await kernel.stop(); });
// 临时目录在进程退出时再删（运行中删掉会让文件监视卡住进程，Windows）
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const MEMBER_KEY = () => 'u:' + memberIdentity.user;

// 授权 / 签句柄 / 中转这三组只认 bridge 自己界面发的请求（X-Bridge-UI: 1）：这里模拟主界面，默认带上；
// ui: false = 故意不带（测「别处来的调用」）
const UI_ONLY = /^\/api\/plugins\/(grants|handles|host-requests\/)/;
async function call(method, p, { as = '', ticket = '', body, raw, ui = true } = {}) {
  const headers = {};
  if (as) headers['x-test'] = as;
  if (ui && UI_ONLY.test(p)) headers['x-bridge-ui'] = '1';
  if (ticket) headers.authorization = 'Plugin ' + ticket;
  let payload;
  if (raw !== undefined) { payload = raw; headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const r = await fetch(base + p, { method, headers, body: payload });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if (/json/.test(r.headers.get('content-type') || '')) { try { json = JSON.parse(buf.toString('utf8')); } catch {} }
  return { status: r.status, json, buf, headers: r.headers };
}
const bridge = (id, op) => `/api/plugin/${id}/_bridge/${op}`;
const grant = (as, plugin, perm, allow = true) => call('POST', '/api/plugins/grants', { as, body: { plugin, perm, allow } });

test('_bridge 判权分流：设置类只给主机；页面能力给能用页面的人；主机专用插件成员够不着', async () => {
  assert.equal(canUsePluginPages(contextFor(memberIdentity), OPEN), true);
  assert.equal(canUsePluginPages(contextFor(memberIdentity), HOSTONLY), false);
  assert.equal(canUsePluginPages(contextFor({ kind: 'admin' }), HOSTONLY), true);

  assert.equal((await call('GET', bridge(OPEN, 'config'), { as: 'member' })).status, 403, '成员调 config');
  assert.equal((await call('GET', bridge(OPEN, 'config'), { as: 'admin' })).status, 200, '主机调 config');
  const kv = await call('GET', bridge(OPEN, 'kv'), { as: 'member' });
  assert.equal(kv.status, 200, '成员调对成员开放插件的 kv');
  assert.deepEqual(kv.json, { keys: [] });
  assert.equal((await call('GET', bridge(HOSTONLY, 'kv'), { as: 'member' })).status, 403, '成员调主机专用插件的 kv');
  assert.equal((await call('GET', bridge(HOSTONLY, 'grants'), { as: 'member' })).status, 403);
  assert.equal((await call('POST', bridge(HOSTONLY, 'host/request'), { as: 'member', body: { type: 'pick.session' } })).status, 403);
  assert.equal((await call('GET', bridge(HOSTONLY, 'kv'), { as: 'admin' })).status, 200, '主机都能用');
  assert.equal((await call('GET', bridge(OPEN, 'kv'))).status, 401, '没登录');

  // 票据：按签票的人算；不认主机 / 成员以外的身份（contextFor 会把它兜底成主机）
  const mt = mintTicket(OPEN, memberIdentity, { app: 'main' }).ticket;
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: mt })).status, 200);
  assert.equal((await call('GET', bridge(OPEN, 'config'), { ticket: mt })).status, 403, '成员的票调 config');
  assert.equal((await call('GET', bridge(HOSTONLY, 'kv'), { ticket: mt })).status, 401, '别的插件的票');
  const ht = mintTicket(HOSTONLY, memberIdentity).ticket;
  assert.equal((await call('GET', bridge(HOSTONLY, 'kv'), { ticket: ht })).status, 403, '成员的票也够不着主机专用插件');
  const odd = mintTicket(OPEN, { kind: 'snap', dir: tmp, token: 'x' }).ticket;
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: odd })).status, 403, '票上是别的身份');
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: 'A'.repeat(32) })).status, 401, '假票');
  // 格式不对的票头不能退回 cookie / NO_AUTH 身份（as: admin 模拟 NO_AUTH 下 identify 恒为主机）
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { as: 'admin', ticket: 'junk' })).status, 401, '格式不对的票头');
  assert.equal((await call('POST', bridge(OPEN, 'chat/start'), { as: 'admin', ticket: 'junk', body: { text: 'x' } })).status, 401, '格式不对的票头开对话');

  // 不认识的 op / 子操作
  assert.equal((await call('GET', bridge(OPEN, 'nope'), { as: 'admin' })).status, 404);
  assert.equal((await call('GET', bridge(OPEN, 'kv/extra'), { as: 'admin' })).status, 404);
  assert.equal((await call('GET', bridge(OPEN, 'config/x'), { as: 'admin' })).status, 404);
  assert.equal((await call('GET', bridge(OPEN, 'chat/answer'), { as: 'admin' })).status, 404, '没有代批接口');
  assert.equal((await call('GET', bridge('pg-missing', 'kv'), { as: 'admin' })).status, 404, '没开着的插件');
});

test('Origin 守卫的放行条件：只认这个插件的有效票，格式不对 / 别的插件 / 假票都不算', () => {
  const tk = mintTicket(OPEN, memberIdentity).ticket;
  const req = (auth) => ({ headers: { authorization: auth } });
  const u = (p) => new URL('http://127.0.0.1' + p);
  assert.equal(validTicketRequest(req('Plugin ' + tk), u(`/api/plugin/${OPEN}/_bridge/kv`)), true);
  assert.equal(validTicketRequest(req('Plugin ' + tk), u(`/api/plugins/page-events?id=${OPEN}`)), true);
  assert.equal(validTicketRequest(req('Plugin junk'), u(`/api/plugin/${OPEN}/_bridge/kv`)), false, '格式不对');
  assert.equal(validTicketRequest(req('Plugin ' + 'A'.repeat(32)), u(`/api/plugin/${OPEN}/_bridge/kv`)), false, '假票');
  assert.equal(validTicketRequest(req('Plugin ' + tk), u(`/api/plugin/${HOSTONLY}/_bridge/kv`)), false, '别的插件');
  assert.equal(validTicketRequest(req('Plugin ' + tk), u('/api/chat')), false, '插件接口以外');
});

test('票据：每次按账号库现状重解析身份——账号停用 / 删除后页面能力一律 401 并作废这张票，账号恢复了旧票也不复活', async () => {
  const r = await users.createUser('pgmember-off', 'pw-pgmember-off-1', 'user');
  assert.ok(r.ok, r.error);
  const ident = userIdentity(r.id);
  const t1 = mintTicket(OPEN, ident, { app: 'main' }).ticket;
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: t1 })).status, 200);
  assert.equal((await call('GET', bridge(OPEN, 'grants'), { ticket: t1 })).status, 200);
  users.setDisabled(r.id, true);
  for (const [m, op, body] of [['GET', 'kv'], ['POST', 'kv', { key: 'a', value: 1 }], ['GET', 'grants'], ['POST', 'host/request', { type: 'pick.session' }], ['GET', 'chat/sessions']]) {
    assert.equal((await call(m, bridge(OPEN, op), { ticket: t1, body })).status, 401, '停用后 ' + m + ' ' + op);
  }
  users.setDisabled(r.id, false);
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: t1 })).status, 401, '旧票已作废');
  const t2 = mintTicket(OPEN, userIdentity(r.id), { app: 'main' }).ticket;
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: t2 })).status, 200, '重新打开拿新票就好');
  users.deleteUser(r.id);
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: t2 })).status, 401, '账号删了');
  // 主机的票照常
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { ticket: mintTicket(OPEN, { kind: 'admin', user: null }).ticket })).status, 200);
});

test('kv：读写删列；成员之间互相看不见；键规则、单值上限 413', async () => {
  const set = (as, key, value) => call('POST', bridge(OPEN, 'kv'), { as, body: { key, value } });
  assert.deepEqual((await set('member', 'count', 3)).json, { ok: true });
  assert.equal((await set('member', 'draft:1', { text: '草稿', n: [1, 2] })).status, 200);
  assert.equal((await set('member', '__proto__', 'p')).status, 200, '__proto__ 也是普通键');
  assert.deepEqual((await call('GET', bridge(OPEN, 'kv?key=count'), { as: 'member' })).json, { value: 3 });
  assert.deepEqual((await call('GET', bridge(OPEN, 'kv?key=draft:1'), { as: 'member' })).json, { value: { text: '草稿', n: [1, 2] } });
  assert.deepEqual((await call('GET', bridge(OPEN, 'kv?key=__proto__'), { as: 'member' })).json, { value: 'p' });
  assert.deepEqual((await call('GET', bridge(OPEN, 'kv?key=none'), { as: 'member' })).json, { value: null });
  assert.deepEqual((await call('GET', bridge(OPEN, 'kv'), { as: 'member' })).json.keys.sort(), ['__proto__', 'count', 'draft:1']);
  // 主机那份是另一份
  assert.deepEqual((await call('GET', bridge(OPEN, 'kv?key=count'), { as: 'admin' })).json, { value: null });
  await set('admin', 'count', 99);
  assert.deepEqual((await call('GET', bridge(OPEN, 'kv?key=count'), { as: 'member' })).json, { value: 3 });
  // 删除
  assert.equal((await set('member', 'count', null)).status, 200);
  assert.deepEqual((await call('GET', bridge(OPEN, 'kv?key=count'), { as: 'member' })).json, { value: null });
  assert.equal((await set('member', 'count', null)).status, 200, '删不存在的也行');
  // 落盘位置：plugin-data/<id>/kv/host.json 与 u-<id>.json
  const files = readdirSync(path.join(tmp, 'plugin-data', OPEN, 'kv')).sort();
  assert.ok(files.includes('host.json') && files.some((f) => f.startsWith('u-')), files.join(','));
  assert.ok(!files.some((f) => f.endsWith('.tmp')), '没有留下临时文件');
  // 键规则 / 缺 value / 太大
  assert.equal((await set('member', 'bad key', 1)).status, 400);
  assert.equal((await set('member', 'x'.repeat(129), 1)).status, 400);
  assert.equal((await call('POST', bridge(OPEN, 'kv'), { as: 'member', body: { key: 'k' } })).status, 400, '没给 value');
  assert.equal((await call('GET', bridge(OPEN, 'kv?key=a/b'), { as: 'member' })).status, 400);
  const big = await set('member', 'big', 'x'.repeat(KV_VALUE_MAX));
  assert.equal(big.status, 413, JSON.stringify(big.json));
});

test('kv：每人每插件总量上限 10MB（超了 413，已有的不动）；同一文件并发写排队不丢', async () => {
  const owner = 'u:capper';
  const chunk = 'y'.repeat(250 * 1024);
  let n = 0;
  let caught = null;
  for (; n < 60; n++) {
    try { await kvSet(OPEN, owner, 'k' + n, chunk); } catch (e) { caught = e; break; }
  }
  assert.ok(caught, '应当撞到总量上限');
  assert.equal(caught.status, 413);
  assert.ok(n * 250 * 1024 <= KV_TOTAL_MAX && (n + 1) * 250 * 1024 > KV_TOTAL_MAX * 0.97, String(n));
  assert.equal((await kvList(OPEN, owner)).length, n, '超限那次没写进去');
  // 并发：20 个不同的键同时写，一个都不丢
  await Promise.all(Array.from({ length: 20 }, (_, i) => kvSet(OPEN, 'u:racer', 'r' + i, i)));
  assert.equal((await kvList(OPEN, 'u:racer')).length, 20);
});

test('授权：声明校验 / 允许 / 撤销 / 推总线；页面自己够不着授权接口', async () => {
  const g0 = await call('GET', '/api/plugins/grants?plugin=' + OPEN, { as: 'member' });
  assert.equal(g0.status, 200);
  assert.deepEqual(g0.json.declared.map((p) => p.id), ['page.chat', 'page.files'], '只列页面权限');
  assert.equal(g0.json.declared[0].label, '在应用页面里以你的身份和 Claude 对话');
  assert.deepEqual(g0.json.granted, {});
  assert.equal((await call('GET', '/api/plugins/grants?plugin=nope', { as: 'member' })).status, 404);
  assert.equal((await call('GET', '/api/plugins/grants?plugin=' + OPEN)).status, 401);

  // 推总线：plugins.grants
  const got = [];
  const fake = { write: (s) => { got.push(String(s)); return true; }, on() {}, writableEnded: false };
  const unsub = busSubscribe(MEMBER_KEY(), fake);
  const ok = await grant('member', OPEN, 'page.chat');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.ok(ok.json.granted['page.chat'], '记下了同意时间');
  assert.ok(got.some((s) => s.includes('plugins.grants') && s.includes(OPEN)), got.join('|'));
  unsub?.();

  assert.equal((await grant('member', NODECL, 'page.chat')).status, 400, '没声明的权限');
  assert.equal((await grant('member', OPEN, 'net')).status, 400, '不是页面权限');
  assert.equal((await grant('member', HOSTONLY, 'page.chat')).status, 403, '成员用不了这个插件的页面');
  assert.equal((await grant('member', 'nope', 'page.chat')).status, 404);
  assert.equal((await grant('admin', HOSTONLY, 'page.chat')).status, 200, '主机可以');

  // 页面读得到，改不了
  const pv = await call('GET', bridge(OPEN, 'grants'), { as: 'member' });
  assert.deepEqual(Object.keys(pv.json.granted), ['page.chat']);
  assert.equal((await call('POST', bridge(OPEN, 'grants'), { as: 'member', body: { perm: 'page.files', allow: true } })).status, 404);
  const mt = mintTicket(OPEN, memberIdentity).ticket;
  assert.equal((await call('POST', '/api/plugins/grants', { ticket: mt, body: { plugin: OPEN, perm: 'page.files', allow: true } })).status, 401, '拿票据调不了授权接口');

  // 撤销
  const rv = await grant('member', OPEN, 'page.chat', false);
  assert.deepEqual(rv.json.granted, {});
  assert.deepEqual((await call('GET', bridge(OPEN, 'grants'), { as: 'member' })).json.granted, {});
  const stored = JSON.parse(readFileSync(path.join(tmp, 'plugin-data', OPEN, 'grants.json'), 'utf8'));
  assert.equal(stored[MEMBER_KEY()], undefined, '撤销后不留空壳');
});

// ---- 文件句柄 ----
const isWin = process.platform === 'win32';
const outside = path.join(tmp, 'outside');
mkdirSync(path.join(VAULT, 'docs'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(VAULT, 'docs', 'a.txt'), 'hello 文件');
writeFileSync(path.join(VAULT, 'docs', 'page.html'), '<script>alert(1)</script>');
writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
const junction = (link, target) => execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' });
const unjunction = (link) => { try { unlinkSync(link); } catch { try { rmdirSync(link); } catch {} } };
const sign = (as, plugin, items, mode) => call('POST', '/api/plugins/handles', { as, body: { plugin, items, ...(mode ? { mode } : {}) } });

test('文件句柄：签发（要授权、不回路径）、stat / read / write、只读、越界与 junction 拒绝、写入原子', async () => {
  const pre = await sign('admin', OPEN, [{ rel: 'docs/a.txt' }]);
  assert.equal(pre.status, 403, '没授权 page.files');
  assert.equal(pre.json.needGrant, 'page.files');
  assert.equal((await grant('admin', OPEN, 'page.files')).status, 200);

  const r = await sign('admin', OPEN, [{ rel: 'docs/a.txt' }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const f = r.json.files[0];
  assert.match(f.handle, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual({ ...f, handle: '' }, { handle: '', name: 'a.txt', size: Buffer.byteLength('hello 文件'), mime: 'text/plain; charset=utf-8', mode: 'rw' });
  assert.ok(!JSON.stringify(r.json).includes(tmp.replace(/\\/g, '\\\\')), '不回服务器路径');

  const st = await call('GET', bridge(OPEN, 'files/stat?h=' + f.handle), { as: 'admin' });
  assert.equal(st.status, 200);
  assert.equal(st.json.name, 'a.txt');
  assert.equal(typeof st.json.mtime, 'number');
  assert.equal(st.json.mode, 'rw');
  const rd = await call('GET', bridge(OPEN, 'files/read?h=' + f.handle), { as: 'admin' });
  assert.equal(rd.status, 200);
  assert.equal(rd.buf.toString('utf8'), 'hello 文件');
  assert.equal(rd.headers.get('cache-control'), 'no-store');

  // 写回：原子（同目录临时文件再改名，不留 .part-*）
  const wr = await call('POST', bridge(OPEN, 'files/write?h=' + f.handle), { as: 'admin', raw: Buffer.from('改过了 ✓') });
  assert.equal(wr.status, 200, JSON.stringify(wr.json));
  assert.equal(wr.json.ok, true);
  assert.equal(wr.json.size, Buffer.byteLength('改过了 ✓'));
  assert.equal(readFileSync(path.join(VAULT, 'docs', 'a.txt'), 'utf8'), '改过了 ✓');
  assert.deepEqual(readdirSync(path.join(VAULT, 'docs')).filter((n) => n.startsWith('.part-')), [], '没留临时文件');

  // 网页类文件给成纯文本，不在 bridge 的源上当文档解析
  const h2 = (await sign('admin', OPEN, [{ rel: 'docs/page.html' }])).json.files[0];
  assert.match((await call('GET', bridge(OPEN, 'files/read?h=' + h2.handle), { as: 'admin' })).headers.get('content-type'), /^text\/plain/);

  // 只读
  const ro = (await sign('admin', OPEN, [{ rel: 'docs/a.txt' }], 'r')).json.files[0];
  assert.equal(ro.mode, 'r');
  assert.equal((await call('POST', bridge(OPEN, 'files/write?h=' + ro.handle), { as: 'admin', raw: Buffer.from('x') })).status, 403, '只读模式写入');
  assert.equal(readFileSync(path.join(VAULT, 'docs', 'a.txt'), 'utf8'), '改过了 ✓');

  // 越界 / 不是文件 / 不存在 / 太多：整批不签
  for (const rel of ['../outside/secret.txt', '..\\..\\outside\\secret.txt', path.join(outside, 'secret.txt')]) {
    const x = await sign('admin', OPEN, [{ rel }]);
    assert.notEqual(x.status, 200, rel);
  }
  assert.equal((await sign('admin', OPEN, [{ rel: 'docs' }])).status, 400, '目录');
  assert.equal((await sign('admin', OPEN, [{ rel: '' }])).status, 403, '根');
  assert.equal((await sign('admin', OPEN, [{ rel: 'docs/none.txt' }])).status, 404);
  assert.equal((await sign('admin', OPEN, [{ rel: 'docs/a.txt' }, { rel: 'docs/none.txt' }])).status, 404, '一项不合格整批不签');
  assert.equal((await sign('admin', OPEN, Array.from({ length: 21 }, () => ({ rel: 'docs/a.txt' })))).status, 400, '一次最多 20');
  assert.equal((await sign('admin', OPEN, [])).status, 400);
  assert.equal((await sign('admin', OPEN, [{ rel: 'docs/a.txt', ws: 'C:\\' }])).status === 200, false, 'ws 不在允许的项目目录里');

  // 句柄只认签给的插件和人
  assert.equal((await call('GET', bridge(NODECL, 'files/stat?h=' + f.handle), { as: 'admin' })).status, 404, '别的插件');
  assert.equal((await call('GET', bridge(OPEN, 'files/stat?h=' + f.handle), { as: 'member' })).status, 404, '别人');
  assert.equal((await call('GET', bridge(OPEN, 'files/stat?h=nope'), { as: 'admin' })).status, 404);
  assert.equal((await call('POST', bridge(OPEN, 'files/stat?h=' + f.handle), { as: 'admin' })).status, 404, '方法不对');
});

test('文件句柄：junction 指到根外拒绝；选完之后被换成链接也拦得住', { skip: !isWin && 'junction 只在 Windows 上造' }, async () => {
  const link = path.join(VAULT, 'link');
  junction(link, outside);
  try {
    const x = await sign('admin', OPEN, [{ rel: 'link/secret.txt' }]);
    assert.equal(x.status, 403, JSON.stringify(x.json));
    assert.match(x.json.error, /链接到了你的空间以外/);
  } finally { unjunction(link); }

  // 先选一个正常文件，再把它所在的目录换成指到外面的 junction（外面放一个同名文件）
  mkdirSync(path.join(VAULT, 'swap'), { recursive: true });
  writeFileSync(path.join(VAULT, 'swap', 'secret.txt'), 'inside');
  const h = (await sign('admin', OPEN, [{ rel: 'swap/secret.txt' }])).json.files[0].handle;
  renameSync(path.join(VAULT, 'swap'), path.join(VAULT, 'swap-old'));
  junction(path.join(VAULT, 'swap'), outside);
  try {
    assert.equal((await call('GET', bridge(OPEN, 'files/read?h=' + h), { as: 'admin' })).status, 403);
    assert.equal((await call('POST', bridge(OPEN, 'files/write?h=' + h), { as: 'admin', raw: Buffer.from('pwn') })).status, 403);
    assert.equal(readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'top secret', '外面的文件没被改');
  } finally { unjunction(path.join(VAULT, 'swap')); }
});

test('文件句柄：撤销 page.files 当场作废这对插件 / 使用者的句柄（别人的不动）', async () => {
  assert.equal((await grant('admin', OPEN, 'page.files')).status, 200);
  const h = (await sign('admin', OPEN, [{ rel: 'docs/a.txt' }])).json.files[0].handle;
  // 成员自己空间里的文件
  const ctx = contextFor(memberIdentity);
  mkdirSync(ctx.cwd, { recursive: true });
  writeFileSync(path.join(ctx.cwd, 'm.txt'), 'member');
  assert.equal((await grant('member', OPEN, 'page.files')).status, 200);
  const mh = (await sign('member', OPEN, [{ rel: 'm.txt' }])).json.files[0];
  assert.equal(mh.mode, 'rw');
  assert.equal((await call('GET', bridge(OPEN, 'files/read?h=' + mh.handle), { as: 'member' })).buf.toString(), 'member');
  // 成员的 .bridge（会话与配置）不给
  mkdirSync(path.join(ctx.cwd, '.bridge'), { recursive: true });
  writeFileSync(path.join(ctx.cwd, '.bridge', 'x.json'), '{}');
  assert.equal((await sign('member', OPEN, [{ rel: '.bridge/x.json' }])).status, 403);

  assert.ok(_handleCount(OPEN, MEMBER_KEY()) >= 1);
  await grant('member', OPEN, 'page.files', false);
  assert.equal(_handleCount(OPEN, MEMBER_KEY()), 0);
  const gone = await call('GET', bridge(OPEN, 'files/stat?h=' + mh.handle), { as: 'member' });
  assert.equal(gone.status, 404);
  assert.match(gone.json.error, /失效/);
  assert.equal((await call('GET', bridge(OPEN, 'files/stat?h=' + h), { as: 'admin' })).status, 200, '主机的句柄不受影响');
});

test('文件句柄：空间里的 junction 指向本空间的 .bridge——选不了；选完之后被换成这种链接，读写也拦得住', { skip: !isWin && 'junction 只在 Windows 上造' }, async () => {
  const ctx = contextFor(memberIdentity);
  mkdirSync(path.join(ctx.cwd, '.bridge'), { recursive: true });
  writeFileSync(path.join(ctx.cwd, '.bridge', 'cfg.json'), '{"secret":1}');
  assert.equal((await grant('member', OPEN, 'page.files')).status, 200);
  // 字面路径不在 .bridge 里、真实位置在：按 realpath 认出来
  const alias = path.join(ctx.cwd, 'alias');
  junction(alias, path.join(ctx.cwd, '.bridge'));
  try {
    const x = await sign('member', OPEN, [{ rel: 'alias/cfg.json' }]);
    assert.equal(x.status, 403, JSON.stringify(x.json));
    assert.match(x.json.error, /受保护/);
  } finally { unjunction(alias); }

  // 先选一个正常文件，再把它所在的目录换成指向 .bridge 的 junction（里面放一个同名文件）
  mkdirSync(path.join(ctx.cwd, 'sw'), { recursive: true });
  writeFileSync(path.join(ctx.cwd, 'sw', 'cfg.json'), 'plain');
  const h = (await sign('member', OPEN, [{ rel: 'sw/cfg.json' }])).json.files[0].handle;
  renameSync(path.join(ctx.cwd, 'sw'), path.join(ctx.cwd, 'sw-old'));
  junction(path.join(ctx.cwd, 'sw'), path.join(ctx.cwd, '.bridge'));
  try {
    for (const op of ['files/stat', 'files/read']) {
      const r = await call('GET', bridge(OPEN, op + '?h=' + h), { as: 'member' });
      assert.equal(r.status, 403, op);
    }
    assert.equal((await call('POST', bridge(OPEN, 'files/write?h=' + h), { as: 'member', raw: Buffer.from('pwn') })).status, 403);
    assert.equal(readFileSync(path.join(ctx.cwd, '.bridge', 'cfg.json'), 'utf8'), '{"secret":1}', '.bridge 里的文件没被改');
  } finally { unjunction(path.join(ctx.cwd, 'sw')); }
});

test('文件句柄：页面中途断开读取，读流跟着收掉（不占着文件）', async () => {
  assert.equal((await grant('admin', OPEN, 'page.files')).status, 200);
  const big = path.join(VAULT, 'docs', 'big.bin');
  writeFileSync(big, Buffer.alloc(8 * 1024 * 1024, 7));
  const h = (await sign('admin', OPEN, [{ rel: 'docs/big.bin' }])).json.files[0].handle;
  // 另起一个小服务直接调 streamHandle，拿到它返回的读流（Windows 上打开着的文件照样删得掉，没法从外面看出占没占着）
  let stream = null;
  const srv = http.createServer((req, res) => { stream = streamHandle(useHandle(h, OPEN, 'admin'), res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    // 只收第一块就掐断连接
    await new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:' + srv.address().port + '/', (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
    });
    assert.ok(stream);
    if (!stream.closed) await Promise.race([new Promise((r) => stream.once('close', r)), new Promise((r) => setTimeout(r, 3000))]);
    assert.equal(stream.destroyed, true, '页面断开后读流没收掉，文件描述符会一直占着');
  } finally {
    srv.closeAllConnections?.();
    srv.close();
    unlinkSync(big);
  }
});

// ---- 宿主请求中转 ----
test('中转：request → 主界面 GET → complete → wait 拿到结果；别人的 404；处理过的 409', async () => {
  const mt = mintTicket(OPEN, memberIdentity, { app: 'main' }).ticket;
  const r = await call('POST', bridge(OPEN, 'host/request'), { ticket: mt, body: { type: 'pick.session', payload: { junk: 1 } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const req = r.json.req;
  assert.match(req, /^[A-Za-z0-9_-]{32}$/);
  const waiting = call('GET', bridge(OPEN, 'host/wait?req=' + req), { ticket: mt });

  assert.equal((await call('GET', '/api/plugins/host-requests/' + req, { as: 'admin' })).status, 404, '不是主机的请求');
  assert.equal((await call('GET', '/api/plugins/host-requests/' + req, { ticket: mt })).status, 401, '页面拿票够不着主界面那一头');
  const v = await call('GET', '/api/plugins/host-requests/' + req, { as: 'member' });
  assert.equal(v.status, 200);
  assert.deepEqual(v.json, { req, plugin: OPEN, pluginName: '插件 pg-open', app: 'main', appTitle: '主应用', type: 'pick.session', payload: {} });
  assert.equal((await call('GET', bridge(OPEN, 'host/wait?req=' + req), { as: 'admin' })).status, 404, '别人等不了');
  assert.equal((await call('GET', bridge(NODECL, 'host/wait?req=' + req), { as: 'member' })).status, 404, '别的插件等不了');

  const done = await call('POST', '/api/plugins/host-requests/' + req + '/complete', { as: 'member', body: { result: { sessionId: 'abcdef12-3456', title: '一个会话' } } });
  assert.deepEqual(done.json, { ok: true });
  const w = await waiting;
  assert.equal(w.status, 200);
  assert.deepEqual(w.json, { done: true, result: { sessionId: 'abcdef12-3456', title: '一个会话' } });
  // 完成之后再等：马上回结果；主界面再读 / 再交 409
  assert.deepEqual((await call('GET', bridge(OPEN, 'host/wait?req=' + req), { ticket: mt })).json.done, true);
  assert.equal((await call('GET', '/api/plugins/host-requests/' + req, { as: 'member' })).status, 409);
  assert.equal((await call('POST', '/api/plugins/host-requests/' + req + '/complete', { as: 'member', body: { result: {} } })).status, 409);
  assert.equal((await call('GET', '/api/plugins/host-requests/' + req + '/complete', { as: 'member' })).status, 404, '方法不对');
  assert.equal((await call('GET', '/api/plugins/host-requests/short', { as: 'member' })).status, 404);

  // 取消也算完成
  const c = (await call('POST', bridge(OPEN, 'host/request'), { as: 'member', body: { type: 'pick.session' } })).json.req;
  await call('POST', '/api/plugins/host-requests/' + c + '/complete', { as: 'member', body: { result: { cancelled: true } } });
  assert.deepEqual((await call('GET', bridge(OPEN, 'host/wait?req=' + c), { as: 'member' })).json, { done: true, result: { cancelled: true } });
});

test('中转：载荷清洗（类型、nav 目标、授权声明、截断）', async () => {
  const ask = (body) => call('POST', bridge(OPEN, 'host/request'), { as: 'member', body });
  assert.equal((await ask({ type: 'exec' })).status, 400);
  assert.equal((await ask({ type: 'nav', payload: { to: 'evil' } })).status, 400);
  assert.equal((await ask({ type: 'nav', payload: { to: 'session' } })).status, 400, '缺会话 id');
  assert.equal((await ask({ type: 'nav', payload: { to: 'app', app: 'Bad App' } })).status, 400);
  assert.equal((await ask({ type: 'grant', payload: { perm: 'net' } })).status, 400);
  assert.equal((await call('POST', bridge(NODECL, 'host/request'), { as: 'member', body: { type: 'grant', payload: { perm: 'page.chat' } } })).status, 400, '没声明');
  const v = async (body) => {
    const r = await ask(body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return (await call('GET', '/api/plugins/host-requests/' + r.json.req, { as: 'member' })).json;
  };
  const nav = await v({ type: 'nav', payload: { to: 'file', rel: 'r'.repeat(3000), ws: 'w', extra: 1 } });
  assert.deepEqual(Object.keys(nav.payload).sort(), ['rel', 'to', 'ws']);
  assert.equal(nav.payload.rel.length, 2000);
  assert.equal(nav.app, null, '嵌入模式没带 app');
  assert.deepEqual((await v({ type: 'nav', payload: { to: 'app', app: 'other-plugin:board' } })).payload, { to: 'app', app: 'other-plugin:board' });
  assert.equal((await v({ type: 'composer', payload: { text: 'x'.repeat(30000) } })).payload.text.length, 20000);
  assert.deepEqual((await v({ type: 'pick.file', payload: { multiple: 'yes', accept: '.txt' } })).payload, { multiple: false, accept: '.txt' });
  // 嵌入模式请求体里的 app：只认本插件确有的
  assert.equal((await v({ type: 'pick.session', app: 'main' })).appTitle, '主应用');
  assert.equal((await v({ type: 'pick.session', app: 'ghost' })).app, null);
});

test('中转：grant 与 pick.file 的完成走 bridge 的授权与签句柄', async () => {
  // grant：同意 → 写授权
  const g = (await call('POST', bridge(OPEN, 'host/request'), { as: 'member', body: { type: 'grant', payload: { perm: 'page.files' } } })).json.req;
  await call('POST', '/api/plugins/host-requests/' + g + '/complete', { as: 'member', body: { result: { allow: true } } });
  assert.deepEqual((await call('GET', bridge(OPEN, 'host/wait?req=' + g), { as: 'member' })).json, { done: true, result: { granted: true } });
  assert.ok((await call('GET', bridge(OPEN, 'grants'), { as: 'member' })).json.granted['page.files']);
  // grant：不同意
  const g2 = (await call('POST', bridge(OPEN, 'host/request'), { as: 'member', body: { type: 'grant', payload: { perm: 'page.chat' } } })).json.req;
  await call('POST', '/api/plugins/host-requests/' + g2 + '/complete', { as: 'member', body: { result: { allow: false } } });
  assert.deepEqual((await call('GET', bridge(OPEN, 'host/wait?req=' + g2), { as: 'member' })).json.result, { granted: false });

  // pick.file：单选只取第一项
  const p = (await call('POST', bridge(OPEN, 'host/request'), { as: 'member', body: { type: 'pick.file', payload: { multiple: false } } })).json.req;
  const c = await call('POST', '/api/plugins/host-requests/' + p + '/complete', { as: 'member', body: { result: { items: [{ rel: 'm.txt' }, { rel: 'm.txt' }] } } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const res = (await call('GET', bridge(OPEN, 'host/wait?req=' + p), { as: 'member' })).json.result;
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].name, 'm.txt');
  assert.equal((await call('GET', bridge(OPEN, 'files/read?h=' + res.files[0].handle), { as: 'member' })).buf.toString(), 'member');
  // pick.file：签不出来（文件不在）→ 主界面拿到错误，页面按取消收场
  const p2 = (await call('POST', bridge(OPEN, 'host/request'), { as: 'member', body: { type: 'pick.file' } })).json.req;
  assert.equal((await call('POST', '/api/plugins/host-requests/' + p2 + '/complete', { as: 'member', body: { result: { items: [{ rel: 'none.txt' }] } } })).status, 404);
  assert.equal((await call('GET', bridge(OPEN, 'host/wait?req=' + p2), { as: 'member' })).json.result.cancelled, true);
});

test('中转：每对插件 / 使用者最多 20 个未完成的；没完成的 wait 到点回 done:false；过期 404', async () => {
  const ask = (as) => call('POST', bridge(NODECL, 'host/request'), { as, body: { type: 'nav', payload: { to: 'home' } } });
  const reqs = [];
  for (let i = 0; i < HOST_OPEN_MAX; i++) {
    const r = await ask('member');
    assert.equal(r.status, 200, String(i));
    reqs.push(r.json.req);
  }
  const over = await ask('member');
  assert.equal(over.status, 429);
  assert.equal((await ask('admin')).status, 200, '别人不受影响');
  await call('POST', '/api/plugins/host-requests/' + reqs[0] + '/complete', { as: 'member', body: { result: { ok: true } } });
  assert.equal((await ask('member')).status, 200, '完成一个就又能提');
  assert.deepEqual((await call('GET', bridge(NODECL, 'host/wait?req=' + reqs[0]), { as: 'member' })).json, { done: true, result: { ok: true } });

  // 没完成：短等待到点回 done:false（路由里是 25 秒，这里直接调模块）
  assert.deepEqual(await waitHostRequest(reqs[1], NODECL, MEMBER_KEY(), { ms: 30 }), { done: false });
  // 页面断开：提前收掉
  const ac = new AbortController();
  const pending = waitHostRequest(reqs[2], NODECL, MEMBER_KEY(), { ms: 60_000, signal: ac.signal });
  ac.abort();
  assert.deepEqual(await pending, { done: false });

  // 过期（10 分钟）：拨快时钟
  const real = Date.now;
  Date.now = () => real() + HOST_TTL_MS + 1000;
  try {
    assert.equal((await call('GET', bridge(NODECL, 'host/wait?req=' + reqs[3]), { as: 'member' })).status, 404);
    assert.equal((await call('GET', '/api/plugins/host-requests/' + reqs[4], { as: 'member' })).status, 404);
    assert.equal((await ask('member')).status, 200, '过期的不再占名额');
  } finally { Date.now = real; }
  // 模块直调：不认识的类型
  assert.throws(() => createHostRequest(contextFor(memberIdentity), NODECL, null, 'nope', {}), (e) => e.status === 400);
});

// 放最后：停用插件会让它的句柄全部作废
test('停用插件：句柄作废、页面能力 404', async () => {
  const h = (await sign('admin', OPEN, [{ rel: 'docs/a.txt' }])).json.files[0].handle;
  assert.ok(_handleCount(OPEN) >= 1);
  await kernel.setEnabled(OPEN, false);
  assert.equal(kernel.isActive(OPEN), false);
  assert.equal(_handleCount(OPEN), 0);
  assert.equal((await call('GET', bridge(OPEN, 'files/stat?h=' + h), { as: 'admin' })).status, 404);
  assert.equal((await call('GET', bridge(OPEN, 'kv'), { as: 'member' })).status, 404);
  assert.equal((await sign('admin', OPEN, [{ rel: 'docs/a.txt' }])).status, 404);
  // 撤销随时可以（插件停了也能撤）；同意要插件开着
  assert.equal((await grant('admin', OPEN, 'page.files', false)).status, 200);
  assert.equal((await grant('admin', OPEN, 'page.files', true)).status, 409);
  await kernel.setEnabled(OPEN, true);
  assert.equal((await call('GET', bridge(OPEN, 'files/stat?h=' + h), { as: 'admin' })).status, 404, '重新启用旧句柄也不复活');
});
