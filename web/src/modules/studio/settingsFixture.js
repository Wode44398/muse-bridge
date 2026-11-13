// i18n-ignore-file —— dev 专用：后端骨架没到时设置页的内存假后端（只在 import.meta.env.DEV 下被动态 import，生产构建没有它）。
// 形状照方案 §3.1 / §3.5 与 studio-backend 回复的定案：/api/studio/providers*、/api/studio/settings、/api/studio/catalog。
// 打开：localStorage['bridge-studio-fixture'] = '1'；模拟成员：再设 localStorage['bridge-studio-fixture-member'] = '1'。
// 数据只在内存里，整页刷新就回到「还没导入」的初始态。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (status, error) => { const e = new Error(error); e.status = status; e.body = { error }; throw e; };
const uid = () => 'p-' + Math.random().toString(16).slice(2, 10);
const asMember = () => { try { return localStorage.getItem('bridge-studio-fixture-member') === '1'; } catch { return false; } };

const PRESETS = [
  { id: 'vertex', name: 'Google Vertex AI', dialect: 'vertex', kinds: ['image', 'video', 'speech', 'music'], baseUrl: '', authStyle: 'none', note: '服务账号 JSON 或本机 ADC' },
  { id: 'gemini', name: 'Gemini API', dialect: 'gemini', kinds: ['image', 'video', 'speech', 'music'], baseUrl: 'https://generativelanguage.googleapis.com', authStyle: 'x-goog-api-key' },
  { id: 'openrouter', name: 'OpenRouter', dialect: 'openrouter', kinds: ['image'], baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer' },
  { id: 'openai', name: 'OpenAI', dialect: 'openai', kinds: ['image', 'video', 'speech'], baseUrl: 'https://api.openai.com/v1', authStyle: 'bearer' },
  { id: 'custom', name: 'OpenAI 兼容（自定义）', dialect: 'openai', kinds: ['image', 'video', 'speech'], baseUrl: '', authStyle: 'bearer', note: '任何兼容 OpenAI 图像 / 语音 / 视频接口的服务' },
  { id: 'fal', name: 'fal', dialect: 'fal', kinds: ['image', 'video', 'speech', 'music'], baseUrl: 'https://queue.fal.run', authStyle: 'fal-key' },
  { id: 'replicate', name: 'Replicate', dialect: 'replicate', kinds: ['image', 'video', 'speech', 'music'], baseUrl: 'https://api.replicate.com/v1', authStyle: 'bearer' },
  { id: 'elevenlabs', name: 'ElevenLabs', dialect: 'elevenlabs', kinds: ['speech', 'music'], baseUrl: 'https://api.elevenlabs.io/v1', authStyle: 'xi-api-key' },
  { id: 'minimax', name: 'MiniMax', dialect: 'minimax', kinds: ['video', 'speech', 'music'], baseUrl: 'https://api.minimaxi.com/v1', authStyle: 'bearer' },
  { id: 'ark', name: '火山方舟', dialect: 'ark', kinds: ['image', 'video'], baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', authStyle: 'bearer' },
  { id: 'local', name: '本机图像模型', dialect: 'local', kinds: ['image'], baseUrl: 'http://127.0.0.1:8190', authStyle: 'none' },
];

const M = (id, label, kind, source = 'builtin') => ({ id, label, kind, enabled: true, source, defaults: {} });
const BUILTIN = {
  vertex: [
    M('gemini-3.1-flash-image', 'Nano Banana 2', 'image'), M('gemini-nano-banana-2.1', 'Nano Banana 2.1', 'image'),
    M('veo-3.1-generate', 'Veo 3.1', 'video'), M('veo-3.1-fast-generate', 'Veo 3.1 Fast', 'video'), M('veo-3.1-lite-generate', 'Veo 3.1 Lite', 'video'),
    M('gemini-3.1-flash-tts', 'Gemini 3.1 Flash TTS', 'speech'), M('gemini-2.5-pro-tts', 'Gemini 2.5 Pro TTS', 'speech'),
    M('lyria-002', 'Lyria 2', 'music'),
  ],
  gemini: [
    M('gemini-nano-banana-2.1', 'Nano Banana 2.1（2K / 4K）', 'image'), M('gemini-omni-1.1-flash', 'Gemini Omni 1.1', 'video'),
    M('gemini-3.1-flash-tts', 'Gemini 3.1 Flash TTS', 'speech'), M('lyria-3', 'Lyria 3', 'music'), M('lyria-3.5', 'Lyria 3.5', 'music'),
  ],
  openrouter: [M('gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', 'image')],
  local: [M('qwen-image', 'Qwen Image（本机）', 'image')],
};
const REMOTE = {
  openai: [{ id: 'gpt-image-2', label: 'gpt-image-2', kind: 'image' }, { id: 'gpt-image-1.5', label: 'gpt-image-1.5', kind: 'image' }, { id: 'sora-2', label: 'sora-2', kind: 'video' }, { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts', kind: 'speech' }, { id: 'tts-1-hd', label: 'tts-1-hd', kind: 'speech' }, { id: 'whisper-1', label: 'whisper-1', kind: null }],
  openrouter: [{ id: 'openai/gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', kind: 'image' }, { id: 'google/gemini-3.1-flash-image', label: 'Nano Banana 2', kind: 'image' }, { id: 'black-forest-labs/flux-2-pro', label: 'FLUX.2 Pro', kind: 'image' }],
  elevenlabs: [{ id: 'eleven_v3', label: 'Eleven v3', kind: 'speech' }, { id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', kind: 'speech' }, { id: 'music_v1', label: 'Eleven Music', kind: 'music' }],
  fal: [{ id: 'fal-ai/flux-pro/v1.1-ultra', label: 'FLUX1.1 [pro] ultra', kind: 'image' }, { id: 'fal-ai/kling-video/v3/pro/text-to-video', label: 'Kling 3 Pro', kind: 'video' }, { id: 'fal-ai/stable-audio', label: 'Stable Audio', kind: 'music' }, { id: 'fal-ai/some-new-model', label: 'some-new-model', kind: null }],
  minimax: [{ id: 'MiniMax-Hailuo-03', label: 'Hailuo 03', kind: 'video' }, { id: 'speech-2.8-hd', label: 'Speech 2.8 HD', kind: 'speech' }, { id: 'music-2.0', label: 'Music 2.0', kind: 'music' }],
  ark: [{ id: 'doubao-seedream-5-0', label: 'Seedream 5.0', kind: 'image' }, { id: 'doubao-seedance-2-0-pro', label: 'Seedance 2.0 Pro', kind: 'video' }],
  replicate: [{ id: 'black-forest-labs/flux-2-pro', label: 'FLUX.2 Pro', kind: 'image' }, { id: 'minimax/music-02', label: 'music-02', kind: 'music' }],
};

// 自动识别（方案 §9.3）：能发现模型的方言、导入后预置的发现样例（新模型 / 备选 / 已下线）与三种巡检状态（null / 成功 / 失败）
const DISCOVERABLE = ['vertex', 'gemini', 'openrouter', 'replicate', 'fal', 'openai', 'elevenlabs'];
const DAY = 86400_000;
const R = (id, label, kind, extra = {}) => ({ id, label, kind, enabled: true, source: 'remote', defaults: {}, ...extra });
const SHELF_VENDORS = ['black-forest-labs', 'bytedance', 'recraft', 'ideogram', 'stability', 'qwen', 'kling', 'minimax', 'luma', 'pika'];
function seedDiscovery(src, p, now) {
  if (src === 'openrouter') {
    // 建底：几十个备选（shelf）；之后新出现的进主列表（7 天内 = 朱点）；上游不再列出的标 gone
    const shelf = Array.from({ length: 42 }, (_, i) => {
      const v = SHELF_VENDORS[i % SHELF_VENDORS.length];
      return R(`${v}/model-${i + 1}`, `${v} model ${i + 1}`, i % 5 === 4 ? 'video' : 'image', { shelf: true, discoveredAt: now - 20 * DAY, vendor: v });
    });
    p.models = [
      ...p.models,
      R('black-forest-labs/flux-2-max', 'FLUX.2 Max', 'image', { discoveredAt: now - 2 * DAY, vendor: 'black-forest-labs' }),
      R('google/veo-3.2', 'Veo 3.2', 'video', { discoveredAt: now - 3 * 3600_000, vendor: 'google' }),
      R('openai/gpt-image-1', 'GPT Image 1', 'image', { discoveredAt: now - 30 * DAY, vendor: 'openai', gone: true }),
      R('recraft/recraft-v3', 'Recraft V3', 'image', { discoveredAt: now - 12 * DAY, vendor: 'recraft' }),
      ...shelf,
    ];
    S.syncs[p.id] = { at: now - 3 * 60_000, ok: true, added: ['black-forest-labs/flux-2-max', 'google/veo-3.2'], gone: ['openai/gpt-image-1'] };
  } else if (src === 'gemini') {
    p.models = [
      ...p.models,
      R('gemini-omni-1.2-flash', 'Gemini Omni 1.2', 'video', { discoveredAt: now - 5 * DAY }),
      R('gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS', 'speech', { discoveredAt: now - 9 * DAY }),
    ];
    S.syncs[p.id] = { at: now - 2 * 3600_000, ok: false, error: 'Gemini API 401：API Key 无效', added: [], gone: [] };
  }
  // google（Vertex）：没巡检过 → sync: null
}

const S = {
  rev: 1,
  providers: [],
  syncs: {},
  logs: {},
  available: { google: true, gemini: true, openrouter: true, local: false },
  last: null,
  host: { autoSave: true, saveDir: 'Media Studio', claudeMedia: true, claudeProactive: true, dimensioMedia: false, codexMedia: false, apiMedia: true,
    agentImage: true, agentSpeech: true, agentMusic: true, agentVideo: true, agentVideoMaxRes: '4k',
    safetyHarassment: 'default', safetyHate: 'default', safetySexual: 'default', safetyDangerous: 'default', defaults: {} },
  hostChanged: new Set(),
  mine: {},
};
const HOST_DEFAULTS = { ...S.host };

function view(p, forMember = false) {
  const { apiKey, serviceAccount, ...rest } = p;
  const out = { ...rest, autoSync: p.autoSync !== false, hasKey: !!apiKey, keyTail: apiKey ? apiKey.slice(-4) : '' };
  if (DISCOVERABLE.includes(p.dialect)) out.sync = S.syncs[p.id] || null;
  if (p.dialect === 'vertex') {
    let sa = null; try { sa = serviceAccount ? JSON.parse(serviceAccount) : null; } catch {}
    Object.assign(out, { hasServiceAccount: !!sa, saEmail: sa?.client_email || '', saProject: sa?.project_id || '' });
  }
  if (forMember) delete out.shared;
  return out;
}
const sharedView = (p) => ({ id: p.id, name: p.name, preset: p.preset, dialect: p.dialect, enabled: p.enabled, models: p.models.filter((m) => m.enabled).map((m) => ({ id: m.id, label: m.label, kind: m.kind })) });
const mineProviders = () => S.providers.filter((p) => (asMember() ? p.owner === 'u:demo' : p.owner === 'admin'));

function listing() {
  if (asMember()) {
    return { ok: true, providers: mineProviders().map((p) => view(p, true)), presets: PRESETS.filter((x) => x.dialect !== 'local'), rev: S.rev, discoverable: DISCOVERABLE,
      member: true, maxProviders: 10, canShare: false, shared: S.providers.filter((p) => p.owner === 'admin' && p.shared).map(sharedView) };
  }
  return { ok: true, providers: mineProviders().map((p) => view(p)), presets: PRESETS, rev: S.rev, discoverable: DISCOVERABLE, member: false, canShare: true,
    vertexImport: { available: { ...S.available }, last: S.last } };
}

function normalize(d, prev = {}) {
  const p = { ...prev };
  for (const k of ['name', 'preset', 'dialect', 'baseUrl', 'authStyle', 'timeoutSec', 'retries', 'enabled', 'shared', 'autoSync', 'headers', 'params', 'models', 'google']) if (k in d) p[k] = d[k];
  // 同服务端：设置页回传的模型不带发现元数据，按 id 从旧条目补回
  if (Array.isArray(d.models) && Array.isArray(prev.models)) {
    const old = new Map(prev.models.map((m) => [m.id, m]));
    p.models = d.models.map((m) => {
      const o = old.get(m.id);
      if (!o) return m;
      const keep = {};
      for (const k of ['discoveredAt', 'shelf', 'gone', 'vendor']) if (o[k] !== undefined && !(k in m)) keep[k] = o[k];
      return { ...keep, ...m };
    });
  }
  if ('apiKey' in d) p.apiKey = d.apiKey || '';
  if ('serviceAccount' in d) p.serviceAccount = d.serviceAccount || '';
  if (asMember()) delete p.shared;
  if (!p.name) fail(400, '先填名称');
  if (p.dialect !== 'vertex' && p.dialect !== 'local' && !String(p.baseUrl || '').trim()) fail(400, '先填接口地址');
  if (asMember() && /127\.0\.0\.1|localhost|192\.168\./.test(p.baseUrl || '')) fail(400, '成员只能接公网地址');
  return p;
}

function addLog(id, row) {
  const l = (S.logs[id] ||= []);
  l.unshift({ at: Date.now(), ...row });
  if (l.length > 50) l.length = 50;
}

function catalog() {
  const visible = asMember()
    ? [...mineProviders().map((p) => ({ p, mine: true })), ...S.providers.filter((p) => p.owner === 'admin' && p.shared).map((p) => ({ p, mine: false }))]
    : mineProviders().map((p) => ({ p, mine: false }));
  const eff = effective();
  const kinds = {};
  for (const k of ['image', 'video', 'speech', 'music']) {
    const groups = visible.filter(({ p }) => p.enabled !== false).map(({ p, mine }) => ({
      provider: { id: p.id, name: p.name, dialect: p.dialect, preset: p.preset, mine },
      models: p.models.filter((m) => m.enabled && !m.shelf && !m.gone && m.kind === k).map((m) => ({ key: p.id + '/' + m.id, id: m.id, label: m.label || m.id, kind: k, async: k === 'video' || k === 'music', inputs: { text: true }, params: [] })),
    })).filter((g) => g.models.length);
    const d = eff.defaults?.[k];
    const first = groups[0] ? { provider: groups[0].provider.id, model: groups[0].models[0].id } : null;
    kinds[k] = { defaults: d && groups.some((g) => g.provider.id === d.provider && g.models.some((m) => m.id === d.model)) ? d : first, groups };
  }
  return { kinds, rev: S.rev };
}

function effective() {
  const mine = asMember() ? S.mine : {};
  return { ...S.host, ...mine, defaults: { ...(S.host.defaults || {}), ...(mine.defaults || {}) } };
}
function settings() {
  const eff = effective();
  // 同服务端 studioMineSnapshot：个人项的值没改过就给主机的，changed 才是自己改过的键
  const mineValues = Object.fromEntries(['defaults', 'autoSave', 'saveDir'].map((k) => [k, k in S.mine ? S.mine[k] : S.host[k]]));
  if (asMember()) return { mine: { values: mineValues, changed: Object.keys(S.mine) }, effective: eff, canEditHost: false };
  return { host: { values: { ...S.host }, changed: [...S.hostChanged] }, mine: { values: {}, changed: [] }, effective: eff, canEditHost: true };
}

function doImport() {
  const now = Date.now();
  const items = [];
  const upsert = (src, base) => {
    let p = S.providers.find((x) => x.owner === 'admin' && x.importedFrom === 'vertex' && x.importSource === src);
    const status = p ? 'updated' : 'created';
    if (!p) { p = { id: uid(), owner: 'admin', enabled: true, shared: true, headers: {}, params: {}, timeoutSec: 600, retries: 2, importedFrom: 'vertex', importSource: src, ...base }; S.providers.push(p); }
    p.importedAt = now;
    return { status, p };
  };
  for (const id of ['google', 'gemini', 'openrouter', 'local']) {
    if (!S.available[id]) {
      items.push({ id, ok: false, status: 'missing', reason: id === 'local' ? '这台电脑上还没部署本机图像模型（设置 › Gemini › 本机图像模型）' : '主机上没有配置' });
      continue;
    }
    const base = id === 'google'
      ? { name: 'Google Vertex AI', preset: 'vertex', dialect: 'vertex', baseUrl: '', authStyle: 'none', google: { project: 'bridge-media-prod', location: 'global', mediaLocation: 'us-central1', credMode: 'adc' }, models: BUILTIN.vertex.map((m) => ({ ...m })) }
      : id === 'gemini'
        ? { name: 'Gemini API', preset: 'gemini', dialect: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', authStyle: 'x-goog-api-key', apiKey: 'AIzaSyFAKEKEY1234w9Qx', models: BUILTIN.gemini.map((m) => ({ ...m })) }
        : id === 'openrouter'
          ? { name: 'OpenRouter', preset: 'openrouter', dialect: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer', apiKey: 'sk-or-v1-fake-7c1e', models: BUILTIN.openrouter.map((m) => ({ ...m })) }
          : { name: '本机图像模型', preset: 'local', dialect: 'local', baseUrl: 'http://127.0.0.1:8190', authStyle: 'none', models: BUILTIN.local.map((m) => ({ ...m })) };
    const { status, p } = upsert(id, base);
    if (status === 'created') seedDiscovery(id, p, now);
    items.push({ id, ok: true, status, provider: p.id, models: p.models.length });
  }
  S.last = { at: now, items };
  S.rev++;
  if (!Object.keys(S.host.defaults || {}).length) {
    const g = S.providers.find((p) => p.importSource === 'google');
    if (g) S.host.defaults = { image: { provider: g.id, model: 'gemini-3.1-flash-image' }, video: { provider: g.id, model: 'veo-3.1-generate' }, speech: { provider: g.id, model: 'gemini-3.1-flash-tts' }, music: { provider: g.id, model: 'lyria-002' } };
  }
  return { ok: true, items, importedAt: now };
}

function providerOf(id) {
  const p = mineProviders().find((x) => x.id === id);
  if (!p) fail(404, '没有这个服务');
  return p;
}

export async function handle(method, path, body = {}) {
  await sleep(method === 'GET' ? 120 : 380);
  const [p0, qs] = path.split('?');
  if (method === 'GET' && p0 === '/api/studio/providers') return listing();
  if (method === 'GET' && p0 === '/api/studio/providers/log') return { log: S.logs[new URLSearchParams(qs).get('id')] || [] };
  if (method === 'GET' && p0 === '/api/studio/settings') return settings();
  if (method === 'GET' && p0 === '/api/studio/catalog') return catalog();
  if (method !== 'POST') fail(404, 'not found');
  switch (p0) {
    case '/api/studio/providers/create': {
      if (asMember() && mineProviders().length >= 10) fail(400, '成员最多 10 个服务');
      const p = normalize(body, { id: uid(), owner: asMember() ? 'u:demo' : 'admin', enabled: true, headers: {}, params: {}, models: [], timeoutSec: 600, retries: 2 });
      S.providers.push(p); S.rev++;
      return { provider: view(p, asMember()) };
    }
    case '/api/studio/providers/update': {
      const prev = providerOf(body.id);
      const p = normalize(body.patch || {}, prev);
      S.providers[S.providers.indexOf(prev)] = p; S.rev++;
      return { provider: view(p, asMember()) };
    }
    case '/api/studio/providers/delete': {
      const p = providerOf(body.id);
      S.providers = S.providers.filter((x) => x !== p); S.rev++;
      delete S.syncs[p.id];
      return { ok: true };
    }
    case '/api/studio/providers/sync': {
      // 立即检查（同步等待；真后端 Vertex 探活可能十几秒）：缺 Key 记失败；成功时 OpenRouter 多发现一个新模型
      const list = body.id ? [providerOf(body.id)] : mineProviders().filter((x) => DISCOVERABLE.includes(x.dialect));
      for (const p of list) if (!DISCOVERABLE.includes(p.dialect)) fail(400, '这种服务没有模型列表接口，不能自动发现');
      await sleep(1800);
      const now = Date.now();
      const results = {};
      for (const p of list) {
        const missing = p.dialect === 'vertex' ? (p.google?.credMode === 'json' && !p.serviceAccount) : (p.authStyle !== 'none' && !p.apiKey);
        if (missing) S.syncs[p.id] = { at: now, ok: false, error: '还没填 API Key', added: [], gone: [] };
        else {
          const added = [];
          if (p.dialect === 'openrouter' && !p.models.some((m) => m.id === 'bytedance/seedream-5')) {
            p.models = [...p.models, R('bytedance/seedream-5', 'Seedream 5', 'image', { discoveredAt: now, vendor: 'bytedance' })];
            added.push('bytedance/seedream-5');
          }
          S.syncs[p.id] = { at: now, ok: true, added, gone: [] };
        }
        results[p.id] = S.syncs[p.id];
      }
      S.rev++;
      return { results, providers: listing().providers };
    }
    case '/api/studio/providers/test': {
      const p = body.draft ? normalize(body.draft, body.id ? providerOf(body.id) : {}) : providerOf(body.id);
      await sleep(600);
      const missing = p.dialect === 'vertex' ? (p.google?.credMode === 'json' && !p.serviceAccount) : (p.dialect !== 'local' && p.authStyle !== 'none' && !p.apiKey);
      const result = missing ? { ok: false, status: 401, ms: 412, error: p.dialect === 'vertex' ? '没有服务账号 JSON' : '没有 API Key' }
        : p.dialect === 'local' ? { ok: false, status: 0, ms: 2003, error: '连不上本机图像 worker（127.0.0.1:8190）：它没在运行' }
          : { ok: true, status: 200, ms: 640 + Math.round(Math.random() * 300), detail: '列出了 ' + (p.models.length || 12) + ' 个模型（没有生成任何内容，不计费）' };
      if (body.id) addLog(body.id, { kind: 'test', model: body.model || '', status: result.status, ms: result.ms, error: result.error, test: true });
      return { result };
    }
    case '/api/studio/providers/models': {
      const p = body.draft ? normalize(body.draft, body.id ? providerOf(body.id) : {}) : providerOf(body.id);
      await sleep(500);
      if (p.dialect === 'vertex' || p.dialect === 'gemini' || p.dialect === 'local') return { models: BUILTIN[p.dialect].map(({ id, label, kind }) => ({ id, label, kind })) };
      const list = REMOTE[p.dialect];
      if (!list) fail(400, '这个服务没有模型列表接口，请手动添加模型 ID');
      return { models: list };
    }
    case '/api/studio/providers/import-vertex': {
      if (asMember()) fail(403, '只有管理员能导入');
      await sleep(900);
      return doImport();
    }
    case '/api/studio/settings': {
      const scope = body.scope;
      if (scope === 'host' && asMember()) fail(403, '只有管理员能改');
      for (const [k, v] of Object.entries(body.values || {})) {
        if (scope === 'host') {
          if (v === null) { S.host[k] = HOST_DEFAULTS[k]; S.hostChanged.delete(k); }
          else { S.host[k] = v; S.hostChanged.add(k); }
        } else if (v === null) delete S.mine[k];
        else S.mine[k] = v;
      }
      return settings();
    }
  }
  return fail(404, 'not found');
}
