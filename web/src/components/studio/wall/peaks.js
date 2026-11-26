// 音频作品的真波形（120 格，0–1）：作品记录里带了就用；没带先问服务端（/assets/<id>/peaks，算好会写回侧车）；
// 服务端解不出（没有 ffmpeg）再在本机用 WebAudio 解码——只对 < 8MB 的文件，大的宁可画一条平线也不拖垮手机。
// 同一件作品只算一次（Promise 缓存），同时最多解两件。
import { studioApi } from '../../../modules/studio/api.js';
import { mediaSrc } from '../../../modules/studio/media.svelte.js';

export const BINS = 120;
const MAX_BYTES = 8 * 1024 * 1024;
const cache = new Map();          // id → Promise<{ peaks: number[] | null, duration: number }>
let running = 0;
const queue = [];

function slot(fn) {
  return new Promise((res) => {
    const go = () => { running++; fn().then(res, () => res(null)).finally(() => { running--; queue.shift()?.(); }); };
    if (running < 2) go(); else queue.push(go);
  });
}

/** 和服务端同一个算法：峰值 0.35 + RMS 0.65×2.2，整体归一，0.8 次方（矮的抬一点，别一片贴地） */
export function binsFrom(channels, bins = BINS) {
  const n = channels[0]?.length || 0;
  if (!n) return null;
  const step = n / bins, out = new Array(bins);
  let max = 0;
  for (let b = 0; b < bins; b++) {
    const s = Math.floor(b * step), e = Math.max(s + 1, Math.floor((b + 1) * step));
    let pk = 0, sq = 0, c = 0;
    for (let i = s; i < e; i += 4) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      v /= channels.length;
      const a = Math.abs(v);
      if (a > pk) pk = a;
      sq += v * v; c++;
    }
    const val = 0.35 * pk + 0.65 * Math.sqrt(sq / Math.max(1, c)) * 2.2;
    out[b] = val;
    if (val > max) max = val;
  }
  return out.map((v) => (max > 0 ? Math.pow(v / max, 0.8) : 0));
}

async function decodeLocal(a) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctl = new AbortController();
  const res = await fetch(mediaSrc(a), { signal: ctl.signal });
  if (!res.ok) return null;
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > MAX_BYTES) { ctl.abort(); return null; }
  // 没写长度的：边读边数，超了就停
  const reader = res.body?.getReader();
  let buf;
  if (reader) {
    const parts = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > MAX_BYTES) { ctl.abort(); return null; }
      parts.push(value);
    }
    buf = new Uint8Array(got); let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    buf = buf.buffer;
  } else buf = await res.arrayBuffer();
  const ac = new AC();
  try {
    const ab = await ac.decodeAudioData(buf);
    const chs = []; for (let i = 0; i < Math.min(2, ab.numberOfChannels); i++) chs.push(ab.getChannelData(i));
    return { peaks: binsFrom(chs), duration: ab.duration };
  } finally { try { ac.close(); } catch {} }
}

async function load(a) {
  let duration = Number(a.duration) || 0;
  try {
    const r = await studioApi.peaks(a.id);
    if (Array.isArray(r?.peaks) && r.peaks.length) return { peaks: r.peaks, duration: Number(r.duration) || duration };
    if (r?.duration) duration = Number(r.duration);
  } catch {}
  try {
    const r = await decodeLocal(a);
    if (r?.peaks) return { peaks: r.peaks, duration: r.duration || duration };
  } catch {}
  return { peaks: null, duration };
}

/** 这件作品的波形：{ peaks | null, duration }（null = 拿不到，画一条平线） */
export function peaksFor(a) {
  if (Array.isArray(a?.peaks) && a.peaks.length) return Promise.resolve({ peaks: a.peaks, duration: Number(a.duration) || 0 });
  if (!a?.id) return Promise.resolve({ peaks: null, duration: 0 });
  if (!cache.has(a.id)) cache.set(a.id, slot(() => load(a)).then((r) => r || { peaks: null, duration: Number(a.duration) || 0 }));
  return cache.get(a.id);
}
