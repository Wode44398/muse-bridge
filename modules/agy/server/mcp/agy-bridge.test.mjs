import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.resolve(HERE, '..', 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-mcp-'));
const dataRoot = path.join(tmp, 'data');
const usersRoot = path.join(tmp, 'users');
const vaultDir = path.join(tmp, 'vault');
const mediaDir = path.join(dataRoot, 'media');
const agyHome = path.join(tmp, 'agy-home');
const stateFile = path.join(tmp, 'fake-acp-state.json');
const logFile = path.join(dataRoot, 'agy', 'acp.log');

mkdirSync(path.join(dataRoot, 'agy'), { recursive: true });
mkdirSync(usersRoot, { recursive: true });
mkdirSync(vaultDir, { recursive: true });
mkdirSync(mediaDir, { recursive: true });
mkdirSync(path.join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true });

const MASTER = 'agy-mcp-master-token-9876543210';
writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
  port: 18996,
  token: MASTER,
  vaultPath: vaultDir,
  usersRoot,
  features: { multiUser: true },
}, null, 2));

process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = usersRoot;
process.env.VAULT_PATH = vaultDir;
process.env.AGY_HOME_DIR = agyHome;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';
process.env.AGY_BIN = FAKE_AGENT;
process.env.AGY_NO_WARMUP = '1';
process.env.FAKE_ACP_STATE_FILE = stateFile;

const { loadModules, registerModuleRoutes } = await import('@bridge/core/modules/registry.mjs');
await loadModules();

const { createRouter } = await import('@bridge/core/runtime/router.mjs');
const { registerAuthRoutes } = await import('@bridge/core/routes/auth.mjs');
const { registerChatRoutes } = await import('@bridge/core/routes/chat.mjs');
const { registerAdminRoutes } = await import('@bridge/core/routes/admin.mjs');
const { createAuth } = await import('@bridge/core/auth.mjs');
const { makeIdentify } = await import('@bridge/core/runtime/identity.mjs');
const { ensureHostSecret } = await import('@bridge/core/runtime/host-secret.mjs');
const { handlePhoneResult } = await import('@bridge/core/runtime/phone-bridge.mjs');
const { newId: newMediaId, save: saveVertexMedia } = await import('@bridge/core/vertex-media.mjs');
const { agentMediaDeny, setStudioHostSettings, _resetStudioSettingsForTests } = await import('@bridge/core/runtime/studio-settings.mjs');
const { toolShown } = await import('@bridge/core/runtime/tool-summary.mjs');
const users = await import('@bridge/core/users.mjs');

const { AcpClient, setAcpClientForTest, shutdownAgy } = await import('../acp/index.mjs');
const { collectDeliverableAttachments } = await import('../deliverables.mjs');
const { effectiveBridgeToolCategories, buildAgyBridgeMcpServers } = await import('./config.mjs');
const { buildAgyBridgeToolDefs } = await import('./agy-bridge-tools.mjs');

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
registerChatRoutes(router, { authOk: auth.authOk, identify });
registerAdminRoutes(router, { authOk: auth.authOk, adminCredential: auth.adminCredential, adminGen: auth.gen });
registerModuleRoutes(router, { authOk: auth.authOk, identify });
router.on('POST', '/api/phone-result', (req, res) => handlePhoneResult(req, res, { identify }));

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

function startLiveSseChat(payload) {
  const events = [];
  const waiters = new Set();
  let ended = false;
  let resolveDone;
  const donePromise = new Promise((resolve) => { resolveDone = resolve; });

  const notify = () => {
    for (const w of [...waiters]) {
      if (w.pred(events, ended)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(events.find(w.predItem));
      }
    }
  };

  (async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ agent: 'agy', ...payload }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            events.push(ev);
            notify();
          } catch {}
        }
      }
    }
  })().catch(() => {}).finally(() => {
    ended = true;
    notify();
    resolveDone(events);
  });

  return {
    events,
    done: donePromise,
    waitFor(predItem, timeoutMs = 8_000) {
      const hit = events.find(predItem);
      if (hit) return Promise.resolve(hit);
      if (ended) return Promise.reject(new Error('SSE 已结束但未等到目标事件'));
      return new Promise((resolve, reject) => {
        const entry = {
          predItem,
          pred: (list, isEnded) => list.some(predItem) || isEnded,
          resolve: (val) => (val ? resolve(val) : reject(new Error('SSE 提前结束'))),
          timer: setTimeout(() => {
            waiters.delete(entry);
            reject(new Error('等待 SSE 事件超时'));
          }, timeoutMs),
        };
        entry.timer.unref?.();
        waiters.add(entry);
      });
    },
  };
}

async function stopSession(sessionId) {
  await fetch(`${BASE}/api/agy/stop`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ sessionId }),
  });
}

function cleanupTempTree() {
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
  for (const ctl of activeControllers) {
    try { ctl.abort(); } catch {}
  }
  activeControllers.clear();
  shutdownAgy();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
  cleanupTempTree();
});

test('Bridge MCP 工具清单与门禁：按开关与手机插件状态精确注册，绝不暴露文件/终端/管理类工具，也不注入单会话环境变量', () => {
  const defaultDefs = buildAgyBridgeToolDefs({
    categories: 'media,ui,phone',
    phonePluginOn: false,
    callAgentOp: async () => ({}),
    callInternal: async () => ({}),
  });
  const defaultNames = defaultDefs.map((d) => d.name);
  assert.deepEqual(defaultNames, [
    'media_image', 'media_video', 'media_speech', 'media_music', 'media_result', 'media_models',
    'ui_view', 'ui_open', 'ui_toast',
  ]);

  const withPhoneDefs = buildAgyBridgeToolDefs({
    categories: 'media,ui,phone',
    phonePluginOn: true,
    callAgentOp: async () => ({}),
    callInternal: async () => ({}),
  });
  const withPhoneNames = withPhoneDefs.map((d) => d.name);
  assert.deepEqual(withPhoneNames, [
    'media_image', 'media_video', 'media_speech', 'media_music', 'media_result', 'media_models',
    'ui_view', 'ui_open', 'ui_toast',
    'phone_list', 'phone_read', 'phone_write', 'phone_scan', 'phone_delete',
  ]);

  for (const forbidden of ['read_file', 'write_file', 'edit_file', 'run_command', 'bash', 'keys', 'plugins', 'modules', 'server']) {
    assert.equal(withPhoneNames.some((n) => n.includes(forbidden)), false, `不应暴露工具 ${forbidden}`);
  }

  assert.deepEqual(effectiveBridgeToolCategories({ bridgeTools: { enabled: false, media: true, ui: true } }, { phonePluginOn: true }), []);
  assert.equal(buildAgyBridgeMcpServers({ ctx: { kind: 'user' }, settings: {} }).length, 0);

  const injected = buildAgyBridgeMcpServers({
    ctx: { kind: 'admin' },
    settings: { bridgeTools: { enabled: true, media: true, ui: false, phoneFiles: true } },
    cwd: vaultDir,
    sessionId: 'sess-1',
    phonePluginOn: false,
  });
  assert.equal(injected.length, 1);
  assert.equal(injected[0].name, 'bridge');
  assert.equal(Array.isArray(injected[0].env), true);
  const envNames = injected[0].env.map((e) => e.name);
  assert.equal(envNames.includes('BRIDGE_SESSION_ID'), false);
  assert.equal(envNames.includes('BRIDGE_SESSION_CWD'), false);
  // 开了哪几类不再写进环境变量：环境变量随设置变，agy 就会另起子进程并把工具改名成 mcp_bridge_<哈希>_*
  assert.equal(envNames.includes('BRIDGE_AGY_TOOLS'), false);
  assert.deepEqual(envNames, ['BRIDGE_API_URL', 'BRIDGE_HOST_SECRET']);

  const noHub = buildAgyBridgeMcpServers({
    ctx: { kind: 'admin' },
    settings: { bridgeTools: { enabled: true, media: true, ui: false, phoneFiles: false, bridgeOps: false, browser: false, terminal: false, workspace: false, device: false, visualize: false, sessions: false, phoneControl: false, pr: false, projectMemory: false, pluginTools: false, remoteConnectors: false } },
    phonePluginOn: false,
  });
  assert.deepEqual(noHub[0], injected[0]);
  assert.deepEqual(effectiveBridgeToolCategories(
    { bridgeTools: { enabled: true, media: true, ui: false, phoneFiles: false, bridgeOps: false, browser: false, terminal: false, workspace: false, device: false, visualize: false, sessions: false, phoneControl: false, pr: false, projectMemory: false, pluginTools: false, remoteConnectors: false } },
    { phonePluginOn: false, ctx: { kind: 'admin' } },
  ), ['media']);
});

