// Shared media-tool factory for both MCP deployments:
//   - phone bridge (in-process MEDIA_MCP, via @anthropic-ai/claude-agent-sdk)
//   - desktop Claude Code (standalone stdio in mcp-media.mjs, via @modelcontextprotocol/sdk)
// Both expose the same 4 tools (generate_image/video/speech/music) with the same
// schemas and the same per-model clamps. The two flavors differ ONLY in:
//   - desktop schemas include `outputPath` (write to a user-chosen abs path)
//   - phone emits gen_media_* SSE events so the page renders artifacts inline;
//     desktop is silent
//   - result text wording (Chinese vs English; phone mentions inline display)
//
// 2026-11-04 起生成走 Media Studio（方案 §3.6）：`model` 收裸 id（按内置 Google 模型 id 解析，现有 id 全部照旧可用）
// 或 '<服务>/<模型>'；不传用 Studio 设置里的默认模型（没设就是下面的内置默认，同以前）。
// 设置全是默认值时，工具描述与 schema 一字不变（别破提示缓存）；设了默认模型才把写死内置默认的那几句换成它
// （DEFAULT_SWAP / SCHEMA_SWAP），没写死默认的工具在描述末尾补一句「当前默认」。
//
// This module produces neutral `{ name, description, schema, handler }` tool
// definitions. Each side wraps them into its SDK's `tool()` signature.

import { z } from 'zod';
import {
  IMAGE_MODELS, imgAspectFor, IMAGE_SIZES, imgSizeClamp,
  IMG_THINK_SUPPORT, IMG_THINK_LEVELS, IMG_SEARCH_SUPPORT, IMG_IMGSEARCH_SUPPORT,
  VEO_MODELS, VEO_MODEL_DEFAULT, VEO_ASPECTS, VEO_RESOLUTIONS, veoResSupport, veoDurClamp,
  TTS_MODEL_DEFAULT, TTS_MODELS, TTS_VOICES, TTS_VOICE_DEFAULT,
  MUSIC_MODELS, MUSIC_MODEL_DEFAULT,
} from '@bridge/core/config/capabilities.mjs';

// The Claude-facing image tool defaults to Nano Banana Flash — fast, cheap, and the
// only image model that supports BOTH thinking and image search (Pro does neither).
// Kept local (not capabilities.image.defaults) so the frontend media panel keeps its
// own default (currently Pro) independent of what this tool reaches for by default.
const IMG_TOOL_MODEL_DEFAULT = 'gemini-3.1-flash-image';

// '<服务 id>/<模型 id>'：交给 Studio 按服务解析，参数按模型卡规范化（这里只把 Claude 给的常用参数原样带过去）
const isKey = (m) => typeof m === 'string' && /^p-[0-9a-f]{6,12}\//.test(m);
// 设置里选的默认模型（defaults(kind) → { key, label, bare? }）：bare = 它就是内置 Google 模型，照旧按裸 id 规范化
const pickModel = (args, kind, known, fallback, defaults) => {
  if (isKey(args.model)) return { key: args.model };
  if (known.has(args.model)) return { bare: args.model };
  const d = defaults && defaults(kind);
  if (d) return d.bare ? { bare: d.bare, key: d.key } : { key: d.key };
  return { bare: fallback };
};

// ---- Param normalizers (shared across both flavors) ---------------------

