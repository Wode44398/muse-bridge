import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-debug-'));
const dataRoot = path.join(tmp, 'data');
mkdirSync(path.join(dataRoot, 'agy'), { recursive: true });
mkdirSync(path.join(tmp, 'users'), { recursive: true });
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ port: 18997, token: 'agy-debug-test-token-0123456789', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users') }));
process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';

const { agyDebugOn, agyDebugPrompt, AGY_HARNESS_FEEDBACK_DIR } = await import('./debug-mode.mjs');
const { buildEffectiveAgySystemPrompt, sanitizeAgySettings, saveAgySettings, DEFAULT_AGY_SETTINGS } = await import('./settings.mjs');
const { buildAgySessionTooling } = await import('./mcp/config.mjs');
const { HARNESS_FEEDBACK_DIR } = await import('@bridge/core/agent-api/ops/feedback.mjs');
const { contextFor } = await import('@bridge/core/runtime/identity.mjs');

after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const MARK = '【调试模式 · 已开启';

test('调试模式：设置默认关、白名单保留布尔值、落盘读回不丢', () => {
  assert.equal(DEFAULT_AGY_SETTINGS.debugMode, false);
  assert.equal(sanitizeAgySettings({}).debugMode, false);
  assert.equal(sanitizeAgySettings({ debugMode: true }).debugMode, true);
  assert.equal(sanitizeAgySettings({ debugMode: 'yes' }).debugMode, false);
  const dir = path.join(tmp, 'agy-settings');
  mkdirSync(dir, { recursive: true });
  assert.equal(saveAgySettings(dir, { debugMode: true }).debugMode, true);
  assert.equal(saveAgySettings(dir, { theme: 'azure' }).debugMode, true, '改别的设置不会把调试开关冲掉');
});

test('调试模式：只认主机管理员的非沙箱身份', () => {
  assert.equal(agyDebugOn({ kind: 'admin' }, { debugMode: true }), true);
  assert.equal(agyDebugOn({ kind: 'admin' }, { debugMode: false }), false);
  assert.equal(agyDebugOn({ kind: 'admin', sandbox: true }, { debugMode: true }), false);
  assert.equal(agyDebugOn({ kind: 'user' }, { debugMode: true }), false);
  assert.equal(agyDebugOn(null, { debugMode: true }), false);
});

test('调试模式提示词：开着拼在最末尾（工作目录那几句之后），关着没有', () => {
  const base = { systemPromptAppend: '- 用户追加' };
  const opts = { hasBridgeTools: true, localCategories: ['ui'], hubGroups: ['bridge', 'browser'], cwd: 'C:\\proj', additionalDirectories: ['D:\\extra'] };
  const off = buildEffectiveAgySystemPrompt(base, opts);
  assert.ok(!off.includes(MARK));
  const on = buildEffectiveAgySystemPrompt(base, { ...opts, debug: true });
  assert.ok(on.startsWith(off + '\n'), '调试段只往最后追加，前面一字不动');
  const tail = on.slice(off.length + 1);
  assert.ok(tail.startsWith(MARK));
  assert.ok(on.indexOf(MARK) > on.indexOf('【当前会话工作目录】'));
  assert.ok(on.indexOf(MARK) > on.indexOf('已授权附加工作目录'));
  for (const kind of ['bug', 'redundant', 'missing', 'workaround', 'friction']) assert.ok(tail.includes(`kind:"${kind}"`), kind);
  assert.match(tail, /铁律/);
  assert.match(tail, /本轮调试反馈：N 条/);
  // 只在 Claude 分页成立的说法不许出现
  assert.ok(!/mcp__|AskUserQuestion|Write 在/.test(tail), tail);
});

test('调试模式提示词：挂着 bridge 操作工具走 call feedback.harness，没挂写进 harness-feedback/agy', () => {
  const viaCall = buildEffectiveAgySystemPrompt({}, { hasBridgeTools: true, hubGroups: ['bridge'], debug: true });
  assert.match(viaCall, /调 bridge 服务的 call 工具，op:"feedback\.harness"/);
  assert.ok(!viaCall.includes('harness-feedback'));

  // 中枢开着、但 bridge 组关了
  const noOps = buildEffectiveAgySystemPrompt({}, { hasBridgeTools: true, hubGroups: ['browser'], debug: true });
  // 整个 bridge 工具关了
  const noTools = buildEffectiveAgySystemPrompt({}, { hasBridgeTools: false, hubGroups: ['bridge'], debug: true });
  const want = path.join(HARNESS_FEEDBACK_DIR, 'agy') + path.sep + '<YYYY-MM-DD>' + path.sep + '<HHMMSS>-<kind>-<短标题>.md';
  for (const p of [noOps, noTools]) {
    assert.ok(p.includes(want), p);
    assert.ok(!p.includes('feedback.harness'));
  }
  assert.equal(AGY_HARNESS_FEEDBACK_DIR, path.join(HARNESS_FEEDBACK_DIR, 'agy'));
  assert.ok(agyDebugPrompt({ dir: 'X:\\fb' }).includes('X:\\fb' + path.sep + '<YYYY-MM-DD>'));
});

test('调试模式：会话挂载工具按身份判定，指纹随开关变（没挂 bridge 工具时也变）', () => {
  const admin = contextFor({ kind: 'admin' });
  const on = buildAgySessionTooling({ ctx: admin, settings: { debugMode: true } });
  const off = buildAgySessionTooling({ ctx: admin, settings: { debugMode: false } });
  assert.ok(on.systemPromptAppend.includes(MARK));
  assert.ok(!off.systemPromptAppend.includes(MARK));
  assert.notEqual(on.toolingSig, off.toolingSig);
  if (on.hubGroups.includes('bridge')) assert.match(on.systemPromptAppend, /op:"feedback\.harness"/);

  const bareOn = buildAgySessionTooling({ ctx: admin, settings: { debugMode: true, bridgeTools: { enabled: false } } });
  const bareOff = buildAgySessionTooling({ ctx: admin, settings: { debugMode: false, bridgeTools: { enabled: false } } });
  assert.equal(bareOff.toolingSig, 'off');
  assert.notEqual(bareOn.toolingSig, 'off');
  assert.ok(bareOn.systemPromptAppend.includes(path.join(HARNESS_FEEDBACK_DIR, 'agy')));

  for (const ctx of [{ kind: 'user' }, { ...admin, sandbox: true }]) {
    const r = buildAgySessionTooling({ ctx, settings: { debugMode: true } });
    assert.ok(!r.systemPromptAppend.includes(MARK), '非主机管理员 / 沙箱不生效');
    assert.ok(!r.toolingSig.endsWith('|debug'));
  }
});