test('工具中枢：复用 Claude 同款工具、按设置开关分组、对外名与 Claude 的进程内 MCP 一一对应', async () => {
  const { listHubTools, resolveHubTool, exposedToolName, enabledHubGroups } = await import('./hub.mjs');
  const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
  const ctx = contextFor({ kind: 'admin' });
  const names = (await listHubTools(ctx, {})).map((t) => t.name);
  for (const want of ['manual', 'call', 'browser', 'terminal', 'workspace']) {
    assert.ok(names.includes(want), `应暴露 ${want}，实际：${names.join(' ')}`);
  }
  // 与本地工具（media_* / ui_* / phone_*）不撞名
  assert.equal(names.some((n) => /^(media|ui|phone)_/.test(n)), false);
  assert.equal(exposedToolName('device', 'browser'), 'device_browser');
  assert.equal(exposedToolName('visualize', 'show_widget'), 'visualize_show_widget');

  const off = { bridgeTools: { terminal: false, browser: false } };
  const offNames = (await listHubTools(ctx, off)).map((t) => t.name);
  assert.equal(offNames.includes('terminal'), false);
  assert.equal(offNames.includes('browser'), false);
  assert.equal(await resolveHubTool(ctx, off, 'terminal'), null);
  assert.ok(await resolveHubTool(ctx, {}, 'terminal'));
  assert.deepEqual(enabledHubGroups(ctx, { bridgeTools: { enabled: false } }), []);
});

test('Media Studio agyMedia 白名单与 toolShown：默认放行 agy，关闭后拦截，且不误藏 mcp__bridge__*', () => {
  _resetStudioSettingsForTests();
  assert.equal(agentMediaDeny('agy', 'image'), null);

  const saved = setStudioHostSettings({ agyMedia: false });
  assert.equal(saved.ok, true);
  assert.match(String(agentMediaDeny('agy', 'image')), /Antigravity/);

  setStudioHostSettings({ agyMedia: null });
  assert.equal(agentMediaDeny('agy', 'image'), null);

  assert.equal(toolShown('mcp__bridge__media_image'), true);
  assert.equal(toolShown('mcp__antigravity__old_delegate'), false);
});

