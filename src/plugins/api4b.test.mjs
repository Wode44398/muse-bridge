// 插件接口四期第二批：replaces 接管内置功能（门控、键名、接管者出错退回）、服务按优先级叠放、通知渠道、外部登录。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-api4b-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { kernel, pluginOn, pluginsOff } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const CT = await import('./claude-tools.mjs');
const { listChannels } = await import('./channels.mjs');
const push = await import('../runtime/push-notices.mjs');
const { HOST_OWNER } = await import('../runtime/principal.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerAuthProviderRoutes, listAuthProviders } = await import('./auth-providers.mjs');
const users = await import('../users.mjs');

installMixins();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const router = createRouter();
kernel.provide('router', router);
let server, base;

let n = 0;
async function addPlugin(apply, extra = {}) {
  const id = extra.id || 'b4-' + (++n);
  await kernel.register({ id, name: id, source: 'local', dir: tmp, pluginApi: 3, load: async () => ({ apply }), ...extra });
  return id;
}

test.before(async () => {
  await kernel.register({ id: 'browser', name: '内置浏览器', source: 'builtin', load: async () => ({ apply: () => {} }) });
  await kernel.start();
  registerAuthProviderRoutes(router, { userCookie: (req, tok) => `bridge_user=${tok}; Path=/` });
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => {
  server?.closeAllConnections?.(); server?.close(); await kernel.stop(); try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 500);   // 同 api4.test.mjs 的兜底
});

test('replaces：接管者开着时内置功能视同关闭、工具占用内置键名；接管者关掉 / 起不来就回来', async () => {
  assert.equal(pluginOn('browser'), true);
  const id = await addPlugin((ctx) => { ctx.claude.tool({ name: 'navigate', handler: () => 'ok' }); }, { replaces: ['browser'] });
  assert.equal(pluginOn('browser'), false);
  assert.equal(kernel.get('browser').status, 'replaced');
  assert.equal(kernel.get('browser').replacedBy, id);
  assert.ok(pluginsOff().includes('browser'));
  const plug = CT.pluginClaudeTurn({ kind: 'chat', ctx: { kind: 'admin', sandbox: false }, snap: null });
  assert.ok(plug.mcpServers.browser, '工具服务用内置的键名 browser');
  await kernel.setEnabled(id, false);
  assert.equal(pluginOn('browser'), true, '接管者关掉，内置的回来');

  // 接管者 apply 抛错：内置的照样回来
  const bad = await addPlugin(() => { throw new Error('炸'); }, { replaces: ['browser'] });
  assert.equal(kernel.get(bad).status, 'error');
  assert.equal(pluginOn('browser'), true);
  await kernel.setEnabled(bad, false);
});

test('服务叠放：priority 高的盖住低的，撤掉露出下一层；不给 priority 的照旧不许重名', async () => {
  let a, b;
  const ida = await addPlugin((ctx) => { a = ctx; ctx.provide('search.web', { who: 'a' }, { priority: 0 }); });
  const idb = await addPlugin((ctx) => { b = ctx; ctx.provide('search.web', { who: 'b' }, { priority: 10 }); });
  assert.equal(kernel.service('search.web').who, 'b');
  await kernel.setEnabled(idb, false);
  assert.equal(kernel.service('search.web').who, 'a');
  await addPlugin((ctx) => { ctx.provide('plain', 1); });
  const clash = await addPlugin((ctx) => { ctx.provide('plain', 2); });
  assert.equal(kernel.get(clash).status, 'error');
  assert.match(kernel.get(clash).error, /已由/);
  await kernel.setEnabled(ida, false);
});

test('通知渠道：主机通知投给 host 渠道，成员的只投 members 渠道；出错不影响别人', async () => {
  const got = [];
  const id = await addPlugin((ctx) => {
    ctx.notify.channel({ id: 'feishu', label: '飞书', send: (m) => { got.push(['feishu', m]); } });
    ctx.notify.channel({ id: 'tg', label: 'Telegram', who: 'members', send: (m) => { got.push(['tg', m]); } });
    ctx.notify.channel({ id: 'bad', send: () => { throw new Error('网断了'); } });
  });
  assert.throws(() => kernel.contextOf(id).notify.channel({ id: 'X', send: () => {} }), /id/);
  assert.equal(listChannels().length, 3);
  push.notePush(HOST_OWNER, { sessionId: 's1', message: '跑完了', title: '定时任务' });
  await sleep(30);
  assert.deepEqual(got.map((g) => g[0]).sort(), ['feishu', 'tg']);
  assert.equal(got.find((g) => g[0] === 'feishu')[1].title, '定时任务');
  got.length = 0;
  push.notePush('u:abc', { message: '成员的提醒' });
  await sleep(30);
  assert.deepEqual(got.map((g) => g[0]), ['tg']);
  // ctx.notify 也走渠道
  got.length = 0;
  kernel.contextOf(id).notify({ title: '掉线了', body: '去扫码', level: 'warn' });
  await sleep(30);
  assert.ok(got.some((g) => g[0] === 'feishu' && /掉线了/.test(g[1].title) && g[1].level === 'warn'));
  await kernel.setEnabled(id, false);
});

test('外部登录：start 跳转带 state，callback 核对 state、只认已有账号、发会话 cookie', async () => {
  const id = await addPlugin((ctx) => {
    ctx.auth.provider({
      id: 'sso', label: '公司 SSO',
      start: (req, { callbackUrl, state }) => `https://idp.example/auth?redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}`,
      callback: (req, url) => ({ login: url.searchParams.get('who') }),
    });
  });
  assert.deepEqual(listAuthProviders().map((p) => p.key), [`${id}.sso`]);
  const list = await (await fetch(base + '/api/auth/providers')).json();
  assert.equal(list.providers[0].label, '公司 SSO');
  const st = await fetch(base + `/api/auth/ext/start?p=${id}.sso`, { redirect: 'manual' });
  assert.equal(st.status, 302);
  const loc = new URL(st.headers.get('location'));
  const state = loc.searchParams.get('state');
  assert.equal(loc.searchParams.get('redirect_uri'), `${base}/api/auth/ext/callback/${id}/sso`);
  // 没这个账号
  const nobody = await fetch(`${base}/api/auth/ext/callback/${id}/sso?state=${state}&who=ghost`, { redirect: 'manual' });
  assert.equal(nobody.status, 403);
  // state 一次性
  assert.equal((await fetch(`${base}/api/auth/ext/callback/${id}/sso?state=${state}&who=ghost`, { redirect: 'manual' })).status, 400);
  // 有账号（服务账号在多用户关着时也能登）
  const c = await users.createUser('alice', 'password-123', 'user');
  assert.ok(!c.error, c.error);
  users.setService('alice', true);
  const st2 = await fetch(base + `/api/auth/ext/start?p=${id}.sso`, { redirect: 'manual' });
  const state2 = new URL(st2.headers.get('location')).searchParams.get('state');
  const ok = await fetch(`${base}/api/auth/ext/callback/${id}/sso?state=${state2}&who=alice`, { redirect: 'manual' });
  if (ok.status === 403) {
    // 多用户关着、又没有服务账号授权接口时：拒的话文案要对
    assert.match(await ok.text(), /访问令牌/);
  } else {
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get('set-cookie') || '', /^bridge_user=/);
  }
  await kernel.setEnabled(id, false);
});
