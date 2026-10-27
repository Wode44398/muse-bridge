// 面板槽位：清单 ui 声明、插件票据（只在本插件的 /api/plugin/<id>/ 认、可续期、插件停用失效）、
// 面板列表按身份过滤、插件页面带 CSP sandbox、SDK 静态文件、独立页面事件流。起一个真 HTTP 服务走一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-panels-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { normUi } = await import('./discover.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerPluginRoutes } = await import('../routes/plugins.mjs');
const { mintTicket, resolveTicket } = await import('./tickets.mjs');

installMixins();
const router = createRouter();
// 测试身份：x-test 头 admin / member / 无
const identify = (req) => {
  const k = req.headers['x-test'];
  if (k === 'admin') return { kind: 'admin', user: null };
  if (k === 'member') return { kind: 'user', user: 'mem1', name: 'mem1', tier: 'user', agents: ['claude'] };
  return { kind: 'none', user: null };
};
kernel.provide('router', router);
kernel.provide('auth', { identify, authOk: () => false });
registerPluginRoutes(router, { identify });
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

function pluginDir(id) {
  const d = path.join(tmp, 'src-' + id);
  mkdirSync(path.join(d, 'web'), { recursive: true });
  writeFileSync(path.join(d, 'web', 'index.html'), '<!doctype html><p>hi</p>');
  writeFileSync(path.join(d, 'web', 'app.js'), 'console.log(1)');
  return d;
}
async function add(id, ui, apply = () => {}) {
  await kernel.register({ id, name: id, source: 'local', dir: pluginDir(id), extra: { ui: normUi({ id, name: id, ui }) }, load: async () => ({ apply }) });
}

let seenKind = null;
test.before(async () => {
  await kernel.start();
  await add('hostonly', { panel: { page: 'web/index.html', title: '主机面板', icon: 'chat' } }, (ctx) => {
    ctx.route('GET', '/api/plugin/hostonly/me', (req, res) => { const c = ctx.http.user(req, res); if (!c) return; seenKind = c.kind; ctx.http.json(res, 200, { kind: c.kind }); });
    ctx.route('GET', '/api/plugin-other/x', (req, res) => { const c = ctx.http.user(req, res); if (!c) return; ctx.http.json(res, 200, { kind: c.kind }); });
  });
  await add('shared', { panel: 'web/index.html', settings: 'web/index.html', who: 'members' }, (ctx) => {
    ctx.route('POST', '/api/plugin/shared/ping', (req, res) => { const c = ctx.http.user(req, res); if (!c) return; ctx.bus.toPage('pong', { from: c.kind }); ctx.http.json(res, 200, { ok: true }); });
  });
});
test.after(async () => { server.closeAllConnections?.(); server.close(); await kernel.stop(); });
// 临时数据目录在进程退出时再删：运行中删掉会让文件监视卡住进程（Windows）
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const get = (p, h = {}) => fetch(base + p, { headers: h });

test('ui 声明：页面必须在 web/ 下；web.page 视同面板', () => {
  assert.equal(normUi({ id: 'a', web: { page: 'web/x.html' } }).panel.page, 'web/x.html');
  assert.equal(normUi({ id: 'a', ui: { panel: 'x.html' } }).panel, null);
  assert.equal(normUi({ id: 'a', ui: { settings: 'web/../../etc' } }).settings, null);
  assert.equal(normUi({ id: 'a', ui: { who: 'everyone' } }).who, 'host');
});

test('面板列表：主机看得到全部，成员只看得到 who:members 的；没登录 401', async () => {
  const a = await (await get('/api/plugins/panels', { 'x-test': 'admin' })).json();
  assert.deepEqual(a.panels.map((p) => p.id).sort(), ['hostonly', 'shared']);
  const m = await (await get('/api/plugins/panels', { 'x-test': 'member' })).json();
  assert.deepEqual(m.panels.map((p) => p.id), ['shared']);
  assert.equal((await get('/api/plugins/panels')).status, 401);
});