test('内部回调鉴权、忽略请求体 cwd、重名括号编码与链接越界拦截', async () => {
  const noAuthRes = await fetch(`${BASE}/api/agy/internal/gate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ category: 'media' }),
  });
  assert.equal(noAuthRes.status, 401);

  const secret = ensureHostSecret();
  const proxiedRes = await fetch(`${BASE}/api/agy/internal/gate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
      'x-forwarded-for': '203.0.113.9',
      connection: 'close',
    },
    body: JSON.stringify({ category: 'media' }),
  });
  assert.equal(proxiedRes.status, 403);

  const fakePngId = newMediaId();
  saveVertexMedia(fakePngId, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png', {
    kind: 'image',
    prompt: 'unit test image',
  }, mediaDir);

  const forgedDir = path.join(tmp, 'forged-body-cwd');
  mkdirSync(forgedDir, { recursive: true });

  // 无在跑会话时即使请求体带了 cwd 也必须回 409，绝不按 body.cwd 落盘
  const idleSaveRes = await fetch(`${BASE}/api/agy/internal/save-media`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
      'x-bridge-agent': 'agy',
      connection: 'close',
    },
    body: JSON.stringify({
      mediaId: fakePngId,
      kind: 'image',
      cwd: forgedDir,
    }),
  });
  assert.equal(idleSaveRes.status, 409);
  assert.deepEqual(readdirSync(forgedDir), []);

  // 启动唯一在跑会话（工作目录为 sessionWorkDir）
  const sessionWorkDir = path.join(vaultDir, 'proj-single');
  mkdirSync(sessionWorkDir, { recursive: true });
  const live = startLiveSseChat({ message: '[SLOW] 单会话落盘与安全校验', cwd: sessionWorkDir });
  const sessEv = await live.waitFor((e) => e.type === 'session');

  try {
    // 1) 请求体恶意/陈旧传入 forgedDir 时被忽略，严格落进会话真实的 sessionWorkDir
    const saveRes1 = await fetch(`${BASE}/api/agy/internal/save-media`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        'x-bridge-agent': 'agy',
        connection: 'close',
      },
      body: JSON.stringify({
        mediaId: fakePngId,
        kind: 'image',
        saveTo: 'generated-media/dup.png',
        cwd: forgedDir,
      }),
    });
    assert.equal(saveRes1.status, 200);
    const saveData1 = await saveRes1.json();
    assert.equal(saveData1.savedPath.startsWith(sessionWorkDir), true);
    assert.deepEqual(readdirSync(forgedDir), [], '请求体里的 cwd 必须被彻底忽略');

    // 2) 同名二次保存生成 dup (1).png：括号编码为 %28/%29，且交付物提取器完整识别出附件卡
    const saveRes2 = await fetch(`${BASE}/api/agy/internal/save-media`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        'x-bridge-agent': 'agy',
        connection: 'close',
      },
      body: JSON.stringify({
        mediaId: fakePngId,
        kind: 'image',
        saveTo: 'generated-media/dup.png',
      }),
    });
    assert.equal(saveRes2.status, 200);
    const saveData2 = await saveRes2.json();
    assert.equal(saveData2.fileName, 'dup (1).png');
    const urlPart = saveData2.markdownLink.slice(saveData2.markdownLink.indexOf('](') + 2, -1);
    assert.equal(urlPart.includes('%281%29'), true, `括号应编码为 %28/%29，实际为 ${urlPart}`);
    assert.equal(urlPart.includes('(') || urlPart.includes(')'), false, '链接目标内不应残留裸括号');

    const extracted = collectDeliverableAttachments(`已生成第二张图：${saveData2.markdownLink}`, {
      workDir: sessionWorkDir,
    });
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].name, 'dup (1).png');

    // 3) 目录联接点 / 符号链接指向工作区外部时，mkdir 前后 realpath 比对拦截（403）
    const outsideDir = path.join(tmp, 'outside-secret');
    mkdirSync(outsideDir, { recursive: true });
    const junctionPath = path.join(sessionWorkDir, 'escape-link');
    symlinkSync(outsideDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');

    for (const badSaveTo of ['escape-link/leak.png', 'escape-link/nested/leak.png']) {
      const symRes = await fetch(`${BASE}/api/agy/internal/save-media`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secret}`,
          'x-bridge-agent': 'agy',
          connection: 'close',
        },
        body: JSON.stringify({
          mediaId: fakePngId,
          kind: 'image',
          saveTo: badSaveTo,
        }),
      });
      assert.equal(symRes.status, 403, `链接越界路径 ${badSaveTo} 应被拒绝`);
    }
    assert.deepEqual(readdirSync(outsideDir), [], '外部目录绝不能被创建子目录或写入文件');

    // 4) 关闭媒体开关后内部接口立即拒绝
    await fetch(`${BASE}/api/agy/settings`, {
      method: 'PUT',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ bridgeTools: { media: false } }),
    });
    const blockedRes = await fetch(`${BASE}/api/agy/internal/save-media`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        connection: 'close',
      },
      body: JSON.stringify({ mediaId: fakePngId, kind: 'image' }),
    });
    assert.equal(blockedRes.status, 403);

    await fetch(`${BASE}/api/agy/settings`, {
      method: 'PUT',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ bridgeTools: { enabled: true, media: true, ui: true, phoneFiles: true } }),
    });
  } finally {
    await stopSession(sessEv.sessionId);
    await live.done;
  }
});

test('跨会话池化复用 MCP 归属判定：并发会话 A 与 B 同跑时，B 调生图与手机文件工具均精确落入 B，歧义时返回 409', async () => {
  const secret = ensureHostSecret();
  const dirA = path.join(vaultDir, 'concurrent-proj-A');
  const dirB = path.join(vaultDir, 'concurrent-proj-B');
  const dirC = path.join(vaultDir, 'concurrent-proj-C');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  mkdirSync(dirC, { recursive: true });

  const mediaId = newMediaId();
  saveVertexMedia(mediaId, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png', {
    kind: 'image',
    prompt: 'concurrent B image',
  }, mediaDir);

  // 会话 A 在 dirA 中执行普通终端命令；会话 B 在 dirB 中发起 mcp_bridge_media_image
  const chatA = startLiveSseChat({ message: '[SLOW] [SLOW_TOOL] 会话 A 在跑构建', cwd: dirA });
  const sessA = await chatA.waitFor((e) => e.type === 'session');
  await chatA.waitFor((e) => e.type === 'tool' && e.tool?.name === 'run_command');

  const chatB = startLiveSseChat({ message: '[SLOW] [SLOW_MCP:mcp_bridge_media_image] 会话 B 调生图', cwd: dirB });
  const sessB = await chatB.waitFor((e) => e.type === 'session');
  await chatB.waitFor((e) => e.type === 'tool' && e.tool?.name === 'mcp_bridge_media_image');

  try {
    // 模拟池化复用的 MCP 子进程仍带着会话 A 的陈旧 sessionId 与 cwd 发起回调
    const saveRes = await fetch(`${BASE}/api/agy/internal/save-media`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        'x-bridge-agent': 'agy',
        connection: 'close',
      },
      body: JSON.stringify({
        mediaId,
        kind: 'image',
        toolName: 'media_image',
        sessionId: sessA.sessionId,
        cwd: dirA,
      }),
    });
    assert.equal(saveRes.status, 200);
    const saved = await saveRes.json();
    assert.equal(saved.sessionId, sessB.sessionId, '归属会话必须是发起 mcp_bridge_media_image 的会话 B');
    assert.equal(saved.savedPath.startsWith(dirB), true, `图片必须落在 B 的目录 ${dirB}，实际为 ${saved.savedPath}`);
    assert.deepEqual(readdirSync(dirA), [], '会话 A 的目录不应被误写入任何文件');

    // 两个并发会话都未发起 phone_delete 时调用手机删除接口：无法唯一归属，必须回 409 而非瞎猜
    const unmatchedPhoneRes = await fetch(`${BASE}/api/agy/internal/phone`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        'x-bridge-agent': 'agy',
        connection: 'close',
      },
      body: JSON.stringify({
        op: 'delete',
        args: { path: '@r1/important.txt' },
        sessionId: sessA.sessionId,
      }),
    });
    assert.equal(unmatchedPhoneRes.status, 409);

    // 若第三个并发会话 C 也同时处于 mcp_bridge_media_image 的 in_progress 状态：同名并发歧义返回 409
    const chatC = startLiveSseChat({ message: '[SLOW] [SLOW_MCP:mcp_bridge_media_image] 会话 C 也同时生图', cwd: dirC });
    const sessC = await chatC.waitFor((e) => e.type === 'session');
    await chatC.waitFor((e) => e.type === 'tool' && e.tool?.name === 'mcp_bridge_media_image');
    try {
      const ambigRes = await fetch(`${BASE}/api/agy/internal/save-media`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secret}`,
          'x-bridge-agent': 'agy',
          connection: 'close',
        },
        body: JSON.stringify({
          mediaId,
          kind: 'image',
          toolName: 'media_image',
        }),
      });
      assert.equal(ambigRes.status, 409);
    } finally {
      await stopSession(sessC.sessionId);
      await chatC.done;
    }
  } finally {
    await stopSession(sessB.sessionId);
    await chatB.done;
  }

  // 会话 A 仍在跑时，新开会话 B2 调用 mcp_bridge_phone_write：手机命令必须只推到 B2 的流，不推到 A
  const chatB2 = startLiveSseChat({ message: '[SLOW] [SLOW_MCP:mcp_bridge_phone_write] 会话 B2 写手机文件', cwd: dirB });
  const sessB2 = await chatB2.waitFor((e) => e.type === 'session');
  await chatB2.waitFor((e) => e.type === 'tool' && e.tool?.name === 'mcp_bridge_phone_write');

  try {
    const phoneCallPromise = fetch(`${BASE}/api/agy/internal/phone`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        'x-bridge-agent': 'agy',
        connection: 'close',
      },
      body: JSON.stringify({
        op: 'write',
        args: { path: '@r1/from-b2.txt', content: 'hello B2' },
        sessionId: sessA.sessionId,
        timeoutMs: 8_000,
      }),
    });

    const phoneCmdOnB2 = await chatB2.waitFor((e) => e.type === 'phone_cmd');
    assert.equal(phoneCmdOnB2.op, 'write');
    assert.equal(phoneCmdOnB2.args?.path, '@r1/from-b2.txt');
    assert.equal(chatA.events.some((e) => e.type === 'phone_cmd'), false, '会话 A 的流绝不能收到 B2 的手机文件命令');

    const ackRes = await fetch(`${BASE}/api/phone-result`, {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ cmdId: phoneCmdOnB2.cmdId, ok: true, result: { written: true } }),
    });
    assert.equal(ackRes.status, 200);

    const phoneRes = await phoneCallPromise;
    assert.equal(phoneRes.status, 200);
    const phoneData = await phoneRes.json();
    assert.equal(phoneData.ok, true);
    assert.equal(phoneData.written, true);
  } finally {
    await stopSession(sessB2.sessionId);
    await stopSession(sessA.sessionId);
    await Promise.all([chatB2.done, chatA.done]);
  }
});

