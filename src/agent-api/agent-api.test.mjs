// 给 agent 用的接口（src/agent-api/）的契约：密钥的铸造 / 吊销与属主隔离，鉴权只认请求头，参数校验，
// 文件与定时任务经现成路由端到端，成员只碰得到自己的东西，重放身份标记伪造不了，手册与操作表对得上。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agentapi-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
mkdirSync(process.env.VAULT_PATH, { recursive: true });
const MASTER = 'master-token-for-agent-api-tests-0123';
// 多用户开着才认普通账号的登录会话（与它的 agent 密钥）
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 8787, token: MASTER, features: { multiUser: true, remoteAdmin: true } }, null, 2));
writeFileSync(path.join(process.env.VAULT_PATH, 'README.md'), '# 测试\n苹果\n');

const users = await import('../users.mjs');
const { createAuth } = await import('../auth.mjs');
const { makeIdentify, replayHeadersOf, INTERNAL_IDENTITY, REPLAY_AS_HEADER } = await import('../runtime/identity.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerAgentApiRoutes } = await import('./http.mjs');
const { registerFileRoutes } = await import('../routes/files.mjs');
const { registerRoutineRoutes } = await import('../routes/routines.mjs');
const { fakeRequest } = await import('../runtime/claude-queue.mjs');
const { allOps, getOp, validateArgs } = await import('./registry.mjs');
const { manualToc, manualChapter } = await import('./manual.mjs');

const auth = createAuth(MASTER, false, { isAdminSession: users.isAdminSession });
const identify = makeIdentify({ authOk: auth.authOk, getCookie: auth.getCookie, bearerToken: auth.bearerToken, queryToken: auth.queryToken });
const router = createRouter();
registerAgentApiRoutes(router, { identify, adminGen: auth.gen });
registerFileRoutes(router, { identify });
registerRoutineRoutes(router, { authOk: auth.authOk, identify });
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
after(() => server.close());

const call = async (op, args = {}, { key, headers = {} } = {}) => {
  const r = await fetch(base + '/agent/v1/' + op, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}), ...headers },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: await r.json() };
};
const ADMIN_OWNER = { admin: true, gen: auth.gen };

test('agent 密钥：bak_ 前缀、按属主隔离、吊销即失效、换主令牌全部作废', () => {
  const k = users.createAgentKey(ADMIN_OWNER, { label: '测试' });
  assert.match(k.token, /^bak_/);
  assert.ok(users.listAgentKeys(ADMIN_OWNER).some((x) => x.id === k.id && x.label === '测试'));
  assert.equal(auth.authOk({ headers: { authorization: 'Bearer ' + k.token }, url: '/' }), true, '主机的密钥就是一张管理员会话');
  assert.equal(users.listAgentKeys({ admin: true, gen: 'other-gen' }).length, 0, '别的主令牌指纹下看不到');
  const rotated = createAuth(MASTER + '-rotated', false, { isAdminSession: users.isAdminSession });
  assert.equal(rotated.authOk({ headers: { authorization: 'Bearer ' + k.token }, url: '/' }), false, '换主令牌即作废');
  assert.equal(users.revokeAgentKey(ADMIN_OWNER, k.id), 1);
  assert.equal(auth.authOk({ headers: { authorization: 'Bearer ' + k.token }, url: '/' }), false, '吊销即失效');
});

