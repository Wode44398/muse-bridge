// 插件运行环境：配置 schema 的结构化字段、ctx.chat（授权 / 排队 / 会话续写 / 停用收尾）、ctx.process（收尸 / 重启 / 日志 / 残留清理）、
// ctx.webhook（校验）、ctx.status / action / configOptions / store。执行器换成假的，不真起 Claude。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-env-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { normalizeSchema, validateConfig, resolveConfig } = await import('../kernel/schema.mjs');
const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const chat = await import('./chat.mjs');
const { verifyRequest, checkVerifySpec } = await import('./webhook.mjs');
const { panelView, refreshStatuses, runAction, optionsFor } = await import('./panel.mjs');
const { killTree } = await import('./process.mjs');
const users = await import('../users.mjs');

installMixins();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; };

// 一个假路由器（ctx.route / ctx.webhook 要）
const routes = new Map();
kernel.provide('router', {
  on: (m, p, h) => { for (const x of [].concat(m)) routes.set(x + ' ' + p, h); return () => { for (const x of [].concat(m)) routes.delete(x + ' ' + p); }; },
  use: () => () => {}, prefix: () => () => {}, has: (m, p) => routes.has(m + ' ' + p),
});

let n = 0;
async function addPlugin(apply, extra = {}) {
  const id = 'env-' + (++n);
  await kernel.register({ id, name: id, source: 'local', dir: tmp, load: async () => ({ apply }), ...extra });
  return id;
}

test.before(async () => { await kernel.start(); });
test.after(async () => { await kernel.stop(); chat._setTestRunner(null); try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('schema：map / array.items / object.fields / user 的校验与默认值', () => {
  const schema = normalizeSchema({
    allow: { type: 'array', items: { type: 'string', max: 12 }, max: 3 },
    groups: { type: 'map', key: { pattern: '^\\d+$' }, value: { enabled: { type: 'boolean', default: true }, effort: { type: 'string', enum: ['low', 'high'] } } },
    runAs: { type: 'user', grant: 'chat' },
    box: { type: 'object', fields: { a: { type: 'integer', default: 1 } } },
  });
  const ok = validateConfig(schema, { allow: ['1', '2'], groups: { 123: { effort: 'low' } }, runAs: ' bot ', box: { a: '5', junk: 1 } });
  assert.deepEqual(ok, { allow: ['1', '2'], groups: { 123: { enabled: true, effort: 'low' } }, runAs: 'bot', box: { a: 5 } });
  assert.throws(() => validateConfig(schema, { allow: ['1', '2', '3', '4'] }), /最多 3 项/);
  assert.throws(() => validateConfig(schema, { groups: { abc: {} } }), /格式不对/);
  assert.throws(() => validateConfig(schema, { groups: { 1: { effort: 'max' } } }), /只能是/);
  assert.throws(() => validateConfig(schema, { runAs: '@host' }), /不能选服务器主机/);
  assert.throws(() => normalizeSchema({ x: { type: 'map' } }), /要写 value/);
  assert.throws(() => normalizeSchema({ x: { type: 'user', grant: 'all' } }), /grant/);
  // 结构化字段没写默认值：给空表 / 空列表 / 子字段默认值，插件不用判空
  const empty = resolveConfig(schema, {}).config;
  assert.deepEqual(empty.groups, {});
  assert.deepEqual(empty.allow, []);
  assert.deepEqual(empty.box, { a: 1 });
  // 存着的坏值退回默认、记问题
  const r = resolveConfig(schema, { box: { a: 'x' } });
  assert.equal(r.problems.length, 1);
});

test('ctx.chat：没授权的账号直接拒；授权后排队串行、记住会话续写', async () => {
  await users.createUser('pbot', 'pbot-pass-123', 'user');
  users.setService('pbot', true);
  const calls = [];
  chat._setTestRunner(async (uctx, o) => {
    calls.push({ user: uctx.user, kind: uctx.kind, resume: o.resume, prompt: o.prompt, append: o.append });
    o.onInit?.('sess-' + calls.length);
    o.onEvent?.({ type: 'text', text: '在想' });
    await sleep(40);
    return { sessionId: o.resume || 'sess-' + calls.length, text: '答：' + o.prompt, isError: false, files: [] };
  });
  let api;
  const id = await addPlugin((ctx) => { api = ctx; }, { config: { runAs: { type: 'user', grant: 'chat' } } });
  assert.throws(() => api.chat.run({ as: 'pbot', session: 'g1', message: 'hi' }), /没有授权/);
  await kernel.setConfig(id, { runAs: 'pbot' });
  api = kernel.contextOf(id);
  const t1 = api.chat.run({ as: 'pbot', session: 'g1', message: '一' });
  const t2 = api.chat.run({ as: 'pbot', session: 'g1', message: '二' });
  const frames = [];
  for await (const ev of t1.events) frames.push(ev.type);
  assert.deepEqual(frames, ['queued', 'start', 'text', 'done']);
  const r2 = await t2.result;
  assert.equal(r2.text, '答：二');
  assert.equal(calls[0].resume, null);
  assert.equal(calls[1].resume, 'sess-1');            // 同键续写
  assert.match(calls[0].append, /代为发起/);
  assert.equal(api.chat.sessionOf('pbot', 'g1'), 'sess-1');
  assert.equal(api.chat.reset('pbot', 'g1'), true);
  assert.equal(api.chat.sessionOf('pbot', 'g1'), null);
});

test('ctx.chat：同账号并行上限、stop 取消排队中的、停用插件时全部收尾', async () => {
  let running = 0, peak = 0;
  chat._setTestRunner(async (uctx, o) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => { const t = setTimeout(r, 150); o.signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); });
    running--;
    return { sessionId: 's', text: o.signal?.aborted ? '已停止' : 'ok', isError: !!o.signal?.aborted, files: [] };
  });
  const id = await addPlugin(() => {}, { config: { runAs: { type: 'user', grant: 'chat' } } });
  await kernel.setConfig(id, { runAs: 'pbot' });
  const api = kernel.contextOf(id);
  api.chat.configure({ maxParallel: 2 });
  const ts = [1, 2, 3, 4].map((i) => api.chat.run({ as: 'pbot', session: 's' + i, message: 'x' }));
  ts[3].stop();
  const rs = await Promise.all(ts.map((t) => t.result));
  assert.equal(peak, 2);
  assert.equal(rs[3].isError, true);
  // 停用：跑着的被 abort
  const long = api.chat.run({ as: 'pbot', session: 'z', message: 'x' });
  await sleep(30);
  await kernel.setEnabled(id, false);
  const r = await long.result;
  assert.equal(r.isError, true);
});

