import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICE_BAR_COUNT,
  VOICE_SAMPLE_RATE,
  makeVoiceFileName,
  parseVoiceFileName,
  isVoiceAtt,
  formatVoiceDuration,
  formatVoiceTimer,
  resamplePeaks,
  fallbackPeaksFor,
  encodeWavPcm16,
  peaksFromPcm,
  saveVoicePeaks,
  loadVoicePeaks,
} from './voice-peaks.js';
import { blobPath, metaballBridge } from './springs.js';
import { attLook, splitAttachedPaths } from './attach-look.js';
import { cleanAtts } from './persist.js';
import { createVoiceRecorder, voiceErrorMessage } from './voice-recorder.js';

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('语音文件名编解码与时间戳前缀剥离', () => {
  const fn = makeVoiceFileName(4.23);
  assert.equal(fn, 'agy-voice-4230ms.wav');

  const p1 = parseVoiceFileName(fn);
  assert.deepEqual(p1, { durationMs: 4230, duration: 4.23, name: 'agy-voice-4230ms.wav' });

  const p2 = parseVoiceFileName('C:\\Users\\demo\\uploads\\1795494778559-agy-voice-12800ms.wav');
  assert.deepEqual(p2, { durationMs: 12800, duration: 12.8, name: 'agy-voice-12800ms.wav' });

  assert.equal(parseVoiceFileName('meeting-notes.wav'), null);
  assert.equal(isVoiceAtt({ kind: 'voice', name: 'x.wav' }), true);
  assert.equal(isVoiceAtt({ kind: 'file', path: '/uploads/1795494778559-agy-voice-3500ms.wav' }), true);
  assert.equal(isVoiceAtt({ kind: 'file', name: 'report.pdf' }), false);
});

test('时长格式化（气泡至少 0:01，录制计时从 0:00 起）', () => {
  assert.equal(formatVoiceDuration(0.4), '0:01');
  assert.equal(formatVoiceDuration(4.2), '0:04');
  assert.equal(formatVoiceDuration(65.6), '1:06');
  assert.equal(formatVoiceTimer(0), '0:00');
  assert.equal(formatVoiceTimer(4900), '0:04');
  assert.equal(formatVoiceTimer(72300), '1:12');
});

test('16kHz 单声道 16-bit PCM WAV 编码与重采样头校验', () => {
  // 48kHz 0.5s 正弦波 → 下采样至 16kHz 应得 ~8000 samples (16000 bytes PCM + 44 bytes header)
  const srcRate = 48000;
  const srcLen = 24000;
  const pcm = new Float32Array(srcLen);
  for (let i = 0; i < srcLen; i++) pcm[i] = Math.sin((2 * Math.PI * 440 * i) / srcRate) * 0.5;

  const wav = encodeWavPcm16([pcm.subarray(0, 12000), pcm.subarray(12000)], srcRate, VOICE_SAMPLE_RATE);
  assert.equal(wav.byteLength, 44 + 8000 * 2);

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(String.fromCharCode(...wav.slice(12, 16)), 'fmt ');
  assert.equal(String.fromCharCode(...wav.slice(36, 40)), 'data');
  assert.equal(view.getUint16(20, true), 1, 'PCM format');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16000, '16kHz sample rate');
  assert.equal(view.getUint16(34, true), 16, '16-bit');
  assert.equal(view.getUint32(40, true), 16000, 'data chunk byte length');

  const peaks = peaksFromPcm(pcm, VOICE_BAR_COUNT);
  assert.equal(peaks.length, VOICE_BAR_COUNT);
  assert.ok(peaks.every((v) => v >= 0.12 && v <= 1));
});

test('声纹重采样、确定性兜底与本机缓存', () => {
  const resampled = resamplePeaks([0.05, 0.2, 0.85, 0.4, 0.9, 0.15, 0.6, 0.3], VOICE_BAR_COUNT);
  assert.equal(resampled.length, VOICE_BAR_COUNT);
  assert.ok(resampled.every((v) => v >= 0.12 && v <= 1));

  const fbA = fallbackPeaksFor('agy-voice-4200ms.wav');
  const fbB = fallbackPeaksFor('agy-voice-4200ms.wav');
  assert.deepEqual(fbA, fbB, '同路径兜底声纹稳定');

  const store = memStorage();
  saveVoicePeaks('C:\\uploads\\1795494778559-agy-voice-4200ms.wav', resampled, store);
  assert.deepEqual(loadVoicePeaks('1795494778559-agy-voice-4200ms.wav', store), resampled);
});

