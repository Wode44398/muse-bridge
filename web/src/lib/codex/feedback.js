// Codex 分页的触觉与提示音。两样都受外观偏好（prefs.svelte.js）控制。
//   触觉：apk 走原生预置效果（AndroidStore.haptic：text / tick / done / error / click），网页退回 vibrate。
//         吐字是最密的一种：78ms 一次封顶，后台与「减少动态效果」时不震（旧版克隆页的节奏原样保留）。
//   提示音：官方 codex-notification.wav（服务端从本机 Codex 安装包取，见 assets.js），取不到用 WebAudio 合成一声。

import { codexPrefs } from './prefs.svelte.js';
import { reduced } from './motion.js';
import { assetUrl } from './assets.js';

let lastAt = 0;
let lastProcess = '';

export function haptic(kind) {
  if (!codexPrefs.haptics) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  const now = performance.now();
  const minGap = kind === 'text' ? 78 : kind === 'tick' ? 140 : 0;
  if (minGap && now - lastAt < minGap) return;
  if (kind === 'text' && reduced()) return;
  lastAt = now;
  try {
    if (window.AndroidStore?.haptic) { window.AndroidStore.haptic(kind); return; }
  } catch {}
  try {
    const pattern = kind === 'text' ? 3 : kind === 'done' ? [8, 34, 12] : kind === 'error' ? [14, 38, 18] : 7;
    navigator.vibrate?.(pattern);
  } catch {}
}

/** 过程里的一步（思考换段、工具起止）：同一个 key 只震一次，免得同一条工具反复报状态时连震。 */
export function processHaptic(key) {
  if (!key || key === lastProcess) return;
  lastProcess = key;
  haptic('tick');
}
export function resetProcessHaptic() { lastProcess = ''; }

let audio = null;
let audioFailed = false;
let ctx = null;

function synth() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime;
    // 两个短音：E6 → B6，像官方提示音那样轻、快、往上走
    for (const [f, at] of [[1318.5, 0], [1975.5, 0.09]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(0.06, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + at);
      o.stop(t0 + at + 0.34);
    }
  } catch {}
}

/** 一轮跑完的提示音。force = 设置页里试听（不看开关）。 */
export async function chime({ force = false } = {}) {
  if (!force && !codexPrefs.sound) return;
  if (!audioFailed) {
    try {
      if (!audio) {
        const url = await assetUrl('sound', 'notification');
        if (!url) throw new Error('no sound');
        audio = new Audio(url);
        audio.volume = 0.6;
      }
      audio.currentTime = 0;
      await audio.play();
      return;
    } catch {
      // 自动播放被拦（页面还没被点过）也会走到这里：退回合成音同样会被拦，不再重试原件
      audioFailed = !audio;
    }
  }
  synth();
}
