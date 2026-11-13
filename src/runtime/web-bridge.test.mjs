// Web Bridge 的链路协议与挑浏览器（不起真浏览器：用 ws 包假扮扩展）。真 Edge 全链路（临时配置档 + --load-extension 加载
// bridge build/client/web-bridge：两个会话、弹窗跟组、分享接手、租约、close、叫停、两个配置并存、改名、组标题）2026-11-02 手动跑过。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'wb-test-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_BROWSER_PERSIST = '0';
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const { WebBridgeHub, pickBrowser, ownerOf, WEB_BRIDGE_EXTENSION_ID, WEB_BRIDGE_PATH } = await import('./web-bridge.mjs');
const { default: WebSocket } = await import('ws');

const ORIGIN = `chrome-extension://${WEB_BRIDGE_EXTENSION_ID}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function startHub() {
  const hub = new WebBridgeHub({ log: () => {} });
  // 测试用一个随机高位端口，不占 47821（开发机上可能跑着客户端）
  const port = await hub.listen([0]);
  return { hub, port: hub.server.address().port || port };
}

// 假扩展：连上、回 hello，记下收到的消息
function fakeExtension(port, { id = 'a'.repeat(32), kind = 'edge', origin = ORIGIN, hello = {} } = {}) {
  const got = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WEB_BRIDGE_PATH}?id=${id}&kind=${kind}`, { headers: { Origin: origin } });
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', id, kind, browser: kind === 'edge' ? 'Edge 156' : 'Chrome 141', version: '1.0.0', ...hello })));
    ws.on('message', (data) => { const m = JSON.parse(String(data)); got.push(m); if (m.t === 'hello') resolve(); });
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
    ws.on('error', reject);
  });
  return { ws, got, ready };
}

test('只认 Web Bridge 扩展的 Origin', async () => {
  const { hub, port } = await startHub();
  try {
    const bad = fakeExtension(port, { origin: 'https://evil.example' });
    await assert.rejects(bad.ready, (e) => e.status === 403);
    const good = fakeExtension(port);
    await good.ready;
    await delay(50);
    assert.equal(hub.connectedLinks().length, 1);
    assert.equal(hub.connectedLinks()[0].label, 'Edge 156');
    good.ws.close();
  } finally { hub.close(); }
});

test('同一实例重连：新的顶掉旧的；不同实例各占一条', async () => {
  const { hub, port } = await startHub();
  try {
    const a1 = fakeExtension(port, { id: '1'.repeat(32) });
    await a1.ready;
    const b = fakeExtension(port, { id: '2'.repeat(32), kind: 'chrome', hello: { email: 'me@example.com' } });
    await b.ready;
    const a2 = fakeExtension(port, { id: '1'.repeat(32), hello: { name: '工作 Edge' } });
    await a2.ready;
    await delay(80);
    assert.ok(a1.got.some((m) => m.t === 'replaced'), '旧连接收到 replaced');
    const labels = hub.list().map((l) => l.label).sort();
    assert.deepEqual(labels, ['Chrome · me@example.com', '工作 Edge']);
    for (const x of [a1, a2, b]) x.ws.close();
  } finally { hub.close(); }
});

test('挑浏览器：id / 种类 / 名字与邮箱 / 歧义与找不到都说清楚', () => {
  const mk = (id, kind, extra = {}) => ({
    id, shortId: id.slice(0, 8), connected: true, kindName: kind === 'edge' ? 'Edge' : 'Chrome',
    info: { id, kind, browser: `${kind} 1`, email: '', name: '', ...extra },
    get label() { return this.info.name || (this.info.email ? `${this.kindName} · ${this.info.email}` : this.info.browser); },
  });
  const e1 = mk('aaaaaaaa1111', 'edge', { name: '工作 Edge' });
  const e2 = mk('bbbbbbbb2222', 'edge', { email: 'home@example.com' });
  const c1 = mk('cccccccc3333', 'chrome');
  const all = [e1, e2, c1];
  assert.equal(pickBrowser(all, ''), 'builtin');
  assert.equal(pickBrowser(all, '内置'), 'builtin');
  assert.equal(pickBrowser(all, 'aaaaaaaa'), e1);
  assert.equal(pickBrowser(all, 'chrome'), c1);
  assert.equal(pickBrowser(all, '工作'), e1);
  assert.equal(pickBrowser(all, 'home@'), e2);
  assert.throws(() => pickBrowser(all, 'edge'), /对上了 2 个浏览器[\s\S]*aaaaaaaa[\s\S]*bbbbbbbb/);
  assert.throws(() => pickBrowser(all, 'firefox'), /没有叫「firefox」/);
  assert.throws(() => pickBrowser([], 'edge'), /没有连着的 Web Bridge 浏览器/);
  assert.equal(pickBrowser([c1], 'mine'), c1, '只连了一个时「我的浏览器」就是它');
});

test('会话键：by + session，标题截短、不带分隔符', () => {
  const o = ownerOf({ by: 'claude', session: 'abc|def ghi', title: '  很长很长的标题  '.repeat(8) });
  assert.equal(o.key, 'claude:abcdefghi');
  assert.equal(o.agent, 'Claude');
  assert.ok(o.title.length <= 40);
  assert.equal(ownerOf({}).key, 'agent:-');
});

test('用户在浏览器里叫停：这个会话 10 分钟内再来被拒，并被要求先问用户', async () => {
  const { hub, port } = await startHub();
  try {
    const ext = fakeExtension(port);
    await ext.ready;
    await delay(30);
    const link = hub.connectedLinks()[0];
    ext.ws.send(JSON.stringify({ t: 'stop', owner: 'claude:s1', reason: 'page-button' }));
    await delay(50);
    const r = await hub.run(link, { action: 'read_page' }, { by: 'claude', session: 's1' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /点了「停止」/);
    const other = await hub.run(link, { action: 'resize', preset: 'mobile' }, { by: 'claude', session: 's2' });
    assert.match(other.content[0].text, /不改它的视口/, '别的会话不受影响（resize 照常被拒的那句）');
    ext.ws.close();
  } finally { hub.close(); }
});

test('没附着时：tabs 只列不附着；其他动作提示先 navigate 或接手分享的标签', async () => {
  const { hub, port } = await startHub();
  try {
    const ext = fakeExtension(port);
    ext.ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.t === 'rpc' && m.op === 'list') {
        ext.ws.send(JSON.stringify({ t: 'rpcres', rid: m.rid, result: { mine: [], shared: [{ id: 't42', url: 'https://mail.example/', title: '收件箱' }] } }));
      }
    });
    await ext.ready;
    await delay(30);
    const link = hub.connectedLinks()[0];
    const who = { by: 'codex', session: 'x' };
    const tabs = await hub.run(link, { action: 'tabs' }, who);
    assert.match(tabs.content[0].text, /tab:"t42" 收件箱/);
    const rp = await hub.run(link, { action: 'read_page' }, who);
    assert.equal(rp.isError, true);
    assert.match(rp.content[0].text, /先 navigate[\s\S]*tab:"t42"/);
    assert.equal(ext.got.filter((m) => m.t === 'open').length, 0, '没有打开任何频道（没附着用户的标签）');
    ext.ws.close();
  } finally { hub.close(); }
});
