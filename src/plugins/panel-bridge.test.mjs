// 插件页面自己改设置、按按钮（/api/plugin/<id>/_bridge/*，SDK 的 bridge.config / options / action / status），
// 以及 ctx.process.spawn 的 args 函数（每次启动现算）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-panel-bridge-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerPluginRoutes } = await import('../routes/plugins.mjs');
const { mintTicket } = await import('./tickets.mjs');
installMixins();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(40); } return false; };

const router = createRouter();
const identify = (req) => (req.headers['x-test'] === 'admin' ? { kind: 'admin', user: null } : req.headers['x-test'] === 'member' ? { kind: 'user', user: 'm1' } : { kind: 'none', user: null });
kernel.provide('router', router);
kernel.provide('auth', { identify, authOk: () => false });
registerPluginRoutes(router, { identify });
const srv = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;

let applies = 0, hot = 0, clicks = 0;
test.before(async () => {
  await kernel.start();
  await kernel.register({
    id: 'pb', name: 'pb', source: 'local', dir: tmp, pluginApi: 3,
    config: {
      paused: { type: 'boolean', default: false },
      mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
      groups: { type: 'array', items: { type: 'string', options: 'plugin' } },
      model: { type: 'string', options: 'claude.models' },
      token: { type: 'string', secret: true },
    },
    load: async () => ({
      apply(ctx) {
        applies++;
        ctx.onConfig(() => { hot++; });
        ctx.configOptions('groups', () => [{ value: '1', label: '一群' }]);
        ctx.action({ id: 'poke', label: '戳一下', handler: () => { clicks++; return '戳了'; } });
        ctx.status(() => ({ tone: 'ok', text: '好着呢' }));
        // 插件自己挂的精确路径优先于 _bridge 前缀路由
        ctx.route('GET', '/api/plugin/pb/hello', (req, res) => ctx.http.json(res, 200, { hi: 1 }));
      },
    }),
  });
});
test.after(async () => { srv.closeAllConnections?.(); srv.close(); await kernel.stop(); });
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const req = (p, { who = 'admin', body, auth } = {}) => fetch(base + '/api/plugin/pb/' + p, {
  method: body ? 'POST' : 'GET',
  headers: { ...(who ? { 'x-test': who } : {}), ...(auth ? { Authorization: auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test('_bridge/config：读 schema 与打码配置；patch 合并、热更新不重启；校验错拒', async () => {
  await kernel.setConfig('pb', { token: 's3cret' });
  const a0 = applies;
  const g = await (await req('_bridge/config')).json();
  assert.equal(g.schema.mode.type, 'string');
  assert.equal(g.config.token, '••••••••');
  const r = await req('_bridge/config', { body: { patch: { paused: true, token: '••••••••' } } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.config.paused, true);
  assert.equal(kernel.configOf('pb').token, 's3cret', '打码串 = 沿用旧值');
  assert.equal(applies, a0, '登记了 onConfig：没重启');
  assert.ok(hot >= 1);
  const bad = await req('_bridge/config', { body: { patch: { mode: 'zzz' } } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /只能是/);
});

test('_bridge/options / actions / action / status', async () => {
  assert.deepEqual((await (await req('_bridge/options?field=groups[]')).json()).options, [{ value: '1', label: '一群' }]);
  assert.ok((await (await req('_bridge/options?field=model')).json()).options.length > 0);
  assert.deepEqual((await (await req('_bridge/actions')).json()).actions.map((a) => a.id), ['poke']);
  const r = await (await req('_bridge/action', { body: { action: 'poke' } })).json();
  assert.equal(r.message, '戳了');
  assert.equal(clicks, 1);
  assert.equal((await (await req('_bridge/status')).json()).status.text, '好着呢');
  assert.deepEqual(await (await req('hello')).json(), { hi: 1 }, '插件自己的精确路径照常');
});

test('权限：没登录 401、成员 403；插件票据按开面板的人算', async () => {
  assert.equal((await req('_bridge/config', { who: null })).status, 401);
  assert.equal((await req('_bridge/config', { who: 'member' })).status, 403);
  const t = mintTicket('pb', { kind: 'admin', user: null }).ticket;
  assert.equal((await req('_bridge/status', { who: null, auth: 'Plugin ' + t })).status, 200);
  assert.equal((await req('_bridge/nope')).status, 404);
});

test('ctx.process.spawn：args 是函数时每次（重）启动现算', async () => {
  let flag = 'one', h;
  const out = path.join(tmp, 'argv.txt');
  writeFileSync(path.join(tmp, 'w.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2], process.argv[3] + '\\n'); setInterval(() => {}, 1000);");
  await kernel.register({ id: 'pa', name: 'pa', source: 'local', dir: tmp, load: async () => ({ apply(ctx) { h = ctx.process.spawn('w', { command: process.execPath, args: () => [path.join(tmp, 'w.mjs'), out, flag] }); } }) });
  assert.ok(await until(() => { try { return readFileSync(out, 'utf8').includes('one'); } catch { return false; } }));
  flag = 'two';
  await h.restart();
  assert.ok(await until(() => readFileSync(out, 'utf8').includes('two')));
  await kernel.setEnabled('pa', false);
});