test('ctx.chat：主机本人要 allowHost 字段才能授权；多用户关着时普通账号不能代跑', async () => {
  await users.createUser('pnorm', 'pnorm-pass-123', 'user');
  const id = await addPlugin(() => {}, { config: { runAs: { type: 'user', grant: 'chat', allowHost: true } } });
  await kernel.setConfig(id, { runAs: 'pnorm' });
  assert.throws(() => kernel.contextOf(id).chat.run({ as: 'pnorm', session: 'a', message: 'x' }), /多用户模式关着|服务账号/);
  await kernel.setConfig(id, { runAs: '@host' });
  assert.equal(chat.identityFor(id, '@host').kind, 'admin');
  assert.equal(chat.grantNeedsConfirm('@host'), true);
  assert.equal(chat.grantNeedsConfirm(chat.normAccount('pbot')), false);
});

test('ctx.files.put：存进账号的上传目录，名字清洗', async () => {
  const id = await addPlugin(() => {}, { config: { runAs: { type: 'user', grant: 'chat' } } });
  await kernel.setConfig(id, { runAs: 'pbot' });
  const f = kernel.contextOf(id).files.put('pbot', Buffer.from('abc'), '../evil?.txt');
  assert.ok(existsSync(f));
  assert.match(path.basename(f), /evil_\.txt$/);
  assert.ok(f.includes(path.join('.bridge', 'uploads')));
});