function normImage(args, defaults) {
  const pick = pickModel(args, 'image', IMAGE_MODELS, IMG_TOOL_MODEL_DEFAULT, defaults);
  if (!pick.bare) {
    const imageSize = IMAGE_SIZES.has(String(args.imageSize || '').toUpperCase()) ? String(args.imageSize).toUpperCase() : '2K';
    return { key: pick.key, model: pick.key, aspectRatio: args.aspectRatio || 'auto', imageSize, isImagen: false, params: { aspectRatio: args.aspectRatio || 'auto', imageSize } };
  }
  const model = pick.bare;
  // Default 'auto' — no aspectRatio sent, model picks the ratio from the prompt /
  // source image (the handler omits the param when it sees 'auto').
  const aspectRatio = imgAspectFor(model, args.aspectRatio);
  // 尺寸再按模型夹紧（lite 只吃 1K，传 2K/4K 会 400）。
  const imageSize = imgSizeClamp(model, IMAGE_SIZES.has(String(args.imageSize || '').toUpperCase()) ? String(args.imageSize).toUpperCase() : '2K');
  const isImagen = /^imagen/.test(model); // Imagen ignores imageSize (fixed res)
  // Thinking is a Nano Banana Flash-only knob (minimal/high). Default 'minimal' on
  // models that support it — cheap deliberation for better adherence — and leave it
  // undefined (param omitted) on models that can't (Pro / 2.5 / Imagen).
  const thinkingLevel = IMG_THINK_SUPPORT.has(model)
    ? (IMG_THINK_LEVELS.has(String(args.thinking || '').toLowerCase()) ? String(args.thinking).toLowerCase() : 'minimal')
    : undefined;
  // Google Search grounding defaults ON wherever the model supports it (better
  // real-world accuracy); image search also defaults ON for Nano Banana Flash.
  // Both are capability-gated and Claude can pass useSearch/useImageSearch:false to opt out per call.
  const useImageSearch = IMG_IMGSEARCH_SUPPORT.has(model) && args.useImageSearch !== false;
  const useSearch = IMG_SEARCH_SUPPORT.has(model) && args.useSearch !== false;
  return {
    key: pick.key || model, model, aspectRatio, imageSize, isImagen, thinkingLevel, useSearch, useImageSearch,
    params: { aspectRatio, imageSize, thinkingLevel, useSearch, useImageSearch },
  };
}

function normVideo(args, defaults) {
  const pick = pickModel(args, 'video', VEO_MODELS, VEO_MODEL_DEFAULT, defaults);
  if (!pick.bare) {
    const p = { aspectRatio: args.aspectRatio || 'auto', durationSeconds: args.durationSeconds ?? 8, resolution: String(args.resolution || '720p').toLowerCase() };
    return { key: pick.key, model: pick.key, ...p, params: { ...p, generateAudio: true } };
  }
  const model = pick.bare;
  // 默认 auto = 不传比例参数（有首帧图跟源图；Omni 纯文字按 prompt 语义自选，Veo 纯文字回落 16:9）。
  const aspectRatio = VEO_ASPECTS.has(args.aspectRatio) ? args.aspectRatio : 'auto';
  // 时长按模型夹紧：Omni 3–10 逐秒、Veo 3.1 只有 4/6/8；不在表内取最近档，不再一律回落 8。
  const durationSeconds = veoDurClamp(model, args.durationSeconds ?? 8);
  // Clamp the requested resolution to what this model actually supports
  // (e.g. 4k only on veo-3.1) so the model can't trigger a backend error.
  let resolution = VEO_RESOLUTIONS.has(String(args.resolution || '').toLowerCase()) ? String(args.resolution).toLowerCase() : '720p';
  const allowed = veoResSupport(model);
  if (!allowed.includes(resolution)) resolution = allowed[allowed.length - 1];
  return { key: pick.key || model, model, aspectRatio, durationSeconds, resolution, params: { aspectRatio, durationSeconds, resolution, generateAudio: true } };
}

function normSpeech(args, defaults) {
  const voice = TTS_VOICES.has(args.voice) ? args.voice : TTS_VOICE_DEFAULT;
  const d = defaults && defaults('speech');
  if (d && !d.bare) return { key: d.key, model: d.key, voice: args.voice || '', params: args.voice ? { voice: args.voice } : {} };
  const model = d && d.bare && TTS_MODELS.has(d.bare) ? d.bare : TTS_MODEL_DEFAULT;
  return { key: (d && d.key) || model, model, voice, params: { voice } };
}

