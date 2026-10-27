// 壁纸数据层（wallpaper.svelte.js）与私有 overlay 壁纸（清单 data.wallpapers）的合并、默认、回退。
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
  'state.svelte.js': `export const ui = { glassMode: 'B' }; export function setHomeModeGuard() {}`,
  'api.js': `export const api = {
    wallpaperList: (...a) => globalThis.__wp.list(...a),
    wallpaperDelete: async () => ({ ok: true }),
  };`,
  'preview.svelte.js': `export const cloudFileUrl = (f) => '/api/file?path=' + encodeURIComponent(f);`,
  'i18n.js': `export const t = (s) => s; export const isEn = () => !!globalThis.__wp.en;`,
  'liquidGlass.js': `export const IS_IOS = false;`,
  'server.js': `export const getServerBase = () => globalThis.__wp.serverBase || '';
    export const isOffline = () => !!globalThis.__wp.offline;
    export const onServerBaseChange = () => () => {};
    export const onServerRecovered = () => () => {};`,
};

const LS = 'bridge-wallpaper';
const VER = 'abc123';
const DOLO = { id: 'dolomites', name: '多洛米蒂', name_en: 'Dolomites', src: 'wallpapers/dolomites.jpg', depth: 'wallpapers/depth/dolomites.png', sys: 'light', default: true };
const manifest = (wallpapers = [DOLO], extraFiles = []) => ({
  v: 1, name: 'bridge-private', base: '/app/_ov/', ver: VER, css: [], vars: {}, modules: {},
  files: ['overlay.json', 'wallpapers/dolomites.jpg', 'wallpapers/depth/dolomites.png', ...extraFiles],
  data: { wallpapers, marks: { strips: {} } },
});
const OV_IMG = `/app/_ov/wallpapers/dolomites.jpg?v=${VER}`;
const OV_DEPTH = `/app/_ov/wallpapers/depth/dolomites.png?v=${VER}`;

const flush = () => new Promise((r) => setTimeout(r, 30));
const sel = (o) => JSON.stringify(o);
const jsonRes = (obj) => ({ ok: true, status: 200, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => obj });
const blobRes = (type = 'image/jpeg') => ({ ok: true, status: 200, headers: { get: () => type }, blob: async () => new Blob(['x'], { type }) });
const notFound = () => ({ ok: false, status: 404, headers: { get: () => 'text/plain' } });

function memStore(init) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m };
}

// 假 Image：src 一设就异步回 onload / onerror（fail(url) 为真 = 加载失败）
function fakeImage(fail) {
  return class {
    set src(u) { this._src = u; setTimeout(() => (fail(u) ? this.onerror?.() : this.onload?.()), 1); }
    get src() { return this._src; }
  };
}

let seq = 0;
/**
 * 起一个新实例。overlay：undefined = 页面没注入（去取 /app/_ov/manifest.json，走 fetch）；null = 公开版；对象 = 注入的清单。
 */
async function boot({ storage = {}, overlay, offline = false, serverBase = '', en = false, list, fetch, Image } = {}) {
  const store = memStore(storage);
  globalThis.localStorage = store;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  if (overlay !== undefined) globalThis.window.__OVERLAY__ = overlay;
  globalThis.__wp = { list: list || (async () => ({ items: [] })), en, offline, serverBase };
  globalThis.fetch = fetch || (async () => { throw new Error('offline'); });
  if (Image) globalThis.Image = Image; else delete globalThis.Image;
  const dir = mkdtempSync(join(tmpdir(), `wallpaper-test-${++seq}-`));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const [f, src] of Object.entries({ ...STUBS, ...MODS })) writeFileSync(join(dir, f), src);
  const m = await import(pathToFileURL(join(dir, 'wallpaper.svelte.js')).href);
  return { m, store, saved: () => JSON.parse(store.getItem(LS) || 'null') };
}

