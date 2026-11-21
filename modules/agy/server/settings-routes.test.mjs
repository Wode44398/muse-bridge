import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-settings-'));
const dataRoot = path.join(tmp, 'data');
const usersRoot = path.join(tmp, 'users');
const vaultDir = path.join(tmp, 'vault');
const agyHome = path.join(tmp, 'agy-home');
const extraDir = path.join(tmp, 'extra-workspace');
const stateFile = path.join(tmp, 'fake-acp-state.json');
const logFile = path.join(dataRoot, 'agy', 'acp.log');

mkdirSync(path.join(dataRoot, 'agy'), { recursive: true });
mkdirSync(usersRoot, { recursive: true });
mkdirSync(vaultDir, { recursive: true });
mkdirSync(path.join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true });
mkdirSync(extraDir, { recursive: true });

writeFileSync(
  path.join(agyHome, '.gemini', 'antigravity-cli', 'oauth_creds.json'),
  JSON.stringify({ refresh_token: 'fake-token' }),
  'utf8',
);
writeFileSync(
  logFile,
  '2026-11-17T12:00:00Z [INFO] applyAuthResult: email=tester@antigravity.dev, authMethod=consumer\n',
  'utf8',
);

process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = usersRoot;
process.env.VAULT_PATH = vaultDir;
process.env.AGY_HOME_DIR = agyHome;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';
process.env.AGY_BIN = FAKE_AGENT;
process.env.AGY_NO_WARMUP = '1';
process.env.FAKE_ACP_STATE_FILE = stateFile;

const MASTER = 'agy-settings-master-token-9876543210';
writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
  port: 18992,
  token: MASTER,
  vaultPath: vaultDir,
  usersRoot,
  features: { multiUser: true },
}, null, 2));

const { loadModules, registerModuleRoutes } = await import('@bridge/core/modules/registry.mjs');
await loadModules();

const { createRouter } = await import('@bridge/core/runtime/router.mjs');
const { registerAuthRoutes } = await import('@bridge/core/routes/auth.mjs');
const { createAuth } = await import('@bridge/core/auth.mjs');
const { makeIdentify } = await import('@bridge/core/runtime/identity.mjs');
const users = await import('@bridge/core/users.mjs');
const { AcpClient, setAcpClientForTest, shutdownAgy } = await import('./acp/index.mjs');

const testClient = new AcpClient({
  daemonCwd: path.join(dataRoot, 'agy', 'daemon-cwd'),
  logFile,
  env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile, AGY_HOME_DIR: agyHome },
});
setAcpClientForTest(testClient);

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
  // 保留 users/_system 空壳目录，绕开 Windows Node 24 删除被 fs.watch 目录导致句柄不释放的底层缺陷
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

test('非管理员访问设置与 CLI 子命令路由一律返回 403', async () => {
  await users.createUser('member1', 'password-123456', 'pro');
  const userTok = users.createSession(users.accountIdOf('member1'));
  const userHeaders = {
    authorization: `Bearer ${userTok}`,
    'content-type': 'application/json',
    connection: 'close',
  };

  for (const [method, url] of [
    ['GET', '/api/agy/mcp'],
    ['POST', '/api/agy/mcp/add'],
    ['GET', '/api/agy/plugins'],
    ['POST', '/api/agy/update'],
    ['PUT', '/api/agy/settings'],
  ]) {
    const r = await fetch(`${BASE}${url}`, {
      method,
      headers: userHeaders,
      body: method === 'POST' || method === 'PUT' ? '{}' : undefined,
    });
    assert.equal(r.status, 403, `${method} ${url} 应拦截普通成员`);
    await r.text();
  }
});

