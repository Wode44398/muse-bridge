// 手机操控通道 v2：按设备分桶。重点回归 09-25 真机事故——同账号两台手机抢同一条长轮询（互相顶掉、每秒空转），
// 命令随机落到其中一台（读屏在 A、点按在 B）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 长轮询会把手机记进手机名册（client-origins.mjs，落在 DATA_ROOT）——测试用临时目录，别写进程序根
process.env.BRIDGE_DATA_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bridge-phonectl-'));
const {
  modelFromUA, deviceIdFromReq, parseReady, resolveDevice, listDevices, requestPhoneControl,
  handleControlNext, handleControlResult, handleControlEvent, isControlOnline, abortAll, __resetForTest,
  releaseLease, __ageForTest,
} = await import('./phone-control.mjs');

const FOLD_DALVIK = 'Dalvik/2.1.0 (Linux; U; Android 17; SM-F9760 Build/CP1A.260805.001)';
const S_DALVIK = 'Dalvik/2.1.0 (Linux; U; Android 16; SM-S9370 Build/BP2A.250605.031)';
const S_WEBVIEW = 'Mozilla/5.0 (Linux; Android 16; SM-S9370 Build/BP2A.250605.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36';
const identify = () => ({ kind: 'admin' });

function mkReq(url, ua, headers = {}, body) {
  const req = new EventEmitter();
  req.url = url; req.method = body ? 'POST' : 'GET';
  req.headers = { 'user-agent': ua, ...headers };
  if (body !== undefined) {
    // readBody 按 data/end 事件读；下一拍推送
    setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  }
  return req;
}
function mkRes() {
  const res = { status: null, body: '', ended: false };
  res.writeHead = (s) => { res.status = s; return res; };
  res.end = (b) => { res.body = b || ''; res.ended = true; };
  return res;
}
const tick = () => new Promise((r) => setImmediate(r));

test('UA 抠机型：Dalvik / WebView 都能拿到，Chrome 精简 UA 的 K 不算', () => {
  assert.equal(modelFromUA(FOLD_DALVIK), 'SM-F9760');
  assert.equal(modelFromUA(S_WEBVIEW), 'SM-S9370');
  assert.equal(modelFromUA('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36'), '');
  assert.equal(modelFromUA(undefined), '');
});

test('设备身份优先级：?device > X-Bridge-Device > UA 里的 BridgeDevice/ > 机型号 > legacy', () => {
  assert.equal(deviceIdFromReq(mkReq('/api/phone-control/next?device=abc123XYZ', FOLD_DALVIK)), 'd:abc123XYZ');
  assert.equal(deviceIdFromReq(mkReq('/api/chat', FOLD_DALVIK, { 'x-bridge-device': 'hdr999aaa' })), 'd:hdr999aaa');
  assert.equal(deviceIdFromReq(mkReq('/api/chat', S_WEBVIEW + ' BridgeDevice/uaTok123')), 'd:uaTok123');
  assert.equal(deviceIdFromReq(mkReq('/api/chat', S_WEBVIEW)), 'm:SM-S9370');
  assert.equal(deviceIdFromReq(mkReq('/api/chat', 'curl/8')), 'legacy');
  // 非法 id（太短/带怪字符）不采信，退回机型号
  assert.equal(deviceIdFromReq(mkReq('/api/phone-control/next?device=a/b', FOLD_DALVIK)), 'm:SM-F9760');
});

test('就绪位解析', () => {
  assert.deepEqual(parseReady('a1s1i0d0w1l0o1'), { a11y: true, screenshot: true, imeEnabled: false, imeDefault: false, screenOn: true, locked: false, overlay: true });
  assert.equal(parseReady(''), null);
});