test('设置变更触发静默重启的无竞态保证：准备中与在跑轮次绝不被误杀，顺延至空闲后重启，且重启期间新轮次平滑等待完成', async () => {
  const workDir = path.join(vaultDir, 'restart-race-proj');
  mkdirSync(workDir, { recursive: true });

  await testClient.ensureStarted();
  const pidBefore = testClient.status().pid;
  assert.equal(typeof pidBefore, 'number');

  // 1) 模拟新轮刚进入 session/new 尚未落入 turns 的竞态窗口（preparingTurns === 1, activeTurns.length === 0）
  const curDisk = JSON.parse(readFileSync(stateFile, 'utf8'));
  curDisk.newSessionDelayOnceMs = 180;
  writeFileSync(stateFile, JSON.stringify(curDisk, null, 2));

  const racingChat = startLiveSseChat({ message: '[SLOW] 准备阶段并发改设置', cwd: workDir });
  await new Promise((r) => setTimeout(r, 45));

  // 此刻 session/new 仍在途，activeTurns 为空，修改 bridgeTools 触发 requestIdleRestart
  const putRes1 = await fetch(`${BASE}/api/agy/settings`, {
    method: 'PUT',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ bridgeTools: { ui: false } }),
  });
  assert.equal(putRes1.status, 200);
  assert.equal(testClient.status().pid, pidBefore, '准备中的新轮次不能被静默重启误杀');
  assert.equal(testClient.status().pendingIdleRestart, true);

  const racingSess = await racingChat.waitFor((e) => e.type === 'session');
  assert.equal(Boolean(racingSess.sessionId), true);
  assert.equal(testClient.status().pid, pidBefore, '对话运行期间保持原进程不中断');

  // 结束该轮后，挂起的空闲重启应自动触发并换上新 PID
  await stopSession(racingSess.sessionId);
  await racingChat.done;

  let pidAfterIdle = testClient.status().pid;
  for (let i = 0; i < 40 && (pidAfterIdle === pidBefore || !testClient.status().running); i++) {
    await new Promise((r) => setTimeout(r, 50));
    pidAfterIdle = testClient.status().pid;
  }
  assert.notEqual(pidAfterIdle, pidBefore, '最后一轮结束后应自动完成顺延的静默重启');
  assert.equal(testClient.status().pendingIdleRestart, false);

  // 2) 空闲态下改设置当场启动重启的同时立刻并发进入新对话：新对话等待重启完成后正常成功，不报错
  const settingsFlipPromise = fetch(`${BASE}/api/agy/settings`, {
    method: 'PUT',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ bridgeTools: { ui: true } }),
  });
  const immediateChatPromise = fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      agent: 'agy',
      message: '空闲重启在途并发进入的新对话',
      cwd: workDir,
    }),
  });

  const [flipRes, immChatRes] = await Promise.all([settingsFlipPromise, immediateChatPromise]);
  assert.equal(flipRes.status, 200);
  assert.equal(immChatRes.status, 200);
  const immSseText = await immChatRes.text();
  assert.match(immSseText, /"type":"done"/, '重启期间进入的新对话必须成功完成而非失败');
  assert.doesNotMatch(immSseText, /"type":"error"/);
});

test('ACP 会话级 mcpServers 注入与控制台管理接口：不写全局 mcp_config.json，总开关关闭后不再注入，kill 接口可安全终止', async () => {
  const globalMcpCfg = path.join(agyHome, '.gemini', 'config', 'mcp_config.json');
  assert.equal(existsSync(globalMcpCfg), false);

  const chatRes = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      agent: 'agy',
      message: '测试 MCP 注入',
      cwd: vaultDir,
    }),
  });
  assert.equal(chatRes.status, 200);
  await chatRes.text();

  assert.equal(existsSync(globalMcpCfg), false, '绝不改写用户全局 mcp_config.json');
  const disk = JSON.parse(readFileSync(stateFile, 'utf8'));
  const sessionNewCalls = (disk.rpcLog || []).filter((x) => x.method === 'session/new');
  assert.equal(sessionNewCalls.length >= 1, true);
  const lastNew = sessionNewCalls[sessionNewCalls.length - 1];
  assert.equal(Array.isArray(lastNew.params.mcpServers), true);
  assert.equal(lastNew.params.mcpServers.length, 1);
  assert.equal(lastNew.params.mcpServers[0].name, 'bridge');

  // 控制台 overview 与强制杀进程
  const ovRes = await fetch(`${BASE}/api/admin/overview`, { headers: ADMIN_HEADERS });
  assert.equal(ovRes.status, 200);
  const ov = await ovRes.json();
  assert.equal(ov.agy?.running, true);

  const killRes = await fetch(`${BASE}/api/admin/agy/kill`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: '{}',
  });
  assert.equal(killRes.status, 200);
  const killData = await killRes.json();
  assert.equal(killData.ok, true);
  assert.equal(killData.agy.running, false);

  // 关闭 Bridge 工具总开关后新会话不再注入 mcpServers
  await fetch(`${BASE}/api/agy/settings`, {
    method: 'PUT',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ bridgeTools: { enabled: false } }),
  });

  const chatRes2 = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      agent: 'agy',
      message: '关闭后再测一次',
      cwd: vaultDir,
    }),
  });
  assert.equal(chatRes2.status, 200);
  await chatRes2.text();

  const disk2 = JSON.parse(readFileSync(stateFile, 'utf8'));
  const sessionNewCalls2 = (disk2.rpcLog || []).filter((x) => x.method === 'session/new');
  const lastNew2 = sessionNewCalls2[sessionNewCalls2.length - 1];
  assert.deepEqual(lastNew2.params.mcpServers, []);
});

test('bridge 自家工具的审批口径：与 Claude 的 ownMcp 一致，终端 / 改动类操作 / 动手操作电脑 / 扩展连接器照常审批', async () => {
  const { bridgeToolAutoAllow, bridgeToolOf } = await import('./approval.mjs');
  // agy 的审批请求：name 是工具名，title 形如「Run mcp_bridge_x」
  const tc = (tool, args = {}) => ({ name: `mcp_bridge_${tool}`, title: `Run mcp_bridge_${tool}`, args });
  assert.equal(bridgeToolOf(tc('browser')), 'browser');
  assert.equal(bridgeToolOf({ name: 'mcp_pingbox_ping', title: 'Run mcp_pingbox_ping' }), '');
  for (const t of ['browser', 'workspace', 'manual', 'visualize_show_widget', 'media_image', 'media_models', 'ui_view', 'phone_list', 'device_inspect']) {
    assert.equal(bridgeToolAutoAllow(tc(t)), true, t);
  }
  for (const t of ['terminal', 'device_act', 'device_shell', 'phone_delete', 'phone_write']) {
    assert.equal(bridgeToolAutoAllow(tc(t)), false, t);
  }
  assert.equal(bridgeToolAutoAllow(tc('call', { op: 'routines.list' })), true);
  assert.equal(bridgeToolAutoAllow(tc('call', { op: 'routines.delete' })), false);
  assert.equal(bridgeToolAutoAllow(tc('call', { op: 'no.such.op' })), false);
  assert.equal(bridgeToolAutoAllow({ name: 'mcp_pingbox_ping', title: 'Run mcp_pingbox_ping', args: {} }), false);
});

test('审批口径只认工具名：命令原文、标题里带 mcp_bridge_* 字样的一律不放行（11-19 实测的绕过）', async () => {
  const { bridgeToolAutoAllow, bridgeToolOf } = await import('./approval.mjs');
  const { normalizePermissionRequest } = await import('../events.mjs');
  // 真 agy 的 run_command 审批原文：title 就是命令
  const real = normalizePermissionRequest('7', {
    sessionId: 's1',
    toolCall: {
      sessionUpdate: 'tool_call', toolCallId: 'call_1', name: 'run_command', kind: 'execute', status: 'pending',
      title: 'echo audit-marker > bypass-proof.txt; echo mcp_bridge_browser',
      rawInput: { CommandLine: 'echo audit-marker > bypass-proof.txt; echo mcp_bridge_browser', WaitMsBeforeAsync: 5000 },
    },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
  });
  assert.equal(bridgeToolOf(real.toolCall), '');
  assert.equal(bridgeToolAutoAllow(real.toolCall), false);
  for (const toolCall of [
    { name: 'run_command', title: 'Remove-Item -Recurse C:/x  # mcp_bridge_manual', args: {} },
    { name: '', title: 'Run mcp_bridge_browser', args: {} },                       // 没有工具名：不凭标题认
    { name: 'mcp_x_mcp_bridge_browser', title: 'Run mcp_x_mcp_bridge_browser', args: {} },
    { name: 'mcp_mybridge_browser', title: 'Run mcp_mybridge_browser', args: {} },
    { name: 'mcp_bridge_d1e43fdb_browser', title: 'Run mcp_bridge_d1e43fdb_browser', args: {} },   // 哈希名 = 别的配置起的那一份
    { name: 'mcp_bridge_browser; rm -rf', title: '', args: {} },
  ]) {
    assert.equal(bridgeToolAutoAllow(toolCall), false, JSON.stringify(toolCall.name || toolCall.title));
  }
});