test('没有 overlay（公开版）：层峦为明亮默认，列表只有内置；已存的 dolomites 显示层峦但不改写本机', async () => {
  const a = await boot({ overlay: null });
  assert.equal(a.m.wp.light, 'ridges');
  assert.equal(a.m.wp.dark, 'flux');
  assert.deepEqual([...a.m.LIGHT_IDS], ['ridges']);
  assert.deepEqual([...a.m.DARK_IDS], ['flux']);
  assert.deepEqual([...a.m.SPATIAL_IDS], ['ridges']);
  assert.equal(a.m.wpDef('ridges').url, '/app/assets/wallpapers/ridges.jpg');
  assert.equal(a.m.wpDepthUrl('ridges'), '/app/assets/wallpapers/depth/ridges.png');
  assert.equal(a.m.wpHasDepth('dolomites'), false);

  const b = await boot({ overlay: null, storage: { [LS]: sel({ light: 'dolomites', dark: 'flux' }) } });
  assert.equal(b.m.wp.light, 'ridges');
  await flush();
  assert.equal(b.m.wp.light, 'ridges');
  assert.equal(b.m.wp.ready, true);
  assert.equal(b.saved().light, 'dolomites');
  // 选另一个槽时也不把显示用的层峦写回去
  b.m.setWp('dark', 'flux');
  assert.equal(b.saved().light, 'dolomites');
});

test('有 overlay：多洛米蒂并进列表（排在层峦前）、成为明亮默认，带深度图；地址走 overlay', async () => {
  const a = await boot({ overlay: manifest() });
  assert.equal(a.m.wp.light, 'dolomites');                     // 首帧就是，不等任何异步
  assert.deepEqual([...a.m.LIGHT_IDS], ['dolomites', 'ridges']);
  assert.deepEqual([...a.m.DARK_IDS], ['flux']);
  assert.deepEqual([...a.m.SPATIAL_IDS], ['dolomites', 'ridges']);
  const d = a.m.wpDef('dolomites');
  assert.equal(d.name, '多洛米蒂');
  assert.equal(d.url, OV_IMG);
  assert.equal(d.dyn, undefined);
  assert.equal(a.m.wpHasDepth('dolomites'), true);
  assert.equal(a.m.wpDepthUrl('dolomites'), OV_DEPTH);
  assert.equal(a.m.wpHasDepth('ridges'), true);
  assert.equal(a.m.wpDepthUrl('ridges'), '/app/assets/wallpapers/depth/ridges.png');
  assert.equal(a.saved(), null);                                // 默认不落盘
  await flush();
  assert.equal(a.m.wp.light, 'dolomites');

  const en = await boot({ overlay: manifest(), en: true });
  assert.equal(en.m.wpDef('dolomites').name, 'Dolomites');
});

test('有 overlay：已存 dolomites → 多洛米蒂；已存 ridges → 仍是层峦，多洛米蒂照样可选', async () => {
  const a = await boot({ overlay: manifest(), storage: { [LS]: sel({ light: 'dolomites', dark: 'flux' }) } });
  assert.equal(a.m.wp.light, 'dolomites');

  const b = await boot({ overlay: manifest(), storage: { [LS]: sel({ light: 'ridges', dark: 'flux' }) } });
  assert.equal(b.m.wp.light, 'ridges');
  await flush();
  assert.equal(b.m.wp.light, 'ridges');
  assert.ok(b.m.LIGHT_IDS.includes('dolomites'));
  b.m.setWp('light', 'dolomites');
  assert.equal(b.m.wp.light, 'dolomites');
  assert.equal(b.saved().light, 'dolomites');
  b.m.setWp('light', 'ridges');
  assert.equal(b.saved().light, 'ridges');
});

test('已存上传壁纸 up-*：清单里有就一直是它；清单里没有 → 显示默认（overlay 的），本机仍记着 up-*；删掉选中的 → 回到默认', async () => {
  const item = { id: 'up-7', name: 'mine', sys: 'light', file: '壁纸/a.jpg' };
  const a = await boot({ overlay: manifest(), storage: { [LS]: sel({ light: 'up-7', dark: 'flux' }) }, list: async () => ({ items: [item] }) });
  assert.equal(a.m.wp.light, 'up-7');                           // 清单还没回来：先按可用算
  await flush();
  assert.equal(a.m.wp.light, 'up-7');
  assert.equal(a.m.wpDef('up-7').url, '/api/file?path=' + encodeURIComponent('壁纸/a.jpg'));
  await a.m.deleteUpload('up-7');
  assert.equal(a.m.wp.light, 'dolomites');
  assert.equal(a.saved().light, null);

  const later = (v) => () => new Promise((r) => setTimeout(() => r(v), 5));   // 像真的网络请求一样晚一点回来
  const b = await boot({ overlay: manifest(), storage: { [LS]: sel({ light: 'up-7', dark: 'flux' }) }, list: later({ items: [] }) });
  assert.equal(b.m.wp.light, 'up-7');
  await flush();
  assert.equal(b.m.wp.light, 'dolomites');
  assert.equal(b.saved().light, 'up-7');

  const c = await boot({ overlay: null, storage: { [LS]: sel({ light: 'up-7', dark: 'flux' }) } });
  await flush();
  assert.equal(c.m.wp.light, 'ridges');
});

