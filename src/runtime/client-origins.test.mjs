// 发送端识别 / 手机名册 / 按会话逐条记录，以及 devices 工具把它们拼成的清单。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-origins-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');

const O = await import('./client-origins.mjs');
const { makeDeviceMcp } = await import('../mcp/device-tools.mjs');

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';

test('describeOrigin：桌面客户端 / 手机 App / 胶囊 / 浏览器 / 会话间 / agent 接口', () => {
  assert.deepEqual(O.describeOrigin({ computer: { id: 'd-abc123', name: 'MOONLIGHT' } }), { kind: 'desktop', id: 'd-abc123', name: 'MOONLIGHT' });
  assert.deepEqual(O.describeOrigin({ fromPhone: true, phoneId: 'd:0123456789abcdef', phoneModel: 'SM-F9760' }), { kind: 'phone', id: 'd:0123456789abcdef', name: 'SM-F9760' });
  assert.equal(O.describeOrigin({ fromPhone: true, phoneId: 'legacy', capsule: true }).detail, '悬浮胶囊');
  assert.equal(O.describeOrigin({ fromPhone: true, phoneId: 'legacy' }).id, undefined);
  assert.deepEqual(O.describeOrigin({ headers: { 'user-agent': WIN_UA } }), { kind: 'web', detail: 'Edge · Windows' });
  assert.equal(O.describeOrigin({ headers: { 'user-agent': WIN_UA }, narrow: true }).detail, '窄屏 Edge · Windows');
  assert.equal(O.describeOrigin({ headers: { 'user-agent': 'bridge-agent-api' } }).kind, 'internal');
  // 会话派生优先于请求头（派生请求重放的是点卡那个人的头）
  const fam = O.describeOrigin({ family: { origin: { kind: 'spawn', from: ['x'] } }, computer: { id: 'd-abc123', name: 'A' } });
  assert.equal(fam.kind, 'session');
  assert.match(fam.detail, /父会话/);
});

test('手机名册：按身份分开、名字以手机操控上报的为准、空值不覆盖、落盘', () => {
  O.notePhoneClient('admin', 'd:0123456789abcdef', { model: 'SM-F9760', android: '17' });
  O.notePhoneClient('admin', 'd:0123456789abcdef', { name: '维护者的 Fold', model: '', appCode: 511 });
  O.notePhoneClient('u:x', 'd:ffffffffffffffff', { model: 'Pixel 9' });
  O.notePhoneClient('admin', 'legacy', { model: 'nope' });
  const mine = O.phoneClients('admin');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].name, '维护者的 Fold');
  assert.equal(mine[0].model, 'SM-F9760');
  assert.equal(mine[0].appCode, 511);
  assert.equal(O.phoneClients('u:x')[0].model, 'Pixel 9');
  assert.equal(O.phoneHandle('d:0123456789abcdef'), '012345');
  const disk = JSON.parse(readFileSync(path.join(tmp, 'phone-clients.json'), 'utf8'));
  assert.equal(disk.owners.admin['d:0123456789abcdef'].name, '维护者的 Fold');
});

test('按会话逐条记发送端：只留开头一段文字、按会话分开、取最近 N 条', () => {
  const dataDir = path.join(tmp, 'admin-data');
  mkdirSync(dataDir, { recursive: true });
  const ctx = { key: 'admin', dataDir };
  O.recordMessageOrigin(ctx, 's1', { kind: 'desktop', id: 'd-abc123', name: 'A' }, '看看我屏幕上\n这个报错'.repeat(10));
  O.recordMessageOrigin(ctx, 's1', { kind: 'phone', id: 'd:0123456789abcdef', name: 'SM-F9760' }, '手机上接着聊');
  O.recordMessageOrigin(ctx, 's2', { kind: 'web', detail: 'Chrome' }, '别的会话');
  const rows = O.messageOrigins(ctx, 's1', 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'desktop');
  assert.ok(rows[0].text.length <= 60 && !rows[0].text.includes('\n'));
  assert.equal(O.messageOrigins(ctx, 's1', 1)[0].kind, 'phone');
  assert.equal(O.messageOrigins(ctx, 'nope').length, 0);
});