test('工具名改口：照 Claude 写的 mcp__* 名字给 agy 之前换成它这边的名字', async () => {
  const { agyWording } = await import('./hub.mjs');
  assert.equal(agyWording('media.image 不从这里调：操作电脑用 mcp__device__*，生成媒体用 mcp__media__*'),
    'media.image 不从这里调：操作电脑用 device_*，生成媒体用 media_image / media_video / media_speech / media_music');
  assert.equal(agyWording('另开并行会话优先用 mcp__sessions__start_session；操作电脑用 mcp__device__*，生成媒体用 mcp__media__*。'),
    '操作电脑用 device_*，生成媒体用 media_image / media_video / media_speech / media_music。');
  assert.equal(agyWording('用 mcp__media__generate_image 生成'), '用 media_image 生成');
  assert.equal(agyWording('先 mcp__bridge__manual 再 mcp__bridge__call，或 mcp__terminal__terminal / mcp__visualize__show_widget'), '先 manual 再 call，或 terminal / visualize_show_widget');
  assert.ok(!/mcp__/.test(agyWording('找不到电脑「x」（手机不能连到会话，操作手机用 mcp__phoneControl__*）')));
  assert.equal(agyWording('没有要改的'), '没有要改的');
  // 真清单里不该再有 Claude 的工具名
  const { listHubTools } = await import('./hub.mjs');
  const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
  for (const t of await listHubTools(contextFor({ kind: 'admin' }), {})) {
    assert.ok(!/mcp__/.test(t.description), `${t.name} 的说明里还有 mcp__：${(/.{0,30}mcp__.{0,40}/.exec(t.description) || [''])[0]}`);
  }
});

test('工具返回内容：按工具名与参数对上本轮的工具记录，补进事件流并落盘，历史里套回去', async () => {
  const { recordToolOutput, readToolOutputs, applyToolOutputs, toolResultText, matchToolCallId } = await import('../tool-outputs.mjs');
  const agyDir = mkdtempSync(path.join(os.tmpdir(), 'agy-toolout-'));
  const gen = {
    sessionId: 'sess-out-1', subscribers: new Set(), done: false,
    events: [
      { type: 'tool', tool: { toolCallId: 'c1', name: 'mcp_bridge_call', args: { op: 'routines.list', toolSummary: 'List' }, status: 'in_progress' } },
      { type: 'tool', tool: { toolCallId: 'c2', name: 'mcp_bridge_call', args: { op: 'media.image', args: { prompt: 'x' }, toolSummary: 'Img' }, status: 'in_progress' } },
      { type: 'tool', tool: { toolCallId: 'c3', name: 'run_command', args: { CommandLine: 'echo mcp_bridge_call' }, status: 'in_progress' } },
    ],
  };
  // 参数对得上的优先（agy 自己加的 toolSummary 不算、键序无关）
  assert.equal(matchToolCallId(gen, 'call', { args: { prompt: 'x' }, op: 'media.image' }), 'c2');
  assert.equal(matchToolCallId(gen, 'browser', {}), '');
  const before = gen.events.length;
  assert.equal(recordToolOutput({ agyDir }, gen, { name: 'call', args: { op: 'media.image', args: { prompt: 'x' } }, text: 'media.image 不从这里调', isError: true }), 'c2');
  assert.equal(recordToolOutput({ agyDir }, gen, { name: 'call', args: { op: 'routines.list' }, text: '{"routines":[]}' }), 'c1');
  // 同一条不重复认领；跑命令那条（名字不是 bridge 工具）永远对不上
  assert.equal(recordToolOutput({ agyDir }, gen, { name: 'call', args: { op: 'routines.list' }, text: 'again' }), '');
  const added = gen.events.slice(before);
  assert.deepEqual(added.map((e) => [e.type, e.tool.toolCallId, e.tool.output]), [
    ['tool-update', 'c2', 'media.image 不从这里调'], ['tool-update', 'c1', '{"routines":[]}'],
  ]);
  const saved = readToolOutputs(agyDir, 'sess-out-1');
  assert.equal(saved.c2.text, 'media.image 不从这里调');
  assert.equal(saved.c2.isError, true);
  assert.equal(saved.c1.text, '{"routines":[]}');
  const msgs = [{ role: 'assistant', tools: [{ toolCallId: 'c1' }, { toolCallId: 'c9', output: 'own' }], blocks: [{ type: 'tool', tool: { toolCallId: 'c2' } }] }];
  applyToolOutputs(msgs, saved);
  assert.equal(msgs[0].tools[0].output, '{"routines":[]}');
  assert.equal(msgs[0].tools[1].output, 'own');
  assert.equal(msgs[0].blocks[0].tool.output, 'media.image 不从这里调');
  assert.equal(toolResultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'xx', mimeType: 'image/png' }] }), ['a', '[图片]'].join(String.fromCharCode(10)));
  // 会话 id 不合法不落盘（防路径穿越）
  assert.deepEqual(readToolOutputs(agyDir, '../x'), {});
  rmSync(agyDir, { recursive: true, force: true });
});

test('工具清单变了自动换进程：指纹不同就请求空闲重启，在跑的轮不被打断；环境变量不随设置变', async () => {
  const { buildAgySessionTooling } = await import('./config.mjs');
  const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
  const ctx = contextFor({ kind: 'admin' });
  const a = buildAgySessionTooling({ ctx, settings: { bridgeTools: { enabled: true } } });
  const b = buildAgySessionTooling({ ctx, settings: { bridgeTools: { enabled: true, ui: false, browser: false } } });
  assert.notEqual(a.toolingSig, b.toolingSig);
  assert.equal(buildAgySessionTooling({ ctx, settings: { bridgeTools: { enabled: false } } }).toolingSig, 'off');
  // 同名服务的配置必须逐字节一致（否则 agy 另起子进程并把工具改名成 mcp_bridge_<哈希>_*）
  assert.deepEqual(a.mcpServers.find((s) => s.name === 'bridge'), b.mcpServers.find((s) => s.name === 'bridge'));

  const c = new AcpClient({ daemonCwd: path.join(dataRoot, 'agy', 'daemon-cwd-sig') });
  const calls = [];
  c.requestIdleRestart = (opts) => { calls.push(opts); return Promise.resolve({ restarted: true }); };
  c.proc = { fake: true };
  c.noteTooling('off');
  c.noteTooling('');
  assert.equal(c.toolingSig, null);
  c.noteTooling(a.toolingSig);            // 这个进程第一次挂 bridge 工具：只记不重启
  assert.equal(calls.length, 0);
  c.noteTooling(a.toolingSig);
  assert.equal(calls.length, 0);
  c.noteTooling(b.toolingSig);            // 清单变了：请求空闲重启（不重新挂载别的会话）
  assert.deepEqual(calls, [{ remountIdle: false }]);
  assert.equal(c.toolingSig, b.toolingSig);
  c.noteTooling(b.toolingSig);            // 重启还在等空闲时再来一轮：不重复请求
  assert.equal(calls.length, 1);
  c.proc = null;                          // 进程没了（崩溃 / 手动重启）：下次挂载自然取到新清单
  c.noteTooling(a.toolingSig);
  assert.equal(calls.length, 1);
  assert.equal(c.toolingSig, a.toolingSig);
});