test('历史附加路径前缀自动还原为原生语音附件，草稿持久化保留 voice 字段', () => {
  const prompt = '本轮附加文件路径：\n- C:\\Users\\demo\\uploads\\1795494778559-agy-voice-5400ms.wav  ← 已作为文件内容附上（看不到内容时用 read_file 打开该路径）';
  const split = splitAttachedPaths(prompt);
  assert.equal(split.text, '');
  assert.equal(split.atts.length, 1);
  assert.equal(split.atts[0].kind, 'voice');
  assert.equal(split.atts[0].duration, 5.4);
  assert.equal(split.atts[0].name, 'agy-voice-5400ms.wav');

  const look = attLook(split.atts[0]);
  assert.equal(look.isVoice, true);
  assert.equal(look.duration, 5.4);

  const cleaned = cleanAtts([{
    path: split.atts[0].path,
    name: split.atts[0].name,
    kind: 'voice',
    duration: 5.4,
    peaks: [0.2, 0.8, 0.5],
    url: 'blob:http://localhost/abc',
    size: 172844,
  }]);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].kind, 'voice');
  assert.equal(cleaned[0].duration, 5.4);
  assert.deepEqual(cleaned[0].peaks, [0.2, 0.8, 0.5]);
  assert.equal('url' in cleaned[0], false);
});

test('解析液滴分身桥与扩展超椭圆路径', () => {
  assert.equal(blobPath(0, 2, 0, 6, 0), '');
  const d = blobPath(16, 2.9, 0, 6, 0, -4, 0, 1.05, 0.96);
  assert.ok(d.startsWith('M') && d.endsWith('Z'));

  assert.equal(metaballBridge(0, 16, -24, 14, 0), '');
  const br = metaballBridge(0, 16, -26, 13, 0.75);
  assert.ok(br.startsWith('M ') && br.includes(' Q ') && br.endsWith(' Z'));
});

test('原生 BridgeVoice 通道：录制、电平读取、停止取 WAV 与释放缓存', async () => {
  const calls = [];
  let curLevel = 0.62;
  const bridge = {
    version: () => 1,
    start: (tok) => {
      calls.push(['start', tok]);
      queueMicrotask(() => globalThis.__bridgeVoice({ type: 'started', token: tok, sampleRate: 16000 }));
    },
    stop: (tok) => {
      calls.push(['stop', tok]);
      queueMicrotask(() => globalThis.__bridgeVoice({
        type: 'stopped',
        token: tok,
        id: 'vtest1',
        size: 32044,
        durationSec: 1.0,
        sampleRate: 16000,
        empty: false,
      }));
    },
    cancel: (tok) => { calls.push(['cancel', tok]); },
    level: () => curLevel,
    release: (id) => { calls.push(['release', id]); },
  };
  const fakeWav = new Blob([new Uint8Array(32044)], { type: 'audio/wav' });
  const rec = createVoiceRecorder({
    nativeBridge: bridge,
    fetchNativeWav: async (id) => {
      calls.push(['fetch', id]);
      return fakeWav;
    },
  });

  const started = await rec.start();
  assert.deepEqual(started, { ok: true, sampleRate: 16000 });
  assert.equal(rec.isActive(), true);

  const lv = rec.sampleLevel(1 / 30, false);
  assert.ok(lv > 0.2 && lv <= 1);
  rec.recordEnvelopePoint(lv);
  curLevel = 0.85;
  rec.recordEnvelopePoint(rec.sampleLevel(1 / 30, false));

  const out = await rec.stop();
  assert.ok(out);
  assert.equal(out.mime, 'audio/wav');
  assert.equal(out.size, 32044);
  assert.equal(out.durationSec >= 1.0, true);
  assert.equal(out.peaks.length, VOICE_BAR_COUNT);
  assert.match(out.fileName, /^agy-voice-\d+ms\.wav$/);
  assert.equal(rec.isActive(), false);
  assert.deepEqual(calls.map((c) => c[0]), ['start', 'stop', 'fetch', 'release']);
});

