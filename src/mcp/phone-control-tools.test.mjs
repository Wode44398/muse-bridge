// 手机操控 MCP v2：多设备选择 + 本轮锁定 + 如实回报。用假手机（直接调长轮询/回传 handler）跑工具 handler。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { buildPhoneControlTools, fmtObservation, fmtReadiness } from './phone-control-tools.mjs';
import { handleControlNext, handleControlResult, __resetForTest } from '../runtime/phone-control.mjs';

const identify = () => ({ kind: 'admin' });
function mkReq(url, body) {
  const req = new EventEmitter();
  req.url = url; req.headers = { 'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 17; SM-F9760 Build/X)' };
  if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return req;
}
function mkRes() { const r = { ended: false }; r.writeHead = (s) => { r.status = s; return r; }; r.end = (b) => { r.body = b || ''; r.ended = true; }; return r; }

// 假手机：挂长轮询，收到命令就用 reply(op,args) 的返回值回传，然后再挂下一条。
function fakePhone(devId, name, reply, log) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const res = mkRes();
      await handleControlNext(mkReq('/api/phone-control/next?wait=200&device=' + devId + '&name=' + encodeURIComponent(name)), res, { identify });
      while (!res.ended) await new Promise((r) => setTimeout(r, 5));
      if (res.status !== 200) continue;
      const cmd = JSON.parse(res.body);
      log.push(devId + ':' + cmd.op);
      let out;
      try { out = { ok: true, result: await reply(cmd.op, cmd.args) }; } catch (e) { out = { ok: false, error: e.message }; }
      await handleControlResult(mkReq('/api/phone-control/result?device=' + devId, { cmdId: cmd.cmdId, ...out }), mkRes(), { identify });
    }
  };
  loop();
  return () => { stopped = true; };
}
const byName = (tools, n) => tools.find((t) => t.name === n);
const textOf = (out) => out.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const obs = (pkg) => ({ package: pkg, screenW: 1080, screenH: 2400, elements: [{ i: 0, label: '搜索', clickable: true, bounds: [0, 0, 100, 100] }], windows: [{ i: 0, type: 1, pkg, active: true }], screenshot: 'AAAA', som: true });

test('两台在线：不指定设备的动作被拒绝；origin=发起那台时直接操作它，并在本轮锁定', async () => {
  __resetForTest();
  const log = [];
  const stopA = fakePhone('fold0001', 'Z Fold7', async (op) => (op === 'tap' ? { target: '[0]「搜索」', ...obs('com.a') } : obs('com.a')), log);
  const stopB = fakePhone('sphone02', 'Galaxy S', async () => obs('com.b'), log);
  await new Promise((r) => setTimeout(r, 30));

  const noOrigin = buildPhoneControlTools('admin', null, undefined);
  const refused = await byName(noOrigin, 'phone_tap').handler({ by: 'index', index: 0 });
  assert.match(textOf(refused), /2 台手机开着操控/);
  assert.equal(log.length, 0, '歧义时一条命令都不该发出去');

  const fromS = buildPhoneControlTools('admin', null, 'd:sphone02');
  const shot = await byName(fromS, 'phone_screen').handler({});
  assert.match(textOf(shot), /【Galaxy S】/);
  assert.ok(shot.content.some((c) => c.type === 'image' && c.data === 'AAAA'), '截图以扁平 image 块返回');
  // 显式换到 Fold：提示编号作废；之后不传 device 也锁在 Fold
  const t1 = await byName(fromS, 'phone_tap').handler({ index: 0, device: 'fold' });
  assert.match(textOf(t1), /已切换到 Z Fold7/);
  assert.match(textOf(t1), /点了 \[0\]「搜索」/);
  await byName(fromS, 'phone_screen').handler({});
  assert.deepEqual(log, ['sphone02:screen', 'fold0001:tap', 'fold0001:screen']);
  stopA(); stopB();
  await new Promise((r) => setTimeout(r, 250));
  __resetForTest();
});

test('输入如实回报：无障碍路径回读没对上 → 明说没写进去，提交没生效 → 明说', async () => {
  __resetForTest();
  const log = [];
  const stop = fakePhone('fold0001', 'Z Fold7', async () => ({ path: 'a11y', verified: false, submitted: false, submitNote: '输入框不接受回车', imeReason: 'Bridge 输入法没在系统设置里启用', ...obs('com.tencent.mm') }), log);
  await new Promise((r) => setTimeout(r, 30));
  const tools = buildPhoneControlTools('admin', null, undefined);
  const out = await byName(tools, 'phone_input').handler({ text: '文件传输助手', submit: 'search' });
  const t = textOf(out);
  assert.match(t, /经无障碍写入/);
  assert.match(t, /输入框里没有这段文字/);
  assert.match(t, /没在系统设置里启用/);
  assert.match(t, /提交没有生效/);
  stop(); await new Promise((r) => setTimeout(r, 250));
  __resetForTest();
});

test('观察格式：多窗口标 w 编号、画面没变给警告、没元素时说明只能看图', () => {
  const r = {
    package: 'com.taobao.taobao', screenW: 2256, screenH: 2504, changed: false,
    ime: { visible: true, bounds: [0, 1400, 2256, 2504] },
    windows: [{ i: 0, type: 3, pkg: 'com.samsung.android.sm_cn', title: '支付安全' }, { i: 1, type: 1, pkg: 'com.taobao.taobao', active: true }],
    elements: [{ i: 0, w: 0, label: '忽略', clickable: true, bounds: [600, 2312, 1126, 2420] }, { i: 1, w: 1, label: '搜索栏', clickable: true, bounds: [193, 238, 1918, 333] }],
  };
  const s = fmtObservation(r, '【Z Fold7】');
  assert.match(s, /键盘已弹出/);
  assert.match(s, /画面和动作前一样/);
  assert.match(s, /w0 系统 支付安全/);
  assert.match(s, /\[1\] w1 「搜索栏」 可点/);
  assert.match(fmtObservation({ package: 'com.tencent.mm', elements: [] }), /只能看截图/);
  // 旧 apk 的元素（text/desc 字段）也能排
  assert.match(fmtObservation({ package: 'x', elements: [{ i: 3, text: '发送', clickable: true, bounds: [1, 2, 3, 4] }] }), /\[3\] 「发送」 可点/);
});

test('就绪自检文案：输入法没启用、锁屏会明确指出', () => {
  const s = fmtReadiness({ a11y: true, screenshot: true, imeEnabled: false, screenOn: true, locked: true, foreground: 'com.tencent.mm', screenW: 2256, screenH: 2504 });
  assert.match(s, /✓ 无障碍/);
  assert.match(s, /✗ Bridge 输入法没在系统里启用/);
  assert.match(s, /锁屏中/);
  assert.match(fmtReadiness(null), /版本较旧/);
});
