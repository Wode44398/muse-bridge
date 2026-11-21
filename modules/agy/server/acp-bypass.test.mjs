import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-bypass-'));
const projectDir = path.join(tmp, 'proj');
const stateFile = path.join(tmp, 'state.json');
mkdirSync(projectDir, { recursive: true });

process.env.BRIDGE_DATA_ROOT = path.join(tmp, 'data');
process.env.AGY_BIN = FAKE_AGENT;
process.env.FAKE_ACP_STATE_FILE = stateFile;

const { AcpClient } = await import('./acp/client.mjs');
const { decorateModeOptions, decorateModes, pickAllowOption, toAcpMode } = await import('./acp/bypass.mjs');
const { extractConfigSummary } = await import('./events.mjs');

const client = new AcpClient({
  daemonCwd: path.join(tmp, 'daemon'),
  logFile: null,
  env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile },
});

after(() => {
  client.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

const MODE_OPT = {
  id: 'mode', category: 'mode', type: 'select', currentValue: 'auto',
  options: [{ value: 'default' }, { value: 'auto' }, { value: 'plan' }],
};

test('bypass 纯函数：补选项幂等、按放行状态改写当前值、挑允许项', () => {
  const on = decorateModeOptions([MODE_OPT], true);
  assert.equal(on[0].currentValue, 'bypass');
  assert.deepEqual(on[0].options.map((o) => o.value), ['default', 'auto', 'plan', 'bypass']);
  assert.deepEqual(decorateModeOptions(on, true), on, '重复改写结果不变');
  assert.equal(decorateModeOptions(on, false)[0].currentValue, 'auto', '关掉放行后还原成 auto');
  assert.equal(decorateModeOptions([{ ...MODE_OPT, currentValue: 'plan' }], true)[0].currentValue, 'plan');
  const noAuto = { ...MODE_OPT, options: [{ value: 'default' }] };
  assert.equal(decorateModeOptions([noAuto], true)[0], noAuto, '没有 auto 的版本不加选项');
  assert.equal(decorateModes({ currentModeId: 'auto' }, true).currentModeId, 'bypass');
  assert.equal(toAcpMode('bypass'), 'auto');
  assert.equal(toAcpMode('plan'), 'plan');
  assert.equal(pickAllowOption([
    { optionId: 'deny', kind: 'reject_once' },
    { optionId: 'always', kind: 'allow_always' },
    { optionId: 'once', kind: 'allow_once' },
  ]).optionId, 'once');
  assert.equal(pickAllowOption([{ optionId: 'deny', kind: 'reject_once' }]), null);
});

test('AcpClient：完全放行会话自动允许审批、对外显示 bypass、换回默认后恢复逐次审批', async () => {
  const snap = await client.createSession({ cwd: projectDir, desiredConfig: { mode: 'bypass' } });
  const sid = snap.sessionId;
  assert.equal(client.isBypass(sid), true);
  assert.equal(extractConfigSummary(snap.configOptions, snap.modes).mode, 'bypass', '快照对外显示 bypass');

  const resolved = [];
  const turn1 = await client.runPrompt({
    sessionId: sid,
    cwd: projectDir,
    promptBlocks: [{ type: 'text', text: '跑个命令 [PERM]' }],
    onPermission: () => assert.fail('放行模式不应弹审批'),
    onPermissionResolved: (r) => resolved.push(r),
  });
  assert.equal(turn1.status, 'completed');
  assert.match(turn1.text, /\/auto /, 'agy 实际跑在 auto');
  assert.match(turn1.text, /perm=allow/);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].auto, true);
  assert.equal(resolved[0].optionId, 'allow');

  const out = await client.setConfigOption(sid, 'mode', 'default', { cwd: projectDir });
  assert.equal(out.mode, 'default');
  assert.equal(client.isBypass(sid), false);

  let asked = 0;
  const turn2 = await client.runPrompt({
    sessionId: sid,
    cwd: projectDir,
    promptBlocks: [{ type: 'text', text: '再跑一次 [PERM]' }],
    onPermission: (p) => { asked += 1; setTimeout(() => client.answerPermission(p.requestId, { optionId: 'deny' }), 10); },
  });
  assert.equal(asked, 1, '默认模式恢复逐次审批');
  assert.match(turn2.text, /\/default /);
  assert.match(turn2.text, /perm=deny/);

  const back = await client.setConfigOption(sid, 'mode', 'bypass', { cwd: projectDir });
  assert.equal(back.mode, 'bypass');
  assert.equal(client.isBypass(sid), true);
});

test('AcpClient：新会话同时补发 model / thought_level / mode=bypass 时不被中间 config_option_update 冲成 auto', async () => {
  const snap = await client.createSession({
    cwd: projectDir,
    desiredConfig: { model: 'gemini-4-hydrogen', thought_level: 'xhigh', mode: 'bypass' },
  });
  const sid = snap.sessionId;
  const summary = extractConfigSummary(snap.configOptions, snap.modes, snap.models);
  assert.equal(summary.model, 'gemini-4-hydrogen');
  assert.equal(summary.thoughtLevel, 'xhigh');
  assert.equal(summary.mode, 'bypass', '快照对外仍应为 bypass，而非被中间态冲掉后落成 auto');
  assert.equal(client.isBypass(sid), true, 'desiredConfig.mode 仍应保持 bypass');

  const resolved = [];
  const turn = await client.runPrompt({
    sessionId: sid,
    cwd: projectDir,
    promptBlocks: [{ type: 'text', text: '带模型切换建会话后跑命令 [PERM]' }],
    onPermission: () => assert.fail('放行模式不应弹审批'),
    onPermissionResolved: (r) => resolved.push(r),
  });
  assert.equal(turn.status, 'completed');
  assert.match(turn.text, /\/auto /, '底层 agy 实际跑在 auto');
  assert.match(turn.text, /perm=allow/);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].auto, true);
});