test('原生 BridgeVoice 通道：授权等待期间取消不泄漏且不抛错，拒权报 NotAllowedError', async () => {
  const cancelled = [];
  let heldTok = '';
  const bridge = {
    version: () => 1,
    start: (tok) => { heldTok = tok; },
    stop: () => {},
    cancel: (tok) => { cancelled.push(tok); },
    level: () => 0.04,
    release: () => {},
  };
  const rec = createVoiceRecorder({ nativeBridge: bridge });
  const p = rec.start();
  rec.cancel();
  const res = await p;
  assert.deepEqual(res, { cancelled: true });
  assert.deepEqual(cancelled, [heldTok]);

  // 权限被拒
  const denyBridge = {
    version: () => 1,
    start: (tok) => {
      queueMicrotask(() => globalThis.__bridgeVoice({
        type: 'error',
        token: tok,
        name: 'NotAllowedError',
        message: 'RECORD_AUDIO denied',
      }));
    },
    stop: () => {},
    cancel: () => {},
    level: () => 0.04,
    release: () => {},
  };
  const rec2 = createVoiceRecorder({ nativeBridge: denyBridge });
  await assert.rejects(() => rec2.start(), (err) => {
    assert.equal(err.name, 'NotAllowedError');
    assert.equal(
      voiceErrorMessage(err, (s) => s),
      '未获取麦克风权限，请在系统或浏览器设置中允许麦克风访问',
    );
    return true;
  });
});

test('原生 BridgeVoice 通道：达到时长上限触发 onAutoStop', async () => {
  let autoCount = 0;
  let activeTok = '';
  const bridge = {
    version: () => 1,
    start: (tok) => {
      activeTok = tok;
      queueMicrotask(() => globalThis.__bridgeVoice({ type: 'started', token: tok, sampleRate: 16000 }));
    },
    stop: () => {},
    cancel: () => {},
    level: () => 0.1,
    release: () => {},
  };
  const rec = createVoiceRecorder({
    nativeBridge: bridge,
    onAutoStop: () => { autoCount += 1; },
  });
  await rec.start();
  globalThis.__bridgeVoice({ type: 'autostop', token: activeTok });
  globalThis.__bridgeVoice({ type: 'autostop', token: activeTok });
  assert.equal(autoCount, 1);
  rec.cancel();
});

test('Web getUserMedia：遇 NotReadableError 自动回退原始麦克风约束，NotAllowedError 直接抛出', async () => {
  const seen = [];
  let stopped = false;
  const fakeStream = { getTracks: () => [{ stop: () => { stopped = true; } }] };
  const origAudioCtx = globalThis.AudioContext;
  globalThis.AudioContext = class FakeAudioContext {
    sampleRate = 16000;
    state = 'running';
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 256, frequencyBinCount: 128, smoothingTimeConstant: 0, getByteFrequencyData() {}, getFloatTimeDomainData() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    close() {}
  };
  try {
    const rec = createVoiceRecorder({
      mediaDevices: {
        getUserMedia: async (constraints) => {
          seen.push(constraints);
          if (seen.length === 1) {
            const err = new Error('Could not start audio source');
            err.name = 'NotReadableError';
            throw err;
          }
          return fakeStream;
        },
      },
    });
    const r = await rec.start();
    assert.deepEqual(r, { ok: true, sampleRate: 16000 });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].audio.echoCancellation, true);
    assert.equal(seen[1].audio.echoCancellation, false);
    rec.cancel();
    assert.equal(stopped, true);

    const denySeen = [];
    const recDeny = createVoiceRecorder({
      mediaDevices: {
        getUserMedia: async (constraints) => {
          denySeen.push(constraints);
          const err = new Error('Permission denied');
          err.name = 'NotAllowedError';
          throw err;
        },
      },
    });
    await assert.rejects(() => recDeny.start(), { name: 'NotAllowedError' });
    assert.equal(denySeen.length, 1);
  } finally {
    globalThis.AudioContext = origAudioCtx;
  }
});