test('入口与手册不用登录；操作要密钥，且只认请求头不认 cookie', async () => {
  const home = await fetch(base + '/agent');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /markdown/);
  assert.match(await home.text(), /agent\/v1/);
  assert.equal((await fetch(base + '/llms.txt')).status, 200);
  assert.equal((await fetch(base + '/agent/manual?q=定时任务')).status, 200);
  const k = users.createAgentKey(ADMIN_OWNER, { label: 'hdr' });
  assert.equal((await call('whoami')).status, 401);
  assert.equal((await call('whoami', {}, { headers: { cookie: 'bridge_auth=' + encodeURIComponent(k.token) } })).status, 401, 'cookie 不认');
  const ok = await call('whoami', {}, { key: k.token });
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.data.you.kind, 'host');
  const viaHeader = await call('whoami', {}, { headers: { 'x-bridge-key': k.token } });
  assert.equal(viaHeader.body.ok, true, 'X-Bridge-Key 也认');
  const pre = await fetch(base + '/agent/v1/whoami', { method: 'OPTIONS', headers: { origin: 'https://elsewhere.example', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  users.revokeAgentKey(ADMIN_OWNER, k.id);
  assert.equal((await call('whoami', {}, { key: k.token })).status, 401);
});

test('参数校验：未声明的参数、缺必填、类型不对都回 bad_args；没有的操作回 not_found', async () => {
  const k = users.createAgentKey(ADMIN_OWNER, { label: 'args' });
  const a = await call('files.read', { pth: 'x' }, { key: k.token });
  assert.equal(a.status, 400); assert.equal(a.body.error.code, 'bad_args'); assert.match(a.body.error.hint, /path/);
  assert.equal((await call('files.read', {}, { key: k.token })).body.error.code, 'bad_args');
  assert.equal((await call('sessions.list', { limit: 'abc' }, { key: k.token })).body.error.code, 'bad_args');
  assert.equal((await call('nope.op', {}, { key: k.token })).status, 404);
  // GET 查询串按声明的类型转
  assert.deepEqual(validateArgs(getOp('sessions.list'), { limit: '5', archived: 'true' }), { limit: 5, archived: true });
});

test('文件：写 / 读 / 列 / 冲突 / 覆盖 / 改名 / 越界', async () => {
  const k = users.createAgentKey(ADMIN_OWNER, { label: 'files' }).token;
  assert.equal((await call('files.read', { path: 'README.md' }, { key: k })).body.data.content, '# 测试\n苹果\n');
  assert.equal((await call('files.mkdir', { path: 'notes' }, { key: k })).body.ok, true);
  assert.equal((await call('files.write', { path: 'notes/a.md', content: '一' }, { key: k })).body.data.created, true);
  assert.equal((await call('files.write', { path: 'notes/a.md', content: '二' }, { key: k })).body.error.code, 'conflict');
  assert.equal((await call('files.write', { path: 'notes/a.md', content: '三', overwrite: true }, { key: k })).body.data.overwritten, true);
  assert.equal(readFileSync(path.join(process.env.VAULT_PATH, 'notes', 'a.md'), 'utf8'), '三');
  const list = await call('files.list', { path: 'notes' }, { key: k });
  assert.deepEqual(list.body.data.items.map((i) => i.name), ['a.md']);
  assert.equal((await call('files.rename', { path: 'notes/a.md', name: 'b.md' }, { key: k })).body.data.to, 'notes/b.md');
  const esc = await call('files.read', { path: '../../../etc/passwd' }, { key: k });
  assert.equal(esc.body.ok, false, '越界读不到');
  const search = await call('files.search', { q: 'b.md' }, { key: k });
  assert.deepEqual(search.body.data.matches.map((m) => m.path), ['notes/b.md']);
});

test('删除：服务端不在 Windows 上时没有回收站，主机身份也是永久删除（不能报错）', async () => {
  const k = users.createAgentKey(ADMIN_OWNER, { label: 'delete' }).token;
  assert.equal((await call('files.write', { path: 'gone.md', content: 'x' }, { key: k })).body.ok, true);
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const d = await call('files.delete', { path: 'gone.md' }, { key: k });
    assert.equal(d.body.ok, true, JSON.stringify(d.body));
    assert.equal(d.body.data.recoverable, false);
  } finally { Object.defineProperty(process, 'platform', real); }
  assert.equal((await call('files.read', { path: 'gone.md' }, { key: k })).body.error.code, 'not_found');
});