function normMusic(args, defaults) {
  const pick = pickModel(args, 'music', MUSIC_MODELS, MUSIC_MODEL_DEFAULT, defaults);
  return { key: pick.key || pick.bare, model: pick.bare || pick.key, params: {} };
}

// ---- Tool descriptions --------------------------------------------------
// Phone descriptions stay in Chinese (matching the existing MEDIA_NUDGE tone +
// what Claude reads at runtime on the bridge); desktop is English (Claude Code's
// runtime language). Capability facts (4k availability, default models, etc.)
// are identical across flavors — only the "where the file lives" sentence differs.

const DESC = {
  phone: {
    generate_image: 'Generate an image from a text prompt (Google Nano Banana). Use proactively whenever an image asset would help the request — illustrations, a hero/background image for an HTML page, a requested picture, etc. DEFAULTS: model Nano Banana Flash (gemini-3.1-flash-image), aspectRatio auto (model picks the ratio), imageSize 2K, thinking minimal. Sizes 1K / 2K / 4K via `imageSize`（Pro/Flash 支持到 4K；Lite 只出 1K，传大了自动落回）. Google 联网搜索 + 图片搜索均【默认开启】（默认模型 Flash 两者都支持，提升真实世界准确度）；纯抽象/艺术图可传 useSearch:false / useImageSearch:false 关闭。thinking 仅 Flash/Lite/2.1 支持(minimal/high)。Nano Banana 2.1（gemini-nano-banana-2.1）：画质与文字渲染更好、独有超宽比例 4:1/1:4/8:1/1:8；2K/4K 走 Gemini API 预付费额度（出 JPEG）。GPT Image 2.6 Sunburst（gpt-image-2.6-sunburst，OpenAI 最新款）与 2.5 Sunburst（gpt-image-2.5-sunburst，更便宜），均经 OpenRouter：构图/文字/指令遵循精细，1K/2K/4K，无思考与搜索。The image is shown to the user inline AND its absolute file path is returned so you can Read it or copy it into your project as an asset.',
    generate_video: 'Generate a short video from a text prompt (Google Veo / Gemini Omni). SLOW (1-3 min) and EXPENSIVE — use only when the user clearly wants a video. Default model veo-3.1-fast (720p/1080p/4k). 也可传 model:"gemini-omni-1.1-flash"（Google 新一代视频模型：原生自带音轨/对白，360p 低价预览档，时长≥3s，适合要"带声音的片段"或省钱预览）。Pass `resolution` when the user asks for HD/4K (otherwise it defaults to 720p to stay cheap). Shown to the user inline; returns the absolute .mp4 path for use as an asset.',
    generate_speech: 'Synthesize speech (text-to-speech, Gemini TTS) — read text aloud in a chosen voice. Use when narration / spoken audio would serve the request. Shown to the user inline; returns the absolute .wav path.',
    generate_music: 'Generate a music clip or song from a style description (Google Lyria). Use when background music / a track would serve the request. SLOW (~1-2 min). Shown to the user inline; returns the absolute audio file path.',
  },
  desktop: {
    generate_image: 'Generate an image with Google Nano Banana (Vertex AI). Returns the absolute path to the saved file so you can use it as an asset (Read it, copy into a project, reference in HTML). Pass outputPath (absolute) to control where it lands. Defaults: model Nano Banana Flash (gemini-3.1-flash-image) — fast, cheap, up to 4K, supports image search; aspectRatio auto (model picks the ratio); imageSize 2K; thinking minimal. Google Search grounding AND image search are both ON by default (Flash supports both). Pass useSearch:false / useImageSearch:false to disable for purely abstract/artistic images; thinking (minimal/high) is Flash/Lite/2.1-only. Nano Banana 2.1 (gemini-nano-banana-2.1) has better quality and text rendering plus ultra-wide ratios 4:1/1:4/8:1/1:8; its 2K/4K runs on the prepaid Gemini API key and returns JPEG. GPT Image 2.6 Sunburst (gpt-image-2.6-sunburst, newest) and 2.5 Sunburst (gpt-image-2.5-sunburst, cheaper), OpenAI via OpenRouter, are precise on layout, text and instruction-following, 1K/2K/4K, no thinking/search. Prompting: describe subject + style + composition + lighting; pass aspectRatio or leave auto.',
    generate_video: 'Generate a short video with Google Veo or Gemini Omni. SLOW (~1-3 min) and EXPENSIVE — use deliberately. Default model veo-3.1-fast (720p/1080p/4k). Alternatively pass model:"gemini-omni-1.1-flash" — Google\'s new conversational video model with native audio/dialogue always on, a cheap 360p preview tier, min duration 3s. Pass `resolution` for HD/4K, else it defaults to 720p. Returns the absolute path to the saved .mp4. Prompting: describe scene + camera movement + lighting + motion (Omni: also describe the sound you want). Pass outputPath (absolute) to control where it lands.',
    generate_speech: 'Text-to-speech with Gemini TTS (Vertex AI). Returns the absolute path to the saved .wav. Voices include Kore (steady), Puck (upbeat), Zephyr (bright), Charon (deep), Fenrir, Aoede, Leda, Orus, Enceladus (breathy), Algieba. You can embed emotion tags inline in the text like [laughs], [whispers], [sighs].',
    generate_music: 'Generate a music clip or song with Google Lyria. SLOW (~1-2 min). Returns the absolute path to the saved audio. Prompting: describe genre + instruments + mood + tempo (bpm); English works best, e.g. "calm lo-fi hip hop, mellow piano, vinyl crackle, 80 bpm". Default lyria-002 (~30s WAV); lyria-3.5 makes a full ~1 min+ song and can sing (put lyrics with [Verse]/[Chorus] tags in the prompt); lyria-3-pro-preview can do up to 3 min (lyria-3* need the Gemini key).',
  },
};

