// Music generation via Lyria. Two paths, routed by model id:
//  - lyria-002        -> Vertex AI `:predict` REST (ADC token). Returns a
//    complete WAV (48kHz stereo, ~30s) in `predictions[0].bytesBase64Encoded`.
//  - lyria-3-*        -> Gemini Developer API generateContent (API key). Vertex
//    won't serve lyria-3 to this project (404 = not allowlisted), but the
//    Developer API does (needs billing enabled on the key's project). Returns
//    inline audio (MP3 by default; Pro can do WAV). lyria-3.5 (GA 2026-09-04)
//    takes this same path: Vertex 404s it too, dev API returns ~1 min mp3.
import { geminiGenAI, vertexAccessToken, vertexRestUrl } from './google-clients.mjs';

const isLyria3 = (model) => /^lyria-3/.test(model);

// lyria-3 via Gemini Developer API (API key).
let devClient = null, devKey = null;
async function generateLyria3({ model, prompt, apiKey }) {
  if (!apiKey) throw new Error('lyria-3 需要 Gemini API key（config.geminiApiKey），且该 key 的项目要开通付费');
  if (!devClient || devKey !== apiKey) { devClient = geminiGenAI(apiKey); devKey = apiKey; }
  // lyria-3 preview is flaky: it sometimes returns only a text part (e.g.
  // "<instrumental>") and no audio. Retry a couple times before giving up.
  let lastText = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await devClient.models.generateContent({
      model, contents: [{ role: 'user', parts: [{ text: String(prompt || '') }] }],
    });
    for (const part of (res.candidates?.[0]?.content?.parts || [])) {
      const d = part.inlineData;
      if (d && d.data && /^audio\//.test(d.mimeType || '')) {
        return { bytes: Buffer.from(d.data, 'base64'), mime: d.mimeType };
      }
      if (part.text) lastText = part.text;
    }
  }
  throw new Error('lyria-3 多次未返回音频' + (lastText ? '（模型只回了文本「' + lastText.slice(0, 40) + '」）' : '') + '，多为偶发，请再试一次或换个描述');
}


/**
 * Generate a music clip. Returns playable audio (WAV or MP3).
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function generate({ model = 'lyria-002', prompt, negativePrompt, project, location, apiKey }) {
  if (isLyria3(model)) return generateLyria3({ model, prompt, apiKey });
  const tok = await vertexAccessToken();
  if (!tok) throw new Error('拿不到 Vertex 访问令牌（ADC 未配置？）');
  const url = vertexRestUrl(location, `v1/projects/${project}/locations/${location}/publishers/google/models/${model}:predict`);
  const instance = { prompt: String(prompt || '') };
  if (negativePrompt) instance.negative_prompt = String(negativePrompt);
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [instance], parameters: { sample_count: 1 } }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Lyria ' + r.status + '：' + t.replace(/\s+/g, ' ').slice(0, 220));
  }
  const j = await r.json();
  const b64 = j && j.predictions && j.predictions[0] && j.predictions[0].bytesBase64Encoded;
  if (!b64) throw new Error('Lyria 未返回音频');
  return { bytes: Buffer.from(b64, 'base64'), mime: 'audio/wav' };
}
