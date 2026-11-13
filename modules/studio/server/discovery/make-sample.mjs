// 生成 catalog-v3.sample.json（方案 §9.4 联调样例）：用 fixtures/ 里的真实目录，在临时数据根上跑真的巡检合并 + 目录，
// 产出 GET /api/studio/catalog 的原样响应，另附 _resolve（备选模型的完整条目）与 _providers（设置页看的 autoSync / sync）。
// 用法：node --import ./src/modules/register.mjs modules/studio/server/discovery/make-sample.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-studio-sample-'));
Object.assign(process.env, { BRIDGE_DATA_ROOT: tmp, BRIDGE_USERS_ROOT: path.join(tmp, 'users'), BRIDGE_CLAUDE_IN_CHROME: '0', BRIDGE_MODULES_SKIP: 'codex,dimensio', BRIDGE_STUDIO_AUTOSYNC: '0' });
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 18995, token: 'sample-token-not-real-0000', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users') }));
await (await import('@bridge/core/modules/registry.mjs')).loadModules();

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(path.join(here, 'fixtures', f), 'utf8'));
const P = await import('../providers.mjs');
const store = await import('./store.mjs');
const sources = await import('./sources.mjs');
const disc = await import('./index.mjs');
const { catalog, resolvedModel } = await import('../catalog.mjs');

const OR_IMAGES = fx('openrouter-images-models.json').data, OR_VIDEOS = fx('openrouter-videos-models.json').data;
store.setReference({ images: OR_IMAGES, videos: OR_VIDEOS }, { persist: false });
const noFetch = { fetchSchema: async () => null, fetchEndpoints: async () => null };

// Vertex（导入来的内置模型）+ Gemini API（巡检出 Omni 1.2 / 3.8 TTS 等）+ OpenRouter（建底后又出现 krea/k3-edit）+ fal（主列表里三个带 schema 的）
P.createProvider({ preset: 'vertex', dialect: 'vertex', name: 'Google Vertex AI', models: [
  { id: 'gemini-3-pro-image', kind: 'image', source: 'builtin' }, { id: 'veo-3.1-fast-generate-001', kind: 'video', source: 'builtin' }, { id: 'gemini-2.5-flash-tts', kind: 'speech', source: 'builtin' },
] }, 'admin');
const gem = P.createProvider({ preset: 'gemini', dialect: 'gemini', name: 'Gemini API', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'sample',
  models: [{ id: 'gemini-nano-banana-2.1', kind: 'image', source: 'builtin' }, { id: 'gemini-omni-1.1-flash', kind: 'video', source: 'builtin' }, { id: 'lyria-3.5', kind: 'music', source: 'builtin' }] }, 'admin');
await disc.syncProvider('admin', gem.id, { sources: { gemini: async () => ({ models: sources.parseGeminiModels(fx('gemini-models.json').models), complete: true }) }, ...noFetch });

const or = P.createProvider({ preset: 'openrouter', dialect: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sample',
  models: [{ id: 'openai/gpt-image-2.6-sunburst', kind: 'image', source: 'builtin', label: 'GPT Image 2.6 Sunburst' }] }, 'admin');
const orSrc = (imgs) => ({ openrouter: async () => ({ ...sources.parseOpenRouter(imgs, OR_VIDEOS), schemasReplace: true, complete: true }) });
await disc.syncProvider('admin', or.id, { sources: orSrc(OR_IMAGES.filter((m) => m.id !== 'krea/k3-edit' && m.id !== 'x-ai/grok-imagine-image-2.0')), ...noFetch });
await disc.syncProvider('admin', or.id, { sources: orSrc(OR_IMAGES), ...noFetch });   // 第二次：两个「新」进主列表

const fal = P.createProvider({ preset: 'fal', dialect: 'fal', name: 'fal', baseUrl: 'https://queue.fal.run', apiKey: 'sample', models: [
  { id: 'fal-ai/flux/dev', kind: 'image', source: 'manual', label: 'FLUX.1 [dev]' },
  { id: 'fal-ai/kling-video/v3/pro/image-to-video', kind: 'video', source: 'remote', label: 'Kling 3.0 Pro 图生视频', discoveredAt: Date.now() - 3600_000 },
  { id: 'bytedance/seedance-2.5/us/reference-to-video', kind: 'video', source: 'remote', label: 'Seedance 2.5 参考生视频', discoveredAt: Date.now() - 86400_000 },
  { id: 'elevenlabs/tts/eleven-v4', kind: 'speech', source: 'remote', label: 'ElevenLabs v4' },
  { id: 'acme/unknown-video', kind: 'video', source: 'manual', label: '手填的未知模型' },
] }, 'admin');
const schemaOf = (f, kind) => { const s = sources.falSchemaOf(fx(f).models[0]); return { src: 'jsonschema', kind, data: { input: s.input, defs: s.defs } }; };
store.putSchemas('admin', fal.id, {
  'fal-ai/flux/dev': schemaOf('fal-flux-dev.json', 'image'),
  'fal-ai/kling-video/v3/pro/image-to-video': schemaOf('fal-kling-v3-pro-i2v.json', 'video'),
  'bytedance/seedance-2.5/us/reference-to-video': schemaOf('fal-seedance-2.5-reference.json', 'video'),
  'elevenlabs/tts/eleven-v4': schemaOf('fal-elevenlabs-tts-v4.json', 'speech'),
});
store.setSyncState('admin', fal.id, { at: Date.now() - 3 * 3600_000, ok: false, error: 'fal 模型列表 401：API Key 无效或没权限', added: [], gone: [] });

const cat = catalog('admin');
const orP = P.getProvider(or.id, 'admin');
const shelfOmni = orP.models.find((m) => m.id === 'google/gemini-omni-1.2-flash');
const out = {
  _note: 'Media Studio v3 目录样例（方案 §9.3）。由 discovery/make-sample.mjs 用 fixtures/ 里 2026-11-06 的真实目录跑真代码生成；'
    + '顶层除 _note / _resolve / _providers 外就是 GET /api/studio/catalog 的原样响应。group.shelf = 备选轻条目（完整条目走 GET /api/studio/models/resolve?key=，示例见 _resolve）。',
  ...cat,
  _resolve: { ok: true, model: resolvedModel(orP, shelfOmni, 'admin') },
  _providers: P.listProviders('admin').map(({ id, name, dialect, preset, enabled, autoSync, sync }) => ({ id, name, dialect, preset, enabled, autoSync, sync: sync ?? null })),
};
const file = path.join(here, 'catalog-v3.sample.json');
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log('写入', file, Buffer.byteLength(JSON.stringify(cat)), '字节（目录本体）');
process.exit(0);