test('定时任务：建 / 改 / 删，Ultracode 被拒', async () => {
  const k = users.createAgentKey(ADMIN_OWNER, { label: 'routines' }).token;
  const c = await call('routines.create', { name: 'r', prompt: '做点事', schedule: { type: 'weekly', weekday: 2, hour: 7, minute: 5 } }, { key: k });
  assert.equal(c.body.ok, true);
  const id = c.body.data.routine.id;
  assert.equal(c.body.data.routine.engine, 'claude');
  assert.equal((await call('routines.update', { id, enabled: false }, { key: k })).body.data.routine.enabled, false);
  assert.equal((await call('routines.create', { prompt: 'x', schedule: { type: 'daily' }, effort: 'ultracode' }, { key: k })).body.error.code, 'bad_args');
  assert.equal((await call('routines.delete', { id }, { key: k })).body.ok, true);
  assert.equal((await call('routines.list', {}, { key: k })).body.data.routines.length, 0);
});

test('成员的密钥：只看得到自己的文件夹，没命令行就不能换根，看不到主机的密钥', async () => {
  await users.createUser('agentuser', 'pw-agentuser-123', 'user');
  const k = users.createAgentKey({ user: 'agentuser' }, { label: 'member' }).token;
  const who = await call('whoami', {}, { key: k });
  assert.equal(who.body.data.you.kind, 'member');
  assert.equal(who.body.data.you.shell, false);
  assert.equal((await call('files.list', {}, { key: k })).body.data.items.some((i) => i.name === 'README.md'), false, '看不到主机工作区');
  assert.equal((await call('files.write', { path: 'mine.md', content: 'x' }, { key: k })).body.ok, true);
  assert.equal((await call('files.list', { ws: process.env.VAULT_PATH }, { key: k })).body.error.code, 'forbidden');
  const keys = (await call('keys.list', {}, { key: k })).body.data.keys;
  assert.deepEqual(keys.map((x) => x.label), ['member']);
  // 停用账号：密钥立即失效
  users.setDisabled('agentuser', true);
  assert.equal((await call('whoami', {}, { key: k })).status, 401);
  users.setDisabled('agentuser', false);
});

test('重放身份标记：只能来自进程内身份，网络请求头伪造无效；停用的账号重放不给身份', async () => {
  const forged = replayHeadersOf({ headers: { authorization: 'x', [REPLAY_AS_HEADER]: 'admin' } });
  assert.equal(forged[REPLAY_AS_HEADER], undefined);
  const internal = replayHeadersOf({ headers: {}, [INTERNAL_IDENTITY]: { kind: 'user', user: (users.getUser('agentuser').id || 'agentuser') } });
  const r = fakeRequest({ headers: internal, url: '/api/chat', body: {} });
  assert.equal(r[INTERNAL_IDENTITY].kind, 'user');
  assert.equal(r.headers[REPLAY_AS_HEADER], undefined, '标记不留在请求头里');
  users.setDisabled('agentuser', true);
  assert.equal(fakeRequest({ headers: internal, url: '/api/chat', body: {} })[INTERNAL_IDENTITY], undefined);
  users.setDisabled('agentuser', false);
});

test('手册：每章恰好一个 # 标题、占位符都填上、提到的操作名都存在', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manual');
  const ids = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.ok(ids.length >= 12);
  assert.deepEqual(manualToc(null, 'https://x').map((c) => c.id).sort(), [...ids].sort());
  const ops = new Set(allOps().map((o) => o.name));
  const groups = new Set(allOps().map((o) => o.group));
  for (const id of ids) {
    const raw = readFileSync(path.join(dir, id + '.md'), 'utf8');
    assert.equal(raw.match(/^# /gm)?.length, 1, id + '：一个 # 标题');
    const md = manualChapter(id, null, 'https://x').markdown;
    assert.doesNotMatch(md, /\{\{/, id + '：占位符没填');
    for (const [, name] of md.matchAll(/`([a-z]+\.[a-z_]+)`/g)) {
      if (groups.has(name.split('.')[0]) && !/\.(md|mjs|json|js|txt)$/.test(name)) assert.ok(ops.has(name), `${id} 提到了不存在的操作 ${name}`);
    }
  }
});
