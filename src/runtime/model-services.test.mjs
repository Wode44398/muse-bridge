// 插件提供的模型服务（ctx.models.provide，2026-11-01）：登记 / 更新 / 撤掉，按勾选的 agent 进 Claude 的注册表与 dimensio 的 plugin-providers.json；
// 成员只在勾了 members 时看得到；设置里的编辑器（getProvider）够不着；Key 只在内存。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-model-services-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const S = await import('./model-services.mjs');
const P = await import('./claude-providers.mjs');
// dimensio 扩展的写盘端用 @bridge/core 引核心：装上解析钩子（指向同一个 model-services 实例）
const { installCoreResolver } = await import('../modules/core-resolve.mjs');
installCoreResolver();
const D = await import('../../modules/dimensio/server/runtime/plugin-providers.mjs');

const spec = (over = {}) => ({
  name: 'Gemini 网页版', protocol: 'anthropic', baseUrl: 'http://127.0.0.1:8765/',
  models: [{ id: 'gemini-argon', label: 'Gemini 4 Argon', contextWindow: 200000, maxOutput: 32000, vision: false, thinking: 'effort',
    efforts: [{ id: 'medium', name: '标准', value: { gemini_thinking: false } }, { id: 'high', name: '深度思考', value: { gemini_thinking: true } }], effortDefault: 'medium' }],
  ...over,
});
const MEMBER = 'u:alice';

test('校验：坏地址、没有模型、坏 id 一律拒', () => {
  assert.throws(() => S.provideModelService('x', 'X', spec({ baseUrl: 'ftp://a' })), /baseUrl/);
  assert.throws(() => S.provideModelService('x', 'X', spec({ models: [] })), /models/);
  assert.throws(() => S.provideModelService('x', 'X', spec({ id: 'Bad Id' })), /id/);
});

test('Claude：进模型菜单、能解析、Key 在内存；编辑器够不着；成员默认看不到；撤掉就没了', () => {
  S._resetModelServicesForTests();
  const rev0 = P.providersRev();
  const h = S.provideModelService('gemini-web', 'Gemini 网页版', spec({ apiKey: 'sk-local' }));
  const pid = 'p-' + S.serviceHash('gemini-web', 'default', 10);
  const view = P.customModelsView();
  const m = view.find((x) => x.provider === pid);
  assert.ok(m, '主机的模型菜单里有');
  assert.equal(m.id, `custom:${pid}:gemini-argon`);
  assert.equal(m.plugin, 'Gemini 网页版');
  assert.deepEqual(m.efforts.map((t) => t.id), ['medium', 'high']);
  const r = P.resolveCustomModel(m.id);
  assert.equal(r.provider.baseUrl, 'http://127.0.0.1:8765');
  assert.equal(r.provider.compat.useProxy, false, '本机端点不走出站代理');
  assert.equal(P.providerKey(pid), 'sk-local');
  assert.equal(P.getProvider(pid), null, '设置里的编辑器改不到');
  assert.equal(P.listProviders().some((p) => p.id === pid), false);
  assert.deepEqual(P.providerPlugin(pid), { id: 'gemini-web', name: 'Gemini 网页版' });
  assert.notEqual(P.providersRev(), rev0, '签名跟着换');
  assert.equal(P.resolveCustomModel(m.id, MEMBER), null, '没勾 members 成员用不了');

  h.update({ members: true });
  assert.ok(P.resolveCustomModel(m.id, MEMBER), '勾了 members 成员能用');
  assert.ok(P.sharedProvidersView(MEMBER).some((p) => p.id === pid));

  h.update({ agents: ['dimensio'] });
  assert.equal(P.resolveCustomModel(m.id), null, '取消勾选 claude 就没了');
  h.update({ agents: ['claude', 'dimensio'] });
  h.dispose();
  h.dispose();
  assert.equal(P.resolveCustomModel(m.id), null);
  assert.equal(P.providerKey(pid), '');
});

test('dimensio：勾了的写进 plugin-providers.json，形状对得上 harness；撤掉写成空表', () => {
  S._resetModelServicesForTests();
  const dir = path.join(tmp, 'harness-cp');
  const stop = D.startPluginProviderSync(() => dir);
  const file = path.join(dir, D.PLUGIN_PROVIDERS_FILE);
  assert.ok(existsSync(file), '启动就写一遍（清掉旧条目）');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).providers, []);

  const onlyClaude = S.provideModelService('a', 'A', spec({ id: 'c', agents: ['claude'] }));
  const h = S.provideModelService('gemini-web', 'Gemini 网页版', spec({ members: true }));
  const list = JSON.parse(readFileSync(file, 'utf8')).providers;
  assert.equal(list.length, 1, '只写勾了 dimensio 的');
  const p = list[0];
  assert.match(p.id, /^custom-[0-9a-f]{8}$/);
  assert.equal(p.id, 'custom-' + S.serviceHash('gemini-web', 'default', 8));
  assert.deepEqual(p.models, ['gemini-argon']);
  assert.equal(p.modelSpecs[0].efforts[1].value.gemini_thinking, true);
  assert.equal(p.modelSpecs[0].effortDefault, 'medium');
  assert.equal(p.authStyle, 'none');
  assert.equal(p.shared, true);
  assert.deepEqual(p.plugin, { id: 'gemini-web', name: 'Gemini 网页版' });

  h.dispose(); onlyClaude.dispose();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).providers, []);
  stop();
});