test('ctx.webhook：必须声明校验；本机直连认隧道头、密钥、HMAC', async () => {
  assert.throws(() => checkVerifySpec(null), /必须写 verify/);
  assert.throws(() => checkVerifySpec({}), /至少要一种/);
  const req = (headers, addr = '127.0.0.1') => ({ headers, socket: { remoteAddress: addr } });
  assert.equal(verifyRequest(req({}), { loopbackOnly: true }), null);
  assert.equal(verifyRequest(req({ 'cf-connecting-ip': '1.2.3.4' }), { loopbackOnly: true })[0], 403);
  assert.equal(verifyRequest(req({}, '10.0.0.2'), { loopbackOnly: true })[0], 403);
  assert.equal(verifyRequest(req({ authorization: 'Bearer s3cret' }), { secret: 's3cret' }), null);
  assert.equal(verifyRequest(req({ authorization: 'nope' }), { secret: 's3cret' })[0], 401);
  const crypto = await import('node:crypto');
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 'k').update(body).digest('hex');
  assert.equal(verifyRequest(req({ 'x-sig': sig }), { hmac: { secret: 'k', header: 'x-sig', prefix: 'sha256=' } }, body), null);
  assert.equal(verifyRequest(req({ 'x-sig': 'sha256=00' }), { hmac: { secret: 'k', header: 'x-sig', prefix: 'sha256=' } }, body)[0], 401);

  // 挂上去走一遍：限流、handler 收到 json()
  let got = null;
  const id = await addPlugin((ctx) => { ctx.webhook('in', (rq, rs, x) => { got = x.json(); }, { verify: { loopbackOnly: true }, perMinute: 2 }); });
  const h = routes.get('POST /hook/' + id + '/in');
  assert.ok(h, '回调路由挂上了');
  const fire = async () => {
    const r = Readable.from([Buffer.from('{"msg":"hi"}')]);
    Object.assign(r, { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    const res = { code: 0, writableEnded: false, headersSent: false, writeHead(c) { this.code = c; this.headersSent = true; }, end() { this.writableEnded = true; } };
    await h(r, res, new URL('http://x/hook'));
    return res.code;
  };
  assert.equal(await fire(), 200);
  assert.deepEqual(got, { msg: 'hi' });
  assert.equal(await fire(), 200);
  assert.equal(await fire(), 429);
  assert.equal(panelView(id).hooks[0].path, '/hook/' + id + '/in');
  await kernel.setEnabled(id, false);
  assert.equal(routes.has('POST /hook/' + id + '/in'), false, '停用后回调摘掉');
});

test('ctx.process：托管子进程跑起来、崩了按退避重启、写日志，停用时整棵收掉', async () => {
  const script = path.join(tmp, 'child.mjs');
  // 第一次启动 0.3 秒后崩（退出码 3），之后常驻；同时拉一个孙进程，验证收尸收整棵树
  writeFileSync(script, `
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const flag = process.argv[2];
console.log('child up ' + process.pid);
const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[3], String(g.pid));
if (!existsSync(flag)) { writeFileSync(flag, '1'); setTimeout(() => process.exit(3), 300); }
setInterval(() => {}, 1000);
`);
  const flag = path.join(tmp, 'crashed.flag');
  const gpid = path.join(tmp, 'grandchild.pid');
  let h;
  const id = await addPlugin((ctx) => { h = ctx.process.spawn('worker', { command: process.execPath, args: [script, flag, gpid], restart: 'on-failure' }); });
  assert.ok(await until(() => h.state === 'running'));
  assert.ok(await until(() => h.restarts === 1 && h.state === 'running', 10000), '崩了之后重启过一次');
  assert.ok(await until(() => h.tail(50).some((l) => /child up/.test(l))));
  assert.ok(h.tail(50).some((l) => /退出码 3/.test(l)));
  const st = panelView(id).processes[0];
  assert.equal(st.name, 'worker');
  assert.ok(existsSync(path.join(tmp, 'plugin-data', id, '.pids')));
  const grand = Number(readFileSync(gpid, 'utf8'));
  const childPid = h.pid;
  await kernel.setEnabled(id, false);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(await until(() => !alive(childPid)), '子进程收掉了');
  assert.ok(await until(() => !alive(grand)), '孙进程也收掉了');
  assert.equal(existsSync(path.join(tmp, 'plugin-data', id, '.pids')), false);
});

test('ctx.process：上次没收掉的残留，下次 spawn 前清理', async () => {
  const stray = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const id = 'env-' + (++n);
  mkdirSync(path.join(tmp, 'plugin-data', id), { recursive: true });
  writeFileSync(path.join(tmp, 'plugin-data', id, '.pids'), JSON.stringify({ old: { pid: stray.pid, image: path.basename(process.execPath).toLowerCase(), at: 1 } }));
  let h;
  await kernel.register({ id, name: id, source: 'local', dir: tmp, load: async () => ({ apply(ctx) { h = ctx.process.spawn('w2', { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }); } }) });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(await until(() => !alive(stray.pid)), '残留被清掉');
  assert.ok(await until(() => h.state === 'running'));
  await kernel.setEnabled(id, false);
  await killTree(stray.pid);
});

test('ctx.status / action / configOptions / store', async () => {
  let api;
  const id = await addPlugin((ctx) => {
    api = ctx;
    let count = 0;
    ctx.status(() => ({ tone: 'ok', text: '在线', items: [{ label: '回复', value: count }] }));
    ctx.action({ id: 'bump', label: '加一', handler: () => { count++; return '加好了'; } });
    ctx.configOptions('groups', async () => [{ value: '1', label: '一群' }]);
  });
  await refreshStatuses([id]);
  assert.equal(panelView(id).panelStatus.text, '在线');
  assert.deepEqual(panelView(id).actions.map((a) => a.id), ['bump']);
  assert.deepEqual(await runAction(id, 'bump', {}), { ok: true, message: '加好了' });
  await refreshStatuses([id]);
  assert.equal(panelView(id).panelStatus.items[0].value, '1');
  assert.deepEqual(await optionsFor(id, 'groups.$key', {}), [{ value: '1', label: '一群' }]);
  await assert.rejects(runAction(id, 'nope', {}), /没有这个动作/);
  api.store.set('k', { a: 1 });
  assert.deepEqual(api.store.get('k'), { a: 1 });
  await kernel.setEnabled(id, false);   // 停用时写盘
  assert.deepEqual(JSON.parse(readFileSync(path.join(tmp, 'plugin-data', id, 'store.json'), 'utf8')), { k: { a: 1 } });
  assert.deepEqual(panelView(id), {});
});
