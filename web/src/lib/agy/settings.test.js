import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialAgyPrefsState,
  createAgySettingsController,
  splitCommandArgs,
  parseEnvLines,
} from './settings-logic.js';
import { extractModeOptions } from './catalog.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('splitCommandArgs 与 parseEnvLines：支持带空格引号参数并校验环境变量格式', () => {
  assert.deepEqual(
    splitCommandArgs('-y @modelcontextprotocol/server-filesystem "D:\\Notes\\My Project"'),
    ['-y', '@modelcontextprotocol/server-filesystem', 'D:\\Notes\\My Project'],
  );

  assert.deepEqual(
    parseEnvLines('API_KEY=sk-123=abc\n  # comment  \nNODE_ENV=production'),
    { API_KEY: 'sk-123=abc', NODE_ENV: 'production' },
  );

  assert.throws(() => parseEnvLines('MISSING_EQUALS'), /KEY=VALUE/);
  assert.throws(() => parseEnvLines('123_BAD=val'), /不合法/);

  // 尚未挂载实时会话（configOptions 为空、modes 为 null）时，本地静态模式目录仍返回完整 4 档选项
  const modeCat = extractModeOptions([], null, [
    { id: 'default', name: 'Default' },
    { id: 'accept-edits', name: 'Accept Edits' },
    { id: 'auto', name: 'Auto' },
    { id: 'plan', name: 'Plan' },
  ]);
  assert.equal(modeCat.options.length, 5);
  assert.deepEqual(modeCat.options.map((m) => m.id), ['default', 'accept-edits', 'auto', 'plan', 'bypass']);
});

test('patchSettings：立即乐观更新并同步会话默认值，服务端报错时精确回滚快照', async () => {
  const state = createInitialAgyPrefsState();
  state.settings.defaultModel = 'gemini-4-carbon';
  state.settings.theme = 'system';

  const syncedSnapshots = [];
  const toastErrors = [];
  const def = createDeferred();

  const ctl = createAgySettingsController({
    state,
    api: {
      saveSettings: () => def.promise,
    },
    onError: (msg) => toastErrors.push(msg),
    onSyncDefaults: (snap) => syncedSnapshots.push({ ...snap }),
  });

  const pending = ctl.patchSettings({ defaultModel: 'claude-opus-4-6', theme: 'daylight' }, 'defaults');

  // 请求尚未返回时，状态已乐观生效并通知对话页同步
  assert.equal(state.settings.defaultModel, 'claude-opus-4-6');
  assert.equal(state.settings.theme, 'daylight');
  assert.equal(syncedSnapshots.length, 1);
  assert.equal(syncedSnapshots[0].defaultModel, 'claude-opus-4-6');

  // 模拟服务端拒绝保存
  def.reject(Object.assign(new Error('磁盘只读'), { body: { error: '保存被拒绝' } }));
  const ok = await pending;
  assert.equal(ok, false);

  // 状态与对话页默认值均已自动回滚到修改前，且记录可见错误
  assert.equal(state.settings.defaultModel, 'gemini-4-carbon');
  assert.equal(state.settings.theme, 'system');
  assert.equal(syncedSnapshots.length, 2);
  assert.equal(syncedSnapshots[1].defaultModel, 'gemini-4-carbon');
  assert.equal(state.errors.defaults, '保存被拒绝');
  assert.deepEqual(toastErrors, ['保存被拒绝']);
});

test('MCP / 插件启停删除与隐藏会话恢复：失败时均自动回滚乐观状态', async () => {
  const state = createInitialAgyPrefsState();
  state.mcp.items = [
    { name: 'fs-a', type: 'stdio', enabled: true, target: 'npx a' },
    { name: 'fs-b', type: 'stdio', enabled: false, target: 'npx b' },
  ];
  state.plugins.items = [
    { name: 'plg-x', enabled: true, version: '1.0.0' },
  ];
  state.hiddenCount = 4;

  const toggleDef = createDeferred();
  const removeDef = createDeferred();
  const plgDef = createDeferred();
  const restoreDef = createDeferred();

  const ctl = createAgySettingsController({
    state,
    api: {
      toggleMcp: () => toggleDef.promise,
      removeMcp: () => removeDef.promise,
      togglePlugin: () => plgDef.promise,
      restoreAllSessions: () => restoreDef.promise,
    },
  });

  // 1) toggleMcp 乐观切换 -> 失败回滚
  const pToggle = ctl.toggleMcp('fs-a', false);
  assert.equal(state.mcp.items[0].enabled, false);
  toggleDef.reject(new Error('CLI 忙'));
  assert.equal(await pToggle, false);
  assert.equal(state.mcp.items[0].enabled, true);

  // 2) removeMcp 乐观移除 -> 失败按原位置恢复
  const pRemove = ctl.removeMcp('fs-a');
  assert.equal(state.mcp.items.length, 1);
  assert.equal(state.mcp.items[0].name, 'fs-b');
  removeDef.reject(new Error('无法删除'));
  assert.equal(await pRemove, false);
  assert.equal(state.mcp.items.length, 2);
  assert.equal(state.mcp.items[0].name, 'fs-a');

  // 3) togglePlugin 乐观切换 -> 失败回滚
  const pPlg = ctl.togglePlugin('plg-x', false);
  assert.equal(state.plugins.items[0].enabled, false);
  plgDef.reject(new Error('插件占用'));
  assert.equal(await pPlg, false);
  assert.equal(state.plugins.items[0].enabled, true);

  // 4) restoreAllHidden 乐观归零 -> 失败回滚原数量
  const pRestore = ctl.restoreAllHidden();
  assert.equal(state.hiddenCount, 0);
  restoreDef.reject(new Error('网络中断'));
  assert.equal(await pRestore, false);
  assert.equal(state.hiddenCount, 4);
});
