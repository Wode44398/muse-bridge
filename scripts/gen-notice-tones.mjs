// 会话消息通知的内置提示音（2026-11-07）：纯合成、不用任何第三方音频素材。
// 产物两份同源：web/public/sounds/notice-<id>.wav（网页 / 桌面前台横幅）与
// android/app/src/main/res/raw/notice_<id>.wav（手机原生通知，MsgNotify 播）。
// 改音色就改这里重跑：node scripts/gen-notice-tones.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 44100;

// 一个「敲击」音：若干分音各自指数衰减，4ms 起音防爆音
function strike(buf, at, freq, { partials = [[1, 1]], tau = 0.3, gain = 1, glide = null } = {}) {
  const start = Math.round(at * SR);
  const len = Math.min(buf.length - start, Math.round(tau * 7 * SR));
  for (const [ratio, amp, ptau = tau] of partials) {
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const f = (glide ? glide(t) : freq) * ratio;
      phase += (2 * Math.PI * f) / SR;
      const env = Math.min(1, t / 0.004) * Math.exp(-t / ptau);
      buf[start + i] += Math.sin(phase) * amp * env * gain;
    }
  }
}

// 默认是系统通知声音（手机放手机自己的），这几个只是备选；「叮咚」两声钟像门铃，维护者否了，已删。
const TONES = {
  // 清脆：一声明亮的「叮」（网页 / 电脑前台选「系统通知声音」时也用它代替）
  ding(buf) {
    strike(buf, 0, 1760, { partials: [[1, 1, 0.26], [2, 0.28, 0.14], [2.76, 0.12, 0.08], [5.4, 0.04, 0.04]], tau: 0.26 });
  },
  // 水滴：两颗上扬的水滴
  drop(buf) {
    const glide = (lo, hi) => (t) => lo + (hi - lo) * (1 - Math.exp(-t / 0.018));
    strike(buf, 0, 0, { partials: [[1, 1, 0.07]], tau: 0.07, glide: glide(520, 1480) });
    strike(buf, 0.15, 0, { partials: [[1, 0.7, 0.06]], tau: 0.06, glide: glide(700, 1900) });
  },
  // 嘀嘀：两下短促的木琴
  pop(buf) {
    const mar = { partials: [[1, 1, 0.1], [4, 0.14, 0.03], [10, 0.03, 0.01]], tau: 0.1 };
    strike(buf, 0, 1046.5, mar);
    strike(buf, 0.11, 1396.9, mar);
  },
};
const LEN = { ding: 0.8, drop: 0.55, pop: 0.6 };

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const webDir = path.join(ROOT, 'web', 'public', 'sounds');
const rawDir = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'raw');
mkdirSync(webDir, { recursive: true });
mkdirSync(rawDir, { recursive: true });
for (const [id, fn] of Object.entries(TONES)) {
  const buf = new Float64Array(Math.round(LEN[id] * SR));
  fn(buf);
  // 收尾 40ms 淡出、峰值归一到 0.8（-2 dBFS）
  const fade = Math.round(0.04 * SR);
  for (let i = 0; i < fade; i++) buf[buf.length - 1 - i] *= i / fade;
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] / (peak || 1)) * 0.8;
  const out = wav(buf);
  writeFileSync(path.join(webDir, `notice-${id}.wav`), out);
  writeFileSync(path.join(rawDir, `notice_${id}.wav`), out);
  console.log(id, (out.length / 1024).toFixed(1) + 'KB');
}
