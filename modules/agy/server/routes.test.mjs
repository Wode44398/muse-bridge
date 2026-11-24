import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-routes-'));
const dataRoot = path.join(tmp, 'data');
const usersRoot = path.join(tmp, 'users');
const vaultDir = path.join(tmp, 'vault');
const projectDir = path.join(tmp, 'my-project');
const stateFile = path.join(tmp, 'fake-acp-state.json');

mkdirSync(dataRoot, { recursive: true });
mkdirSync(usersRoot, { recursive: true });
mkdirSync(vaultDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = usersRoot;
process.env.VAULT_PATH = vaultDir;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';
process.env.AGY_BIN = FAKE_AGENT;
process.env.AGY_NO_WARMUP = '1';
process.env.FAKE_ACP_STATE_FILE = stateFile;

writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
  port: 18991,
  token: 'agy-test-master-token-0123456789',
  vaultPath: vaultDir,
  usersRoot,
  features: { multiUser: true },
}, null, 2));

const { loadModules, registerModuleRoutes } = await import('@bridge/core/modules/registry.mjs');
await loadModules();

const { createRouter } = await import('@bridge/core/runtime/router.mjs');
const { registerAuthRoutes } = await import('@bridge/core/routes/auth.mjs');
const { registerChatRoutes } = await import('@bridge/core/routes/chat.mjs');
const { createAuth } = await import('@bridge/core/auth.mjs');
const { makeIdentify } = await import('@bridge/core/runtime/identity.mjs');
const { agentAuthed } = await import('@bridge/core/runtime/agent-status.mjs');
const users = await import('@bridge/core/users.mjs');
const { AcpClient, setAcpClientForTest, shutdownAgy } = await import('./acp/index.mjs');

const testClient = new AcpClient({
  daemonCwd: path.join(dataRoot, 'agy', 'daemon-cwd'),
  logFile: null,
  env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile },
});
setAcpClientForTest(testClient);

const MASTER = 'agy-test-master-token-0123456789';
const auth = createAuth(MASTER, false, {
  isAdminSession: (t, g) => users.isAdminSession(t, g),
  isUserSession: (t) => !!users.getSession(t),
});
const identify = makeIdentify({
  authOk: auth.authOk,
  getCookie: auth.getCookie,
  bearerToken: auth.bearerToken,
  queryToken: auth.queryToken,
});

const router = createRouter();
registerAuthRoutes(router, { ...auth, adminGen: auth.gen, identify });
registerChatRoutes(router, { authOk: auth.authOk, identify });
registerModuleRoutes(router, { authOk: auth.authOk, identify });

const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const BASE = `http://127.0.0.1:${server.address().port}`;
const ADMIN_HEADERS = {
  authorization: `Bearer ${MASTER}`,
  'content-type': 'application/json',
  connection: 'close',
};

const activeControllers = new Set();
const rawFetch = globalThis.fetch;
function fetch(url, init = {}) {
  const ctl = new AbortController();
  activeControllers.add(ctl);
  return rawFetch(url, { ...init, signal: ctl.signal });
}

function cleanupTempTree() {
  // users.mjs 对 usersRoot/_system 挂了 fs.watch：Windows Node 24 下在起过 http.Server 后直接删除被监视目录本身，
  // 会触发 libuv uv_fs_event 句柄不释放导致进程无法退出，因此只清空 _system 目录内容而保留空壳目录。
  try {
    for (const top of readdirSync(tmp)) {
      const fullTop = path.join(tmp, top);
      if (top === 'users') {
        for (const entry of readdirSync(fullTop)) {
          const full = path.join(fullTop, entry);
          if (entry === '_system') {
            for (const sub of readdirSync(full)) {
              rmSync(path.join(full, sub), { recursive: true, force: true });
            }
          } else {
            rmSync(full, { recursive: true, force: true });
          }
        }
      } else {
        rmSync(fullTop, { recursive: true, force: true });
      }
    }
  } catch {}
}

after(async () => {
  for (const ctl of [...activeControllers]) {
    try { ctl.abort(); } catch {}
  }
  activeControllers.clear();
  shutdownAgy();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  cleanupTempTree();
});

