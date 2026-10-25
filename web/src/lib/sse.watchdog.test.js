// 回归（2026-10-21 FR4）：SSE 看门狗回前台阈值曾是 12s，小于当时 15s 的服务端心跳——窗口一获得焦点就可能把
// 健康的直播流 / 事件总线当半开掐掉，直播流被掐会整轮重放。现在：不认 window 'focus'；回前台按 20s 判；
// 回前台后 30s 内 5s 巡检也按 20s 判，之后回到 40s。
// 做法：把真的 sse.js 拷进临时目录（依赖换成桩），配假 window / document 与假时钟跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// —— 假时钟：sse.js 模块顶层就起 5s 巡检，所以要在 import 之前装好 ——
let now = 1_000_000;
const timers = [];
let tid = 0;
Date.now = () => now;
globalThis.setTimeout = (fn, ms) => { const id = ++tid; timers.push({ id, at: now + (ms || 0), fn, every: 0 }); return id; };
globalThis.setInterval = (fn, ms) => { const id = ++tid; timers.push({ id, at: now + ms, fn, every: ms }); return id; };
globalThis.clearTimeout = globalThis.clearInterval = (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); };
function advance(ms) {
  const end = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const tm = timers[0];
    if (!tm || tm.at > end) break;
    now = tm.at;
    if (tm.every) tm.at += tm.every; else timers.shift();
    tm.fn();
  }
  now = end;
}
const bags = { window: {}, document: {} };
const on = (bag) => (ev, fn) => { (bag[ev] ||= []).push(fn); };
const fire = (bag, ev) => { for (const fn of bag[ev] || []) fn(); };
globalThis.document = { hidden: false, addEventListener: on(bags.document), removeEventListener() {} };
globalThis.window = { addEventListener: on(bags.window), removeEventListener() {} };

const dir = mkdtempSync(join(tmpdir(), 'sse-watchdog-test-'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
writeFileSync(join(dir, 'api.js'), 'export const authHeaders = () => ({});');
writeFileSync(join(dir, 'server.js'), 'export const apiUrl = (p) => p; export const noteNetFail = () => {};');
writeFileSync(join(dir, 'i18n.js'), 'export const t = (s) => s;');
writeFileSync(join(dir, 'sse.js'), readFileSync(join(here, 'sse.js'), 'utf8'));
const { watch } = await import(pathToFileURL(join(dir, 'sse.js')).href);

function conn() {
  const st = { killed: 0 };
  const w = watch(() => { st.killed++; });
  w.touch();
  return { st, w };
}

test('window focus 不算回前台：不挂监听，空闲 15s 的流不被掐', () => {
  assert.equal(bags.window.focus, undefined);
  const a = conn();
  advance(15_000);
  fire(bags.window, 'focus');
  advance(1_000);
  assert.equal(a.st.killed, 0);
  a.w.release();
});

test('回前台：空闲 15s（一个心跳周期内）不掐，空闲 25s 判半开', () => {
  const a = conn();
  advance(15_000);
  fire(bags.document, 'visibilitychange');
  advance(300);
  assert.equal(a.st.killed, 0);
  a.w.release();

  const b = conn();
  advance(25_000);
  fire(bags.document, 'visibilitychange');
  advance(300);
  assert.equal(b.st.killed, 1);
});

test('回前台后 30s 内巡检按 20s 判，过了窗口回到 40s', () => {
  const a = conn();
  fire(bags.document, 'visibilitychange');
  advance(26_000);
  assert.equal(a.st.killed, 1, '窗口内 ≤25s 就该发现半开');

  advance(60_000);
  const b = conn();
  advance(30_000);
  assert.equal(b.st.killed, 0, '窗口外 30s 空闲还不到 40s');
  advance(15_000);
  assert.equal(b.st.killed, 1, '窗口外 40s+ 判死');
});

test('切到后台那一下的 visibilitychange 不算醒来', () => {
  const a = conn();
  advance(25_000);
  document.hidden = true;
  fire(bags.document, 'visibilitychange');
  advance(300);
  assert.equal(a.st.killed, 0);
  document.hidden = false;
  a.w.release();
});
