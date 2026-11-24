// Antigravity 原生语音采集器：
//   · 安卓离线壳优先走原生 window.BridgeVoice（AudioRecord 16kHz Mono 16-bit PCM WAV + /__localvoice 零拷贝取 Blob），
//     彻底绕开 Android WebView AudioManagerAndroid / VOICE_COMMUNICATION / 蓝牙 SCO 导致的误报 NotReadableError；
//   · 桌面与网页端走 Web Audio API（getUserMedia 多档约束回退 → AnalyserNode + ScriptProcessorNode → 0-gain），
//     16kHz 16-bit 单声道 WAV ≈ 32 KB/s（10 秒 ≈ 320 KB），Gemini 原生音频与全端 <audio> 无条件直通且无 WebM Infinity 时长坑；
//   · 严格状态代号隔离：麦克风授权弹窗期间若用户已松手 / 切页 / 取消，拿到流或原生回调的瞬间立即释放，零麦克风泄漏。

import {
  VOICE_MAX_SEC,
  VOICE_SAMPLE_RATE,
  encodeWavPcm16,
  makeVoiceFileName,
  resamplePeaks,
} from './voice-peaks.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const nativeListeners = new Map();
let nativeTokenCounter = 0;

function ensureNativeDispatcher() {
  if (typeof globalThis === 'undefined') return;
  if (globalThis.__bridgeVoice?.__agyVoiceRouter) return;
  const dispatch = (ev) => {
    const tok = String(ev?.token || '');
    if (!tok) return;
    const fn = nativeListeners.get(tok);
    if (fn) {
      try { fn(ev); } catch {}
    }
  };
  dispatch.__agyVoiceRouter = true;
  globalThis.__bridgeVoice = dispatch;
}

export function getNativeVoiceBridge(overrideBridge = null) {
  const b = overrideBridge ?? globalThis?.BridgeVoice;
  try {
    if (b && typeof b.version === 'function' && Number(b.version()) >= 1 && typeof b.start === 'function') {
      return b;
    }
  } catch {}
  return null;
}

export function voiceErrorMessage(err, t) {
  const name = String(err?.name || '');
  const code = String(err?.code || '');
  if (code === 'UNSUPPORTED') {
    return t('当前环境不支持麦克风录音（请使用 HTTPS 或客户端）');
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return t('未获取麦克风权限，请在系统或浏览器设置中允许麦克风访问');
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return t('未检测到可用的麦克风设备');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return t('麦克风正被其他应用占用，无法开启录音');
  }
  if (!getNativeVoiceBridge() && !globalThis?.navigator?.mediaDevices?.getUserMedia) {
    return t('当前环境不支持麦克风录音（请使用 HTTPS 或客户端）');
  }
  return t('开启录音失败，请检查麦克风后重试');
}

const NON_RETRYABLE_GUM_ERRORS = new Set([
  'NotAllowedError',
  'PermissionDeniedError',
  'SecurityError',
  'NotFoundError',
  'DevicesNotFoundError',
]);

// 依次尝试：标准降噪约束 → 原始麦克风（避开安卓/蓝牙 VOICE_COMMUNICATION 与硬件 AEC 锁定）→ 最简 { audio: true }
const GUM_CONSTRAINT_PROFILES = [
  {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  },
  {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  },
  { audio: true },
];

async function acquireWebAudioStream(md, isCancelled) {
  let lastErr = null;
  for (let i = 0; i < GUM_CONSTRAINT_PROFILES.length; i++) {
    if (isCancelled()) return { cancelled: true, stream: null };
    try {
      const stream = await md.getUserMedia(GUM_CONSTRAINT_PROFILES[i]);
      return { cancelled: false, stream };
    } catch (err) {
      lastErr = err;
      const name = String(err?.name || '');
      try { console.warn(`[agy-voice] getUserMedia profile#${i} failed:`, name, err?.message || ''); } catch {}
      if (NON_RETRYABLE_GUM_ERRORS.has(name)) {
        throw err;
      }
    }
  }
  throw lastErr || new Error('getUserMedia failed');
}