function parseSseFrames(rawText) {
  const frames = [];
  for (const chunk of String(rawText).split('\n\n')) {
    const dataLines = chunk
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    if (!dataLines.length) continue;
    try { frames.push(JSON.parse(dataLines.join('\n'))); } catch {}
  }
  return frames;
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

test('准入与隔离：只开给被授权的完全信任档成员；他用自己的 agy 进程，看不到管理员的会话，主机上的事碰不了', async () => {
  const adminAuth = await (await fetch(`${BASE}/api/auth`, { headers: ADMIN_HEADERS })).json();
  assert.equal(adminAuth.allowAgy, true);
  assert.ok(adminAuth.agents.includes('agy'));

  const headersOf = (name) => {
    const tok = users.createSession(users.accountIdOf(name));
    return { authorization: `Bearer ${tok}`, 'content-type': 'application/json', connection: 'close' };
  };
  const j = async (headers, p, init = {}) => {
    const r = await fetch(`${BASE}${p}`, { headers, ...init });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };

  // 普通档：没有命令行权限，管理员勾了 agy 也不给
  await users.createUser('plain_member', 'password123', 'user');
  users.setAgents('plain_member', ['claude', 'agy']);
  const plain = headersOf('plain_member');
  assert.equal((await j(plain, '/api/auth')).body.allowAgy, false);
  assert.equal((await j(plain, '/api/agy/status')).status, 403);
  assert.equal((await j(plain, '/api/chat', { method: 'POST', body: JSON.stringify({ agent: 'agy', message: 'hello' }) })).status, 403);

  // 完全信任档但没被勾选：同样不给
  await users.createUser('pro_unlisted', 'password123', 'pro');
  assert.equal((await j(headersOf('pro_unlisted'), '/api/agy/status')).status, 403);

  // 完全信任档 + 被勾选：可以用，走他自己的进程（测试里换成另一份状态文件的假 agy，等于另一个会话库）
  const tenantState = path.join(tmp, 'tenant-state.json');
  const { setTenantClientFactoryForTest, tenantDataDir } = await import('./tenants.mjs');
  const spawned = [];
  setTenantClientFactoryForTest((opts) => {
    spawned.push(opts);
    return new AcpClient({ ...opts, logFile: null, env: { ...process.env, FAKE_ACP_STATE_FILE: tenantState } });
  });
  await users.createUser('pro_member', 'password123', 'pro');
  users.setAgents('pro_member', ['claude', 'agy']);
  const member = headersOf('pro_member');
  const memberAuth = (await j(member, '/api/auth')).body;
  assert.equal(memberAuth.allowAgy, true);

  // 管理员先留一个会话，成员那边不该看见
  const adminChat = parseSseFrames(await (await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ agent: 'agy', cwd: projectDir, message: '管理员的私事' }),
  })).text());
  const adminSid = adminChat.find((f) => f.type === 'done').sessionId;

  const st = await j(member, '/api/agy/status?ensure=1');
  assert.equal(st.status, 200);
  assert.equal(st.body.account.email, null, '主机登录的邮箱不给成员');
  assert.equal(st.body.logInfo, null);
  assert.equal(spawned.length, 1, '成员有自己单独的进程');
  assert.ok(spawned[0].extraArgs.includes('--gemini-dir'), '用自己的一份 agy 目录');
  assert.equal(typeof spawned[0].beforeSpawn, 'function', '起进程前要装守卫');
  const memberId = users.accountIdOf('pro_member');
  const dataDir = tenantDataDir({ kind: 'user', user: memberId });
  assert.ok(existsSync(path.join(dataDir, '..', 'config', 'hooks.json')), '守卫已经装进他的全局配置');
  assert.ok(!dataDir.startsWith(usersRoot), '这份目录不在任何人的文件夹里');

  const memberList = (await j(member, '/api/agy/sessions?refresh=1')).body;
  assert.ok(!memberList.sessions.some((s) => s.sessionId === adminSid), '看不到管理员的会话');
  assert.equal((await j(member, `/api/agy/session/${adminSid}`)).status >= 400, true, '也打不开');

  // 成员自己的对话照常跑，工作目录只能在自己的文件夹里
  const outside = await j(member, '/api/chat', { method: 'POST', body: JSON.stringify({ agent: 'agy', cwd: projectDir, message: 'x' }) });
  assert.ok(outside.status === 400 || outside.status === 403, '不能把工作目录指到别处');
  const mine = parseSseFrames((await j(member, '/api/chat', { method: 'POST', body: JSON.stringify({ agent: 'agy', message: '成员的对话' }) })).text);
  const memberSid = mine.find((f) => f.type === 'done').sessionId;
  assert.ok(memberSid && memberSid !== adminSid);
  const adminList = (await j(ADMIN_HEADERS, '/api/agy/sessions?refresh=1')).body;
  assert.ok(!adminList.sessions.some((s) => s.sessionId === memberSid), '管理员的列表里也没有成员的会话（各是各的库）');
  assert.ok((await j(member, '/api/agy/sessions?refresh=1')).body.sessions.some((s) => s.sessionId === memberSid));

  // 主机上的事：登出、全局 MCP 与插件、CLI 升级、运行日志
  assert.equal((await j(member, '/api/agy/logout', { method: 'POST', body: '{}' })).status, 403);
  for (const [method, url] of [['GET', '/api/agy/mcp'], ['POST', '/api/agy/mcp/add'], ['GET', '/api/agy/plugins'], ['POST', '/api/agy/update']]) {
    assert.equal((await j(member, url, { method, ...(method === 'POST' ? { body: '{}' } : {}) })).status, 403, `${method} ${url}`);
  }

  // 守卫的判定接口：只认成员自己的按人令牌；主机密钥、别的 agent 的令牌都不认
  const { mintAgentDeviceToken } = await import('@bridge/core/runtime/agent-device-token.mjs');
  const { ensureHostSecret } = await import('@bridge/core/runtime/host-secret.mjs');
  const ask = (token, payload) => j({ authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close' }, '/api/agy/internal/guard', { method: 'POST', body: JSON.stringify({ payload }) });
  const memberRoot = memberAuth.cwd || path.join(usersRoot, memberId);
  const tok = mintAgentDeviceToken(memberId, 'agy');
  const inside = await ask(tok, { toolCall: { name: 'read_file', args: { Path: path.join(memberRoot, 'note.txt') } } });
  assert.equal(inside.status, 200);
  assert.equal(inside.body.out, null, '自己文件夹里的不表态');
  const leak = await ask(tok, { toolCall: { name: 'read_file', args: { Path: path.join(dataRoot, 'config.json') } } });
  assert.equal(leak.body.out.decision, 'deny', '服务端的配置文件读不到');
  const other = await ask(tok, { toolCall: { name: 'read_file', args: { Path: path.join(projectDir, 'x.txt') } } });
  assert.equal(other.body.out.decision, 'deny');
  assert.equal((await ask(ensureHostSecret(), { toolCall: { name: 'read_file', args: {} } })).status, 403, '主机密钥不是守卫');
  assert.ok([401, 403].includes((await ask('dvt1.agy.bogus.sig', { toolCall: { name: 'read_file' } })).status));
  users.setAgents('pro_member', ['claude']);
  assert.ok([401, 403].includes((await ask(tok, { toolCall: { name: 'read_file', args: {} } })).status), '收回授权后令牌当场失效');
  assert.equal((await j(member, '/api/agy/status')).status, 403);

  setTenantClientFactoryForTest(null);
});

