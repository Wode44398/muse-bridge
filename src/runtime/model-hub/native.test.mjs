// dimensio 自带适配的厂商交给模型中心（2026-11-11，src/model-knowledge/dimensio-native.mjs）：
// 按识别建的服务按地址认厂商（native）；发布时带上厂商 id、第一条可用线路的 Key、专门适配该打的地址；
// dimensio 扩展迁移做完之前照普通服务登记，做完之后落在 plugin-providers.json 的 builtins 上；一次性迁移（Key 来源、地址、重名、读不出 Key）。
// 数据根是临时目录，不联网、不碰真实数据与 Key。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-hub-native-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
delete process.env.VERTEX_PROJECT;

const S = await import('../model-services.mjs');
const R = await import('./registry.mjs');
const G = await import('./gateway.mjs');
const O = await import('./overview.mjs');
const L = await import('./studio-link.mjs');
const { writeSecrets } = await import('../../extension-secrets.mjs');
const { installCoreResolver } = await import('../../modules/core-resolve.mjs');
installCoreResolver();
const D = await import('../../../modules/dimensio/server/runtime/plugin-providers.mjs');
const M = await import('../../../modules/dimensio/server/runtime/native-migrate.mjs');

L._setStudioBridgeForTests(null);
after(async () => { await G._stopGatewayForTests(); L._setStudioBridgeForTests(undefined); });

const HUB = path.join(tmp, 'hub');
R._resetHubForTests(HUB);
await R.initModelHub();

const CP = path.join(tmp, 'custom-providers');   // 管理员实例的自定义服务目录
mkdirSync(CP, { recursive: true });
const stop = D.startPluginProviderSync(() => CP);
after(() => stop());
const disk = () => JSON.parse(readFileSync(path.join(CP, 'plugin-providers.json'), 'utf8'));
const noKeyIn = (v, k) => assert.ok(!JSON.stringify(v).includes(k), `漏了 Key「${k}」`);

let DS;   // 按识别建的 DeepSeek 服务（填的是给 Claude 用的 /anthropic 入口）
test('按识别建服务：地址是自带适配的厂商就记上 native；别家的地址不记', () => {
  DS = R.createHubFromDetect({
    baseUrl: 'https://api.deepseek.com/anthropic', kind: 'anthropic', key: 'k-ds-111111',
    catalog: [{ id: 'deepseek-flash', kind: 'text' }, { id: 'deepseek-v9', kind: 'text' }],
    assign: [{ id: 'deepseek-flash', agents: ['claude', 'dimensio'] }, { id: 'deepseek-v9', agents: ['dimensio'] }],
  }).service;
  assert.equal(DS.native, 'openai');
  noKeyIn(DS, 'k-ds-111111');
  const or = R.createHubFromDetect({
    baseUrl: 'https://openrouter.ai/api/v1', kind: 'openai', key: 'k-or-222222',
    catalog: [{ id: 'openai/gpt-x', kind: 'text' }], assign: [{ id: 'openai/gpt-x', agents: ['dimensio'] }],
  }).service;
  assert.equal(or.native, '');
  // 老接口建的（收编 Claude / dimensio 的服务）不按地址认：它们在 dimensio 里的服务 id 不能变
  const legacy = R.createHubService({ name: 'DS 老服务', kind: 'openai', baseUrl: 'https://api.deepseek.com', models: [{ id: 'deepseek-flash' }], lines: [{ key: 'k-old-333333' }] });
  assert.equal(legacy.native, '');
  R.deleteHubV2(legacy.id);
  // 落盘带 native、不带 Key
  const text = readFileSync(path.join(HUB, 'services.json'), 'utf8');
  assert.ok(text.includes('"native": "openai"'));
  noKeyIn(text, 'k-ds-111111');
});