async function defaultFetchNativeWav(id) {
  const res = await fetch(`/__localvoice?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return await res.blob();
}

export function createVoiceRecorder({
  onAutoStop = null,
  nativeBridge = null,
  fetchNativeWav = defaultFetchNativeWav,
  mediaDevices = null,
} = {}) {
  let active = false;
  let seq = 0;
  let stream = null;
  let ctx = null;
  let source = null;
  let analyser = null;
  let processor = null;
  let silentGain = null;
  let freqData = null;
  let timeData = null;
  let pcmChunks = [];
  let totalSamples = 0;
  let sampleRate = 48000;
  let envelope = [];
  let smoothLevel = 0;
  let startedAt = 0;
  let autoStopFired = false;

  // 原生桥状态
  let activeNativeBridge = null;
  let nativeToken = '';
  let pendingNativeStart = null;
  let pendingNativeStop = null;

  function clearNativePendingStart(result) {
    const p = pendingNativeStart;
    pendingNativeStart = null;
    if (p) p.resolve(result);
  }

  function clearNativePendingStop(result) {
    const p = pendingNativeStop;
    pendingNativeStop = null;
    if (p) {
      clearTimeout(p.timer);
      p.resolve(result);
    }
  }

  function teardownWeb() {
    if (processor) {
      try { processor.onaudioprocess = null; } catch {}
      try { processor.disconnect(); } catch {}
      processor = null;
    }
    if (silentGain) {
      try { silentGain.disconnect(); } catch {}
      silentGain = null;
    }
    if (analyser) {
      try { analyser.disconnect(); } catch {}
      analyser = null;
    }
    if (source) {
      try { source.disconnect(); } catch {}
      source = null;
    }
    if (ctx) {
      try { ctx.close(); } catch {}
      ctx = null;
    }
    if (stream) {
      try { stream.getTracks().forEach((tr) => tr.stop()); } catch {}
      stream = null;
    }
    freqData = null;
    timeData = null;
  }

  function teardownNative({ sendCancel = true } = {}) {
    const tok = nativeToken;
    const br = activeNativeBridge;
    nativeToken = '';
    activeNativeBridge = null;
    if (tok) {
      nativeListeners.delete(tok);
      if (sendCancel && br) {
        try { br.cancel?.(tok); } catch {}
      }
    }
    clearNativePendingStart({ cancelled: true });
    clearNativePendingStop(null);
  }

  function teardown() {
    teardownWeb();
    teardownNative({ sendCancel: true });
    active = false;
  }

  async function startNative(bridge, mySeq) {
    ensureNativeDispatcher();
    const tok = `v${++nativeTokenCounter}`;
    activeNativeBridge = bridge;
    nativeToken = tok;

    return await new Promise((resolve, reject) => {
      pendingNativeStart = { resolve, reject };
      nativeListeners.set(tok, (ev) => {
        if (!ev || ev.token !== tok) return;
        if (ev.type === 'started') {
          if (mySeq !== seq || nativeToken !== tok) {
            nativeListeners.delete(tok);
            try { bridge.cancel?.(tok); } catch {}
            clearNativePendingStart({ cancelled: true });
            return;
          }
          sampleRate = Number(ev.sampleRate) || VOICE_SAMPLE_RATE;
          active = true;
          startedAt = performance.now();
          const p = pendingNativeStart;
          pendingNativeStart = null;
          p?.resolve({ ok: true, sampleRate });
          return;
        }
        if (ev.type === 'autostop') {
          if (mySeq === seq && nativeToken === tok && !autoStopFired) {
            autoStopFired = true;
            try { onAutoStop?.(); } catch {}
          }
          return;
        }
        if (ev.type === 'stopped') {
          nativeListeners.delete(tok);
          const p = pendingNativeStop;
          pendingNativeStop = null;
          if (p) {
            clearTimeout(p.timer);
            p.resolve(ev);
          }
          return;
        }
        if (ev.type === 'error') {
          nativeListeners.delete(tok);
          const err = new Error(ev.message || 'native voice recorder error');
          err.name = String(ev.name || 'NotReadableError');
          if (pendingNativeStart) {
            const p = pendingNativeStart;
            pendingNativeStart = null;
            if (nativeToken === tok) {
              nativeToken = '';
              activeNativeBridge = null;
              active = false;
            }
            p.reject(err);
          } else if (pendingNativeStop) {
            clearNativePendingStop(null);
          } else if (nativeToken === tok) {
            nativeToken = '';
            activeNativeBridge = null;
            active = false;
          }
        }
      });

      try {
        bridge.start(tok);
      } catch (err) {
        nativeListeners.delete(tok);
        nativeToken = '';
        activeNativeBridge = null;
        pendingNativeStart = null;
        reject(err);
      }
    });
  }

  async function start() {
    teardown();
    const mySeq = ++seq;
    pcmChunks = [];
    totalSamples = 0;
    envelope = [];
    smoothLevel = 0;
    startedAt = performance.now();
    autoStopFired = false;

    const bridge = getNativeVoiceBridge(nativeBridge);
    if (bridge) {
      return await startNative(bridge, mySeq);
    }

    const md = mediaDevices ?? globalThis?.navigator?.mediaDevices;
    if (!md?.getUserMedia) {
      const err = new Error('microphone unavailable');
      err.code = 'UNSUPPORTED';
      throw err;
    }

    const acquired = await acquireWebAudioStream(md, () => mySeq !== seq);
    if (acquired.cancelled) return { cancelled: true };
    const gotStream = acquired.stream;

    // 等待权限弹窗期间调用方已经取消 / 松手 / 卸载：立刻释放麦克风轨道
    if (mySeq !== seq) {
      try { gotStream?.getTracks?.().forEach((tr) => tr.stop()); } catch {}
      return { cancelled: true };
    }

    try {
      const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioCtx) throw Object.assign(new Error('AudioContext unavailable'), { code: 'UNSUPPORTED' });

      stream = gotStream;
      ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch {}
      }
      if (mySeq !== seq) {
        teardown();
        return { cancelled: true };
      }

      sampleRate = ctx.sampleRate || 48000;
      source = ctx.createMediaStreamSource(stream);

      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Float32Array(analyser.fftSize);
      source.connect(analyser);

      // ScriptProcessorNode 经零增益节点接 destination：绕开 Android WebView / 离线壳里
      // AudioWorklet blob URL 的安全限制，同时保持 0 回声输出
      const bufSize = 4096;
      processor = ctx.createScriptProcessor(bufSize, 1, 1);
      const maxSamples = Math.ceil(sampleRate * VOICE_MAX_SEC);
      processor.onaudioprocess = (ev) => {
        if (!active || mySeq !== seq) return;
        const ch = ev.inputBuffer.getChannelData(0);
        if (!ch || !ch.length) return;
        const copy = new Float32Array(ch.length);
        copy.set(ch);
        pcmChunks.push(copy);
        totalSamples += copy.length;
        if (totalSamples >= maxSamples && !autoStopFired) {
          autoStopFired = true;
          try { onAutoStop?.(); } catch {}
        }
      };

      silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);

      active = true;
      startedAt = performance.now();
      return { ok: true, sampleRate };
    } catch (err) {
      teardown();
      throw err;
    }
  }

  function sampleLevel(dt = 1 / 60, muted = false) {
    let target = 0.03;
    if (!muted && active) {
      if (activeNativeBridge) {
        try {
          const lv = Number(activeNativeBridge.level?.());
          target = clamp(Number.isFinite(lv) ? lv : 0.04, 0.04, 1);
        } catch {
          target = 0.04;
        }
      } else if (analyser && freqData && timeData) {
        analyser.getByteFrequencyData(freqData);
        analyser.getFloatTimeDomainData(timeData);
        let freqSum = 0;
        const bins = Math.min(28, freqData.length - 2);
        for (let i = 2; i < bins + 2; i++) freqSum += freqData[i];
        const freqAmp = bins > 0 ? (freqSum / bins / 255) * 2.15 : 0;

        let sq = 0;
        for (let i = 0; i < timeData.length; i++) sq += timeData[i] * timeData[i];
        const rmsAmp = Math.sqrt(sq / timeData.length) * 3.8;
        target = clamp(Math.max(freqAmp, rmsAmp), 0.04, 1);
      }
    }
    smoothLevel += (target - smoothLevel) * Math.min(1, Math.max(0.05, dt * 16));
    return smoothLevel;
  }

  function recordEnvelopePoint(level) {
    if (active) envelope.push(clamp(Number(level) || 0.04, 0, 1));
  }

  function cancel() {
    seq += 1;
    teardown();
    pcmChunks = [];
    totalSamples = 0;
    envelope = [];
    smoothLevel = 0;
  }

  async function stopNative(br, tok, env, wallSec) {
    const ev = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingNativeStop) {
          pendingNativeStop = null;
          nativeListeners.delete(tok);
          resolve(null);
        }
      }, 6000);
      pendingNativeStop = { resolve, timer };
      try {
        br.stop(tok);
      } catch {
        clearTimeout(timer);
        pendingNativeStop = null;
        nativeListeners.delete(tok);
        resolve(null);
      }
    });

    if (!ev || ev.empty || !ev.id) return null;
    const id = String(ev.id);
    let blob = null;
    try {
      blob = await fetchNativeWav(id);
    } catch {
      blob = null;
    } finally {
      try { br.release?.(id); } catch {}
    }
    if (!blob || !blob.size) return null;

    const nativeSec = Number(ev.durationSec) || 0;
    const durationSec = Math.max(nativeSec, wallSec);
    const peaks = resamplePeaks(env);
    const fileName = makeVoiceFileName(durationSec, 'wav');

    return {
      blob,
      mime: 'audio/wav',
      size: blob.size,
      durationSec: Math.round(durationSec * 100) / 100,
      peaks,
      fileName,
    };
  }

  function stop() {
    seq += 1;
    const env = envelope.slice();
    const wallSec = startedAt ? Math.max(0, (performance.now() - startedAt) / 1000) : 0;

    if (activeNativeBridge && nativeToken) {
      const br = activeNativeBridge;
      const tok = nativeToken;
      const wasActive = active;
      activeNativeBridge = null;
      nativeToken = '';
      active = false;
      envelope = [];
      smoothLevel = 0;
      clearNativePendingStart({ cancelled: true });

      if (!wasActive) {
        nativeListeners.delete(tok);
        try { br.cancel?.(tok); } catch {}
        return null;
      }
      return stopNative(br, tok, env, wallSec);
    }

    const chunks = pcmChunks;
    const rate = sampleRate;
    const pcmSec = totalSamples > 0 && rate > 0 ? totalSamples / rate : 0;

    teardown();
    pcmChunks = [];
    totalSamples = 0;
    envelope = [];
    smoothLevel = 0;

    const durationSec = Math.max(pcmSec, wallSec);
    if (!chunks.length) return null;

    const wavBytes = encodeWavPcm16(chunks, rate, VOICE_SAMPLE_RATE);
    const blob = new Blob([wavBytes], { type: 'audio/wav' });
    const peaks = resamplePeaks(env);
    const fileName = makeVoiceFileName(durationSec, 'wav');

    return {
      blob,
      mime: 'audio/wav',
      size: blob.size,
      durationSec: Math.round(durationSec * 100) / 100,
      peaks,
      fileName,
    };
  }

  return {
    start,
    stop,
    cancel,
    sampleLevel,
    recordEnvelopePoint,
    isActive: () => active,
  };
}