test('成员进程的收口：环境变量不带 bridge 的密钥；守卫没应答就停用；账号降档 / 删除时进程与数据一起收', async () => {
  const { setTenantClientFactoryForTest, setGuardLivenessForTest, peekTenantClient, tenantGeminiDir, tenantStats } = await import('./tenants.mjs');
  const { _resetGuardLivenessForTest, guardBroken } = await import('./guard/liveness.mjs');
  const lifecycle = await import('@bridge/core/runtime/account-lifecycle.mjs');
  const { userIdentity, contextFor } = await import('@bridge/core/runtime/identity.mjs');
  const { mintAgentDeviceToken, agentDeviceTokenCtx } = await import('@bridge/core/runtime/agent-device-token.mjs');

  const tenantState = path.join(tmp, 'tenant-state-2.json');
  const spawned = [];
  process.env.BRIDGE_SOMETHING_INTERNAL = 'internal';
  process.env.MY_SERVICE_API_KEY = 'secret';
  setTenantClientFactoryForTest((opts) => {
    spawned.push(opts);
    return new AcpClient({ ...opts, logFile: null, env: { ...opts.env, FAKE_ACP_STATE_FILE: tenantState } });
  });
  const post = async (headers, body) => {
    const r = await fetch(`${BASE}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ agent: 'agy', ...body }) });
    return { status: r.status, text: await r.text() };
  };
  const mkMember = async (name) => {
    await users.createUser(name, 'password123', 'pro');
    users.setAgents(name, ['claude', 'agy']);
    const id = users.accountIdOf(name);
    const tok = users.createSession(id);
    return { id, ctx: contextFor(userIdentity(id)), headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', connection: 'close' } };
  };

  try {
    // ① 环境变量：bridge 的内部变量、名字像密钥的都不进成员的进程
    const a = await mkMember('pro_env');
    const first = parseSseFrames((await post(a.headers, { message: '你好' })).text);
    assert.ok(first.some((f) => f.type === 'done'));
    const env = spawned[0].env;
    assert.ok(env && typeof env === 'object', '成员进程显式给了环境变量，不是原样继承 bridge 的');
    const names = Object.keys(env);
    assert.ok(!names.some((k) => /^BRIDGE_/i.test(k)), 'BRIDGE_ 开头的一个都不给');
    assert.ok(!names.includes('MY_SERVICE_API_KEY'));
    assert.ok(names.some((k) => k.toUpperCase() === 'PATH'), '系统变量照常带着');
    assert.equal(tenantStats().count, 1);

    // ② 守卫探活：工具执行完了、守卫却一次没被问过（假 agy 不会来问）→ 这一轮报错、进程收掉、之后不再给他起
    setGuardLivenessForTest(true);
    const quiet = console.error; console.error = () => {};
    let tripped;
    try { tripped = parseSseFrames((await post(a.headers, { message: '改个文件 [EDIT]' })).text); } finally { console.error = quiet; }
    const err = tripped.find((f) => f.type === 'error');
    assert.ok(err && /守卫没有生效/.test(err.message), '明说是守卫的问题');
    assert.ok(!tripped.some((f) => f.type === 'done'));
    assert.ok(guardBroken(a.ctx.key));
    assert.equal(peekTenantClient(a.ctx), null, '他的进程已经收掉');
    const again = await post(a.headers, { message: '再来' });
    assert.equal(again.status, 503);
    assert.match(again.text, /守卫没有生效/);
    setGuardLivenessForTest(false);
    _resetGuardLivenessForTest();

    // ③ 降成普通档：在用的进程当场收掉，按人令牌也跟着失效（名单里还留着 agy 也不认）
    const b = await mkMember('pro_down');
    assert.ok(parseSseFrames((await post(b.headers, { message: '你好' })).text).some((f) => f.type === 'done'));
    assert.ok(peekTenantClient(b.ctx));
    const tok = mintAgentDeviceToken(b.id, 'agy');
    assert.ok(agentDeviceTokenCtx(tok));
    await lifecycle.setAccountTier('pro_down', 'user');
    assert.equal(peekTenantClient(b.ctx), null);
    assert.equal(agentDeviceTokenCtx(tok), null, '普通档拿着旧令牌也过不了');
    assert.equal((await post(b.headers, { message: '还能用吗' })).status, 403);

    // ④ 删号：进程收掉，他那份 agy 数据（会话库、产物、守卫配置）一起删
    const c = await mkMember('pro_gone');
    assert.ok(parseSseFrames((await post(c.headers, { message: '你好' })).text).some((f) => f.type === 'done'));
    const dir = tenantGeminiDir(c.ctx);
    assert.ok(existsSync(path.join(dir, 'config', 'hooks.json')));
    await lifecycle.deleteAccount('pro_gone', { mode: 'purge', drainMs: 0 });
    assert.equal(peekTenantClient(c.ctx), null);
    assert.ok(!existsSync(dir), '删号后不留他的 agy 数据');
  } finally {
    setGuardLivenessForTest(false);
    _resetGuardLivenessForTest();
    setTenantClientFactoryForTest(null);
    delete process.env.BRIDGE_SOMETHING_INTERNAL;
    delete process.env.MY_SERVICE_API_KEY;
  }
});

test('端到端对话流：图片块、文件编辑 diff、字符串 ID 权限审批与表单提问、产物提取、停止续聊与历史恢复', async () => {
  const projRes = await (await fetch(`${BASE}/api/agy/project/create`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ path: projectDir }),
  })).json();
  assert.equal(projRes.ok, true);
  const projectId = projRes.project.id;

  const setRes = await (await fetch(`${BASE}/api/agy/settings`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      defaultModel: 'gemini-3.8-flash',
      defaultThoughtLevel: 'low',
      systemPromptAppend: '自定义追加提示',
    }),
  })).json();
  assert.equal(setRes.ok, true);

  const imgPath = path.join(projectDir, 'input.png');
  writeFileSync(imgPath, Buffer.from('89504e470d0a1a0a', 'hex'));
  const reportPath = path.join(projectDir, 'deliverable.md');
  writeFileSync(reportPath, '# 交付报告\n', 'utf8');

  const chatPromise = fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      agent: 'agy',
      agyProjectId: projectId,
      attachments: [imgPath],
      message: `执行全链路检查 [EDIT] [PERM] [QUESTION] [LINK:${reportPath}]`,
    }),
  }).then((r) => r.text());

  const activePerm = await waitFor(async () => {
    const st = await (await fetch(`${BASE}/api/agy/active`, { headers: ADMIN_HEADERS })).json();
    return st.active && st.pendingPermission ? st : null;
  });
  assert.equal(typeof activePerm.pendingPermission.requestId, 'string');
  assert.match(activePerm.pendingPermission.requestId, /^perm-/);

  const permAns = await (await fetch(`${BASE}/api/agy/permission`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      requestId: activePerm.pendingPermission.requestId,
      optionId: 'allow',
    }),
  })).json();
  assert.equal(permAns.ok, true);

  const activeQ = await waitFor(async () => {
    const st = await (await fetch(`${BASE}/api/agy/active`, { headers: ADMIN_HEADERS })).json();
    return st.active && st.pendingQuestion ? st : null;
  });
  assert.match(activeQ.pendingQuestion.requestId, /^ask-/);
  assert.equal(activeQ.pendingQuestion.fields.length, 2);

  const qAns = await (await fetch(`${BASE}/api/agy/question`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      requestId: activeQ.pendingQuestion.requestId,
      action: 'accept',
      content: { env: 'prod', features: ['cache'] },
    }),
  })).json();
  assert.equal(qAns.ok, true);

  const sseRaw = await chatPromise;
  const frames = parseSseFrames(sseRaw);
  const types = frames.map((f) => f.type);

  for (const expected of [
    'session', 'thinking', 'tool', 'tool-update', 'diff', 'fs',
    'permission', 'permission-resolved', 'question', 'question-resolved', 'done',
  ]) {
    assert.ok(types.includes(expected), `缺少事件 ${expected}`);
  }

  const doneFrame = frames.find((f) => f.type === 'done');
  const sessionId = doneFrame.sessionId;
  assert.ok(sessionId);
  assert.match(doneFrame.result, /model=gemini-3.8-flash\/low\/default/);
  assert.match(doneFrame.result, /imgs=1/);
  assert.match(doneFrame.result, /perm=allow/);
  assert.match(doneFrame.result, /answer=accept:\{"env":"prod","features":\["cache"\]\}/);
  assert.match(doneFrame.result, /\[APPEND_OK\]/);
  assert.equal(doneFrame.attachments.length, 1);
  assert.equal(doneFrame.attachments[0].name, 'deliverable.md');

  // attach 重放已完成的整轮事件流
  const attachRaw = await (await fetch(`${BASE}/api/agy/attach?session=${encodeURIComponent(sessionId)}`, {
    headers: ADMIN_HEADERS,
  })).text();
  const attachFrames = parseSseFrames(attachRaw);
  assert.equal(attachFrames[0].type, 'attach');
  assert.equal(attachFrames[0].done, true);
  assert.ok(attachFrames.some((f) => f.type === 'permission-resolved'));
  assert.ok(attachFrames.some((f) => f.type === 'question-resolved'));
  assert.ok(attachFrames.some((f) => f.type === 'done'));

  // artifact 认 ?token= 直链读取产物
  const artRes = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(reportPath)}&token=${MASTER}`, {
    headers: { connection: 'close' },
  });
  assert.equal(artRes.status, 200);
  assert.equal(await artRes.text(), '# 交付报告\n');

  // 附件卡的预览图档（thumb=）：图片出 webp 缩略图；出不了图的类型回 404（前端落回类型卡）
  const thumbProbe = path.join(projectDir, 'thumb-probe.png');
  writeFileSync(thumbProbe, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const thumbRes = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(thumbProbe)}&thumb=grid&token=${MASTER}`, {
    headers: { connection: 'close' },
  });
  assert.equal(thumbRes.status, 200);
  assert.equal(thumbRes.headers.get('content-type'), 'image/webp');
  assert.ok((await thumbRes.arrayBuffer()).byteLength > 0);
  const noThumbRes = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(reportPath)}&thumb=grid&token=${MASTER}`, {
    headers: { connection: 'close' },
  });
  assert.equal(noThumbRes.status, 404);
  await noThumbRes.text();

  // 在线切配置 + 重启常驻进程 + session/:id 历史恢复与配置自动还原
  const cfgRes = await (await fetch(`${BASE}/api/agy/config`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ sessionId, configId: 'mode', value: 'plan' }),
  })).json();
  assert.equal(cfgRes.ok, true);
  assert.equal(cfgRes.mode, 'plan');

  const restartRes = await (await fetch(`${BASE}/api/agy/restart`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
  })).json();
  assert.equal(restartRes.ok, true);
  assert.equal(restartRes.status.running, true);

  const detail = await (await fetch(`${BASE}/api/agy/session/${encodeURIComponent(sessionId)}`, {
    headers: ADMIN_HEADERS,
  })).json();
  assert.equal(detail.sessionId, sessionId);
  assert.equal(detail.mode, 'plan');
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].role, 'user');
  assert.equal(detail.messages[0].images.length, 1, '重启后重开历史仍保留用户发送的图片');
  assert.equal(detail.messages[0].images[0].name, 'input.png');
  const histImgRes = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(detail.messages[0].images[0].path)}&token=${MASTER}`, {
    headers: { connection: 'close' },
  });
  assert.equal(histImgRes.status, 200);
  await histImgRes.arrayBuffer();
  assert.equal(detail.messages[1].tools.length, 2);
  assert.equal(detail.messages[1].tools[0].diffs[0].oldText, 'before\n');
  assert.equal(detail.messages[1].tools[1].approvalState, 'allowed');

  // 中途停止与恢复续聊
  const slowChatPromise = fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ agent: 'agy', sessionId, message: '长任务 [SLOW]' }),
  }).then((r) => r.text());

  await waitFor(async () => {
    const st = await (await fetch(`${BASE}/api/agy/active?session=${encodeURIComponent(sessionId)}`, { headers: ADMIN_HEADERS })).json();
    return st.active;
  });

  const stopRes = await (await fetch(`${BASE}/api/agy/stop`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ sessionId }),
  })).json();
  assert.equal(stopRes.ok, true);

  const slowFrames = parseSseFrames(await slowChatPromise);
  assert.ok(slowFrames.some((f) => f.type === 'interrupted'));

  // 停止后重新加载历史，仍能看到已停止轮次的 interrupted 标记
  const detailAfterStop = await (await fetch(`${BASE}/api/agy/session/${encodeURIComponent(sessionId)}`, {
    headers: ADMIN_HEADERS,
  })).json();
  const stoppedAssistants = (detailAfterStop.messages || []).filter((m) => m.role === 'assistant' && m.status === 'interrupted');
  assert.equal(stoppedAssistants.length, 1);

  const followFrames = parseSseFrames(await (await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ agent: 'agy', sessionId, message: '取消后恢复测试' }),
  })).text());
  assert.ok(followFrames.some((f) => f.type === 'done'));

  // 重命名、隐藏与恢复
  const renameRes = await (await fetch(`${BASE}/api/agy/session/rename`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ id: sessionId, title: '手改标题' }),
  })).json();
  assert.equal(renameRes.ok, true);

  const list1 = await (await fetch(`${BASE}/api/agy/sessions?projectId=${encodeURIComponent(projectId)}&refresh=1`, {
    headers: ADMIN_HEADERS,
  })).json();
  assert.equal(list1.sessions.some((s) => s.sessionId.includes('phantom')), false);
  const found = list1.sessions.find((s) => s.sessionId === sessionId);
  assert.ok(found);
  assert.equal(found.title, '手改标题');

  const delRes = await (await fetch(`${BASE}/api/agy/session/delete`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ id: sessionId }),
  })).json();
  assert.equal(delRes.ok, true);

  const listAfterHide = await (await fetch(`${BASE}/api/agy/sessions?projectId=${encodeURIComponent(projectId)}`, {
    headers: ADMIN_HEADERS,
  })).json();
  assert.equal(listAfterHide.sessions.some((s) => s.sessionId === sessionId), false);
  assert.ok(listAfterHide.hiddenCount >= 1);

  const restoreRes = await (await fetch(`${BASE}/api/agy/session/restore`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ id: sessionId }),
  })).json();
  assert.equal(restoreRes.ok, true);

  const listAfterRestore = await (await fetch(`${BASE}/api/agy/sessions?projectId=${encodeURIComponent(projectId)}`, {
    headers: ADMIN_HEADERS,
  })).json();
  assert.equal(listAfterRestore.sessions.some((s) => s.sessionId === sessionId), true);
});

test('边界与安全契约：artifact 路径围栏、防伪造幽灵会话与切项目、null 请求体 400、旧通道 410、logout 刷新认证态', async () => {
  // 1) agent:'antigravity' 显式返回 410，不回落进 Claude 分支
  const legacyRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ agent: 'antigravity', message: 'hello' }),
  });
  assert.equal(legacyRes.status, 410);
  const legacyBody = await legacyRes.json();
  assert.match(legacyBody.error, /Antigravity/);

  // 2) parseJsonBody 遇字面量 null 或数组立即回 400，不挂起连接
  const nullBodyRes = await fetch(`${BASE}/api/agy/settings`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: 'null',
  });
  assert.equal(nullBodyRes.status, 400);
  await nullBodyRes.text();

  const arrBodyRes = await fetch(`${BASE}/api/agy/session/rename`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: '["not-an-object"]',
  });
  assert.equal(arrBodyRes.status, 400);
  await arrBodyRes.text();

  // 3) 伪造的不存在 sessionId 请求失败后，绝不在会话列表里留下幽灵条目
  const forgedSid = 'forged-ghost-session-99999';
  const forgedSse = await (await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ agent: 'agy', sessionId: forgedSid, message: '尝试伪造会话' }),
  })).text();
  const forgedFrames = parseSseFrames(forgedSse);
  assert.ok(forgedFrames.some((f) => f.type === 'error'));

  const allSessions = await (await fetch(`${BASE}/api/agy/sessions?includeHidden=1&refresh=1`, {
    headers: ADMIN_HEADERS,
  })).json();
  assert.equal(allSessions.sessions.some((s) => s.sessionId === forgedSid), false, '不应写入幽灵会话');

  // 4) 建两个项目并绑定附加目录，验证禁止已有会话切项目/改 cwd，且 artifact 对管理员同样强制做目录白名单校验
  const projDirA = path.join(tmp, 'proj-sec-a');
  const projDirB = path.join(tmp, 'proj-sec-b');
  const extraAllowedDir = path.join(tmp, 'extra-allowed');
  const outsideDir = path.join(tmp, 'outside-secret');
  mkdirSync(projDirA, { recursive: true });
  mkdirSync(projDirB, { recursive: true });
  mkdirSync(extraAllowedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const outsideSecret = path.join(outsideDir, 'secret.txt');
  const outsideHtml = path.join(outsideDir, 'index.html');
  const allowedExtraFile = path.join(extraAllowedDir, 'allowed.txt');
  writeFileSync(outsideSecret, 'TOP_SECRET\n', 'utf8');
  writeFileSync(outsideHtml, '<h1>secret</h1>\n', 'utf8');
  writeFileSync(allowedExtraFile, 'ALLOWED_EXTRA\n', 'utf8');

  const projA = (await (await fetch(`${BASE}/api/agy/project/create`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ path: projDirA }),
  })).json()).project;
  const projB = (await (await fetch(`${BASE}/api/agy/project/create`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ path: projDirB }),
  })).json()).project;

  const secFrames = parseSseFrames(await (await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      agent: 'agy',
      agyProjectId: projA.id,
      additionalDirectories: [extraAllowedDir],
      message: `检查产物白名单 [LINK:${outsideSecret}] [LINK:${allowedExtraFile}]`,
    }),
  })).text());
  const secDone = secFrames.find((f) => f.type === 'done');
  assert.ok(secDone?.sessionId);
  const secSid = secDone.sessionId;

  // 交付物附件卡只保留授权目录内的文件，目录外链接已被过滤
  assert.equal(secDone.attachments.length, 1);
  assert.equal(secDone.attachments[0].name, 'allowed.txt');

  // 续聊禁止篡改已有会话的 projectId 或 cwd
  const switchProjRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ agent: 'agy', sessionId: secSid, agyProjectId: projB.id, message: '切项目' }),
  });
  assert.equal(switchProjRes.status, 400);
  await switchProjRes.text();

  const switchCwdRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ agent: 'agy', sessionId: secSid, cwd: projDirB, message: '改目录' }),
  });
  assert.equal(switchCwdRes.status, 400);
  await switchCwdRes.text();

  // /api/agy/artifact 严格拦截越界文件与越界 HTML site=1，仅放行会话授权目录
  const forbidSecret = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(secSid)}&path=${encodeURIComponent(outsideSecret)}&token=${MASTER}`, {
    headers: { connection: 'close' },
  });
  assert.equal(forbidSecret.status, 403);
  await forbidSecret.text();

  const forbidSite = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(secSid)}&path=${encodeURIComponent(outsideHtml)}&site=1&token=${MASTER}`, {
    headers: { connection: 'close' },
  });
  assert.equal(forbidSite.status, 403);
  await forbidSite.text();

  const unknownSidArt = await fetch(`${BASE}/api/agy/artifact?id=unknown-session-id&path=${encodeURIComponent(allowedExtraFile)}&token=${MASTER}`, {
    headers: { connection: 'close' },
  });
  assert.equal(unknownSidArt.status, 404);
  await unknownSidArt.text();

  const allowExtraArt = await fetch(`${BASE}/api/agy/artifact?id=${encodeURIComponent(secSid)}&path=${encodeURIComponent(allowedExtraFile)}&token=${MASTER}`, {
    headers: { connection: 'close' },
  });
  assert.equal(allowExtraArt.status, 200);
  assert.equal(await allowExtraArt.text(), 'ALLOWED_EXTRA\n');

  // 5) logout 后即使目录内存在 installation_id，认证态也立即变为 false
  const fakeAppData = path.join(tmp, 'agy-auth-dir');
  mkdirSync(fakeAppData, { recursive: true });
  writeFileSync(path.join(fakeAppData, 'installation_id'), 'install-only-id', 'utf8');
  process.env.AGY_APP_DATA_DIR = fakeAppData;
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.equal(agentAuthed('agy'), true);
    const logoutRes = await (await fetch(`${BASE}/api/agy/logout`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
    })).json();
    assert.equal(logoutRes.ok, true);
    assert.equal(agentAuthed('agy'), false);
  } finally {
    delete process.env.AGY_APP_DATA_DIR;
    if (oldKey !== undefined) process.env.GEMINI_API_KEY = oldKey;
  }
});

test('工作空间置顶与删除路由：置顶排序、按路径置顶、删除同步清空默认项目', async () => {
  const wsA = path.join(tmp, 'ws-menu-a');
  const wsB = path.join(tmp, 'ws-menu-b');
  mkdirSync(wsA, { recursive: true });
  mkdirSync(wsB, { recursive: true });

  const createA = await (await fetch(`${BASE}/api/agy/project/create`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ path: wsA }),
  })).json();
  assert.equal(createA.ok, true);
  const idA = createA.project.id;

  const createB = await (await fetch(`${BASE}/api/agy/project/create`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ path: wsB }),
  })).json();
  assert.equal(createB.ok, true);
  const idB = createB.project.id;

  // 设 A 为默认项目
  const setDef = await (await fetch(`${BASE}/api/agy/settings`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ defaultProjectId: idA }),
  })).json();
  assert.equal(setDef.ok, true);
  assert.equal(setDef.settings.defaultProjectId, idA);

  // 置顶 A：排到列表第一位
  const pinA = await (await fetch(`${BASE}/api/agy/project/pin`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ id: idA, pinned: true }),
  })).json();
  assert.equal(pinA.ok, true);
  assert.equal(pinA.project.pinned, true);
  assert.equal(pinA.projects[0].id, idA);

  // 取消置顶 A
  const unpinA = await (await fetch(`${BASE}/api/agy/project/pin`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ id: idA, pinned: false }),
  })).json();
  assert.equal(unpinA.ok, true);
  assert.equal(unpinA.project.pinned, false);

  // 删除 A：从列表移除，且默认项目自动清空
  const delA = await (await fetch(`${BASE}/api/agy/project/delete`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ id: idA }),
  })).json();
  assert.equal(delA.ok, true);
  assert.equal(delA.deleted, true);
  assert.equal(delA.projects.some((p) => p.id === idA), false);

  const curSet = await (await fetch(`${BASE}/api/agy/settings`, { headers: ADMIN_HEADERS })).json();
  assert.equal(curSet.settings.defaultProjectId, '');

  // 缺参数回 400
  const badPin = await fetch(`${BASE}/api/agy/project/pin`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({}),
  });
  assert.equal(badPin.status, 400);
  await badPin.text();

  const badDel = await fetch(`${BASE}/api/agy/project/delete`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({}),
  });
  assert.equal(badDel.status, 400);
  await badDel.text();

  // 删除 B 清理现场
  const delB = await (await fetch(`${BASE}/api/agy/project/delete`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ id: idB }),
  })).json();
  assert.equal(delB.ok, true);
});

test('POST /api/agy/sessions/hide 批量隐藏多条会话并支持缺参返回 400', async () => {
  const bad = await fetch(`${BASE}/api/agy/sessions/hide`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({ ids: [] }),
  });
  assert.equal(bad.status, 400);
  await bad.text();

  const res = await (await fetch(`${BASE}/api/agy/sessions/hide`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ ids: ['batch-h1', 'batch-h2', 'batch-h1'] }),
  })).json();
  assert.equal(res.ok, true);
  assert.equal(res.hidden, 2);
  assert.deepEqual(res.ids, ['batch-h1', 'batch-h2']);

  // 恢复清理现场
  const restore = await (await fetch(`${BASE}/api/agy/sessions/restore-all`, {
    method: 'POST', headers: ADMIN_HEADERS, body: JSON.stringify({}),
  })).json();
  assert.equal(restore.ok, true);
});

test('附件：上传目录里的 PDF 按 agy 报的能力作为 resource 送入，上传目录并进新会话的 additionalDirectories', async () => {
  const { foldAgyPath } = await import('./paths.mjs');
  const uploadsDir = path.join(dataRoot, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const pdfPath = path.join(uploadsDir, '1795000000099-paper.pdf');
  writeFileSync(pdfPath, '%PDF-1.4');
  const before = JSON.parse(readFileSync(stateFile, 'utf8')).rpcLog.length;

  const sse = await (await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ agent: 'agy', cwd: projectDir, attachments: [pdfPath], message: '读一下这篇' }),
  })).text();
  assert.ok(parseSseFrames(sse).some((fr) => fr.type === 'done'), sse.slice(-400));

  const log = JSON.parse(readFileSync(stateFile, 'utf8')).rpcLog.slice(before);
  const created = log.find((r) => r.method === 'session/new');
  const dirs = created?.params?._meta?.antigravity?.additionalDirectories || [];
  assert.ok(dirs.some((d) => foldAgyPath(d) === foldAgyPath(realpathSync(uploadsDir))), JSON.stringify(dirs));
  const prompt = log.find((r) => r.method === 'session/prompt').params.prompt;
  const res = prompt.find((b) => b.type === 'resource');
  assert.equal(res?.resource?.mimeType, 'application/pdf');
  assert.match(res.resource.uri, /^file:\/\/.*paper\.pdf$/);
  assert.match(prompt[0].text, /← 已作为文件内容附上/);
});
