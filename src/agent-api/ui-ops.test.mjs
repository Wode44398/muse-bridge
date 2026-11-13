// ui.open / ui.notify 的界面回执（2026-11-08）：发 ui.cmd 前先登记回执，前端执行完 POST /api/ui/answer 回来才算确认；
// 没回执照实报「未确认」，不报假成功。另含：视图上报记下所在手机（device）与前后台（visible）、心跳不抢「最近在用」、
// 按手机（device）挑界面。总线订阅用假 res 截下发出去的事件，回执直接调 answerUiRequest（= /api/ui/answer 落地那一步）。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-ui-ops-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const { callOp, OpError } = await import('./registry.mjs');
await import('./ops/ui.mjs');
const { noteUiState, getUiState, answerUiRequest, waitUiAck } = await import('../runtime/ui-state.mjs');
const { busSubscribe } = await import('../runtime/bus.mjs');
const { registerUiStateRoutes } = await import('../routes/ui-state.mjs');

let seq = 0;
const newCtx = () => ({ kind: 'user', key: 'u:uitest' + (++seq), agents: ['claude'] });

// 假的总线连接：截下 data 帧交给 onEvent（模拟前端收到 ui.cmd）
function subscribe(key, onEvent) {
  const res = {
    writableEnded: false,
    write(chunk) { const m = /^data: (.*)\n\n$/s.exec(String(chunk)); if (m) onEvent(JSON.parse(m[1])); return true; },
    end() { this.writableEnded = true; },
  };
  return busSubscribe(key, res);
}

test('waitUiAck：回执即返回；别的身份答不进来；超时给 null；广播先记下 ok:false 接着等 ok 的', async () => {
  const a = waitUiAck('k1', 'id-1', 1000);
  assert.equal(answerUiRequest('k2', 'id-1', { ok: true }), false, '跨身份不收');
  assert.equal(answerUiRequest('k1', 'id-1', { ok: true, client: 'c1' }), true);
  assert.deepEqual(await a, { ok: true, client: 'c1' });
  assert.equal(answerUiRequest('k1', 'id-1', { ok: true }), false, '答过的 id 再来就是未知请求');

  assert.equal(await waitUiAck('k1', 'id-2', 20), null);

  const b = waitUiAck('k1', 'id-3', 1000, { needOk: true });
  assert.equal(answerUiRequest('k1', 'id-3', { ok: false, reason: 'x' }), true);
  assert.equal(answerUiRequest('k1', 'id-3', { ok: true, client: 'c2' }), true);
  assert.deepEqual(await b, { ok: true, client: 'c2' });

  const c = waitUiAck('k1', 'id-4', 20, { needOk: true });
  answerUiRequest('k1', 'id-4', { ok: false, reason: '没开' });
  assert.deepEqual(await c, { ok: false, reason: '没开' }, '到点没有 ok 的就交出最后那份 ok:false');

  // expect：会回执的那几端都回了 ok:false 就立刻交出，不干等到点
  const t0 = Date.now();
  const d = waitUiAck('k1', 'id-5', 5000, { needOk: true, expect: 2 });
  answerUiRequest('k1', 'id-5', { ok: false, reason: 'a' });
  answerUiRequest('k1', 'id-5', { ok: false, reason: 'b' });
  assert.deepEqual(await d, { ok: false, reason: 'b' });
  assert.ok(Date.now() - t0 < 1000, '没等满 5 秒');
});

test('视图上报：记下 device / visible；心跳只续 fresh，不抢「最近在用」的排序', async () => {
  const ctx = newCtx();
  noteUiState(ctx.key, 'desk', 'desktop', { page: 'home' }, { visible: true });
  await new Promise((r) => setTimeout(r, 5));
  noteUiState(ctx.key, 'phone', 'apk', { page: 'claude' }, { device: 'd:abcdef123456', visible: true });
  await new Promise((r) => setTimeout(r, 5));
  noteUiState(ctx.key, 'desk', 'desktop', { page: 'home' }, { visible: true, beat: true });
  const all = getUiState(ctx.key);
  assert.deepEqual(all.map((c) => c.clientId), ['phone', 'desk'], '心跳过的桌面端不排到刚用过的手机前面');
  assert.ok(all[1].at > all[0].at, '但心跳续上了最近联系');
  assert.equal(all[0].device, 'd:abcdef123456');
  assert.equal(all[1].device, null);
  noteUiState(ctx.key, 'old', 'web', { page: 'files' });
  assert.equal(getUiState(ctx.key).find((c) => c.clientId === 'old').visible, null, '旧版不报 visible = null');

  const v = await callOp(ctx, 'ui.view', {});
  const phone = v.clients.find((c) => c.client === 'phone');
  assert.equal(phone.device, 'abcdef', '句柄同手机操控 phone_devices');
  assert.ok(phone.deviceLabel);
  assert.equal(phone.visible, true);
  assert.equal(v.clients.find((c) => c.client === 'desk').device, undefined);
});

