// 壁纸数据层（wallpaper.svelte.js）：内置壁纸（多洛米蒂为原版资源）、默认、下架壁纸 / 上传壁纸的回退。
// 做法同 devices.state.test.js：用 svelte 编译器把真的 wallpaper.svelte.js 和 overlay.svelte.js 编成客户端模块，
// 其余依赖换成桩。每个场景写进一个新的临时目录再 import（模块顶层读 localStorage / window.__OVERLAY__，要新实例）。
// 跑法（web 目录）：node --test src/lib/wallpaper.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const SV = {
  'svelte': pathToFileURL(join(svelteRoot, 'src', 'index-client.js')).href,
  'svelte/internal/client': pathToFileURL(join(svelteRoot, 'src', 'internal', 'client', 'index.js')).href,
  'svelte/internal/disclose-version': pathToFileURL(join(svelteRoot, 'src', 'internal', 'disclose-version.js')).href,
  'svelte/internal/flags/legacy': pathToFileURL(join(svelteRoot, 'src', 'internal', 'flags', 'legacy.js')).href,
};
const fixImports = (code) => code.replace(/from\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, s) => (SV[s] ? `from '${SV[s]}'` : m));

const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);
const compile = (file) => fixImports(compileModule(readFileSync(join(here, file), 'utf8'), { filename: file, generate: 'client' }).js.code)
  .replace(/import\.meta\.env\.BASE_URL/g, "'/app/'");
const MODS = { 'wallpaper.svelte.js': compile('wallpaper.svelte.js'), 'overlay.svelte.js': compile('overlay.svelte.js') };

const STUBS = {
  'state.svelte.js': `export const ui = { glassMode: 'B' };`,
  'api.js': `export const api = {
    wallpaperList: (...a) => globalThis.__wp.list(...a),
    wallpaperDelete: async () => ({ ok: true }),
  };`,
  'preview.svelte.js': `export const cloudFileUrl = (f) => '/api/file?path=' + encodeURIComponent(f);`,
  'i18n.js': `export const t = (s) => s; export const isEn = () => false;`,
};

const LS = 'bridge-wallpaper';
const VER = 'abc123';
// 构建打进壳里的清单（overlay-bundle.mjs）
const MANIFEST = {
  v: 1, name: 'bridge-private', base: '/app/_ov/', ver: VER, css: [], vars: {}, modules: {},
  files: ['overlay.json', 'wallpapers/dolomites.jpg', 'wallpapers/depth/dolomites.png'], data: {},
};
const OV_IMG = `/app/_ov/wallpapers/dolomites.jpg?v=${VER}`;
const OV_DEPTH = `/app/_ov/wallpapers/depth/dolomites.png?v=${VER}`;

const flush = () => new Promise((r) => setTimeout(r, 30));
const sel = (o) => JSON.stringify(o);

function memStore(init) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m };
}

let seq = 0;
async function boot({ storage = {}, list } = {}) {
  const store = memStore(storage);
  globalThis.localStorage = store;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, __OVERLAY__: MANIFEST };
  globalThis.__wp = { list: list || (async () => ({ items: [] })) };
  const dir = mkdtempSync(join(tmpdir(), `wallpaper-test-${++seq}-`));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const [f, src] of Object.entries({ ...STUBS, ...MODS })) writeFileSync(join(dir, f), src);
  const m = await import(pathToFileURL(join(dir, 'wallpaper.svelte.js')).href);
  return { m, store, saved: () => JSON.parse(store.getItem(LS) || 'null') };
}

test('内置：多洛米蒂为明亮默认、流光为暗色默认；地址与深度图都是原版资源', async () => {
  const a = await boot();
  assert.equal(a.m.wp.light, 'dolomites');
  assert.equal(a.m.wp.dark, 'flux');
  assert.deepEqual([...a.m.LIGHT_IDS], ['dolomites']);
  assert.deepEqual([...a.m.DARK_IDS], ['flux']);
  assert.deepEqual([...a.m.SPATIAL_IDS], ['dolomites']);
  const d = a.m.wpDef('dolomites');
  assert.equal(d.name, '多洛米蒂');
  assert.equal(d.url, OV_IMG);
  assert.equal(a.m.wpHasDepth('dolomites'), true);
  assert.equal(a.m.wpDepthUrl('dolomites'), OV_DEPTH);
  assert.equal(a.m.wpHasDepth('flux'), false);
  assert.equal(a.m.wpDef('flux').dyn, true);
  assert.equal(a.m.wpDef('nope').dyn, true, '不认识的 id 兜底成流光');
});

test('已下架的层峦（ridges）：显示多洛米蒂，不改写本机；重新选了才写', async () => {
  const a = await boot({ storage: { [LS]: sel({ light: 'ridges', dark: 'flux' }) } });
  assert.equal(a.m.wp.light, 'dolomites');
  await flush();
  assert.equal(a.m.wp.light, 'dolomites');
  assert.equal(a.saved().light, 'ridges');
  a.m.setWp('light', 'dolomites');
  assert.equal(a.saved().light, 'dolomites');
  assert.equal(a.m.wp.light, 'dolomites');
});

test('上传壁纸：清单拉到之前先按选的算，拉到了没有它 → 默认（pref 不动）', async () => {
  const up = { id: 'up-1', name: '我的', sys: 'light', hasDepth: true, file: '壁纸/a.jpg', depthFile: '壁纸/a-depth.png' };
  const a = await boot({ storage: { [LS]: sel({ light: 'up-1', dark: 'flux' }) }, list: async () => ({ items: [up] }) });
  assert.equal(a.m.wp.light, 'up-1');
  await flush();
  assert.equal(a.m.wp.ready, true);
  assert.equal(a.m.wp.light, 'up-1');
  assert.equal(a.m.wpDef('up-1').url, '/api/file?path=' + encodeURIComponent('壁纸/a.jpg'));
  assert.equal(a.m.wpHasDepth('up-1'), true);
  await a.m.deleteUpload('up-1');
  assert.equal(a.m.wp.light, 'dolomites');
  assert.equal(a.saved().light, null, '删掉正在用的上传壁纸 → 选择清空');

  // 实例共用 globalThis.localStorage，b 起来之后 a 再写就写到 b 的存储里了：a 的断言放在前面
  const b = await boot({ storage: { [LS]: sel({ light: 'up-gone', dark: 'flux' }) } });
  await flush();
  assert.equal(b.m.wp.light, 'dolomites');
  assert.equal(b.saved().light, 'up-gone');
});
