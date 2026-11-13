// Vertex 上游浮层（HubVertex.svelte）的模板——服务端渲染成 HTML 再看结构，不起浏览器：
//   · 「Google 云凭据」卡直接嵌在面板里（11-13 起凭据接口在核心，关了 Media Studio 也能配）；没配好时卡下面一句提示
//   · 「共享给成员」只在多用户服务器的管理员（cp.canShare）那里出现，状态取自 vertex.members
//   · 「提供给」的勾选片带 agent 图标（与服务浮层操作条的去向片同一副长相）
//   · 保存钮：没改动时禁用、不带 busy
// 点击本身要 DOM，这里不测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', '..', '..');
const require = createRequire(join(WEB, 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const url = (...p) => pathToFileURL(join(svelteRoot, ...p)).href;
const SV = {
  'svelte': url('src', 'index-server.js'),
  'svelte/internal/server': url('src', 'internal', 'server', 'index.js'),
  'svelte/internal/disclose-version': url('src', 'internal', 'disclose-version.js'),
  'svelte/internal/flags/legacy': url('src', 'internal', 'flags', 'legacy.js'),
};
const fix = (code) => code
  .replace(/(from|import)\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, kw, s) => (SV[s] ? `${kw} '${SV[s]}'` : m))
  .replace(/(from\s+['"][^'"]+\.svelte)(['"])/g, '$1.js$2');
const { compile, compileModule } = await import(url('src', 'compiler', 'index.js'));
const { render } = await import(url('src', 'server', 'index.js'));

const dir = mkdtempSync(join(tmpdir(), 'hubvertex-test-'));
const put = (rel, code) => { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, code); };
const comp = (rel, src) => put(rel + '.js', fix(compile(src, { filename: rel, generate: 'server' }).js.code));
const mod = (rel, src) => put(rel, fix(compileModule(src, { filename: rel, generate: 'server' }).js.code));
put('package.json', '{"type":"module"}');

const MH = 'web/src/components/modelhub/';
comp(MH + 'HubVertex.svelte', readFileSync(join(here, 'HubVertex.svelte'), 'utf8'));
mod('web/src/lib/modelHub.svelte.js', readFileSync(join(WEB, 'src', 'lib', 'modelHub.svelte.js'), 'utf8'));
comp(MH + 'AgentStack.svelte', '<script>let { agents = [], size = 16, quiet = false } = $props();</script><i class="stack" data-agents={agents.join(",")} data-size={size} data-quiet={quiet}></i>');
comp('web/src/components/settings/SToggle.svelte', '<script>let { checked = false, label = "" } = $props();</script><i class="stg" data-on={checked} data-label={label}></i>');
put('web/src/lib/toast.svelte.js', 'export const showToast = () => {};');
put('web/src/lib/api.js', 'export const api = { get: async () => ({}), post: async () => ({}) };');
put('web/src/lib/state.svelte.js', 'export const me = { kind: "admin" };');
put('web/src/lib/claudeProviders.svelte.js', 'export const cp = { ok: true, canShare: false }; export const loadProviders = () => {}; export const canUseCustomApi = () => true; export const cpSummaryText = () => "";');
comp(MH + 'VertexCredentials.svelte', '<i class="vxc-stub"></i>');
comp(MH + 'BuiltinModels.svelte', '<script>let { models = [], on = $bindable({}) } = $props();</script><i class="bm-stub" data-n={models.length}></i>');
put('web/src/lib/settingsNav.svelte.js', 'export const openSettingsFromChat = () => true;');
put('web/src/lib/i18n.js', `export const t = (s, p) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (p && k in p ? p[k] : m));
export const tr = (s) => s;`);

