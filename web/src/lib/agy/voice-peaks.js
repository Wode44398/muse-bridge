// Antigravity 原生语音消息的纯函数工具：
//   · 语音文件名编解码（agy-voice-<ms>ms.wav，不污染历史提示词格式，重开历史自动识别为语音气泡）；
//   · 16kHz 单声道 16-bit PCM WAV 编码（≈32 KB/s，Gemini 原生音频与全端浏览器 / Android WebView 零兼容坑）；
//   · 28 柱动态范围扩展声纹重采样 + 本机 peaks 缓存 + 跨端历史确定性兜底轮廓。
// 零 DOM / Svelte 依赖，node --test 直接测。

export const VOICE_BAR_COUNT = 28;
export const VOICE_MAX_SEC = 300;
export const VOICE_SAMPLE_RATE = 16000;

const PEAKS_STORAGE_KEY = 'bridge-agy-voice-peaks';
const PEAKS_CACHE_CAP = 180;

export const AGY_VOICE_FILE_RE = /^agy-voice-(\d+)ms\.(?:wav|ogg|oga|opus|mp3|m4a|weba|webm|aac|flac|amr)$/i;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function makeVoiceFileName(durationSec, ext = 'wav') {
  const safeExt = String(ext || 'wav').toLowerCase().replace(/[^a-z0-9]/g, '') || 'wav';
  const ms = Math.round(clamp(Number(durationSec) || 0.4, 0.1, VOICE_MAX_SEC) * 1000);
  return `agy-voice-${ms}ms.${safeExt}`;
}

export function parseVoiceFileName(fileName) {
  const base = String(fileName || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const stripped = base.replace(/^\d{10,}-(?=.)/, '');
  const m = AGY_VOICE_FILE_RE.exec(stripped);
  if (!m) return null;
  const durationMs = Number(m[1]);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3_600_000) return null;
  return { durationMs, duration: Math.round((durationMs / 1000) * 100) / 100, name: stripped };
}

export function isVoiceAtt(att) {
  if (!att || typeof att !== 'object') return false;
  if (att.kind === 'voice') return true;
  return Boolean(parseVoiceFileName(att.name || att.path || ''));
}