// 描述里写死内置默认模型的句子：Studio 设置里选了默认模型（d = { key, label }）时就地换成它，不再只在末尾补一句——
// 开头还写着「默认 Flash」、末尾又说「默认 GPT Image」，两个默认打架（2026-11-07 反馈）。没设就不换，原文一字不变。
// [原句, (d) => 新句]；原句必须逐字出现在上面的描述里（单测守着）。不在表里的工具照旧在末尾补一句。
const DEFAULT_SWAP = {
  phone: {
    generate_image: [
      ['DEFAULTS: model Nano Banana Flash (gemini-3.1-flash-image), ', (d) => `DEFAULTS: model ${d.label}（Media Studio 设置里选的，不传 model 就用它；也可传 model:"${d.key}"）, `],
      ['均【默认开启】（默认模型 Flash 两者都支持，提升真实世界准确度）', () => '在支持的 Nano Banana 模型上【默认开启】（提升真实世界准确度，其它模型不带）'],
    ],
    generate_video: [
      ['Default model veo-3.1-fast (720p/1080p/4k). ', (d) => `Default model ${d.label}（Media Studio 设置里选的，不传 model 就用它；也可传 model:"${d.key}"）；内置 veo-3.1-fast 支持 720p/1080p/4k。`],
    ],
  },
  desktop: {
    generate_image: [
      ['Defaults: model Nano Banana Flash (gemini-3.1-flash-image) — fast, cheap, up to 4K, supports image search; ', (d) => `Defaults: model ${d.label} (set in Media Studio settings — omit model to use it, or pass model:"${d.key}"); `],
      ['Google Search grounding AND image search are both ON by default (Flash supports both). ', () => 'Google Search grounding and image search are ON by default on the Nano Banana models that support them. '],
    ],
    generate_video: [
      ['Default model veo-3.1-fast (720p/1080p/4k). ', (d) => `Default model ${d.label} (set in Media Studio settings — omit model to use it, or pass model:"${d.key}"); built-in veo-3.1-fast does 720p/1080p/4k. `],
    ],
    generate_music: [
      ['Default lyria-002 (~30s WAV); ', (d) => `Default ${d.label} (set in Media Studio settings — omit model to use it, or pass model:"${d.key}"); lyria-002 makes ~30s WAV; `],
    ],
  },
};

