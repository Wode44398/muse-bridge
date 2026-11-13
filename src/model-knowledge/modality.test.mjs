// 型号种类判定的自检：各家目录里的真实型号名（带 / 不带「厂商/」前缀）只看名字的判法，元数据与目录出处的优先级，
// 以及 .d.mts 声明与运行时一致。新增规则先在这里加一行真实型号名再改 modality.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODALITIES, classifyModality } from './modality.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// [型号 ID, 只看名字时应判的种类]，按出处分组
const CASES = {
  OpenRouter: [
    ['openai/gpt-5', 'text'], ['openai/gpt-4o', 'text'], ['openai/gpt-4o-mini', 'text'], ['openai/o3', 'text'],
    ['openai/o4-mini', 'text'], ['openai/gpt-oss-120b', 'text'], ['openai/gpt-4.1', 'text'], ['openai/codex-mini', 'text'],
    ['anthropic/claude-opus-4.1', 'text'], ['anthropic/claude-sonnet-4.5', 'text'], ['anthropic/claude-3.7-sonnet:thinking', 'text'],
    ['~anthropic/claude-sonnet-latest', 'text'], ['google/gemini-2.5-pro', 'text'], ['google/gemma-3-27b-it', 'text'],
    ['deepseek/deepseek-r1:free', 'text'], ['deepseek/deepseek-r1-distill-qwen-32b', 'text'], ['qwen/qwen3-235b-a22b', 'text'],
    ['qwen/qwen-vl-max', 'text'], ['qwen/qwen2.5-vl-72b-instruct', 'text'], ['qwen/qwen3-omni-30b-a3b-instruct', 'text'],
    ['z-ai/glm-4.6', 'text'], ['z-ai/glm-4.5v', 'text'], ['z-ai/glm-4.6v', 'text'], ['moonshotai/kimi-k2-thinking', 'text'],
    ['x-ai/grok-4', 'text'], ['x-ai/grok-code-fast-1', 'text'], ['mistralai/voxtral-small-24b-2507', 'text'],
    ['mistralai/pixtral-large-2411', 'text'], ['meta-llama/llama-4-maverick', 'text'], ['nvidia/llama-3.1-nemotron-70b-instruct', 'text'],
    ['minimax/minimax-m2', 'text'], ['bytedance/ui-tars-1.5-7b', 'text'], ['tencent/hunyuan-a13b-instruct', 'text'],
    ['xiaomi/mimo-v2-flash', 'text'], ['baidu/ernie-4.5-300b-a47b', 'text'], ['inclusionai/ling-1t', 'text'],
    ['thinkingmachines/inkling', 'text'], ['thinkingmachines/inkling-2-small:free', 'text'], ['perplexity/sonar-deep-research', 'text'],
    ['cohere/command-a', 'text'], ['amazon/nova-pro-v1', 'text'], ['microsoft/phi-4', 'text'], ['openrouter/auto', 'text'],
    ['meta-llama/llama-guard-4-12b', 'other'], ['openai/gpt-oss-safeguard-20b', 'other'], ['nvidia/nemotron-3.5-content-safety', 'other'],
    ['openai/gpt-4o-audio-preview', 'other'], ['openai/gpt-audio', 'other'], ['openai/gpt-audio-mini', 'other'],
    ['openai/gpt-5-image', 'image'], ['openai/gpt-5-image-mini', 'image'], ['openai/gpt-image-1', 'image'],
    ['google/gemini-2.5-flash-image', 'image'], ['google/gemini-3-pro-image-preview', 'image'], ['google/gemini-nano-banana-2.1', 'image'],
    ['x-ai/grok-imagine-image', 'image'], ['x-ai/grok-imagine-image-2.0', 'image'], ['black-forest-labs/flux.2-pro', 'image'],
    ['black-forest-labs/flux-3-image-klein', 'image'], ['recraft/recraft-v4.1-pro-vector', 'image'], ['bytedance-seed/seedream-4.5', 'image'],
    ['sourceful/riverflow-v2-pro', 'image'], ['krea/krea-2-large', 'image'], ['microsoft/mai-image-2.5', 'image'], ['tencent/hy-image-v3.5-preview', 'image'],
    ['qwen/qwen-image-3-pro', 'image'], ['meta/muse-image', 'image'],
    ['google/gemini-omni-1.1-flash', 'video'], ['google/gemini-omni-1.2-flash', 'video'], ['google/veo-3.1-fast', 'video'],
    ['x-ai/grok-imagine-video', 'video'], ['x-ai/grok-imagine-video-1.5-lite', 'video'], ['black-forest-labs/flux-3-video', 'video'],
    ['black-forest-labs/flux-video-upscale', 'video'], ['minimax/hailuo-3-max', 'video'], ['alibaba/wan-3.0-prime', 'video'],
    ['alibaba/wan-2.7', 'video'], ['alibaba/happyhorse-1.1', 'video'], ['bytedance/seedance-2.0-fast', 'video'],
    ['bytedance/seedance-1-5-pro', 'video'], ['kwaivgi/kling-v3.0-pro', 'video'], ['kwaivgi/kling-video-o1', 'video'],
    ['runway/gen-4.5', 'video'], ['runway/aleph-2', 'video'], ['heygen/avatar-iv', 'video'], ['heygen/heygen-video-1', 'video'],
    ['google/lyria-3-pro-preview', 'music'], ['google/lyria-3-clip-preview', 'music'],
  ],
  OpenAI: [
    ['gpt-5', 'text'], ['gpt-5-mini', 'text'], ['gpt-5-nano', 'text'], ['gpt-4.1-mini', 'text'], ['chatgpt-4o-latest', 'text'],
    ['o3-pro', 'text'], ['o4-mini-deep-research', 'text'], ['gpt-5-codex', 'text'], ['babbage-002', 'text'], ['davinci-002', 'text'],
    ['gpt-image-1', 'image'], ['gpt-image-1-mini', 'image'], ['dall-e-3', 'image'], ['dall-e-2', 'image'],
    ['sora-2', 'video'], ['sora-2-pro', 'video'],
    ['tts-1', 'voice'], ['tts-1-hd', 'voice'], ['gpt-4o-mini-tts', 'voice'],
    ['whisper-1', 'other'], ['gpt-4o-transcribe', 'other'], ['gpt-4o-mini-transcribe', 'other'],
    ['gpt-4o-audio-preview', 'other'], ['gpt-4o-mini-audio-preview', 'other'], ['gpt-realtime', 'other'],
    ['gpt-4o-realtime-preview', 'other'], ['gpt-4o-mini-realtime-preview', 'other'], ['text-embedding-3-small', 'other'],
    ['text-embedding-3-large', 'other'], ['text-embedding-ada-002', 'other'], ['omni-moderation-latest', 'other'],
    ['text-moderation-latest', 'other'], ['computer-use-preview', 'other'],
  ],
  'Gemini API': [
    ['models/gemini-2.5-pro', 'text'], ['models/gemini-2.5-flash', 'text'], ['models/gemini-2.5-flash-lite', 'text'],
    ['models/gemini-2.0-flash', 'text'], ['models/gemini-flash-latest', 'text'], ['models/gemma-3n-e4b-it', 'text'],
    ['models/gemini-2.5-flash-image', 'image'], ['models/gemini-2.5-flash-image-preview', 'image'], ['models/gemini-3-pro-image-preview', 'image'],
    ['models/imagen-4.0-generate-001', 'image'], ['models/imagen-4.0-ultra-generate-001', 'image'], ['models/imagen-3.0-generate-002', 'image'],
    ['imagen-4', 'image'], ['models/veo-3.0-generate-001', 'video'], ['models/veo-3.1-generate-preview', 'video'], ['models/veo-2.0-generate-001', 'video'],
    ['models/gemini-2.5-flash-preview-tts', 'voice'], ['models/gemini-2.5-pro-preview-tts', 'voice'],
    ['models/gemini-2.5-flash-native-audio-preview-09-2025', 'other'], ['models/gemini-live-2.5-flash-preview', 'other'],
    ['models/gemini-2.0-flash-live-001', 'other'], ['models/gemini-embedding-001', 'other'], ['models/text-embedding-004', 'other'],
    ['models/embedding-001', 'other'], ['models/aqa', 'other'], ['models/lyria-realtime-exp', 'other'],
    ['models/gemini-2.5-computer-use-preview-10-2025', 'other'], ['models/gemini-robotics-er-1.5-preview', 'other'],
    ['publishers/google/models/gemini-2.5-pro', 'text'], ['publishers/google/models/imagen-4.0-generate-001', 'image'],
  ],
  硅基流动: [
    ['deepseek-ai/DeepSeek-V3.2-Exp', 'text'], ['Pro/deepseek-ai/DeepSeek-V3', 'text'], ['Qwen/Qwen3-235B-A22B-Instruct-2507', 'text'],
    ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'text'], ['Qwen/Qwen2.5-VL-72B-Instruct', 'text'], ['Qwen/Qwen3-VL-235B-A22B-Instruct', 'text'],
    ['Qwen/Qwen3-Omni-30B-A3B-Instruct', 'text'], ['zai-org/GLM-4.6', 'text'], ['zai-org/GLM-4.5V', 'text'], ['THUDM/GLM-4.1V-9B-Thinking', 'text'],
    ['moonshotai/Kimi-K2-Instruct-0905', 'text'], ['MiniMaxAI/MiniMax-M1-80k', 'text'], ['ByteDance-Seed/Seed-OSS-36B-Instruct', 'text'],
    ['stepfun-ai/step3', 'text'], ['inclusionAI/Ling-flash-2.0', 'text'],
    ['Kwai-Kolors/Kolors', 'image'], ['Qwen/Qwen-Image', 'image'], ['Qwen/Qwen-Image-Edit-2509', 'image'],
    ['black-forest-labs/FLUX.1-schnell', 'image'], ['black-forest-labs/FLUX.1-Kontext-dev', 'image'],
    ['stabilityai/stable-diffusion-3-5-large', 'image'], ['stabilityai/stable-diffusion-xl-base-1.0', 'image'],
    ['Wan-AI/Wan2.2-T2V-A14B', 'video'], ['Wan-AI/Wan2.2-I2V-A14B', 'video'], ['Wan-AI/Wan2.1-T2V-14B-Turbo', 'video'],
    ['FunAudioLLM/CosyVoice2-0.5B', 'voice'], ['fnlp/MOSS-TTSD-v0.5', 'voice'], ['IndexTeam/IndexTTS-2', 'voice'], ['fishaudio/fish-speech-1.5', 'voice'],
    ['FunAudioLLM/SenseVoiceSmall', 'other'], ['TeleAI/TeleSpeechASR', 'other'], ['BAAI/bge-m3', 'other'], ['BAAI/bge-reranker-v2-m3', 'other'],
    ['Qwen/Qwen3-Embedding-8B', 'other'], ['Qwen/Qwen3-Reranker-8B', 'other'], ['netease-youdao/bce-embedding-base_v1', 'other'],
    ['netease-youdao/bce-reranker-base_v1', 'other'], ['deepseek-ai/DeepSeek-OCR', 'other'],
  ],
  阿里百炼: [
    ['qwen-max', 'text'], ['qwen-plus', 'text'], ['qwen-turbo', 'text'], ['qwen-flash', 'text'], ['qwen3-max', 'text'],
    ['qwen-vl-max', 'text'], ['qwen-vl-plus', 'text'], ['qwen3-vl-plus', 'text'], ['qwen-omni-turbo', 'text'], ['qwen3-omni-flash', 'text'],
    ['qwen-long', 'text'], ['qwq-plus', 'text'], ['qvq-max', 'text'], ['qwen-mt-turbo', 'text'], ['qwen3-coder-plus', 'text'],
    ['qwen2.5-72b-instruct', 'text'], ['qwen2.5-vl-7b-instruct', 'text'],
    ['wanx2.1-t2i-turbo', 'image'], ['wanx2.1-t2i-plus', 'image'], ['wan2.2-t2i-flash', 'image'], ['wan2.5-t2i-preview', 'image'],
    ['wanx2.1-imageedit', 'image'], ['wanx-v1', 'image'], ['qwen-image', 'image'], ['qwen-image-plus', 'image'], ['qwen-image-edit', 'image'],
    ['flux-schnell', 'image'], ['flux-dev', 'image'],
    ['wanx2.1-t2v-turbo', 'video'], ['wanx2.1-t2v-plus', 'video'], ['wan2.2-t2v-plus', 'video'], ['wan2.5-t2v-preview', 'video'],
    ['wanx2.1-i2v-turbo', 'video'], ['wan2.2-i2v-flash', 'video'], ['wanx2.1-kf2v-plus', 'video'], ['wan2.2-s2v', 'video'],
    ['wanx2.1-vace-plus', 'video'], ['wan2.2-animate-move', 'video'],
    ['cosyvoice-v2', 'voice'], ['cosyvoice-v3-plus', 'voice'], ['sambert-zhichu-v1', 'voice'], ['qwen-tts', 'voice'], ['qwen3-tts-flash', 'voice'],
    ['paraformer-v2', 'other'], ['paraformer-realtime-v2', 'other'], ['sensevoice-v1', 'other'], ['fun-asr', 'other'],
    ['qwen3-asr-flash', 'other'], ['qwen-audio-asr', 'other'], ['gummy-realtime-v1', 'other'], ['text-embedding-v4', 'other'],
    ['multimodal-embedding-v1', 'other'], ['gte-rerank-v2', 'other'], ['qwen-vl-ocr', 'other'], ['qwen3-livetranslate-flash-realtime', 'other'],
    ['qwen-omni-turbo-realtime', 'other'],
  ],
  火山方舟: [
    ['doubao-seed-1-6-250615', 'text'], ['doubao-seed-1-6-thinking-250715', 'text'], ['doubao-seed-1-6-flash-250828', 'text'],
    ['doubao-seed-1-6-vision-250815', 'text'], ['doubao-1-5-pro-32k-250115', 'text'], ['doubao-1-5-vision-pro-32k-250115', 'text'],
    ['deepseek-v3-1-terminus', 'text'], ['kimi-k2-250905', 'text'],
    ['doubao-seedream-4-0-250828', 'image'], ['doubao-seedream-3-0-t2i-250415', 'image'], ['doubao-seededit-3-0-i2i-250628', 'image'],
    ['doubao-seedance-1-0-pro-250528', 'video'], ['doubao-seedance-1-0-lite-t2v-250428', 'video'], ['doubao-seedance-1-0-lite-i2v-250428', 'video'],
    ['doubao-seaweed-241128', 'video'],
    ['doubao-embedding-large-text-250515', 'other'], ['doubao-embedding-vision-250615', 'other'],
  ],
  MiniMax: [
    ['MiniMax-M2', 'text'], ['MiniMax-M1', 'text'], ['MiniMax-Text-01', 'text'], ['MiniMax-VL-01', 'text'], ['abab6.5s-chat', 'text'],
    ['speech-02-hd', 'voice'], ['speech-02-turbo', 'voice'], ['speech-2.5-hd-preview', 'voice'], ['speech-2.6-hd', 'voice'],
    ['MiniMax-Hailuo-02', 'video'], ['MiniMax-Hailuo-2.3', 'video'], ['T2V-01', 'video'], ['I2V-01-Director', 'video'], ['S2V-01', 'video'], ['video-01', 'video'],
    ['image-01', 'image'], ['image-01-live', 'image'], ['music-1.5', 'music'], ['music-2.0', 'music'],
  ],
  'xAI / Mistral': [
    ['grok-4-fast-reasoning', 'text'], ['grok-3-mini', 'text'], ['grok-2-image-1212', 'image'], ['grok-imagine-image', 'image'], ['grok-imagine-video', 'video'],
    ['mistral-large-latest', 'text'], ['magistral-medium-latest', 'text'], ['codestral-2508', 'text'], ['devstral-medium-2507', 'text'],
    ['ministral-8b-latest', 'text'], ['voxtral-small-latest', 'text'], ['mistral-embed', 'other'], ['codestral-embed', 'other'],
    ['mistral-moderation-latest', 'other'], ['mistral-ocr-latest', 'other'], ['voxtral-mini-transcribe-2507', 'other'],
  ],
  fal: [
    ['fal-ai/flux/dev', 'image'], ['fal-ai/flux-pro/kontext', 'image'], ['fal-ai/flux-pro/v1.1-ultra', 'image'], ['fal-ai/recraft/v3/text-to-image', 'image'],
    ['fal-ai/ideogram/v3', 'image'], ['fal-ai/imagen4/preview', 'image'], ['fal-ai/nano-banana', 'image'], ['fal-ai/nano-banana/edit', 'image'],
    ['fal-ai/bytedance/seedream/v4/text-to-image', 'image'], ['fal-ai/qwen-image', 'image'], ['fal-ai/hidream-i1-full', 'image'],
    ['fal-ai/stable-diffusion-v35-large', 'image'], ['fal-ai/gpt-image-1/text-to-image', 'image'], ['fal-ai/clarity-upscaler', 'image'], ['fal-ai/birefnet', 'image'],
    ['fal-ai/kling-video/v2.1/master/text-to-video', 'video'], ['fal-ai/kling-video/v2.5-turbo/pro/image-to-video', 'video'], ['fal-ai/veo3', 'video'],
    ['fal-ai/veo3/fast', 'video'], ['fal-ai/minimax/hailuo-02/standard/text-to-video', 'video'], ['fal-ai/bytedance/seedance/v1/pro/text-to-video', 'video'],
    ['fal-ai/wan/v2.2-a14b/text-to-video', 'video'], ['fal-ai/luma-dream-machine/ray-2', 'video'], ['fal-ai/pixverse/v5/text-to-video', 'video'],
    ['fal-ai/ltxv-13b-098-distill', 'video'], ['fal-ai/hunyuan-video', 'video'], ['fal-ai/vidu/q1/text-to-video', 'video'], ['fal-ai/sora-2/text-to-video', 'video'],
    ['fal-ai/sync-lipsync', 'video'], ['flux-video', 'video'],
    ['fal-ai/minimax/speech-02-hd', 'voice'], ['fal-ai/elevenlabs/tts/multilingual-v2', 'voice'], ['fal-ai/chatterbox/text-to-speech', 'voice'],
    ['fal-ai/kokoro/american-english', 'voice'], ['fal-ai/dia-tts', 'voice'],
    ['fal-ai/lyria2', 'music'], ['fal-ai/stable-audio', 'music'], ['fal-ai/minimax-music', 'music'], ['fal-ai/ace-step', 'music'], ['fal-ai/diffrhythm', 'music'],
    ['fal-ai/whisper', 'other'], ['fal-ai/elevenlabs/speech-to-text', 'other'], ['fal-ai/hunyuan3d/v2', 'other'], ['fal-ai/trellis', 'other'], ['fal-ai/mmaudio-v2', 'other'],
  ],
  Replicate: [
    ['black-forest-labs/flux-schnell', 'image'], ['black-forest-labs/flux-1.1-pro', 'image'], ['stability-ai/sdxl', 'image'],
    ['stability-ai/stable-diffusion-3.5-large', 'image'], ['ideogram-ai/ideogram-v3-turbo', 'image'], ['recraft-ai/recraft-v3', 'image'],
    ['google/imagen-4', 'image'], ['bytedance/seedream-4', 'image'], ['luma/photon', 'image'], ['minimax/image-01', 'image'], ['nightmareai/real-esrgan', 'image'],
    ['kwaivgi/kling-v2.1', 'video'], ['google/veo-3', 'video'], ['minimax/hailuo-02', 'video'], ['minimax/video-01', 'video'],
    ['wan-video/wan-2.2-t2v-fast', 'video'], ['luma/ray', 'video'], ['bytedance/seedance-1-pro', 'video'], ['pixverse/pixverse-v5', 'video'],
    ['lightricks/ltx-video', 'video'], ['tencent/hunyuan-video', 'video'], ['openai/sora-2', 'video'],
    ['minimax/speech-02-hd', 'voice'], ['resemble-ai/chatterbox', 'voice'], ['jaaari/kokoro-82m', 'voice'], ['lucataco/xtts-v2', 'voice'],
    ['meta/musicgen', 'music'], ['minimax/music-01', 'music'], ['google/lyria-2', 'music'],
    ['openai/whisper', 'other'], ['vaibhavs10/incredibly-fast-whisper', 'other'],
  ],
  其他写法: [
    ['accounts/fireworks/models/llama-v3p1-70b-instruct', 'text'], ['accounts/fireworks/models/flux-1-dev-fp8', 'image'],
    ['@cf/meta/llama-3.1-8b-instruct', 'text'], ['@cf/baai/bge-m3', 'other'], ['@cf/black-forest-labs/flux-1-schnell', 'image'],
    ['@cf/openai/whisper-large-v3-turbo', 'other'], ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'text'],
    ['amazon.nova-canvas-v1:0', 'image'], ['amazon.nova-reel-v1:1', 'video'], ['amazon.nova-sonic-v1:0', 'other'],
    ['amazon.titan-embed-text-v2:0', 'other'], ['claude-sonnet-4-5[1m]', 'text'], ['nomic-embed-text', 'other'], ['llama3.2:3b', 'text'],
    ['jina-embeddings-v3', 'other'], ['voyage-3-large', 'other'], ['rerank-v3.5', 'other'], ['shieldgemma-2b', 'other'],
    ['granite-guardian-3.2-5b', 'other'], ['cogview-4', 'image'], ['cogvideox-3', 'video'], ['glm-4-voice', 'text'],
    ['eleven_multilingual_v2', 'voice'], ['scribe_v1', 'other'], ['suno-v4.5', 'music'], ['kling-v2-1', 'video'], ['vidu-q1', 'video'],
    ['gen4_turbo', 'video'], ['gen3a_turbo', 'video'], ['ray-2', 'video'], ['pika-2.2', 'video'], ['codegen2-7b', 'text'],
    ['gpt-sovits-v2', 'voice'], ['sonic-2', 'voice'], ['luminous-supreme', 'text'], ['aleph-alpha/pharia-1-llm-7b', 'text'],
  ],
};