test('devices 工具：列出电脑与手机，标出「这条消息发自」，history 回看逐条发送端', async () => {
  const dataDir = path.join(tmp, 'admin-data');
  const ctx = { key: 'admin', kind: 'admin', dataDir };
  let origin = { kind: 'phone', id: 'd:0123456789abcdef', name: 'SM-F9760' };
  const server = makeDeviceMcp({ ctx, getLink: () => '', getSession: () => 's1', getOrigin: () => origin });
  const devicesTool = server.instance._registeredTools.devices;
  assert.ok(devicesTool, '拿得到 devices 工具');
  const call = async (args) => (await devicesTool.handler(args, {})).content[0].text;

  let out = await call({});
  assert.match(out, /这条消息发自：安卓 App「维护者的 Fold」\[012345\]/);
  assert.match(out, /维护者的 Fold.*SM-F9760.*安卓 17.*App 511.*← 这条消息发自这台/);
  assert.match(out, /还没有登记任何电脑/);

  origin = { kind: 'web', detail: 'Edge · Windows' };   // 现取：同一个工具实例，换一条消息就换发送端
  out = await call({ history: 5 });
  assert.match(out, /这条消息发自：浏览器网页（没经客户端）：Edge · Windows/);
  assert.doesNotMatch(out, /← 这条消息发自这台/);
  assert.match(out, /最近 2 条用户消息的发送端/);
  assert.match(out, /Windows 桌面客户端「A」\[d-abc123\]/);
  assert.match(out, /「手机上接着聊」/);
});

test('路由层 chatOrigin：桌面客户端只认自己的设备、手机按 UA 认台并记进名册', async () => {
  const registry = await import('./device-registry.mjs');
  const { chatOrigin } = await import('../routes/chat.mjs');
  const mine = registry.registerDevice({ owner: 'admin', name: 'MOONLIGHT', platform: 'win32', machineId: 'm-1' }).device;
  const theirs = registry.registerDevice({ owner: 'u:other', name: 'OTHER', platform: 'win32', machineId: 'm-2' }).device;
  const ctx = { key: 'admin', kind: 'admin', dataDir: path.join(tmp, 'admin-data') };

  assert.deepEqual(chatOrigin(ctx, { headers: { 'user-agent': WIN_UA }, body: { client: 'web', fromComputer: mine.id } }),
    { kind: 'desktop', id: mine.id, name: 'MOONLIGHT' });
  // 别人的设备 id 冒充不了：按浏览器算
  assert.equal(chatOrigin(ctx, { headers: { 'user-agent': WIN_UA }, body: { client: 'web', fromComputer: theirs.id } }).kind, 'web');

  const phoneUa = 'Mozilla/5.0 (Linux; Android 16; SM-S9370 Build/BP2A.250605.031; wv) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36 BridgeDevice/abcdef123456';
  const o = chatOrigin(ctx, { headers: { 'user-agent': phoneUa }, body: { client: 'apk' } });
  assert.deepEqual(o, { kind: 'phone', id: 'd:abcdef123456', name: 'SM-S9370' });
  const p = O.phoneClients('admin').find((x) => x.id === 'd:abcdef123456');
  assert.equal(p.model, 'SM-S9370');
  assert.equal(p.android, '16');

  // devices 工具里桌面客户端那一行带上「发自这台」
  const server = makeDeviceMcp({ ctx, getLink: () => mine.id, getSession: () => 's1', getOrigin: () => ({ kind: 'desktop', id: mine.id, name: 'MOONLIGHT' }) });
  const out = (await server.instance._registeredTools.devices.handler({}, {})).content[0].text;
  assert.match(out, /这条消息发自：Windows 桌面客户端「MOONLIGHT」/);
  assert.match(out, /MOONLIGHT.*← 本会话连接的设备.*← 这条消息发自这台/);
  assert.doesNotMatch(out, /OTHER/);
});