test('POST /api/ui/state：新 apk 的 UA 带 BridgeDevice → 记成那台手机；网页不记；visible / beat 照收', async () => {
  const handlers = {};
  registerUiStateRoutes({ on: (m, p, h) => { handlers[m + ' ' + p] = h; } }, { identify: () => ({ kind: 'admin' }) });
  const post = async (body, ua) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.headers = { 'content-type': 'application/json', 'user-agent': ua };
    req.method = 'POST'; req.url = '/api/ui/state'; req.socket = { remoteAddress: '127.0.0.1' };
    let code = 0;
    const res = { writeHead: (c) => { code = c; }, end: () => {} };
    await handlers['POST /api/ui/state'](req, res);
    return code;
  };
  const apkUA = 'Mozilla/5.0 (Linux; Android 16; SM-S9370 Build/BP2A; wv) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36 BridgeDevice/zz99a01b2c3d';
  assert.equal(await post({ clientId: 'apk-1', client: 'apk', state: { page: 'home' }, visible: false, beat: true }, apkUA), 200);
  assert.equal(await post({ clientId: 'web-1', client: 'web', state: { page: 'files' }, visible: true }, 'Mozilla/5.0 (Linux; Android 16; SM-S9370 Build/BP2A) Chrome/141 Mobile Safari/537.36'), 200);
  const all = getUiState('admin');
  const apk = all.find((c) => c.clientId === 'apk-1');
  const web = all.find((c) => c.clientId === 'web-1');
  assert.equal(apk.device, 'd:zz99a01b2c3d');
  assert.equal(apk.visible, false);
  assert.equal(web.device, null, '手机浏览器开的网页带机型也不算那台手机');
  assert.equal(web.visible, true);
});

test('ui.open：没有总线连接 → delivered:false；有回执 → confirmed / opened；回执 ok:false 带原因；后台打开要提醒', async () => {
  const ctx = newCtx();
  noteUiState(ctx.key, 'c1', 'web', { page: 'home' }, { visible: true });
  const none = await callOp(ctx, 'ui.open', { file: 'notes/a.md' });
  assert.equal(none.delivered, false);
  assert.equal(none.confirmed, undefined);

  let reply = { ok: true, visible: true };
  const got = [];
  const off = subscribe(ctx.key, (ev) => { got.push(ev); answerUiRequest(ctx.key, ev.id, { ...reply, client: ev.client || 'c1' }); });
  try {
    const r = await callOp(ctx, 'ui.open', { file: 'notes\\a.md' });
    assert.equal(got.at(-1).type, 'ui.cmd');
    assert.equal(got.at(-1).client, 'c1', '默认发给最近在用的那个界面');
    assert.deepEqual(got.at(-1).target, { file: 'notes/a.md' });
    assert.equal(r.delivered, true);
    assert.equal(r.confirmed, true);
    assert.equal(r.opened, true);
    assert.equal(r.client, 'c1');
    assert.equal(r.visible, true);
    assert.equal(r.note, undefined);

    reply = { ok: false, reason: '这个分页对用户没开', visible: true };
    const no = await callOp(ctx, 'ui.open', { page: 'claude' });
    assert.equal(no.confirmed, true);
    assert.equal(no.opened, false);
    assert.equal(no.reason, '这个分页对用户没开');

    reply = { ok: true, visible: false };
    const bg = await callOp(ctx, 'ui.open', { page: 'home' });
    assert.equal(bg.opened, true);
    assert.equal(bg.visible, false);
    assert.match(bg.note, /后台/);

    reply = { ok: true, visible: true };
    const t = await callOp(ctx, 'ui.notify', { text: '做完了' });
    assert.equal(t.confirmed, true);
    assert.equal(t.shown, true);
    assert.equal(got.at(-1).op, 'toast');
  } finally { off(); }
});

