import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtTime, parseTimecode, srtToVtt, parseCues, cuesAt, chapterAt, storyboardCell,
  resumeWorthy, resumeStore, loadAvPrefs, saveAvPrefs, stepRate, parseId3, id3Size, fakePeaks, resamplePeaks, decodeSubtitle,
  peaksFromChannels, wheelStepper,
} from './avUtil.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

test('时间格式', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(65.9), '1:05');
  assert.equal(fmtTime(3600 + 62), '1:01:02');
  assert.equal(fmtTime(NaN), '0:00');
  assert.equal(fmtTime(-3), '0:00');
  assert.equal(parseTimecode('00:01:02,500'), 62.5);
  assert.equal(parseTimecode('01:02.25'), 62.25);
  assert.equal(parseTimecode('1:00:00.000'), 3600);
  assert.ok(Number.isNaN(parseTimecode('abc')));
});

test('SRT → VTT 与 cue 解析', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>你好</i>\r\n世界\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n{\\an8}第二句 &amp; 结束\r\n';
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:02.500'));
  const cues = parseCues(vtt);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 2.5, text: '你好\n世界' });
  assert.equal(cues[1].text, '第二句 & 结束');
  // SRT 原文也能直接解析
  assert.equal(parseCues(srt).length, 2);
  const v2 = 'WEBVTT\n\nNOTE 注释\n\n00:01.000 --> 00:03.000 line:90%\n<v 甲>一</v>\n\n00:02.000 --> 00:04.000\n二\n';
  const c2 = parseCues(v2);
  assert.equal(c2.length, 2);
  assert.deepEqual(cuesAt(c2, 2.5), ['一', '二']);
  assert.deepEqual(cuesAt(c2, 0.5), []);
  assert.deepEqual(cuesAt(c2, 3.5), ['二']);
  assert.deepEqual(cuesAt(c2, 4), []);
});

test('章节与 storyboard 取格', () => {
  const ch = [{ start: 0, end: 10, title: 'A' }, { start: 10, end: 20, title: 'B' }];
  assert.equal(chapterAt(ch, 12).title, 'B');
  assert.equal(chapterAt(ch, 0).title, 'A');
  assert.equal(chapterAt([], 3), null);
  const sb = { cols: 10, rows: 3, w: 160, h: 90, interval: 1, count: 30 };
  assert.deepEqual(storyboardCell(sb, 12.2), { i: 12, col: 2, row: 1, x: 320, y: 90, w: 160, h: 90, W: 1600, H: 270 });
  assert.equal(storyboardCell(sb, 999).i, 29);
  assert.equal(storyboardCell(sb, -5).i, 0);
  assert.equal(storyboardCell(null, 3), null);
});

test('续播 LRU', () => {
  assert.equal(resumeWorthy(20, 100), false);
  assert.equal(resumeWorthy(40, 100), true);
  assert.equal(resumeWorthy(95, 100), false);
  assert.equal(resumeWorthy(40, 0), true);   // 时长未知照记
  const st = mem();
  const r = resumeStore(st, { cap: 3 });
  r.set('a', 40, 100);
  assert.equal(r.get('a').t, 40);
  r.set('a', 99, 100);   // 看到结尾 → 清掉
  assert.equal(r.get('a'), null);
  r.set('a', 40, 100); r.set('b', 41, 100); r.set('c', 42, 100); r.set('d', 43, 100);
  assert.equal(r.get('a'), null);   // 超容量挤掉最旧
  assert.equal(r.get('d').t, 43);
  r.set('b', 50, 100);   // 更新=移到最新
  r.set('e', 44, 100);
  assert.equal(r.get('c'), null);
  assert.equal(r.get('b').t, 50);
  r.clear('b');
  assert.equal(r.get('b'), null);
  assert.equal(resumeStore({ getItem: () => '{bad', setItem() {} }).get('x'), null);
});

test('播放偏好与倍速档位', () => {
  const st = mem();
  assert.deepEqual(loadAvPrefs(st), { volume: 1, muted: false, rate: 1 });
  saveAvPrefs(st, { volume: 0.35, muted: true, rate: 1.5 });
  assert.deepEqual(loadAvPrefs(st), { volume: 0.35, muted: true, rate: 1.5 });
  st.setItem('pv.av', JSON.stringify({ volume: 7, rate: 9 }));
  assert.deepEqual(loadAvPrefs(st), { volume: 1, muted: false, rate: 2 });
  assert.equal(stepRate(1, 1), 1.25);
  assert.equal(stepRate(1, -1), 0.75);
  assert.equal(stepRate(2, 1), 2);
  assert.equal(stepRate(0.25, -1), 0.25);
  assert.equal(stepRate(1.1, 1), 1.25);
  assert.equal(stepRate(1.1, -1), 1);
});

