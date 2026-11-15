// Text-to-speech through Vertex AI (Gemini TTS). 2.5 / 3.1 return raw PCM
// (L16, 24kHz, mono) as base64 — browsers can't play that directly, so we wrap
// it in a WAV container. 3.8 returns a complete WAV (RIFF header) on unary calls:
// used as-is (wrapping it again = double header). Works on both endpoints; uses the media location.
import { vertexGenAI, vertexClientKey, geminiGenAI } from '@bridge/core/runtime/google-clients.mjs';

const clients = new Map();
function client(project, location, credentials) {
  const key = vertexClientKey(project, location, credentials);
  let ai = clients.get(key);
  if (!ai) { ai = vertexGenAI({ project, location, credentials }); clients.set(key, ai); }
  return ai;
}
// Gemini Developer API（gemini 方言，API key）：同一个 generateContent + AUDIO
const devClients = new Map();
function devClient(apiKey) {
  let ai = devClients.get(apiKey);
  if (!ai) { ai = geminiGenAI(apiKey); devClients.set(apiKey, ai); }
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

// 多人对白的正文拆成一个个 turn（3.8 要每个 turn 一个 part、各带 speechMetadata.speaker）：
// 行首「名字：」/「名字:」认作换人（名字须是配置里的两个之一）；认不出名字的行接在上一个 turn 后面，开头就认不出的归第一个说话人。
export function splitTurns(text, names) {
  const turns = [];
  const known = names.filter(Boolean);
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([^:：\n]{1,24})\s*[:：]\s*(.*)$/.exec(line);
    const who = m && known.find((n) => n === m[1].trim());
    if (who) { turns.push({ speaker: who, text: m[2] }); continue; }
    if (!line.trim()) continue;
    if (turns.length) turns[turns.length - 1].text += '\n' + line;
    else turns.push({ speaker: known[0], text: line });
  }
  return turns.filter((t) => t.text.trim());
}

/**
 * 拼请求（单测直接测它，不联网）。回 { contents, config }。
 * metaStyle（3.8 系列）：text 只当逐字稿，风格放 parts[].speechMetadata.style、多人对白每个 turn 带 speechMetadata.speaker
 * （aistudio.google.com/docs/speech-generation、Vertex TTS 总览页）。SDK 2.6 的 Part 转换只认固定字段，会把 speechMetadata 丢掉，
 * 所以 contents 原样塞进 httpOptions.extraBody（SDK 把它深合并进请求体，数组整体替换），两条通道（Vertex / Gemini API）走同一个写法。
 * 字段用 camelCase（speechMetadata）——Vertex 文档的 REST 示例这么写，Gemini API 示例写 speech_metadata，proto JSON 两种都该认；待真打。
 * 旧型号（2.5 / 3.1）照旧把风格拼在正文前面。
 */
export function buildRequest({ text, voiceName, style, speakers, languageCode, metaStyle = false, signal }) {
  // 单人 = prebuiltVoiceConfig；多人对白 = multiSpeakerVoiceConfig（最多 2 人，
  // 2026-08-29 在 3.1-flash-tts / 2.5-pro-tts 上实测 200）。风格是自然语言——
  // Gemini TTS 没有独立的语速/情绪参数，官方就是靠这句话控的。
  const multi = !!(speakers && speakers.length >= 2);
  const speechConfig = multi
    ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: speakers.map((sp) => ({ speaker: sp.speaker, voiceConfig: { prebuiltVoiceConfig: { voiceName: sp.voice } } })) } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || 'Kore' } } };
  // 语言：speechConfig.languageCode（不给 = 按文本自动判断）
  if (languageCode) speechConfig.languageCode = languageCode;
  const config = { responseModalities: ['AUDIO'], speechConfig };
  if (signal) config.abortSignal = signal;
  const st = String(style || '').trim();
  if (!metaStyle) {
    const body = (st ? st + '\n' : '') + String(text || '');
    return { contents: [{ role: 'user', parts: [{ text: body }] }], config };
  }
  const md = (extra) => ({ ...(st ? { style: st } : {}), ...extra });
  let parts;
  if (multi) {
    parts = splitTurns(text, speakers.map((sp) => sp.speaker)).map((t) => ({ text: t.text, speechMetadata: md({ speaker: t.speaker }) }));
    if (!parts.length) parts = [{ text: String(text || ''), speechMetadata: md({ speaker: speakers[0].speaker }) }];
  } else {
    const m = md({});
    parts = [{ text: String(text || ''), ...(Object.keys(m).length ? { speechMetadata: m } : {}) }];
  }
  const contents = [{ role: 'user', parts }];
  // SDK 认的那份（纯文字，speechMetadata 会被它丢掉）+ extraBody 里原样的那份（覆盖上去）
  const sdkContents = [{ role: 'user', parts: parts.map((p) => ({ text: p.text })) }];
  const needExtra = parts.some((p) => p.speechMetadata);
  if (needExtra) config.httpOptions = { extraBody: { contents } };
  return { contents: sdkContents, config };
}

/** 上游回的音频 → 可播放的文件：已是 WAV（3.8 非流式默认带 RIFF 头）就原样用，只有裸 PCM（L16 / pcm，2.5 / 3.1）才包头。 */
export function toPlayable(d) {
  const buf = Buffer.from(d.data, 'base64');
  const mime = String(d.mimeType || '').toLowerCase();
  if (/wav|wave/.test(mime) || buf.toString('ascii', 0, 4) === 'RIFF') return { bytes: buf, mime: 'audio/wav' };
  if (!mime || /l16|pcm/.test(mime)) {
    const rate = parseInt((mime.match(/rate=(\d+)/) || [])[1], 10) || 24000;
    return { bytes: pcmToWav(buf, rate, 1, 16), mime: 'audio/wav' };
  }
  return { bytes: buf, mime: d.mimeType };   // 别的编码（mp3 / ogg…）原样交给任务执行器按 mime 定扩展名
}

/**
 * Synthesize speech. Returns a playable WAV.
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function generate({ model, text, voiceName, style, speakers, languageCode, metaStyle, project, location, credentials, apiKey, signal }) {
  const ai = apiKey ? devClient(apiKey) : client(project, location, credentials);
  const { contents, config } = buildRequest({ text, voiceName, style, speakers, languageCode, metaStyle, signal });
  const res = await ai.models.generateContent({ model, contents, config });
  for (const part of (res.candidates?.[0]?.content?.parts || [])) {
    const d = part.inlineData;
    if (d && d.data) return toPlayable(d);
  }
  throw new Error('TTS 未返回音频（可能被安全策略拦截）');
}