// ---- Schemas -----------------------------------------------------------
// Base param shapes (zod). Desktop adds `outputPath` (build that variant in the
// factory below). Descriptions are English-leaning since zod descriptions
// surface to the model as JSON schema doc text on both flavors.

const BASE_SCHEMAS = {
  generate_image: {
    prompt: z.string().describe('图像描述 / image description'),
    aspectRatio: z.string().optional().describe('auto / 1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 / 5:4 / 4:5 / 21:9，另有 4:1 / 1:4 / 8:1 / 1:8（仅 Nano Banana 2.1 gemini-nano-banana-2.1，其他模型按 auto 处理），默认 auto（不指定，由模型按内容/原图自选比例）。'),
    imageSize: z.string().optional().describe('1K / 2K / 4K，默认 2K。Pro/Flash 支持到 4K；Lite 只出 1K（传大了自动落回）。'),
    model: z.string().optional().describe('可选模型 id，默认 Nano Banana Flash = gemini-3.1-flash-image（快/便宜，唯一同时支持思考+联网+图片搜索，出图到 4K）。其它：gemini-3-pro-image=Pro（画质最高，支持联网，无思考/图搜）、gemini-3.1-flash-lite-image=Lite（最省，仅 1K，支持思考，无联网/图搜——图标/小装饰首选）、gemini-nano-banana-2.1=2.1（新款，画质/文字更好，思考+联网+图搜都支持，独有 4:1/1:4/8:1/1:8 超宽比例，2K/4K 走 Gemini API 预付费额度）、gpt-image-2.6-sunburst=GPT Image 2.6 Sunburst（OpenAI 最新款，经 OpenRouter，排版/文字/指令遵循最精细，1K/2K/4K，无思考/联网）、gpt-image-2.5-sunburst=GPT Image 2.5 Sunburst（上一代，便宜不少）。'),
    thinking: z.string().optional().describe('思考强度 minimal / high，默认 minimal。仅 Nano Banana Flash 支持，其它模型自动忽略。'),
    useSearch: z.boolean().optional().describe('Google 联网搜索增强，提升真实世界（人物/品牌/地标/时事）准确度。【默认开启】，仅 Nano Banana Pro/Flash 支持；纯抽象/艺术图不需要可传 false。'),
    useImageSearch: z.boolean().optional().describe('图片搜索增强（含联网搜索），仅 Nano Banana Flash 支持。默认模型即 Flash，故【默认开启】；不需要可传 false。'),
  },
  generate_video: {
    prompt: z.string().describe('视频描述 / video description'),
    aspectRatio: z.string().optional().describe('auto / 16:9 / 9:16，默认 auto（不指定：有首帧图跟源图；Omni 纯文字按内容自选，Veo 纯文字出横版）。'),
    durationSeconds: z.number().optional().describe('时长（秒），默认 8。veo-3.1 全系只吃 4 / 6 / 8；gemini-omni-1.1-flash 是 3–10 逐秒可选。传了该模型不支持的值会落到最近的合法档。'),
    resolution: z.string().optional().describe('360p / 720p / 1080p / 4k，默认 720p。veo-3.1 全系 720p-4k；360p 仅 Omni（低价预览档）。'),
    model: z.string().optional().describe('模型 id，默认 veo-3.1-fast-generate-001（支持到 4k）。另有 gemini-omni-1.1-flash=Omni 1.1（新一代，原生带音轨/对白，360p-4k，时长≥3s）。'),
  },
  generate_speech: {
    text: z.string().describe('要朗读的文字（可含 [laughs] 等语气标签）'),
    voice: z.string().optional().describe('音色，如 Kore/Puck/Zephyr，默认 Kore'),
  },
  generate_music: {
    prompt: z.string().describe('曲风描述，英文更准，如 calm lo-fi hip hop, 80 bpm'),
    model: z.string().optional().describe('可选模型 id，默认 lyria-002'),
  },
};

