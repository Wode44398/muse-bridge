// S10（#89 方案 2）bridge 侧：桌面壳没有调试端口之后，bridge 怎么认壳。
// 修前：注册 / env 都要求 cdpPort > 0，新壳（CDP 经 broker 转发、没有调试端口）会被当成不存在，内置浏览器退回无头。
// 数据根改道到临时目录再 import：注册会写 desktop-host.json，不能碰真数据目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'bridge-s10-'));
process.env.BRIDGE_DATA_ROOT = root;
delete process.env.BRIDGE_DESKTOP_BROKER;
delete process.env.BRIDGE_DESKTOP_CDP_PORT;
const host = await import('./desktop-host.mjs');
test.after(() => { host.clearDesktopHost(); rmSync(root, { recursive: true, force: true }); });

const SECRET = 'FAKE-DUMMY-secret';
async function fakeBroker(t, mode) {
  const server = http.createServer((req, res) => {
    if (mode === 'proxy' && req.url === `/${SECRET}/json/version`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/${SECRET}/devtools/browser` }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/${SECRET}`;
}

test('S10 新壳只报 broker（cdpPort 0）：注册收下、落盘；liveDesktopHost 认出转发基址', async (t) => {
  const broker = await fakeBroker(t, 'proxy');
  const info = host.registerDesktopHost({ cdpPort: 0, proxy: true, brokerUrl: broker });
  assert.deepEqual(info, { cdpPort: 0, brokerUrl: broker });
  assert.equal(JSON.parse(readFileSync(host.DESKTOP_HOST_FILE, 'utf8')).brokerUrl, broker, 'harness 靠这个文件认壳');
  const live = await host.liveDesktopHost();
  assert.equal(live.cdpBase, broker);
  assert.equal(live.proxy, true);
  assert.throws(() => host.registerDesktopHost({ cdpPort: 0, brokerUrl: 'http://evil.example/x' }), /非法/);
});

test('S10 旧壳（broker 不认 /json/version、带调试端口）照旧走端口；旧 broker 又没端口就回落无头；env 只给 broker 也认', async (t) => {
  const old = await fakeBroker(t, 'old');
  host.registerDesktopHost({ cdpPort: 9444, brokerUrl: old });
  const live = await host.liveDesktopHost();
  assert.equal(live.cdpBase, 'http://127.0.0.1:9444');
  assert.equal(live.proxy, false);
  assert.equal(await host.resolveCdpBase({ cdpPort: 0, brokerUrl: old }), null);

  const proxy = await fakeBroker(t, 'proxy');
  process.env.BRIDGE_DESKTOP_BROKER = proxy;
  t.after(() => { delete process.env.BRIDGE_DESKTOP_BROKER; });
  assert.deepEqual(host.desktopHostInfo(), { cdpPort: 0, brokerUrl: proxy, source: 'env' });
});