test('两台旧 apk 各挂各的长轮询，不再互相顶掉；命令只进指定那台', async () => {
  __resetForTest();
  const resA = mkRes(), resB = mkRes();
  await handleControlNext(mkReq('/api/phone-control/next?wait=25000', FOLD_DALVIK), resA, { identify });
  await handleControlNext(mkReq('/api/phone-control/next?wait=25000', S_DALVIK), resB, { identify });
  assert.equal(resA.ended, false, 'Fold 的长轮询不该被 S 顶掉');
  assert.equal(resB.ended, false);
  assert.equal(listDevices('admin').length, 2);

  const p = requestPhoneControl({ genKey: 'admin', deviceId: 'm:SM-S9370', op: 'screen', args: {}, timeoutMs: 2000 });
  await tick();
  assert.equal(resA.ended, false, '命令不能落到 Fold 上');
  assert.equal(resB.status, 200);
  const cmd = JSON.parse(resB.body);
  assert.equal(cmd.op, 'screen');

  // S 回传结果
  const rr = mkRes();
  await handleControlResult(mkReq('/api/phone-control/result', S_DALVIK, {}, { cmdId: cmd.cmdId, ok: true, result: { package: 'x' } }), rr, { identify });
  assert.equal(rr.status, 200);
  assert.deepEqual(await p, { package: 'x' });
  __resetForTest();
});

test('同一台设备重连时才顶掉自己上一个长轮询', async () => {
  __resetForTest();
  const r1 = mkRes(), r2 = mkRes();
  await handleControlNext(mkReq('/api/phone-control/next?device=fold0001', FOLD_DALVIK), r1, { identify });
  await handleControlNext(mkReq('/api/phone-control/next?device=fold0001', FOLD_DALVIK), r2, { identify });
  assert.equal(r1.status, 204);
  assert.equal(r2.ended, false);
  __resetForTest();
});

test('选设备：唯一在线 → 它；两台在线 → 报错列出两台；origin / sticky / want 依次生效', async () => {
  __resetForTest();
  await handleControlNext(mkReq('/api/phone-control/next?device=fold0001&name=' + encodeURIComponent('Z Fold7') + '&model=SM-F9760', FOLD_DALVIK), mkRes(), { identify });
  assert.equal(resolveDevice('admin', {}).device.id, 'd:fold0001');

  await handleControlNext(mkReq('/api/phone-control/next?device=sphone02&name=' + encodeURIComponent('Galaxy S') + '&model=SM-S9370', S_DALVIK), mkRes(), { identify });
  const amb = resolveDevice('admin', {});
  assert.ok(amb.error && /2 台/.test(amb.error) && /Z Fold7/.test(amb.error) && /Galaxy S/.test(amb.error), amb.error);

  assert.equal(resolveDevice('admin', { origin: 'd:sphone02' }).device.id, 'd:sphone02');
  assert.equal(resolveDevice('admin', { origin: 'd:sphone02', sticky: 'd:fold0001' }).device.id, 'd:fold0001', 'sticky 优先于 origin');
  assert.equal(resolveDevice('admin', { want: 'fold', sticky: 'd:sphone02' }).device.id, 'd:fold0001', 'want 最优先（按名字子串）');
  assert.equal(resolveDevice('admin', { want: 'sphone' }).device.id, 'd:sphone02', 'want 按句柄前缀');
  assert.ok(resolveDevice('admin', { want: 'pixel' }).error);
  // origin 离线（不在列表）时不采信，退回歧义报错
  assert.ok(resolveDevice('admin', { origin: 'd:ghost999' }).error);
  // 未指定设备的 requestPhoneControl 在歧义时直接拒绝，不会随便挑一台
  await assert.rejects(requestPhoneControl({ genKey: 'admin', op: 'tap', args: {}, timeoutMs: 500 }), /2 台/);
  __resetForTest();
});

test('急停只停发起急停的那台，另一台的在途命令不受牵连', async () => {
  __resetForTest();
  const resA = mkRes(), resB = mkRes();
  await handleControlNext(mkReq('/api/phone-control/next?device=fold0001', FOLD_DALVIK), resA, { identify });
  await handleControlNext(mkReq('/api/phone-control/next?device=sphone02', S_DALVIK), resB, { identify });
  const pA = requestPhoneControl({ genKey: 'admin', deviceId: 'd:fold0001', op: 'screen', timeoutMs: 3000 });
  const pB = requestPhoneControl({ genKey: 'admin', deviceId: 'd:sphone02', op: 'screen', timeoutMs: 300 });
  await tick();
  await handleControlEvent(mkReq('/api/phone-control/event?device=fold0001', FOLD_DALVIK, {}, { type: 'estop' }), mkRes(), { identify });
  await assert.rejects(pA, /急停/);
  assert.equal(isControlOnline('admin', 'd:fold0001'), false, '急停后那台立即算离线');
  await assert.rejects(pB, /超时/, 'S 的命令没被急停误杀，只是没人回传而超时');
  abortAll('admin');
  __resetForTest();
});

