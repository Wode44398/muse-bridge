// Music generation via Lyria. Two paths, routed by model id:
//  - lyria-002        -> Vertex AI `:predict` REST (ADC token). Returns complete
//    WAVs (48kHz stereo, ~30s) in `predictions[]` (bytesBase64Encoded — what we've
//    always seen — or audioContent, which is what the current API reference shows; read both).
//    instances[].seed and parameters.sample_count (1–4) are mutually exclusive.
//  - lyria-3-*        -> Gemini Developer API generateContent (API key). Vertex
//    won't serve lyria-3 to this project (404 = not allowlisted), but the
//    Developer API does (needs billing enabled on the key's project). Returns
//    inline audio (MP3 by default; lyria-3.5 can do WAV via generationConfig.responseFormat)
//    plus text parts (lyrics / song structure). lyria-3.5 (GA 2026-09-04) also takes up to 10 images.
import { geminiGenAI, vertexAccessToken, vertexRestUrl } from '@bridge/core/runtime/google-clients.mjs';

const isLyria3 = (model) => /^lyria-3/.test(model);

/** lyria-3 的 generateContent 参数（单测直接测它，不联网）。 */
export function buildLyria3Request({ model, prompt, images = [], outputFormat }) {
  // 图在前、文字在后（文档示例是文字在前，两种顺序都是合法的多模态输入）
  const parts = [...images.filter((x) => x && x.data).map((x) => ({ inlineData: { data: x.data, mimeType: x.mimeType || 'image/jpeg' } })), { text: String(prompt || '') }];
  const req = { model, contents: [{ role: 'user', parts }] };
  // WAV：generationConfig.responseFormat.audio.mimeType = AUDIO_WAV（文档只写了 3.5）。SDK 2.6 的 GenerateContentConfig 没有 responseFormat，
  // 塞进 httpOptions.extraBody 深合并进请求体；文档示例同时带 responseModalities ["AUDIO","TEXT"]。待真打。
  if (outputFormat === 'wav') {
    req.config = { responseModalities: ['AUDIO', 'TEXT'], httpOptions: { extraBody: { generationConfig: { responseFormat: { audio: { mimeType: 'AUDIO_WAV' } } } } } };
  }
  return req;
}

// lyria-3 via Gemini Developer API (API key).
let devClient = null, devKey = null;
async function generateLyria3({ model, prompt, images, outputFormat, apiKey }) {
  if (!apiKey) throw new Error('lyria-3 要用 Gemini API 服务（填好 API Key），且该 key 的项目要开通付费');
  if (!devClient || devKey !== apiKey) { devClient = geminiGenAI(apiKey); devKey = apiKey; }
  // lyria-3 preview is flaky: it sometimes returns only a text part (e.g.
  // "<instrumental>") and no audio. Retry a couple times before giving up.
  let lastText = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await devClient.models.generateContent(buildLyria3Request({ model, prompt, images, outputFormat }));
    const parts = res.candidates?.[0]?.content?.parts || [];
    const audio = parts.find((p) => p.inlineData && p.inlineData.data && /^audio\//.test(p.inlineData.mimeType || ''));
    // 文字段 = 歌词 / 歌曲结构说明（不保证在第一段）；思考段不算
    const texts = parts.filter((p) => typeof p.text === 'string' && p.text.trim() && !p.thought).map((p) => p.text.trim());
    if (audio) return { clips: [{ bytes: Buffer.from(audio.inlineData.data, 'base64'), mime: audio.inlineData.mimeType }], lyrics: texts.join('\n\n').slice(0, 20000) };
    if (texts.length) lastText = texts[texts.length - 1];
  }
  throw new Error('lyria-3 多次未返回音频' + (lastText ? '（模型只回了文本「' + lastText.slice(0, 40) + '」）' : '') + '，多为偶发，请再试一次或换个描述');
}

/** lyria-002 的 :predict 请求体（单测直接测它）：给了种子就不发 sample_count（上游互斥），否则 sample_count = 条数（默认 1）。 */
export function buildLyria2Body({ prompt, negativePrompt, seed, count }) {
  const instance = { prompt: String(prompt || '') };
  if (negativePrompt) instance.negative_prompt = String(negativePrompt);
  if (typeof seed === 'number') instance.seed = seed;
  return { instances: [instance], parameters: typeof seed === 'number' ? {} : { sample_count: Math.min(4, Math.max(1, Number(count) || 1)) } };
}

/** :predict 回的每条（bytesBase64Encoded 或 audioContent，两种都认）。 */
export function lyria2Clips(j) {
  return (Array.isArray(j?.predictions) ? j.predictions : [])
    .map((p) => ({ b64: p && (p.bytesBase64Encoded || p.audioContent), mime: (p && p.mimeType) || 'audio/wav' }))
    .filter((p) => p.b64)
    .map((p) => ({ bytes: Buffer.from(p.b64, 'base64'), mime: p.mime }));
}

/**
 * Generate music. Returns playable audio clips (WAV or MP3) and, for lyria-3, the lyrics text.
 * @returns {Promise<{ clips: Array<{ bytes: Buffer, mime: string }>, lyrics?: string }>}
 */
export async function generate({ model = 'lyria-002', prompt, negativePrompt, seed, count, outputFormat, images, project, location, apiKey, credentials, signal }) {
  if (isLyria3(model)) return generateLyria3({ model, prompt, images, outputFormat, apiKey });
  const tok = await vertexAccessToken(credentials);
  if (!tok) throw new Error('拿不到 Vertex 访问令牌（ADC 未配置？）');
  const url = vertexRestUrl(location, `v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`);
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildLyria2Body({ prompt, negativePrompt, seed, count })),
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Lyria ' + r.status + '：' + t.replace(/\s+/g, ' ').slice(0, 220));
  }
  const clips = lyria2Clips(await r.json());
  if (!clips.length) throw new Error('Lyria 未返回音频');
  return { clips };
}
