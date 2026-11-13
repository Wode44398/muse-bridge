// i18n-ignore-file（dev 专用样例数据：模仿服务端下发的目录与作品，显示处已经过 tr()）
// 仅 dev：按 §3 契约在浏览器里模拟 /api/studio/*，后端骨架合进来之前用它把界面跑通。
// 生产构建不会打进来（api.js 里只在 import.meta.env.DEV 下动态 import）。
// 不花钱、不发网络：图片是按提示词哈希上色的 SVG，配音 / 音乐是现场合成的几秒 WAV，视频只有海报帧。

const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0; };
const uid = () => Math.random().toString(36).slice(2, 10);

function svgImage(prompt, w, h) {
  const x = hash(prompt);
  const a = x % 360, b = (a + 40 + (x >> 8) % 80) % 360;
  const esc = String(prompt).replace(/[<&>"]/g, '').slice(0, 28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a} 62% 62%)"/><stop offset="1" stop-color="hsl(${b} 58% 32%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.32}" r="${Math.min(w, h) * 0.12}" fill="hsl(${a} 90% 88% / .8)"/><path d="M0 ${h * 0.78} Q ${w * 0.3} ${h * 0.55} ${w * 0.55} ${h * 0.72} T ${w} ${h * 0.6} V ${h} H 0 Z" fill="hsl(${b} 40% 18% / .55)"/><text x="${w / 2}" y="${h * 0.92}" font-family="system-ui" font-size="${Math.round(w / 22)}" fill="#fff" fill-opacity=".72" text-anchor="middle">${esc}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function wavUrl(seconds, seed) {
  const rate = 16000, n = Math.floor(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  const f = [220, 277, 330, 415][seed % 4];
  for (let i = 0; i < n; i++) {
    const t = i / rate, env = Math.min(1, t * 8) * Math.max(0, 1 - t / seconds);
    const s = (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * t)) * 0.25 * env;
    v.setInt16(44 + i * 2, s * 32767, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const ASPECTS = [
  { value: 'auto', label: '自动' }, { value: '1:1', label: '1:1' }, { value: '3:4', label: '3:4' }, { value: '4:3', label: '4:3' },
  { value: '9:16', label: '9:16' }, { value: '16:9', label: '16:9' }, { value: '21:9', label: '21:9' },
  { value: '4:1', label: '4:1', only: ['gemini-3.1-flash-image'] }, { value: '1:8', label: '1:8', only: ['gemini-3.1-flash-image'] },
];
const imgParams = (big) => [
  { key: 'aspectRatio', label: '比例', type: 'enum', group: 'basic', default: 'auto', options: ASPECTS },
  { key: 'imageSize', label: '分辨率', type: 'enum', group: 'basic', default: '1K', options: [{ value: '1K', label: '1K' }, ...(big ? [{ value: '2K', label: '2K', note: '2K / 4K 由 Gemini API 生成：扣预付费额度，返回 JPEG' }, { value: '4K', label: '4K', note: '2K / 4K 由 Gemini API 生成：扣预付费额度，返回 JPEG' }] : [])] },
  { key: 'outputFormat', label: '输出格式', type: 'enum', group: 'basic', default: 'image', options: [{ value: 'both', label: '图文' }, { value: 'image', label: '仅图' }] },
  { key: 'thinkingLevel', label: '思考强度', type: 'enum', group: 'advanced', default: 'minimal', options: [{ value: 'minimal', label: '最少' }, { value: 'high', label: '高' }] },
  { key: 'temperature', label: 'Temperature', type: 'number', group: 'advanced', min: 0, max: 2, step: 0.05, default: 1 },
  { key: 'topP', label: 'Top P', type: 'number', group: 'advanced', min: 0, max: 1, step: 0.01, default: 0.95 },
  { key: 'personGeneration', label: '人物生成', type: 'enum', group: 'advanced', default: 'allow_adult', options: [{ value: 'allow_all', label: '允许所有人物' }, { value: 'allow_adult', label: '仅成人' }, { value: 'dont_allow', label: '不生成人物' }], when: { imageSize: '1K' } },
  { key: 'useSearch', label: '联网搜索', type: 'bool', group: 'advanced' },
];

// 后端约定（§9.3 落地澄清）：备选轻条目在 group.shelf（和 models 并列）；这里写样例时混在 models 里，出口处挪过去
function catalog() {
  const c = rawCatalog();
  for (const blk of Object.values(c.kinds)) for (const g of blk.groups) { g.shelf = g.models.filter((x) => x.shelf); g.models = g.models.filter((x) => !x.shelf); }
  return c;
}
// —— §9.3 自动识别的样例（v3 前端先按契约自造；后端 studio-autodiscover 的脱敏样例到了以后以那份为准）——
// 上游 schema 转出来的卡：十几个参数、几十个选项的长枚举、超长英文标签、带 unit / desc / format / options[].hint
const LONG_STYLES = ['photographic', 'cinematic', 'analog-film', 'anime', 'comic-book', 'digital-art', 'enhance', 'fantasy-art', 'isometric', 'line-art', 'low-poly',
  'modeling-compound', 'neon-punk', 'origami', 'pixel-art', 'tile-texture', '3d-model', 'watercolor', 'oil-painting', 'charcoal-sketch', 'ukiyo-e', 'art-nouveau',
  'art-deco', 'bauhaus', 'brutalist', 'cyberpunk', 'steampunk', 'vaporwave', 'synthwave', 'film-noir', 'polaroid', 'risograph', 'screen-print', 'blueprint',
  'chalkboard', 'claymation', 'stained-glass', 'paper-cutout', 'embroidery', 'mosaic', 'graffiti', 'long-exposure-night-photography-with-light-trails'];
const schemaParams = () => [
  { key: 'aspect_ratio', label: '比例', type: 'enum', group: 'basic', format: 'aspect', default: '1:1', options: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21', '5:4', '4:5', '1:4', '4:1', '1:8', '8:1'].map((v) => ({ value: v, label: v })) },
  { key: 'resolution', label: '分辨率', type: 'enum', group: 'basic', format: 'resolution', default: '1K', options: [{ value: '1K', label: '1K', hint: '$0.03' }, { value: '2K', label: '2K', hint: '$0.06' }, { value: '4K', label: '4K', hint: '$0.12' }] },
  { key: 'quality', label: '画质', type: 'enum', group: 'basic', default: 'high', options: [{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }, { value: 'auto', label: 'auto' }] },
  { key: 'n', label: '张数', type: 'number', group: 'basic', format: 'count', min: 1, max: 4, step: 1, default: 1 },
  { key: 'style_preset', label: '风格', type: 'enum', group: 'advanced', default: '', desc: 'Style preset applied before sampling.', options: [{ value: '', label: '' }, ...LONG_STYLES.map((v) => ({ value: v, label: v }))] },
  { key: 'num_inference_steps', label: '采样步数', type: 'number', group: 'advanced', min: 1, max: 80, step: 1, default: 28, desc: 'Number of denoising steps. More steps usually means more detail, but slower.' },
  { key: 'guidance_scale', label: '引导强度', type: 'number', group: 'advanced', min: 0, max: 20, step: 0.1, default: 3.5, desc: 'How strictly the image follows the prompt.' },
  { key: 'output_format', label: '格式', type: 'enum', group: 'advanced', default: 'png', options: [{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }] },
  { key: 'output_compression', label: '压缩率', type: 'number', group: 'advanced', min: 0, max: 100, step: 1, unit: '%', default: 90, when: { output_format: ['jpeg', 'webp'] } },
  { key: 'background', label: '背景', type: 'enum', group: 'advanced', default: 'auto', options: [{ value: 'auto', label: 'auto' }, { value: 'transparent', label: 'transparent' }, { value: 'opaque', label: 'opaque' }] },
  { key: 'safety_tolerance', label: 'Safety tolerance (lower is stricter, higher is more permissive)', type: 'number', group: 'advanced', min: 1, max: 6, step: 1, default: 2, desc: 'Tolerance level for input and output moderation. 1 is the most strict, 6 the most permissive.' },
  { key: 'prompt_upsampling', label: 'Prompt upsampling with a large language model before generation', type: 'bool', group: 'advanced', default: false },
  { key: 'raw', label: 'Raw mode', type: 'bool', group: 'advanced', default: false, desc: 'Generate less processed, more natural-looking images.' },
  { key: 'image_prompt_strength', label: 'Image prompt strength', type: 'number', group: 'advanced', min: 0, max: 1, step: 0.01, default: 0.1 },
  { key: 'seed', label: '种子', type: 'seed', group: 'advanced' },
  { key: 'extra', label: '额外参数', type: 'json', group: 'advanced' },
];

function rawCatalog() {
  const vx = { id: 'vertex', name: 'Google Vertex AI', dialect: 'vertex', preset: 'vertex', mine: false };
  const gm = { id: 'gemini', name: 'Gemini API', dialect: 'gemini', preset: 'gemini', mine: false };
  const or = { id: 'openrouter', name: 'OpenRouter', dialect: 'openrouter', preset: 'openrouter', mine: false };
  const el = { id: 'my-eleven', name: 'ElevenLabs', dialect: 'elevenlabs', preset: 'elevenlabs', mine: true };
  const m = (p, id, label, kind, extra) => ({ key: p.id + '/' + id, id, label, kind, async: false, inputs: { text: true }, params: [], ...extra });
  return {
    rev: 1,
    kinds: {
      image: {
        defaults: { provider: 'vertex', model: 'gemini-3.1-flash-image' },
        groups: [
          { provider: vx, models: [
            m(vx, 'gemini-3.1-flash-image', 'Nano Banana 2.1', 'image', { desc: '对话式生成与修改，速度快', inputs: { text: true, images: { max: 3, roles: ['edit', 'ref'] }, multiTurn: true }, params: imgParams(true) }),
            m(vx, 'imagen-4.0-generate-001', 'Imagen 4', 'image', { desc: '单张高保真生成', params: imgParams(false).slice(0, 1) }),
          ] },
          { provider: or, models: [
            m(or, 'black-forest-labs/flux-2-pro', 'FLUX.2 Pro', 'image', { vendor: 'black-forest-labs', paramSource: 'schema', isNew: true, inputs: { text: true, images: { max: 8, roles: ['edit', 'ref'] } }, params: schemaParams() }),
            m(or, 'black-forest-labs/flux-2-flex', 'FLUX.2 Flex', 'image', { vendor: 'black-forest-labs', paramSource: 'schema', params: schemaParams().slice(0, 8) }),
            m(or, 'bytedance-seed/seedream-4.5', 'Seedream 4.5', 'image', { vendor: 'bytedance-seed', paramSource: 'schema', isNew: true, params: schemaParams().slice(0, 4) }),
            m(or, 'sourceful/riverflow-v2-max-preview-extended-context-experimental', 'Riverflow V2 Max Preview (Extended Context, Experimental Build 2026-11)', 'image', { vendor: 'sourceful', paramSource: 'generic', params: [{ key: 'extra', label: '额外参数', type: 'json', group: 'advanced' }] }),
            { key: 'openrouter/recraft/recraft-v4', id: 'recraft/recraft-v4', label: 'Recraft V4', vendor: 'recraft', kind: 'image', shelf: true },
            { key: 'openrouter/ideogram/ideogram-v3-turbo', id: 'ideogram/ideogram-v3-turbo', label: 'Ideogram 3.0 Turbo', vendor: 'ideogram', kind: 'image', shelf: true },
            { key: 'openrouter/google/gemini-3-pro-image-preview', id: 'google/gemini-3-pro-image-preview', label: 'Nano Banana Pro (Preview)', vendor: 'google', kind: 'image', shelf: true },
            { key: 'openrouter/stability/sd-4-large', id: 'stability/sd-4-large', label: 'Stable Diffusion 4 Large', vendor: 'stability', kind: 'image', shelf: true },
            m(or, 'openai/gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst', 'image', { vendor: 'openai', desc: '经 OpenRouter，扣 OpenRouter 余额', inputs: { text: true, images: { max: 4, roles: ['edit'] } }, priceHint: '约 $0.04 / 张', params: [
              { key: 'size', label: '尺寸', type: 'enum', group: 'basic', default: '1024x1024', options: [{ value: '1024x1024', label: '1024 × 1024' }, { value: '1536x1024', label: '1536 × 1024' }, { value: '1024x1536', label: '1024 × 1536' }] },
              { key: 'quality', label: '画质', type: 'enum', group: 'basic', default: 'high', options: [{ value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }] },
              { key: 'extra', label: '额外参数', type: 'json', group: 'advanced' },
            ] }),
          ] },
        ],
      },
      video: {
        defaults: { provider: 'vertex', model: 'veo-3.1-lite' },
        groups: [
          { provider: vx, models: [
            m(vx, 'veo-3.1-lite', 'Veo 3.1 Lite', 'video', { async: true, desc: '最便宜的 Veo，4–8 秒', inputs: { text: true, images: { max: 3, roles: ['first', 'last', 'ref'] } }, params: [
              { key: 'aspectRatio', label: '比例', type: 'enum', group: 'basic', default: '16:9', options: [{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }] },
              { key: 'durationSeconds', label: '时长', type: 'enum', group: 'basic', default: 4, options: [{ value: 4, label: '4 秒' }, { value: 6, label: '6 秒' }, { value: 8, label: '8 秒' }] },
              { key: 'resolution', label: '分辨率', type: 'enum', group: 'basic', default: '720p', options: [{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }] },
              { key: 'generateAudio', label: '生成声音', type: 'bool', group: 'basic', default: true },
              { key: 'negativePrompt', label: '负面提示', type: 'text', group: 'advanced' },
              { key: 'seed', label: '种子', type: 'seed', group: 'advanced' },
            ] }),
          ] },
          { provider: or, models: [
            m(or, 'bytedance/seedance-2.0-pro', 'Seedance 2.0 Pro', 'video', { async: true, vendor: 'bytedance', paramSource: 'schema', isNew: true,
              inputs: { text: true, images: { max: 4, roles: ['first', 'last', 'ref'], exclusive: false }, video: { max: 2 }, audio: { max: 1 } }, params: [
              { key: 'aspect_ratio', label: '比例', type: 'enum', group: 'basic', format: 'aspect', default: '16:9', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((v) => ({ value: v, label: v })) },
              { key: 'duration', label: '时长', type: 'number', group: 'basic', format: 'duration', unit: 's', min: 4, max: 15, step: 1, default: 5 },
              { key: 'resolution', label: '分辨率', type: 'enum', group: 'basic', format: 'resolution', default: '720p', options: [{ value: '480p', label: '480p' }, { value: '720p', label: '720p' }, { value: '1080p', label: '1080p', hint: '×2' }] },
              { key: 'generate_audio', label: '生成声音', type: 'bool', group: 'basic', default: true },
              { key: 'camera_fixed', label: 'Camera fixed', type: 'bool', group: 'advanced' },
              { key: 'seed', label: '种子', type: 'seed', group: 'advanced' },
            ] }),
            { key: 'openrouter/kwaivgi/kling-v3-master', id: 'kwaivgi/kling-v3-master', label: 'Kling 3.0 Master', vendor: 'kwaivgi', kind: 'video', shelf: true },
          ] },
          { provider: gm, models: [
            m(gm, 'gemini-omni-1.2-flash', 'Omni 1.2 Flash', 'video', { async: true, paramSource: 'family', inheritsFrom: 'omni-1.1-flash', refinedBy: 'openrouter', isNew: true, inputs: { text: true, images: { max: 1, roles: ['first'] } }, params: [
              { key: 'durationSeconds', label: '时长', type: 'enum', group: 'basic', format: 'duration', default: 3, options: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => ({ value: n, label: n + ' 秒' })) },
              { key: 'resolution', label: '分辨率', type: 'enum', group: 'basic', default: '360p', options: [{ value: '360p', label: '360p' }, { value: '720p', label: '720p' }] },
            ] }),
            m(gm, 'omni-1.1-flash', 'Omni 1.1 Flash', 'video', { async: true, desc: '带声音的短片，最低 360p', inputs: { text: true, images: { max: 1, roles: ['first'] } }, params: [
              { key: 'durationSeconds', label: '时长', type: 'enum', group: 'basic', default: 3, options: [3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ value: n, label: n + ' 秒' })) },
              { key: 'resolution', label: '分辨率', type: 'enum', group: 'basic', default: '360p', options: [{ value: '360p', label: '360p' }, { value: '720p', label: '720p' }] },
            ] }),
          ] },
        ],
      },
      speech: {
        defaults: { provider: 'vertex', model: 'gemini-2.5-flash-tts' },
        groups: [
          { provider: vx, models: [
            m(vx, 'gemini-2.5-flash-tts', 'Gemini 2.5 Flash TTS', 'speech', { desc: '30 种音色，支持风格提示', params: [
              { key: 'voice', label: '音色', type: 'voice', group: 'basic', default: 'Kore' },
              { key: 'style', label: '风格', type: 'text', group: 'advanced' },
            ] }),
          ] },
          { provider: gm, models: [
            m(gm, 'gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS', 'speech', { paramSource: 'family', inheritsFrom: 'gemini-2.5-flash-tts', isNew: true, params: [
              { key: 'voice', label: '音色', type: 'voice', group: 'basic', default: 'Kore' },
              { key: 'style', label: '风格', type: 'text', group: 'advanced' },
            ] }),
          ] },
          { provider: el, models: [
            m(el, 'eleven_v3', 'Eleven v3', 'speech', { desc: '你自己的 ElevenLabs Key', inputs: { text: true, audio: { max: 1 } }, params: [
              { key: 'voice', label: '音色', type: 'voice', group: 'basic' },
              { key: 'stability', label: '稳定性', type: 'number', group: 'advanced', min: 0, max: 1, step: 0.05, default: 0.5 },
            ] }),
          ] },
        ],
      },
      music: {
        defaults: { provider: 'vertex', model: 'lyria-002' },
        groups: [
          { provider: vx, models: [
            m(vx, 'lyria-002', 'Lyria 2', 'music', { async: true, desc: '30 秒器乐', params: [
              { key: 'negativePrompt', label: '负面提示', type: 'text', group: 'advanced' },
              { key: 'seed', label: '种子', type: 'seed', group: 'advanced' },
            ] }),
          ] },
        ],
      },
    },
  };
}

const VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'].map((id, i) => ({ id, label: id, note: ['坚定', '欢快', '沉稳', '激昂', '轻快', '年轻', '坚定', '明亮'][i] }));
const ASSET_KIND = { image: 'image', video: 'video', speech: 'audio', music: 'music' };

export function createFixture() {
  const listeners = new Set();
  const emit = (ev) => { for (const fn of listeners) try { fn(ev); } catch {} };
  const assets = [];
  const jobs = [];
  const now = Date.now();
  // 几条旧历史：一条图 → 视频的血缘链、一条续改链、一段音乐
  const mk = (kind, prompt, ago, extra = {}) => {
    const id = uid();
    const w = extra.w || 1024, h = extra.h || 1024;
    const a = { id, kind, mime: kind === 'image' ? 'image/svg+xml' : kind === 'video' ? 'video/mp4' : 'audio/wav', prompt, provider: 'vertex', model: extra.model || 'gemini-3.1-flash-image', params: {}, parents: extra.parents || [], w, h, createdAt: now - ago, thread: extra.thread };
    a.url = kind === 'image' ? svgImage(prompt, w, h) : kind === 'video' ? '' : wavUrl(extra.duration || 3, hash(prompt));
    a.thumb = kind === 'video' || kind === 'image' ? svgImage(prompt, 320, Math.round(320 * h / w)) : '';
    if (kind !== 'image') a.duration = extra.duration || 4;
    assets.unshift(a);
    return a;
  };
  const t1 = uid();
  const base = mk('image', '黄昏的海边灯塔，胶片质感', 86400e3 * 1.2, { thread: t1 });
  const edit = mk('image', '加一只停在栏杆上的海鸥', 86400e3 * 1.1, { thread: t1, parents: [base.id] });
  mk('music', '温暖的钢琴与弦乐，慢板', 86400e3 * 0.6, { model: 'lyria-002', duration: 6 });
  mk('video', '镜头缓慢推近灯塔，海浪拍岸', 3600e3 * 5, { model: 'veo-3.1-lite', parents: [edit.id], w: 1280, h: 720 });
  mk('audio', '欢迎来到 Media Studio。', 3600e3 * 2, { model: 'gemini-2.5-flash-tts', duration: 2 });
  mk('image', '一碗冒着热气的拉面，俯拍', 1800e3, { thread: uid() });

  function run(job) {
    const dur = job.kind === 'image' ? 3500 : job.kind === 'speech' ? 2500 : 9000;
    job.state = 'queued';
    emit({ type: 'studio.job', ...pub(job) });
    setTimeout(() => {
      if (job.state === 'canceled') return;
      job.state = 'running';
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (job.state !== 'running') { clearInterval(iv); return; }
        const p = Math.min(1, (Date.now() - t0) / dur);
        job.progress = p; job.elapsed = (Date.now() - job.createdAt) / 1000; job.eta = Math.max(0, (dur - (Date.now() - t0)) / 1000);
        if (p < 1) { emit({ type: 'studio.job', ...pub(job) }); return; }
        clearInterval(iv);
        if (/失败|error/i.test(job.prompt)) { job.state = 'error'; job.error = '模拟失败：提示词里带了「失败」'; job.finishedAt = Date.now(); emit({ type: 'studio.job', ...pub(job) }); return; }
        const kind = ASSET_KIND[job.kind];
        const { model } = { model: job.key.split('/').slice(1).join('/') };
        const asp = String(job.params?.aspectRatio || '1:1').split(':').map(Number);
        const w = 1024, h = asp.length === 2 && asp[0] ? Math.round(1024 * asp[1] / asp[0]) : 1024;
        const a = mk(kind, job.prompt || '（无提示词）', 0, { model, parents: job.parent ? [job.parent] : [], thread: job.thread || (job.kind === 'image' ? uid() : undefined), w, h, duration: job.kind === 'music' ? 6 : 2 });
        a.provider = job.key.split('/')[0];
        job.state = 'done'; job.progress = 1; job.result = [a]; job.finishedAt = Date.now();
        emit({ type: 'studio.job', ...pub(job) });
      }, 400);
    }, 600);
  }
  const pub = (j) => JSON.parse(JSON.stringify({ ...j, result: j.result || [] }));

  async function handle(method, path, body) {
    await new Promise((r) => setTimeout(r, 120));
    const u = new URL(path, 'http://x');
    const p = u.pathname;
    if (method === 'GET' && p === '/api/studio/catalog') return catalog();
    if (method === 'GET' && p === '/api/studio/voices') return { voices: VOICES };
    if (method === 'GET' && p === '/api/studio/models/resolve') {
      const key = u.searchParams.get('key') || '';
      for (const blk of Object.values(catalog().kinds)) for (const g of blk.groups) for (const x of [...g.models, ...(g.shelf || [])]) {
        if (x.key !== key) continue;
        return { model: { ...x, shelf: undefined, async: x.kind === 'video', inputs: { text: true }, paramSource: 'schema', params: schemaParams().slice(0, 6) } };
      }
      throw Object.assign(new Error('没有这个模型'), { status: 404 });
    }
    if (method === 'GET' && p === '/api/studio/settings') return { autoSave: true, saveDir: 'Media Studio' };
    if (method === 'GET' && p === '/api/studio/jobs') return { jobs: jobs.slice(0, 50).map(pub) };
    if (method === 'POST' && p === '/api/studio/jobs') {
      const job = { id: uid(), kind: body.kind, key: body.key, prompt: body.prompt || '', params: body.params || {}, inputs: body.inputs || [], thread: body.thread, parent: body.parent, state: 'queued', progress: 0, createdAt: Date.now(), finishedAt: null, result: [], error: null };
      jobs.unshift(job);
      run(job);
      return { job: pub(job) };
    }
    let m = p.match(/^\/api\/studio\/jobs\/([^/]+)\/cancel$/);
    if (m) {
      const j = jobs.find((x) => x.id === m[1]);
      if (j && (j.state === 'queued' || j.state === 'running')) { j.state = 'canceled'; j.abandoned = j.kind === 'video'; j.finishedAt = Date.now(); emit({ type: 'studio.job', ...pub(j) }); }
      return { ok: true };
    }
    m = p.match(/^\/api\/studio\/jobs\/([^/]+)$/);
    if (m) return { job: pub(jobs.find((x) => x.id === m[1]) || {}) };
    if (method === 'GET' && p === '/api/studio/assets') {
      const kind = u.searchParams.get('kind'), text = (u.searchParams.get('q') || '').toLowerCase(), thread = u.searchParams.get('thread');
      let list = assets.filter((a) => (!kind || a.kind === kind) && (!text || a.prompt.toLowerCase().includes(text)) && (!thread || a.thread === thread));
      if (thread) list = [...list].reverse();
      return { items: list, cursor: null };
    }
    m = p.match(/^\/api\/studio\/assets\/([^/]+)\/delete$/);
    if (m) { const i = assets.findIndex((a) => a.id === m[1]); if (i >= 0) assets.splice(i, 1); return { ok: true }; }
    m = p.match(/^\/api\/studio\/assets\/([^/]+)\/save$/);
    if (m) { const a = assets.find((x) => x.id === m[1]); if (a) a.wsPath = (body?.dir || 'Media Studio') + '/' + a.prompt.slice(0, 12) + '.png'; return { ok: true, wsPath: a?.wsPath }; }
    throw Object.assign(new Error('fixture 没有 ' + method + ' ' + p), { status: 404 });
  }
  return { handle, listen: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
}