// —— 11-08：同一台手机被几个会话同时驱动（计算器上算出 122、31 的事故）——
// 假手机：挂长轮询，收到命令按 reply(op,args) 回传，再挂下一条。
function fakePhone(devId, ua, reply, log = []) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      const res = mkRes();
      await handleControlNext(mkReq('/api/phone-control/next?wait=200&device=' + devId, ua), res, { identify });
      while (!res.ended) await new Promise((r) => setTimeout(r, 5));
      if (res.status !== 200) continue;
      const cmd = JSON.parse(res.body);
      log.push(cmd.op + (cmd.args && cmd.args.by ? ':' + cmd.args.by : ''));
      await handleControlResult(mkReq('/api/phone-control/result?device=' + devId, ua, {}, { cmdId: cmd.cmdId, ok: true, result: reply(cmd.op, cmd.args) }), mkRes(), { identify });
    }
  })();
  return async () => { stopped = true; await new Promise((r) => setTimeout(r, 250)); };
}
const obsReply = (op) => (op === 'screen' || op === 'tap' ? { package: 'com.calc', sig: 'S' + Math.random(), elements: [] } : { ok: 1 });
const send = (owner, op, args = {}, ownerLabel) => requestPhoneControl({ genKey: 'admin', deviceId: 'd:fold0001', op, args, timeoutMs: 2000, owner, ownerLabel });

test('设备租约：别的会话在用时动作被拒（报出对方），只读放行；90 秒没动静过期、轮次结束释放、急停清掉', async () => {
  __resetForTest();
  const stop = fakePhone('fold0001', FOLD_DALVIK, obsReply);
  await tick(); await tick();
  await send('sessA', 'tap', { by: 'coord', x: 0.5, y: 0.5, observe: 'none' }, '「算一下 12+3」（sessA）');
  await assert.rejects(send('sessB', 'tap', { by: 'coord', x: 0.1, y: 0.1, observe: 'none' }), /正被另一个会话〈「算一下 12\+3」（sessA）〉操控（\d+ 秒前有动作）.*等它做完、换一台，或问用户/);
  await assert.rejects(send('sessB', 'open_app', { app: '设置' }), /正被另一个会话/);
  // 只读：看画面、查状态不抢租约
  assert.ok(await send('sessB', 'screen'));
  assert.ok(await send('sessB', 'status'));
  assert.equal(listDevices('admin')[0].lease.owner, 'sessA', 'phone_devices 能看到谁占着');
  // 同一会话（主线程与子 agent 共用 owner）照常
  assert.ok(await send('sessA', 'key', { key: 'back', observe: 'none' }));
  // 不带 owner 的旧调用方不受影响
  assert.ok(await send(undefined, 'key', { key: 'back', observe: 'none' }));
  // 过期放行
  __ageForTest('admin', 91_000);
  assert.ok(await send('sessB', 'tap', { by: 'coord', x: 0.1, y: 0.1, observe: 'none' }));
  await assert.rejects(send('sessA', 'tap', { by: 'coord', x: 0.5, y: 0.5, observe: 'none' }), /正被另一个会话/, '租约换到 B 手里了');
  // 轮次结束释放
  assert.equal(releaseLease('sessB', 'admin'), 1);
  assert.equal(listDevices('admin')[0].lease, null);
  assert.ok(await send('sessA', 'tap', { by: 'coord', x: 0.5, y: 0.5, observe: 'none' }));
  // 急停清租约
  assert.equal(listDevices('admin')[0].lease.owner, 'sessA');
  await handleControlEvent(mkReq('/api/phone-control/event?device=fold0001', FOLD_DALVIK, {}, { type: 'estop' }), mkRes(), { identify });
  assert.equal(listDevices('admin', { includeOffline: true })[0].lease, null);
  await stop();
  __resetForTest();
});

