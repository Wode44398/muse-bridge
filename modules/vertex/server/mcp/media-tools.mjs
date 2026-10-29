// Shared media-tool factory for both MCP deployments:
//   - phone bridge (in-process MEDIA_MCP in server.mjs, via @anthropic-ai/claude-agent-sdk)
//   - desktop Claude Code (standalone stdio in mcp-media.mjs, via @modelcontextprotocol/sdk)
// Both expose the same 4 tools (generate_image/video/speech/music) with the same
// schemas, the same per-model clamps and the same driver calls. The two flavors
// differ ONLY in:
//   - desktop schemas include `outputPath` (write to a user-chosen abs path)
//   - phone emits gen_media_* SSE events so the page renders artifacts inline;
//     desktop is silent
//   - result text wording (Chinese vs English; phone mentions inline display)
//
// This module produces neutral `{ name, description, schema, handler }` tool
// definitions. Each side wraps them into its SDK's `tool()` signature.
//
// Single source of truth for model enums / defaults / per-model caps lives in
// ../config/capabilities.mjs — imported below; do NOT duplicate them here.

import { z } from 'zod';
import {
  IMAGE_MODELS, imgAspectFor, IMAGE_SIZES, imgSizeClamp,
  IMG_THINK_SUPPORT, IMG_THINK_LEVELS, IMG_SEARCH_SUPPORT, IMG_IMGSEARCH_SUPPORT,
  VEO_MODELS, VEO_MODEL_DEFAULT, VEO_ASPECTS, VEO_RESOLUTIONS, veoResSupport, veoDurClamp, veoDurSupport,
  TTS_MODEL_DEFAULT, TTS_VOICES, TTS_VOICE_DEFAULT,
  MUSIC_MODELS, MUSIC_MODEL_DEFAULT,
} from '@bridge/core/config/capabilities.mjs';

// The Claude-facing image tool defaults to Nano Banana Flash — fast, cheap, and the
// only image model that supports BOTH thinking and image search (Pro does neither).
// Kept local (not capabilities.image.defaults) so the frontend media panel keeps its
// own default (currently Pro) independent of what this tool reaches for by default.
const IMG_TOOL_MODEL_DEFAULT = 'gemini-3.1-flash-image';

// ---- Param normalizers (shared across both flavors) ---------------------

function normImage(args) {
  const model = IMAGE_MODELS.has(args.model) ? args.model : IMG_TOOL_MODEL_DEFAULT;
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
  // real-world accuracy); image search also defaults ON for Nano Banana Flash (the
  // only model that supports it, and it implies web search). Both are capability-
  // gated — silently off on models that can't do them (Imagen / Nano Banana 2.5 /
  // Pro's image-search) — and Claude can still pass useSearch/useImageSearch:false
  // to opt out per call. Since the tool now defaults to Flash, both are ON by default.
  const useImageSearch = IMG_IMGSEARCH_SUPPORT.has(model) && args.useImageSearch !== false;
  const useSearch = IMG_SEARCH_SUPPORT.has(model) && args.useSearch !== false;
  return { model, aspectRatio, imageSize, isImagen, thinkingLevel, useSearch, useImageSearch };
}

function normVideo(args) {
  const model = VEO_MODELS.has(args.model) ? args.model : VEO_MODEL_DEFAULT;
  // 默认 auto = 不传比例参数（有首帧图跟源图；Omni 纯文字按 prompt 语义自选，Veo 纯文字回落 16:9）。
  const aspectRatio = VEO_ASPECTS.has(args.aspectRatio) ? args.aspectRatio : 'auto';
  // 时长按模型夹紧：Omni 3–10 逐秒、Veo 3.1 只有 4/6/8；不在表内取最近档，不再一律回落 8。
  const durationSeconds = veoDurClamp(model, args.durationSeconds ?? 8);
  // Clamp the requested resolution to what this model actually supports
  // (e.g. 4k only on veo-3.1) so the model can't trigger a backend error.
  let resolution = VEO_RESOLUTIONS.has(String(args.resolution || '').toLowerCase()) ? String(args.resolution).toLowerCase() : '720p';
  const allowed = veoResSupport(model);
  if (!allowed.includes(resolution)) resolution = allowed[allowed.length - 1];
  return { model, aspectRatio, durationSeconds, resolution };
}

function normSpeech(args) {
  const voice = TTS_VOICES.has(args.voice) ? args.voice : TTS_VOICE_DEFAULT;
  return { model: TTS_MODEL_DEFAULT, voice };
}

