// 插件审批策略管到 agy（八期）：ACP 客户端在自动放行（含完全放行）之前先问这一轮的 permissionPolicy。
// 'ask' → 完全放行也弹卡；'deny' → 直接拒；'allow' → 直接放；没表态 → 原口径。另验 makeAgyPermissionPolicy 接到核心的 agents:['agy'] 策略。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-plugin-perm-'));
const projectDir = path.join(tmp, 'proj');
const stateFile = path.join(tmp, 'state.json');
mkdirSync(projectDir, { recursive: true });

process.env.BRIDGE_DATA_ROOT = path.join(tmp, 'data');
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');
process.env.AGY_BIN = FAKE_AGENT;
process.env.FAKE_ACP_STATE_FILE = stateFile;

const { AcpClient } = await import('./acp/client.mjs');
const { makeAgyPermissionPolicy } = await import('./plugin-permission.mjs');
const { kernel } = await import('@bridge/core/plugins/state.mjs');
const { installMixins } = await import('@bridge/core/plugins/host.mjs');
const CT = await import('@bridge/core/plugins/claude-tools.mjs');

const client = new AcpClient({ daemonCwd: path.join(tmp, 'daemon'), logFile: null, env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile } });
// 核心插件内核 / 上游代理留着常驻句柄：断言都跑完了，不等它们
after(() => { client.shutdown(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 200); });

const HOST = { kind: 'admin', key: 'admin', sandbox: false, cwd: tmp };
const seen = [];
let verdict = 'ask';
installMixins();
await kernel.start();
await kernel.register({
  id: 'perm-agy', name: 'perm-agy', source: 'local', dir: tmp, pluginApi: 3,
  load: async () => ({ apply: (ctx) => {
    ctx.claude.permission((view, turn) => {
      seen.push({ tool: view.tool, op: view.input?.op, agent: view.agent, turnAgent: turn.agent, cwd: turn.cwd });
      return view.tool === 'mcp_bridge_call' && view.input?.op === 'chat.send' ? verdict : undefined;
    }, { agents: ['agy'] });
    ctx.claude.permission(() => 'deny');   // 只管 Claude 的：agy 那边不该问到它
  } }),
});
await kernel.setEnabled('perm-agy', true);

async function bypassSession() {
  const snap = await client.createSession({ cwd: projectDir, desiredConfig: { mode: 'bypass' } });
  return snap.sessionId;
}

test('ctx.claude.permission 的 agents：只认 claude / agy；Claude 的审批不问 agents:[agy] 的策略', async () => {
  assert.throws(() => kernel.contextOf('perm-agy').claude.permission(() => {}, { agents: ['codex'] }), /只认 claude \/ agy/);
  seen.length = 0;
  const r = await CT.pluginPermission({ kind: 'chat', ctx: HOST, snap: null, sessionId: 's' }, { tool: 'mcp__bridge__call', input: { op: 'chat.send', args: {} } });
  assert.equal(r.behavior, 'deny', 'Claude 那边是缺省 agents 的那条');
  assert.equal(seen.length, 0);
});

test("完全放行下插件说 'ask'：照样弹卡，批了才放；策略看到 agy 的工具名、参数与会话目录", async () => {
  const sid = await bypassSession();
  verdict = 'ask';
  seen.length = 0;
  let asked = 0;
  const policy = makeAgyPermissionPolicy(HOST, { sessionId: sid, cwd: projectDir }, { cwd: projectDir });
  const t = await client.runPrompt({
    sessionId: sid, cwd: projectDir, promptBlocks: [{ type: 'text', text: '找 Claude [PERM] [PERM_BRIDGE]' }],
    permissionPolicy: policy,
    onPermission: (p) => { asked += 1; setTimeout(() => client.answerPermission(p.requestId, { optionId: 'allow' }), 10); },
  });
  assert.equal(asked, 1, '完全放行也弹了卡');
  assert.match(t.text, /perm=allow/);
  assert.deepEqual(seen[0], { tool: 'mcp_bridge_call', op: 'chat.send', agent: 'agy', turnAgent: 'agy', cwd: projectDir });
});

test("插件说 'deny' 直接拒、'allow' 直接放（都不弹卡）；没表态照完全放行；无人值守的轮 'ask' 按拒绝", async () => {
  const sid = await bypassSession();
  const policy = makeAgyPermissionPolicy(HOST, { sessionId: sid, cwd: projectDir }, { cwd: projectDir });
  const run = (text, pol = policy) => client.runPrompt({ sessionId: sid, cwd: projectDir, promptBlocks: [{ type: 'text', text }], permissionPolicy: pol, onPermission: () => assert.fail('不该弹卡') });
  verdict = 'deny';
  assert.match((await run('发 [PERM] [PERM_BRIDGE]')).text, /perm=deny/);
  verdict = 'allow';
  assert.match((await run('发 [PERM] [PERM_BRIDGE]')).text, /perm=allow/);
  verdict = 'ask';
  assert.match((await run('跑命令 [PERM]')).text, /perm=allow/, '策略没表态（不是 bridge 发消息）：完全放行照旧');
  const wake = makeAgyPermissionPolicy(HOST, { sessionId: sid, cwd: projectDir }, { cwd: projectDir, unattended: true });
  assert.match((await run('后台唤醒 [PERM] [PERM_BRIDGE]', wake)).text, /perm=deny/);
});

test('没有策略（permissionPolicy 不给）：原来的完全放行不变', async () => {
  const sid = await bypassSession();
  const t = await client.runPrompt({ sessionId: sid, cwd: projectDir, promptBlocks: [{ type: 'text', text: '[PERM] [PERM_BRIDGE]' }], onPermission: () => assert.fail('不该弹卡') });
  assert.match(t.text, /perm=allow/);
});