function frame23(id, payload) {
  const h = new Uint8Array(10 + payload.length);
  h.set([...id].map((c) => c.charCodeAt(0)), 0);
  const n = payload.length;
  h[4] = (n >>> 24) & 255; h[5] = (n >>> 16) & 255; h[6] = (n >>> 8) & 255; h[7] = n & 255;
  h.set(payload, 10);
  return h;
}
function tag23(frames) {
  const body = frames.reduce((a, f) => { const x = new Uint8Array(a.length + f.length); x.set(a); x.set(f, a.length); return x; }, new Uint8Array(0));
  const n = body.length + 16;   // 带一点补白
  const out = new Uint8Array(10 + n);
  out.set([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  out.set(body, 10);
  return out;
}
test('ID3v2.3 解析', () => {
  const enc = new TextEncoder();
  const utf16 = (s) => { const u = new Uint8Array(2 + s.length * 2); u[0] = 0xff; u[1] = 0xfe; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); u[2 + i * 2] = c & 255; u[3 + i * 2] = c >> 8; } return u; };
  const t = (s) => new Uint8Array([3, ...enc.encode(s)]);
  const apic = new Uint8Array([0, ...enc.encode('image/png'), 0, 3, ...enc.encode('cover'), 0, 0x89, 0x50, 0x4e, 0x47]);
  const b = tag23([
    frame23('TIT2', t('夜曲')),
    frame23('TPE1', new Uint8Array([1, ...utf16('周')])),
    frame23('TALB', t('十一月')),
    frame23('APIC', apic),
  ]);
  assert.equal(id3Size(b), b.length);
  const r = parseId3(b);
  assert.equal(r.title, '夜曲');
  assert.equal(r.artist, '周');
  assert.equal(r.album, '十一月');
  assert.equal(r.cover.mime, 'image/png');
  assert.deepEqual([...r.cover.data], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(parseId3(new Uint8Array([1, 2, 3])), null);
});

test('占位波形稳定、重采样取峰', () => {
  const a = fakePeaks('song.mp3', 40), b = fakePeaks('song.mp3', 40);
  assert.deepEqual(a, b);
  assert.equal(a.length, 40);
  assert.ok(a.every((v) => v > 0 && v <= 1));
  assert.notDeepEqual(fakePeaks('other.mp3', 40), a);
  assert.deepEqual(resamplePeaks([0.1, 0.9, 0.2, 0.4], 2), [0.9, 0.4]);
  assert.deepEqual(resamplePeaks([0.5], 3), [0.5, 0.5, 0.5]);
});

test('字幕编码识别', () => {
  const enc = new TextEncoder();
  assert.equal(decodeSubtitle(enc.encode('你好')), '你好');
  assert.equal(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('甲')])), '甲');
  assert.equal(decodeSubtitle(new Uint8Array([0xff, 0xfe, 0x60, 0x4f])), '你');   // UTF-16LE「你」
  assert.equal(decodeSubtitle(new Uint8Array([0xfe, 0xff, 0x4f, 0x60])), '你');
  assert.equal(decodeSubtitle(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])), '你好');   // GBK「你好」
});

test('PCM 出波形：与服务端同算法（双声道平均、0.05s 块峰、重采样取峰、归一）', () => {
  const rate = 4000;   // 块 = 200 样本
  const L = new Float32Array(rate * 2), R = new Float32Array(rate * 2);   // 2 秒 = 40 块
  for (let i = 0; i < L.length; i++) { L[i] = i < rate ? 0.5 : 0.1; R[i] = i < rate ? -0.5 : 0.1; }
  L[100] = 0.8; R[100] = 0.8;   // 第 0 块里有个 0.8 的同相峰
  const p = peaksFromChannels([L, R], rate, 400);
  assert.equal(p.length, 40);   // 块数不足 400 就是块数
  assert.equal(p[0], 1);        // 0.8 是全局最大
  assert.equal(p[1], 0);        // 反相抵消：(0.5 + -0.5) / 2 = 0
  assert.equal(p[39], 0.13);    // 0.1 / 0.8 = 0.125 → 0.13
  const q = peaksFromChannels([new Float32Array(rate * 60).fill(0.25)], rate, 400);
  assert.equal(q.length, 400);
  assert.ok(q.every((v) => v === 1));
  assert.deepEqual(peaksFromChannels([new Float32Array(1000)], rate), [0, 0, 0, 0, 0]);   // 全静音不除零
  assert.deepEqual(peaksFromChannels([], rate), []);
  assert.deepEqual(peaksFromChannels([L], 0), []);
});

test('滚轮攒格：鼠标一格一步、触控板细碎累加、停顿清零、行 / 页模式换算', () => {
  const s = wheelStepper(100, 400);
  assert.equal(s({ deltaY: -100 }, 0), 1);        // 上滚一格 = +1
  assert.equal(s({ deltaY: 200 }, 50), -2);       // 下滚两格
  const t = wheelStepper(100, 400);
  assert.equal(t({ deltaY: -10 }, 0), 0);         // 触控板细碎：攒着
  let n = 0;
  for (let i = 1; i <= 9; i++) n += t({ deltaY: -10 }, i * 16);
  assert.equal(n, 1);                             // 攒满 100 出一步
  assert.equal(t({ deltaY: -30 }, 1000), 0);      // 停顿超过 400ms 清零，0.3 格不够
  const u = wheelStepper(100, 400);
  assert.equal(u({ deltaY: -53 }, 0), 1);         // 一串的第一下有 0.4 格就算一格
  assert.equal(u({ deltaY: 3, deltaMode: 1 }, 1000), -1);   // 3 行 ≈ 一格
  assert.equal(u({ deltaX: 1, deltaMode: 2 }, 2000), 1);    // 横滚一页 = 一格，右为正
});
