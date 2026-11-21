// 工具中枢 · 插件工具：插件声明给 agy（agents 含 'agy'，或 ctx.tools.add 缺省）的工具经 bridge 工具服务列出与调用。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-plugins-'));
const dataRoot = path.join(tmp, 'data');
for (const d of [dataRoot, path.join(tmp, 'users'), path.join(tmp, 'vault')]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ port: 18995, token: 'agy-plugins-token-0123456789', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'), features: { multiUser: true } }));
process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { kernel } = await import('@bridge/core/plugins/state.mjs');
const { installMixins } = await import('@bridge/core/plugins/host.mjs');
const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
const hub = await import('./hub.mjs');
const { bridgeToolAutoAllow } = await import('./approval.mjs');
const { pluginPromptsForAgy } = await import('./groups/plugins.mjs');
const { buildAgySessionTooling } = await import('./config.mjs');

installMixins();
await kernel.start();
after(async () => {
  await kernel.stop();
  try { for (const e of readdirSync(tmp)) if (e !== 'users') rmSync(path.join(tmp, e), { recursive: true, force: true }); } catch {}
});

const ctx = contextFor({ kind: 'admin' });
const textOf = (r) => (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('插件工具：声明给 agy 的才列、名字规整成小写下划线、只读的免审批、卡片段不给 agy、开关插件会改工具指纹', async () => {
  const sig0 = buildAgySessionTooling({ ctx, settings: {} }).toolingSig;
  const seenTurn = [];
  const id = 'demo-tools';
  await kernel.register({
    id, name: id, source: 'local', dir: tmp, pluginApi: 3,
    load: async () => ({
      apply: (c) => {
        c.tools.add({ name: 'Weather-Now', description: '查天气', access: 'read', params: { city: { type: 'string', required: true } }, handler: ({ city }, turn) => { seenTurn.push(turn); return { card: { title: city + ' 晴' }, text: city + '：晴' }; } });
        c.claude.tool({ name: 'write_note', agents: ['agy'], description: '记一条', params: {}, handler: () => 'ok' });
        c.claude.tool({ name: 'claude_only', description: '只给 Claude', params: {}, handler: () => 'no' });
        c.claude.prompt('插件给 agy 的说明', { agents: ['agy'] });
      },
    }),
  });
  assert.throws(() => kernel.contextOf(id).tools.add({ name: 'x', agents: ['codex'], handler: () => 1 }), /不认识/);
  hub._clearHubCacheForTest();
  const tools = await hub.listHubTools(ctx, {});
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('plugin_demo_tools_weather_now'), names.join(' '));
  assert.ok(names.includes('plugin_demo_tools_write_note'));
  assert.ok(!names.some((n) => n.includes('claude_only')));
  assert.equal(bridgeToolAutoAllow({ name: 'mcp_bridge_plugin_demo_tools_weather_now', args: {} }), true);
  assert.equal(bridgeToolAutoAllow({ name: 'mcp_bridge_plugin_demo_tools_write_note', args: {} }), false);
  const gen = { sessionId: 'sess-plug', cwd: tmp, events: [], subscribers: new Set() };
  const r = await hub.callHubTool(ctx, gen, await hub.resolveHubTool(ctx, {}, 'plugin_demo_tools_weather_now'), { city: '上海' });
  assert.equal(textOf(r), '上海：晴');
  assert.equal(seenTurn.at(-1).agent, 'agy');
  assert.equal(seenTurn.at(-1).sessionId, 'sess-plug');
  assert.match(pluginPromptsForAgy(ctx), /插件给 agy 的说明/);
  const tooling = buildAgySessionTooling({ ctx, settings: {} });
  assert.notEqual(tooling.toolingSig, sig0);
  assert.match(tooling.systemPromptAppend, /插件给 agy 的说明/);
  // 设置里关掉插件工具：不列、提示也不带
  const offNames = (await hub.listHubTools(ctx, { bridgeTools: { pluginTools: false } })).map((t) => t.name);
  assert.ok(!offNames.some((n) => n.startsWith('plugin_')));
  // 插件停用：指纹回到原样
  await kernel.setEnabled(id, false);
  assert.equal(buildAgySessionTooling({ ctx, settings: {} }).toolingSig, sig0);
});
