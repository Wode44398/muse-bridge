// 插件应用页面开的会话打标：跑真的 runClaudeChat（假 SDK，见 testing/fake-claude-sdk.mjs），
// 入参照 routes/chat.mjs 的组法——pluginOrigin 由真的 pluginOriginFor 从请求里取，取得到才往下传。
// 钉住：内部请求带来的 pluginOrigin 在 init 帧之后落进 pluginSessions（plugin / app / label / owner）；
// 网络上来的请求（没有内部身份标记）在请求体里带了也不打标。
//
// 本文件不能静态 import bridge 的运行时模块：隔离用的环境变量要先于它们设好。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'bridge-claude-plugin-origin-')));
const dirs = {
  tmp,
  data: path.join(tmp, 'data'),
  vault: path.join(tmp, 'vault'),
  users: path.join(tmp, 'users'),
  claude: path.join(tmp, 'claude'),
  home: path.join(tmp, 'home'),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
// 从启动它的环境里继承来的开关与凭据一律清掉，数据一律落临时目录
for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|_CLAUDE_|CLAUDE|BRIDGE_|VERTEX_|GEMINI_|OPENROUTER_|GIT_)/i.test(k) || ['PORT', 'VAULT_PATH', 'PYTHONIOENCODING', 'CODEX_BIN', 'PV_PUBLIC_DOMAIN'].includes(k)) delete process.env[k];
}
Object.assign(process.env, {
  BRIDGE_DATA_ROOT: dirs.data,
  VAULT_PATH: dirs.vault,
  BRIDGE_USERS_ROOT: dirs.users,
  CLAUDE_CONFIG_DIR: dirs.claude,
  USERPROFILE: dirs.home,
  HOME: dirs.home,
  APPDATA: path.join(dirs.home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(dirs.home, 'AppData', 'Local'),
  BRIDGE_MODULES_SKIP: 'all',
  BRIDGE_CLAUDE_IN_CHROME: '0',
  BRIDGE_NO_ROUTINES: '1',
  BRIDGE_DESKTOP_MIRROR: '0',
  BRIDGE_CLAUDE_CLI_DOWNLOAD: '0',
  BRIDGE_PLUGINS_STATE: path.join(dirs.data, 'plugins.json'),
  BRIDGE_PLUGINS_DIR: path.join(dirs.data, 'plugins'),
});

const { makeChatHarness } = await import('./testing/chat-harness.mjs');
const { frames, closing, CONTROL, chatArgs } = await import('./testing/chat-kit.mjs');
const { pluginSessions } = await import('../runtime/gen.mjs');
const { INTERNAL_IDENTITY } = await import('../runtime/identity.mjs');
const { pluginOriginFor } = await import('../routes/chat.mjs');

const harness = makeChatHarness({ dirs });

test.after(() => {
  harness.shutdown();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  // runClaudeChat 留着几个不 unref 的兜底定时器（最长 10s）；断言都已跑完，不等它们
  setTimeout(() => process.exit(process.exitCode || 0), 200);
});

const ORIGIN = { plugin: 'pg-chat', app: 'main', label: '对话应用' };

// 一轮新会话：请求体带 pluginOrigin，internal 决定请求上有没有内部身份标记；入参照 routes/chat.mjs 组。
// 返回 init 刚处理完那一刻（CLI 还没吐下一帧）与整轮结束后 pluginSessions 里这个会话的记录。
async function openTurn(h, ctx, { internal }) {
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  let atInit;
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    // 读循环要下一帧时 init 已经处理完（拉动式），此刻就该查得到
    atInit = pluginSessions.get(sid);
    yield* closing(io, f, '好的。');
    await io.user();
  }, CONTROL);
  const parsed = { message: '帮我看看', agent: 'claude', pluginOrigin: ORIGIN };
  const req = { headers: {}, ...(internal ? { [INTERNAL_IDENTITY]: { kind: ctx.kind === 'user' ? 'user' : 'admin' } } : {}) };
  const pluginOrigin = pluginOriginFor(req, parsed, { sessionId: undefined, isSnap: false });
  const call = h.chat(chatArgs(ctx, parsed.message, { ...(pluginOrigin ? { pluginOrigin } : {}) }));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  return { sid, atInit, after: pluginSessions.get(sid) };
}

test('内部请求带 pluginOrigin：init 之后会话打上插件 / 应用 / 标签 / 使用者（主机）', async () => {
  let got;
  await harness.run('主机', async (h) => { got = await openTurn(h, h.ctx(), { internal: true }); });
  assert.equal(got.atInit && got.atInit.plugin, ORIGIN.plugin, 'init 帧处理完时已经打标');
  const { at, ...rest } = got.after;
  assert.deepEqual(rest, { plugin: 'pg-chat', label: '对话应用', app: 'main', owner: 'admin' });
  assert.equal(typeof at, 'number');
});

test('内部请求带 pluginOrigin：owner 是发起这一轮的成员', async () => {
  let got, key;
  await harness.run('成员', async (h) => {
    const ctx = h.ctx({ kind: 'user', user: 'u-plug', name: 'erin', tier: 'pro' });
    mkdirSync(ctx.cwd, { recursive: true });
    key = ctx.key;
    got = await openTurn(h, ctx, { internal: true });
  });
  assert.ok(key && key !== 'admin');
  assert.equal(got.after.owner, key);
  assert.equal(got.after.plugin, 'pg-chat');
  assert.equal(got.after.app, 'main');
  assert.equal(got.after.label, '对话应用');
});

test('外部请求（没有内部身份标记）带了 pluginOrigin 也不打标', async () => {
  let got;
  await harness.run('外部', async (h) => { got = await openTurn(h, h.ctx(), { internal: false }); });
  assert.equal(got.atInit, undefined);
  assert.equal(got.after, undefined);
});

test('不带 pluginOrigin 的普通一轮不打标', async () => {
  let sid;
  await harness.run('普通', async (h) => {
    const ctx = h.ctx();
    sid = h.sid();
    const f = frames(sid, { cwd: ctx.cwd });
    const cli = h.script(async function* (io) {
      await io.user();
      yield f.init(io);
      yield* closing(io, f, '好的。');
      await io.user();
    }, CONTROL);
    const call = h.chat(chatArgs(ctx, '你好'));
    await h.at(cli, 'user#2');
    await h.releaseWarm(ctx.key, sid);
    await h.done(call);
  });
  assert.equal(pluginSessions.has(sid), false);
});
