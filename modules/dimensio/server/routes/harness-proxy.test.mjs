// M15（kimi K32）：bridge 反代到 harness 时剥掉远端凭证——Authorization / Cookie / Proxy-Authorization 头与 ?token= 查询参数。
// harness 只认进程内能力令牌；远端的管理员令牌不该出现在 harness 能看到（进而可能记进日志、诊断包）的任何地方。
import { test } from 'node:test';
import assert from 'node:assert';
import { upstreamRequest } from './harness.mjs';

test('反代剥掉远端凭证头，换上进程内能力令牌；其余头照转', () => {
  const url = new URL('http://127.0.0.1:8787/api/harness/api/sessions?offset=0&limit=20');
  const { path, headers } = upstreamRequest(
    {
      host: 'bridge.example',
      connection: 'keep-alive',
      authorization: 'Bearer FAKE-admin-token',
      cookie: 'bridge_auth=FAKE-cookie; other=1',
      'proxy-authorization': 'Basic FAKE',
      'x-dimensio-internal-token': 'FAKE-client-forged',
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    url,
  );
  assert.equal(path, '/api/sessions?offset=0&limit=20');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers['proxy-authorization'], undefined);
  assert.equal(headers.host, undefined);
  assert.notEqual(headers['x-dimensio-internal-token'], 'FAKE-client-forged', '客户端伪造的内部令牌被换掉');
  assert.ok(headers['x-dimensio-internal-token']);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.accept, 'text/event-stream');
});

test('反代剥掉 ?token=（GET 资源的 bridge 鉴权），其余查询参数原样', () => {
  const url = new URL('http://127.0.0.1:8787/api/harness/api/sessions/abc/artifact?path=out%2F%E6%8A%A5%E5%91%8A.md&token=FAKE-admin-token&download=1');
  const { path } = upstreamRequest({}, url);
  assert.ok(!path.includes('FAKE-admin-token'));
  const got = new URL('http://x' + path);
  assert.equal(got.pathname, '/api/sessions/abc/artifact');
  assert.equal(got.searchParams.get('path'), 'out/报告.md');
  assert.equal(got.searchParams.get('download'), '1');
  assert.equal(got.searchParams.has('token'), false);
  // 没有 token 的查询串原样转，不重新编码
  const plain = upstreamRequest({}, new URL('http://127.0.0.1:8787/api/harness/api/files?path=a%20b'));
  assert.equal(plain.path, '/api/files?path=a%20b');
});