test('媒体工具进阶参数与分段等待：图片 / 语音常用参数走老路；视频 / 音乐与进阶调用走 Studio 任务，没跑完交出任务 id、media_result 接着取', async () => {
  const ops = [];
  const internal = [];
  const jobs = new Map();   // id -> { polls 之后变 done, job }
  const mkJob = (id, kind, pollsUntilDone, result) => { jobs.set(id, { left: pollsUntilDone, job: { id, kind, state: 'running', progress: 0.4, elapsed: 12, model: 'M', result: [] }, result }); return jobs.get(id).job; };
  let nextJob = 1;
  let nextResults = [{ id: 'cccccccc-0000-0000-0000-000000000001', kind: 'image' }, { id: 'cccccccc-0000-0000-0000-000000000002', kind: 'image' }];
  let pollsUntilDone = 1;
  const callAgentOp = async (name, args) => {
    ops.push([name, args]);
    if (name === 'media.image') return { id: 'aaaaaaaa-0000-0000-0000-000000000001', kind: 'image' };
    if (name === 'studio.asset') return { asset: { id: args.id, thread: 'bbbbbbbb-0000-0000-0000-00000000000b' } };
    if (name === 'studio.generate') { assert.equal(args.wait, false, '不许在一次调用里死等'); return { job: { ...mkJob('job' + nextJob++, args.kind, pollsUntilDone, nextResults) } }; }
    if (name === 'studio.job') {
      const rec = jobs.get(args.id);
      if (!rec) throw new Error('任务记录不见了');
      if (rec.left-- <= 0) Object.assign(rec.job, { state: 'done', result: rec.result });
      return { job: { ...rec.job } };
    }
    if (name === 'studio.job_cancel') { jobs.get(args.id).job.state = 'canceled'; return { job: jobs.get(args.id).job }; }
    if (name === 'studio.models') return { kinds: { image: { default: 'p/x', models: [{ key: 'p/x' }] } } };
    throw new Error('unexpected op ' + name);
  };
  const callInternal = async (pathname, body) => {
    internal.push([pathname, body]);
    if (pathname.endsWith('/media-inputs')) return { inputs: body.inputs.map((x) => (x.asset ? { role: x.role, asset: x.asset } : { role: x.role, upload: 'U:' + x.path })) };
    if (pathname.endsWith('/save-media')) return { savedPath: 'W:/demo/' + body.mediaId + '.png', fileName: body.mediaId + '.png', markdownLink: `[${body.mediaId}.png](file:///W:/demo/${body.mediaId}.png)` };
    return { ok: true };
  };
  const defs = buildAgyBridgeToolDefs({ categories: 'media', phonePluginOn: false, callAgentOp, callInternal, pollMs: 5, waitBudgetMs: 60 });
  const tool = (n) => defs.find((d) => d.name === n);
  const reset = () => { ops.length = 0; internal.length = 0; };

  // 老路：参数原样给 media.image，回执带作品 id（接着改用）
  const simple = await tool('media_image').handler({ prompt: '一只猫', aspectRatio: '1:1' });
  assert.deepEqual(ops, [['media.image', { prompt: '一只猫', aspectRatio: '1:1' }]]);
  assert.match(simple.content[0].text, /作品 id：aaaaaaaa-0000-0000-0000-000000000001/);
  assert.equal(internal.filter(([p]) => p.endsWith('/media-inputs')).length, 0);

  // 进阶：常用参数并进 params（同名以 params 为准）、image 当改图素材、续改链接回原作品的 thread
  reset();
  const adv = await tool('media_image').handler({
    prompt: '换成夜景', model: 'p/x', aspectRatio: '16:9', imageSize: '2K', image: 'C:/w/a.png',
    params: { count: 2, aspectRatio: '4:3' }, negative: '文字', inputs: [{ role: 'ref', asset: 'dddddddd-0000-0000-0000-00000000000d' }],
    continueFrom: 'eeeeeeee-0000-0000-0000-00000000000e', saveTo: 'out/',
  });
  assert.deepEqual(internal.find(([p]) => p.endsWith('/media-inputs'))[1], {
    inputs: [{ role: 'edit', path: 'C:/w/a.png' }, { role: 'ref', asset: 'dddddddd-0000-0000-0000-00000000000d' }], toolName: 'media_image',
  });
  assert.deepEqual(ops.slice(0, 2).map(([n]) => n), ['studio.asset', 'studio.generate']);
  assert.deepEqual(ops[1][1], {
    kind: 'image', model: 'p/x', prompt: '换成夜景', negative: '文字',
    params: { aspectRatio: '4:3', imageSize: '2K', count: 2 },
    inputs: [{ role: 'edit', upload: 'U:C:/w/a.png' }, { role: 'ref', asset: 'dddddddd-0000-0000-0000-00000000000d' }],
    thread: 'bbbbbbbb-0000-0000-0000-00000000000b', parent: 'eeeeeeee-0000-0000-0000-00000000000e', wait: false,
  });
  const saves = internal.filter(([p]) => p.endsWith('/save-media')).map(([, b]) => [b.mediaId, b.saveTo, b.toolName]);
  assert.deepEqual(saves, [
    ['cccccccc-0000-0000-0000-000000000001', 'out/', 'media_image'], ['cccccccc-0000-0000-0000-000000000002', 'out/', 'media_image'],
  ]);
  assert.match(adv.content[0].text, /已生成 2 件/);
  assert.match(adv.content[0].text, /cccccccc-0000-0000-0000-000000000002\.png\)/);
  assert.match(adv.content[0].text, /continueFrom 传这个 id/);

  // 视频：不带进阶参数也走任务；image = 首帧，negativePrompt 当负面词
  reset();
  nextResults = [{ id: 'ffffffff-0000-0000-0000-000000000001', kind: 'video' }];
  const vid = await tool('media_video').handler({ prompt: '海浪', image: 'C:/w/f.png', negativePrompt: '模糊', durationSeconds: 6 });
  assert.deepEqual(internal.find(([p]) => p.endsWith('/media-inputs'))[1].inputs, [{ role: 'first', path: 'C:/w/f.png' }]);
  assert.deepEqual(ops[0], ['studio.generate', { kind: 'video', prompt: '海浪', negative: '模糊', params: { durationSeconds: 6 }, inputs: [{ role: 'first', upload: 'U:C:/w/f.png' }], wait: false }]);
  assert.match(vid.content[0].text, /视频已生成并保存/);
  assert.ok(!ops.some(([n]) => n === 'media.video'), '视频不再走会一直等到底的老接口');

  // 等不到：交出任务 id，不报失败、也不重发；media_result 接着取到结果并存盘
  reset();
  pollsUntilDone = 1000;
  const late = await tool('media_music').handler({ prompt: '钢琴' });
  const jobId = ops[0][0] === 'studio.generate' ? [...jobs.keys()].pop() : '';
  assert.match(late.content[0].text, new RegExp(`还在生成.*任务 id：${jobId}`));
  assert.match(late.content[0].text, /media_result/);
  assert.equal(late.isError, undefined);
  assert.equal(internal.filter(([p]) => p.endsWith('/save-media')).length, 0);
  jobs.get(jobId).left = 0;
  jobs.get(jobId).result = [{ id: '99999999-0000-0000-0000-000000000001', kind: 'music' }];
  reset();
  const got = await tool('media_result').handler({ job: jobId, saveTo: 'music/' });
  assert.match(got.content[0].text, /音乐已生成并保存/);
  assert.deepEqual(internal.filter(([p]) => p.endsWith('/save-media')).map(([, b]) => [b.mediaId, b.saveTo, b.toolName]), [['99999999-0000-0000-0000-000000000001', 'music/', 'media_result']]);
  assert.ok(!ops.some(([n]) => n === 'studio.generate'), 'media_result 不会重新生成');

  // 这一轮被停止：任务跟着取消
  reset();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 15);
  const stopped = await tool('media_video').handler({ prompt: '云' }, { signal: ac.signal });
  assert.equal(stopped.isError, true);
  assert.ok(ops.some(([n]) => n === 'studio.job_cancel'));

  // 任务失败照实报
  reset();
  const failing = buildAgyBridgeToolDefs({
    categories: 'media', phonePluginOn: false, callInternal, pollMs: 5, waitBudgetMs: 60,
    callAgentOp: async (name) => (name === 'studio.generate' ? { job: { id: 'jx', kind: 'video', state: 'error', error: '上游拒绝：内容策略' } } : {}),
  }).find((d) => d.name === 'media_video');
  const bad = await failing.handler({ prompt: 'x' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /上游拒绝：内容策略/);

  // 查模型：只读，走 studio.models
  reset();
  const models = await tool('media_models').handler({ kind: 'image' });
  assert.deepEqual(ops, [['studio.models', { kind: 'image' }]]);
  assert.match(models.content[0].text, /"default": "p\/x"/);
});