test('签票：成员签不了主机专用插件的票、签不了设置页的票', async () => {
  const post = (h, b) => fetch(base + '/api/plugins/ticket', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
  assert.equal((await post({ 'x-test': 'member' }, { id: 'hostonly' })).status, 403);
  assert.equal((await post({ 'x-test': 'member' }, { id: 'shared', which: 'settings' })).status, 403);
  const r = await (await post({ 'x-test': 'member' }, { id: 'shared' })).json();
  assert.match(r.ticket, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(r.page, '/plugins/shared/web/index.html');
});

test('票据：只在本插件自己的 /api/plugin/<id>/ 下认；别的插件、别的路径、过期都不认', async () => {
  const { ticket } = mintTicket('hostonly', { kind: 'admin', user: null });
  const ok = await get('/api/plugin/hostonly/me', { authorization: 'Plugin ' + ticket });
  assert.equal(ok.status, 200);
  assert.equal(seenKind, 'admin');
  // 本插件挂在别的前缀下的接口：票不认（落回普通登录判定 → 401）
  assert.equal((await get('/api/plugin-other/x', { authorization: 'Plugin ' + ticket })).status, 401);
  // 拿 A 插件的票打 B 插件
  const { ticket: t2 } = mintTicket('shared', { kind: 'admin', user: null });
  assert.equal(resolveTicket(t2, 'hostonly'), null);
  assert.equal((await get('/api/plugin/hostonly/me', { authorization: 'Plugin ' + t2 })).status, 401);
  assert.equal((await get('/api/plugin/hostonly/me', { authorization: 'Plugin bogus-bogus-bogus-bogus' })).status, 401);
});

test('插件页面带 CSP sandbox；SDK 文件不带；插件关掉页面 404', async () => {
  const page = await get('/plugins/hostonly/web/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') || '', /^sandbox allow-scripts/);
  assert.doesNotMatch(page.headers.get('content-security-policy') || '', /allow-same-origin/);
  const js = await get('/plugins/hostonly/web/app.js');
  assert.equal(js.headers.get('content-security-policy'), null);
  const sdk = await get('/plugins/_sdk/bridge-plugin.js');
  assert.equal(sdk.status, 200);
  assert.match(await sdk.text(), /export const bridge/);
  assert.equal((await get('/plugins/_sdk/../state.mjs')).status, 404);
});

test('独立页面事件流：带票收得到 ctx.bus.toPage 推的事件；成员的票只收 who:members 插件的', async () => {
  const { ticket } = mintTicket('shared', { kind: 'user', user: 'mem1', name: 'mem1', tier: 'user', agents: ['claude'] });
  const ac = new AbortController();
  const res = await fetch(base + '/api/plugins/page-events?id=shared', { headers: { authorization: 'Plugin ' + ticket }, signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  await fetch(base + '/api/plugin/shared/ping', { method: 'POST', headers: { authorization: 'Plugin ' + ticket } });
  const t0 = Date.now();
  while (!buf.includes('"pong"') && Date.now() - t0 < 3000) { const { value } = await reader.read(); buf += dec.decode(value); }
  ac.abort();
  assert.match(buf, /"event":"pong"/);
  assert.match(buf, /"from":"user"/);
  assert.equal((await get('/api/plugins/page-events?id=shared', { authorization: 'Plugin nope-nope-nope-nope' })).status, 401);
});

test('插件停用后票据失效', async () => {
  const { ticket } = mintTicket('hostonly', { kind: 'admin', user: null });
  assert.equal((await get('/api/plugin/hostonly/me', { authorization: 'Plugin ' + ticket })).status, 200);
  await kernel.setEnabled('hostonly', false);
  assert.notEqual((await get('/api/plugin/hostonly/me', { authorization: 'Plugin ' + ticket })).status, 200);
  assert.equal((await get('/plugins/hostonly/web/')).status, 404);
});
