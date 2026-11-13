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
  // sid：提供方那边的服务 id（卡片据此跳回去改）；没给 logo 的不带 logo 字段
  assert.equal(p.plugin.id, 'gemini-web');
  assert.equal(p.plugin.name, 'Gemini 网页版');
  assert.match(p.plugin.sid, /^[a-z0-9][a-z0-9-]{0,31}$/);
  assert.ok(!('logo' in p.plugin));

  h.dispose(); onlyClaude.dispose();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).providers, []);
  stop();
});

// —— 模型级 agents（2026-11-10 模型中心 v2：同一服务里每个模型各自给哪些 agent，服务 id 不拆不变）——
const three = (over = {}) => spec({
  models: [
    { id: 'a', label: 'A', agents: ['claude'] },
    { id: 'b', label: 'B', agents: ['dimensio'] },
    { id: 'c', label: 'C', agents: ['claude', 'dimensio'] },
  ],
  ...over,
});

test('模型级 agents：a 只给 Claude、b 只给 dimensio、c 两边；两侧 id 与不带 agents 时一样', () => {
  S._resetModelServicesForTests();
  const dir = path.join(tmp, 'harness-cp-agents');
  const stop = D.startPluginProviderSync(() => dir);
  const file = path.join(dir, D.PLUGIN_PROVIDERS_FILE);
  const pid = 'p-' + S.serviceHash('hub', 'svc', 10);
  const did = 'custom-' + S.serviceHash('hub', 'svc', 8);

  // 先按老写法（不带模型级 agents）登记一次，记下两侧 id
  const h = S.provideModelService('hub', '模型中心', spec({ id: 'svc', models: ['a', 'b', 'c'] }));
  assert.ok(P.customModelsView().some((m) => m.id === `custom:${pid}:a`));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).providers[0].id, did);

  h.update({ models: three().models, defaultModel: 'b' });
  const claude = S.modelServices('claude');
  assert.equal(claude.length, 1);
  assert.deepEqual(claude[0].models.map((m) => m.id), ['a', 'c']);
  assert.equal(claude[0].defaultModel, 'a', '默认模型 b 不给 Claude：回落到剩下的第一个');
  const dim = S.modelServices('dimensio');
  assert.deepEqual(dim[0].models.map((m) => m.id), ['b', 'c']);
  assert.equal(dim[0].defaultModel, 'b');
  assert.equal(S.modelServices().length, 1);
  assert.deepEqual(S.modelServices()[0].models.map((m) => m.id), ['a', 'b', 'c'], '不带 agent 参数：全量原样');

  const ids = P.customModelsView().filter((m) => m.provider === pid).map((m) => m.id).sort();
  assert.deepEqual(ids, [`custom:${pid}:a`, `custom:${pid}:c`], 'Claude 的服务 id 不变，只剩 a、c');
  assert.equal(P.resolveCustomModel(`custom:${pid}:b`), null);
  const list = JSON.parse(readFileSync(file, 'utf8')).providers;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, did, 'dimensio 的服务 id 不变');
  assert.deepEqual(list[0].models, ['b', 'c']);
  assert.equal(list[0].defaultModel, 'b');
  h.dispose();
  stop();
});

test('模型级 agents：某一侧一个不剩就整条不出现；坏值清洗；gemini 去掉 claude；跟服务级取交集', () => {
  S._resetModelServicesForTests();
  const h = S.provideModelService('hub', '模型中心', spec({ id: 'only-d', models: [{ id: 'x', agents: ['dimensio'] }, { id: 'y', agents: ['dimensio', 'studio', 7, 'claude-x'] }] }));
  assert.equal(S.modelServices('claude').length, 0, 'Claude 一侧没有模型：整条不出现');
  assert.equal(P.customModelsView().some((m) => m.provider === 'p-' + S.serviceHash('hub', 'only-d', 10)), false);
  const rec = S.modelServices()[0];
  assert.deepEqual(rec.models[1].agents, ['dimensio'], '不认识的去向清掉');

  // 服务级只给 dimensio：模型上写了 claude 也不算
  h.update({ agents: ['dimensio'], models: [{ id: 'x', agents: ['claude', 'dimensio'] }] });
  assert.deepEqual(S.modelServices()[0].models[0].agents, ['dimensio']);
  assert.equal(S.modelServices('claude').length, 0);

  // gemini 协议：模型上的 claude 也去掉
  const g = S.provideModelService('hub', '模型中心', spec({ id: 'gem', protocol: 'gemini', models: [{ id: 'g1', agents: ['claude', 'dimensio'] }, { id: 'g2', agents: ['claude'] }] }));
  const gem = S.modelServices().find((s) => s.sid === 'gem');
  assert.deepEqual(gem.models.map((m) => m.agents), [['dimensio'], []]);
  assert.deepEqual(S.modelServices('dimensio').find((s) => s.sid === 'gem').models.map((m) => m.id), ['g1']);
  assert.equal(S.modelServices('claude').some((s) => s.sid === 'gem'), false);
  g.dispose(); h.dispose();
});

test('模型级 agents：老插件不传时逐字段不变，modelServices(agent) 返回的就是原记录', () => {
  S._resetModelServicesForTests();
  const h = S.provideModelService('gemini-web', 'Gemini 网页版', spec());
  const all = S.modelServices();
  assert.equal(all.length, 1);
  assert.equal(Object.hasOwn(all[0].models[0], 'agents'), false, '没给就不多出 agents 字段');
  assert.deepEqual(all[0].models[0], spec().models[0]);
  assert.equal(S.modelServices('claude')[0], all[0], '没筛掉模型：原记录');
  assert.equal(S.modelServices('dimensio')[0], all[0]);
  h.dispose();
});

test('Claude：一个模型 id 不合 Claude 的规则只跳过它自己，不连累整条服务', () => {
  S._resetModelServicesForTests();
  const h = S.provideModelService('hub', '模型中心', spec({ id: 'mixed', models: ['good-1', 'bad?id', 'good-2'].map((id) => ({ id })) }));
  const pid = 'p-' + S.serviceHash('hub', 'mixed', 10);
  // model-services 自己只拦空白与控制字符，「bad?id」能登记；Claude 的规则更严（不收问号）
  assert.equal(S.modelServices('claude')[0].models.length, 3);
  const ids = P.customModelsView().filter((m) => m.provider === pid).map((m) => m.id).sort();
  assert.deepEqual(ids, [`custom:${pid}:good-1`, `custom:${pid}:good-2`]);
  h.dispose();
});

test('logo：提供方给的品牌标的键原样带给 dimensio；不合法的丢掉', () => {
  S._resetModelServicesForTests();
  const h = S.provideModelService('model-hub', '模型中心', { id: 'h-00aa11bb', name: 'OpenRouter', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/x', models: ['a/b'], logo: 'openrouter' });
  const rec = S.modelServices('dimensio')[0];
  assert.equal(rec.logo, 'openrouter');
  const p = D.toHarnessProvider(rec);
  assert.deepEqual(p.plugin, { id: 'model-hub', name: '模型中心', sid: 'h-00aa11bb', logo: 'openrouter' });
  h.update({ logo: '<svg onload=x>' });
  assert.equal(S.modelServices('dimensio')[0].logo, '');
  h.dispose();
});