export function formatVoiceDuration(sec) {
  const n = Math.max(1, Math.round(Number(sec) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

export function formatVoiceTimer(ms) {
  const secs = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// 将采集到的实时音量包络做动态对比扩展与两端柔窗，重采样为 28 根清晰声纹柱（0.12..1）
export function resamplePeaks(rawEnv, count = VOICE_BAR_COUNT) {
  const n = Math.max(8, Math.min(48, Math.round(Number(count) || VOICE_BAR_COUNT)));
  const src = Array.isArray(rawEnv) ? rawEnv.filter((v) => Number.isFinite(Number(v))).map(Number) : [];
  const raw = [];
  for (let i = 0; i < n; i++) {
    let v;
    if (src.length >= 4) {
      const a = Math.floor((i / n) * src.length);
      const b = Math.max(a + 1, Math.floor(((i + 1) / n) * src.length));
      let peak = 0;
      for (let j = a; j < Math.min(src.length, b); j++) {
        if (src[j] > peak) peak = src[j];
      }
      v = peak;
    } else {
      const w = Math.sin(i * 0.56 + 0.3) * 0.5 + 0.5;
      const w2 = Math.abs(Math.sin(i * 1.18 + 1.1));
      v = 0.08 + 0.88 * w * w2;
    }
    raw.push(v);
  }
  const lo = Math.min(...raw);
  const hi = Math.max(...raw);
  const span = Math.max(0.18, hi - lo);
  return raw.map((v, i) => {
    const norm = clamp((v - lo) / span, 0, 1);
    const shaped = Math.pow(norm, 1.2);
    const envWin = 0.35 + 0.65 * Math.sin(((i + 0.5) / n) * Math.PI);
    return Math.round(clamp(0.1 + shaped * envWin * 0.9, 0.12, 1) * 100) / 100;
  });
}

// 历史记录跨设备打开且尚无缓存声纹时：按路径种子生成稳定、自然的语流波形轮廓
export function fallbackPeaksFor(seed = '', count = VOICE_BAR_COUNT) {
  let h = 2166136261;
  const s = String(seed || 'voice');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const p1 = ((h >>> 0) % 100) / 100 * Math.PI * 2;
  const p2 = (((h >>> 8) & 0xff) / 255) * Math.PI * 2;
  const raw = [];
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    const syll = 0.5 + 0.5 * Math.sin(t * 14.5 + p1);
    const phrase = 0.45 + 0.55 * Math.abs(Math.sin(t * 5.2 + p2));
    raw.push(0.1 + 0.85 * syll * phrase);
  }
  return resamplePeaks(raw, count);
}

// 单声道 Float32 PCM → 16kHz 16-bit signed little-endian RIFF/WAVE 字节数组
export function encodeWavPcm16(chunks, srcSampleRate, targetSampleRate = VOICE_SAMPLE_RATE) {
  const list = Array.isArray(chunks) ? chunks : (chunks ? [chunks] : []);
  let totalSrc = 0;
  for (const c of list) totalSrc += c?.length || 0;

  const srcRate = Math.max(8000, Number(srcSampleRate) || targetSampleRate);
  const dstRate = Math.max(8000, Number(targetSampleRate) || VOICE_SAMPLE_RATE);

  const merged = new Float32Array(totalSrc);
  let off = 0;
  for (const c of list) {
    if (!c?.length) continue;
    merged.set(c, off);
    off += c.length;
  }

  let outSamples;
  if (totalSrc === 0) {
    outSamples = new Float32Array(0);
  } else if (Math.abs(srcRate - dstRate) < 1) {
    outSamples = merged;
  } else {
    const ratio = srcRate / dstRate;
    const outLen = Math.max(1, Math.round(totalSrc / ratio));
    outSamples = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = merged[idx] ?? 0;
      const s1 = merged[Math.min(totalSrc - 1, idx + 1)] ?? s0;
      outSamples[i] = s0 + (s1 - s0) * frac;
    }
  }

  const dataBytes = outSamples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (at, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(at + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);           // PCM fmt chunk size
  view.setUint16(20, 1, true);            // PCM format
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, dstRate, true);      // sample rate
  view.setUint32(28, dstRate * 2, true);  // byte rate
  view.setUint16(32, 2, true);            // block align
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  let pos = 44;
  for (let i = 0; i < outSamples.length; i++) {
    const s = clamp(outSamples[i], -1, 1);
    view.setInt16(pos, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
    pos += 2;
  }
  return new Uint8Array(buf);
}

// 从解码后的 AudioBuffer 提取真实 28 柱声纹（跨端重开历史消息播放时可升级为真声纹）
export function peaksFromPcm(samples, count = VOICE_BAR_COUNT) {
  if (!samples || !samples.length) return [];
  const raw = [];
  const step = Math.max(1, Math.floor(samples.length / count));
  for (let i = 0; i < count; i++) {
    const a = i * step;
    const b = Math.min(samples.length, a + step);
    let sumSq = 0;
    let peak = 0;
    for (let j = a; j < b; j++) {
      const v = Math.abs(samples[j]);
      sumSq += v * v;
      if (v > peak) peak = v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, b - a));
    raw.push(rms * 0.65 + peak * 0.35);
  }
  return resamplePeaks(raw, count);
}

const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };

function peakCacheKey(rawKey) {
  const s = String(rawKey || '').trim();
  if (!s) return '';
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

export function saveVoicePeaks(key, peaks, storage = ls()) {
  const k = peakCacheKey(key);
  if (!storage || !k || !Array.isArray(peaks) || !peaks.length) return;
  try {
    const map = JSON.parse(storage.getItem(PEAKS_STORAGE_KEY) || '{}');
    const clean = peaks.slice(0, 48).map((v) => Math.round(clamp(Number(v) || 0.12, 0.1, 1) * 100) / 100);
    map[k] = { p: clean, at: Date.now() };
    const entries = Object.entries(map).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, PEAKS_CACHE_CAP);
    storage.setItem(PEAKS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

export function loadVoicePeaks(key, storage = ls()) {
  const k = peakCacheKey(key);
  if (!storage || !k) return null;
  try {
    const map = JSON.parse(storage.getItem(PEAKS_STORAGE_KEY) || '{}');
    const hit = map?.[k];
    return Array.isArray(hit?.p) && hit.p.length ? hit.p : null;
  } catch {
    return null;
  }
}