test('单次调用时长上限：终端等待与电脑命令夹到 150 秒以内，说明里写明', async () => {
  const { fitAgyBudget, listHubTools, AGY_CALL_BUDGET_SEC } = await import('./hub.mjs');
  assert.equal(AGY_CALL_BUDGET_SEC, 150);
  assert.deepEqual(fitAgyBudget('terminal', 'terminal', { action: 'wait', waitSec: 600, quietSec: 0 }), { action: 'wait', waitSec: 150, quietSec: 0 });
  assert.deepEqual(fitAgyBudget('terminal', 'terminal', { action: 'run', command: 'x', waitSec: 300 }), { action: 'run', command: 'x', waitSec: 150 });
  assert.deepEqual(fitAgyBudget('terminal', 'terminal', { action: 'wait', waitSec: 60 }), { action: 'wait', waitSec: 60 });
  assert.deepEqual(fitAgyBudget('device', 'shell', { command: 'x', timeoutMs: 300000 }), { command: 'x', timeoutMs: 150000 });
  assert.deepEqual(fitAgyBudget('device', 'act', { timeoutMs: 300000 }), { timeoutMs: 300000 });
  assert.deepEqual(fitAgyBudget('browser', 'browser', null), {});
  const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
  const term = (await listHubTools(contextFor({ kind: 'admin' }), {})).find((t) => t.name === 'terminal');
  if (term) assert.match(term.description, /capped at 150/);
});

