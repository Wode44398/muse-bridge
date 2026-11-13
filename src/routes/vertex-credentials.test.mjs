// 核心的「Google 云凭据」接口（routes/vertex-credentials.mjs，11-13 从 Media Studio 扩展搬回核心）：
//   · 不装 Media Studio（getModule('studio') 拿不到）也能读、能存
//   · 只给管理员：成员 403、没登录 401
//   · 存了项目 ID 立刻重新发布模型中心的 Vertex（以前要等下一次改模型中心或重启）；清掉项目就撤下
// 不联网：不带 test，就不会真打 Google。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-vx-route-'));
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 1, token: 'test-token-0123456789abcdefghij', vertexProject: '' }));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
for (const k of ['VERTEX_PROJECT', 'VERTEX_LOCATION', 'VERTEX_MEDIA_LOCATION', 'GEMINI_API_KEY', 'BRIDGE_VERTEX_RELAY']) delete process.env[k];

const R = await import('../runtime/model-hub/registry.mjs');
const G = await import('../runtime/model-hub/gateway.mjs');
const { getModule } = await import('../modules/registry.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerVertexCredentialRoutes } = await import('./vertex-credentials.mjs');

R._resetHubForTests(path.join(tmp, 'hub'));
await R.initModelHub();

const router = createRouter();
registerVertexCredentialRoutes(router, { identify: (req) => ({ kind: req.headers['x-who'] || 'admin' }) });
const web = http.createServer((q, s) => router.dispatch(q, s));
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${web.address().port}`;
const call = async (method, body, who = 'admin') => {
  const r = await fetch(API + '/api/vertex/credentials', { method, headers: { 'content-type': 'application/json', 'x-who': who }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, j: await r.json() };
};

after(async () => { web.close(); await G._stopGatewayForTests(); });

test('没装 Media Studio 也能用；只给管理员', async () => {
  assert.equal(getModule('studio'), null);
  const a = await call('GET');
  assert.equal(a.status, 200);
  assert.equal(a.j.ok, true);
  assert.equal(a.j.project, '');
  assert.equal((await call('GET', undefined, 'user')).status, 403);
  assert.equal((await call('GET', undefined, 'none')).status, 401);
  assert.equal((await call('POST', { project: 'x-proj-1234' }, 'user')).status, 403);
});

test('存了项目 ID 立刻发布模型中心的 Vertex，清掉就撤下', async () => {
  assert.equal(R.vertexView().configured, false);
  assert.equal(R.vertexView().published, false);
  const r = await call('POST', { project: 'my-proj-1234' });
  assert.equal(r.status, 200);
  assert.equal(r.j.project, 'my-proj-1234');
  assert.equal(R.vertexView().configured, true);
  assert.equal(R.vertexView().published, true, '存完不用等别的改动，Vertex 已经发布给 agent');
  await call('POST', { project: '' });
  assert.equal(R.vertexView().configured, false);
  assert.equal(R.vertexView().published, false);
});