function normMusic(args) {
  const model = MUSIC_MODELS.has(args.model) ? args.model : MUSIC_MODEL_DEFAULT;
  return { model };
}

// ---- Tool descriptions --------------------------------------------------
// Phone descriptions stay in Chinese (matching the existing MEDIA_NUDGE tone +
// what Claude reads at runtime on the bridge); desktop is English (Claude Code's
// runtime language). Capability facts (4k availability, default models, etc.)
// are identical across flavors — only the "where the file lives" sentence differs.

const DESC = {
  phone: {
    generate_image: 'Generate an image from a text prompt (Google Nano Banana). Use proactively whenever an image asset would help the request — illustrations, a hero/background image for an HTML page, a requested picture, etc. DEFAULTS: model Nano Banana Flash (gemini-3.1-flash-image), aspectRatio auto (model picks the ratio), imageSize 2K, thinking minimal. Sizes 1K / 2K / 4K via `imageSize`（Pro/Flash 支持到 4K；Lite 只出 1K，传大了自动落回）. Google 联网搜索 + 图片搜索均【默认开启】（默认模型 Flash 两者都支持，提升真实世界准确度）；纯抽象/艺术图可传 useSearch:false / useImageSearch:false 关闭。thinking 仅 Flash/Lite/2.1 支持(minimal/high)。Nano Banana 2.1（gemini-nano-banana-2.1）：画质与文字渲染更好、独有超宽比例 4:1/1:4/8:1/1:8；2K/4K 走 Gemini API 预付费额度（出 JPEG）。The image is shown to the user inline AND its absolute file path is returned so you can Read it or copy it into your project as an asset.',
    generate_video: 'Generate a short video from a text prompt (Google Veo / Gemini Omni). SLOW (1-3 min) and EXPENSIVE — use only when the user clearly wants a video. Default model veo-3.1-fast (720p/1080p/4k). 也可传 model:"gemini-omni-1.1-flash"（Google 新一代视频模型：原生自带音轨/对白，360p 低价预览档，时长≥3s，适合要"带声音的片段"或省钱预览）。Pass `resolution` when the user asks for HD/4K (otherwise it defaults to 720p to stay cheap). Shown to the user inline; returns the absolute .mp4 path for use as an asset.',
    generate_speech: 'Synthesize speech (text-to-speech, Gemini TTS) — read text aloud in a chosen voice. Use when narration / spoken audio would serve the request. Shown to the user inline; returns the absolute .wav path.',
    generate_music: 'Generate a music clip or song from a style description (Google Lyria). Use when background music / a track would serve the request. SLOW (~1-2 min). Shown to the user inline; returns the absolute audio file path.',
  },
  desktop: {
    generate_image: 'Generate an image with Google Nano Banana (Vertex AI). Returns the absolute path to the saved file so you can use it as an asset (Read it, copy into a project, reference in HTML). Pass outputPath (absolute) to control where it lands. Defaults: model Nano Banana Flash (gemini-3.1-flash-image) — fast, cheap, up to 4K, supports image search; aspectRatio auto (model picks the ratio); imageSize 2K; thinking minimal. Google Search grounding AND image search are both ON by default (Flash supports both). Pass useSearch:false / useImageSearch:false to disable for purely abstract/artistic images; thinking (minimal/high) is Flash/Lite/2.1-only. Nano Banana 2.1 (gemini-nano-banana-2.1) has better quality and text rendering plus ultra-wide ratios 4:1/1:4/8:1/1:8; its 2K/4K runs on the prepaid Gemini API key and returns JPEG. Prompting: describe subject + style + composition + lighting; pass aspectRatio or leave auto.',
    generate_video: 'Generate a short video with Google Veo or Gemini Omni. SLOW (~1-3 min) and EXPENSIVE — use deliberately. Default model veo-3.1-fast (720p/1080p/4k). Alternatively pass model:"gemini-omni-1.1-flash" — Google\'s new conversational video model with native audio/dialogue always on, a cheap 360p preview tier, min duration 3s. Pass `resolution` for HD/4K, else it defaults to 720p. Returns the absolute path to the saved .mp4. Prompting: describe scene + camera movement + lighting + motion (Omni: also describe the sound you want). Pass outputPath (absolute) to control where it lands.',
    generate_speech: 'Text-to-speech with Gemini TTS (Vertex AI). Returns the absolute path to the saved .wav. Voices include Kore (steady), Puck (upbeat), Zephyr (bright), Charon (deep), Fenrir, Aoede, Leda, Orus, Enceladus (breathy), Algieba. You can embed emotion tags inline in the text like [laughs], [whispers], [sighs].',
    generate_music: 'Generate a music clip or song with Google Lyria. SLOW (~1-2 min). Returns the absolute path to the saved audio. Prompting: describe genre + instruments + mood + tempo (bpm); English works best, e.g. "calm lo-fi hip hop, mellow piano, vinyl crackle, 80 bpm". Default lyria-002 (~30s WAV); lyria-3.5 makes a full ~1 min+ song and can sing (put lyrics with [Verse]/[Chorus] tags in the prompt); lyria-3-pro-preview can do up to 3 min (lyria-3* need the Gemini key).',
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
    model: z.string().optional().describe('可选模型 id，默认 Nano Banana Flash = gemini-3.1-flash-image（快/便宜，唯一同时支持思考+联网+图片搜索，出图到 4K）。其它：gemini-3-pro-image=Pro（画质最高，支持联网，无思考/图搜）、gemini-3.1-flash-lite-image=Lite（最省，仅 1K，支持思考，无联网/图搜——图标/小装饰首选）、gemini-nano-banana-2.1=2.1（新款，画质/文字更好，思考+联网+图搜都支持，独有 4:1/1:4/8:1/1:8 超宽比例，2K/4K 走 Gemini API 预付费额度）。'),
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

const OUTPUT_PATH_FIELD = {
  outputPath: z.string().optional().describe('absolute path to write the file to (e.g. D:\\proj\\assets\\hero.png)'),
};

// ---- Factory -----------------------------------------------------------
// adapter: {
//   newId: () => string,
//   save: (id, bytes, ext, meta, outputPath?) => string,   // returns abs file path (for the model's reply text)
//   emit: (event) => void,                                  // phone: SSE gen_media_*; desktop: no-op
//   resultText: (kind, info) => string,                     // success text
//   errorText: (kind, message) => string,                   // failure text
// }
// loc: { project, globalLoc, mediaLoc, apiKey }
export function buildMediaTools({ flavor = 'phone', adapter, loc }) {
  const desc = DESC[flavor] || DESC.phone;
  const includeOutputPath = flavor === 'desktop';
  const schemaOf = (key) => includeOutputPath ? { ...BASE_SCHEMAS[key], ...OUTPUT_PATH_FIELD } : BASE_SCHEMAS[key];

  return [
    {
      name: 'generate_image',
      description: desc.generate_image,
      schema: schemaOf('generate_image'),
      handler: async (args) => {
        const id = adapter.newId();
        const p = normImage(args);
        adapter.emit({ type: 'gen_media_start', id, kind: 'image' });
        try {
          const imagen = await import('../imagen.mjs');
          const location = p.isImagen ? loc.mediaLoc : loc.globalLoc;
          const r = await imagen.generate({ model: p.model, prompt: String(args.prompt || ''), aspectRatio: p.aspectRatio === 'auto' ? undefined : p.aspectRatio, imageSize: p.imageSize, thinkingLevel: p.thinkingLevel, useSearch: p.useSearch, useImageSearch: p.useImageSearch, project: loc.project, location });
          const ext = /jpeg/.test(r.mime) ? 'jpg' : (/webp/.test(r.mime) ? 'webp' : 'png');
          const meta = { kind: 'image', prompt: args.prompt, model: p.model, aspectRatio: p.aspectRatio, imageSize: p.isImagen ? '' : p.imageSize, thinkingLevel: p.thinkingLevel || '', useSearch: p.useSearch, useImageSearch: p.useImageSearch };
          const file = adapter.save(id, r.bytes, ext, meta, args.outputPath);
          adapter.emit({ type: 'gen_media', id, kind: 'image', prompt: args.prompt });
          return { content: [{ type: 'text', text: adapter.resultText('image', { ...p, prompt: args.prompt, file, id }) }] };
        } catch (e) {
          adapter.emit({ type: 'gen_media_error', id, kind: 'image', message: String(e?.message ?? e) });
          return { isError: true, content: [{ type: 'text', text: adapter.errorText('image', e) }] };
        }
      },
    },
    {
      name: 'generate_video',
      description: desc.generate_video,
      schema: schemaOf('generate_video'),
      handler: async (args) => {
        const id = adapter.newId();
        const p = normVideo(args);
        adapter.emit({ type: 'gen_media_start', id, kind: 'video' });
        try {
          let buf;
          if (/^gemini-omni/.test(p.model)) {
            // Omni：dev API Interactions（key 通道）；音频恒开。
            const omni = await import('../omni.mjs');
            const r = await omni.generate({
              model: p.model, prompt: String(args.prompt || ''),
              aspectRatio: p.aspectRatio, durationSeconds: p.durationSeconds, resolution: p.resolution,
              apiKey: loc.apiKey,
              onProgress: (s) => adapter.emit({ type: 'gen_media_progress', id, kind: 'video', elapsed: s }),
            });
            buf = r.bytes;
          } else {
            const veo = await import('../veo.mjs');
            const vids = await veo.generate({
              prompt: String(args.prompt || ''),
              model: p.model,
              aspectRatio: p.aspectRatio === 'auto' ? undefined : p.aspectRatio,
              durationSeconds: p.durationSeconds,
              resolution: p.resolution,
              generateAudio: true, numberOfVideos: 1,
              project: loc.project, location: loc.mediaLoc,
              onProgress: (s) => adapter.emit({ type: 'gen_media_progress', id, kind: 'video', elapsed: s }),
            });
            const v = vids[0];
            if (!v) throw new Error('Veo 没有返回视频 / no video returned');
            buf = await veo.fetchBytes(v, loc.project, loc.mediaLoc);
          }
          const usedRes = p.resolution;
          const meta = { kind: 'video', prompt: args.prompt, model: p.model, aspectRatio: p.aspectRatio, durationSeconds: p.durationSeconds, resolution: usedRes };
          const file = adapter.save(id, buf, 'mp4', meta, args.outputPath);
          adapter.emit({ type: 'gen_media', id, kind: 'video', prompt: args.prompt });
          return { content: [{ type: 'text', text: adapter.resultText('video', { ...p, resolution: usedRes, prompt: args.prompt, file, id }) }] };
        } catch (e) {
          adapter.emit({ type: 'gen_media_error', id, kind: 'video', message: String(e?.message ?? e) });
          return { isError: true, content: [{ type: 'text', text: adapter.errorText('video', e) }] };
        }
      },
    },
    {
      name: 'generate_speech',
      description: desc.generate_speech,
      schema: schemaOf('generate_speech'),
      handler: async (args) => {
        const id = adapter.newId();
        const p = normSpeech(args);
        adapter.emit({ type: 'gen_media_start', id, kind: 'audio' });
        try {
          const tts = await import('../tts.mjs');
          const r = await tts.generate({ model: p.model, text: String(args.text || ''), voiceName: p.voice, project: loc.project, location: loc.mediaLoc });
          const meta = { kind: 'audio', prompt: args.text, model: p.model, voice: p.voice };
          const file = adapter.save(id, r.bytes, 'wav', meta, args.outputPath);
          adapter.emit({ type: 'gen_media', id, kind: 'audio', prompt: args.text });
          return { content: [{ type: 'text', text: adapter.resultText('audio', { ...p, prompt: args.text, file, id }) }] };
        } catch (e) {
          adapter.emit({ type: 'gen_media_error', id, kind: 'audio', message: String(e?.message ?? e) });
          return { isError: true, content: [{ type: 'text', text: adapter.errorText('audio', e) }] };
        }
      },
    },
    {
      name: 'generate_music',
      description: desc.generate_music,
      schema: schemaOf('generate_music'),
      handler: async (args) => {
        const id = adapter.newId();
        const p = normMusic(args);
        adapter.emit({ type: 'gen_media_start', id, kind: 'music' });
        try {
          const music = await import('../music.mjs');
          const r = await music.generate({ model: p.model, prompt: String(args.prompt || ''), project: loc.project, location: loc.mediaLoc, apiKey: loc.apiKey });
          const ext = /mpeg|mp3/.test(r.mime || '') ? 'mp3' : 'wav';
          const meta = { kind: 'music', prompt: args.prompt, model: p.model };
          const file = adapter.save(id, r.bytes, ext, meta, args.outputPath);
          adapter.emit({ type: 'gen_media', id, kind: 'music', prompt: args.prompt });
          return { content: [{ type: 'text', text: adapter.resultText('music', { ...p, prompt: args.prompt, file, id }) }] };
        } catch (e) {
          adapter.emit({ type: 'gen_media_error', id, kind: 'music', message: String(e?.message ?? e) });
          return { isError: true, content: [{ type: 'text', text: adapter.errorText('music', e) }] };
        }
      },
    },
  ];
}