// schema 字段说明里的同类句子（两种版本共用）：同 DEFAULT_SWAP，设了默认模型才换。{ 工具: { 字段: [原句, (d) => 新句] } }
const SCHEMA_SWAP = {
  generate_image: {
    model: ['可选模型 id，默认 Nano Banana Flash = gemini-3.1-flash-image（', (d) => `可选模型 id，不传 = 当前默认 ${d.label}（Media Studio 设置里选的，也可传 "${d.key}"）。内置：gemini-3.1-flash-image=Nano Banana Flash（`],
    useImageSearch: ['仅 Nano Banana Flash 支持。默认模型即 Flash，故【默认开启】', () => '仅 Nano Banana Flash / 2.1 支持，所选模型支持时【默认开启】'],
  },
  generate_video: {
    model: ['模型 id，默认 veo-3.1-fast-generate-001（支持到 4k）。另有', (d) => `模型 id，不传 = 当前默认 ${d.label}（Media Studio 设置里选的，也可传 "${d.key}"）。内置 veo-3.1-fast-generate-001 支持到 4k；另有`],
  },
  generate_music: {
    model: ['可选模型 id，默认 lyria-002', (d) => `可选模型 id，不传 = 当前默认 ${d.label}（Media Studio 设置里选的，也可传 "${d.key}"）；内置有 lyria-002 等`],
  },
};
// 换句用函数替换，免得 label / key 里的 $ 被当成替换模式
const swapIn = (text, from, to) => text.replace(from, () => to);

const OUTPUT_PATH_FIELD = {
  outputPath: z.string().optional().describe('absolute path to write the file to (e.g. D:\\proj\\assets\\hero.png)'),
};

// ---- Factory -----------------------------------------------------------
// adapter: {
//   newId: () => string,
//   generate: (kind, body, { id, outputPath, onProgress }) => Promise<{ id, file, model?, width?, height?, params? }>
//       走 Studio：phone = 任务执行器（作品落调用者的媒体库，id 就是作品 id）；desktop = 直接跑、写到 outputPath / genmedia
//       图片可带回实际像素 width / height；params = 真正下发的参数（卡规范化之后），有它才查降档
//   emit: (event) => void,                                  // phone: SSE gen_media_*; desktop: no-op
//   resultText: (kind, info) => string,                     // success text
//   errorText: (kind, message) => string,                   // failure text
// }
// defaults(kind) → { key, label, bare? } | null：Studio 设置里显式选的默认模型（没设 = null，描述一字不变）
const KIND_OF_TOOL = { generate_image: 'image', generate_video: 'video', generate_speech: 'speech', generate_music: 'music' };

// 实际像素明显低于下发的尺寸档 = 没拿到要的大图（2026-11-07 Pro 请求 4K 实出 768×1376——取到了思考草图，见 imagen.mjs pickImagePart）。
// 按总像素判、不按长边：Gemini 各档按面积走（1K≈1MP、2K≈4MP、4K≈16MP；2.1 的 1:8 在 1K 档长边就有 2928），
// GPT Image 按长边走、4K 封顶 3840×2160≈8.3MP、2K 21:9≈1.8MP、auto 不传尺寸约 1536×864。门槛夹在「本档最小」和「低一档最大」之间；1K 不判。
const SIZE_FLOOR = { '2K': 1.2e6, '4K': 5e6 };
export const belowSize = (size, w, h) => !!SIZE_FLOOR[size] && w > 0 && h > 0 && w * h < SIZE_FLOOR[size];

