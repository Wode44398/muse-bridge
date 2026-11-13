// 设置 › Media Studio 的英文显示：服务端报错 / 测试结果经 trErr()（settings.svelte.js）与字典模式键翻成英文。
// 做法同 settings.state.test.js：svelte 编译器把真模块编成客户端模块，除 i18n 外的依赖换成桩；
// i18n 用真的 lib/i18n.js，预先把全局状态设成英文并灌入 i18n/en 的全部字典（= 线上 ?lang=en 的样子）。
// 跑法：node --test web/src/modules/studio/settings.i18n.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', '..');
const repoRoot = join(webRoot, '..');
const require = createRequire(join(webRoot, 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const SV = {
  'svelte': pathToFileURL(join(svelteRoot, 'src', 'index-client.js')).href,
  'svelte/internal/client': pathToFileURL(join(svelteRoot, 'src', 'internal', 'client', 'index.js')).href,
  'svelte/internal/disclose-version': pathToFileURL(join(svelteRoot, 'src', 'internal', 'disclose-version.js')).href,
  'svelte/internal/flags/legacy': pathToFileURL(join(svelteRoot, 'src', 'internal', 'flags', 'legacy.js')).href,
};
const fixImports = (code) => code.replace(/from\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, s) => (SV[s] ? `from '${SV[s]}'` : m));
const realI18n = pathToFileURL(join(webRoot, 'src', 'lib', 'i18n.js')).href;
const registryUrl = pathToFileURL(join(repoRoot, 'src', 'config', 'studio-settings.mjs')).href;

// 英文界面：全局 i18n 状态（lib/i18n.js 的 G）先设好，再加载模块
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.location = { search: '?lang=en', pathname: '/' };
const dict = Object.create(null);
const enDir = join(webRoot, 'src', 'i18n', 'en');
for (const f of readdirSync(enDir)) if (f.endsWith('.js') && f !== 'index.js') Object.assign(dict, (await import(pathToFileURL(join(enDir, f)).href)).default);
globalThis.__bridgeI18n = { lang: 'en', dict, pats: null };

const STUBS = {
  'lib/api.js': `export const api = { async get() { return {}; }, async post() { return {}; } };`,
  'lib/bus.js': `export const busOn = () => () => {};`,
  'lib/state.svelte.js': `export const me = { kind: 'admin' };`,
  'lib/i18n.js': `export * from '${realI18n}';`,
  'lib/providerLogos.js': readFileSync(join(webRoot, 'src', 'lib', 'providerLogos.js'), 'utf8'),
  'modules/studio/settingsRegistry.js': readFileSync(join(here, 'settingsRegistry.js'), 'utf8').replaceAll('../../../../src/config/studio-settings.mjs', registryUrl),
  'modules/studio/icons.js': readFileSync(join(here, 'icons.js'), 'utf8'),   // 种类字形（设置页与 Studio 共用一套线稿）
};
const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);
const dir = mkdtempSync(join(tmpdir(), 'studio-settings-i18n-'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
for (const [f, src] of Object.entries(STUBS)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), src); }
const out = compileModule(readFileSync(join(here, 'settings.svelte.js'), 'utf8'), { filename: 'settings.svelte.js', generate: 'client' }).js.code;
writeFileSync(join(dir, 'modules', 'studio', 'settings.svelte.js'), fixImports(out).replaceAll('import.meta.env.DEV', 'false'));
const m = await import(pathToFileURL(join(dir, 'modules', 'studio', 'settings.svelte.js')).href);
const { tr, isEn } = await import(realI18n);

test('英文界面', () => assert.equal(isEn(), true));

test('「服务名 状态码：说明（上游原话）」：服务名带空格也不切错，上游原话原样留着', () => {
  // 服务名就是预设名（字典里有译名）、带空格；返回的是网页
  assert.equal(m.trErr('OpenAI 兼容（自定义） 404：接口或模型不存在（检查地址和模型 id）（对方回的是网页，不是接口——检查接口地址）'),
    'OpenAI compatible (custom) 404: The endpoint or model doesn’t exist (check the endpoint and model ID) (the server returned a web page, not an API — check the endpoint)');
  // 上游给了英文原话
  assert.equal(m.trErr('fal 401：API Key 无效或没权限（Invalid API key）'), 'fal 401: The API key is invalid or lacks permission (Invalid API key)');
  // 参数错没有说明，只有原话
  assert.equal(m.trErr('Replicate 422：input.prompt is required'), 'Replicate 422: input.prompt is required');
  // 不带服务名
  assert.equal(m.trErr('429：被限流了，稍后再试'), '429: Rate limited; try again later');
});

test('后端测试结果 / 报错的模式键（studio-backend e7cffc97 的清单）', () => {
  const cases = [
    ['剩余额度 $99.60', 'Remaining credit $99.60'],
    ['项目 bridge-media · global / us-central1', 'Project bridge-media · global / us-central1'],
    ['Key 有效（套餐 creator）', 'Key is valid (plan creator)'],
    ['剩余 9000 字符（套餐 starter，本周期已用 1000 / 上限 10000）', '9000 characters left (plan starter, 1000 / 10000 used this period)'],
    ['Key 有效（fal-ai/flux/dev 单价 $0.025 / image）', 'Key is valid (fal-ai/flux/dev costs $0.025 / image)'],
    ['Key 有效（系统音色 1 个）', 'Key is valid (1 system voice)'],
    ['Key 有效（系统音色 300 个）', 'Key is valid (300 system voices)'],
    ['连接正常，接口列出 12 个模型', 'Connected; the API listed 12 models'],
    ['已连上 Replicate，账号 alice', 'Connected to Replicate as alice'],
    ['已连上 Replicate，账号 （没返回用户名）', 'Connected to Replicate as (no username returned)'],
    ['状态：stopped', 'Status: stopped'],
    ['接口地址 192.168.1.10 是内网 / 本机地址，只有主机管理员能接', 'Endpoint 192.168.1.10 is a local or private address; only the server admin can connect it'],
    ['接口地址 localtest.me 解析到内网地址 127.0.0.1，只有主机管理员能接', 'Endpoint localtest.me resolves to the private address 127.0.0.1; only the server admin can connect it'],
    ['连不上服务（ECONNRESET）', 'Couldn’t reach the service (ECONNRESET)'],
    ['请求超过 30 秒没有回应', 'Request didn’t respond within 30 seconds'],
    ['默认模型里的服务不存在：p-0a1b0000', 'The provider in the default models doesn’t exist: p-0a1b0000'],
    ['服务「OpenRouter」里没有这个视频模型：veo', 'Provider “OpenRouter” has no such video model: veo'],
    ['已安装，还没启动', 'Installed, not started yet'],
  ];
  for (const [zh, en] of cases) assert.equal(m.trErr(zh), en, zh);
});

test('整句 tr() 遇到带空格的服务名：服务名完整留着，不被切碎', () => {
  // Studio 页面这类没走 trErr 的地方：'{status}：{hint}（对方回的是网页…）' 把「服务名 状态码」整段放进 {status}
  assert.equal(tr('我的 图像服务 404：接口或模型不存在（检查地址和模型 id）（对方回的是网页，不是接口——检查接口地址）'),
    '我的 图像服务 404: The endpoint or model doesn’t exist (check the endpoint and model ID) (the server returned a web page, not an API — check the endpoint)');
});

test('没收录的句子原样返回（中文界面同样原样）', () => {
  assert.equal(m.trErr('一句没收录的话'), '一句没收录的话');
  assert.equal(m.trErr(''), '');
  assert.equal(m.trErr(null), '');
});
