// 别的 agent 经 bridge 操作 chat.send 发来的这一轮（viaAgent）：跑真的 runClaudeChat（假 SDK，见 testing/fake-claude-sdk.mjs），
// 入参照 routes/chat.mjs 的组法——viaAgent 由真的 viaAgentFor 从请求里取。
// 钉住：内部请求带 viaAgent:'agy' → 插件事件 turn.start / turn.end 带 via:'agy'，插件消息改写（ctx.claude.input）的 turn.via 也是它；
// 网络上来的请求（没有内部身份标记）、不认识的值都不带。
//
// 本文件不能静态 import bridge 的运行时模块：隔离用的环境变量要先于它们设好。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'bridge-claude-via-agent-')));
const dirs = {
  tmp,
  data: path.join(tmp, 'data'),
  vault: path.join(tmp, 'vault'),
  users: path.join(tmp, 'users'),
  claude: path.join(tmp, 'claude'),
  home: path.join(tmp, 'home'),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
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
const { INTERNAL_IDENTITY } = await import('../runtime/identity.mjs');
const { viaAgentFor } = await import('../routes/chat.mjs');
const { kernel } = await import('../plugins/state.mjs');
const { installMixins } = await import('../plugins/host.mjs');

const harness = makeChatHarness({ dirs });
const seen = { starts: [], ends: [], inputs: [] };

test.before(async () => {
  installMixins();
  await kernel.start();
  await kernel.register({
    id: 'via-probe', name: 'via-probe', source: 'local', dir: tmp, pluginApi: 3,
    load: async () => ({ apply: (ctx) => {
      ctx.events.on('turn.start', (e) => { if (e.agent === 'claude') seen.starts.push(e); });
      ctx.events.on('turn.end', (e) => { if (e.agent === 'claude') seen.ends.push(e); });
      ctx.claude.input((m, turn) => { seen.inputs.push(turn.via || ''); });
    } }),
  });
  await kernel.setEnabled('via-probe', true);
});

test.after(() => {
  harness.shutdown();
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 200);
});

const flush = () => new Promise((r) => setTimeout(r, 30));

async function oneTurn(h, ctx, parsed, { internal }) {
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '好的。');
    await io.user();
  }, CONTROL);
  const req = { headers: {}, ...(internal ? { [INTERNAL_IDENTITY]: { kind: 'admin' } } : {}) };
  const viaAgent = viaAgentFor(req, parsed, { isSnap: false });
  const call = h.chat(chatArgs(ctx, parsed.message, { ...(viaAgent ? { viaAgent } : {}) }));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  await flush();
  return { sid, viaAgent };
}

test('viaAgentFor：只认进程内请求、只认几个 agent id；快照轮不给', () => {
  const inner = { [INTERNAL_IDENTITY]: { kind: 'admin' } };
  assert.equal(viaAgentFor(inner, { viaAgent: 'agy' }), 'agy');
  assert.equal(viaAgentFor(inner, { viaAgent: 'dimensio' }), 'dimensio');
  assert.equal(viaAgentFor(inner, { viaAgent: 'claude' }), '');
  assert.equal(viaAgentFor(inner, { viaAgent: 'evil' }), '');
  assert.equal(viaAgentFor({ headers: {} }, { viaAgent: 'agy' }), '', '网络上来的请求不认');
  assert.equal(viaAgentFor(inner, { viaAgent: 'agy' }, { isSnap: true }), '');
});

test('agy 经 chat.send 发来的一轮：turn.start / turn.end 带 via，消息改写的 turn.via 也是 agy', async () => {
  seen.starts.length = 0; seen.ends.length = 0; seen.inputs.length = 0;
  await harness.run('via', async (h) => { await oneTurn(h, h.ctx(), { message: '「来自 Antigravity」帮我看看', viaAgent: 'agy' }, { internal: true }); });
  assert.equal(seen.starts.length, 1);
  assert.equal(seen.starts[0].via, 'agy');
  assert.equal(seen.ends.length, 1);
  assert.equal(seen.ends[0].via, 'agy');
  assert.deepEqual(seen.inputs, ['agy']);
});

test('用户自己发的、外部请求冒充的：都不带 via', async () => {
  seen.starts.length = 0; seen.ends.length = 0; seen.inputs.length = 0;
  await harness.run('plain', async (h) => { await oneTurn(h, h.ctx(), { message: '你好' }, { internal: true }); });
  await harness.run('forged', async (h) => { await oneTurn(h, h.ctx(), { message: '你好', viaAgent: 'agy' }, { internal: false }); });
  assert.equal(seen.starts.length, 2);
  for (const e of [...seen.starts, ...seen.ends]) assert.equal('via' in e, false);
  assert.deepEqual(seen.inputs, ['', '']);
});