test('overlay 晚到：之前显示层峦、不写回本机；清单到了换成多洛米蒂；到了却没有 overlay → 仍是层峦', async () => {
  let arrive;
  const fetch = (u) => {
    assert.equal(u, '/app/_ov/manifest.json');
    return new Promise((r) => { arrive = r; });
  };
  const a = await boot({ storage: { [LS]: sel({ light: 'dolomites', dark: 'flux' }) }, fetch });
  assert.equal(a.m.wp.light, 'ridges');
  assert.deepEqual([...a.m.LIGHT_IDS], ['ridges']);
  await flush();                                                // 上传清单先回来了，overlay 还没到
  assert.equal(a.m.wp.ready, true);
  assert.equal(a.m.wp.light, 'ridges');
  a.m.setWp('dark', 'flux');                                    // 动另一个槽也不把 ridges 写回 light
  assert.equal(a.saved().light, 'dolomites');
  arrive(jsonRes(manifest()));
  await flush();
  assert.equal(a.m.wp.light, 'dolomites');
  assert.deepEqual([...a.m.LIGHT_IDS], ['dolomites', 'ridges']);
  assert.deepEqual([...a.m.SPATIAL_IDS], ['dolomites', 'ridges']);
  assert.equal(a.m.wpDef('dolomites').url, OV_IMG);

  // 没选过：先层峦，清单到了换成 overlay 的默认
  let arrive2;
  const b = await boot({ fetch: () => new Promise((r) => { arrive2 = r; }) });
  assert.equal(b.m.wp.light, 'ridges');
  arrive2(jsonRes(manifest()));
  await flush();
  assert.equal(b.m.wp.light, 'dolomites');
  assert.equal(b.saved(), null);

  // 取到的是 null（服务器没配 overlay）
  let arrive3;
  const c = await boot({ storage: { [LS]: sel({ light: 'dolomites', dark: 'flux' }) }, fetch: () => new Promise((r) => { arrive3 = r; }) });
  arrive3(jsonRes(null));
  await flush();
  assert.equal(c.m.wp.light, 'ridges');
  assert.equal(c.saved().light, 'dolomites');
});

test('离线壳远端只读模式：overlay 图先取成同源 blob: 地址再用（纹理不跨源）；取不到就当没有', async () => {
  const origin = 'https://srv.example';
  const calls = [];
  const fetch = async (u, opt) => {
    calls.push([u, opt]);
    await new Promise((r) => setTimeout(r, 5));                  // 像真的网络请求一样晚一点回来
    if (u === origin + '/app/_ov/manifest.json') return jsonRes(manifest());
    if (u.startsWith(origin + '/app/_ov/wallpapers/')) return blobRes(u.includes('.png') ? 'image/png' : 'image/jpeg');
    return notFound();
  };
  const storage = { [LS]: sel({ light: 'dolomites', dark: 'flux' }), 'bridge.ov.remote': JSON.stringify({ origin, m: manifest() }) };
  const a = await boot({ offline: true, serverBase: origin, storage, fetch });
  assert.equal(a.m.wp.light, 'ridges');                         // blob 还没取回来
  await flush();
  assert.equal(a.m.wp.light, 'dolomites');
  assert.match(a.m.wpDef('dolomites').url, /^blob:/);
  assert.match(a.m.wpDepthUrl('dolomites'), /^blob:/);
  const img = calls.find(([u]) => u === origin + OV_IMG);
  assert.ok(img, '按 overlay 地址取原图');
  assert.equal(img[1].mode, 'cors');
  assert.equal(img[1].credentials, 'omit');
  assert.ok(calls.some(([u]) => u === origin + OV_DEPTH));
  assert.equal(a.saved().light, 'dolomites');

  // 图取不到（404）：多洛米蒂不出现，仍是层峦
  const b = await boot({ offline: true, serverBase: origin, storage, fetch: async (u) => (u.endsWith('manifest.json') ? jsonRes(manifest()) : notFound()) });
  await flush();
  assert.equal(b.m.wp.light, 'ridges');
  assert.deepEqual([...b.m.LIGHT_IDS], ['ridges']);

  // 深度图取不到：原图照用，只是没有空间壁纸
  const c = await boot({ offline: true, serverBase: origin, storage, fetch: async (u) => (u.endsWith('manifest.json') ? jsonRes(manifest()) : u.includes('/depth/') ? notFound() : blobRes()) });
  await flush();
  assert.equal(c.m.wp.light, 'dolomites');
  assert.equal(c.m.wpHasDepth('dolomites'), false);
  assert.deepEqual([...c.m.SPATIAL_IDS], ['ridges']);
});

