// 插件实时通道（六期）：登记端点 → 换一次性票 → 连上收发文本与二进制 → 票只能用一次 → 插件停用时连接关闭。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { registerSocket, dropPluginSockets, attachPluginSockets, mintSocketTicket, hasSocket, socketWho, _test } from './sockets.mjs';

const active = new Set(['demo']);
let server, port, detach;

test.before(async () => {
  server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  detach = attachPluginSockets(server, { isActive: (id) => active.has(id) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.after(async () => { detach(); await new Promise((r) => server.close(r)); });

const open = (path) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.binaryType = 'arraybuffer';
  const got = [];
  ws.onmessage = (e) => got.push(e.data);
  ws.onopen = () => resolve({ ws, got, ok: true });
  ws.onerror = () => resolve({ ws, got, ok: false });
});
const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

test('名字、who 校验与登记查询', () => {
  assert.throws(() => registerSocket('demo', 'Bad Name', () => {}), /名字/);
  assert.throws(() => registerSocket('demo', 'x', () => {}, { who: 'all' }), /who/);
  const off = registerSocket('demo', 'probe', () => {}, { who: 'members' });
  assert.equal(hasSocket('demo', 'probe'), true);
  assert.equal(socketWho('demo', 'probe'), 'members');
  assert.throws(() => registerSocket('demo', 'probe', () => {}), /重名/);
  off();
  assert.equal(hasSocket('demo', 'probe'), false);
});

test('换票连接：收发文本 / 二进制，handler 拿到身份与参数；票只能用一次', async () => {
  let seen = null;
  const off = registerSocket('demo', 'echo', (sock, who, query) => {
    seen = { who, q: query.get('serial') };
    sock.sendJson({ hi: true });
    sock.onText((s) => sock.send('echo:' + s));
    sock.onBinary((b) => sock.sendBinary(Buffer.from([...b].reverse())));
  });
  const { path } = mintSocketTicket('demo', 'echo', { kind: 'admin' }, { serial: 'emulator-5554', bad: { x: 1 } });
  const c = await open(path);
  assert.equal(c.ok, true);
  await until(() => c.got.length >= 1);
  assert.deepEqual(JSON.parse(c.got[0]), { hi: true });
  assert.deepEqual(seen, { who: { kind: 'admin' }, q: 'emulator-5554' });
  c.ws.send('ping');
  c.ws.send(new Uint8Array([1, 2, 3]));
  await until(() => c.got.length >= 3);
  assert.equal(c.got[1], 'echo:ping');
  assert.deepEqual([...new Uint8Array(c.got[2])], [3, 2, 1]);
  // 同一张票再用：401
  const again = await open(path);
  assert.equal(again.ok, false);
  c.ws.close();
  off();
});

test('没登记的端点、别的插件的票、停用的插件：都连不上；停用时已开的连接被关', async () => {
  const off = registerSocket('demo', 'live', () => {});
  assert.equal((await open('/api/plugin/demo/_ws/nope?t=x')).ok, false);
  const other = mintSocketTicket('other', 'live', { kind: 'admin' });
  assert.equal((await open(other.path.replace('/other/', '/demo/'))).ok, false);
  const t = mintSocketTicket('demo', 'live', { kind: 'admin' });
  const c = await open(t.path);
  assert.equal(c.ok, true);
  let closed = false;
  c.ws.onclose = () => { closed = true; };
  await until(() => (_test.live.get('demo')?.size || 0) === 1);
  dropPluginSockets('demo');
  await until(() => closed);
  active.delete('demo');
  const t2 = mintSocketTicket('demo', 'live', { kind: 'admin' });
  assert.equal((await open(t2.path)).ok, false);
  active.add('demo');
  off();
});
