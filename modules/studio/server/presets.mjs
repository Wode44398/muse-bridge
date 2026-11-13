// Media Studio 的服务预设与方言表（方案 §4）。
//
// 预设只给方言、地址、鉴权方式和内置模型清单；「自定义」服务选方言后地址自己填（OpenAI 兼容服务就是 openai 方言 + 改地址）。
// models：预设自带的模型（source 'builtin'），每个都有模型卡（cards/）；拉取来的、手填的用通用卡。
// keyUrl：去哪儿拿 Key（设置页做成链接）。admin：只有主机管理员能用（本机模型——成员只许连公网）。

export const DIALECTS = Object.freeze(['vertex', 'gemini', 'openai', 'openrouter', 'fal', 'replicate', 'elevenlabs', 'minimax', 'ark', 'local']);
export const KINDS = Object.freeze(['image', 'video', 'speech', 'music']);

// 方言能做哪几种（catalog / 设置页据此置灰）
export const DIALECT_KINDS = Object.freeze({
  vertex: ['image', 'video', 'speech', 'music'],
  gemini: ['image', 'video', 'speech', 'music'],
  openai: ['image', 'video', 'speech'],
  openrouter: ['image', 'video'],
  fal: ['image', 'video', 'speech', 'music'],
  replicate: ['image', 'video', 'speech', 'music'],
  elevenlabs: ['speech', 'music'],
  minimax: ['video', 'speech', 'music'],
  ark: ['image', 'video'],
  local: ['image'],
});

// 鉴权方式：怎么把 Key 放进请求
//   bearer          Authorization: Bearer <key>
//   x-goog-api-key  x-goog-api-key: <key>（Gemini Developer API）
//   fal-key         Authorization: Key <key>（fal）
//   xi-api-key      xi-api-key: <key>（ElevenLabs）
//   x-api-key       x-api-key: <key>
//   none            不带（vertex 走 Google 凭据，本机模型不要 Key）
export const AUTH_STYLES = Object.freeze(['bearer', 'x-goog-api-key', 'fal-key', 'xi-api-key', 'x-api-key', 'none']);
export const DIALECT_AUTH = Object.freeze({
  vertex: 'none', gemini: 'x-goog-api-key', openai: 'bearer', openrouter: 'bearer', fal: 'fal-key',
  replicate: 'bearer', elevenlabs: 'xi-api-key', minimax: 'bearer', ark: 'bearer', local: 'none',
});
// 方言不需要接口地址（vertex 按区域拼 Google 的地址、本机模型固定端口）
export const NO_BASEURL = new Set(['vertex', 'local']);

const m = (id, kind, label) => ({ id, kind, ...(label ? { label } : {}) });

export const PRESETS = Object.freeze([
  { id: 'vertex', name: 'Google Vertex AI', dialect: 'vertex', baseUrl: '', authStyle: 'none', note: '服务账号或本机 ADC',
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    models: [
      m('gemini-3-pro-image', 'image'), m('gemini-nano-banana-2.1', 'image'), m('gemini-3.1-flash-image', 'image'),
      m('gemini-3.1-flash-lite-image', 'image'), m('gemini-2.5-flash-image', 'image'),
      m('veo-3.1-fast-generate-001', 'video'), m('veo-3.1-generate-001', 'video'), m('veo-3.1-lite-generate-001', 'video'),
      m('gemini-2.5-flash-tts', 'speech'), m('gemini-3.1-flash-tts-preview', 'speech'), m('gemini-2.5-pro-tts', 'speech'),
      m('lyria-002', 'music'),
    ] },
  { id: 'gemini', name: 'Gemini API', dialect: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', authStyle: 'x-goog-api-key', note: 'Google AI Studio 的 API Key（预付费）',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      m('gemini-nano-banana-2.1', 'image'), m('gemini-omni-1.1-flash', 'video'),
      m('lyria-3.5', 'music'), m('lyria-3-clip-preview', 'music'), m('lyria-3-pro-preview', 'music'),
    ] },
  { id: 'openrouter', name: 'OpenRouter', dialect: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer',
    keyUrl: 'https://openrouter.ai/settings/keys',
    models: [m('openai/gpt-image-2.6-sunburst', 'image', 'GPT Image 2.6 Sunburst'), m('openai/gpt-image-2.5-sunburst', 'image', 'GPT Image 2.5 Sunburst')] },
  { id: 'openai', name: 'OpenAI', dialect: 'openai', baseUrl: 'https://api.openai.com/v1', authStyle: 'bearer',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [] },
  { id: 'openai-compat', name: 'OpenAI 兼容（自定义）', dialect: 'openai', baseUrl: '', authStyle: 'bearer', note: '填任何兼容 OpenAI 图像 / 语音 / 视频接口的地址',
    models: [] },
  { id: 'fal', name: 'fal', dialect: 'fal', baseUrl: 'https://queue.fal.run', authStyle: 'fal-key',
    keyUrl: 'https://fal.ai/dashboard/keys', models: [] },
  { id: 'replicate', name: 'Replicate', dialect: 'replicate', baseUrl: 'https://api.replicate.com/v1', authStyle: 'bearer',
    keyUrl: 'https://replicate.com/account/api-tokens', models: [] },
  { id: 'elevenlabs', name: 'ElevenLabs', dialect: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io/v1', authStyle: 'xi-api-key',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys', models: [] },
  { id: 'minimax', name: 'MiniMax', dialect: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', authStyle: 'bearer', note: '国内站；海外站改成 https://api.minimax.io/v1',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', models: [] },
  { id: 'ark', name: '火山方舟', dialect: 'ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', authStyle: 'bearer',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', models: [] },
  { id: 'local', name: '本机图像模型', dialect: 'local', baseUrl: '', authStyle: 'none', note: 'Qwen Image 2.1（本机 GPU）', admin: true,
    models: [m('qwen-image-2.1-local', 'image', 'Qwen Image 2.1 · 本机')] },
  { id: 'custom', name: '自定义', dialect: 'openai', baseUrl: '', authStyle: 'bearer', note: '选方言、填地址', models: [] },
]);
export const PRESET_BY_ID = Object.freeze(Object.fromEntries(PRESETS.map((p) => [p.id, p])));

/** 这个 owner 能看到的预设（成员没有「本机模型」：只许连公网）。 */
export const presetsFor = (member) => (member ? PRESETS.filter((p) => !p.admin) : PRESETS);

// 预设没写模型清单的（新方言）：用方言适配器登记的常见模型卡补上（设置页新建服务时预勾这些）
import { dialectBuiltinModels } from './cards/dialects.mjs';
export function presetsView(member) {
  // 只给官方预设（预设 id = 方言名）补；「OpenAI 兼容」「自定义」接的是别家服务，不预填 OpenAI 官方模型
  return presetsFor(member).map((p) => (p.models.length || p.id !== p.dialect ? p : { ...p, models: dialectBuiltinModels(p.dialect).map(({ id, kind, label }) => ({ id, kind, label })) }));
}
