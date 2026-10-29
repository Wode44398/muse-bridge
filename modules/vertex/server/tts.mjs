// Text-to-speech through Vertex AI (Gemini TTS). The model returns raw PCM
// (L16, 24kHz, mono) as base64 — browsers can't play that directly, so we wrap
// it in a WAV container. Works on both endpoints; uses the media location.
import { vertexGenAI, vertexClientKey } from './google-clients.mjs';

const clients = new Map();
function client(project, location) {
  const key = vertexClientKey(project, location);
  let ai = clients.get(key);
  if (!ai) { ai = vertexGenAI({ project, location }); clients.set(key, ai); }
  return ai;
}

// Wrap raw little-endian PCM in a minimal WAV (RIFF) container.
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);       // fmt chunk size
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Synthesize speech. Returns a playable WAV.
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function generate({ model, text, voiceName, style, speakers, project, location, signal }) {
  const ai = client(project, location);
  // 单人 = prebuiltVoiceConfig；多人对白 = multiSpeakerVoiceConfig（最多 2 人，
  // 2026-08-29 在 3.1-flash-tts / 2.5-pro-tts 上实测 200）。风格是自然语言前缀——
  // Gemini TTS 没有独立的语速/情绪参数，官方就是靠这句话控的。
  const speechConfig = (speakers && speakers.length >= 2)
    ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: speakers.map((sp) => ({ speaker: sp.speaker, voiceConfig: { prebuiltVoiceConfig: { voiceName: sp.voice } } })) } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || 'Kore' } } };
  const config = { responseModalities: ['AUDIO'], speechConfig };
  if (signal) config.abortSignal = signal;
  const body = (style ? String(style).trim() + '\n' : '') + String(text || '');
  const res = await ai.models.generateContent({
    model, contents: [{ role: 'user', parts: [{ text: body }] }], config,
  });
  for (const part of (res.candidates?.[0]?.content?.parts || [])) {
    const d = part.inlineData;
    if (d && d.data) {
      const pcm = Buffer.from(d.data, 'base64');
      const rate = parseInt((String(d.mimeType || '').match(/rate=(\d+)/) || [])[1], 10) || 24000;
      return { bytes: pcmToWav(pcm, rate, 1, 16), mime: 'audio/wav' };
    }
  }
  throw new Error('TTS 未返回音频（可能被安全策略拦截）');
}