test('编号归属：编号表被别的会话的读屏刷新后，按编号点被拒；坐标点不受影响；自己再读屏就恢复', async () => {
  __resetForTest();
  const log = [];
  const stop = fakePhone('fold0001', FOLD_DALVIK, obsReply, log);
  await tick(); await tick();
  await send('sessA', 'screen');
  assert.ok(await send('sessA', 'tap', { by: 'index', index: 20, observe: 'none' }), '自己读的编号照常点');
  await send('sessB', 'screen');                       // B 读屏：手机端编号表重编号
  await assert.rejects(send('sessA', 'tap', { by: 'index', index: 20, observe: 'none' }), /编号已被其他会话的读屏刷新.*phone_screen/);
  await assert.rejects(send('sessA', 'input', { by: 'index', index: 3, text: 'x' }), /编号已被其他会话/);
  await assert.rejects(send('sessA', 'scroll', { direction: 'down', index: 2 }), /编号已被其他会话/);
  assert.ok(await send('sessA', 'scroll', { direction: 'down', observe: 'none' }), '不带编号的滚动不受影响');
  assert.ok(await send('sessA', 'tap', { by: 'coord', x: 0.5, y: 0.5, observe: 'none' }), '坐标点不看编号');
  await send('sessA', 'screen');
  assert.ok(await send('sessA', 'tap', { by: 'index', index: 20, observe: 'none' }));
  assert.equal(log.filter((x) => x === 'tap:index').length, 2, '被拒的按编号点一条都没发到手机');
  await stop();
  __resetForTest();
});

test('编号归属：别的会话的读屏还排在前面时，按编号点也被拒（手机按到达顺序执行，会先重编号）', async () => {
  __resetForTest();
  await handleControlNext(mkReq('/api/phone-control/next?device=fold0001', FOLD_DALVIK), mkRes(), { identify });
  const pB = send('sessB', 'screen');                  // 已发给手机、还没回传
  pB.catch(() => {});
  await tick();
  await assert.rejects(send('sessA', 'tap', { by: 'index', index: 4, observe: 'none' }), /对方的读屏正排在你前面/);
  abortAll('admin');
  __resetForTest();
});

test('跨轮记住会话上次用的设备：接口代发（无发起设备）、两台在线时沿用；别的会话仍要指定；过期只提示不替选', async () => {
  __resetForTest();
  await handleControlNext(mkReq('/api/phone-control/next?device=fold0001&name=Fold', FOLD_DALVIK), mkRes(), { identify });
  await handleControlNext(mkReq('/api/phone-control/next?device=sphone02&name=Galaxy', S_DALVIK), mkRes(), { identify });
  // 查状态不算「用过」
  requestPhoneControl({ genKey: 'admin', deviceId: 'd:fold0001', op: 'status', owner: 'sessC', timeoutMs: 300 }).catch(() => {});
  assert.ok(resolveDevice('admin', { owner: 'sessC' }).error);
  requestPhoneControl({ genKey: 'admin', deviceId: 'd:sphone02', op: 'screen', owner: 'sessC', timeoutMs: 300 }).catch(() => {});
  const r = resolveDevice('admin', { owner: 'sessC' });
  assert.equal(r.device && r.device.id, 'd:sphone02');
  assert.equal(r.via, 'last');
  assert.equal(resolveDevice('admin', { owner: 'sessC', origin: 'd:fold0001' }).device.id, 'd:fold0001', '发起设备优先');
  assert.match(resolveDevice('admin', { owner: 'sessD' }).error, /2 台/, '别的会话不沿用');
  __ageForTest('admin', 61 * 60_000);
  const old = resolveDevice('admin', { owner: 'sessC' });
  assert.ok(old.error && /本会话上次操作的是「sphone」Galaxy/.test(old.error), old.error);
  abortAll('admin');
  __resetForTest();
});

test('同一会话跨轮不被自己锁住：轮次结束放租约后，下一轮（同 sessionId）照常动作、上轮读的编号仍算自己的', async () => {
  __resetForTest();
  const stop = fakePhone('fold0001', FOLD_DALVIK, obsReply);
  await tick(); await tick();
  await send('sessA', 'screen');
  await send('sessA', 'tap', { by: 'coord', x: 0.5, y: 0.5, observe: 'none' });
  releaseLease('sessA', 'admin');                       // 第一轮收尾
  // 第二轮（续跑 / resume 同一 sessionId）：不必重新读屏，租约重新拿到
  assert.ok(await send('sessA', 'tap', { by: 'index', index: 4, observe: 'none' }));
  assert.equal(listDevices('admin')[0].lease.owner, 'sessA');
  // 没释放（进程崩在中途）也只锁 90 秒，且锁不住自己
  assert.ok(await send('sessA', 'key', { key: 'back', observe: 'none' }));
  await stop();
  __resetForTest();
});