test('状态、附加目录校验、运行日志预览、MCP 与插件增删启停闭环（隔离 AGY_HOME_DIR）', async () => {
  // 1) 状态接口返回账号邮箱、CLI 版本与日志文件信息
  const statusRes = await (await fetch(`${BASE}/api/agy/status?ensure=1`, { headers: ADMIN_HEADERS })).json();
  assert.equal(statusRes.account.authed, true);
  assert.equal(statusRes.account.email, 'tester@antigravity.dev');
  assert.equal(statusRes.account.authMethod, 'consumer');
  assert.ok(statusRes.cliVersion);
  assert.equal(statusRes.logInfo.exists, true);

  // 2) 运行日志可通过 /api/agy/artifact 安全预览
  const logPreview = await fetch(`${BASE}/api/agy/artifact?path=${encodeURIComponent(logFile)}&token=${MASTER}`, {
    headers: { connection: 'close' },
  });
  assert.equal(logPreview.status, 200);
  const logText = await logPreview.text();
  assert.match(logText, /tester@antigravity\.dev/);

  // 3) 设置保存校验 additionalDirectories，拒绝不存在的路径，持久化合法目录与外观字号
  const badDirRes = await fetch(`${BASE}/api/agy/settings`, {
    method: 'PUT',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ additionalDirectories: [path.join(tmp, 'does-not-exist-999')] }),
  });
  assert.equal(badDirRes.status, 404);
  await badDirRes.text();

  const savedCfg = await (await fetch(`${BASE}/api/agy/settings`, {
    method: 'PUT',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      defaultModel: 'gemini-4-hydrogen',
      additionalDirectories: [extraDir],
      theme: 'daylight',
      fontSize: 'lg',
      particles: false,
    }),
  })).json();
  assert.equal(savedCfg.settings.defaultModel, 'gemini-4-hydrogen');
  assert.deepEqual(savedCfg.settings.additionalDirectories, [path.resolve(extraDir)]);
  assert.equal(savedCfg.settings.theme, 'daylight');
  assert.equal(savedCfg.settings.fontSize, 'lg');
  assert.equal(savedCfg.settings.particles, false);

  // 4) MCP 服务器增、查、停用、启用、删（全程落在隔离 AGY_HOME_DIR）
  const mcp0 = await (await fetch(`${BASE}/api/agy/mcp`, { headers: ADMIN_HEADERS })).json();
  assert.deepEqual(mcp0.items, []);

  const mcpAdded = await (await fetch(`${BASE}/api/agy/mcp/add`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      name: 'sandbox-fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', extraDir],
      env: { SECRET_KEY: 'do-not-expose' },
    }),
  })).json();
  assert.equal(mcpAdded.ok, true);
  assert.equal(mcpAdded.items.length, 1);
  assert.equal(mcpAdded.items[0].name, 'sandbox-fs');
  assert.equal(mcpAdded.items[0].enabled, true);
  assert.deepEqual(mcpAdded.items[0].envKeys, ['SECRET_KEY']);

  const mcpToggled = await (await fetch(`${BASE}/api/agy/mcp/toggle`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ name: 'sandbox-fs', enabled: false }),
  })).json();
  assert.equal(mcpToggled.items[0].enabled, false);

  const mcpRemoved = await (await fetch(`${BASE}/api/agy/mcp/remove`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ name: 'sandbox-fs' }),
  })).json();
  assert.deepEqual(mcpRemoved.items, []);

  // 5) CLI 插件安装、停用、卸载与 CLI 检查更新
  const plgInstalled = await (await fetch(`${BASE}/api/agy/plugins/install`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ target: 'demo-helper@local' }),
  })).json();
  assert.equal(plgInstalled.ok, true);
  assert.equal(plgInstalled.items.length, 1);
  assert.equal(plgInstalled.items[0].name, 'demo-helper');
  assert.equal(plgInstalled.items[0].enabled, true);

  const plgDisabled = await (await fetch(`${BASE}/api/agy/plugins/toggle`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ name: 'demo-helper', enabled: false }),
  })).json();
  assert.equal(plgDisabled.items[0].enabled, false);

  const plgUninstalled = await (await fetch(`${BASE}/api/agy/plugins/uninstall`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ name: 'demo-helper' }),
  })).json();
  assert.deepEqual(plgUninstalled.items, []);

  const updRes = await (await fetch(`${BASE}/api/agy/update`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: '{}',
  })).json();
  assert.equal(updRes.ok, true);
  assert.match(updRes.output, /up to date/i);
});