const H = await import(pathToFileURL(join(dir, 'web', 'src', 'lib', 'modelHub.svelte.js')).href);
const CP = await import(pathToFileURL(join(dir, 'web', 'src', 'lib', 'claudeProviders.svelte.js')).href);
const Vertex = (await import(pathToFileURL(join(dir, MH + 'HubVertex.svelte.js')).href)).default;
const KNOWN = [{ id: 'gemini-4-carbon', label: 'Gemini 4 Carbon' }, { id: 'gemini-4-argon', label: 'Gemini 4 Argon' }];
const html = (vertex, { canShare = false } = {}) => {
  CP.cp.canShare = canShare;
  Object.assign(H.hub, { ok: true, v2: true, vertex });
  return render(Vertex, { props: { onClose() {} } }).body.replace(/<!--.*?-->/g, '').replace(/ svelte-[a-z0-9]+/g, '');
};

test('凭据卡嵌在面板里；没配好时卡下面一句提示，配好了没有', () => {
  const off = html({ enabled: true, configured: false, agents: ['claude', 'dimensio'], models: ['gemini-4-carbon'], known: KNOWN });
  assert.match(off, /<div class="vxwrap"><i class="vxc-stub"><\/i><\/div>/);
  assert.match(off, /<p class="hint">/);
  assert.ok(!off.includes('class="note"') && !off.includes('去 Media Studio 设置'));
  const on = html({ enabled: true, configured: true, agents: ['claude'], models: ['gemini-4-carbon'], known: KNOWN });
  assert.match(on, /<i class="vxc-stub"><\/i>/);
  assert.ok(!on.includes('class="hint"'));
});

test('共享给成员：只有 canShare 时出现，开关状态取自 vertex.members', () => {
  const v = { enabled: true, configured: true, agents: ['dimensio'], models: ['gemini-4-carbon'], known: KNOWN };
  assert.ok(!html(v).includes('共享给成员'));
  assert.match(html({ ...v, members: true }, { canShare: true }), /<span class="tog-l">共享给成员<\/span>\s*<i class="stg" data-on="true" data-label="共享给成员"><\/i>/);
  assert.match(html(v, { canShare: true }), /data-on="false" data-label="共享给成员"/);
});

test('「提供给」：勾选框 + agent 图标（纯装饰）+ 名字；勾上的带 on', () => {
  const h = html({ enabled: true, configured: true, agents: ['dimensio'], models: ['gemini-4-carbon'], known: KNOWN });
  const chips = [...h.matchAll(/<button type="button" class="chk( on)?" aria-pressed="(true|false)">(.*?)<\/button>/g)];
  assert.equal(chips.length, 2);
  const [claude, dim] = chips;
  assert.equal(claude[1], undefined);
  assert.equal(claude[2], 'false');
  assert.match(claude[3], /<span class="box">.*<\/span>\s*<i class="stack" data-agents="claude" data-size="16" data-quiet="true"><\/i>\s*<span class="chk-n">Claude<\/span>/);
  assert.equal(dim[1], ' on');
  assert.equal(dim[2], 'true');
  assert.match(dim[3], /data-agents="dimensio".*<span class="chk-n">dimensio<\/span>/);
});

test('启用开关：标签与开关成对；保存钮没改动时禁用、不带 busy', () => {
  const h = html({ enabled: false, configured: true, agents: ['claude'], models: ['gemini-4-carbon'], known: KNOWN });
  assert.match(h, /<label class="tog"><span class="tog-l">启用<\/span>\s*<i class="stg" data-on="false" data-label="启用 Vertex"><\/i><\/label>/);
  assert.match(h, /<button type="button" class="btn primary" disabled(="")?>保存<\/button>/);
  assert.ok(!/class="btn primary busy"/.test(h));
});

test('型号：已知的列出来、勾上的带 on；已添加但不在已知表里的补在后面', () => {
  const h = html({ enabled: true, configured: true, agents: ['claude'], models: ['gemini-4-argon', 'my-tuned-model'], known: KNOWN });
  const rows = [...h.matchAll(/<button type="button" class="mrow( on)?" aria-pressed="(true|false)">.*?<span class="m-n">([^<]*)<\/span>/g)].map((m) => [m[3], m[2]]);
  assert.deepEqual(rows, [['Gemini 4 Carbon', 'false'], ['Gemini 4 Argon', 'true'], ['my-tuned-model', 'true']]);
});