test('ui.open：发出去了但没回执（后台 / 旧版 App）→ delivered:false、confirmed:false、照实说；点名的界面陈旧 → stale', async () => {
  const ctx = newCtx();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() - 600_000 });
  try {
    noteUiState(ctx.key, 'old-apk', 'apk', { page: 'home' });
    mock.timers.setTime(Date.now() + 300_000);   // 5 分钟没联系：fresh=false，但还没到十倍陈旧
    const got = [];
    const off = subscribe(ctx.key, (ev) => got.push(ev));   // 旧版：收得到、不回执
    try {
      const p = callOp(ctx, 'ui.open', { session: 's-1', client: 'old-apk' });
      await Promise.resolve();
      mock.timers.tick(6000);
      const r = await p;
      assert.equal(got.length, 1);
      assert.equal(r.delivered, false);
      assert.equal(r.sent, true);
      assert.equal(r.confirmed, false);
      assert.equal(r.stale, true);
      assert.equal(r.opened, undefined);
      assert.match(r.note, /别跟用户说已经打开/);
    } finally { off(); }
  } finally { mock.timers.reset(); }
});

test('按手机挑界面：device 认句柄 / 设备 id 前缀 / 机型；对不上给 phone_open_app 的提示；client 与 device 不能同给', async () => {
  const ctx = newCtx();
  noteUiState(ctx.key, 'desk', 'desktop', { page: 'home' }, { visible: true });
  noteUiState(ctx.key, 'p-old', 'apk', { page: 'home' }, { device: 'd:abcdef123456', visible: false });
  noteUiState(ctx.key, 'p-new', 'apk', { page: 'home' }, { device: 'd:abcdef123456', visible: true });
  noteUiState(ctx.key, 'p2', 'apk', { page: 'home' }, { device: 'm:SM-S9370', visible: true });
  const got = [];
  const off = subscribe(ctx.key, (ev) => { got.push(ev); answerUiRequest(ctx.key, ev.id, { ok: true, client: ev.client, visible: true }); });
  try {
    const r = await callOp(ctx, 'ui.open', { file: 'a.md', device: 'abcdef' });
    assert.equal(got.at(-1).client, 'p-new', '同一台手机上挑在前台的那个界面');
    assert.equal(r.device, 'abcdef');
    assert.equal(r.opened, true);
    await callOp(ctx, 'ui.open', { file: 'a.md', device: 'abcdef1234' });
    assert.equal(got.at(-1).client, 'p-new', '设备 id 前缀也认');
    await callOp(ctx, 'ui.notify', { text: 'hi', device: 's9370' });
    assert.equal(got.at(-1).client, 'p2', '机型子串也认');
    const n = got.length;
    const miss = await callOp(ctx, 'ui.open', { file: 'a.md', device: 'nope99' });
    assert.equal(miss.delivered, false);
    assert.match(miss.note, /phone_open_app/);
    assert.equal(got.length, n, '对不上不发');
    await assert.rejects(callOp(ctx, 'ui.open', { file: 'a.md', device: 'abcdef', client: 'desk' }), (e) => e instanceof OpError && e.code === 'bad_args');
  } finally { off(); }
});

test('广播（client=all）：后台那端先回 ok:false 不算数，等到前台那端 ok 的回执', async () => {
  const ctx = newCtx();
  noteUiState(ctx.key, 'a', 'web', { page: 'home' }, { visible: true });
  noteUiState(ctx.key, 'b', 'web', { page: 'home' }, { visible: true });
  const off = subscribe(ctx.key, (ev) => {
    assert.equal(ev.client, undefined, '广播不点名');
    answerUiRequest(ctx.key, ev.id, { ok: false, client: 'a', reason: '这个分页对用户没开' });
    setTimeout(() => answerUiRequest(ctx.key, ev.id, { ok: true, client: 'b', visible: true }), 10);
  });
  try {
    const r = await callOp(ctx, 'ui.open', { page: 'files', client: 'all' });
    assert.equal(r.confirmed, true);
    assert.equal(r.opened, true);
    assert.equal(r.client, 'b');
  } finally { off(); }
});
