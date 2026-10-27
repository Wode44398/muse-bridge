// 手机操控通道 v2：按设备分桶。重点回归 09-25 真机事故——同账号两台手机抢同一条长轮询（互相顶掉、每秒空转），
// 命令随机落到其中一台（读屏在 A、点按在 B）。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  modelFromUA, deviceIdFromReq, parseReady, resolveDevice, listDevices, requestPhoneControl,
  handleControlNext, handleControlResult, handleControlEvent, isControlOnline, abortAll, __resetForTest,
} from './phone-control.mjs';

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