test('同源 overlay 图加载失败（如 apk 里漏打了文件）：回退默认、不写回本机；只坏深度图则只关空间壁纸', async () => {
  const a = await boot({ overlay: manifest(), storage: { [LS]: sel({ light: 'dolomites', dark: 'flux' }) }, Image: fakeImage((u) => u.includes('/_ov/')) });
  assert.equal(a.m.wp.light, 'dolomites');                      // 乐观先用
  await flush();
  assert.equal(a.m.wp.light, 'ridges');
  assert.deepEqual([...a.m.LIGHT_IDS], ['ridges']);
  assert.equal(a.saved().light, 'dolomites');

  // 没用上的不探（网页上不白下大图）；选上了才探
  const seen = [];
  const c = await boot({ overlay: manifest(), storage: { [LS]: sel({ light: 'ridges', dark: 'flux' }) }, Image: fakeImage((u) => { seen.push(u); return false; }) });
  await flush();
  assert.deepEqual(seen, []);
  c.m.setWp('light', 'dolomites');
  assert.equal(c.m.wp.light, 'dolomites');
  await flush();
  assert.deepEqual(seen, [OV_IMG, OV_DEPTH]);
  assert.equal(c.m.wp.light, 'dolomites');

  const b = await boot({ overlay: manifest(), Image: fakeImage((u) => u.includes('/depth/')) });
  await flush();
  assert.equal(b.m.wp.light, 'dolomites');
  assert.equal(b.m.wpHasDepth('dolomites'), false);
  assert.equal(b.m.wpDepthUrl('dolomites'), null);
  assert.deepEqual([...b.m.SPATIAL_IDS], ['ridges']);
});

test('清单校验：撞内置 id、up- 前缀、文件不在清单、重复的条目都忽略；深色 overlay 壁纸进深色列表并可当默认', async () => {
  const night = { id: 'night', name: '夜', src: 'wallpapers/night.jpg', sys: 'dark', default: true };
  const bad = [
    { id: 'ridges', name: 'x', src: 'wallpapers/dolomites.jpg' },
    { id: 'up-1', name: 'x', src: 'wallpapers/dolomites.jpg' },
    { id: 'ghost', name: 'x', src: 'wallpapers/missing.jpg' },
    { id: '../evil', name: 'x', src: 'wallpapers/dolomites.jpg' },
    'junk',
  ];
  const a = await boot({ overlay: manifest([...bad, DOLO, { ...DOLO, name: 'dup' }, night], ['wallpapers/night.jpg']) });
  assert.deepEqual([...a.m.LIGHT_IDS], ['dolomites', 'ridges']);
  assert.deepEqual([...a.m.DARK_IDS], ['night', 'flux']);
  assert.equal(a.m.wpDef('dolomites').name, '多洛米蒂');
  assert.equal(a.m.wpDef('ridges').url, '/app/assets/wallpapers/ridges.jpg');
  assert.equal(a.m.wp.dark, 'night');
  assert.equal(a.m.wpHasDepth('night'), false);

  // 不标 default：只是可选，默认仍是层峦
  const b = await boot({ overlay: manifest([{ ...DOLO, default: false }]) });
  assert.equal(b.m.wp.light, 'ridges');
  assert.ok(b.m.LIGHT_IDS.includes('dolomites'));
});