test('素材归一化路由：媒体库作品 → asset、上传目录 → upload、会话目录里的拷进上传目录、别处的拒绝', async () => {
  const secret = ensureHostSecret();
  const post = (body) => fetch(`${BASE}/api/agy/internal/media-inputs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'x-bridge-agent': 'agy', connection: 'close' },
    body: JSON.stringify(body),
  });
  // 前面的用例可能把总开关关了：先打开
  await fetch(`${BASE}/api/agy/settings`, {
    method: 'PUT',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ bridgeTools: { enabled: true, media: true } }),
  });
  // 没有在跑的会话：不知道按哪个会话目录算，拒
  assert.equal((await post({ inputs: [{ role: 'ref', asset: 'x' }] })).status, 409);

  const workDir = path.join(vaultDir, 'proj-inputs');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const outside = path.join(tmp, 'outside-inputs');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.png'), Buffer.from([1, 2, 3]));
  const uploadsDir = path.join(dataRoot, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(path.join(uploadsDir, 'up.png'), Buffer.from([4, 5, 6]));
  const assetId = newMediaId();
  saveVertexMedia(assetId, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png', { kind: 'image', prompt: 'inputs test' }, mediaDir);

  const live = startLiveSseChat({ message: '[SLOW] 素材归一化', cwd: workDir });
  const sessEv = await live.waitFor((e) => e.type === 'session');
  try {
    const ok = await post({
      toolName: 'media_image',
      inputs: [
        { role: 'edit', path: 'pic.png' },                                   // 相对会话工作目录
        { role: 'ref', path: path.join(workDir, 'pic.png') },                // 绝对路径
        { role: 'ref', path: path.join(uploadsDir, 'up.png') },
        { role: 'ref', path: path.join(mediaDir, assetId + '.png') },
        { role: 'ref', asset: assetId },
      ],
    });
    assert.equal(ok.status, 200);
    const { inputs } = await ok.json();
    assert.equal(inputs.length, 5);
    for (const x of inputs.slice(0, 2)) {
      assert.ok(x.upload && path.dirname(x.upload).toLowerCase().endsWith(path.join('uploads', 'agy-inputs').toLowerCase()), JSON.stringify(x));
      assert.equal(existsSync(x.upload), true);
      assert.match(path.basename(x.upload), /-pic\.png$/);
    }
    assert.equal(inputs[0].role, 'edit');
    assert.equal(path.basename(inputs[2].upload), 'up.png');
    assert.deepEqual(inputs[3], { role: 'ref', asset: assetId });
    assert.deepEqual(inputs[4], { role: 'ref', asset: assetId });

    const denied = await post({ toolName: 'media_image', inputs: [{ role: 'ref', path: path.join(outside, 'secret.png') }] });
    assert.equal(denied.status, 400);
    assert.match((await denied.json()).error, /不在当前会话的工作目录/);
    const missing = await post({ toolName: 'media_image', inputs: [{ role: 'ref', path: 'no-such.png' }] });
    assert.equal(missing.status, 400);
    assert.equal((await post({ toolName: 'media_image', inputs: [{ path: 'pic.png' }] })).status, 400);
  } finally {
    await stopSession(sessEv.sessionId);
    await live.done;
  }
});

test('工具清单体量预算：大工具给精简定义、全量压进 agy 的预算、tool_docs 取回完整说明（11-20 实测 agy 超预算会整个丢掉最大的工具）', async () => {
  const { listHubTools, resolveHubTool, callHubTool, agyTokenEstimate, compactAgyTool } = await import('./hub.mjs');
  const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
  const ctx = contextFor({ kind: 'admin' });
  const tools = await listHubTools(ctx, {});
  const cost = (t) => agyTokenEstimate(t.description) + agyTokenEstimate(t.inputSchema);
  const total = tools.reduce((a, t) => a + cost(t), 0);
  // agy 总预算约 1.4 万 token，还要留给子进程本地工具（约 3700）与用户自己装的 MCP
  assert.ok(total < 8000, `中枢工具总量 ${total} 太大`);
  const browser = tools.find((t) => t.name === 'browser');
  assert.ok(browser && browser.description.includes('tool_docs'), '侧边浏览器应在清单里、且是精简版');
  assert.ok(browser.inputSchema.properties.action, '精简后参数表仍保留结构');
  assert.ok(tools.find((t) => t.name === 'tool_docs'));
  // 小工具原样不动
  const small = { name: 'x', description: 'short', inputSchema: { type: 'object', properties: { a: { type: 'string', description: '一段比较长的参数说明文字，超过三十个字也应原样保留因为整体很小' } } } };
  assert.deepEqual(compactAgyTool(small), small);
  const target = await resolveHubTool(ctx, {}, 'tool_docs');
  assert.ok(target);
  const docs = await callHubTool(ctx, null, target, { name: 'browser' });
  assert.ok(/navigate/.test(docs.content[0].text) && /## 参数/.test(docs.content[0].text));
  const miss = await callHubTool(ctx, null, target, { name: 'nope' });
  assert.equal(miss.isError, true);
  const { bridgeToolAutoAllow } = await import('./approval.mjs');
  assert.equal(bridgeToolAutoAllow({ name: 'mcp_bridge_tool_docs' }), true);
});

test('11-20 接入复查：改口补漏、不可用原因、系统提示按类别现拼、批内动作保留、bridge 操作带 agy 身份', async () => {
  const hub = await import('./hub.mjs');
  const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
  const ctx = contextFor({ kind: 'admin' });

  // 改口：带反引号 / 句号收尾的写法、通配写法、不带 mcp__ 前缀的 Claude 专属说法
  assert.equal(hub.agyWording('会话里有专用的 `mcp__device__*` 工具；另开并行会话优先用 `mcp__sessions__start_session`。'), '会话里有专用的 `device_*` 工具。');
  assert.equal(hub.agyWording('还是 `mcp__browser__*`'), '还是 `browser`');
  assert.ok(!/AskUserQuestion/.test(hub.agyWording('对外生效的动作先用 AskUserQuestion 确认。')));
  assert.ok(!/Ctrl\+Shift\+B|眼睛键/.test(hub.agyWording('先请他把浏览器打开：桌面端按 Ctrl+Shift+B 或点工作台的浏览器卡片，手机上点顶栏的眼睛键；做完的事在回复里说清楚。')));

  // 调不了的原因：设置里关了 / 没登记电脑 / 根本没有
  assert.match(hub.hubToolUnavailableReason(ctx, { bridgeTools: { browser: false } }, 'browser'), /Bridge 工具 里打开/);
  assert.match(hub.hubToolUnavailableReason(ctx, {}, 'nope_tool'), /没有叫 nope_tool/);
  const devWhy = hub.hubToolUnavailableReason(ctx, {}, 'device_act');
  assert.ok(/没有登记电脑|组里没有/.test(devWhy), devWhy);

  // tool_docs：只要挂了中枢组就列出（系统提示无条件提到它）
  const few = await hub.listHubTools(ctx, { bridgeTools: { browser: false, terminal: false, device: false } });
  assert.ok(few.length && few.find((t) => t.name === 'tool_docs'), '只剩小工具时也要有 tool_docs');

  // 精简参数表：batch 单步保留可用动作；完整说明里也列
  const full = { name: 'device_act', description: 'x'.repeat(4000), inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['launch', 'batch'] }, actions: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'screenshot'] }, x: { type: 'number' } } } } } } };
  const compact = hub.compactAgyTool(full);
  assert.deepEqual(compact.inputSchema.properties.actions.items.properties.action.enum, ['click', 'screenshot']);
  assert.equal(compact.inputSchema.properties.actions.items.properties.x, undefined);

  // 系统提示：旧存档里那一行被剥掉；本地工具提示按类别拼，关掉的类别不提
  const s = await import('../settings.mjs');
  const legacy = '- 默认使用简体中文。\n- 如当前会话挂载了 bridge 工具集：生成图片请调用 media_image（旧措辞）。';
  assert.equal(s.stripLegacyBridgeHint(legacy), '- 默认使用简体中文。');
  assert.ok(!s.DEFAULT_SYSTEM_PROMPT_APPEND.includes('media_image'));
  const p1 = s.buildEffectiveAgySystemPrompt({ systemPromptAppend: legacy }, { hasBridgeTools: true, localCategories: ['media'] });
  assert.ok(p1.includes('media_models') && !p1.includes('旧措辞') && !p1.includes('ui_open') && !p1.includes('phone_'));
  const p2 = s.buildEffectiveAgySystemPrompt({ systemPromptAppend: legacy }, { hasBridgeTools: false });
  assert.ok(!p2.includes('media_image'));
  const p3 = s.buildEffectiveAgySystemPrompt({}, { hasBridgeTools: true, localCategories: [], hubGroups: ['bridge', 'workspace'] });
  assert.ok(!p3.includes('media_image') && p3.includes('tool_docs') && /Claude 分页的会话/.test(p3));

  // bridge 的 call：经 agy 中枢调来的按「同机 agent 实例」对待，不能给自己开 Media Studio 的放行
  const { makeBridgeMcp } = await import('@bridge/core/mcp/bridge-tools.mjs');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const callVia = async (instance) => {
    const server = makeBridgeMcp({ ctx, getGen: () => null, ...(instance ? { instance } : {}) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    try { return await client.callTool({ name: 'call', arguments: { op: 'media.settings_set', args: { values: {} } } }); }
    finally { await client.close(); await server.instance.close(); }
  };
  const asAgy = await callVia('agy');
  assert.equal(asAgy.isError, true);
  assert.match(asAgy.content[0].text, /同机 agent 实例不能改这组设置/);
  const asClaude = await callVia('');
  assert.ok(!/同机 agent 实例/.test(asClaude.content[0].text), 'Claude 自己不受这条限制（照旧）');
});

test('ui_open 打开文件 / 文件夹：按发起调用那一轮的会话目录解析，ui.cmd 带上 agy 来源；页面目标仍直接走 ui.open', async () => {
  const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
  const { busSubscribe } = await import('@bridge/core/runtime/bus.mjs');
  const { noteUiState, answerUiRequest } = await import('@bridge/core/runtime/ui-state.mjs');
  const secret = ensureHostSecret();
  const post = (body) => fetch(`${BASE}/api/agy/internal/ui-open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'x-bridge-agent': 'agy', connection: 'close' },
    body: JSON.stringify(body),
  });
  await fetch(`${BASE}/api/agy/settings`, { method: 'PUT', headers: ADMIN_HEADERS, body: JSON.stringify({ bridgeTools: { enabled: true, ui: true } }) });
  assert.equal((await post({ file: 'a.md' })).status, 409, '没有在跑的轮：不知道按哪个会话目录算');

  const workDir = path.join(vaultDir, 'proj-uiopen');
  mkdirSync(path.join(workDir, 'docs'), { recursive: true });
  writeFileSync(path.join(workDir, 'docs', 'a.md'), '# a');

  // 假装用户开着一个 bridge 界面：收总线上的 ui.cmd 并回执
  const ctx = contextFor({ kind: 'admin' });
  const sent = [];
  const res = { writableEnded: false, write(chunk) { const m = /^data: (.*)$/m.exec(String(chunk)); if (m) { try { const ev = JSON.parse(m[1]); if (ev.type === 'ui.cmd') { sent.push(ev); answerUiRequest(ctx.key, ev.id, { ok: true }); } } catch {} } return true; }, end() {} };
  const off = busSubscribe(ctx.key, res);
  noteUiState(ctx.key, 'ui-test', 'web', { screen: 'agy' }, { visible: true });

  const live = startLiveSseChat({ message: '[SLOW] ui_open', cwd: workDir });
  const sessEv = await live.waitFor((e) => e.type === 'session');
  try {
    const r1 = await post({ file: 'docs/a.md', conversationId: sessEv.sessionId });
    assert.equal(r1.status, 200);
    const d1 = (await r1.json()).data;
    assert.equal(d1.confirmed, true);
    assert.equal(d1.path, path.join(realpathSync(workDir), 'docs', 'a.md'));
    const ev1 = sent.at(-1);
    assert.deepEqual(ev1.target, { file: 'docs/a.md' });
    assert.equal(ev1.from.agent, 'agy');
    assert.equal(ev1.from.session, sessEv.sessionId);
    assert.equal(ev1.from.ws, realpathSync(workDir));
    assert.equal(ev1.from.rootRel, 'proj-uiopen/docs/a.md');

    const r2 = await post({ folder: '.', conversationId: sessEv.sessionId });
    assert.equal(r2.status, 200);
    assert.deepEqual(sent.at(-1).target, { folder: '.' });
    assert.equal(sent.at(-1).from.rootRel, 'proj-uiopen', '会话目录在文件根里：文件页去得了');

    assert.equal((await post({ file: 'docs/none.md', conversationId: sessEv.sessionId })).status, 404);
    assert.equal((await post({ file: 'docs/a.md', folder: 'docs', conversationId: sessEv.sessionId })).status, 400);
    assert.equal((await post({ file: 'docs/a.md', conversationId: 'not-a-live-session' })).status, 409);

    // 工具层：file / folder 走内部接口，页面目标仍直接调 ui.open
    const calls = [];
    const ui = buildAgyBridgeToolDefs({
      categories: 'ui', phonePluginOn: false,
      callInternal: async (p, body) => { calls.push(['internal', p, body]); return { ok: true, data: { opened: true } }; },
      callAgentOp: async (name, args) => { calls.push(['op', name, args]); return { opened: true }; },
    }).find((d) => d.name === 'ui_open');
    await ui.handler({ file: 'docs/a.md' });
    await ui.handler({ page: 'settings', section: 'agy' });
    assert.deepEqual(calls[0], ['internal', '/api/agy/internal/ui-open', { file: 'docs/a.md' }]);
    assert.deepEqual(calls.at(-1), ['op', 'ui.open', { page: 'settings', section: 'agy' }]);
    assert.ok(calls.some((c) => c[1] === '/api/agy/internal/gate'), '页面目标照旧先过开关复核');
  } finally {
    off();
    await stopSession(sessEv.sessionId);
    await live.done;
  }
});