export function buildMediaTools({ flavor = 'phone', adapter, defaults = null }) {
  const desc = DESC[flavor] || DESC.phone;
  const swaps = DEFAULT_SWAP[flavor] || DEFAULT_SWAP.phone;
  const includeOutputPath = flavor === 'desktop';
  const defaultOf = (name) => (defaults && defaults(KIND_OF_TOOL[name])) || null;
  // 设了默认模型：字段说明里写死内置默认的句子换掉（没设 = 原对象原样返回）
  const schemaOf = (key) => {
    const d = defaultOf(key);
    let s = BASE_SCHEMAS[key];
    if (d && SCHEMA_SWAP[key]) {
      s = { ...s };
      for (const [f, [from, to]] of Object.entries(SCHEMA_SWAP[key])) s[f] = s[f].describe(swapIn(s[f].description, from, to(d)));
    }
    return includeOutputPath ? { ...s, ...OUTPUT_PATH_FIELD } : s;
  };
  // 设了默认模型：描述里写死内置默认的句子就地换掉；没写死的工具在末尾补一句（都只在改过设置时出现）
  const describe = (name) => {
    const d = defaultOf(name);
    if (!d) return desc[name];
    if (swaps[name]) return swaps[name].reduce((t, [from, to]) => swapIn(t, from, to(d)), desc[name]);
    return desc[name] + (flavor === 'desktop'
      ? ` Current default model (set in Media Studio settings): ${d.label} — omit model to use it, or pass model:"${d.key}".`
      : ` 当前默认模型（Media Studio 设置里选的）：${d.label}，不传 model 就用它；也可传 model:"${d.key}"。`);
  };
  const evKind = (kind) => (kind === 'speech' ? 'audio' : kind);
  const gen = (kind, args, p, id) => adapter.generate(kind, {
    kind, key: p.key, prompt: String((kind === 'speech' ? args.text : args.prompt) || ''), params: p.params,
  }, { id, outputPath: args.outputPath, onProgress: (s) => adapter.emit({ type: 'gen_media_progress', id, kind: evKind(kind), elapsed: s }) });

  const tool = (name, kind, norm, promptOf) => ({
    name,
    description: describe(name),
    schema: schemaOf(name),
    handler: async (args) => {
      const id = adapter.newId();
      const p = norm(args, defaults);
      adapter.emit({ type: 'gen_media_start', id, kind: evKind(kind) });
      try {
        const r = await gen(kind, args, p, id);
        adapter.emit({ type: 'gen_media', id: r.id, kind: evKind(kind), prompt: promptOf(args) });
        const info = { ...p, model: r.model || p.model, prompt: promptOf(args), file: r.file, id: r.id };
        // 图片：回执报实际像素，不只回显请求档位。有真正下发的参数就按它的尺寸档（卡不收 imageSize 就没有，不报也不判）查降档
        if (r.width > 0 && r.height > 0) {
          Object.assign(info, { width: r.width, height: r.height });
          if (r.params) Object.assign(info, { imageSize: r.params.imageSize, downscaled: !p.isImagen && belowSize(r.params.imageSize, r.width, r.height) });
        }
        return { content: [{ type: 'text', text: adapter.resultText(evKind(kind), info) }] };
      } catch (e) {
        adapter.emit({ type: 'gen_media_error', id, kind: evKind(kind), message: String(e?.message ?? e) });
        return { isError: true, content: [{ type: 'text', text: adapter.errorText(evKind(kind), e) }] };
      }
    },
  });

  return [
    tool('generate_image', 'image', normImage, (a) => a.prompt),
    tool('generate_video', 'video', normVideo, (a) => a.prompt),
    tool('generate_speech', 'speech', normSpeech, (a) => a.text),
    tool('generate_music', 'music', normMusic, (a) => a.prompt),
  ];
}