test('真实型号名只看名字的判定（≥200 条，覆盖 OpenRouter / OpenAI / Gemini / 硅基流动 / 百炼 / 方舟 / fal / Replicate）', () => {
  const all = Object.values(CASES).flat();
  assert.ok(all.length >= 200, `样本只有 ${all.length} 条`);
  const wrong = [];
  for (const [src, rows] of Object.entries(CASES)) {
    for (const [id, want] of rows) {
      const got = classifyModality(id);
      if (got !== want) wrong.push(`${src} ${id}: 应为 ${want}，实际 ${got}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('同一型号带不带「厂商/」前缀判得一样', () => {
  for (const id of ['openai/gpt-5-image', 'google/gemini-omni-1.1-flash', 'bytedance-seed/seedream-4.5', 'minimax/speech-02-hd',
    'qwen/qwen3-omni-30b-a3b-instruct', 'z-ai/glm-4.6v', 'x-ai/grok-imagine-image', 'meta-llama/llama-guard-4-12b', 'kwaivgi/kling-v3.0-pro']) {
    assert.equal(classifyModality(id.split('/').pop()), classifyModality(id), id);
  }
});

test('元数据优先于名字：OpenRouter / fal / Together / Gemini / Mistral / Ollama / ElevenLabs / Studio 的条目', () => {
  const c = (id, raw) => classifyModality(id, { raw });
  // OpenRouter output_modalities；路由条目的输出是并集，不当出图
  assert.equal(c('tbc/mischief-1', { architecture: { output_modalities: ['video'] } }), 'video');
  assert.equal(c('google/gemini-2.5-flash-image', { architecture: { output_modalities: ['image', 'text'] } }), 'image');
  assert.equal(c('openrouter/auto', { architecture: { output_modalities: ['text', 'image'] } }), 'text');
  assert.equal(c('foo/bar', { architecture: { modality: 'text+image->text' } }), 'text');
  assert.equal(c('google/lyria-3-pro-preview', { architecture: { output_modalities: ['audio', 'text'] } }), 'music');
  assert.equal(c('openai/gpt-audio', { architecture: { output_modalities: ['text', 'audio'] } }), 'other');
  assert.equal(c('foo/omni-chat', { architecture: { output_modalities: ['text', 'audio'] } }), 'text');
  // 审核 / 安全分类器：元数据说出文本，名字里的排除字样仍说了算
  assert.equal(c('meta-llama/llama-guard-4-12b', { architecture: { output_modalities: ['text'] } }), 'other');
  assert.equal(c('foo/text-embedder', { output_modalities: ['embeddings'] }), 'other');
  // fal category
  assert.equal(c('fal-ai/some-new-model', { category: 'text-to-video' }), 'video');
  assert.equal(c('fal-ai/some-new-model', { category: 'image-to-image' }), 'image');
  assert.equal(c('fal-ai/some-new-model', { category: 'text-to-speech' }), 'voice');
  assert.equal(c('fal-ai/some-new-model', { category: 'speech-to-speech' }), 'other');
  assert.equal(c('fal-ai/some-new-model', { category: 'speech-to-text' }), 'other');
  assert.equal(c('fal-ai/some-new-model', { category: 'image-to-3d' }), 'other');
  assert.equal(c('fal-ai/some-new-model', { category: 'video-to-audio' }), 'other');
  assert.equal(c('fal-ai/stable-audio', { category: 'text-to-audio' }), 'music');
  assert.equal(c('fal-ai/some-new-model', { metadata: { category: 'text-to-video' } }), 'video');
  // Together type / 硅基流动 sub_type / HF pipeline_tag / 方舟 domain
  assert.equal(c('cartesia/sonic-2', { type: 'audio' }), 'voice');
  assert.equal(c('BAAI/bge-large-en-v1.5', { type: 'embedding' }), 'other');
  assert.equal(c('Salesforce/Llama-Rank-V1', { type: 'rerank' }), 'other');
  assert.equal(c('some/llm', { type: 'chat' }), 'text');
  assert.equal(c('some/model', { sub_type: 'text-to-image' }), 'image');
  assert.equal(c('some/model', { pipeline_tag: 'automatic-speech-recognition' }), 'other');
  assert.equal(c('some/model', { pipeline_tag: 'image-text-to-text' }), 'text');
  assert.equal(c('some/model', { domain: 'VideoGeneration' }), 'video');
  assert.equal(c('claude-x', { type: 'model' }), 'text');            // Anthropic 的 type: model 不是种类
  // Gemini supportedGenerationMethods
  assert.equal(c('models/veo-3.0-generate-001', { supportedGenerationMethods: ['predictLongRunning'] }), 'video');
  assert.equal(c('models/gemini-embedding-001', { supportedGenerationMethods: ['embedContent', 'countTextTokens'] }), 'other');
  assert.equal(c('models/gemini-2.5-flash', { supportedGenerationMethods: ['generateContent', 'countTokens'] }), 'text');
  assert.equal(c('models/imagen-4.0-generate-001', { supportedGenerationMethods: ['predict'] }), 'image');
  // Mistral capabilities
  assert.equal(c('mistral-embed', { capabilities: { completion_chat: false } }), 'other');
  assert.equal(c('mistral-somenew', { capabilities: { completion_chat: false } }), 'other');
  assert.equal(c('codestral-latest', { capabilities: { completion_chat: true, completion_fim: true } }), 'text');
  // Ollama /api/show capabilities
  assert.equal(c('some-embedder', { capabilities: ['embedding'] }), 'other');
  assert.equal(c('llava:13b', { capabilities: ['completion', 'vision'] }), 'text');
  // ElevenLabs
  assert.equal(c('eleven_flash_v2_5', { can_do_text_to_speech: true }), 'voice');
  assert.equal(c('eleven_english_sts_v2', { can_do_text_to_speech: false, can_do_voice_conversion: true }), 'other');
  // Studio 自己的条目：speech = 配音
  assert.equal(c('whatever', { kind: 'speech' }), 'voice');
  assert.equal(c('whatever', { kind: 'music' }), 'music');
  // 元数据认不出时回到名字
  assert.equal(c('fal-ai/kling-video/v2.1/pro/image-to-video', { foo: 1 }), 'video');
});

test('目录出处 hint 最高优先；音频一类允许名字细分；mediaOnly 让认不出的媒体型号算 other', () => {
  assert.equal(classifyModality('gpt-4o', { hint: 'video' }), 'video');
  assert.equal(classifyModality('some-new-model', { hint: 'image' }), 'image');
  assert.equal(classifyModality('flux-dev', { hint: 'text' }), 'text');
  assert.equal(classifyModality('anything', { hint: 'other' }), 'other');
  assert.equal(classifyModality('some-tts-thing', { hint: 'speech' }), 'voice');
  assert.equal(classifyModality('some-new-voice', { hint: 'voice' }), 'voice');
  assert.equal(classifyModality('FunAudioLLM/SenseVoiceSmall', { hint: 'voice' }), 'other');   // 硅基流动 type=audio 里混着识别
  assert.equal(classifyModality('fal-ai/stable-audio', { hint: 'voice' }), 'music');
  assert.equal(classifyModality('google/lyria-3-pro-preview', { hint: 'audio' }), 'music');
  assert.equal(classifyModality('openai/gpt-audio-mini', { hint: 'audio' }), 'other');
  assert.equal(classifyModality('someone/new-model', { hint: 'audio' }), 'voice');
  assert.equal(classifyModality('someone/new-model', { hint: 'audio', raw: { architecture: { output_modalities: ['text', 'audio'] } } }), 'text');
  assert.equal(classifyModality('someone/new-model', { hint: 'music' }), 'music');
  assert.equal(classifyModality('gpt-4o', { hint: '不认识的出处' }), 'text');
  assert.equal(classifyModality('IMAGE-01', { hint: ' IMAGE ' }), 'image');
  assert.equal(classifyModality('fal-ai/wizper', { mediaOnly: true }), 'other');
  assert.equal(classifyModality('fal-ai/wizper'), 'text');
  assert.equal(classifyModality('fal-ai/flux/dev', { mediaOnly: true }), 'image');
  assert.equal(classifyModality('fal-ai/new-thing', { mediaOnly: true, raw: { category: 'text-to-video' } }), 'video');
});

test('边界输入不抛错', () => {
  assert.equal(classifyModality(''), 'other');
  assert.equal(classifyModality('   '), 'other');
  assert.equal(classifyModality(null), 'other');
  assert.equal(classifyModality(undefined, null), 'other');
  assert.equal(classifyModality('gpt-4o', 'not-an-object'), 'text');
  assert.equal(classifyModality('gpt-4o', { raw: ['array'] }), 'text');
  assert.equal(classifyModality('gpt-4o', { raw: { architecture: { output_modalities: [] } } }), 'text');
  assert.equal(classifyModality('gpt-4o', { raw: { architecture: { output_modalities: [null, 7] } } }), 'text');
  assert.equal(classifyModality('gpt-4o', { raw: { category: 42, type: ['', null] } }), 'text');
  assert.equal(classifyModality('GPT-IMAGE-1'), 'image');
  assert.deepEqual([...MODALITIES], ['text', 'image', 'video', 'voice', 'music']);
  assert.ok(Object.isFrozen(MODALITIES));
});

function declared(file) {
  const src = readFileSync(path.join(HERE, file), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return names;
}

test('modality.d.mts 声明的导出与运行时一致', async () => {
  const mod = await import('./modality.mjs');
  assert.deepEqual([...declared('modality.d.mts')].sort(), Object.keys(mod).sort());
});
