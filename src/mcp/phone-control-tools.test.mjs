// 手机操控 MCP v2：多设备选择 + 本轮锁定 + 如实回报。用假手机（直接调长轮询/回传 handler）跑工具 handler。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { buildPhoneControlTools, fmtObservation, fmtReadiness, fmtDeviceInfo } from './phone-control-tools.mjs';
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

test('电量 / 存储 / 网络：新 apk 回包显示一行，旧 apk 缺字段就不显示', () => {
  const s = fmtReadiness({ a11y: true, screenshot: true, screenOn: true,
    battery: { level: 83, charging: true, plugged: 'usb', saver: false, tempC: 31 },
    storage: { totalBytes: 256e9, freeBytes: 112.4e9 },
    network: { type: 'wifi', metered: true, validated: true } });
  assert.match(s, /电量 83%（充电中·USB）/);
  assert.match(s, /存储 剩余 112\/256 GB/);
  assert.match(s, /网络 Wi-Fi（按流量计费）/);
  assert.equal(fmtDeviceInfo({ a11y: true }), '');
  assert.doesNotMatch(fmtReadiness({ a11y: true, screenshot: true }), /电量|存储|网络/);
  assert.match(fmtDeviceInfo({ battery: { level: 100, full: true, tempC: 45 }, network: { type: 'none' } }), /电量 100%（已充满）（电池 45°C 偏热） · 网络 没联网/);
  assert.match(fmtDeviceInfo({ network: { type: 'cellular', validated: false } }), /移动数据（连上了但上不了网）/);
  assert.match(fmtDeviceInfo({ network: { type: 'wifi', vpn: true } }), /网络 Wi-Fi（经 VPN）$/);
  assert.match(fmtDeviceInfo({ network: { type: 'vpn', vpn: true } }), /网络 VPN$/);
});

test('画面没变的措辞：带截图时提醒网页/画布不在清单里；像素变了要说清', () => {
  assert.match(fmtObservation({ package: 'com.android.chrome', changed: false, screenshot: 'AAAA', elements: [] }), /元素清单和动作前一样，可能没生效（网页、画布、视频的内容不在清单里，以截图为准）/);
  assert.match(fmtObservation({ package: 'com.android.chrome', changed: true, changedBy: 'pixels', screenshot: 'AAAA', elements: [] }), /元素清单没变，但截图内容变了/);
});

test('打开类动作：旧 apk 回包还停在原前台 → 补看到新前台为止；新 apk 自己等前台就不再先查', async () => {
  __resetForTest();
  const log = [];
  let screens = 0;
  const stop = fakePhone('open0001', 'Z Fold7', async (op) => {
    if (op === 'status') return { a11y: true, foreground: 'com.bridge' };
    if (op === 'open_url') return obs('com.bridge');
    if (op === 'screen') return obs(++screens >= 2 ? 'com.android.chrome' : 'com.bridge');
    return {};
  }, log);
  await new Promise((r) => setTimeout(r, 30));
  const tools = buildPhoneControlTools('admin', null, undefined, 'sess-open');
  const out = await byName(tools, 'phone_open_url').handler({ url: 'https://example.com' });
  const t = textOf(out);
  assert.deepEqual(log, ['open0001:status', 'open0001:open_url', 'open0001:screen', 'open0001:screen']);
  assert.match(t, /已打开 https:\/\/example\.com/);
  assert.match(t, /com\.android\.chrome/);
  assert.doesNotMatch(t, /尚未到前台/);
  stop(); await new Promise((r) => setTimeout(r, 250));

  // 一直没换前台 → 补看 4 次后如实说明
  __resetForTest(); log.length = 0;
  const stop2 = fakePhone('open0002', 'Z Fold7', async (op) => (op === 'status' ? { foreground: 'com.bridge' } : obs('com.bridge')), log);
  await new Promise((r) => setTimeout(r, 30));
  const t2 = textOf(await byName(buildPhoneControlTools('admin', null, undefined, 'sess-open'), 'phone_open_settings').handler({ page: 'battery' }));
  assert.equal(log.filter((x) => x.endsWith(':screen')).length, 4);
  assert.match(t2, /⚠ 目标页面尚未到前台（前台还是 com\.bridge/);
  assert.match(t2, /以截图为准/);
  stop2(); await new Promise((r) => setTimeout(r, 250));

  // 新 apk：回包带 foreground，第二次起不再先查 status、也不补看
  __resetForTest(); log.length = 0;
  const stop3 = fakePhone('open0003', 'Z Fold7', async (op) => (op === 'status' ? { foreground: 'com.bridge' } : { foreground: op !== 'share', waitMs: 6000, ...obs(op === 'share' ? 'com.bridge' : 'com.android.chrome') }), log);
  await new Promise((r) => setTimeout(r, 30));
  const tools3 = buildPhoneControlTools('admin', null, undefined, 'sess-open');
  await byName(tools3, 'phone_open_url').handler({ url: 'https://a.com' });
  const t3 = textOf(await byName(tools3, 'phone_share').handler({ text: 'hi', target: '微信' }));
  assert.deepEqual(log, ['open0003:status', 'open0003:open_url', 'open0003:share']);
  assert.match(t3, /⚠ 等了 6 秒前台还是 com\.bridge/);
  stop3(); await new Promise((r) => setTimeout(r, 250));
  __resetForTest();
});

test('两个会话抢同一台：后来的被拦并说出对方是谁，phone_devices 标出占用', async () => {
  __resetForTest();
  const log = [];
  const stop = fakePhone('lease001', 'Z Fold7', async (op) => (op === 'status' ? { a11y: true } : obs('com.a')), log);
  await new Promise((r) => setTimeout(r, 30));
  const a = buildPhoneControlTools('admin', null, undefined, () => 'sessAAAA1111');
  const b = buildPhoneControlTools('admin', null, undefined, () => 'sessBBBB2222');
  const ta = await byName(a, 'phone_swipe').handler({ x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.3 });
  assert.doesNotMatch(textOf(ta), /另一个会话/);
  const tb = await byName(b, 'phone_tap').handler({ by: 'coord', x: 0.5, y: 0.5 });
  assert.match(textOf(tb), /正被另一个会话〈sessAAAA〉操控/);
  const dv = textOf(await byName(b, 'phone_devices').handler({}));
  assert.match(dv, /⚠ 正被另一个会话〈sessAAAA〉操控/);
  const dvA = textOf(await byName(a, 'phone_devices').handler({}));
  assert.doesNotMatch(dvA, /另一个会话/);
  assert.equal(log.filter((x) => x.endsWith(':tap')).length, 0, '被拦的点按不该发到手机');
  stop(); await new Promise((r) => setTimeout(r, 250));
  __resetForTest();
});
