// 样板插件 src/plugins/examples/qq-onebot 的端到端：假 OneBot 协议端（记录发出的消息）+ 真 HTTP 回调，执行器换成假的。
// 不碰真群：上报是伪造的、发消息打到本地假服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-qq-onebot-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');
const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'examples', 'qq-onebot');

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { linkLocal } = await import('./discover.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { installCoreResolver } = await import('../modules/core-resolve.mjs');
const chat = await import('./chat.mjs');
const { refreshStatuses, panelView, optionsFor } = await import('./panel.mjs');
const users = await import('../users.mjs');
installCoreResolver();
installMixins();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(30); } return false; };

// 假 OneBot 协议端
const sent = [];
const onebotSrv = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const act = req.url.slice(1);
  const data = act === 'get_login_info' ? { user_id: 10001, nickname: 'bot' }
    : act === 'get_group_list' ? [{ group_id: 555, group_name: '测试群', member_count: 9 }, { group_id: 666, group_name: '别的群', member_count: 3 }]
    : act.startsWith('send_') ? (sent.push({ act, auth: req.headers.authorization, ...JSON.parse(body || '{}') }), { message_id: 1 }) : null;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
});
await new Promise((r) => onebotSrv.listen(0, '127.0.0.1', r));

// bridge：真路由器 + HTTP 服务（回调走 isLocalDirect，要真套接字）
const router = createRouter();
const identify = (req) => (req.headers['x-test'] === 'admin' ? { kind: 'admin', user: null } : { kind: 'none', user: null });
kernel.provide('router', router);
kernel.provide('auth', { identify, authOk: () => false });
const bridgeSrv = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => bridgeSrv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + bridgeSrv.address().port;

const asks = [];
test.before(async () => {
  await users.createUser('qqbot', 'qqbot-pass-123', 'user');
  users.setService('qqbot', true);
  chat._setTestRunner(async (uctx, o) => {
    asks.push({ user: uctx.user, prompt: o.prompt, resume: o.resume, append: o.append, effort: o.effort });
    o.onInit?.('sess-' + asks.length);
    return { sessionId: o.resume || 'sess-' + asks.length, text: '答' + asks.length, isError: false, files: [] };
  });
  await kernel.start();
  await linkLocal(kernel, EXAMPLE);
  await kernel.setConfig('qq-onebot', {
    runAs: 'qqbot', apiUrl: 'http://127.0.0.1:' + onebotSrv.address().port, apiToken: 'tok',
    prefix: '/ai', cooldownSec: 0, allowGroups: ['555', '777'], groups: { 777: { enabled: false }, 555: { effort: 'high' } },
  });
});
test.after(async () => {
  chat._setTestRunner(null);
  for (const s of [bridgeSrv, onebotSrv]) { s.closeAllConnections?.(); s.close(); }
  await kernel.stop();
});
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const report = (ev) => fetch(base + '/hook/qq-onebot/onebot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
const groupMsg = (gid, text, extra = {}) => ({
  post_type: 'message', message_type: 'group', self_id: 10001, group_id: gid, user_id: 42, message_id: 900 + sent.length,
  sender: { nickname: '小明', card: '' }, message: [{ type: 'text', data: { text } }], ...extra,
});

test('启用：状态块在线、群号下拉来自协议端', async () => {
  assert.equal(kernel.get('qq-onebot').status, 'active', kernel.get('qq-onebot').error || '');
  await sleep(200);
  await refreshStatuses(['qq-onebot']);
  const pv = panelView('qq-onebot');
  assert.equal(pv.panelStatus.tone, 'ok', JSON.stringify(pv.panelStatus));
  assert.equal(pv.hooks[0].path, '/hook/qq-onebot/onebot');
  // 状态块不能盖掉插件摘要里的运行状态（active / error）
  const { pluginView } = await import('../routes/plugins.mjs');
  const v = pluginView(kernel.get('qq-onebot'));
  assert.equal(v.status, 'active');
  assert.equal(v.panelStatus.text, 'QQ 在线');
  assert.deepEqual((await optionsFor('qq-onebot', 'groups.$key', {})).map((o) => o.value), ['555', '666']);
});

test('群里用前缀提问：以授权账号跑 Claude，回答带引用和 @ 发回群里；同群续写会话、按群的思考强度生效', async () => {
  assert.equal((await report(groupMsg(555, '/ai 今天天气'))).status, 200);
  assert.ok(await until(() => sent.length === 1));
  assert.equal(asks[0].user, users.accountIdOf('qqbot'));
  assert.match(asks[0].prompt, /【小明（QQ 42）】今天天气/);
  assert.match(asks[0].append, /QQ 不渲染 Markdown/);
  assert.equal(asks[0].effort, 'high');
  assert.equal(sent[0].act, 'send_group_msg');
  assert.equal(sent[0].group_id, 555);
  assert.equal(sent[0].auth, 'Bearer tok');
  assert.deepEqual(sent[0].message.map((m) => m.type), ['reply', 'at', 'text', 'text']);
  assert.equal(sent[0].message.at(-1).data.text, '答1');
  await report(groupMsg(555, '/ai 再问一句'));
  assert.ok(await until(() => sent.length === 2));
  assert.equal(asks[1].resume, 'sess-1');
});

test('不触发的：没前缀没 @、白名单外的群、按群关掉的群', async () => {
  const before = sent.length;
  await report(groupMsg(555, '随便聊聊'));
  await report(groupMsg(666, '/ai 白名单外'));
  await report(groupMsg(777, '/ai 本群关了'));
  await sleep(300);
  assert.equal(sent.length, before);
});

test('@ 机器人也触发；私聊直接回答', async () => {
  await report(groupMsg(555, ' 帮个忙', { message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 帮个忙' } }] }));
  assert.ok(await until(() => sent.some((s) => s.message.at(-1).data.text === '答3')));
  await report({ post_type: 'message', message_type: 'private', self_id: 10001, user_id: 77, message_id: 5, sender: { nickname: '阿花' }, message: [{ type: 'text', data: { text: '你好' } }] });
  assert.ok(await until(() => sent.some((s) => s.act === 'send_private_msg')));
  assert.equal(sent.find((s) => s.act === 'send_private_msg').user_id, 77);
});

test('控制台接口：要主机身份；能看到聊天记录', async () => {
  assert.equal((await fetch(base + '/api/plugin/qq-onebot/chats')).status, 401);
  const r = await (await fetch(base + '/api/plugin/qq-onebot/chats', { headers: { 'x-test': 'admin' } })).json();
  assert.ok(r.chats.some((c) => c.cid === 'g555' && c.name === '测试群'));
  const log = await (await fetch(base + '/api/plugin/qq-onebot/log?cid=g555', { headers: { 'x-test': 'admin' } })).json();
  assert.ok(log.messages.some((m) => m.bot && m.text === '答1'));
});

test('回调只收本机直连：带隧道头的上报被拒', async () => {
  const r = await fetch(base + '/hook/qq-onebot/onebot', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: '{}' });
  assert.equal(r.status, 403);
});