test('发布：带 native 的服务多一份 { vendor, key, baseUrl }；Claude 那边照旧走网关', () => {
  const s = S.modelServices('dimensio').find((x) => x.sid === DS.id);
  assert.deepEqual(s.native, { vendor: 'openai', key: 'k-ds-111111', baseUrl: '' });   // 填的是 /anthropic 入口：专门适配用它自己的默认地址
  assert.deepEqual(s.models.map((m) => m.id), ['deepseek-flash', 'deepseek-v9']);
  const c = S.modelServices('claude').find((x) => x.sid === DS.id);
  assert.match(c.baseUrl, /^http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(c.models.map((m) => m.id), ['deepseek-flash']);
});

test('迁移做完之前：照普通服务登记（文件里没有 builtins，harness 照老样子用自己的 Key）', () => {
  assert.equal(R.hubFlag('dimensioNative'), false);
  assert.equal(O.hubOverview().dimensioNative, false);
  const d = disk();
  assert.equal(d.builtins, undefined);
  assert.equal(d.providers.length, 2);
  assert.ok(d.providers.every((p) => /^http:\/\/127\.0\.0\.1:/.test(p.baseUrl)));
});

test('迁移：Key 读不出来就整个不搬、不记号', () => {
  const bad = path.join(tmp, 'cp-bad');
  mkdirSync(bad, { recursive: true });
  writeFileSync(path.join(bad, 'connector-secrets.json'), '{ 坏的');
  const r = M.migrateNativeVendors({ envFile: '', dir: bad, env: { KIMI_API_KEY: 'k-kimi-zzzzzz' } });
  assert.equal(r.done, false);
  assert.equal(R.hubFlag('dimensioNative'), false);
  assert.equal(R.listHubServices().length, 2);
});

test('迁移：配了 Key 的厂商各建一个服务（设置页存的 > 环境；地址照环境变量 / Key 前缀），已有的那家不重复建，重名的加后缀', () => {
  // 一个碰巧也叫 Kimi 的普通服务；一个以前就有的智谱服务（没有 native 记号，填的是给 Claude 用的入口）
  R.createHubService({ name: '智谱', kind: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: [{ id: 'glm-5.2' }], lines: [{ key: 'k-zp-old-1212' }] });
  R.createHubService({ name: 'Kimi', kind: 'openai', baseUrl: 'https://example.com/v1', models: [{ id: 'm1' }], lines: [{ key: 'k-other-444444' }] });
  writeSecrets(CP, { zhipu: { headers: { apiKey: 'k-zhipu-saved-55' } }, 'custom-0a1b2c3d': { headers: { apiKey: 'k-custom-666666' } } });
  const envFile = path.join(tmp, 'harness.env');
  writeFileSync(envFile, 'KIMI_API_KEY=k-kimi-file-7777\nZHIPU_API_KEY=k-zhipu-env-8888\nVISION_API_KEY=k-vision-999999\nVISION_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1/\nANTHROPIC_API_KEY=\n');
  const r = M.migrateNativeVendors({ envFile, dir: CP, env: { MIMO_API_KEY: 'tp-mimo-aaaaaa', OPENAI_API_KEY: 'k-ds-env-bbbbbb' } });
  assert.equal(r.done, true);
  assert.deepEqual(r.created, ['Qwen', 'Zhipu GLM · dimensio', 'Kimi · dimensio', 'Xiaomi MiMo']);
  assert.equal(r.skipped.length, 1);   // DeepSeek：模型中心里已经有带 native 的服务
  assert.match(r.skipped[0], /DeepSeek/);
  assert.equal(R.hubFlag('dimensioNative'), true);
  assert.equal(O.hubOverview().dimensioNative, true);
  assert.ok(existsSync(path.join(HUB, 'services.pre-native.bak.json')));
  const by = (n) => R.listHubServices().find((s) => s.native === n);
  assert.equal(by('qwen').baseUrl, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  assert.equal(by('zhipu').baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(by('kimi').baseUrl, 'https://api.kimi.com/coding/v1');
  assert.equal(by('mimo').baseUrl, 'https://token-plan-cn.xiaomimimo.com/v1');   // tp- 开头的 Key 是 Token Plan
  assert.equal(by('anthropic'), undefined);   // 没配 Key 的不建
  assert.equal(by('gemini'), undefined);
  for (const n of ['qwen', 'zhipu', 'kimi', 'mimo']) {
    const s = by(n);
    assert.deepEqual(s.agents, ['dimensio'], n);
    assert.ok(s.models.every((m) => m.kind === 'text' && m.agents.length === 1 && m.agents[0] === 'dimensio'), n);
    assert.equal(s.lines.length, 1);
    assert.equal(s.lines[0].hasKey, true);
  }
  assert.deepEqual(by('kimi').models.map((m) => m.id), ['k3.1-pro', 'k3.1-pro-highspeed', 'k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed']);
  for (const k of ['k-kimi-file-7777', 'k-zhipu-saved-55', 'k-vision-999999', 'tp-mimo-aaaaaa']) noKeyIn(R.listHubServices(), k);
  // 再跑一次什么都不做
  assert.deepEqual(M.migrateNativeVendors({ envFile, dir: CP, env: {} }), { done: false, created: [], skipped: [] });
  assert.equal(R.listHubServices().length, 8);
});

test('迁移做完之后：带 native 的服务落在 builtins 上（Key、地址、勾给 dimensio 的型号），不再登记成卡', () => {
  const d = disk();
  assert.deepEqual(Object.keys(d.builtins).sort(), ['kimi', 'mimo', 'openai', 'qwen', 'zhipu']);
  assert.equal(d.builtins.zhipu.key, 'k-zhipu-saved-55');   // 设置页存的优先于环境里的
  assert.equal(d.builtins.kimi.key, 'k-kimi-file-7777');
  assert.equal(d.builtins.kimi.baseUrl, 'https://api.kimi.com/coding/v1');
  assert.equal(d.builtins.mimo.baseUrl, 'https://token-plan-cn.xiaomimimo.com/v1');
  assert.equal(d.builtins.openai.key, 'k-ds-111111');
  assert.equal(d.builtins.openai.baseUrl, undefined);
  assert.deepEqual(d.builtins.openai.models.map((m) => m.id), ['deepseek-flash', 'deepseek-v9']);
  assert.deepEqual(d.builtins.openai.plugin, { id: 'model-hub', name: '模型中心', sid: DS.id, logo: 'deepseek-color' });
  assert.equal(d.builtins.kimi.name, 'Kimi · dimensio');
  // 剩下的普通服务：OpenRouter 和那个碰巧叫 Kimi 的
  assert.deepEqual(d.providers.map((p) => p.name).sort(), ['Kimi', 'OpenRouter', '智谱']);
});

test('同一家的第二个服务照普通服务登记；停用 / 取消勾选 / 删掉第一家，这家就让给下一个或空出来', () => {
  const second = R.createHubFromDetect({
    baseUrl: 'https://api.deepseek.com', kind: 'openai', key: 'k-ds2-cccccc',
    catalog: [{ id: 'deepseek-flash', kind: 'text' }], assign: [{ id: 'deepseek-flash', agents: ['dimensio'] }],
  }).service;
  assert.equal(second.native, 'openai');
  let d = disk();
  assert.equal(d.builtins.openai.key, 'k-ds-111111');
  assert.ok(d.providers.some((p) => p.plugin.sid === second.id));
  // 第一家取消全部 dimensio 勾选：让给第二家（它填的就是 OpenAI 兼容地址，照它的地址）
  R.assignHubModels(DS.id, [{ id: 'deepseek-flash', agents: ['claude'] }, { id: 'deepseek-v9', agents: [] }]);
  d = disk();
  assert.equal(d.builtins.openai.key, 'k-ds2-cccccc');
  assert.equal(d.builtins.openai.baseUrl, 'https://api.deepseek.com');
  assert.ok(!d.providers.some((p) => p.plugin.sid === second.id));
  // 停用第二家：这家空出来
  R.updateHubV2(second.id, { enabled: false });
  assert.equal(disk().builtins.openai, undefined);
  R.updateHubV2(second.id, { enabled: true });
  assert.equal(disk().builtins.openai.key, 'k-ds2-cccccc');
  R.deleteHubV2(second.id);
  assert.equal(disk().builtins.openai, undefined);
});

test('改了地址才重认厂商；换 Key 立刻跟上', () => {
  const kimi = R.listHubServices().find((s) => s.native === 'kimi');
  const line = kimi.lines[0].id;
  R.updateHubV2(kimi.id, { lines: [{ id: line, key: 'k-kimi-new-dddd' }] });
  assert.equal(disk().builtins.kimi.key, 'k-kimi-new-dddd');
  assert.equal(R.updateHubV2(kimi.id, { name: '我的 Kimi' }).service.native, 'kimi');
  // 改到别家的地址：不再是自带适配的厂商，变成一张普通的卡
  assert.equal(R.updateHubV2(kimi.id, { baseUrl: 'https://example.org/v1' }).service.native, '');
  let d = disk();
  assert.equal(d.builtins.kimi, undefined);
  assert.ok(d.providers.some((p) => p.name === '我的 Kimi'));
  // 改回来也不重认：没有记号的服务一律不按地址猜（以前就有的服务在 dimensio 里的服务 id 不能变），要走专门适配就重新添加
  assert.equal(R.updateHubV2(kimi.id, { baseUrl: 'https://api.kimi.com/coding/v1' }).service.native, '');
});
